import type Database from 'better-sqlite3';
import type { Source } from '../core/atom.js';

/**
 * Deterministic ingress gates (G1a–G1e). Same input + same state ⇒ same
 * verdict; zero model calls; short-circuit in documented order. Most junk
 * dies here so it never costs an LLM call.
 */

export interface PrefilterConfig {
  /** G1a: minimum grapheme count after NFKC + emoji/punct/space strip. */
  minGraphemes: number;
  /** G1b: phatic patterns; coverage ≥ `phaticCoverage` fails. */
  phaticPatterns: RegExp[];
  phaticCoverage: number;
  /** G1c: Hamming distance ≤ this against recent fingerprints = duplicate. */
  dupHamming: number;
  fingerprintWindow: number;
  /** G1d: max ingress events per source per hour (anti-flooding too). */
  hourlyCapPerSource: number;
  /** G1e: channel substrings to exclude (cron, healthchecks, ...). */
  excludedChannels: string[];
}

export const DEFAULT_PREFILTER: PrefilterConfig = {
  minGraphemes: 6,
  phaticPatterns: [
    /在吗/g, /在不在/g, /你好/g, /早上好/g, /晚安/g, /好的/g, /收到/g, /谢谢/g,
    /兄弟/g, /哈+/g, /呵+/g, /嗯+/g, /哦+/g, /okay/gi, /ok/gi, /hello/gi, /hi/gi, /thanks/gi,
  ],
  phaticCoverage: 0.9,
  dupHamming: 3,
  fingerprintWindow: 256,
  hourlyCapPerSource: 30,
  excludedChannels: ['cron', 'healthcheck', 'monitoring'],
};

export type PrefilterResult = { pass: true } | { pass: false; gate: string; detail: string };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** NFKC-normalize and strip emoji, punctuation, symbols, separators, controls. */
function stripToCore(text: string): string {
  return text.normalize('NFKC').replace(/[\p{P}\p{S}\p{Z}\p{C}\s]/gu, '');
}

function graphemeCount(text: string): number {
  return [...segmenter.segment(text)].length;
}

// --- SimHash -----------------------------------------------------------------

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** 64-bit SimHash over character 3-grams of the normalized text. */
export function simhash64(text: string): bigint {
  const core = stripToCore(text.toLowerCase());
  const chars = Array.from(core);
  const grams: string[] = [];
  if (chars.length <= 3) grams.push(chars.join(''));
  else for (let i = 0; i + 2 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]! + chars[i + 2]!);

  const counts = new Array<number>(64).fill(0);
  for (const gram of grams) {
    const h = fnv1a64(gram);
    for (let bit = 0; bit < 64; bit++) {
      counts[bit]! += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) if (counts[bit]! > 0) out |= 1n << BigInt(bit);
  return out;
}

export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

function ensureFingerprintTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fingerprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fp TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `);
}

/** Record the fingerprint of an episode that reached gate 2 (i.e. cost money). */
export function recordFingerprint(
  db: Database.Database,
  fp: bigint,
  ts: number,
  config: PrefilterConfig = DEFAULT_PREFILTER,
): void {
  ensureFingerprintTable(db);
  db.prepare('INSERT INTO fingerprints (fp, ts) VALUES (?, ?)').run(fp.toString(16), ts);
  db.prepare(
    `DELETE FROM fingerprints WHERE id <= (
       SELECT id FROM fingerprints ORDER BY id DESC LIMIT 1 OFFSET ?
     )`,
  ).run(config.fingerprintWindow);
}

// --- The gates ---------------------------------------------------------------

export function prefilter(
  db: Database.Database,
  episode: { content: string; source: Source },
  config: PrefilterConfig = DEFAULT_PREFILTER,
): PrefilterResult {
  const core = stripToCore(episode.content);

  // G1a — length after strip
  const graphemes = graphemeCount(core);
  if (graphemes < config.minGraphemes) {
    return { pass: false, gate: 'G1a-length', detail: `${graphemes} graphemes < ${config.minGraphemes}` };
  }

  // G1b — phatic lexicon coverage
  let remaining = core.toLowerCase();
  for (const pattern of config.phaticPatterns) remaining = remaining.replace(pattern, '');
  const coverage = 1 - graphemeCount(remaining) / graphemes;
  if (coverage >= config.phaticCoverage) {
    return { pass: false, gate: 'G1b-phatic', detail: `coverage ${(coverage * 100).toFixed(0)}%` };
  }

  // G1c — near-duplicate against the recent fingerprint ring
  ensureFingerprintTable(db);
  const fp = simhash64(episode.content);
  const recent = db
    .prepare('SELECT fp FROM fingerprints ORDER BY id DESC LIMIT ?')
    .all(config.fingerprintWindow) as Array<{ fp: string }>;
  for (const row of recent) {
    const distance = hamming64(fp, BigInt(`0x${row.fp}`));
    if (distance <= config.dupHamming) {
      return { pass: false, gate: 'G1c-duplicate', detail: `hamming ${distance} <= ${config.dupHamming}` };
    }
  }

  // G1d — per-source hourly cap, counted from the ledger (includes this
  // episode's own ingress.received appended by capture() before the gates)
  const windowStart = episode.source.ts - 3_600_000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ledger
       WHERE type = 'ingress.received' AND ts >= ? AND json_extract(payload, '$.who') = ?`,
    )
    .get(windowStart, episode.source.who) as { n: number };
  if (row.n > config.hourlyCapPerSource) {
    return { pass: false, gate: 'G1d-rate', detail: `${row.n} events/h > ${config.hourlyCapPerSource}` };
  }

  // G1e — excluded channels
  for (const needle of config.excludedChannels) {
    if (episode.source.channel.includes(needle)) {
      return { pass: false, gate: 'G1e-channel', detail: `channel matches "${needle}"` };
    }
  }

  return { pass: true };
}
