import Database from 'better-sqlite3';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';
import { linkIdentity } from '../src/session/router.js';
import { atomVisibility, buildState, listAtoms, movePreview, tierMove, topicTree, viewerReport, type UiDeps } from '../src/ui/api.js';
import { parseTokenFromHash, renderPage } from '../src/ui/page.js';
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

describe('knowledge browser: topic tree and atom listing', () => {
  it('topic filter matches by subtree, same ancestor semantics as the evaluator', () => {
    const deps = makeDeps();
    deps.store.insert(atom('a-work', ['work'], 2));
    deps.store.insert(atom('a-alpha', ['work/alpha'], 2));
    deps.store.insert(atom('a-life', ['life'], 2));

    expect(listAtoms(deps, { topic: 'work' }).map((a) => a.atomId).sort()).toEqual(['a-alpha', 'a-work']);
    expect(listAtoms(deps, { topic: 'work/alpha' }).map((a) => a.atomId)).toEqual(['a-alpha']);
    expect(listAtoms(deps, { topic: 'life' }).map((a) => a.atomId)).toEqual(['a-life']);
  });

  it('scope filter includes sealed atoms — the owner shelf shows rejects', () => {
    const deps = makeDeps();
    deps.store.insert(atom('a-g', ['work'], 2, 'global'));
    deps.store.insert(atom('a-l', ['work'], 2, 'local'));
    deps.store.insert(atom('a-s', ['work'], 2, 'sealed'));

    expect(listAtoms(deps, {}).map((a) => a.atomId).sort()).toEqual(['a-g', 'a-l', 'a-s']);
    expect(listAtoms(deps, { scope: 'sealed' }).map((a) => a.atomId)).toEqual(['a-s']);
  });

  it('topic tree materializes intermediate nodes with subtree counts, folding in policy-only and discovered topics', () => {
    const deps = makeDeps();
    deps.store.insert(atom('a1', ['work/alpha'], 2));
    deps.store.insert(atom('a2', ['work/alpha'], 2));
    deps.store.insert(atom('a3', ['work'], 2));
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 2 });
    deps.ledger.append('topic.discovered', { topic: 'hobby/climbing', atomId: 'a1' });

    const tree = topicTree(deps);
    expect(tree.map((n) => n.path)).toEqual(['health', 'hobby', 'work']);
    const work = tree.find((n) => n.path === 'work')!;
    expect(work.atomCount).toBe(3); // whole subtree
    expect(work.children).toEqual([{ path: 'work/alpha', atomCount: 2, children: [] }]);
    expect(tree.find((n) => n.path === 'health')!.atomCount).toBe(0);
    expect(tree.find((n) => n.path === 'hobby')!.children[0]!.path).toBe('hobby/climbing');
  });

  it('viewer filter reproduces retrieval ceilings: ancestor grants apply, invisible atoms drop out', () => {
    const deps = makeDeps();
    deps.acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:carol', resolution: 4 });
    deps.acl.grant({ object: 'topic:work', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
    deps.store.insert(atom('a-alpha', ['work/alpha'], 2, 'global')); // covered by the coarse "work" grant
    deps.store.insert(atom('a-life', ['life'], 4, 'global')); // no grant — invisible
    deps.store.insert(atom('a-local', ['work'], 3, 'local')); // carol was not in the room

    const seen = listAtoms(deps, { viewer: 'person:carol' });
    expect(seen.map((a) => a.atomId)).toEqual(['a-alpha']);
    // resolution 3 clamped to the 2-layer ladder
    expect(seen[0]!.viewerLevel).toBe(2);

    // bob WAS in the room (test atoms carry him in acquisitionAudience): local visible at full depth
    const bobSees = listAtoms(deps, { viewer: 'person:bob' });
    expect(bobSees.find((a) => a.atomId === 'a-local')!.viewerLevel).toBe(3);
  });

  it('atomVisibility walks every known person through the real ceiling logic per scope', () => {
    const deps = makeDeps();
    linkIdentity(deps.db, 'telegram', 'carol_tg', 'person:carol');
    deps.acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:carol', resolution: 4 });
    deps.acl.grant({ object: 'topic:work', relation: 'viewer', subject: 'tier:friend#member', resolution: 1 });
    deps.acl.grant({ object: 'topic:work', relation: 'viewer', subject: OWNER, resolution: 4 });

    deps.store.insert(atom('a-g', ['work'], 4, 'global'));
    const globalVis = atomVisibility(deps, 'a-g').people;
    expect(globalVis).toContainEqual({ personId: OWNER, level: 4 });
    expect(globalVis).toContainEqual({ personId: 'person:carol', level: 1 });
    // bob has no grants: level 0 despite being the source
    expect(globalVis).toContainEqual({ personId: 'person:bob', level: 0 });

    deps.store.insert(atom('a-l', ['work'], 3, 'local'));
    const localVis = atomVisibility(deps, 'a-l').people;
    // presence beats policy: bob (in the acquisition room) sees the full ladder, carol nothing
    expect(localVis).toContainEqual({ personId: 'person:bob', level: 3 });
    expect(localVis).toContainEqual({ personId: OWNER, level: 3 });
    expect(localVis).toContainEqual({ personId: 'person:carol', level: 0 });

    deps.store.insert(atom('a-s', ['work'], 4, 'sealed'));
    expect(atomVisibility(deps, 'a-s').people.every((p) => p.level === 0)).toBe(true);
  });
});

