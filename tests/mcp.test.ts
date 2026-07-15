import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApertureMcpServer } from '../src/adapters/mcp.js';
import type { MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import type { LayerDraft } from '../src/core/ingest.js';
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
  layers: [
    { level: 1, text: 'he is at his computer', entities: ['computer'] },
    { level: 2, text: 'he is watching a video', entities: ['computer', 'video'] },
    { level: 3, text: 'he is watching bilibili', entities: ['computer', 'video', 'bilibili'] },
    { level: 4, text: 'he is watching rust async explained on bilibili', entities: ['computer', 'video', 'bilibili', 'rust async explained'] },
  ],
  quarantined: false,
};

const strangerDrafts: LayerDraft[] = [
  { level: 1, text: 'bob has news', entities: ['bob'] },
  { level: 2, text: 'bob is moving to shanghai', entities: ['bob', 'shanghai'] },
];

async function connect(audience: string[]) {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, hashEmbedder(32));
  const acl = new AclStore(db, ledger);

  store.insert(biliAtom);
  await vectors.index(biliAtom);
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: BOB, resolution: 1 });

  const server = createApertureMcpServer({
    db,
    ownerId: OWNER,
    audience,
    channel: 'telegram:dm:bob',
    generator: { generate: async () => structuredClone(strangerDrafts) },
    embedder: hashEmbedder(32),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, db, store, ledger };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join('\n');
}

describe('MCP adapter', () => {
  it('recall as a tier-1 audience never returns layers above the ceiling', async () => {
    const { client } = await connect([BOB]);
    const result = await client.callTool({
      name: 'aperture_recall',
      arguments: { query: 'watching bilibili video' },
    });
    const text = textOf(result);
    expect(text).toContain('[L1] he is at his computer');
    expect(text).not.toContain('bilibili');
    expect(text).not.toContain('rust async');
  });

  it('recall for an unknown audience is empty (default deny)', async () => {
    const { client } = await connect(['person:mallory']);
    const result = await client.callTool({
      name: 'aperture_recall',
      arguments: { query: 'watching bilibili video' },
    });
    expect(textOf(result)).toBe('(no permitted memories)');
  });

  it('store attributes provenance to the audience: content lands in quarantine', async () => {
    const { client, store, ledger } = await connect([BOB]);
    const result = await client.callTool({
      name: 'aperture_store',
      arguments: { content: 'i am moving to shanghai next tuesday, new address 88 guangfu road' },
    });

    expect(textOf(result)).toContain('quarantined');
    expect(store.listQuarantined()).toHaveLength(1);
    expect(store.listVisible()).toHaveLength(1); // only the seeded owner atom
    expect([...ledger.events()].some((e) => e.type === 'ingress.received')).toBe(true);
    expect(ledger.verify().ok).toBe(true);
  });
});
