import type Database from 'better-sqlite3';
import type { MemoryAtom } from './core/atom.js';
import { approveAtom } from './core/ingest.js';
import type { Ledger } from './core/ledger.js';
import { AclStore } from './core/rebac.js';
import type { AtomStore } from './core/store.js';
import { peekIdentity, resolveIdentity } from './session/router.js';

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
/aperture quarantine — list atoms awaiting approval
/aperture approve <id> — release an atom from quarantine
/aperture grant <who> <tier> — add <who> to a tier (who: platform:id or person:id-prefix)
/aperture revoke <who> <tier> — remove <who> from a tier`;

/** First uuid segment: 8 hex chars, no hyphens — safe in tappable commands. */
export function shortId(atomId: string): string {
  return atomId.slice(0, 8);
}

/** Push text for a freshly quarantined atom. Coarsest layer only — the notice itself is a disclosure. */
export function quarantineNotice(atom: MemoryAtom): string {
  const summary = atom.layers[0]?.text ?? '(no summary)';
  return (
    `🔒 quarantined from ${atom.source.who} (${atom.source.channel}):\n` +
    `"${summary}"\n` +
    `/aperture approve ${shortId(atom.id)} to release · ignoring keeps it sealed`
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

    case 'quarantine': {
      const atoms = deps.store.listQuarantined();
      if (atoms.length === 0) return { handled: true, reply: 'quarantine is empty' };
      const lines = atoms.map(
        (a) => `/aperture approve ${shortId(a.id)} · ${a.source.who} · "${a.layers[0]?.text ?? ''}"`,
      );
      return { handled: true, reply: lines.join('\n') };
    }

    case 'approve': {
      const prefix = args[0];
      if (!prefix) return { handled: true, reply: 'usage: /aperture approve <id> (see /aperture quarantine)' };
      const matches = deps.store.listQuarantined().filter((a) => a.id.startsWith(prefix));
      if (matches.length === 0) return { handled: true, reply: `no quarantined atom matches "${prefix}"` };
      if (matches.length > 1) return { handled: true, reply: `"${prefix}" is ambiguous (${matches.length} matches)` };
      approveAtom(
        { store: deps.store, ledger: deps.ledger, ownerId: deps.ownerId },
        matches[0]!.id,
        deps.ownerId,
      );
      return { handled: true, reply: `approved: "${matches[0]!.layers[0]?.text ?? matches[0]!.id}"` };
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
