import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { LayerDraft, LayerGenerator, RawEvent } from '../src/core/ingest.js';
import { IngestPipeline } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { rebuildProjections } from '../src/core/replay.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';
const STRANGER = 'person:stranger';

const drafts: LayerDraft[] = [
  { level: 1, text: 'He is at his computer', entities: ['computer'] },
  { level: 2, text: 'He is watching a video', entities: ['computer', 'video'] },
];

const generator: LayerGenerator = { generate: async () => structuredClone(drafts) };

function event(who: string, ts: number): RawEvent {
  return {
    content: 'x',
    subject: [OWNER],
    topics: ['activity'],
    source: { who, channel: 'telegram:dm:1', ts },
    acquisitionContext: 'dm:owner',
  };
}

function snapshot(db: Database.Database): { atoms: unknown[]; layers: unknown[] } {
  return {
    atoms: db.prepare('SELECT * FROM atoms ORDER BY id').all(),
    layers: db.prepare('SELECT * FROM layers ORDER BY atom_id, level').all(),
  };
}

describe('projection replay invariant', () => {
  it('atom store rebuilt from the ledger is row-for-row identical', async () => {
    const db = new Database(':memory:');
    const store = new AtomStore(db);
    const ledger = new Ledger(db);
    const pipeline = new IngestPipeline({ store, ledger, ownerId: OWNER, generator });

    await pipeline.ingest(event(OWNER, 1_000));
    const strangerResult = await pipeline.ingest(event(STRANGER, 2_000));
    await pipeline.ingest(event(STRANGER, 3_000)); // stays room-local
    if (strangerResult.ok && 'atom' in strangerResult) {
      pipeline.promote(strangerResult.atom.id, OWNER);
    }

    const before = snapshot(db);
    expect(before.atoms).toHaveLength(3);

    db.exec('DELETE FROM layers; DELETE FROM atoms;');
    expect(snapshot(db).atoms).toHaveLength(0);

    await rebuildProjections(ledger, db);

    expect(snapshot(db)).toEqual(before);
    expect(ledger.verify().ok).toBe(true);
  });

  it('replay does not append to the ledger', async () => {
    const db = new Database(':memory:');
    const store = new AtomStore(db);
    const ledger = new Ledger(db);
    const pipeline = new IngestPipeline({ store, ledger, ownerId: OWNER, generator });
    await pipeline.ingest(event(OWNER, 1_000));

    const countBefore = [...ledger.events()].length;
    await rebuildProjections(ledger, db);
    expect([...ledger.events()].length).toBe(countBefore);
  });
});
