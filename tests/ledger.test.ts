import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
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
    ledger.append('atom.approved', { atomId: 'a2', approverId: 'owner' });
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
    ledger.append('atom.ingested', { atomId: 'a1', quarantined: true });
    ledger.append('atom.ingested', { atomId: 'a2', quarantined: false });
    ledger.append('atom.approved', { atomId: 'a1', approverId: 'owner' });

    // Rebuild the "currently quarantined" projection purely from events.
    const quarantined = new Set<string>();
    for (const event of ledger.events()) {
      const payload = event.payload as { atomId: string; quarantined?: boolean };
      if (event.type === 'atom.ingested' && payload.quarantined) quarantined.add(payload.atomId);
      if (event.type === 'atom.approved') quarantined.delete(payload.atomId);
    }
    expect(quarantined.size).toBe(0);

    const counts: Record<string, number> = {};
    for (const event of ledger.events()) counts[event.type] = (counts[event.type] ?? 0) + 1;
    expect(counts).toEqual({ 'atom.ingested': 2, 'atom.approved': 1 });
  });

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalJson({ a: { c: [3], d: 2 }, b: 1 }));
  });
});
