import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Ledger } from '../core/ledger.js';

/**
 * Identity resolution and session routing. Sessions are runtime state (not
 * knowledge, not authorization) — they are not ledgered.
 *
 * The router is deliberately dumb: it resolves WHO is in the room. Ceiling
 * combination happens per-atom in retrieve(), because ceilings are per-topic,
 * not per-person scalars.
 */

export interface Session {
  id: string;
  audience: string[];
  /** TBAC task scope: topic allowlist; null = unscoped. */
  scope: string[] | null;
}

export function ensureSessionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aliases (
      platform    TEXT NOT NULL,
      external_id TEXT NOT NULL,
      person_id   TEXT NOT NULL,
      PRIMARY KEY (platform, external_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id       TEXT PRIMARY KEY,
      channel  TEXT NOT NULL,
      audience TEXT NOT NULL,
      scope    TEXT
    );
  `);
}

/** Read-only identity lookup: no person node is minted on a miss. */
export function peekIdentity(
  db: Database.Database,
  platform: string,
  externalId: string,
): string | undefined {
  ensureSessionTables(db);
  const row = db
    .prepare('SELECT person_id FROM aliases WHERE platform = ? AND external_id = ?')
    .get(platform, externalId) as { person_id: string } | undefined;
  return row?.person_id;
}

/**
 * Platform id → canonical person. Unknown ids get a fresh person node,
 * which has resolution 0 everywhere until tuples grant it something —
 * strangers are deny-by-default for free.
 */
export function resolveIdentity(db: Database.Database, platform: string, externalId: string): string {
  ensureSessionTables(db);
  const row = db
    .prepare('SELECT person_id FROM aliases WHERE platform = ? AND external_id = ?')
    .get(platform, externalId) as { person_id: string } | undefined;
  if (row) return row.person_id;

  const personId = `person:${randomUUID()}`;
  db.prepare('INSERT INTO aliases (platform, external_id, person_id) VALUES (?, ?, ?)').run(
    platform,
    externalId,
    personId,
  );
  return personId;
}

/** Owner action: bind a platform identity to an existing person node. */
export function linkIdentity(
  db: Database.Database,
  platform: string,
  externalId: string,
  personId: string,
): void {
  ensureSessionTables(db);
  db.prepare(
    `INSERT INTO aliases (platform, external_id, person_id) VALUES (?, ?, ?)
     ON CONFLICT(platform, external_id) DO UPDATE SET person_id = excluded.person_id`,
  ).run(platform, externalId, personId);
}

/**
 * One session per audience container (a DM peer, a group chat). The id is
 * stable per channel; the audience is refreshed on every call so group
 * membership changes take effect immediately.
 */
export function sessionFor(
  db: Database.Database,
  req: { platform: string; channel: string; peerExternalIds: string[] },
): Session {
  ensureSessionTables(db);
  const audience = [...new Set(req.peerExternalIds.map((x) => resolveIdentity(db, req.platform, x)))].sort();
  const id = `${req.platform}:${req.channel}`;

  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | { id: string; channel: string; audience: string; scope: string | null }
    | undefined;

  if (!existing) {
    db.prepare('INSERT INTO sessions (id, channel, audience, scope) VALUES (?, ?, ?, NULL)').run(
      id,
      req.channel,
      JSON.stringify(audience),
    );
    return { id, audience, scope: null };
  }

  db.prepare('UPDATE sessions SET audience = ? WHERE id = ?').run(JSON.stringify(audience), id);
  return { id, audience, scope: existing.scope ? (JSON.parse(existing.scope) as string[]) : null };
}

export function getSession(db: Database.Database, id: string): Session | undefined {
  ensureSessionTables(db);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | { id: string; audience: string; scope: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    audience: JSON.parse(row.audience) as string[],
    scope: row.scope ? (JSON.parse(row.scope) as string[]) : null,
  };
}

// ---------------------------------------------------------------------------
// TBAC task scope: narrowing is automatic, widening requires the ledger.
// ---------------------------------------------------------------------------

function mustGetSession(db: Database.Database, id: string): Session {
  const session = getSession(db, id);
  if (!session) throw new Error(`unknown session "${id}"`);
  return session;
}

function setScope(db: Database.Database, id: string, scope: string[] | null): void {
  db.prepare('UPDATE sessions SET scope = ? WHERE id = ?').run(
    scope === null ? null : JSON.stringify([...new Set(scope)].sort()),
    id,
  );
}

/**
 * Shrink the task scope. No ledger event — narrowing is free by design.
 * Mechanically refuses to smuggle in new topics: that is widening.
 */
export function narrowScope(db: Database.Database, sessionId: string, topics: string[]): void {
  const session = mustGetSession(db, sessionId);
  if (session.scope !== null) {
    const added = topics.filter((t) => !session.scope!.includes(t));
    if (added.length > 0) {
      throw new Error(`narrowScope cannot add topics (${added.join(', ')}) — use widenScope`);
    }
  }
  setScope(db, sessionId, topics);
}

/**
 * Expand the task scope (union of topics, or null to lift all restriction).
 * Appends `scope.widened` BEFORE the state change — no event, no widening.
 * No-op (and no event) when nothing actually widens.
 */
export function widenScope(
  deps: { db: Database.Database; ledger: Ledger },
  sessionId: string,
  topics: string[] | null,
): void {
  const session = mustGetSession(deps.db, sessionId);
  if (session.scope === null) return; // already unscoped — nothing to widen

  const next = topics === null ? null : [...new Set([...session.scope, ...topics])].sort();
  if (next !== null && next.length === session.scope.length) return; // no-op

  deps.ledger.append('scope.widened', { sessionId, from: session.scope, to: next });
  setScope(deps.db, sessionId, next);
}
