import type { Ledger } from './ledger.js';

/**
 * Mosaic tracking: the dual cost of the ladder design, paid here. Coarse
 * layers flow freely, but many "harmless" fragments compose into a
 * sensitive picture — so each outsider carries a per-topic budget of NOVEL
 * disclosures per time window.
 *
 * No tables, no cursor: the per-viewer profile is a pure scan over
 * `disclosure.adjudicated` events. The data has been on the ledger since
 * the first retrieval — this module is only a projection.
 *
 * Deliberately deferred until real data exists to calibrate them:
 * embedding-cluster coverage scoring, timing-pattern analysis.
 */

export interface MosaicConfig {
  ownerId: string;
  /** Max distinct NOVEL atoms per topic per window for one viewer. */
  budgetPerTopic?: number;
  windowMs?: number;
}

const DEFAULT_BUDGET = 10;
const DEFAULT_WINDOW_MS = 3_600_000;

interface AdjudicatedPayload {
  audience: string[];
  injected?: Array<{ atomId: string; level: number }>;
}

export interface DisclosedAtom {
  maxLevel: number;
  firstTs: number;
}

/** Everything ever disclosed to `viewer`: atomId → max level and first time. */
export function disclosureProfile(ledger: Ledger, viewer: string): Map<string, DisclosedAtom> {
  const out = new Map<string, DisclosedAtom>();
  for (const event of ledger.events()) {
    if (event.type !== 'disclosure.adjudicated') continue;
    const payload = event.payload as AdjudicatedPayload;
    if (!payload.audience.includes(viewer)) continue;
    for (const item of payload.injected ?? []) {
      const known = out.get(item.atomId);
      if (!known) {
        out.set(item.atomId, { maxLevel: item.level, firstTs: event.ts });
      } else {
        known.maxLevel = Math.max(known.maxLevel, item.level);
        known.firstTs = Math.min(known.firstTs, event.ts);
      }
    }
  }
  return out;
}

export interface WithheldItem<T> {
  item: T;
  topic: string;
  viewer: string;
}

/**
 * Budget filter for candidate items, most-relevant first. Semantics:
 * - re-disclosing something a viewer already knows (at that level or finer)
 *   is free — old information composes no new picture;
 * - novelty is counted per (viewer, topic) within the window;
 * - the owner is exempt; group audiences compose conservatively (any member
 *   over budget withholds the item).
 */
export function applyMosaicBudget<T extends { atomId: string; level: number }>(
  deps: { ledger: Ledger; config: MosaicConfig },
  req: {
    audience: string[];
    items: T[];
    topicsOf: (atomId: string) => string[];
    now: number;
  },
): { allowed: T[]; withheld: Array<WithheldItem<T>> } {
  const budget = deps.config.budgetPerTopic ?? DEFAULT_BUDGET;
  const windowMs = deps.config.windowMs ?? DEFAULT_WINDOW_MS;
  const members = req.audience.filter((m) => m !== deps.config.ownerId);
  if (members.length === 0) return { allowed: req.items, withheld: [] };

  const perMember = members.map((viewer) => {
    const profile = disclosureProfile(deps.ledger, viewer);
    const counts = new Map<string, number>();
    for (const [atomId, info] of profile) {
      if (info.firstTs >= req.now - windowMs) {
        for (const topic of req.topicsOf(atomId)) {
          counts.set(topic, (counts.get(topic) ?? 0) + 1);
        }
      }
    }
    return { viewer, profile, counts };
  });

  const allowed: T[] = [];
  const withheld: Array<WithheldItem<T>> = [];

  for (const item of req.items) {
    const topics = req.topicsOf(item.atomId);
    let blocked: { topic: string; viewer: string } | undefined;

    for (const member of perMember) {
      const known = member.profile.get(item.atomId);
      if (known && known.maxLevel >= item.level) continue; // nothing novel for them
      for (const topic of topics) {
        if ((member.counts.get(topic) ?? 0) >= budget) {
          blocked = { topic, viewer: member.viewer };
          break;
        }
      }
      if (blocked) break;
    }

    if (blocked) {
      withheld.push({ item, ...blocked });
      continue;
    }

    allowed.push(item);
    // Consume budget for every member to whom this item is novel, and treat
    // it as disclosed for the rest of this batch.
    for (const member of perMember) {
      const known = member.profile.get(item.atomId);
      if (known && known.maxLevel >= item.level) continue;
      for (const topic of topics) {
        member.counts.set(topic, (member.counts.get(topic) ?? 0) + 1);
      }
      member.profile.set(item.atomId, { maxLevel: item.level, firstTs: req.now });
    }
  }

  return { allowed, withheld };
}
