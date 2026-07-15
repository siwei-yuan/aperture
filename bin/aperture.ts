#!/usr/bin/env -S npx tsx
/**
 * Owner CLI.
 *
 *   aperture --db ~/.aperture/aperture.db pending
 *   aperture --db ~/.aperture/aperture.db promote <atomId>
 *   aperture --db ~/.aperture/aperture.db grant topic:activity viewer tier:friend#member 3
 *   aperture --db ~/.aperture/aperture.db disclosures --viewer person:bob
 *   aperture --db ~/.aperture/aperture.db verify
 */
import { parseArgs } from 'node:util';
import { runCli } from '../src/cli.js';
import { openDatabase } from '../src/core/db.js';

const { values, positionals } = parseArgs({
  options: {
    db: { type: 'string' },
    owner: { type: 'string', default: 'person:owner' },
    viewer: { type: 'string' },
  },
  allowPositionals: true,
});

if (!values.db) {
  console.error('usage: aperture --db <path> [--owner <person:id>] <command> [...args]');
  process.exit(1);
}

const argv = [...positionals];
if (values.viewer) argv.push('--viewer', values.viewer);

const code = await runCli(
  { db: openDatabase(values.db), ownerId: values.owner! },
  argv,
  (line) => console.log(line),
);
process.exit(code);
