import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Layer } from '../src/core/atom.js';
import { hashEmbedder } from '../src/core/embed.js';
import type { LayerDraft, LayerGenerator, RawEvent } from '../src/core/ingest.js';
import { IngestPipeline } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AtomStore } from '../src/core/store.js';
import { foldAtoms, resetGraph, type FactExtractor, type FoldDeps } from '../src/graph/fold.js';

const OWNER = 'person:owner';

/**
 * Deterministic extractor derived from the ladder itself: every entity's
 * firstLevel is the first rung whose entities list contains it, and each
 * layer's first entity is linked to the finest layer's subject-ish first
 * entity via a "mentions" fact at that rung.
 */
const ladderExtractor: FactExtractor = {
  extract: async (layers: Layer[]) => {
    const seen = new Map<string, number>();
    for (const layer of layers) {
      for (const entity of layer.entities) {
        if (!seen.has(entity)) seen.set(entity, layer.level);
      }
    }
    const entities = [...seen.entries()].map(([name, firstLevel]) => ({
      name,
      kind: 'thing',
      firstLevel,
    }));
    const anchor = entities[0]?.name;
    const facts = entities
      .slice(1)
      .map((e) => ({ src: anchor!, predicate: 'mentions', dst: e.name, level: e.firstLevel }));
    return { entities, facts };
  },
};

const biliDrafts: LayerDraft[] = [
  { level: 1, text: 'he is at his computer', entities: ['owner'] },
  { level: 2, text: 'he is watching a video', entities: ['owner', 'video'] },
  { level: 3, text: 'he is watching bilibili', entities: ['owner', 'video', 'bilibili'] },
  { level: 4, text: 'he is watching rust async explained', entities: ['owner', 'video', 'bilibili', 'rust-async-explained'] },
];

function makeStack(drafts: LayerDraft[] = biliDrafts) {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const generator: LayerGenerator = { generate: async () => structuredClone(drafts) };
  const pipeline = new IngestPipeline({ store, ledger, ownerId: OWNER, generator });
  const deps: FoldDeps = { db, ledger, extractor: ladderExtractor, embedder: hashEmbedder(32) };
  return { db, store, ledger, pipeline, deps };
}

function event(who: string, ts: number): RawEvent {
  return {
    content: 'x',
    subject: [OWNER],
    topics: ['activity'],
    source: { who, channel: 'screen', ts },
    acquisitionContext: 'private',
  };
}

const snapshot = (db: Database.Database) => ({
  nodes: db.prepare('SELECT id, name, kind, min_level FROM nodes ORDER BY id').all(),
  edges: db.prepare('SELECT * FROM edges ORDER BY id').all(),
});

describe('graph fold (T5.1)', () => {
  it('min_level emerges from the ladder: entities carry their first rung', async () => {
    const { db, pipeline, deps } = makeStack();
    await pipeline.ingest(event(OWNER, 1_000));
    await foldAtoms(deps);

    const levels = Object.fromEntries(
      (db.prepare('SELECT name, min_level FROM nodes').all() as Array<{ name: string; min_level: number }>).map(
        (n) => [n.name, n.min_level],
      ),
    );
    expect(levels).toEqual({ owner: 1, video: 2, bilibili: 3, 'rust-async-explained': 4 });

    const edges = db.prepare('SELECT dst, min_level FROM edges ORDER BY min_level').all() as Array<{
      dst: string;
      min_level: number;
    }>;
    // edge level = max(fact level, endpoint first levels)
    expect(edges.map((e) => e.min_level)).toEqual([2, 3, 4]);
  });

  it('quarantine contagion: stranger edges are flagged until approval, then a re-fold clears them', async () => {
    const { db, pipeline, deps } = makeStack();
    const result = await pipeline.ingest(event('person:bob', 1_000));
    await foldAtoms(deps);

    const flagged = db.prepare('SELECT COUNT(*) AS n FROM edges WHERE quarantined = 1').get() as { n: number };
    expect(flagged.n).toBeGreaterThan(0);

    const atomId = result.ok && 'atom' in result ? result.atom.id : '';
    pipeline.approve(atomId, OWNER);
    await foldAtoms(deps); // consumes the atom.approved event

    const still = db.prepare('SELECT COUNT(*) AS n FROM edges WHERE quarantined = 1').get() as { n: number };
    expect(still.n).toBe(0);
  });

  it('replay equivalence: incremental folds ≡ one fold from scratch', async () => {
    const { db, pipeline, deps } = makeStack();

    await pipeline.ingest(event(OWNER, 1_000));
    await foldAtoms(deps); // incremental fold 1
    await pipeline.ingest(event('person:bob', 2_000));
    await foldAtoms(deps); // incremental fold 2

    const incremental = snapshot(db);
    resetGraph(db);
    await foldAtoms(deps); // one fold over the whole ledger
    expect(snapshot(db)).toEqual(incremental);
  });

  it('the cursor makes folding idempotent: a no-op when nothing new happened', async () => {
    const { db, pipeline, deps } = makeStack();
    await pipeline.ingest(event(OWNER, 1_000));
    await foldAtoms(deps);
    const before = snapshot(db);
    await foldAtoms(deps);
    expect(snapshot(db)).toEqual(before);
  });

  it('entity resolution merges the same normalized name across atoms', async () => {
    const { db, pipeline, deps } = makeStack();
    await pipeline.ingest(event(OWNER, 1_000));
    await pipeline.ingest(event(OWNER, 2_000)); // same ladder again
    await foldAtoms(deps);

    const nodes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
    expect(nodes.n).toBe(4); // no duplicate nodes
    const edges = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number };
    expect(edges.n).toBe(6); // but both atoms' edges exist (3 each)
  });
});
