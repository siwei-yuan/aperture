import Database from 'better-sqlite3';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';
import { linkIdentity } from '../src/session/router.js';
import { buildState, movePreview, tierMove, viewerReport, type UiDeps } from '../src/ui/api.js';
import { createUiServer } from '../src/ui/server.js';

const OWNER = 'person:owner';
const TOKEN = 'a'.repeat(32);

function ladder(id: string, depth: number): MemoryAtom['layers'] {
  return Array.from({ length: depth }, (_, i) => ({
    level: i + 1,
    text: `${id} level ${i + 1}`,
    entities: [],
  }));
}

function atom(id: string, topics: string[], depth: number, scope: MemoryAtom['scope'] = 'global'): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: 'person:bob', channel: 'telegram:dm', ts: 1_000 },
    acquisitionContext: 'telegram:dm',
    acquisitionAudience: ['person:bob', OWNER],
    topics,
    layers: ladder(id, depth),
    scope,
  };
}

function makeDeps(): UiDeps {
  const db = new Database(':memory:');
  const ledger = new Ledger(db);
  const store = new AtomStore(db);
  const acl = new AclStore(db, ledger);
  return { db, ledger, store, acl, ownerId: OWNER };
}

describe('ui state assembly: derived vs explicit', () => {
  it('marks explicit tuples and computes derived effective values', () => {
    const deps = makeDeps();
    deps.acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:bob', resolution: 4 });
    deps.acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:carol', resolution: 4 });
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
    // carol gets a per-person exception tighter than her tier
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'person:carol', resolution: 2 });
    deps.acl.grant({ object: 'topic:work', relation: 'viewer', subject: 'person:carol', resolution: 1 });
    deps.store.insert(atom('a1', ['health'], 4));

    const state = buildState(deps);

    const friendRow = state.matrix.tierRows.find((r) => r.tier === 'friend')!;
    expect(friendRow.cells['health']).toEqual({ explicit: 3, effective: 3, derivedFrom: null });

    // bob has no direct tuple → no exception row for him
    expect(state.matrix.personRows.map((r) => r.personId)).toEqual(['person:carol']);

    const carol = state.matrix.personRows[0]!;
    // explicit exception: her own tuple wins the shape, but check() still
    // takes the max across paths — the tier path (3) beats her cap (2).
    expect(carol.cells['health']!.explicit).toBe(2);
    expect(carol.cells['health']!.effective).toBe(3);
    expect(carol.cells['work']).toEqual({ explicit: 1, effective: 1, derivedFrom: null });

    // a topic with only the tier policy: carol's cell is derived, labeled with the path
    deps.acl.grant({ object: 'topic:travel', relation: 'viewer', subject: 'tier:friend#member', resolution: 2 });
    const carol2 = buildState(deps).matrix.personRows[0]!;
    expect(carol2.cells['travel']).toEqual({ explicit: null, effective: 2, derivedFrom: 'tier:friend#member' });
  });

  it('topics include both policy-only and memory-only topics with atom counts', () => {
    const deps = makeDeps();
    deps.acl.grant({ object: 'topic:policyonly', relation: 'viewer', subject: 'tier:friend#member', resolution: 1 });
    deps.store.insert(atom('a1', ['memoryonly'], 2));
    const topics = buildState(deps).topics;
    expect(topics).toEqual([
      { name: 'memoryonly', atomCount: 1 },
      { name: 'policyonly', atomCount: 0 },
    ]);
  });

  it('people fold aliases and memberships; strangers have no tiers', () => {
    const deps = makeDeps();
    linkIdentity(deps.db, 'telegram', 'bob123', 'person:bob');
    linkIdentity(deps.db, 'wechat', 'bob_wx', 'person:bob');
    linkIdentity(deps.db, 'telegram', 'stranger9', 'person:mallory');
    deps.acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:bob', resolution: 4 });

    const people = buildState(deps).people;
    const bob = people.find((p) => p.personId === 'person:bob')!;
    expect(bob.aliases).toHaveLength(2);
    expect(bob.tiers).toEqual(['friend']);
    const mallory = people.find((p) => p.personId === 'person:mallory')!;
    expect(mallory.tiers).toEqual([]);
    expect(people.find((p) => p.personId === OWNER)!.isOwner).toBe(true);
  });
});

describe('viewer report fold', () => {
  it('folds adjudications into known atoms, hides undisclosed depth, and builds the timeline', () => {
    const deps = makeDeps();
    deps.store.insert(atom('a1', ['health'], 4));
    deps.store.insert(atom('a2', ['work'], 2));
    deps.ledger.append('disclosure.adjudicated', {
      audience: ['person:bob'],
      injected: [{ atomId: 'a1', level: 1 }],
    }, 1_000);
    deps.ledger.append('disclosure.adjudicated', {
      audience: ['person:bob'],
      injected: [{ atomId: 'a1', level: 3 }, { atomId: 'a2', level: 2 }],
    }, 2_000);
    deps.ledger.append('disclosure.adjudicated', { audience: ['person:carol'], injected: [{ atomId: 'a1', level: 4 }] }, 3_000);
    deps.ledger.append('disclosure.adjudicated', { audience: ['person:bob'], injected: [] }, 4_000);

    const report = viewerReport(deps, 'person:bob');
    expect(report.summary).toEqual({ atomCount: 2, deepCount: 1, topicCount: 2, lastTs: 4_000 });

    const a1 = report.knownAtoms.find((a) => a.atomId === 'a1')!;
    expect(a1.seenLevel).toBe(3); // max across events, carol's L4 not counted
    expect(a1.seenText).toBe('a1 level 3');
    expect(a1.hiddenDeeper).toBe(1);
    expect(a1.firstTs).toBe(1_000);

    // newest first; the empty adjudication is present and marked
    expect(report.timeline.map((t) => t.ts)).toEqual([4_000, 2_000, 1_000]);
    expect(report.timeline[0]!.detail).toBe('asked — nothing was disclosable');
  });
});

