import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/db.js';
import { Ledger, canonicalJson } from '../src/core/ledger.js';

function makeLedger() {
  const db = new Database(':memory:');
  return { db, ledger: new Ledger(db) };
}

describe('hash-chained ledger', () => {
  it('verifies an intact chain', () => {
    const { ledger } = makeLedger();
    ledger.append('atom.ingested', { atomId: 'a1' });
    ledger.append('atom.ingested', { atomId: 'a2' });
    ledger.append('atom.promoted', { atomId: 'a2', approverId: 'owner' });
    expect(ledger.verify()).toEqual({ ok: true });
  });

  it('detects payload tampering', () => {
    const { db, ledger } = makeLedger();
    ledger.append('atom.ingested', { atomId: 'a1' });
    ledger.append('atom.ingested', { atomId: 'a2' });

    db.prepare('UPDATE ledger SET payload = ? WHERE seq = 1').run(canonicalJson({ atomId: 'FORGED' }));

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(1);
  });

  it('detects a deleted event in the middle of the chain', () => {
    const { db, ledger } = makeLedger();
    ledger.append('e', { n: 1 });
    ledger.append('e', { n: 2 });
    ledger.append('e', { n: 3 });

    db.prepare('DELETE FROM ledger WHERE seq = 2').run();

    expect(ledger.verify().ok).toBe(false);
  });

  it('detects hash rewrites even when the payload is untouched', () => {
    const { db, ledger } = makeLedger();
    ledger.append('e', { n: 1 });
    db.prepare('UPDATE ledger SET hash = ? WHERE seq = 1').run('0'.repeat(64));
    expect(ledger.verify().ok).toBe(false);
  });

  it('projections are rebuildable by replay', () => {
    const { ledger } = makeLedger();
    ledger.append('atom.ingested', { atomId: 'a1', scope: 'local' });
    ledger.append('atom.ingested', { atomId: 'a2', scope: 'global' });
    ledger.append('atom.promoted', { atomId: 'a1', approverId: 'owner' });

    // Rebuild the "currently local" projection purely from events.
    const local = new Set<string>();
    for (const event of ledger.events()) {
      const payload = event.payload as { atomId: string; scope?: string };
      if (event.type === 'atom.ingested' && payload.scope === 'local') local.add(payload.atomId);
      if (event.type === 'atom.promoted') local.delete(payload.atomId);
    }
    expect(local.size).toBe(0);

    const counts: Record<string, number> = {};
    for (const event of ledger.events()) counts[event.type] = (counts[event.type] ?? 0) + 1;
    expect(counts).toEqual({ 'atom.ingested': 2, 'atom.promoted': 1 });
  });

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalJson({ a: { c: [3], d: 2 }, b: 1 }));
  });
});

describe('append concurrency invariants', () => {
  function withSharedFile(run: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'aperture-ledger-'));
    try {
      run(join(dir, 'shared.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('appends from two connections to one file interleave into an intact chain', () => {
    withSharedFile((path) => {
      const dbA = openDatabase(path);
      const dbB = openDatabase(path);
      const a = new Ledger(dbA);
      const b = new Ledger(dbB);
      for (let i = 0; i < 10; i++) {
        a.append('e', { from: 'A', i });
        b.append('e', { from: 'B', i });
      }
      const seqs = [...a.events()].map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(a.verify()).toEqual({ ok: true });
      expect(b.verify()).toEqual({ ok: true });
      dbA.close();
      dbB.close();
    });
  });

  it('append takes the write lock BEFORE reading the head (BEGIN IMMEDIATE semantics)', () => {
    withSharedFile((path) => {
      const dbA = openDatabase(path);
      const dbB = openDatabase(path);
      dbA.pragma('busy_timeout = 0'); // fail fast instead of queueing, so the test is instant
      const a = new Ledger(dbA);
      new Ledger(dbB);
      a.append('e', { n: 1 });

      // B holds the write lock; A's append must fail up front — atomically,
      // with nothing inserted — rather than read a head that may go stale.
      dbB.exec('BEGIN IMMEDIATE');
      expect(() => a.append('e', { n: 2 })).toThrow(/busy|locked/i);
      dbB.exec('ROLLBACK');

      const after = a.append('e', { n: 2 });
      expect(after.seq).toBe(2);
      expect(a.verify()).toEqual({ ok: true });
      dbA.close();
      dbB.close();
    });
  });

  it('openDatabase tolerates :memory: (WAL unsupported there, silently kept off)', () => {
    const db = openDatabase(':memory:');
    const ledger = new Ledger(db);
    ledger.append('e', { n: 1 });
    expect(ledger.verify()).toEqual({ ok: true });
  });
});
