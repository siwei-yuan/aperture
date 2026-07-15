import type Database from 'better-sqlite3';
import { getSession, widenScope } from '../session/router.js';
import { applyMosaicBudget, type MosaicConfig } from './disclosure-profile.js';
import type { VectorStore } from './embed.js';
import type { Ledger } from './ledger.js';
import { ceilingsForAudience, topicAncestors } from './rebac.js';
import type { AtomStore } from './store.js';

export interface RetrieveDeps {
  db: Database.Database;
  ledger: Ledger;
  store: AtomStore;
  vectors: VectorStore;
  /** Opt-in mosaic tracking (M6). Absent = no throttling. */
  mosaic?: MosaicConfig;
  /** Known owner: a session whose audience is exactly the owner is never scope-limited. */
  ownerId?: string;
  /**
   * Topics (with their whole subtrees) the scope driver must never widen
   * into on its own — entering one takes an owner signature (widenScope via
   * /aperture allow). Default: none.
   */
  sensitiveTopics?: string[];
}

export interface RetrieveRequest {
  /** Everyone in the room. The weakest member caps every atom (min-combine). */
  audience: string[];
  query: string;
  k?: number;
  /** TBAC topic allowlist; null/undefined = unscoped. */
  scopeTopics?: string[] | null;
  /**
   * Enables the scope driver: when the query's inferred topics fall outside
   * the scope, non-sensitive ones auto-widen this session (ledgered), and
   * sensitive ones come back as `scopeBlocked`. Absent = scope is a plain
   * hard filter.
   */
  sessionId?: string;
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

/** A sensitive topic this query wanted but the session's scope withheld — for owner review. */
export interface ScopeBlock {
  topic: string;
  sessionId: string;
}

/** Scope allowlists work like grants: a scope entry covers its whole subtree. */
function topicInScope(topic: string, scope: string[]): boolean {
  return topicAncestors(topic).some((a) => scope.includes(a));
}

/**
 * The main battlefield: what must not be said never enters the context.
 *
 * Order: per-atom ceiling over the ReBAC partition (local: presence at
 * acquisition; global: min-combined ReBAC) → exact KNN inside that partition
 * → scope driver (see below) → topic-scope filter → one item per atom at its
 * finest permitted layer (coarser layers are entailed by it) → adjudication
 * on the ledger.
 *
 * The scope driver (needs `sessionId`): topics of top-ranked, ReBAC-permitted
 * hits that the scope blocks are the query's inferred topics — inference only
 * ever sees atoms this audience may see, so no unpermitted content acts as an
 * oracle. Non-sensitive inferred topics auto-widen the session (`scope.widened`
 * on the ledger, effective this very call); sensitive ones are withheld and
 * reported as `scopeBlocked`. A session whose audience is exactly the owner
 * is never scope-limited (no need-to-know friction against oneself).
 *
 * Local atoms blocked by scope but relevant enough to have ranked come back
 * as promotion suggestions (demand-driven review, each suggested at most
 * once — `promotion.suggested` on the ledger is the dedupe record).
 */
export async function retrieve(
  deps: RetrieveDeps,
  req: RetrieveRequest,
): Promise<{ items: RetrievedItem[]; suggestions: PromotionSuggestion[]; scopeBlocked: ScopeBlock[] }> {
  const k = req.k ?? 5;
  const retrievable = deps.store.listRetrievable();
  const now = req.now ?? Date.now();

  const ownerAlone =
    deps.ownerId !== undefined && req.audience.length === 1 && req.audience[0] === deps.ownerId;
  let scope = ownerAlone ? null : (req.scopeTopics ?? null);

  // ReBAC first: everything downstream — including the scope driver's topic
  // inference — only ever sees the audience's permitted partition.
  const combined = ceilingsForAudience(deps.db, req.audience, retrievable);

  const queryVec = await deps.vectors.embedQuery(req.query);
  // Over-fetch so per-atom dedupe still fills k items.
  const hits = deps.vectors.search(queryVec, combined, k * 4);

  const bestPerAtom = new Map<string, number>();
  for (const hit of hits) {
    const cur = bestPerAtom.get(hit.atomId);
    if (cur === undefined || hit.score > cur) bestPerAtom.set(hit.atomId, hit.score);
  }
  const ranked = [...bestPerAtom.entries()].sort((a, b) => b[1] - a[1]);

  const scopeBlocked: ScopeBlock[] = [];
  if (scope !== null && req.sessionId) {
    // Inferred query topics: what the top-ranked permitted hits are about
    // but the scope withholds.
    const inferred = new Set<string>();
    for (const [atomId] of ranked.slice(0, k)) {
      for (const t of deps.store.get(atomId)!.topics) {
        if (!topicInScope(t, scope)) inferred.add(t);
      }
    }
    const sensitive = deps.sensitiveTopics ?? [];
    const isSensitive = (t: string): boolean => topicAncestors(t).some((a) => sensitive.includes(a));

    const safe = [...inferred].filter((t) => !isSensitive(t));
    if (safe.length > 0) {
      widenScope({ db: deps.db, ledger: deps.ledger }, req.sessionId, safe);
      scope = [...new Set([...scope, ...safe])];
    }
    // Sensitive topics take an owner signature; each session×topic is
    // requested at most once — `scope.requested` on the ledger is the
    // dedupe record, so a restart never re-asks the owner.
    const wanted = [...inferred].filter(isSensitive);
    if (wanted.length > 0) {
      const alreadyRequested = new Set<string>();
      for (const event of deps.ledger.events()) {
        if (event.type !== 'scope.requested') continue;
        const p = event.payload as { sessionId: string; topic: string };
        if (p.sessionId === req.sessionId) alreadyRequested.add(p.topic);
      }
      for (const topic of wanted) {
        if (alreadyRequested.has(topic)) continue;
        deps.ledger.append('scope.requested', { sessionId: req.sessionId, topic }, now);
        scopeBlocked.push({ topic, sessionId: req.sessionId });
      }
    }
  }

  const scoped =
    scope === null ? retrievable : retrievable.filter((a) => a.topics.some((t) => topicInScope(t, scope!)));
  const scopedIds = new Set(scoped.map((a) => a.id));

  let items: RetrievedItem[] = [];
  for (const [atomId, score] of ranked) {
    if (items.length >= k) break;
    if (!scopedIds.has(atomId)) continue;
    const atom = deps.store.get(atomId)!;
    // Finest permitted layer, clamped to ladder length (ladders may be short).
    const level = Math.min(combined.get(atomId)!, atom.layers.length);
    items.push({ atomId, level, text: atom.layers[level - 1]!.text, score });
  }

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

  // Promotion demand is evidence for the OWNER, so it is gated by room
  // provenance and the dedupe ledger — not by this session's topic scope
  // (the suggestion text is the coarsest layer, pushed to the owner only).
  const suggestions = suggestPromotions(deps, {
    candidates: retrievable,
    combined,
    queryVec,
    items,
    k,
    audience: req.audience,
    now,
  });

  return { items, suggestions, scopeBlocked };
}

/**
 * Demand-driven promotion: a scope-blocked local atom is suggested iff it
 * would have made the injected set on relevance alone. Each atom is
 * suggested at most once, ever — the ledger event is the dedupe record.
 */
function suggestPromotions(
  deps: RetrieveDeps,
  args: {
    candidates: ReturnType<AtomStore['listRetrievable']>;
    combined: Map<string, number>;
    queryVec: Float32Array;
    items: RetrievedItem[];
    k: number;
    audience: string[];
    now: number;
  },
): PromotionSuggestion[] {
  const blocked = args.candidates.filter((a) => a.scope === 'local' && !args.combined.has(a.id));
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

/** Session-aware variant: audience and TBAC scope come from the session row; the scope driver is on. */
export async function retrieveForSession(
  deps: RetrieveDeps,
  req: { sessionId: string; query: string; k?: number },
): Promise<{ items: RetrievedItem[]; suggestions: PromotionSuggestion[]; scopeBlocked: ScopeBlock[] }> {
  const session = getSession(deps.db, req.sessionId);
  if (!session) throw new Error(`unknown session "${req.sessionId}"`);
  return retrieve(deps, {
    audience: session.audience,
    query: req.query,
    k: req.k,
    scopeTopics: session.scope,
    sessionId: session.id,
  });
}
