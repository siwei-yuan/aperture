import type Database from 'better-sqlite3';
import { getSession } from '../session/router.js';
import { applyMosaicBudget, type MosaicConfig } from './disclosure-profile.js';
import type { VectorStore } from './embed.js';
import type { Ledger } from './ledger.js';
import { lookupVisibleLayers } from './rebac.js';
import type { AtomStore } from './store.js';

export interface RetrieveDeps {
  db: Database.Database;
  ledger: Ledger;
  store: AtomStore;
  vectors: VectorStore;
  /** Opt-in mosaic tracking (M6). Absent = no throttling. */
  mosaic?: MosaicConfig;
}

export interface RetrieveRequest {
  /** Everyone in the room. The weakest member caps every atom (min-combine). */
  audience: string[];
  query: string;
  k?: number;
  /** TBAC topic allowlist; null/undefined = unscoped. */
  scopeTopics?: string[] | null;
  /** Clock override for deterministic tests; defaults to Date.now(). */
  now?: number;
}

export interface RetrievedItem {
  atomId: string;
  level: number;
  text: string;
  score: number;
}

/**
 * The main battlefield: what must not be said never enters the context.
 *
 * Order: visible atoms → scope filter → per-member ReBAC lookup, min-combined
 * across the audience → exact KNN inside the permitted partition → one item
 * per atom at its finest permitted layer (coarser layers are entailed by it)
 * → adjudication on the ledger.
 */
export async function retrieve(
  deps: RetrieveDeps,
  req: RetrieveRequest,
): Promise<{ items: RetrievedItem[] }> {
  const k = req.k ?? 5;
  const visible = deps.store.listVisible();

  const scoped =
    req.scopeTopics == null
      ? visible
      : visible.filter((a) => a.topics.some((t) => req.scopeTopics!.includes(t)));

  const combined = new Map<string, number>();
  if (req.audience.length > 0) {
    const perMember = req.audience.map((m) => lookupVisibleLayers(deps.db, m, scoped));
    for (const atom of scoped) {
      let min = Infinity;
      for (const member of perMember) min = Math.min(min, member.get(atom.id) ?? 0);
      if (min > 0 && Number.isFinite(min)) combined.set(atom.id, min);
    }
  }

  const queryVec = await deps.vectors.embedQuery(req.query);
  // Over-fetch so per-atom dedupe still fills k items.
  const hits = deps.vectors.search(queryVec, combined, k * 4);

  const bestPerAtom = new Map<string, number>();
  for (const hit of hits) {
    const cur = bestPerAtom.get(hit.atomId);
    if (cur === undefined || hit.score > cur) bestPerAtom.set(hit.atomId, hit.score);
  }

  let items: RetrievedItem[] = [];
  const ranked = [...bestPerAtom.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  for (const [atomId, score] of ranked) {
    const atom = deps.store.get(atomId)!;
    // Finest permitted layer, clamped to ladder length (ladders may be short).
    const level = Math.min(combined.get(atomId)!, atom.layers.length);
    items.push({ atomId, level, text: atom.layers[level - 1]!.text, score });
  }

  const now = req.now ?? Date.now();

  // Mosaic budget (opt-in): withhold novel disclosures beyond the per-topic
  // window budget, most-relevant-first. The adjudicated event below records
  // only what actually entered the context.
  if (deps.mosaic) {
    const { allowed, withheld } = applyMosaicBudget(
      { ledger: deps.ledger, config: deps.mosaic },
      {
        audience: req.audience,
        items,
        topicsOf: (atomId) => deps.store.get(atomId)?.topics ?? [],
        now,
      },
    );
    if (withheld.length > 0) {
      deps.ledger.append(
        'disclosure.throttled',
        {
          audience: req.audience,
          withheld: withheld.map((w) => ({
            atomId: w.item.atomId,
            level: w.item.level,
            topic: w.topic,
            viewer: w.viewer,
          })),
        },
        now,
      );
    }
    items = allowed;
  }

  deps.ledger.append(
    'disclosure.adjudicated',
    {
      audience: req.audience,
      candidates: scoped.length,
      injected: items.map((i) => ({ atomId: i.atomId, level: i.level })),
    },
    now,
  );

  return { items };
}

/** Session-aware variant: audience and TBAC scope come from the session row. */
export async function retrieveForSession(
  deps: RetrieveDeps,
  req: { sessionId: string; query: string; k?: number },
): Promise<{ items: RetrievedItem[] }> {
  const session = getSession(deps.db, req.sessionId);
  if (!session) throw new Error(`unknown session "${req.sessionId}"`);
  return retrieve(deps, {
    audience: session.audience,
    query: req.query,
    k: req.k,
    scopeTopics: session.scope,
  });
}
