import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { hashEmbedder } from '../src/core/embed.js';
import type { LayerDraft, LayerGenerator, RawEvent } from '../src/core/ingest.js';
import { IngestPipeline } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore, resolutionForAtom } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';
import { foldAtoms, invalidateEdge, resetGraph, type FactExtractor, type FoldDeps } from '../src/graph/fold.js';
import { neighbors } from '../src/graph/query.js';

const OWNER = 'person:owner';
const BOB = 'person:bob';
const ALICE = 'person:alice';

/** Extractor mirroring the ladder: owner --mentions--> each later entity. */
const ladderExtractor: FactExtractor = {
  extract: async (layers) => {
    const seen = new Map<string, number>();
    for (const layer of layers) {
      for (const entity of layer.entities) if (!seen.has(entity)) seen.set(entity, layer.level);
    }
    const entities = [...seen.entries()].map(([name, firstLevel]) => ({ name, kind: 'thing', firstLevel }));
    const anchor = entities[0]!.name;
    const facts = entities.slice(1).map((e) => ({ src: anchor, predicate: 'mentions', dst: e.name, level: e.firstLevel }));
    return { entities, facts };
  },
};

const biliDrafts: LayerDraft[] = [
  { level: 1, text: 'at computer', entities: ['owner'] },
  { level: 2, text: 'watching video', entities: ['owner', 'video'] },
  { level: 3, text: 'on bilibili', entities: ['owner', 'video', 'bilibili'] },
  { level: 4, text: 'rust async explained', entities: ['owner', 'video', 'bilibili', 'rust-async-explained'] },
];

function makeStack() {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const acl = new AclStore(db, ledger);
  const fold: FoldDeps = {
    db,
    ledger,
    extractor: ladderExtractor,
    embedder: hashEmbedder(32),
    functionalPredicates: ['lives_in'],
  };
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: BOB, resolution: 1 });
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: ALICE, resolution: 3 });
  return { db, store, ledger, acl, fold };
}

function makePipeline(db: Database.Database, store: AtomStore, ledger: Ledger, drafts: LayerDraft[]) {
  const generator: LayerGenerator = { generate: async () => structuredClone(drafts) };
  return new IngestPipeline({ store, ledger, ownerId: OWNER, generator });
}

function event(ts: number): RawEvent {
  return {
    content: 'x',
    subject: [OWNER],
    topics: ['activity'],
    source: { who: OWNER, channel: 'screen', ts },
    acquisitionContext: 'private',
  };
}

