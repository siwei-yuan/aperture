import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerDraft, RawEvent } from '../src/core/ingest.js';
import { IngestPipeline } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AtomStore } from '../src/core/store.js';
import type { CaptureDeps } from '../src/gen/capture.js';
import { CaptureBuffer } from '../src/gen/debounce.js';

const OWNER = 'person:owner';
const BOB = 'person:bob';

const drafts: LayerDraft[] = [
  { level: 1, text: 'a plan is taking shape', entities: [] },
  { level: 2, text: 'bob is planning a move to shanghai next month', entities: ['shanghai'] },
];

function makeStack() {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const distilled: string[] = []; // contents the generator actually saw
  const pipeline = new IngestPipeline({
    store,
    ledger,
    ownerId: OWNER,
    generator: {
      generate: async (event: RawEvent) => {
        distilled.push(event.content);
        return structuredClone(drafts);
      },
    },
  });
  const deps: CaptureDeps = { db, ledger, pipeline };
  return { db, store, ledger, deps, distilled };
}

function fragment(content: string, opts?: { who?: string; ts?: number; audience?: string[] }): RawEvent {
  const who = opts?.who ?? BOB;
  return {
    content,
    subject: [who],
    topics: ['general'],
    source: { who, channel: 'telegram:dm', ts: opts?.ts ?? 1_720_000_000_000 },
    acquisitionContext: 'telegram:dm',
    acquisitionAudience: opts?.audience ?? [who],
  };
}

const ingressCount = (ledger: Ledger) =>
  [...ledger.events()].filter((e) => e.type === 'ingress.received').length;

describe('session-level capture debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records every fragment immediately, but distills the burst as ONE episode after the quiet gap', async () => {
    const { deps, ledger, store, distilled } = makeStack();
    const buffer = new CaptureBuffer(deps, OWNER, { quietMs: 1_000, maxFragments: 10, maxChars: 10_000 });

    buffer.add('s1', fragment('bob: I have been apartment hunting lately'));
    buffer.add('s1', fragment('bob: settled on one at 88 guangfu road'));
    buffer.add('s1', fragment('bob: moving next month, shanghai here I come'));

    // Gate 0 is immediate and per-fragment — the tape anchor never waits.
    expect(ingressCount(ledger)).toBe(3);
    // Distillation has not happened yet.
    expect(distilled).toHaveLength(0);
    expect(store.listRetrievable()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_100);

    // One LLM call, seeing the whole burst joined together.
    expect(distilled).toHaveLength(1);
    expect(distilled[0]).toContain('apartment hunting');
    expect(distilled[0]).toContain('88 guangfu road');
    expect(distilled[0]).toContain('shanghai here I come');
    expect(store.listRetrievable()).toHaveLength(1); // one coherent atom, not three fragments
  });

  it('a new fragment resets the quiet timer (debounce, not throttle)', async () => {
    const { deps, distilled } = makeStack();
    const buffer = new CaptureBuffer(deps, OWNER, { quietMs: 1_000, maxFragments: 10, maxChars: 10_000 });

    buffer.add('s1', fragment('first message about the move'));
    await vi.advanceTimersByTimeAsync(800);
    buffer.add('s1', fragment('second message, still talking'));
    await vi.advanceTimersByTimeAsync(800);
    expect(distilled).toHaveLength(0); // never went quiet long enough

    await vi.advanceTimersByTimeAsync(300);
    expect(distilled).toHaveLength(1); // quiet gap finally elapsed
  });

  it('sessions buffer independently — one room going quiet does not flush another', async () => {
    const { deps, distilled } = makeStack();
    const buffer = new CaptureBuffer(deps, OWNER, { quietMs: 1_000, maxFragments: 10, maxChars: 10_000 });

    buffer.add('bob-dm', fragment('bob talks about his move to shanghai'));
    await vi.advanceTimersByTimeAsync(500);
    buffer.add('mom-dm', fragment('mom asks about the weekend dinner plan', { who: 'person:mom', audience: ['person:mom'] }));

    await vi.advanceTimersByTimeAsync(600);
    expect(distilled).toHaveLength(1); // bob's room flushed
    expect(distilled[0]).toContain('shanghai');

    await vi.advanceTimersByTimeAsync(500);
    expect(distilled).toHaveLength(2); // mom's room flushed on its own clock
  });

  it('the fragment cap forces an early flush', async () => {
    const { deps, distilled } = makeStack();
    const buffer = new CaptureBuffer(deps, OWNER, { quietMs: 60_000, maxFragments: 3, maxChars: 10_000 });

    buffer.add('s1', fragment('message one of the burst'));
    buffer.add('s1', fragment('message two of the burst'));
    expect(distilled).toHaveLength(0);
    buffer.add('s1', fragment('message three hits the cap'));
    await vi.advanceTimersByTimeAsync(0);
    expect(distilled).toHaveLength(1);
  });

  it('merged provenance is conservative and the room is the union', async () => {
    const { deps, store } = makeStack();
    const buffer = new CaptureBuffer(deps, OWNER, { quietMs: 1_000, maxFragments: 10, maxChars: 10_000 });

    buffer.add('s1', fragment('owner: let me introduce you two', { who: OWNER, audience: [OWNER] }));
    buffer.add('s1', fragment('bob: nice to meet everyone, I am moving to shanghai', { audience: [BOB, 'person:carol'] }));
    await vi.advanceTimersByTimeAsync(1_100);

    const atoms = store.listRetrievable();
    expect(atoms).toHaveLength(1);
    // Any non-owner voice in the burst → the episode is theirs → room-local.
    expect(atoms[0]!.source.who).toBe(BOB);
    expect(atoms[0]!.scope).toBe('local');
    // The frozen room is the union of everyone the fragments were heard by.
    expect(atoms[0]!.acquisitionAudience).toEqual([BOB, 'person:carol', OWNER].sort());
  });

  it('flushAll drains every session (shutdown path)', async () => {
    const { deps, distilled } = makeStack();
    const buffer = new CaptureBuffer(deps, OWNER, { quietMs: 60_000, maxFragments: 10, maxChars: 10_000 });

    buffer.add('a', fragment('room a content about the move'));
    buffer.add('b', fragment('room b content about dinner', { who: 'person:mom' }));
    await buffer.flushAll();
    expect(distilled).toHaveLength(2);

    // Idempotent: nothing left to flush.
    await buffer.flushAll();
    expect(distilled).toHaveLength(2);
  });

  it('a crashed distillation loses nothing: fragments are already on the ledger', async () => {
    const { db, ledger, store } = makeStack();
    const pipeline = new IngestPipeline({
      store,
      ledger,
      ownerId: OWNER,
      generator: {
        generate: async () => {
          throw new Error('endpoint down');
        },
      },
    });
    const buffer = new CaptureBuffer({ db, ledger, pipeline }, OWNER, {
      quietMs: 1_000,
      maxFragments: 10,
      maxChars: 10_000,
    });

    buffer.add('s1', fragment('important fact that must survive'));
    await vi.advanceTimersByTimeAsync(1_100);

    expect(store.listRetrievable()).toHaveLength(0); // distillation failed...
    expect(ingressCount(ledger)).toBe(1); // ...but the tape anchor is there — replayable
    expect(ledger.verify().ok).toBe(true);
  });
});
