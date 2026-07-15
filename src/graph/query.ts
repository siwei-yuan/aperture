import type Database from 'better-sqlite3';
import { resolutionForAtom } from '../core/rebac.js';
import type { AtomStore } from '../core/store.js';
import { ensureGraphTables } from './fold.js';

/**
 * Graph queries share the exact adjudication of atom retrieval — the graph
 * must never know more than the atoms (axiom A2: an unlabeled derivative is
 * an ACL side channel). An edge is visible to an audience iff it is not
 * quarantined, currently valid (unless historical view is requested), and
 * min over members of resolutionForAtom(member, edge's source atom) ≥ the
 * edge's min_level.
 */

export interface GraphQueryDeps {
  db: Database.Database;
  store: AtomStore;
}

export interface EdgeView {
  id: string;
  srcName: string;
  predicate: string;
  dstName: string;
  minLevel: number;
  atomId: string;
  invalidated: boolean;
}

interface EdgeRow {
  id: string;
  src: string;
  predicate: string;
  dst: string;
  atom_id: string;
  min_level: number;
  t_invalid: number | null;
  quarantined: number;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function neighbors(
  deps: GraphQueryDeps,
  req: { audience: string[]; entity: string; depth?: number; includeInvalidated?: boolean },
): EdgeView[] {
  ensureGraphTables(deps.db);
  const depth = Math.min(req.depth ?? 2, 3);

  const start = deps.db
    .prepare('SELECT id FROM nodes WHERE id LIKE ? OR name = ?')
    .get(`ent:%:${normalizeName(req.entity)}`, req.entity) as { id: string } | undefined;
  if (!start) return [];

  const nodeName = new Map<string, string>(
    (deps.db.prepare('SELECT id, name FROM nodes').all() as Array<{ id: string; name: string }>).map(
      (n) => [n.id, n.name],
    ),
  );

  // Ceiling per source atom, memoized; 0 for anything the audience may not see.
  const ceilingCache = new Map<string, number>();
  const ceilingFor = (atomId: string): number => {
    const cached = ceilingCache.get(atomId);
    if (cached !== undefined) return cached;
    const atom = deps.store.get(atomId);
    let ceiling = 0;
    if (atom && !atom.quarantined && req.audience.length > 0) {
      ceiling = Math.min(...req.audience.map((m) => resolutionForAtom(deps.db, m, atom)));
    }
    ceilingCache.set(atomId, ceiling);
    return ceiling;
  };

  const edgesTouching = deps.db.prepare(
    'SELECT * FROM edges WHERE src = ? OR dst = ?',
  );

  const visited = new Set<string>([start.id]);
  const collected = new Map<string, EdgeView>();
  let frontier = [start.id];

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const row of edgesTouching.all(nodeId, nodeId) as EdgeRow[]) {
        if (collected.has(row.id)) continue;
        if (row.quarantined === 1) continue;
        if (!req.includeInvalidated && row.t_invalid !== null) continue;
        if (ceilingFor(row.atom_id) < row.min_level) continue;

        collected.set(row.id, {
          id: row.id,
          srcName: nodeName.get(row.src) ?? row.src,
          predicate: row.predicate,
          dstName: nodeName.get(row.dst) ?? row.dst,
          minLevel: row.min_level,
          atomId: row.atom_id,
          invalidated: row.t_invalid !== null,
        });

        for (const endpoint of [row.src, row.dst]) {
          if (!visited.has(endpoint)) {
            visited.add(endpoint);
            next.push(endpoint);
          }
        }
      }
    }
    frontier = next;
  }

  return [...collected.values()];
}
