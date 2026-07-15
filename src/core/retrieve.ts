import type Database from 'better-sqlite3';
import { getSession } from '../session/router.js';
import { applyMosaicBudget, type MosaicConfig } from './disclosure-profile.js';
import type { VectorStore } from './embed.js';
import type { Ledger } from './ledger.js';
import { ceilingsForAudience } from './rebac.js';
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

/** A local atom that would have ranked for this query but is scope-blocked. */
export interface PromotionSuggestion {
  atomId: string;
  /** Coarsest-layer summary — the suggestion is itself a disclosure to the owner's channel. */
  summary: string;
  score: number;
}

/**
 * The main battlefield: what must not be said never enters the context.
 *
 * Order: retrievable atoms → topic-scope filter → per-atom ceiling
 * (local: presence at acquisition; global: min-combined ReBAC) → exact KNN
 * inside the permitted partition → one item per atom at its finest permitted
 * layer (coarser layers are entailed by it) → adjudication on the ledger.
 *
 * Local atoms blocked by scope but relevant enough to have ranked come back
 * as promotion suggestions (demand-driven review, each suggested at most
 * once — `promotion.suggested` on the ledger is the dedupe record).
 */
export async function retrieve(
  deps: RetrieveDeps,
  req: RetrieveRequest,
): Promise<{ items: RetrievedItem[]; suggestions: PromotionSuggestion[] }> {
  const k = req.k ?? 5;
  const retrievable = deps.store.listRetrievable();

  const scoped =
    req.scopeTopics == null
      ? retrievable
      : retrievable.filter((a) => a.topics.some((t) => req.scopeTopics!.includes(t)));

  const combined = ceilingsForAudience(deps.db, req.audience, scoped);

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

  const suggestions = suggestPromotions(deps, {
    scoped,
    combined,
    queryVec,
    items,
    k,
    audience: req.audience,
    now,
  });

  return { items, suggestions };
}

/**
 * Demand-driven promotion: a scope-blocked local atom is suggested iff it
 * would have made the injected set on relevance alone. Each atom is
 * suggested at most once, ever — the ledger event is the dedupe record.
 */
function suggestPromotions(
  deps: RetrieveDeps,
  args: {
    scoped: ReturnType<AtomStore['listRetrievable']>;
    combined: Map<string, number>;
    queryVec: Float32Array;
    items: RetrievedItem[];
    k: number;
    audience: string[];
    now: number;
  },
): PromotionSuggestion[] {
  const blocked = args.scoped.filter((a) => a.scope === 'local' && !args.combined.has(a.id));
  if (blocked.length === 0 || args.audience.length === 0) return [];

  // Would it have ranked? If the injected set is full, beat its weakest
  // member; if the context came back short, any relevance would have ranked.
  const bar = args.items.length >= args.k ? args.items[args.items.length - 1]!.score : -Infinity;

  const alreadySuggested = new Set<string>();
  for (const event of deps.ledger.events()) {
    if (event.type === 'promotion.suggested') {
      alreadySuggested.add((event.payload as { atomId: string }).atomId);
    }
  }

  const fullCeilings = new Map(blocked.map((a) => [a.id, a.layers.length]));
  const suggestions: PromotionSuggestion[] = [];
  for (const hit of deps.vectors.search(args.queryVec, fullCeilings, 3)) {
    if (hit.score < bar) continue;
    const atom = blocked.find((a) => a.id === hit.atomId);
    if (!atom || alreadySuggested.has(atom.id)) continue;
    alreadySuggested.add(atom.id);
    suggestions.push({ atomId: atom.id, summary: atom.layers[0]?.text ?? '', score: hit.score });
    deps.ledger.append(
      'promotion.suggested',
      { atomId: atom.id, audience: args.audience, score: Number(hit.score.toFixed(4)) },
      args.now,
    );
  }
  return suggestions;
}

/** Session-aware variant: audience and TBAC scope come from the session row. */
export async function retrieveForSession(
  deps: RetrieveDeps,
  req: { sessionId: string; query: string; k?: number },
): Promise<{ items: RetrievedItem[]; suggestions: PromotionSuggestion[] }> {
  const session = getSession(deps.db, req.sessionId);
  if (!session) throw new Error(`unknown session "${req.sessionId}"`);
  return retrieve(deps, {
    audience: session.audience,
    query: req.query,
    k: req.k,
    scopeTopics: session.scope,
  });
}
