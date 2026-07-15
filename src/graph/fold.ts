import type Database from 'better-sqlite3';
import type { Layer } from '../core/atom.js';
import { cosine, vecFromBlob, vecToBlob, type Embedder } from '../core/embed.js';
import type { Ledger } from '../core/ledger.js';

/**
 * Knowledge-graph projection: a cursor-based, idempotent fold over the
 * ledger. The graph never becomes state — drop it, re-fold, identical
 * (node/edge ids are deterministic; entity resolution is deterministic
 * given a deterministic embedder).
 */

export interface ExtractedEntity {
  name: string;
  kind: string;
  /** First ladder rung this entity appears on — its discoverability level. */
  firstLevel: number;
}

export interface ExtractedFact {
  /** Entity names (resolved to nodes by the fold). */
  src: string;
  predicate: string;
  dst: string;
  /** Ladder rung the fact was stated on. */
  level: number;
}

/** LLM-backed in production; deterministic fake in tests. */
export interface FactExtractor {
  extract(layers: Layer[]): Promise<{ entities: ExtractedEntity[]; facts: ExtractedFact[] }>;
}

export interface FoldDeps {
  db: Database.Database;
  ledger: Ledger;
  extractor: FactExtractor;
  embedder: Embedder;
  /**
   * Predicates where a new fact supersedes the old one for the same subject
   * (lives_in, works_at, ...). Superseding closes the old edge's t_invalid —
   * derived deterministically during fold, so it needs no ledger event.
   */
  functionalPredicates?: string[];
  /** Entity-resolution similarity threshold (embedding fallback). */
  similarity?: number;
}

interface IngestedPayload {
  atomId: string;
  source: { who: string; channel: string; ts: number };
  layers: Layer[];
  scope?: 'local' | 'global' | 'sealed';
  /** Pre-scope ledgers carried a boolean instead. */
  quarantined?: boolean;
}

/** Edge flag: 1 = the source atom is not globally visible (local or sealed). */
function nonGlobal(p: IngestedPayload): 0 | 1 {
  const scope = p.scope ?? (p.quarantined ? 'local' : 'global');
  return scope === 'global' ? 0 : 1;
}

