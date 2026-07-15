import type Database from 'better-sqlite3';
import type { MemoryAtom } from './atom.js';
import type { Ledger } from './ledger.js';

/**
 * One authorization fact: ⟨object, relation, subject⟩ with an ordinal
 * capacity. Objects and subjects are "type:id" strings; a subject may be a
 * userset like "tier:friend#member" (everyone reachable via that relation).
 *
 * Conventions:
 * - membership tuples carry resolution 4 (full capacity);
 * - policy tuples carry the layer cap (0..4).
 */
export interface RelationTuple {
  object: string;
  relation: string;
  subject: string;
  resolution: number;
}

export type TupleRef = Omit<RelationTuple, 'resolution'>;

/**
 * ACL tuples as a ledger projection: grant/revoke append `acl.*` events
 * first, then update the table. The apply* methods write the table without
 * appending — they exist for replay (see replay.ts).
 */
export class AclStore {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tuples (
        object     TEXT NOT NULL,
        relation   TEXT NOT NULL,
        subject    TEXT NOT NULL,
        resolution INTEGER NOT NULL,
        PRIMARY KEY (object, relation, subject)
      );
      CREATE INDEX IF NOT EXISTS idx_tuples_subject ON tuples(subject);
    `);
  }

  grant(t: RelationTuple): void {
    if (!Number.isInteger(t.resolution) || t.resolution < 0 || t.resolution > 4) {
      throw new RangeError(`resolution must be an integer in 0..4 (got ${t.resolution})`);
    }
    this.ledger.append('acl.granted', t);
    this.applyGrant(t);
  }

  revoke(t: TupleRef): void {
    this.ledger.append('acl.revoked', t);
    this.applyRevoke(t);
  }

  /** Projection write path only — no ledger append. Used by grant() and replay. */
  applyGrant(t: RelationTuple): void {
    this.db
      .prepare(
        `INSERT INTO tuples (object, relation, subject, resolution) VALUES (?, ?, ?, ?)
         ON CONFLICT(object, relation, subject) DO UPDATE SET resolution = excluded.resolution`,
      )
      .run(t.object, t.relation, t.subject, t.resolution);
  }

  /** Projection write path only — no ledger append. Used by revoke() and replay. */
  applyRevoke(t: TupleRef): void {
    this.db
      .prepare('DELETE FROM tuples WHERE object = ? AND relation = ? AND subject = ?')
      .run(t.object, t.relation, t.subject);
  }
}

// ---------------------------------------------------------------------------
// Evaluator: widest path in the (max, min) semiring over {0..4}
// ---------------------------------------------------------------------------

/** Userset nesting bound. Also guarantees termination on membership cycles. */
const MAX_DEPTH = 4;

/**
 * Resolution of `subject` on `object` via `relation` (default "viewer").
 *
 * Semantics — the ordinal lift of boolean ReBAC:
 * - a direct tuple (object, relation, subject, r) contributes capacity r;
 * - a userset tuple (object, relation, "g#rel", r) contributes
 *   min(r, check via g#rel) — attenuation along the path;
 * - the result is the max over contributions — union across paths;
 * - no path ⇒ 0 (default deny).
 *
 * Boolean ReBAC is the {0, 4} special case (capacity 4 ≡ reachable).
 * No memoization: personal-scale graphs are tiny and depth is capped.
 */
export function check(
  db: Database.Database,
  subject: string,
  object: string,
  relation = 'viewer',
): number {
  return widest(db, subject, object, relation, 0);
}

function widest(
  db: Database.Database,
  subject: string,
  object: string,
  relation: string,
  depth: number,
): number {
  if (depth > MAX_DEPTH) return 0;
  const rows = db
    .prepare('SELECT subject, resolution FROM tuples WHERE object = ? AND relation = ?')
    .all(object, relation) as Array<{ subject: string; resolution: number }>;

  let best = 0;
  for (const row of rows) {
    if (best === 4) break; // cannot improve further
    if (row.subject === subject) {
      best = Math.max(best, row.resolution);
      continue;
    }
    const hash = row.subject.indexOf('#');
    if (hash > 0) {
      const via = widest(db, subject, row.subject.slice(0, hash), row.subject.slice(hash + 1), depth + 1);
      if (via > 0) best = Math.max(best, Math.min(row.resolution, via));
    }
  }
  return best;
}

/**
 * Effective resolution of a viewer on an atom: the max of any direct
 * per-atom grant and the grants on each of the atom's topics. The policy
 * matrix (tier × topic → max_layer) is nothing but topic tuples.
 */
export function resolutionForAtom(
  db: Database.Database,
  subject: string,
  atom: Pick<MemoryAtom, 'id' | 'topics'>,
  objectCache?: Map<string, number>,
): number {
  const cachedCheck = (object: string): number => {
    if (!objectCache) return check(db, subject, object);
    let r = objectCache.get(object);
    if (r === undefined) {
      r = check(db, subject, object);
      objectCache.set(object, r);
    }
    return r;
  };

  let best = cachedCheck(`atom:${atom.id}`);
  for (const t of atom.topics) {
    if (best === 4) break;
    best = Math.max(best, cachedCheck(`topic:${t}`));
  }
  return best;
}

/**
 * Reverse lookup for retrieval pre-filtering: every atom the subject can see
 * at all, mapped to its maximum visible layer. Topic checks are computed
 * once per distinct topic across the whole batch.
 */
export function lookupVisibleLayers(
  db: Database.Database,
  subject: string,
  atoms: Array<Pick<MemoryAtom, 'id' | 'topics'>>,
): Map<string, number> {
  const cache = new Map<string, number>();
  const out = new Map<string, number>();
  for (const atom of atoms) {
    const r = resolutionForAtom(db, subject, atom, cache);
    if (r > 0) out.set(atom.id, r);
  }
  return out;
}

/**
 * Effective per-atom ceilings for a whole room. The single adjudication rule
 * shared by retrieval and egress:
 *
 * - `sealed` — ceiling 0 everywhere.
 * - `local` — full resolution iff every audience member was present at
 *   acquisition (no new disclosure: they already heard the raw thing);
 *   otherwise 0. ReBAC does not apply — presence beats policy for one's
 *   own room.
 * - `global` — min over members of the widest-path ReBAC resolution;
 *   an empty audience resolves to 0 (deny by default).
 *
 * Atoms with ceiling 0 are omitted from the map.
 */
export function ceilingsForAudience(
  db: Database.Database,
  audience: string[],
  atoms: Array<Pick<MemoryAtom, 'id' | 'topics' | 'scope' | 'acquisitionAudience' | 'layers'>>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (audience.length === 0) return out;

  const globals = atoms.filter((a) => a.scope === 'global');
  const perMember = audience.map((m) => lookupVisibleLayers(db, m, globals));
  for (const atom of globals) {
    let min = Infinity;
    for (const member of perMember) min = Math.min(min, member.get(atom.id) ?? 0);
    if (min > 0 && Number.isFinite(min)) out.set(atom.id, min);
  }

  for (const atom of atoms) {
    if (atom.scope !== 'local') continue;
    const present = new Set(atom.acquisitionAudience);
    if (audience.every((m) => present.has(m))) out.set(atom.id, atom.layers.length);
  }

  return out;
}
