import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { checkEgress, type EgressDeps } from '../src/core/egress.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';

const OWNER = 'person:owner';
const BOB = 'person:bob';

const biliAtom: MemoryAtom = {
  id: 'bili',
  subject: [OWNER],
  source: { who: OWNER, channel: 'screen', ts: 1_000 },
  acquisitionContext: 'private',
  topics: ['activity'],
  // Layer texts chosen with minimal cross-layer lexical overlap: the toy
  // bigram embedder must behave like a semantic one for these tests.
  layers: [
    { level: 1, text: 'busy at the desk today', entities: [] },
    { level: 2, text: 'enjoying multimedia entertainment', entities: ['video'] },
    { level: 3, text: 'browsing bilibili currently', entities: ['video', 'bilibili'] },
    { level: 4, text: 'watching rust async explained on bilibili', entities: ['video', 'bilibili', 'rust async explained'] },
  ],
  quarantined: false,
};

const poisonAtom: MemoryAtom = {
  id: 'poison',
  subject: [BOB],
  source: { who: BOB, channel: 'telegram:dm', ts: 2_000 },
  acquisitionContext: 'dm',
  topics: ['activity'],
  layers: [{ level: 1, text: 'bob shared a secret meeting location downtown', entities: ['bob'] }],
  quarantined: true,
};

async function makeDeps(): Promise<EgressDeps> {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, hashEmbedder(64));
  const acl = new AclStore(db, ledger);

  for (const atom of [biliAtom, poisonAtom]) {
    store.insert(atom);
    await vectors.index(atom);
  }
  // Bob may see up to L1 of activity atoms.
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: BOB, resolution: 1 });

  return { db, ledger, store, vectors };
}

const requestEvents = (ledger: Ledger) =>
  [...ledger.events()].filter((e) => e.type === 'disclosure.request');

describe('egress checker (second line of defense)', () => {
  it('deterministic PII scan escalates regardless of memory similarity', async () => {
    const deps = await makeDeps();
    const result = await checkEgress(deps, {
      audience: [BOB],
      reply: '你可以打给他，号码是13812345678。',
    });

    expect(result.verdict).toBe('escalate');
    expect(result.hits[0]).toMatchObject({ kind: 'pii', detail: 'cn-mobile' });
    expect(requestEvents(deps.ledger)).toHaveLength(1);
  });

  it('a reply reconstructing a blocked layer escalates with the atom named', async () => {
    const deps = await makeDeps();
    const result = await checkEgress(deps, {
      audience: [BOB],
      reply: 'oh he is watching rust async explained on bilibili right now!',
      threshold: 0.5,
    });

    expect(result.verdict).toBe('escalate');
    const similarity = result.hits.find((h) => h.kind === 'similarity');
    expect(similarity).toMatchObject({ atomId: 'bili' });
    expect(similarity!.level).toBeGreaterThan(1);

    const event = requestEvents(deps.ledger)[0]!;
    expect((event.payload as { audience: string[] }).audience).toEqual([BOB]);
  });

  it('echoing a PERMITTED layer passes silently — no event', async () => {
    const deps = await makeDeps();
    const result = await checkEgress(deps, {
      audience: [BOB],
      reply: 'busy at the desk today',
      threshold: 0.5,
    });

    expect(result.verdict).toBe('pass');
    expect(requestEvents(deps.ledger)).toHaveLength(0);
  });

  it('clean, unrelated replies pass silently', async () => {
    const deps = await makeDeps();
    const result = await checkEgress(deps, {
      audience: [BOB],
      reply: '今天天气不错，适合出门散步。',
      threshold: 0.5,
    });
    expect(result.verdict).toBe('pass');
    expect(requestEvents(deps.ledger)).toHaveLength(0);
  });

  it('quarantined content is fully blocked even for a fully-granted audience', async () => {
    const deps = await makeDeps();
    // give bob everything on the topic — quarantine must still block
    const acl = new AclStore(deps.db, deps.ledger);
    acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: BOB, resolution: 4 });

    const result = await checkEgress(deps, {
      audience: [BOB],
      reply: 'apparently bob shared a secret meeting location downtown',
      threshold: 0.5,
    });

    expect(result.verdict).toBe('escalate');
    expect(result.hits.find((h) => h.atomId === 'poison')).toBeDefined();
  });
});
