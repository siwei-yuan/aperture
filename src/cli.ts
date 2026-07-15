import type Database from 'better-sqlite3';
import { promoteAtom, sealAtom } from './core/ingest.js';
import { Ledger } from './core/ledger.js';
import { AclStore, check } from './core/rebac.js';
import { AtomStore } from './core/store.js';

export interface CliDeps {
  db: Database.Database;
  ownerId: string;
}

const USAGE = `usage: aperture <command> [...args]
  pending                                       list room-local atoms
  promote <atomId>                              lift an atom into the global profile
  seal <atomId>                                 reject an atom (visible nowhere)
  grant <object> <relation> <subject> <0-4>     write an ACL tuple (ledgered)
  revoke <object> <relation> <subject>          delete an ACL tuple (ledgered)
  check <subject> <object>                      resolution of subject on object
  disclosures [--viewer <person>]               what left the membrane, to whom
  verify                                        verify the ledger hash chain`;

/**
 * Pure command dispatcher: no process, no stdout — callers inject `out`.
 * Every command is a thin pass-through to an existing core function; the
 * CLI invents no capability of its own.
 */
export async function runCli(
  deps: CliDeps,
  argv: string[],
  out: (line: string) => void,
): Promise<number> {
  const { db, ownerId } = deps;
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const acl = new AclStore(db, ledger);
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case 'pending':
      case 'quarantine': {
        const atoms = store.listLocal();
        if (atoms.length === 0) {
          out('no room-local atoms');
          return 0;
        }
        for (const atom of atoms) {
          out(`${atom.id}  from=${atom.source.who}  channel=${atom.source.channel}  L1="${atom.layers[0]?.text ?? ''}"`);
        }
        return 0;
      }

      case 'promote':
      case 'approve':
      case 'seal': {
        const verb = command === 'seal' ? 'seal' : 'promote';
        const atomId = rest[0];
        if (!atomId) {
          out(`usage: ${verb} <atomId>`);
          return 1;
        }
        (verb === 'seal' ? sealAtom : promoteAtom)({ store, ledger, ownerId }, atomId, ownerId);
        out(`${verb === 'seal' ? 'sealed' : 'promoted'} ${atomId}`);
        return 0;
      }

      case 'grant': {
        const [object, relation, subject, resolution] = rest;
        if (!object || !relation || !subject || resolution === undefined) {
          out('usage: grant <object> <relation> <subject> <resolution 0-4>');
          return 1;
        }
        acl.grant({ object, relation, subject, resolution: Number(resolution) });
        out(`granted ${object}#${relation}@${subject} = ${resolution}`);
        return 0;
      }

      case 'revoke': {
        const [object, relation, subject] = rest;
        if (!object || !relation || !subject) {
          out('usage: revoke <object> <relation> <subject>');
          return 1;
        }
        acl.revoke({ object, relation, subject });
        out(`revoked ${object}#${relation}@${subject}`);
        return 0;
      }

      case 'check': {
        const [subject, object] = rest;
        if (!subject || !object) {
          out('usage: check <subject> <object>');
          return 1;
        }
        out(`${check(db, subject, object)}`);
        return 0;
      }

      case 'disclosures': {
        const viewerIdx = rest.indexOf('--viewer');
        const viewer = viewerIdx >= 0 ? rest[viewerIdx + 1] : undefined;
        let found = 0;
        for (const event of ledger.events()) {
          if (event.type !== 'disclosure.adjudicated' && event.type !== 'disclosure.request') continue;
          const payload = event.payload as {
            audience: string[];
            injected?: Array<{ atomId: string; level: number }>;
            hits?: Array<{ kind: string; atomId?: string; level?: number }>;
          };
          if (viewer && !payload.audience.includes(viewer)) continue;
          found++;
          const when = new Date(event.ts).toISOString();
          const who = payload.audience.join(',');
          if (event.type === 'disclosure.adjudicated') {
            const injected =
              payload.injected && payload.injected.length > 0
                ? payload.injected.map((i) => `${i.atomId}@L${i.level}`).join(' ')
                : '(nothing)';
            out(`#${event.seq} ${when} adjudicated → [${who}] ${injected}`);
          } else {
            out(`#${event.seq} ${when} ESCALATED → [${who}] ${payload.hits?.length ?? 0} hit(s)`);
          }
        }
        if (found === 0) out('no disclosures');
        return 0;
      }

      case 'verify': {
        const result = ledger.verify();
        if (result.ok) {
          out('ledger chain OK');
          return 0;
        }
        out(`ledger chain BROKEN at seq ${result.brokenAtSeq}`);
        return 1;
      }

      default:
        out(USAGE);
        return 1;
    }
  } catch (error) {
    out(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
