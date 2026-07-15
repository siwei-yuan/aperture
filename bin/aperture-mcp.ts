#!/usr/bin/env -S npx tsx
/**
 * Aperture MCP server (stdio).
 *
 *   aperture-mcp --db ~/.aperture/aperture.db \
 *     --owner person:owner \
 *     --audience person:bob \
 *     --channel telegram:dm:bob
 *
 * One server instance per audience: the viewer identity is a launch
 * argument, never a tool parameter.
 *
 * LLM for distillation comes from env (any OpenAI-compatible endpoint):
 * APERTURE_LLM_BASE_URL / APERTURE_LLM_API_KEY / APERTURE_LLM_MODEL.
 * Without them the server still runs — recall works, store records ingress
 * on the ledger but skips distillation (honest degradation).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import type { LayerGenerator } from '../src/core/ingest.js';
import { createApertureMcpServer } from '../src/adapters/mcp.js';
import { LlmLayerGenerator, type LlmClient } from '../src/gen/llm-generator.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    owner: { type: 'string' },
    audience: { type: 'string' },
    channel: { type: 'string' },
  },
});

if (!values.db || !values.owner || !values.audience || !values.channel) {
  console.error('usage: aperture-mcp --db <path> --owner <person:id> --audience <person:id[,person:id]> --channel <channel>');
  process.exit(1);
}

function makeGenerator(): LayerGenerator {
  const base = process.env.APERTURE_LLM_BASE_URL;
  const key = process.env.APERTURE_LLM_API_KEY;
  const model = process.env.APERTURE_LLM_MODEL;
  if (!base || !key || !model) {
    console.error('aperture-mcp: no LLM configured — store will ledger ingress but skip distillation');
    return { generate: async () => ({ skip: true, reason: 'no-llm-configured' }) };
  }
  const client: LlmClient = {
    async completeJson(system, user) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`LLM endpoint ${res.status}`);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return body.choices[0]!.message.content;
    },
  };
  return new LlmLayerGenerator(client);
}

const server = createApertureMcpServer({
  db: new Database(values.db),
  ownerId: values.owner,
  audience: values.audience.split(',').map((s) => s.trim()),
  channel: values.channel,
  generator: makeGenerator(),
});

await server.connect(new StdioServerTransport());
