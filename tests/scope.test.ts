import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { retrieveForSession, type RetrieveDeps } from '../src/core/retrieve.js';
import { AtomStore } from '../src/core/store.js';
import { narrowScope, sessionFor, widenScope } from '../src/session/router.js';

function atom(id: string, topics: string[]): MemoryAtom {
  return {
    id,
    subject: ['person:owner'],
    source: { who: 'person:owner', channel: 'screen', ts: 1_000 },
    acquisitionContext: 'private',
    topics,
    layers: [{ level: 1, text: `${id} fact detail`, entities: [] }],
    acquisitionAudience: ['person:owner'],
    scope: 'global',
  };
}

async function makeStack(): Promise<{ deps: RetrieveDeps; sessionId: string; alicePerson: string }> {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, hashEmbedder(32));
  const acl = new AclStore(db, ledger);

  for (const a of [atom('sched', ['schedule']), atom('health', ['health'])]) {
    store.insert(a);
    await vectors.index(a);
  }

  const session = sessionFor(db, { platform: 'telegram', channel: 'dm:alice', peerExternalIds: ['alice_tg'] });
  const alicePerson = session.audience[0]!;
  acl.applyGrant({ object: 'topic:schedule', relation: 'viewer', subject: alicePerson, resolution: 4 });
  acl.applyGrant({ object: 'topic:health', relation: 'viewer', subject: alicePerson, resolution: 4 });

  return { deps: { db, ledger, store, vectors }, sessionId: session.id, alicePerson };
}

const scopeEvents = (ledger: Ledger) => [...ledger.events()].filter((e) => e.type === 'scope.widened');

describe('TBAC task scope', () => {
  it('unscoped sessions see everything ReBAC allows; narrowed sessions do not', async () => {
    const { deps, sessionId } = await makeStack();

    const unscoped = await retrieveForSession(deps, { sessionId, query: 'fact detail', k: 10 });
    expect(unscoped.items.map((i) => i.atomId).sort()).toEqual(['health', 'sched']);

    narrowScope(deps.db, sessionId, ['schedule']);
    const scoped = await retrieveForSession(deps, { sessionId, query: 'fact detail', k: 10 });
    expect(scoped.items.map((i) => i.atomId)).toEqual(['sched']);

    expect(scopeEvents(deps.ledger)).toHaveLength(0); // narrowing is free
  });

  it('widening requires a ledger event and makes atoms reappear', async () => {
    const { deps, sessionId } = await makeStack();
    narrowScope(deps.db, sessionId, ['schedule']);

    widenScope(deps, sessionId, ['health']);
    const events = scopeEvents(deps.ledger);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ sessionId, from: ['schedule'], to: ['health', 'schedule'] });

    const res = await retrieveForSession(deps, { sessionId, query: 'fact detail', k: 10 });
    expect(res.items.map((i) => i.atomId).sort()).toEqual(['health', 'sched']);
  });

  it('narrowScope mechanically refuses to add topics', async () => {
    const { deps, sessionId } = await makeStack();
    narrowScope(deps.db, sessionId, ['schedule']);
    expect(() => narrowScope(deps.db, sessionId, ['schedule', 'health'])).toThrow(/use widenScope/);
  });

  it('widening to null lifts all restriction; widening an unscoped session is a no-op', async () => {
    const { deps, sessionId } = await makeStack();

    widenScope(deps, sessionId, ['health']); // already unscoped
    expect(scopeEvents(deps.ledger)).toHaveLength(0);

    narrowScope(deps.db, sessionId, ['schedule']);
    widenScope(deps, sessionId, null);
    expect(scopeEvents(deps.ledger)).toHaveLength(1);

    const res = await retrieveForSession(deps, { sessionId, query: 'fact detail', k: 10 });
    expect(res.items).toHaveLength(2);
  });
});
