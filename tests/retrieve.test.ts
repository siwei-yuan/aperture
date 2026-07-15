import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore, resolutionForAtom, type RelationTuple } from '../src/core/rebac.js';
import { retrieve, type RetrieveDeps } from '../src/core/retrieve.js';
import { AtomStore } from '../src/core/store.js';

const embedder = hashEmbedder(32);

function ladder(atomId: string, depth: number): MemoryAtom['layers'] {
  const layers = [];
  for (let level = 1; level <= depth; level++) {
    layers.push({ level, text: `${atomId} fact at level ${level} detail`, entities: [] });
  }
  return layers;
}

function atom(id: string, topics: string[], depth: number, quarantined = false): MemoryAtom {
  return {
    id,
    subject: ['person:owner'],
    source: { who: 'person:owner', channel: 'screen', ts: 1_000 },
    acquisitionContext: 'private',
    topics,
    layers: ladder(id, depth),
    quarantined,
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

  it('quarantined atoms never surface, and every call is adjudicated on the ledger', async () => {
    const deps = await makeStack(
      [atom('clean', ['activity'], 2), atom('poison', ['activity'], 2, true)],
      [T('topic:activity', 'viewer', 'person:alice', 4)],
    );
    const res = await retrieve(deps, { audience: ['person:alice'], query: 'fact', k: 10 });

    expect(res.items.map((i) => i.atomId)).toEqual(['clean']);
    const events = [...deps.ledger.events()].filter((e) => e.type === 'disclosure.adjudicated');
    expect(events).toHaveLength(1);
  });

  it('THE invariant: no returned level ever exceeds the audience minimum', async () => {
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
        quarantined: fc.boolean(),
      }),
      { minLength: 1, maxLength: 3 },
    ).map((list) => list.filter((a, i) => list.findIndex((b) => b.idx === a.idx) === i));
    const audienceArb = fc.uniqueArray(fc.constantFrom(...PERSONS), { minLength: 1, maxLength: 2 });

    await fc.assert(
      fc.asyncProperty(atomsArb, fc.array(tupleArb, { maxLength: 12 }), audienceArb, async (atomSpecs, tuples, audience) => {
        const atoms = atomSpecs.map((s) => atom(`a${s.idx}`, s.topics, s.depth, s.quarantined));
        const deps = await makeStack(atoms, tuples);
        const res = await retrieve(deps, { audience, query: 'fact detail', k: 10 });

        for (const item of res.items) {
          const source = atoms.find((a) => a.id === item.atomId)!;
          expect(source.quarantined).toBe(false);
          const audienceMin = Math.min(
            ...audience.map((m) => resolutionForAtom(deps.db, m, source)),
          );
          expect(item.level).toBeLessThanOrEqual(audienceMin);
          expect(item.level).toBeLessThanOrEqual(source.layers.length);
        }
      }),
      { numRuns: 50 },
    );
  });
});
