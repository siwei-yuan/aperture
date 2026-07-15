import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { disclosureProfile } from '../src/core/disclosure-profile.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { retrieve, type RetrieveDeps } from '../src/core/retrieve.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';
const BOB = 'person:bob';
const T0 = 1_720_000_000_000;
const HOUR = 3_600_000;

function atom(id: string, text: string): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: OWNER, channel: 'screen', ts: 1_000 },
    acquisitionContext: 'private',
    topics: ['activity'],
    layers: [{ level: 1, text, entities: [] }],
    acquisitionAudience: ['person:owner'],
    scope: 'global',
  };
}

async function makeStack(budgetPerTopic: number): Promise<RetrieveDeps> {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, hashEmbedder(32));
  const acl = new AclStore(db, ledger);

  for (let i = 1; i <= 5; i++) {
    const a = atom(`a${i}`, `daily activity fact number ${i} about the routine`);
    store.insert(a);
    await vectors.index(a);
  }
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: BOB, resolution: 1 });

  return {
    db,
    ledger,
    store,
    vectors,
    mosaic: { ownerId: OWNER, budgetPerTopic, windowMs: HOUR },
  };
}

const throttledEvents = (ledger: Ledger) =>
  [...ledger.events()].filter((e) => e.type === 'disclosure.throttled');

describe('mosaic tracking (T6.1)', () => {
  it('jigsaw sequence trips the throttle: budget caps novel atoms per topic per window', async () => {
    const deps = await makeStack(3);
    const res = await retrieve(deps, { audience: [BOB], query: 'daily activity fact', k: 10, now: T0 });

    expect(res.items).toHaveLength(3); // 5 relevant, budget 3

    const events = throttledEvents(deps.ledger);
    expect(events).toHaveLength(1);
    const withheld = (events[0]!.payload as { withheld: Array<{ atomId: string; topic: string; viewer: string }> })
      .withheld;
    expect(withheld).toHaveLength(2);
    expect(withheld[0]).toMatchObject({ topic: 'activity', viewer: BOB });

    // The adjudicated event records only what actually entered the context.
    const adjudicated = [...deps.ledger.events()].filter((e) => e.type === 'disclosure.adjudicated');
    expect((adjudicated[0]!.payload as { injected: unknown[] }).injected).toHaveLength(3);

    // The profile is a pure ledger projection and matches what was injected.
    const profile = disclosureProfile(deps.ledger, BOB);
    expect(profile.size).toBe(3);
    expect([...profile.values()].every((d) => d.firstTs === T0)).toBe(true);
  });

  it('re-disclosing known atoms is free; the window resets the budget', async () => {
    const deps = await makeStack(3);
    await retrieve(deps, { audience: [BOB], query: 'daily activity fact', k: 10, now: T0 });

    // Same question minutes later: 3 known atoms are free, the 2 novel ones
    // are still over budget within the window.
    const again = await retrieve(deps, { audience: [BOB], query: 'daily activity fact', k: 10, now: T0 + 10 * 60_000 });
    expect(again.items).toHaveLength(3);
    expect(throttledEvents(deps.ledger)).toHaveLength(2);

    // After the window slides past, the budget recovers and the remaining
    // two atoms finally flow.
    const later = await retrieve(deps, { audience: [BOB], query: 'daily activity fact', k: 10, now: T0 + 2 * HOUR });
    expect(later.items).toHaveLength(5);
    expect(throttledEvents(deps.ledger)).toHaveLength(2); // no new throttle
    expect(disclosureProfile(deps.ledger, BOB).size).toBe(5);
  });

  it('the owner is exempt even at budget zero', async () => {
    const deps = await makeStack(0);
    const acl = new AclStore(deps.db, deps.ledger);
    acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: OWNER, resolution: 4 });

    const res = await retrieve(deps, { audience: [OWNER], query: 'daily activity fact', k: 10, now: T0 });
    expect(res.items).toHaveLength(5);
    expect(throttledEvents(deps.ledger)).toHaveLength(0);
  });

  it('group audiences compose conservatively: one exhausted member withholds the item', async () => {
    const deps = await makeStack(1);
    const acl = new AclStore(deps.db, deps.ledger);
    const ALICE = 'person:alice';
    acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: ALICE, resolution: 1 });

    // Exhaust bob's budget in a DM.
    await retrieve(deps, { audience: [BOB], query: 'daily activity fact', k: 1, now: T0 });

    // In a group with alice (fresh budget), bob's exhaustion still withholds novel atoms.
    const group = await retrieve(deps, {
      audience: [BOB, ALICE],
      query: 'daily activity fact',
      k: 10,
      now: T0 + 60_000,
    });
    // bob already knows one atom (free for him, novel-but-within-budget for alice):
    // that one flows; everything else is blocked by bob's spent budget.
    expect(group.items).toHaveLength(1);
    expect(disclosureProfile(deps.ledger, BOB).size).toBe(1);
  });

  it('without a mosaic config nothing throttles (opt-in)', async () => {
    const deps = await makeStack(1);
    const res = await retrieve(
      { ...deps, mosaic: undefined },
      { audience: [BOB], query: 'daily activity fact', k: 10, now: T0 },
    );
    expect(res.items).toHaveLength(5);
    expect(throttledEvents(deps.ledger)).toHaveLength(0);
  });
});
