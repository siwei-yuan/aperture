import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { retrieveForSession, type RetrieveDeps } from '../src/core/retrieve.js';
import { AtomStore } from '../src/core/store.js';
import {
  ensureSessionTables,
  getSession,
  linkIdentity,
  narrowScope,
  sessionFor,
  widenScope,
} from '../src/session/router.js';

const OWNER = 'person:owner';

function atom(id: string, topics: string[]): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: OWNER, channel: 'screen', ts: 1_000 },
    acquisitionContext: 'private',
    topics,
    layers: [{ level: 1, text: `${id} fact detail`, entities: [] }],
    acquisitionAudience: [OWNER],
    scope: 'global',
  };
}

async function makeStack(opts?: { atoms?: MemoryAtom[]; sensitiveTopics?: string[] }): Promise<{
  deps: RetrieveDeps;
  sessionId: string;
  alicePerson: string;
  db: Database.Database;
}> {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, hashEmbedder(32));
  const acl = new AclStore(db, ledger);

  const atoms = opts?.atoms ?? [atom('sched', ['schedule']), atom('health', ['health'])];
  for (const a of atoms) {
    store.insert(a);
    await vectors.index(a);
  }

  const session = sessionFor(db, {
    platform: 'telegram',
    channel: 'dm:alice',
    peerExternalIds: ['alice_tg'],
    ownerId: OWNER,
  });
  const alicePerson = session.audience[0]!;
  for (const a of atoms) {
    for (const t of a.topics) {
      acl.applyGrant({ object: `topic:${t}`, relation: 'viewer', subject: alicePerson, resolution: 4 });
    }
  }

  return {
    deps: { db, ledger, store, vectors, ownerId: OWNER, sensitiveTopics: opts?.sensitiveTopics },
    sessionId: session.id,
    alicePerson,
    db,
  };
}

const scopeEvents = (ledger: import('../src/core/ledger.js').Ledger) =>
  [...ledger.events()].filter((e) => e.type === 'scope.widened');

