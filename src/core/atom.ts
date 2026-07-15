/** Provenance of a piece of information — the anti-poisoning anchor. */
export interface Source {
  /** Principal id of whoever the information originated from. */
  who: string;
  /** Channel it arrived through, e.g. "telegram:dm:123", "wechat:group:456". */
  channel: string;
  /** Acquisition time, ms epoch. */
  ts: number;
}

/** One rung of the generalization ladder. Level 1 is the coarsest. */
export interface Layer {
  level: number;
  text: string;
  /** Normalized entity strings mentioned at this layer. */
  entities: string[];
}

/**
 * Visibility scope of an atom.
 * - `local`: usable only where no new disclosure happens — rooms whose whole
 *   audience was present at acquisition (owner is an implicit member
 *   everywhere). The default for anything a non-owner said. No approval
 *   needed for in-room use; leaving the room requires promotion.
 * - `global`: retrievable everywhere, layer-gated by ReBAC resolution.
 *   The default for the owner's own knowledge; non-owner content gets here
 *   only via an owner-signed promotion.
 * - `sealed`: visible nowhere (owner explicitly rejected it). Stays on the
 *   ledger for audit.
 */
export type AtomScope = 'local' | 'global' | 'sealed';

export interface MemoryAtom {
  id: string;
  /** Who the information is ABOUT (not necessarily the speaker). */
  subject: string[];
  source: Source;
  /** Channel label at the time the info was acquired (contextual integrity). */
  acquisitionContext: string;
  /**
   * Person ids present when the info was acquired — the room's membership,
   * frozen at ingest, with the owner materialized in. The mechanical basis
   * of the "no new disclosure" rule for local atoms.
   */
  acquisitionAudience: string[];
  topics: string[];
  /** Ascending levels 1..n, n <= MAX_LAYERS. Frozen at ingest. */
  layers: Layer[];
  scope: AtomScope;
}
