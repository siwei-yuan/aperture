import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { cosine, hashEmbedder, VectorStore } from '../src/core/embed.js';
import type { LayerDraft, LayerGenerator, RawEvent } from '../src/core/ingest.js';
import { IngestPipeline } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { rebuildProjections } from '../src/core/replay.js';
import { AtomStore } from '../src/core/store.js';

const embedder = hashEmbedder(32);

function makeVectors() {
  const db = new Database(':memory:');
  return { db, vectors: new VectorStore(db, embedder) };
}

/** Seeded RNG for reproducible random-vector tests. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('per-layer vector store', () => {
  it('hashEmbedder is deterministic and language-agnostic', async () => {
    const [a1] = await embedder.embed(['他在B站看视频']);
    const [a2] = await embedder.embed(['他在B站看视频']);
    const [b] = await embedder.embed(['completely different text']);
    expect(cosine(a1!, a2!)).toBeCloseTo(1);
    expect(cosine(a1!, b!)).toBeLessThan(0.99);
  });

  it('partition invariant: search never returns disallowed atoms or levels', async () => {
    const { vectors } = makeVectors();
    await vectors.index({
      id: 'a1',
      layers: [
        { level: 1, text: 'watching something', entities: [] },
        { level: 2, text: 'watching a video', entities: [] },
        { level: 3, text: 'watching bilibili videos', entities: [] },
      ],
    });
    await vectors.index({
      id: 'a2',
      layers: [
        { level: 1, text: 'watching a movie', entities: [] },
        { level: 2, text: 'watching movies at the cinema', entities: [] },
      ],
    });

    const query = await vectors.embedQuery('watching videos');
    const hits = vectors.search(query, new Map([['a1', 2]]), 10);

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.atomId).toBe('a1');
      expect(hit.level).toBeLessThanOrEqual(2);
    }
  });

  it('exactness: matches a brute-force reference on random vectors', async () => {
    const db = new Database(':memory:');
    const dim = 8;
    const rand = mulberry32(42);
    const randomVec = () => Float32Array.from({ length: dim }, () => rand() * 2 - 1);

    // A stub embedder is enough — we insert vectors directly via a queue.
    const queue: Float32Array[] = [];
    const stub = { dim, embed: async (texts: string[]) => texts.map(() => queue.shift()!) };
    const vectors = new VectorStore(db, stub);

    const reference: Array<{ atomId: string; level: number; vec: Float32Array }> = [];
    for (let i = 0; i < 30; i++) {
      const levels = 1 + (i % 2);
      const layers = [];
      for (let level = 1; level <= levels; level++) {
        const vec = randomVec();
        reference.push({ atomId: `a${i}`, level, vec });
        queue.push(vec);
        layers.push({ level, text: `t${i}-${level}`, entities: [] });
      }
      await vectors.index({ id: `a${i}`, layers });
    }

    const allowed = new Map(reference.map((r) => [r.atomId, 4]));
    const query = randomVec();
    const got = vectors.search(query, allowed, 5);

    const want = reference
      .map((r) => ({ atomId: r.atomId, level: r.level, score: cosine(query, r.vec) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 5);

    expect(got).toEqual(want);
  });

  it('replay with a vector store rebuilds vectors identically', async () => {
    const db = new Database(':memory:');
    const store = new AtomStore(db);
    const ledger = new Ledger(db);
    const vectors = new VectorStore(db, embedder);

    const drafts: LayerDraft[] = [
      { level: 1, text: 'he is at his computer', entities: ['computer'] },
      { level: 2, text: 'he is watching a video', entities: ['computer', 'video'] },
    ];
    const generator: LayerGenerator = { generate: async () => structuredClone(drafts) };
    const pipeline = new IngestPipeline({ store, ledger, ownerId: 'person:owner', generator, vectors });

    const event: RawEvent = {
      content: 'x',
      subject: ['person:owner'],
      topics: ['activity'],
      source: { who: 'person:owner', channel: 'screen', ts: 1_000 },
      acquisitionContext: 'private',
    };
    await pipeline.ingest(event);

    const snapshot = () => db.prepare('SELECT * FROM vectors ORDER BY atom_id, level').all();
    const before = snapshot();
    expect(before).toHaveLength(2);

    await rebuildProjections(ledger, db, { vectors });
    expect(snapshot()).toEqual(before);
  });
});
