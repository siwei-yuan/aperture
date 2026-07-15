import type Database from 'better-sqlite3';
import type { Layer, MemoryAtom } from './atom.js';

interface AtomRow {
  id: string;
  subject: string;
  source_who: string;
  source_channel: string;
  source_ts: number;
  acquisition_context: string;
  topics: string;
  quarantined: number;
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
        topics              TEXT NOT NULL,
        quarantined         INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS layers (
        atom_id  TEXT NOT NULL REFERENCES atoms(id),
        level    INTEGER NOT NULL,
        text     TEXT NOT NULL,
        entities TEXT NOT NULL,
        PRIMARY KEY (atom_id, level)
      );
    `);
  }

  insert(atom: MemoryAtom): void {
    const insertAtom = this.db.prepare(`
      INSERT INTO atoms (id, subject, source_who, source_channel, source_ts, acquisition_context, topics, quarantined)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(atom.topics),
        atom.quarantined ? 1 : 0,
      );
      for (const layer of atom.layers) {
        insertLayer.run(atom.id, layer.level, layer.text, JSON.stringify(layer.entities));
      }
    })();
  }

  /** Admin path — returns the atom regardless of quarantine state. */
  get(id: string): MemoryAtom | undefined {
    const row = this.db.prepare('SELECT * FROM atoms WHERE id = ?').get(id) as AtomRow | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  /** The read path: quarantined atoms do not exist here. */
  listVisible(): MemoryAtom[] {
    const rows = this.db
      .prepare('SELECT * FROM atoms WHERE quarantined = 0 ORDER BY source_ts ASC')
      .all() as AtomRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listQuarantined(): MemoryAtom[] {
    const rows = this.db
      .prepare('SELECT * FROM atoms WHERE quarantined = 1 ORDER BY source_ts ASC')
      .all() as AtomRow[];
    return rows.map((row) => this.hydrate(row));
  }

  setQuarantined(id: string, quarantined: boolean): void {
    this.db.prepare('UPDATE atoms SET quarantined = ? WHERE id = ?').run(quarantined ? 1 : 0, id);
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
      topics: JSON.parse(row.topics) as string[],
      layers,
      quarantined: row.quarantined === 1,
    };
  }
}