describe('TBAC task scope — the driver', () => {
  it('a fresh non-owner session starts at scope [] and auto-widens to its first question\'s topics, ledgered', async () => {
    const { deps, sessionId, db } = await makeStack();
    expect(getSession(db, sessionId)!.scope).toEqual([]); // need-to-know default

    const res = await retrieveForSession(deps, { sessionId, query: 'sched fact detail', k: 1 });
    expect(res.items.map((i) => i.atomId)).toEqual(['sched']); // effective this very call

    const events = scopeEvents(deps.ledger);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ sessionId, from: [] });
    expect(getSession(db, sessionId)!.scope).toContain('schedule');
  });

  it('scope only ever expands through widenScope, and every expansion carries a ledger event', async () => {
    const { deps, sessionId, db } = await makeStack();
    await retrieveForSession(deps, { sessionId, query: 'sched fact detail', k: 1 });
    await retrieveForSession(deps, { sessionId, query: 'health fact detail', k: 1 });

    // Every scope the session ever held is reachable from [] through the
    // event chain alone — no expansion happened off the books.
    let replayed: string[] = [];
    for (const event of scopeEvents(deps.ledger)) {
      const p = event.payload as { from: string[]; to: string[] | null };
      expect([...p.from].sort()).toEqual([...replayed].sort());
      expect(p.to === null || p.from.every((t) => p.to!.includes(t))).toBe(true); // never shrinks
      replayed = p.to ?? [];
    }
    expect([...replayed].sort()).toEqual(getSession(db, sessionId)!.scope);
  });

  it('narrowScope still mechanically refuses to add topics', async () => {
    const { deps, sessionId } = await makeStack();
    await retrieveForSession(deps, { sessionId, query: 'sched fact detail', k: 1 });
    expect(() => narrowScope(deps.db, sessionId, ['schedule', 'health'])).toThrow(/use widenScope/);
  });

  it('scope entries cover their subtree (ancestor logic), and a subtopic entry does not cover the parent', async () => {
    const { deps, sessionId } = await makeStack({
      atoms: [atom('alpha', ['work/alpha']), atom('plain', ['work'])],
      sensitiveTopics: ['work'], // freeze the driver so the filter itself is observable
    });

    widenScope(deps, sessionId, ['work/alpha']);
    const narrow = await retrieveForSession(deps, { sessionId, query: 'fact detail', k: 10 });
    expect(narrow.items.map((i) => i.atomId)).toEqual(['alpha']); // subtopic entry: no climb to parent

    widenScope(deps, sessionId, ['work']);
    const wide = await retrieveForSession(deps, { sessionId, query: 'fact detail', k: 10 });
    expect(wide.items.map((i) => i.atomId).sort()).toEqual(['alpha', 'plain']); // parent covers subtree
  });

  it('the owner alone is never scope-limited — even with an empty scope on the session row', async () => {
    const db = new Database(':memory:');
    const store = new AtomStore(db);
    const ledger = new Ledger(db);
    const vectors = new VectorStore(db, hashEmbedder(32));
    const acl = new AclStore(db, ledger);
    for (const a of [atom('sched', ['schedule']), atom('health', ['health'])]) {
      store.insert(a);
      await vectors.index(a);
    }
    acl.applyGrant({ object: 'topic:schedule', relation: 'viewer', subject: OWNER, resolution: 4 });
    acl.applyGrant({ object: 'topic:health', relation: 'viewer', subject: OWNER, resolution: 4 });

    // Force the worst case: an owner session that somehow carries scope [].
    ensureSessionTables(db);
    db.prepare("INSERT INTO sessions (id, channel, audience, scope) VALUES ('self', 'self', ?, '[]')").run(
      JSON.stringify([OWNER]),
    );

    const deps: RetrieveDeps = { db, ledger, store, vectors, ownerId: OWNER, sensitiveTopics: ['health'] };
    const res = await retrieveForSession(deps, { sessionId: 'self', query: 'fact detail', k: 10 });
    expect(res.items.map((i) => i.atomId).sort()).toEqual(['health', 'sched']);
    expect(res.scopeBlocked).toEqual([]); // no friction against oneself
    expect(scopeEvents(ledger)).toHaveLength(0); // and nothing to widen

    // An owner's fresh session is born unscoped; a stranger's is born at [].
    linkIdentity(db, 'telegram', 'me_tg', OWNER);
    const own = sessionFor(db, { platform: 'telegram', channel: 'dm:me_tg', peerExternalIds: ['me_tg'], ownerId: OWNER });
    expect(own.scope).toBeNull();
    const stranger = sessionFor(db, { platform: 'telegram', channel: 'dm:bob_tg', peerExternalIds: ['bob_tg'], ownerId: OWNER });
    expect(stranger.scope).toEqual([]);
  });

  it('sensitive topics are not auto-widened and their content stays out; approval lets it in', async () => {
    const { deps, sessionId, db } = await makeStack({ sensitiveTopics: ['health'] });

    const res = await retrieveForSession(deps, { sessionId, query: 'health fact detail', k: 10 });
    expect(res.items.map((i) => i.atomId)).not.toContain('health'); // withheld
    expect(res.scopeBlocked).toEqual([{ topic: 'health', sessionId }]);
    expect(getSession(db, sessionId)!.scope).not.toContain('health'); // not widened

    // Owner signs: widenScope is the approval primitive (console/CLI call it).
    widenScope(deps, sessionId, ['health']);
    const approved = await retrieveForSession(deps, { sessionId, query: 'health fact detail', k: 10 });
    expect(approved.items.map((i) => i.atomId)).toContain('health');
    expect(approved.scopeBlocked).toEqual([]);
  });

  it('sensitivity walks the ancestor path: a sensitive parent freezes its subtopics too', async () => {
    const { deps, sessionId } = await makeStack({
      atoms: [atom('mental', ['health/mental'])],
      sensitiveTopics: ['health'],
    });
    const res = await retrieveForSession(deps, { sessionId, query: 'mental fact detail', k: 10 });
    expect(res.items).toHaveLength(0);
    expect(res.scopeBlocked.map((b) => b.topic)).toEqual(['health/mental']);
  });

  it('topic inference never uses ReBAC-forbidden atoms as an oracle', async () => {
    const { deps, sessionId, db } = await makeStack({
      atoms: [atom('sched', ['schedule']), atom('secret', ['finance'])],
    });
    // Revoke alice's finance grant: the finance atom is ReBAC-invisible.
    const session = getSession(db, sessionId)!;
    db.prepare('DELETE FROM tuples WHERE object = ? AND subject = ?').run(
      'topic:finance',
      session.audience[0]!,
    );

    const res = await retrieveForSession(deps, { sessionId, query: 'secret fact detail', k: 10 });
    expect(res.items.map((i) => i.atomId)).not.toContain('secret');
    expect(getSession(db, sessionId)!.scope).not.toContain('finance'); // not even inferred
  });
});
