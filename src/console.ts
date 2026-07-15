import type Database from 'better-sqlite3';
import { promoteAtom, sealAtom } from './core/ingest.js';
import type { Ledger } from './core/ledger.js';
import { AclStore } from './core/rebac.js';
import type { PromotionSuggestion, ScopeBlock } from './core/retrieve.js';
import type { AtomStore } from './core/store.js';
import { ensureSessionTables, getSession, peekIdentity, resolveIdentity, widenScope, type Session } from './session/router.js';

/**
 * Owner console: the chat-native counterpart of the CLI. The design rule it
 * enforces is the membrane's signature rule — the model may DRAFT, but every
 * authorization fact (approval, grant) is signed by a deterministic owner
 * action that never passes through an LLM.
 *
 * Harness contract (two mount points, both optional-degradable):
 *  - a model-bypassing command entry → feed inbound text to handleOwnerCommand
 *  - a proactive owner push → deliver the *Notice strings after capture
 */

export interface ConsoleDeps {
  db: Database.Database;
  ledger: Ledger;
  store: AtomStore;
  ownerId: string;
}

export type ConsoleResult =
  | { handled: false }
  | { handled: true; reply: string };

const NOT_HANDLED: ConsoleResult = { handled: false };

const HELP = `aperture owner console:
/aperture pending — list room-local atoms (usable in their own room; promotion makes them global)
/aperture promote <id> — lift an atom into the globally retrievable profile
/aperture seal <id> — reject an atom (visible nowhere, stays on the ledger)
/aperture grant <who> <tier> — add <who> to a tier (who: platform:id or person:id-prefix)
/aperture revoke <who> <tier> — remove <who> from a tier
/aperture allow <session> <topic> — let a conversation enter a sensitive topic (session: platform:channel or platform:externalId)`;

/** First uuid segment: 8 hex chars, no hyphens — safe in tappable commands. */
export function shortId(atomId: string): string {
  return atomId.slice(0, 8);
}

/**
 * Push text when another room wanted a local atom (demand-driven promotion).
 * Coarsest layer only — the notice itself is a disclosure.
 */
export function promotionNotice(s: PromotionSuggestion): string {
  return (
    `🔓 another conversation wanted a room-local memory:\n` +
    `"${s.summary}"\n` +
    `/aperture promote ${shortId(s.atomId)} to share it · /aperture seal ${shortId(s.atomId)} to reject · ignoring keeps it room-local`
  );
}

/** Push text when a session's query wanted a sensitive topic the scope withheld. */
export function scopeNotice(b: ScopeBlock): string {
  return (
    `🔒 conversation ${b.sessionId} wants to enter the "${b.topic}" topic (sensitive — held back)\n` +
    `/aperture allow ${b.sessionId} ${b.topic} to let it in · ignoring keeps it out`
  );
}

/** Push text when distillation proposed a topic outside the taxonomy. Zero grants until the owner signs some. */
export function newTopicNotice(topic: string): string {
  return (
    `🏷️ new topic discovered: ${topic} (no grants — no one sees it)\n` +
    `sign it in the UI, or: aperture grant topic:${topic} viewer tier:friend#member 3`
  );
}

/** Push text for a first-time sender. Zero-resolution until the owner acts. */
export function newContactNotice(platform: string, externalId: string): string {
  return (
    `👤 new contact: ${platform}:${externalId} (no grants — sees nothing)\n` +
    `/aperture grant ${platform}:${externalId} friend — or any tier you use`
  );
}

/** Identity lookup that also reports first-sight, for the new-contact push. */
export function noteContact(
  db: Database.Database,
  platform: string,
  externalId: string,
): { personId: string; isNew: boolean } {
  const existing = peekIdentity(db, platform, externalId);
  if (existing) return { personId: existing, isNew: false };
  return { personId: resolveIdentity(db, platform, externalId), isNew: true };
}

/** `person:<prefix>` → unique full person id from the alias table, if unambiguous. */
function expandPersonPrefix(db: Database.Database, ref: string): string | undefined {
  const rows = db
    .prepare("SELECT DISTINCT person_id FROM aliases WHERE person_id LIKE ? || '%'")
    .all(ref) as Array<{ person_id: string }>;
  if (rows.length === 1) return rows[0]!.person_id;
  return rows.some((r) => r.person_id === ref) ? ref : undefined;
}

/**
 * Session ref → session. The pushed notice carries the exact session id
 * (platform:channel), so the direct lookup is the common path; as a
 * convenience, `platform:externalId` also resolves when that person has
 * exactly one DM session.
 */