describe('tier move', () => {
  it('emits revoke then grant as two honest ledger events', () => {
    const deps = makeDeps();
    deps.acl.grant({ object: 'tier:stranger', relation: 'member', subject: 'person:bob', resolution: 4 });

    tierMove(deps.acl, 'person:bob', 'stranger', 'friend');

    const events = [...deps.ledger.events()].map((e) => ({ type: e.type, payload: e.payload as { object: string } }));
    expect(events.map((e) => e.type)).toEqual(['acl.granted', 'acl.revoked', 'acl.granted']);
    expect(events[1]!.payload.object).toBe('tier:stranger');
    expect(events[2]!.payload.object).toBe('tier:friend');

    const state = buildState(deps);
    expect(state.tiers.find((t) => t.name === 'friend')!.members).toEqual(['person:bob']);
    // no registry: a tier with no remaining tuples ceases to exist
    expect(state.tiers.find((t) => t.name === 'stranger')).toBeUndefined();
  });

  it('a move from the unknown zone is a pure grant', () => {
    const deps = makeDeps();
    tierMove(deps.acl, 'person:new', null, 'friend');
    expect([...deps.ledger.events()].map((e) => e.type)).toEqual(['acl.granted']);
  });

  it('movePreview computes the per-topic diff with zero side effects', () => {
    const deps = makeDeps();
    deps.acl.grant({ object: 'tier:stranger', relation: 'member', subject: 'person:bob', resolution: 4 });
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:stranger#member', resolution: 1 });
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
    deps.acl.grant({ object: 'topic:work', relation: 'viewer', subject: 'tier:stranger#member', resolution: 2 });
    const eventsBefore = [...deps.ledger.events()].length;

    const diff = movePreview(deps, 'person:bob', 'stranger', 'friend');

    expect(diff).toEqual([
      { topic: 'health', before: 1, after: 3 },
      { topic: 'work', before: 2, after: 0 },
    ]);
    // hypothetical only: no ledger event, projection untouched
    expect([...deps.ledger.events()]).toHaveLength(eventsBefore);
    const state = buildState(deps);
    expect(state.tiers.find((t) => t.name === 'stranger')!.members).toEqual(['person:bob']);
  });
});

describe('http server: auth and pass-through', () => {
  let deps: UiDeps;
  let base: string;
  let port: number;
  let close: () => void;

  beforeEach(async () => {
    deps = makeDeps();
    const { server } = createUiServer(deps, { token: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    close = () => server.close();
  });

  afterEach(() => close());

  const api = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    });

  it('rejects /api requests without the token', async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(401);
    const bad = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${'b'.repeat(32)}` } });
    expect(bad.status).toBe(401);
  });

  it('serves the page without a token (data only flows through /api)', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('rejects requests whose Host header is not loopback (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example.com', authorization: `Bearer ${TOKEN}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('rejects write requests without a JSON content type', async () => {
    const res = await api('/api/grant', { method: 'POST', body: 'object=x' });
    expect(res.status).toBe(415);
  });

  it('grant passes through to AclStore.grant: ledger first, then projection', async () => {
    const res = await api('/api/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 }),
    });
    expect(res.status).toBe(200);

    const events = [...deps.ledger.events()];
    expect(events.map((e) => e.type)).toEqual(['acl.granted']);
    const row = deps.db
      .prepare('SELECT resolution FROM tuples WHERE object = ? AND subject = ?')
      .get('topic:health', 'tier:friend#member') as { resolution: number };
    expect(row.resolution).toBe(3);
  });

  it("core's range check surfaces as a 400, and nothing is written", async () => {
    const res = await api('/api/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object: 'topic:health', relation: 'viewer', subject: 'person:bob', resolution: 9 }),
    });
    expect(res.status).toBe(400);
    expect([...deps.ledger.events()]).toHaveLength(0);
  });

  it('revoke passes through and the matrix cell falls back to the derived value', async () => {
    deps.acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:carol', resolution: 4 });
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'person:carol', resolution: 1 });

    const res = await api('/api/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object: 'topic:health', relation: 'viewer', subject: 'person:carol' }),
    });
    expect(res.status).toBe(200);

    const state = (await (await api('/api/state')).json()) as ReturnType<typeof buildState>;
    // still an exception row this rebuild? no direct tuple left → row disappears entirely
    expect(state.matrix.personRows).toHaveLength(0);
    expect([...deps.ledger.events()].at(-1)!.type).toBe('acl.revoked');
  });

  it('promote passes through owner-signed and flips scope', async () => {
    deps.store.insert(atom('local1', ['general'], 2, 'local'));
    const res = await api('/api/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ atomId: 'local1' }),
    });
    expect(res.status).toBe(200);
    expect(deps.store.get('local1')!.scope).toBe('global');
    expect([...deps.ledger.events()].at(-1)!.type).toBe('atom.promoted');
  });

  it('head reflects ledger growth so the page knows when to refetch', async () => {
    const before = (await (await api('/api/head')).json()) as { seq: number };
    deps.ledger.append('e', { n: 1 });
    const after = (await (await api('/api/head')).json()) as { seq: number };
    expect(after.seq).toBe(before.seq + 1);
  });
});
