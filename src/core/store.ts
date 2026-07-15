import type Database from 'better-sqlite3';
import type { AtomScope, Layer, MemoryAtom } from './atom.js';

interface AtomRow {
  id: string;
  subject: string;
  source_who: string;
  source_channel: string;
  source_ts: number;
  acquisition_context: string;
  acq_audience: string;
  topics: string;
  scope: string;
}

interface LayerRow {
  atom_id: string;
  level: number;
  text: string;
  entities: string;
}

export class AtomStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS atoms (
        id                  TEXT PRIMARY KEY,
        subject             TEXT NOT NULL,
        source_who          TEXT NOT NULL,
        source_channel      TEXT NOT NULL,
        source_ts           INTEGER NOT NULL,
        acquisition_context TEXT NOT NULL,
        acq_audience        TEXT NOT NULL,
        topics              TEXT NOT NULL,
        scope               TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS layers (
        atom_id  TEXT NOT NULL REFERENCES atoms(id),
        level    INTEGER NOT NULL,
        text     TEXT NOT NULL,
        entities TEXT NOT NULL,
        PRIMARY KEY (atom_id, level)
      );
    `);
    this.migrateQuarantinedColumn();
  }

  /** Pre-scope databases had a `quarantined` boolean; map it onto scopes once. */
  private migrateQuarantinedColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(atoms)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (names.has('scope')) return;
    this.db.exec(`
      ALTER TABLE atoms ADD COLUMN acq_audience TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE atoms ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
      UPDATE atoms SET scope = CASE WHEN quarantined = 1 THEN 'local' ELSE 'global' END,
                       acq_audience = json_array(source_who);
    `);
  }

  insert(atom: MemoryAtom): void {
    const insertAtom = this.db.prepare(`
      INSERT INTO atoms (id, subject, source_who, source_channel, source_ts, acquisition_context, acq_audience, topics, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLayer = this.db.prepare(
      'INSERT INTO layers (atom_id, level, text, entities) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      insertAtom.run(
        atom.id,
        JSON.stringify(atom.subject),
        atom.source.who,
        atom.source.channel,
        atom.source.ts,
        atom.acquisitionContext,
        JSON.stringify(atom.acquisitionAudience),
        JSON.stringify(atom.topics),
        atom.scope,
      );
      for (const layer of atom.layers) {
        insertLayer.run(atom.id, layer.level, layer.text, JSON.stringify(layer.entities));
      }
    })();
  }

  /** Admin path — returns the atom regardless of scope. */
  get(id: string): MemoryAtom | undefined {
    const row = this.db.prepare('SELECT * FROM atoms WHERE id = ?').get(id) as AtomRow | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  /** The read path: everything a retrieval MAY consider (sealed atoms do not exist here). */
  listRetrievable(): MemoryAtom[] {
    const rows = this.db
      .prepare("SELECT * FROM atoms WHERE scope != 'sealed' ORDER BY source_ts ASC")
      .all() as AtomRow[];
    return rows.map((row) => this.hydrate(row));
  }

  /** Globally retrievable atoms only (the pre-scope `listVisible`). */
  listGlobal(): MemoryAtom[] {
    return this.listByScope('global');
  }

  /** Room-local atoms — the review queue for promotion. */
  listLocal(): MemoryAtom[] {
    return this.listByScope('local');
  }

  listByScope(scope: AtomScope): MemoryAtom[] {
    const rows = this.db
      .prepare('SELECT * FROM atoms WHERE scope = ? ORDER BY source_ts ASC')
      .all(scope) as AtomRow[];
    return rows.map((row) => this.hydrate(row));
  }

  setScope(id: string, scope: AtomScope): void {
    this.db.prepare('UPDATE atoms SET scope = ? WHERE id = ?').run(scope, id);
  }

  private hydrate(row: AtomRow): MemoryAtom {
    const layerRows = this.db
      .prepare('SELECT * FROM layers WHERE atom_id = ? ORDER BY level ASC')
      .all(row.id) as LayerRow[];
    const layers: Layer[] = layerRows.map((l) => ({
      level: l.level,
      text: l.text,
      entities: JSON.parse(l.entities) as string[],
    }));
    return {
      id: row.id,
      subject: JSON.parse(row.subject) as string[],
      source: { who: row.source_who, channel: row.source_channel, ts: row.source_ts },
      acquisitionContext: row.acquisition_context,
      acquisitionAudience: JSON.parse(row.acq_audience) as string[],
      topics: JSON.parse(row.topics) as string[],
      layers,
      scope: row.scope as AtomScope,
    };
  }
}