describe('gated graph queries (T5.2)', () => {
  it('the graph never knows more than the atoms: per-tier bypass test', async () => {
    const { db, store, ledger, fold } = makeStack();
    await makePipeline(db, store, ledger, biliDrafts).ingest(event(1_000));
    await foldAtoms(fold);

    for (const [viewer, ceiling] of [
      [BOB, 1],
      [ALICE, 3],
      ['person:mallory', 0],
    ] as Array<[string, number]>) {
      // Allowed entity closure from the ATOM side: entities on layers ≤ ceiling.
      const allowed = new Set<string>();
      for (const atom of store.listGlobal()) {
        const r = resolutionForAtom(db, viewer, atom);
        for (const layer of atom.layers) {
          if (layer.level <= r) layer.entities.forEach((e: string) => allowed.add(e));
        }
      }

      // Reachable entity set from the GRAPH side.
      const edges = neighbors({ db, store }, { audience: [viewer], entity: 'owner', depth: 3 });
      const reachable = new Set(edges.flatMap((e) => [e.srcName, e.dstName]));

      for (const name of reachable) {
        expect(allowed.has(name), `${viewer} reached "${name}" beyond ceiling L${ceiling}`).toBe(true);
      }
    }
  });

  it('alice (L3) sees the bilibili edge; bob (L1) sees nothing; L4 stays invisible to both', async () => {
    const { db, store, ledger, fold } = makeStack();
    await makePipeline(db, store, ledger, biliDrafts).ingest(event(1_000));
    await foldAtoms(fold);

    const alice = neighbors({ db, store }, { audience: [ALICE], entity: 'owner', depth: 3 });
    expect(alice.map((e) => e.dstName).sort()).toEqual(['bilibili', 'video']);

    const bob = neighbors({ db, store }, { audience: [BOB], entity: 'owner', depth: 3 });
    expect(bob).toHaveLength(0); // all edges are min_level ≥ 2

    expect(alice.find((e) => e.dstName === 'rust-async-explained')).toBeUndefined();
  });

  it('functional predicates supersede: old residence closes, history remains queryable', async () => {
    const { db, store, ledger, fold } = makeStack();
    const beijing: LayerDraft[] = [
      { level: 1, text: 'owner lives somewhere', entities: ['owner'] },
      { level: 2, text: 'owner lives in beijing', entities: ['owner', 'beijing'] },
    ];
    const shanghai: LayerDraft[] = [
      { level: 1, text: 'owner lives somewhere', entities: ['owner'] },
      { level: 2, text: 'owner lives in shanghai', entities: ['owner', 'shanghai'] },
    ];
    // lives_in extractor variant
    const livesExtractor: FactExtractor = {
      extract: async (layers) => {
        const city = layers[1]!.entities[1]!;
        return {
          entities: [
            { name: 'owner', kind: 'thing', firstLevel: 1 },
            { name: city, kind: 'thing', firstLevel: 2 },
          ],
          facts: [{ src: 'owner', predicate: 'lives_in', dst: city, level: 2 }],
        };
      },
    };
    const foldDeps = { ...fold, extractor: livesExtractor };

    await makePipeline(db, store, ledger, beijing).ingest(event(1_000));
    await makePipeline(db, store, ledger, shanghai).ingest(event(2_000));
    await foldAtoms(foldDeps);

    const current = neighbors({ db, store }, { audience: [ALICE], entity: 'owner', depth: 1 });
    expect(current.map((e) => e.dstName)).toEqual(['shanghai']);

    const historical = neighbors(
      { db, store },
      { audience: [ALICE], entity: 'owner', depth: 1, includeInvalidated: true },
    );
    expect(historical.map((e) => e.dstName).sort()).toEqual(['beijing', 'shanghai']);
    expect(historical.find((e) => e.dstName === 'beijing')!.invalidated).toBe(true);
  });

  it('manual invalidation is ledgered and survives a graph rebuild', async () => {
    const { db, store, ledger, fold } = makeStack();
    await makePipeline(db, store, ledger, biliDrafts).ingest(event(1_000));
    await foldAtoms(fold);

    const edge = neighbors({ db, store }, { audience: [ALICE], entity: 'owner', depth: 1 })[0]!;
    invalidateEdge({ db, ledger }, edge.id, 5_000);

    expect([...ledger.events()].some((e) => e.type === 'graph.edge_invalidated')).toBe(true);
    expect(
      neighbors({ db, store }, { audience: [ALICE], entity: 'owner', depth: 1 }).map((e) => e.id),
    ).not.toContain(edge.id);

    // Rebuild from scratch: the manual invalidation must replay.
    resetGraph(db);
    await foldAtoms(fold);
    expect(
      neighbors({ db, store }, { audience: [ALICE], entity: 'owner', depth: 1 }).map((e) => e.id),
    ).not.toContain(edge.id);
  });

  it('quarantined atoms produce no reachable edges even for full grants', async () => {
    const { db, store, ledger, fold, acl } = makeStack();
    acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: ALICE, resolution: 4 });

    const pipeline = makePipeline(db, store, ledger, biliDrafts);
    await pipeline.ingest({ ...event(1_000), source: { who: BOB, channel: 'dm', ts: 1_000 } });
    await foldAtoms(fold);

    expect(neighbors({ db, store }, { audience: [ALICE], entity: 'owner', depth: 3 })).toHaveLength(0);
  });
});