function resolveSessionRef(db: Database.Database, ref: string): Session | undefined {
  const direct = getSession(db, ref);
  if (direct) return direct;

  const colon = ref.indexOf(':');
  if (colon <= 0 || colon === ref.length - 1) return undefined;
  const person = peekIdentity(db, ref.slice(0, colon), ref.slice(colon + 1));
  if (!person) return undefined;
  ensureSessionTables(db);
  const rows = db.prepare('SELECT id, audience FROM sessions').all() as Array<{ id: string; audience: string }>;
  const matches = rows.filter((r) => {
    const audience = JSON.parse(r.audience) as string[];
    return audience.length === 1 && audience[0] === person;
  });
  return matches.length === 1 ? getSession(db, matches[0]!.id) : undefined;
}

/** `<platform>:<externalId>` or `person:<id-prefix>` → person id. Minting is fine here: the owner is about to grant. */
function resolveWho(db: Database.Database, ref: string): string | undefined {
  const colon = ref.indexOf(':');
  if (colon <= 0 || colon === ref.length - 1) return undefined;
  if (ref.startsWith('person:')) return expandPersonPrefix(db, ref);
  return resolveIdentity(db, ref.slice(0, colon), ref.slice(colon + 1));
}

/**
 * The single command entrance, namespaced under one root command
 * ("/aperture ...") so it can never collide with a host's built-in or
 * reserved command names. Only the owner's platform identity is recognized;
 * anyone else's "/aperture ..." is not a command, just words
 * (handled: false — no refusal reply, a refusal would leak the grammar).
 */
export function handleOwnerCommand(
  deps: ConsoleDeps,
  msg: { platform: string; senderExternalId: string; text: string },
): ConsoleResult {
  const text = msg.text.trim();
  if (!/^\/aperture\b/i.test(text)) return NOT_HANDLED;

  if (peekIdentity(deps.db, msg.platform, msg.senderExternalId) !== deps.ownerId) {
    return NOT_HANDLED;
  }

  const [command = 'help', ...args] = text.split(/\s+/).slice(1);
  switch (command.toLowerCase()) {
    default:
      return { handled: true, reply: HELP };

    case 'pending':
    case 'quarantine': {
      const atoms = deps.store.listLocal();
      if (atoms.length === 0) return { handled: true, reply: 'no room-local atoms' };
      const lines = atoms.map(
        (a) => `/aperture promote ${shortId(a.id)} · ${a.source.who} · "${a.layers[0]?.text ?? ''}"`,
      );
      return { handled: true, reply: lines.join('\n') };
    }

    case 'promote':
    case 'approve':
    case 'seal': {
      const verb = command === 'seal' ? 'seal' : 'promote';
      const prefix = args[0];
      if (!prefix) return { handled: true, reply: `usage: /aperture ${verb} <id> (see /aperture pending)` };
      const matches = deps.store.listLocal().filter((a) => a.id.startsWith(prefix));
      if (matches.length === 0) return { handled: true, reply: `no room-local atom matches "${prefix}"` };
      if (matches.length > 1) return { handled: true, reply: `"${prefix}" is ambiguous (${matches.length} matches)` };
      const act = verb === 'seal' ? sealAtom : promoteAtom;
      act(
        { store: deps.store, ledger: deps.ledger, ownerId: deps.ownerId },
        matches[0]!.id,
        deps.ownerId,
      );
      return {
        handled: true,
        reply: `${verb === 'seal' ? 'sealed' : 'promoted'}: "${matches[0]!.layers[0]?.text ?? matches[0]!.id}"`,
      };
    }

    case 'allow': {
      const [sessionRef, topic] = args;
      if (!sessionRef || !topic) return { handled: true, reply: 'usage: /aperture allow <session> <topic>' };
      const session = resolveSessionRef(deps.db, sessionRef);
      if (!session) return { handled: true, reply: `unknown session "${sessionRef}"` };
      widenScope({ db: deps.db, ledger: deps.ledger }, session.id, [topic]);
      return { handled: true, reply: `${session.id} may now enter "${topic}"` };
    }

    case 'grant':
    case 'revoke': {
      const [whoRef, tier] = args;
      if (!whoRef || !tier) return { handled: true, reply: `usage: /aperture ${command} <who> <tier>` };
      const who = resolveWho(deps.db, whoRef);
      if (!who) return { handled: true, reply: `unknown contact "${whoRef}"` };
      const acl = new AclStore(deps.db, deps.ledger);
      const tuple = { object: `tier:${tier}`, relation: 'member', subject: who };
      if (command === 'grant') {
        acl.grant({ ...tuple, resolution: 4 });
        return { handled: true, reply: `${who} is now a member of tier:${tier}` };
      }
      acl.revoke(tuple);
      return { handled: true, reply: `${who} removed from tier:${tier}` };
    }
  }
}
