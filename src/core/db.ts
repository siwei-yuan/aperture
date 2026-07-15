import Database from 'better-sqlite3';

/**
 * The one way to open an aperture database file. Multiple processes share
 * the same file (gateway, CLI, UI server), so every connection needs:
 *
 * - WAL: readers and the single writer proceed in parallel instead of
 *   locking the whole file per write. In-memory databases don't support
 *   WAL — sqlite silently keeps `memory` mode, which is fine (a :memory:
 *   db has exactly one connection by construction).
 * - busy_timeout: writer-vs-writer contention queues for up to 5s instead
 *   of failing immediately with SQLITE_BUSY.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}