describe('token fragment parsing', () => {
  const hex = 'deadbeef00112233deadbeef00112233';

  it('parses the plain fragment the server prints', () => {
    expect(parseTokenFromHash(`#t=${hex}`)).toBe(hex);
  });

  it('parses a percent-encoded fragment (some openers encode "=" as %3D)', () => {
    expect(parseTokenFromHash(`#t%3D${hex}`)).toBe(hex);
    expect(parseTokenFromHash(`#%74%3D${hex}`)).toBe(hex); // fully encoded
  });

  it('rejects hashes without a token instead of matching noise', () => {
    expect(parseTokenFromHash('')).toBe('');
    expect(parseTokenFromHash('#')).toBe('');
    expect(parseTokenFromHash('#view=matrix')).toBe('');
    expect(parseTokenFromHash(`#nott=${hex}`)).toBe(''); // "t=" must start a fragment param
  });

  it('tolerates malformed percent-escapes by falling back to the raw hash', () => {
    expect(parseTokenFromHash(`#t=${hex}%E0%A4%A`)).toBe(hex);
  });

  it('the served page embeds this exact parser', () => {
    expect(renderPage()).toContain('function parseTokenFromHash');
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

  it('tier policy edit lifecycle: grant, regrade (upsert), revoke falls back to derived', async () => {
    // nested tier: inner derives from outer, so the revoke has somewhere to fall
    deps.acl.grant({ object: 'tier:inner', relation: 'member', subject: 'person:carol', resolution: 4 });
    deps.acl.grant({ object: 'tier:outer', relation: 'member', subject: 'tier:inner#member', resolution: 4 });
    deps.acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:outer#member', resolution: 1 });

    const send = (path: string, body: unknown) =>
      api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // the ring panel's SET L3: one grant tuple
    await send('/api/grant', { object: 'topic:health', relation: 'viewer', subject: 'tier:inner#member', resolution: 3 });
    let cell = buildState(deps).matrix.tierRows.find((r) => r.tier === 'inner')!.cells['health']!;
    expect(cell).toMatchObject({ explicit: 3, effective: 3 });

    // clicking another segment regrades in place (same tuple key, upsert)
    await send('/api/grant', { object: 'topic:health', relation: 'viewer', subject: 'tier:inner#member', resolution: 2 });
    cell = buildState(deps).matrix.tierRows.find((r) => r.tier === 'inner')!.cells['health']!;
    expect(cell).toMatchObject({ explicit: 2, effective: 2 });

    // clicking the lit level clears: explicit gone, evaluator's derived value shows through
    await send('/api/revoke', { object: 'topic:health', relation: 'viewer', subject: 'tier:inner#member' });
    cell = buildState(deps).matrix.tierRows.find((r) => r.tier === 'inner')!.cells['health']!;
    expect(cell).toMatchObject({ explicit: null, effective: 1 });

    // every step is on the ledger, chain intact
    expect([...deps.ledger.events()].filter((e) => e.type.startsWith('acl.'))).toHaveLength(6);
    expect(deps.ledger.verify()).toEqual({ ok: true });
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
