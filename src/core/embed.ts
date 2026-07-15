import type Database from 'better-sqlite3';
import type { MemoryAtom } from './atom.js';

export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Deterministic embedder for tests and demos: character-bigram FNV-1a
 * hashing into `dim` buckets. Language-agnostic (works for CJK), zero
 * dependencies, and stable across runs — which is what replay tests need.
 */
export function hashEmbedder(dim = 64): Embedder {
  return {
    dim,
    embed: async (texts) =>
      texts.map((text) => {
        const v = new Float32Array(dim);
        const chars = Array.from(text.toLowerCase());
        for (let i = 0; i + 1 < chars.length; i++) {
          const bigram = chars[i]! + chars[i + 1]!;
          let h = 2166136261;
          for (let j = 0; j < bigram.length; j++) {
            h ^= bigram.charCodeAt(j);
            h = Math.imul(h, 16777619);
          }
          const bucket = (h >>> 0) % dim;
          v[bucket] = v[bucket]! + 1;
        }
        return v;
      }),
  };
}

/**
 * Real embedder over an OpenAI-compatible `/v1/embeddings` endpoint (Ollama,
 * OpenAI platform, etc.). Sends one input per request for maximum server
 * compatibility — personal scale makes batching unnecessary.
 */
export function httpEmbedder(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
}): Embedder {
  return {
    dim: opts.dim,
    embed: async (texts) => {
      const out: Float32Array[] = [];
      for (const input of texts) {
        const res = await fetch(`${opts.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model: opts.model, input }),
        });
        if (!res.ok) throw new Error(`embedder endpoint ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
        out.push(Float32Array.from(body.data[0]!.embedding));
      }
      return out;
    },
  };
}

export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function vecFromBlob(b: Buffer): Float32Array {
  const bytes = new Uint8Array(b.byteLength);
  bytes.set(b);
  return new Float32Array(bytes.buffer);
}

const toBlob = vecToBlob;
const fromBlob = vecFromBlob;

export interface KnnHit {
  atomId: string;
  level: number;
  score: number;
}

/**
 * Per-layer vector index. A projection of layer text (not ledgered):
 * replay re-embeds from the ladders carried on `atom.ingested` events.
 */
export class VectorStore {
  constructor(
    private readonly db: Database.Database,
    readonly embedder: Embedder,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        atom_id TEXT NOT NULL,
        level   INTEGER NOT NULL,
        vec     BLOB NOT NULL,
        PRIMARY KEY (atom_id, level)
      )
    `);
  }

  async index(atom: Pick<MemoryAtom, 'id' | 'layers'>): Promise<void> {
    const vecs = await this.embedder.embed(atom.layers.map((l) => l.text));
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO vectors (atom_id, level, vec) VALUES (?, ?, ?)',
    );
    atom.layers.forEach((layer, i) => insert.run(atom.id, layer.level, toBlob(vecs[i]!)));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.embedder.embed([text]);
    return v!;
  }

  clear(): void {
    this.db.exec('DELETE FROM vectors');
  }

  /**
   * Exact scores for every stored layer vector, no filtering. The egress
   * checker uses this to compare reply sentences against the BLOCKED
   * complement — filtering semantics live with the caller.
   */
  scoreAll(query: Float32Array): KnnHit[] {
    const rows = this.db.prepare('SELECT atom_id, level, vec FROM vectors').all() as Array<{
      atom_id: string;
      level: number;
      vec: Buffer;
    }>;
    return rows.map((row) => ({
      atomId: row.atom_id,
      level: row.level,
      score: cosine(query, fromBlob(row.vec)),
    }));
  }

  /**
   * Exact scan over the permitted partition only: a layer is even compared
   * iff `allowed` grants its atom at that level or finer. Exactness is a
   * security property on the egress path — no ANN here by design.
   */
  search(query: Float32Array, allowed: Map<string, number>, k: number): KnnHit[] {
    const rows = this.db.prepare('SELECT atom_id, level, vec FROM vectors').all() as Array<{
      atom_id: string;
      level: number;
      vec: Buffer;
    }>;
    const hits: KnnHit[] = [];
    for (const row of rows) {
      const max = allowed.get(row.atom_id);
      if (max === undefined || row.level > max) continue;
      hits.push({ atomId: row.atom_id, level: row.level, score: cosine(query, fromBlob(row.vec)) });
    }
    hits.sort((x, y) => y.score - x.score);
    return hits.slice(0, k);
  }
}
