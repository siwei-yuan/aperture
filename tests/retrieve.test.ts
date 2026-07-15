import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AtomScope, MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore, resolutionForAtom, type RelationTuple } from '../src/core/rebac.js';
import { retrieve, type RetrieveDeps } from '../src/core/retrieve.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';
const embedder = hashEmbedder(32);

function ladder(atomId: string, depth: number): MemoryAtom['layers'] {
  const layers = [];
  for (let level = 1; level <= depth; level++) {
    layers.push({ level, text: `${atomId} fact at level ${level} detail`, entities: [] });
  }
  return layers;
}

function atom(
  id: string,
  topics: string[],
  depth: number,
  opts?: { scope?: AtomScope; acquisitionAudience?: string[] },
): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: OWNER, channel: 'screen', ts: 1_000 },
    acquisitionContext: 'private',
    acquisitionAudience: opts?.acquisitionAudience ?? [OWNER],
    topics,
    layers: ladder(id, depth),
    scope: opts?.scope ?? 'global',
  };
}

async function makeStack(atoms: MemoryAtom[], tuples: RelationTuple[]): Promise<RetrieveDeps> {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, embedder);
  const acl = new AclStore(db, ledger);
  for (const a of atoms) {
    store.insert(a);
    await vectors.index(a);
  }
  for (const t of tuples) acl.applyGrant(t);
  return { db, ledger, store, vectors };
}

const T = (object: string, relation: string, subject: string, resolution: number): RelationTuple => ({
  object,
  relation,
  subject,
  resolution,
});

