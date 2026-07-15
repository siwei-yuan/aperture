import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { LadderViolation } from '../src/core/entail.js';
import type { LayerDraft, LayerGenerator, RawEvent } from '../src/core/ingest.js';
import { IngestPipeline } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AtomStore } from '../src/core/store.js';
import { capture, type CaptureDeps } from '../src/gen/capture.js';
import { DEFAULT_PREFILTER, hamming64, prefilter, simhash64 } from '../src/gen/prefilter.js';
import { LlmLayerGenerator, type LlmClient } from '../src/gen/llm-generator.js';

const OWNER = 'person:owner';

const goodDrafts: LayerDraft[] = [
  { level: 1, text: 'Bob has a life change coming', entities: ['bob'] },
  { level: 2, text: 'Bob is moving house', entities: ['bob', 'moving'] },
  { level: 3, text: 'Bob moves to Shanghai next Tuesday', entities: ['bob', 'moving', 'shanghai'] },
];

function makeStack(generator: LayerGenerator) {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const pipeline = new IngestPipeline({ store, ledger, ownerId: OWNER, generator });
  const deps: CaptureDeps = { db, ledger, pipeline };
  return { db, store, ledger, deps };
}

function episode(content: string, opts?: { who?: string; channel?: string; ts?: number }): RawEvent {
  return {
    content,
    subject: [OWNER],
    topics: ['activity'],
    source: {
      who: opts?.who ?? OWNER,
      channel: opts?.channel ?? 'telegram:dm:1',
      ts: opts?.ts ?? 1_720_000_000_000,
    },
    acquisitionContext: 'dm',
  };
}

const eventTypes = (ledger: Ledger) => [...ledger.events()].map((e) => e.type);

describe('deterministic prefilter gates', () => {
  const db = new Database(':memory:');
  new Ledger(db); // creates the ledger table G1d queries

  it('G1a: emoji-only / too-short content is gated by length after strip', () => {
    const result = prefilter(db, episode('哈哈哈哈👍'));
    expect(result).toMatchObject({ pass: false, gate: 'G1a-length' });
  });

  it('G1b: phatic content passes length but dies on lexicon coverage', () => {
    const result = prefilter(db, episode('在吗在吗，兄弟在不在？'));
    expect(result).toMatchObject({ pass: false, gate: 'G1b-phatic' });
  });

  it('G1e: excluded channels are gated', () => {
    const result = prefilter(db, episode('我下周二搬去上海，新地址光复路88号', { channel: 'cron:daily-digest' }));
    expect(result).toMatchObject({ pass: false, gate: 'G1e-channel' });
  });

  it('substantive content passes all gates', () => {
    expect(prefilter(db, episode('我下周二搬去上海，新地址光复路88号'))).toEqual({ pass: true });
  });

  it('simhash: near-identical texts are close, unrelated texts are far', () => {
    const a = simhash64('我下周二搬去上海，新地址光复路88号');
    const b = simhash64('我下周二搬去上海，新地址光复路88号！！');
    const c = simhash64('The quarterly meeting moved to Thursday afternoon');
    expect(hamming64(a, b)).toBeLessThanOrEqual(3);
    expect(hamming64(a, c)).toBeGreaterThan(10);
  });
});

describe('capture: the single ingress entrance', () => {
  it('gate 0 is unconditional: gated episodes still land on the ledger', async () => {
    const { deps, ledger, store } = makeStack({ generate: async () => structuredClone(goodDrafts) });

    const result = await capture(deps, episode('在吗？'));
    expect(result).toMatchObject({ gated: 'G1a-length' });

    expect(eventTypes(ledger)).toEqual(['ingress.received']);
    expect(store.listGlobal()).toHaveLength(0);
    expect(ledger.verify().ok).toBe(true);
  });

  it('G1c: the second occurrence of the same content is a duplicate', async () => {
    const { deps, store } = makeStack({ generate: async () => structuredClone(goodDrafts) });
    const text = '我下周二搬去上海，新地址光复路88号';

    const first = await capture(deps, episode(text, { ts: 1_720_000_000_000 }));
    expect('ingest' in first && first.ingest.ok).toBe(true);

    const second = await capture(deps, episode(`${text}！！`, { ts: 1_720_000_100_000 }));
    expect(second).toMatchObject({ gated: 'G1c-duplicate' });
    expect(store.listGlobal()).toHaveLength(1);
  });

  it('G1d: per-source hourly cap trips after distinct messages flood in', async () => {
    const { deps } = makeStack({ generate: async () => structuredClone(goodDrafts) });
    const config = { ...DEFAULT_PREFILTER, hourlyCapPerSource: 2 };
    const base = 1_720_000_000_000;

    const texts = [
      '第一条完全不同的正经消息内容甲',
      '第二条完全不同的正经消息内容乙',
      '第三条完全不同的正经消息内容丙',
    ];
    const results = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await capture(deps, episode(texts[i]!, { who: 'person:bob', ts: base + i * 60_000 }), config));
    }

    expect('ingest' in results[0]!).toBe(true);
    expect('ingest' in results[1]!).toBe(true);
    expect(results[2]).toMatchObject({ gated: 'G1d-rate' });
  });

  it('a crashed distillation does not burn the fingerprint: the same content may retry', async () => {
    // Observed live: a cold local model timed out mid-ingest; the retry of the
    // identical message must not die at G1c-duplicate, because no LLM call was
    // ever paid for the first attempt.
    let attempt = 0;
    const generator: LayerGenerator = {
      generate: async () => {
        attempt++;
        if (attempt === 1) throw new Error('endpoint timeout');
        return structuredClone(goodDrafts);
      },
    };
    const { deps, store } = makeStack(generator);
    const text = '我下周二搬去上海，新地址光复路88号';

    await expect(capture(deps, episode(text, { ts: 1_720_000_000_000 }))).rejects.toThrow('endpoint timeout');

    const retry = await capture(deps, episode(text, { ts: 1_720_000_060_000 }));
    expect('ingest' in retry && retry.ingest.ok).toBe(true);
    expect(store.listGlobal()).toHaveLength(1);

    // But a completed call (even a skip) IS recorded: the third pass is a dup.
    const third = await capture(deps, episode(text, { ts: 1_720_000_120_000 }));
    expect(third).toMatchObject({ gated: 'G1c-duplicate' });
  });

  it('LLM skip stores nothing and emits no atom event', async () => {
    const { deps, ledger, store } = makeStack({ generate: async () => ({ skip: true, reason: 'ephemeral' }) });

    const result = await capture(deps, episode('他最近在忙什么呀，你知道吗？'));
    expect('ingest' in result && result.ingest.ok && 'skipped' in result.ingest && result.ingest.skipped).toBe('ephemeral');
    expect(eventTypes(ledger)).toEqual(['ingress.received']);
    expect(store.listGlobal()).toHaveLength(0);
  });
});

