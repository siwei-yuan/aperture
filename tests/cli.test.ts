import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDeps } from '../src/cli.js';
import type { MemoryAtom } from '../src/core/atom.js';
import { Ledger } from '../src/core/ledger.js';
import { AtomStore } from '../src/core/store.js';
import { getSession, sessionFor } from '../src/session/router.js';

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

function localAtom(id: string): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: 'person:bob', channel: 'telegram:dm', ts: 1_000 },
    acquisitionContext: 'dm',
    acquisitionAudience: [OWNER, 'person:bob'],
    topics: ['activity'],
    layers: [{ level: 1, text: 'bob has news', entities: ['bob'] }],
    scope: 'local',
  };
}

describe('owner CLI', () => {
  it('pending list → promote lifts the atom to global and ledgers the promotion', async () => {
    const { store, ledger, deps } = makeDeps();
    store.insert(localAtom('a-9'));

    const list = await run(deps, 'pending');
    expect(list.code).toBe(0);
    expect(list.text).toContain('a-9');
    expect(list.text).toContain('person:bob');

    const promote = await run(deps, 'promote', 'a-9');
    expect(promote.code).toBe(0);
    expect(store.listGlobal()).toHaveLength(1);
    expect(store.listLocal()).toHaveLength(0);
    expect([...ledger.events()].map((e) => e.type)).toContain('atom.promoted');

    const empty = await run(deps, 'pending');
    expect(empty.text).toBe('no room-local atoms');
  });

  it('seal rejects an atom out of every read path', async () => {
    const { store, ledger, deps } = makeDeps();
    store.insert(localAtom('a-7'));

    const seal = await run(deps, 'seal', 'a-7');
    expect(seal.code).toBe(0);
    expect(store.get('a-7')?.scope).toBe('sealed');
    expect(store.listRetrievable()).toHaveLength(0);
    expect([...ledger.events()].map((e) => e.type)).toContain('atom.sealed');
  });

  it('promote on an unknown atom fails cleanly with a nonzero exit', async () => {
    const { deps } = makeDeps();
    const result = await run(deps, 'promote', 'nope');
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

  it('allow widens a session scope with a ledger event; unknown sessions fail cleanly', async () => {
    const { db, ledger, deps } = makeDeps();
    const session = sessionFor(db, {
      platform: 'telegram',
      channel: 'dm:mom_tg',
      peerExternalIds: ['mom_tg'],
      ownerId: OWNER,
    });

    const ok = await run(deps, 'allow', session.id, 'health');
    expect(ok.code).toBe(0);
    expect(getSession(db, session.id)!.scope).toEqual(['health']);
    expect([...ledger.events()].filter((e) => e.type === 'scope.widened')).toHaveLength(1);

    const bad = await run(deps, 'allow', 'telegram:dm:nobody', 'health');
    expect(bad.code).toBe(1);
    expect(bad.text).toContain('unknown session');
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