describe('retrieval adjudication', () => {
  it('same question, two tiers, two resolutions (hero scenario)', async () => {
    const deps = await makeStack(
      [atom('bili', ['activity'], 4)],
      [
        T('topic:activity', 'viewer', 'tier:friend#member', 3),
        T('topic:activity', 'viewer', 'tier:stranger#member', 1),
        T('tier:friend', 'member', 'person:alice', 4),
        T('tier:stranger', 'member', 'person:bob', 4),
      ],
    );

    const alice = await retrieve(deps, { audience: ['person:alice'], query: 'bili fact' });
    const bob = await retrieve(deps, { audience: ['person:bob'], query: 'bili fact' });

    expect(alice.items[0]!.level).toBe(3);
    expect(bob.items[0]!.level).toBe(1);
    expect(alice.items[0]!.text).toContain('level 3');
    expect(bob.items[0]!.text).toContain('level 1');
  });

  it('group audiences are capped by their weakest member', async () => {
    const deps = await makeStack(
      [atom('bili', ['activity'], 4)],
      [
        T('topic:activity', 'viewer', 'person:alice', 3),
        T('topic:activity', 'viewer', 'person:bob', 1),
      ],
    );
    const group = await retrieve(deps, { audience: ['person:alice', 'person:bob'], query: 'bili' });
    expect(group.items[0]!.level).toBe(1);

    const withStranger = await retrieve(deps, {
      audience: ['person:alice', 'person:mallory'],
      query: 'bili',
    });
    expect(withStranger.items).toHaveLength(0);
  });

  it('local atoms surface at full resolution inside their acquisition room, regardless of grants', async () => {
    const deps = await makeStack(
      [atom('gossip', ['social'], 3, { scope: 'local', acquisitionAudience: [OWNER, 'person:bob'] })],
      [], // bob has NO grants at all
    );
    const bobRoom = await retrieve(deps, { audience: ['person:bob'], query: 'gossip fact' });
    expect(bobRoom.items).toHaveLength(1);
    expect(bobRoom.items[0]!.level).toBe(3); // finest layer — he already heard the raw thing

    const ownerRoom = await retrieve(deps, { audience: [OWNER], query: 'gossip fact' });
    expect(ownerRoom.items).toHaveLength(1); // the owner is an implicit member everywhere
  });

  it('local atoms are invisible outside the room even to fully-granted viewers, and get suggested', async () => {
    const deps = await makeStack(
      [atom('gossip', ['social'], 3, { scope: 'local', acquisitionAudience: [OWNER, 'person:bob'] })],
      [T('topic:social', 'viewer', 'person:alice', 4)],
    );
    const alice = await retrieve(deps, { audience: ['person:alice'], query: 'gossip fact' });
    expect(alice.items).toHaveLength(0);
    // Demand-driven promotion: the block itself produces the suggestion...
    expect(alice.suggestions.map((s) => s.atomId)).toEqual(['gossip']);
    expect(alice.suggestions[0]!.summary).toContain('level 1'); // coarsest layer only

    // ...exactly once, ever (the ledger event is the dedupe record).
    const again = await retrieve(deps, { audience: ['person:alice'], query: 'gossip fact' });
    expect(again.suggestions).toHaveLength(0);
    const suggested = [...deps.ledger.events()].filter((e) => e.type === 'promotion.suggested');
    expect(suggested).toHaveLength(1);
  });

  it('a mixed room (insider + outsider) does not see the local atom', async () => {
    const deps = await makeStack(
      [atom('gossip', ['social'], 3, { scope: 'local', acquisitionAudience: [OWNER, 'person:bob'] })],
      [],
    );
    const mixed = await retrieve(deps, { audience: ['person:bob', 'person:carol'], query: 'gossip' });
    expect(mixed.items).toHaveLength(0);
  });

  it('sealed atoms never surface, and every call is adjudicated on the ledger', async () => {
    const deps = await makeStack(
      [atom('clean', ['activity'], 2), atom('poison', ['activity'], 2, { scope: 'sealed' })],
      [T('topic:activity', 'viewer', 'person:alice', 4)],
    );
    const res = await retrieve(deps, { audience: ['person:alice'], query: 'fact', k: 10 });

    expect(res.items.map((i) => i.atomId)).toEqual(['clean']);
    const events = [...deps.ledger.events()].filter((e) => e.type === 'disclosure.adjudicated');
    expect(events).toHaveLength(1);
  });

  it('THE invariant: no returned level ever exceeds the audience ceiling', async () => {
    const PERSONS = ['person:p0', 'person:p1'];
    const subjectArb = fc.constantFrom(...PERSONS, 'g:a#member', 'g:b#member');
    const tupleArb: fc.Arbitrary<RelationTuple> = fc.oneof(
      fc.record({
        object: fc.constantFrom('topic:t0', 'topic:t1', 'atom:a0', 'atom:a1', 'atom:a2'),
        relation: fc.constant('viewer'),
        subject: subjectArb,
        resolution: fc.integer({ min: 0, max: 4 }),
      }),
      fc.record({
        object: fc.constantFrom('g:a', 'g:b'),
        relation: fc.constant('member'),
        subject: subjectArb,
        resolution: fc.integer({ min: 0, max: 4 }),
      }),
    );
    const atomsArb = fc.array(
      fc.record({
        idx: fc.constantFrom(0, 1, 2),
        topics: fc.uniqueArray(fc.constantFrom('t0', 't1'), { minLength: 1, maxLength: 2 }),
        depth: fc.integer({ min: 1, max: 4 }),
        scope: fc.constantFrom<AtomScope>('global', 'local', 'sealed'),
        roomWith: fc.uniqueArray(fc.constantFrom(...PERSONS), { maxLength: 2 }),
      }),
      { minLength: 1, maxLength: 3 },
    ).map((list) => list.filter((a, i) => list.findIndex((b) => b.idx === a.idx) === i));
    const audienceArb = fc.uniqueArray(fc.constantFrom(...PERSONS), { minLength: 1, maxLength: 2 });

    await fc.assert(
      fc.asyncProperty(atomsArb, fc.array(tupleArb, { maxLength: 12 }), audienceArb, async (atomSpecs, tuples, audience) => {
        const atoms = atomSpecs.map((s) =>
          atom(`a${s.idx}`, s.topics, s.depth, {
            scope: s.scope,
            acquisitionAudience: [OWNER, ...s.roomWith],
          }),
        );
        const deps = await makeStack(atoms, tuples);
        const res = await retrieve(deps, { audience, query: 'fact detail', k: 10 });

        for (const item of res.items) {
          const source = atoms.find((a) => a.id === item.atomId)!;
          expect(source.scope).not.toBe('sealed');
          expect(item.level).toBeLessThanOrEqual(source.layers.length);
          if (source.scope === 'local') {
            // Only reachable via presence at acquisition.
            for (const member of audience) {
              expect(source.acquisitionAudience).toContain(member);
            }
          } else {
            const audienceMin = Math.min(
              ...audience.map((m) => resolutionForAtom(deps.db, m, source)),
            );
            expect(item.level).toBeLessThanOrEqual(audienceMin);
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