describe('repair loop', () => {
  const poisoned = (): LayerDraft[] => {
    const drafts = structuredClone(goodDrafts);
    drafts[0]!.entities.push('secret-leak');
    return drafts;
  };

  it('feeds violations back and succeeds on a repaired attempt', async () => {
    const feedbackSeen: Array<LadderViolation[] | undefined> = [];
    const generator: LayerGenerator = {
      generate: async (_event, feedback) => {
        feedbackSeen.push(feedback);
        return feedback ? structuredClone(goodDrafts) : poisoned();
      },
    };
    const { deps, store } = makeStack(generator);

    const result = await capture(deps, episode('我下周二搬去上海，新地址光复路88号'));
    expect('ingest' in result && result.ingest.ok).toBe(true);
    expect(store.listGlobal()).toHaveLength(1);

    expect(feedbackSeen).toHaveLength(2);
    expect(feedbackSeen[0]).toBeUndefined();
    expect(feedbackSeen[1]![0]!.reason).toContain('secret-leak');
  });

  it('gives up after 2 retries with a single atom.rejected event', async () => {
    let calls = 0;
    const generator: LayerGenerator = {
      generate: async () => {
        calls++;
        return poisoned();
      },
    };
    const { deps, ledger, store } = makeStack(generator);

    const result = await capture(deps, episode('我下周二搬去上海，新地址光复路88号'));
    expect('ingest' in result && !result.ingest.ok).toBe(true);
    expect(calls).toBe(3); // 1 initial + 2 repairs
    expect(eventTypes(ledger)).toEqual(['ingress.received', 'atom.rejected']);
    expect(store.listGlobal()).toHaveLength(0);
  });
});

describe('LlmLayerGenerator output handling', () => {
  const gen = (raw: string) => {
    const client: LlmClient = { completeJson: async () => raw };
    return new LlmLayerGenerator(client).generate(episode('x'));
  };

  it('parses skip decisions', async () => {
    expect(await gen('{"skip": true, "reason": "filler"}')).toEqual({ skip: true, reason: 'filler' });
  });

  it('parses ladders and drops non-string and blank entities', async () => {
    const out = await gen('{"layers": [{"level": 1, "text": "a fact", "entities": ["x", 42, "", "  "]}]}');
    expect(out).toEqual([{ level: 1, text: 'a fact', entities: ['x'] }]);
  });

  it('keeps well-formed hierarchical topics and drops the rest', async () => {
    const out = await gen(
      '{"topics": ["work/alpha", "Work Alpha!", 42, "health"], "layers": [{"level": 1, "text": "a fact", "entities": []}]}',
    );
    expect(out).toEqual({
      layers: [{ level: 1, text: 'a fact', entities: [] }],
      topics: ['work/alpha', 'health'],
    });
  });

  it('a topics array that yields nothing valid falls back to "general"', async () => {
    const out = await gen('{"topics": ["NOT/A/Valid Path"], "layers": [{"level": 1, "text": "a fact", "entities": []}]}');
    expect(out).toMatchObject({ topics: ['general'] });
  });

  it('a missing topics field leaves the caller\'s suggestion in force (bare drafts)', async () => {
    const out = await gen('{"layers": [{"level": 1, "text": "a fact", "entities": []}]}');
    expect(Array.isArray(out)).toBe(true);
  });

  it('malformed JSON or shape degrades to an empty ladder (invariant rejects it)', async () => {
    expect(await gen('not json at all')).toEqual([]);
    expect(await gen('{"layers": "nope"}')).toEqual([]);
    expect(await gen('{"layers": [{"level": "one"}]}')).toEqual([]);
  });
});
