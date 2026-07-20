import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';

/** The exact atoms schema shipped before the scope migration. */
const PRE_SCOPE_SCHEMA = `
  CREATE TABLE atoms (
    id                  TEXT PRIMARY KEY,
    subject             TEXT NOT NULL,
    source_who          TEXT NOT NULL,
    source_channel      TEXT NOT NULL,
    source_ts           INTEGER NOT NULL,
    acquisition_context TEXT NOT NULL,
    topics              TEXT NOT NULL,
    quarantined         INTEGER NOT NULL
  );
  CREATE TABLE layers (
    atom_id  TEXT NOT NULL REFERENCES atoms(id),
    level    INTEGER NOT NULL,
    text     TEXT NOT NULL,
    entities TEXT NOT NULL,
    PRIMARY KEY (atom_id, level)
  );
`;

function seedOldAtom(db: Database.Database, id: string, who: string, quarantined: 0 | 1): void {
  db.prepare(
    `INSERT INTO atoms (id, subject, source_who, source_channel, source_ts, acquisition_context, topics, quarantined)
     VALUES (?, ?, ?, 'telegram:dm:1', 1000, 'dm', '["activity"]', ?)`,
  ).run(id, JSON.stringify([OWNER]), who, quarantined);
  db.prepare("INSERT INTO layers (atom_id, level, text, entities) VALUES (?, 1, 'fact', '[]')").run(id);
}

function newAtom(id: string): MemoryAtom {
  return {
    id,
    subject: [OWNER],
    source: { who: OWNER, channel: 'webchat:dm:2', ts: 2_000 },
    acquisitionContext: 'dm:owner',
    acquisitionAudience: [OWNER],
    topics: ['schedule'],
    layers: [{ level: 1, text: 'flying saturday', entities: ['flight'] }],
    scope: 'global',
  };
}

function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(atoms)').all() as Array<{ name: string }>).map((c) => c.name);
}

describe('pre-scope database migration', () => {
  it('migrated databases accept new inserts — the legacy NOT NULL column is gone', () => {
    const db = new Database(':memory:');
    db.exec(PRE_SCOPE_SCHEMA);
    seedOldAtom(db, 'old-local', 'person:stranger', 1);
    seedOldAtom(db, 'old-global', OWNER, 0);

    const store = new AtomStore(db);
    expect(columnNames(db)).not.toContain('quarantined');

    // The exact path the bug broke: insert() no longer writes `quarantined`,
    // so the old column's NOT NULL constraint rejected every new atom.
    expect(() => store.insert(newAtom('fresh'))).not.toThrow();
    expect(store.get('fresh')?.layers[0]?.text).toBe('flying saturday');
  });

  it('old rows map onto scopes: quarantined=1 → local, 0 → global, audience backfilled', () => {
    const db = new Database(':memory:');
    db.exec(PRE_SCOPE_SCHEMA);
    seedOldAtom(db, 'old-local', 'person:stranger', 1);
    seedOldAtom(db, 'old-global', OWNER, 0);

    const store = new AtomStore(db);
    store.insert(newAtom('fresh'));

    expect(store.listLocal().map((a) => a.id)).toEqual(['old-local']);
    expect(store.listGlobal().map((a) => a.id).sort()).toEqual(['fresh', 'old-global']);
    expect(store.listRetrievable().map((a) => a.id).sort()).toEqual(['fresh', 'old-global', 'old-local']);
    expect(store.get('old-local')?.acquisitionAudience).toEqual(['person:stranger']);
  });

  it('migration is idempotent: constructing AtomStore again neither throws nor rewrites', () => {
    const db = new Database(':memory:');
    db.exec(PRE_SCOPE_SCHEMA);
    seedOldAtom(db, 'old-local', 'person:stranger', 1);

    new AtomStore(db);
    const after = columnNames(db);
    expect(() => new AtomStore(db)).not.toThrow();
    expect(columnNames(db)).toEqual(after);
    expect(new AtomStore(db).get('old-local')?.scope).toBe('local');
  });

  it('a half-migrated database (scope added, quarantined still present) is finished off', () => {
    const db = new Database(':memory:');
    db.exec(PRE_SCOPE_SCHEMA);
    seedOldAtom(db, 'old-local', 'person:stranger', 1);
    // Replicate what the old (buggy) migration left behind on the live db.
    db.exec(`
      ALTER TABLE atoms ADD COLUMN acq_audience TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE atoms ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
      UPDATE atoms SET scope = CASE WHEN quarantined = 1 THEN 'local' ELSE 'global' END,
                       acq_audience = json_array(source_who);
    `);

    const store = new AtomStore(db);
    expect(columnNames(db)).not.toContain('quarantined');
    expect(() => store.insert(newAtom('fresh'))).not.toThrow();
    expect(store.listLocal().map((a) => a.id)).toEqual(['old-local']); // backfill not redone
  });
});
