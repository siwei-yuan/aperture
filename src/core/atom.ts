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

export interface MemoryAtom {
  id: string;
  /** Who the information is ABOUT (not necessarily the speaker). */
  subject: string[];
  source: Source;
  /** Audience scope at the time the info was acquired (contextual integrity). */
  acquisitionContext: string;
  topics: string[];
  /** Ascending levels 1..n, n <= MAX_LAYERS. Frozen at ingest. */
  layers: Layer[];
  /** True until the owner approves atoms from non-owner sources. */
  quarantined: boolean;
}
