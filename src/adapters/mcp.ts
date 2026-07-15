import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { hashEmbedder, VectorStore, type Embedder } from '../core/embed.js';
import { IngestPipeline, type LayerGenerator } from '../core/ingest.js';
import { Ledger } from '../core/ledger.js';
import { retrieve } from '../core/retrieve.js';
import { AtomStore } from '../core/store.js';
import { capture } from '../gen/capture.js';

export interface ApertureMcpOptions {
  db: Database.Database;
  ownerId: string;
  /**
   * Fixed at launch — the trust boundary. The model gets no parameter to
   * choose whose eyes it looks through; one server instance per audience.
   */
  audience: string[];
  channel: string;
  generator: LayerGenerator;
  embedder?: Embedder;
}

export function createApertureMcpServer(opts: ApertureMcpOptions): McpServer {
  const store = new AtomStore(opts.db);
  const ledger = new Ledger(opts.db);
  const vectors = new VectorStore(opts.db, opts.embedder ?? hashEmbedder(64));
  const pipeline = new IngestPipeline({
    store,
    ledger,
    ownerId: opts.ownerId,
    generator: opts.generator,
    vectors,
  });
  // Provenance is also fixed at launch: content arriving through this server
  // is attributed to the audience, never to the owner — so non-owner content
  // always lands in quarantine regardless of what the model claims.
  const speaker = opts.audience[0] ?? 'person:unknown';

  const server = new McpServer({ name: 'aperture', version: '0.1.0' });

  server.registerTool(
    'aperture_recall',
    {
      description:
        'Recall memories permitted for the current audience. Results are already ' +
        'adjudicated: each atom appears at its finest permitted layer only.',
      inputSchema: {
        query: z.string().describe('What to search for'),
        k: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      },
    },
    async ({ query, k }) => {
      const res = await retrieve(
        { db: opts.db, ledger, store, vectors },
        { audience: opts.audience, query, k },
      );
      const text =
        res.items.length === 0
          ? '(no permitted memories)'
          : res.items.map((i) => `[L${i.level}] ${i.text}`).join('\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'aperture_store',
    {
      description:
        'Store an episode into memory. Non-owner content is quarantined until the owner approves.',
      inputSchema: {
        content: z.string().describe('The episode content to remember'),
        topics: z.array(z.string()).max(3).optional().describe('Topic tags (default: general)'),
      },
    },
    async ({ content, topics }) => {
      const result = await capture(
        { db: opts.db, ledger, pipeline },
        {
          content,
          subject: [speaker],
          topics: topics ?? ['general'],
          source: { who: speaker, channel: opts.channel, ts: Date.now() },
          acquisitionContext: opts.channel,
        },
      );

      let text: string;
      if ('gated' in result) text = `not distilled (${result.gated}: ${result.detail})`;
      else if (!result.ingest.ok) text = 'rejected: ladder violated the entailment invariant';
      else if ('skipped' in result.ingest) text = `skipped (${result.ingest.skipped})`;
      else text = `stored${result.ingest.atom.quarantined ? ' (quarantined until owner approval)' : ''}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}
