#!/usr/bin/env -S npx tsx
/**
 * Owner UI: permission visualization and signing console.
 *
 *   aperture-ui --db ~/.aperture/aperture.db [--owner person:owner] [--port 4870]
 *
 * Listens on 127.0.0.1 only (hardcoded — use ssh port forwarding for remote
 * access). The printed URL carries the session token in the fragment; the
 * token dies with the process.
 */
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/core/db.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';
import { createUiServer } from '../src/ui/server.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    owner: { type: 'string', default: 'person:owner' },
    port: { type: 'string', default: '4870' },
  },
});

if (!values.db) {
  console.error('usage: aperture-ui --db <path> [--owner <person:id>] [--port <port>]');
  process.exit(1);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port "${values.port}"`);
  process.exit(1);
}

const db = openDatabase(values.db);
const ledger = new Ledger(db);
const store = new AtomStore(db);
const acl = new AclStore(db, ledger);

const { server, token } = createUiServer({ db, ledger, store, acl, ownerId: values.owner! });
server.listen(port, '127.0.0.1', () => {
  console.log(`aperture ui listening on http://127.0.0.1:${port}/#t=${token}`);
  console.log('(localhost only — the token above is the session key; it dies with this process)');
});