export function ensureGraphTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      kind      TEXT NOT NULL,
      min_level INTEGER NOT NULL,
      vec       BLOB
    );
    CREATE TABLE IF NOT EXISTS edges (
      id          TEXT PRIMARY KEY,
      src         TEXT NOT NULL,
      predicate   TEXT NOT NULL,
      dst         TEXT NOT NULL,
      atom_id     TEXT NOT NULL,
      min_level   INTEGER NOT NULL,
      t_valid     INTEGER NOT NULL,
      t_invalid   INTEGER,
      quarantined INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_cursor (
      id  INTEGER PRIMARY KEY CHECK (id = 1),
      seq INTEGER NOT NULL
    );
  `);
}

/** Drop the projection. Re-folding from seq 0 rebuilds it — that's the point. */
export function resetGraph(db: Database.Database): void {
  ensureGraphTables(db);
  db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM graph_cursor;');
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Two-stage entity resolution: deterministic id lookup on the normalized
 * name, then embedding similarity within the same kind. No LLM judge until
 * similarity matching demonstrably mis-merges.
 */
async function resolveEntity(
  deps: FoldDeps,
  entity: ExtractedEntity,
): Promise<string> {
  const norm = normalizeName(entity.name);
  const id = `ent:${entity.kind}:${norm}`;

  const exact = deps.db.prepare('SELECT id, min_level FROM nodes WHERE id = ?').get(id) as
    | { id: string; min_level: number }
    | undefined;
  if (exact) {
    if (entity.firstLevel < exact.min_level) {
      deps.db.prepare('UPDATE nodes SET min_level = ? WHERE id = ?').run(entity.firstLevel, id);
    }
    return id;
  }

  const [vec] = await deps.embedder.embed([norm]);
  const threshold = deps.similarity ?? 0.9;
  const candidates = deps.db
    .prepare('SELECT id, min_level, vec FROM nodes WHERE kind = ? AND vec IS NOT NULL')
    .all(entity.kind) as Array<{ id: string; min_level: number; vec: Buffer }>;
  for (const candidate of candidates) {
    if (cosine(vec!, vecFromBlob(candidate.vec)) >= threshold) {
      if (entity.firstLevel < candidate.min_level) {
        deps.db.prepare('UPDATE nodes SET min_level = ? WHERE id = ?').run(entity.firstLevel, candidate.id);
      }
      return candidate.id;
    }
  }

  deps.db
    .prepare('INSERT INTO nodes (id, name, kind, min_level, vec) VALUES (?, ?, ?, ?, ?)')
    .run(id, entity.name, entity.kind, entity.firstLevel, vecToBlob(vec!));
  return id;
}

/** Consume ledger events past the cursor and grow the graph. Idempotent. */
export async function foldAtoms(deps: FoldDeps): Promise<void> {
  ensureGraphTables(deps.db);
  const cursorRow = deps.db.prepare('SELECT seq FROM graph_cursor WHERE id = 1').get() as
    | { seq: number }
    | undefined;
  let cursor = cursorRow?.seq ?? 0;
  const functional = new Set(deps.functionalPredicates ?? []);

  for (const event of deps.ledger.events()) {
    if (event.seq <= cursor) continue;

    switch (event.type) {
      case 'atom.ingested': {
        const p = event.payload as IngestedPayload;
        const { entities, facts } = await deps.extractor.extract(p.layers);

        const firstLevels = new Map<string, number>();
        const nodeIds = new Map<string, string>();
        for (const entity of entities) {
          firstLevels.set(normalizeName(entity.name), entity.firstLevel);
          nodeIds.set(normalizeName(entity.name), await resolveEntity(deps, entity));
        }
        const resolveName = async (name: string, level: number): Promise<string> => {
          const norm = normalizeName(name);
          return (
            nodeIds.get(norm) ??
            resolveEntity(deps, { name, kind: 'unknown', firstLevel: level })
          );
        };

        for (let i = 0; i < facts.length; i++) {
          const fact = facts[i]!;
          const srcId = await resolveName(fact.src, fact.level);
          const dstId = await resolveName(fact.dst, fact.level);
          const minLevel = Math.max(
            fact.level,
            firstLevels.get(normalizeName(fact.src)) ?? fact.level,
            firstLevels.get(normalizeName(fact.dst)) ?? fact.level,
          );

          // Derived supersession for functional predicates: deterministic
          // from event order, so it is projection logic — no ledger event.
          if (functional.has(fact.predicate)) {
            deps.db
              .prepare(
                'UPDATE edges SET t_invalid = ? WHERE src = ? AND predicate = ? AND t_invalid IS NULL',
              )
              .run(p.source.ts, srcId, fact.predicate);
          }

          deps.db
            .prepare(
              `INSERT OR REPLACE INTO edges
                 (id, src, predicate, dst, atom_id, min_level, t_valid, t_invalid, quarantined)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            )
            .run(
              `${p.atomId}#${i}`,
              srcId,
              fact.predicate,
              dstId,
              p.atomId,
              minLevel,
              p.source.ts,
              nonGlobal(p),
            );
        }
        break;
      }

      // 'atom.approved' is the pre-scope name for the same owner signature.
      case 'atom.approved':
      case 'atom.promoted': {
        const p = event.payload as { atomId: string };
        deps.db.prepare('UPDATE edges SET quarantined = 0 WHERE atom_id = ?').run(p.atomId);
        break;
      }

      case 'atom.sealed': {
        const p = event.payload as { atomId: string };
        deps.db.prepare('UPDATE edges SET quarantined = 1 WHERE atom_id = ?').run(p.atomId);
        break;
      }

      case 'graph.edge_invalidated': {
        // Manual (owner) invalidation — a first-class event, replay applies it.
        const p = event.payload as { edgeId: string; ts: number };
        deps.db.prepare('UPDATE edges SET t_invalid = ? WHERE id = ?').run(p.ts, p.edgeId);
        break;
      }
    }

    cursor = event.seq;
  }

  deps.db
    .prepare(
      `INSERT INTO graph_cursor (id, seq) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq`,
    )
    .run(cursor);
}

/** Owner action: invalidate an edge. Ledger first, then the projection. */
export function invalidateEdge(
  deps: { db: Database.Database; ledger: Ledger },
  edgeId: string,
  ts: number,
): void {
  ensureGraphTables(deps.db);
  const edge = deps.db.prepare('SELECT id FROM edges WHERE id = ?').get(edgeId);
  if (!edge) throw new Error(`unknown edge "${edgeId}"`);
  deps.ledger.append('graph.edge_invalidated', { edgeId, ts });
  deps.db.prepare('UPDATE edges SET t_invalid = ? WHERE id = ?').run(ts, edgeId);
}
