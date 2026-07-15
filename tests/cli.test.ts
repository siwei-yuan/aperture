import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps } from '../src/cli.js';
import type { MemoryAtom } from '../src/core/atom.js';
import { Ledger } from '../src/core/ledger.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';

function makeDeps() {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const deps: CliDeps = { db, ownerId: OWNER };
  return { db, store, ledger, deps };
}

async function run(deps: CliDeps, ...argv: string[]) {
  const lines: string[] = [];
  const code = await runCli(deps, argv, (l) => lines.push(l));
  return { code, lines, text: lines.join('\n') };
}

function quarantinedAtom(id: string): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: 'person:bob', channel: 'telegram:dm', ts: 1_000 },
    acquisitionContext: 'dm',
    topics: ['activity'],
    layers: [{ level: 1, text: 'bob has news', entities: ['bob'] }],
    quarantined: true,
  };
}

describe('owner CLI', () => {
  it('quarantine list → approve flips visibility and ledgers the approval', async () => {
    const { store, ledger, deps } = makeDeps();
    store.insert(quarantinedAtom('a-9'));

    const list = await run(deps, 'quarantine');
    expect(list.code).toBe(0);
    expect(list.text).toContain('a-9');
    expect(list.text).toContain('person:bob');

    const approve = await run(deps, 'approve', 'a-9');
    expect(approve.code).toBe(0);
    expect(store.listVisible()).toHaveLength(1);
    expect(store.listQuarantined()).toHaveLength(0);
    expect([...ledger.events()].map((e) => e.type)).toContain('atom.approved');

    const empty = await run(deps, 'quarantine');
    expect(empty.text).toBe('quarantine is empty');
  });

  it('approve on an unknown atom fails cleanly with a nonzero exit', async () => {
    const { deps } = makeDeps();
    const result = await run(deps, 'approve', 'nope');
    expect(result.code).toBe(1);
    expect(result.text).toContain('unknown atom');
  });

  it('grant changes check output; revoke restores default deny', async () => {
    const { deps } = makeDeps();

    expect((await run(deps, 'check', 'person:bob', 'topic:activity')).text).toBe('0');

    await run(deps, 'grant', 'topic:activity', 'viewer', 'person:bob', '3');
    expect((await run(deps, 'check', 'person:bob', 'topic:activity')).text).toBe('3');

    await run(deps, 'revoke', 'topic:activity', 'viewer', 'person:bob');
    expect((await run(deps, 'check', 'person:bob', 'topic:activity')).text).toBe('0');
  });

  it('grant validates the resolution range through to the core', async () => {
    const { deps } = makeDeps();
    const result = await run(deps, 'grant', 'topic:x', 'viewer', 'person:bob', '9');
    expect(result.code).toBe(1);
    expect(result.text).toContain('resolution must be an integer in 0..4');
  });

  it('disclosures filters by viewer and shows escalations', async () => {
    const { ledger, deps } = makeDeps();
    ledger.append('disclosure.adjudicated', {
      audience: ['person:bob'],
      candidates: 2,
      injected: [{ atomId: 'bili', level: 1 }],
    });
    ledger.append('disclosure.adjudicated', {
      audience: ['person:alice'],
      candidates: 2,
      injected: [{ atomId: 'bili', level: 3 }],
    });
    ledger.append('disclosure.request', {
      audience: ['person:bob'],
      hits: [{ kind: 'similarity', atomId: 'bili', level: 4 }],
    });

    const bob = await run(deps, 'disclosures', '--viewer', 'person:bob');
    expect(bob.lines).toHaveLength(2);
    expect(bob.lines[0]).toContain('bili@L1');
    expect(bob.lines[1]).toContain('ESCALATED');
    expect(bob.text).not.toContain('bili@L3');

    const all = await run(deps, 'disclosures');
    expect(all.lines).toHaveLength(3);
  });

  it('verify reports OK on an intact chain and BROKEN with nonzero exit after tampering', async () => {
    const { db, ledger, deps } = makeDeps();
    ledger.append('atom.ingested', { atomId: 'a1' });
    ledger.append('atom.ingested', { atomId: 'a2' });

    expect(await run(deps, 'verify')).toMatchObject({ code: 0, text: 'ledger chain OK' });

    db.prepare('UPDATE ledger SET payload = ? WHERE seq = 1').run('{"atomId":"FORGED"}');
    const broken = await run(deps, 'verify');
    expect(broken.code).toBe(1);
    expect(broken.text).toContain('BROKEN at seq 1');
  });

  it('unknown commands print usage and exit nonzero', async () => {
    const { deps } = makeDeps();
    const result = await run(deps, 'frobnicate');
    expect(result.code).toBe(1);
    expect(result.text).toContain('usage: aperture');
  });
});
