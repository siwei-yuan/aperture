import type Database from 'better-sqlite3';
import type { VectorStore } from './embed.js';
import type { Ledger } from './ledger.js';
import { ceilingsForAudience } from './rebac.js';
import type { AtomStore } from './store.js';

/**
 * Second line of defense. The first line (retrieve) keeps secrets out of the
 * context; this one catches replies that reconstruct them anyway — from
 * parametric knowledge or inference. Deterministic PII scan first, then
 * exact similarity against the BLOCKED complement: every layer above the
 * audience's ceiling. Ceilings come from the same rule retrieval uses
 * (`ceilingsForAudience`), so repeating a local atom back into its own
 * acquisition room is not a leak, while sealed atoms and out-of-room local
 * atoms are fully blocked.
 */

export interface EgressDeps {
  db: Database.Database;
  ledger: Ledger;
  store: AtomStore;
  vectors: VectorStore;
}

export interface EgressHit {
  sentence: string;
  kind: 'pii' | 'similarity';
  detail: string;
  atomId?: string;
  level?: number;
}

export interface EgressResult {
  verdict: 'pass' | 'escalate';
  hits: EgressHit[];
}

const SENTENCE_SPLIT = /[。！？!?；;\n]+/;

// No 'g' flags: RegExp#test with /g/ is stateful across calls.
const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'cn-mobile', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: 'intl-phone', pattern: /\+\d{7,15}/ },
  { name: 'cn-id', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { name: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: 'cn-address', pattern: /[\u4e00-\u9fa5]{1,12}(?:路|街|巷|大道)\d{1,5}号/ },
];

export async function checkEgress(
  deps: EgressDeps,
  req: { audience: string[]; reply: string; threshold?: number },
): Promise<EgressResult> {
  const threshold = req.threshold ?? 0.82;
  const sentences = req.reply
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const hits: EgressHit[] = [];

  for (const sentence of sentences) {
    for (const { name, pattern } of PII_PATTERNS) {
      if (pattern.test(sentence)) hits.push({ sentence, kind: 'pii', detail: name });
    }
  }

  // Audience ceilings via the shared adjudication rule; anything absent
  // from the map (sealed, out-of-room local, ungranted) has ceiling 0 —
  // every layer of it is blocked.
  const ceilings = ceilingsForAudience(deps.db, req.audience, deps.store.listRetrievable());

  for (const sentence of sentences) {
    const vec = await deps.vectors.embedQuery(sentence);
    for (const scored of deps.vectors.scoreAll(vec)) {
      const ceiling = ceilings.get(scored.atomId) ?? 0;
      if (scored.level <= ceiling) continue; // permitted layer — not a leak
      if (scored.score >= threshold) {
        hits.push({
          sentence,
          kind: 'similarity',
          detail: `cosine ${scored.score.toFixed(2)} vs blocked layer`,
          atomId: scored.atomId,
          level: scored.level,
        });
      }
    }
  }

  if (hits.length === 0) return { verdict: 'pass', hits: [] }; // silent pass — no event

  deps.ledger.append('disclosure.request', {
    audience: req.audience,
    hits: hits.map((h) => ({
      kind: h.kind,
      detail: h.detail,
      atomId: h.atomId,
      level: h.level,
      sentence: h.sentence.slice(0, 120),
    })),
  });
  return { verdict: 'escalate', hits };
}
