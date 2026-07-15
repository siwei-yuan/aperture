import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RawEvent, LayerDraft, LayerGenerator } from '../src/core/ingest.js';
import { IngestPipeline, sealAtom } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';
const STRANGER = 'person:stranger';

const validDrafts: LayerDraft[] = [
  { level: 1, text: 'Owner is at his computer', entities: ['computer'] },
  { level: 2, text: 'Owner is watching a video', entities: ['computer', 'video'] },
  { level: 3, text: 'Owner is watching Bilibili', entities: ['computer', 'video', 'bilibili'] },
  { level: 4, text: 'Owner is watching "Rust async" on Bilibili', entities: ['computer', 'video', 'bilibili', 'rust async'] },
];

function fakeGenerator(drafts: LayerDraft[]): LayerGenerator {
  return { generate: async () => structuredClone(drafts) };
}

function makePipeline(generator: LayerGenerator) {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const pipeline = new IngestPipeline({ store, ledger, ownerId: OWNER, generator });
  return { store, ledger, pipeline };
}

function event(sourceWho: string): RawEvent {
  return {
    content: 'watching a video',
    subject: [OWNER],
    topics: ['activity'],
    source: { who: sourceWho, channel: 'telegram:dm:1', ts: 1_720_000_000_000 },
    acquisitionContext: 'dm:owner',
  };
}

describe('ingest pipeline: provenance and scope invariants', () => {
  it('owner-sourced atoms are global immediately and recorded on the ledger', async () => {
    const { store, ledger, pipeline } = makePipeline(fakeGenerator(validDrafts));

    const result = await pipeline.ingest(event(OWNER));
    expect(result.ok).toBe(true);

    expect(store.listGlobal()).toHaveLength(1);
    expect(store.listLocal()).toHaveLength(0);

    const events = [...ledger.events()];
    expect(events.map((e) => e.type)).toEqual(['atom.ingested']);
    // The full ladder rides on the event — atom store must be rebuildable.
    expect((events[0]!.payload as { layers: unknown }).layers).toEqual(
      validDrafts.map((d) => ({ level: d.level, text: d.text, entities: d.entities })),
    );
    expect(ledger.verify().ok).toBe(true);
  });

  it('non-owner-sourced atoms land room-local; promotion makes them global', async () => {
    const { store, ledger, pipeline } = makePipeline(fakeGenerator(validDrafts));

    const result = await pipeline.ingest(event(STRANGER));
    expect(result.ok).toBe(true);
    const atomId = result.ok && 'atom' in result ? result.atom.id : '';

    // Invariant: non-owner content never silently merges into the global profile.
    expect(store.listGlobal()).toHaveLength(0);
    expect(store.listLocal()).toHaveLength(1);

    pipeline.promote(atomId, OWNER);
    expect(store.listGlobal()).toHaveLength(1);

    const types = [...ledger.events()].map((e) => e.type);
    expect(types).toEqual(['atom.ingested', 'atom.promoted']);
    expect(ledger.verify().ok).toBe(true);
  });

  it('the acquisition audience is frozen at ingest with the owner materialized in', async () => {
    const { pipeline } = makePipeline(fakeGenerator(validDrafts));
    const result = await pipeline.ingest({
      ...event(STRANGER),
      acquisitionAudience: [STRANGER, 'person:bystander'],
    });
    const atom = result.ok && 'atom' in result ? result.atom : undefined;
    expect(atom?.acquisitionAudience).toEqual([OWNER, 'person:bystander', STRANGER].sort());

    // Default: just the speaker (plus the owner).
    const solo = await pipeline.ingest({
      ...event(STRANGER),
      content: 'a different message entirely',
    });
    const soloAtom = solo.ok && 'atom' in solo ? solo.atom : undefined;
    expect(soloAtom?.acquisitionAudience).toEqual([OWNER, STRANGER].sort());
  });

  it('only the owner can promote or seal, and only local atoms qualify', async () => {
    const { store, ledger, pipeline } = makePipeline(fakeGenerator(validDrafts));
    const result = await pipeline.ingest(event(STRANGER));
    const atomId = result.ok && 'atom' in result ? result.atom.id : '';

    expect(() => pipeline.promote(atomId, STRANGER)).toThrow(/only the owner/);
    expect(() => pipeline.promote(atomId, OWNER)).not.toThrow();
    expect(() => pipeline.promote(atomId, OWNER)).toThrow(/not local/);

    const sealed = await pipeline.ingest({ ...event(STRANGER), content: 'something else' });
    const sealedId = sealed.ok && 'atom' in sealed ? sealed.atom.id : '';
    expect(() => sealAtom({ store, ledger, ownerId: OWNER }, sealedId, STRANGER)).toThrow(/only the owner/);
    sealAtom({ store, ledger, ownerId: OWNER }, sealedId, OWNER);
    expect(store.get(sealedId)?.scope).toBe('sealed');
    expect(store.listRetrievable().map((a) => a.id)).not.toContain(sealedId);
    expect([...ledger.events()].map((e) => e.type)).toContain('atom.sealed');
  });

  it('entailment-violating ladders are rejected: nothing stored, rejection on the ledger', async () => {
    const poisoned = structuredClone(validDrafts);
    poisoned[0]!.entities.push('secret-detail'); // coarse layer leaks info absent from finer layers
    const { store, ledger, pipeline } = makePipeline(fakeGenerator(poisoned));

    const result = await pipeline.ingest(event(OWNER));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]!.reason).toContain('secret-detail');
    }

    expect(store.listRetrievable()).toHaveLength(0);

    const types = [...ledger.events()].map((e) => e.type);
    expect(types).toEqual(['atom.rejected']);
  });

  it('semantic entailment hook can veto ladders the deterministic check passes', async () => {
    const db = new Database(':memory:');
    const store = new AtomStore(db);
    const ledger = new Ledger(db);
    const vetoing = new IngestPipeline({
      store,
      ledger,
      ownerId: OWNER,
      generator: fakeGenerator(validDrafts),
      semantic: { entails: async () => false },
    });

    const result = await vetoing.ingest(event(OWNER));
    expect(result.ok).toBe(false);
    expect(store.listRetrievable()).toHaveLength(0);

    const types = [...ledger.events()].map((e) => e.type);
    expect(types).toEqual(['atom.rejected']);
  });

  it('atoms are frozen artifacts: layers round-trip identically through the store', async () => {
    const { store, pipeline } = makePipeline(fakeGenerator(validDrafts));
    const result = await pipeline.ingest(event(OWNER));
    const atomId = result.ok && 'atom' in result ? result.atom.id : '';

    const loaded = store.get(atomId)!;
    expect(loaded.layers).toEqual(validDrafts.map((d) => ({ level: d.level, text: d.text, entities: d.entities })));
    expect(loaded.source.who).toBe(OWNER);
    expect(loaded.acquisitionContext).toBe('dm:owner');
  });
});
