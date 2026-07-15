import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface LedgerEvent {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = 'GENESIS';

/** JSON with recursively sorted object keys, so hashing is order-independent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function eventHash(seq: number, ts: number, type: string, payloadJson: string, prevHash: string): string {
  return createHash('sha256')
    .update(`${prevHash}\n${seq}\n${ts}\n${type}\n${payloadJson}`)
    .digest('hex');
}

/**
 * Append-only hash-chained event log. The single source of truth: every
 * ingest, adjudication, and disclosure decision is an event here, and all
 * projections must be rebuildable by replaying it.
 */
export class Ledger {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        seq       INTEGER PRIMARY KEY,
        ts        INTEGER NOT NULL,
        type      TEXT    NOT NULL,
        payload   TEXT    NOT NULL,
        prev_hash TEXT    NOT NULL,
        hash      TEXT    NOT NULL
      )
    `);
  }

  append(type: string, payload: unknown, ts: number = Date.now()): LedgerEvent {
    const last = this.db
      .prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1')
      .get() as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const payloadJson = canonicalJson(payload);
    const hash = eventHash(seq, ts, type, payloadJson, prevHash);
    this.db
      .prepare('INSERT INTO ledger (seq, ts, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(seq, ts, type, payloadJson, prevHash, hash);
    return { seq, ts, type, payload, prevHash, hash };
  }

  /** Walks the full chain recomputing hashes. */
  verify(): { ok: boolean; brokenAtSeq?: number } {
    let expectedPrev = GENESIS;
    let expectedSeq = 1;
    for (const row of this.rows()) {
      if (row.seq !== expectedSeq) return { ok: false, brokenAtSeq: row.seq };
      if (row.prev_hash !== expectedPrev) return { ok: false, brokenAtSeq: row.seq };
      const recomputed = eventHash(row.seq, row.ts, row.type, row.payload, row.prev_hash);
      if (recomputed !== row.hash) return { ok: false, brokenAtSeq: row.seq };
      expectedPrev = row.hash;
      expectedSeq = row.seq + 1;
    }
    return { ok: true };
  }

  *events(): IterableIterator<LedgerEvent> {
    for (const row of this.rows()) {
      yield {
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        payload: JSON.parse(row.payload),
        prevHash: row.prev_hash,
        hash: row.hash,
      };
    }
  }

  private rows(): Array<{ seq: number; ts: number; type: string; payload: string; prev_hash: string; hash: string }> {
    return this.db.prepare('SELECT * FROM ledger ORDER BY seq ASC').all() as Array<{
      seq: number;
      ts: number;
      type: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }>;
  }
}
