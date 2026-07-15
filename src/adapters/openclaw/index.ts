/**
 * OpenClaw adapter — binds aperture's membrane to the real plugin SDK
 * (openclaw 2026.6.9: `definePluginEntry`, typed hooks, dynamic tools).
 *
 * Mount points:
 *   before_prompt_build → adjudicated retrieval injected as prependContext
 *   agent_end           → this turn's transcript through the ingress gates
 *   message_sending     → egress check; escalations are rewritten to a safe
 *                         placeholder (checkEgress already ledgered the
 *                         disclosure.request for owner review)
 *   aperture_recall / aperture_store → tools bound to the runtime tool context
 */
import type Database from 'better-sqlite3';
import { buildJsonPluginConfigSchema, definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { Type } from 'typebox';
import { handleOwnerCommand, newContactNotice, noteContact, promotionNotice } from '../../console.js';
import { openDatabase } from '../../core/db.js';
import { hashEmbedder, httpEmbedder, VectorStore, type Embedder } from '../../core/embed.js';
import { checkEgress } from '../../core/egress.js';
import { IngestPipeline, type LayerGenerator } from '../../core/ingest.js';
import { Ledger } from '../../core/ledger.js';
import { retrieveForSession } from '../../core/retrieve.js';
import { AtomStore } from '../../core/store.js';
import { capture } from '../../gen/capture.js';
import { CaptureBuffer, DEFAULT_DEBOUNCE } from '../../gen/debounce.js';
import { LlmLayerGenerator, type LlmClient } from '../../gen/llm-generator.js';
import { linkIdentity, resolveIdentity, sessionFor } from '../../session/router.js';

export interface ApertureDeps {
  db: Database.Database;
  ownerId: string;
  /** platform → the owner's own external id, so their messages land global, not room-local. */
  ownerExternalIds?: Record<string, string>;
  generator: LayerGenerator;
  embedder?: Embedder;
  /** Default topic tags for captured episodes. */
  topics?: string[];
  /** Proactive push to the owner (promotion / new-contact notices). Absent = no pushes. */
  notifyOwner?: (text: string) => void | Promise<void>;
  /**
   * Quiet gap (ms) before a session's buffered turns are distilled as one
   * burst. 0 = distill every turn immediately. Recording on the ledger is
   * always immediate either way.
   */
  debounceMs?: number;
}

/** The slice of the host API the adapter consumes — fake-able in tests. */
export type ApertureHostApi = Pick<OpenClawPluginApi, 'on' | 'registerTool' | 'registerCommand'>;

/** Outbound replacement when egress escalates: the reply is escrowed, not sent. */
export const EGRESS_PLACEHOLDER = 'Let me get back to you on that after checking with my owner.';

/** Pull this turn's text out of the host's loosely-typed message list. */
function transcriptOf(messages: unknown[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') continue;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((block) => {
                const b = block as { type?: unknown; text?: unknown };
                return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
              })
              .join('')
          : '';
    if (text.trim()) lines.push(`${role}: ${text.trim()}`);
  }
  return lines.join('\n');
}

export function registerAperture(api: ApertureHostApi, config: ApertureDeps): void {
  const { db, ownerId } = config;
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, config.embedder ?? hashEmbedder(64));
  const pipeline = new IngestPipeline({ store, ledger, ownerId, generator: config.generator, vectors });
  const membrane = { db, ledger, store, vectors };
  const topics = config.topics ?? ['general'];

  for (const [platform, externalId] of Object.entries(config.ownerExternalIds ?? {})) {
    linkIdentity(db, platform, externalId, ownerId);
  }

  const notify = (text: string) => {
    if (!config.notifyOwner) return;
    void Promise.resolve(config.notifyOwner(text)).catch((err) =>
      console.error('[aperture] owner notify failed:', err),
    );
  };

  // First-sight detection must run wherever an identity is FIRST resolved —
  // recall fires before capture, so both paths go through here.
  const seeContact = (platform: string, externalId: string): string => {
    const contact = noteContact(db, platform, externalId);
    if (contact.isNew) notify(newContactNotice(platform, externalId));
    return contact.personId;
  };

  /** Injected when adjudication returns nothing: the model must know that it does not know. */
  const EMPTY_RECALL =
    '<aperture-memory>\n(no permitted memories for this audience — do not assume any prior ' +
    'knowledge about the participants; if you do not know who someone is, ask instead of guessing)\n</aperture-memory>';

  // auto-recall: adjudicated retrieval into the upcoming model context.
  api.on('before_prompt_build', async (event, ctx) => {
    const platform = ctx.messageProvider ?? ctx.channel;
    // senderId is absent on some runs (observed live: owner DM turns). The
    // conversation target id is the peer for DMs; for groups it resolves to
    // a fresh person node, which stays deny-by-default.
    const peer = ctx.senderId ?? ctx.channelId ?? ctx.chatId;
    if (!platform || !peer) return; // no channel audience — default deny
    seeContact(platform, peer);
    const session = sessionFor(db, {
      platform,
      channel: ctx.channelId ?? ctx.chatId ?? ctx.sessionKey ?? 'unknown',
      peerExternalIds: [peer],
    });
    const res = await retrieveForSession(membrane, { sessionId: session.id, query: event.prompt });
    // Demand-driven promotion: another room wanted a local atom — the owner
    // decides, once, out of band. This is the ONLY approval touchpoint.
    for (const suggestion of res.suggestions) notify(promotionNotice(suggestion));
    if (res.items.length === 0) return { prependContext: EMPTY_RECALL };
    return {
      prependContext: `<aperture-memory>\n${res.items.map((i) => `[L${i.level}] ${i.text}`).join('\n')}\n</aperture-memory>`,
    };
  });

  // owner console: a native host command — the host routes it around the
  // model entirely, so the model never sees it and can never issue it.
  // One namespaced root ("/aperture ...") avoids reserved-name collisions.
  api.registerCommand({
    name: 'aperture',
    description: 'Aperture owner console: pending review, promotions, tier grants',
    acceptsArgs: true,
    handler: (ctx) => {
      const platform = ctx.channelId ?? ctx.channel;
      const res = handleOwnerCommand(
        { db, ledger, store, ownerId },
        { platform, senderExternalId: ctx.senderId ?? '', text: ctx.commandBody ?? '' },
      );
      // Non-owner senders: the console does not exist for them.
      return { text: res.handled ? res.reply : 'aperture: owner only' };
    },
  });

  // auto-capture: recording is unconditional and immediate; distillation is
  // adjudicated and DEBOUNCED — a session's turns buffer until the
  // conversation goes quiet, then the whole burst distills as one episode
  // (one coherent ladder instead of per-turn fragments). Everything runs
  // detached, so a slow local model can never time a turn out.
  //
  // Non-owner content lands room-local: immediately usable in its own room,
  // globally retrievable only after an owner-signed promotion. Writing is
  // silent by design — the owner is consulted on demand (see recall hook),
  // not on every message.
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE.quietMs;
  const buffer = new CaptureBuffer(
    { db, ledger, pipeline },
    ownerId,
    { ...DEFAULT_DEBOUNCE, quietMs: debounceMs },
  );

  api.on('agent_end', async (event, ctx) => {
    const content = transcriptOf(event.messages);
    if (!content) return;
    const platform = ctx.messageProvider ?? ctx.channel;
    // Conservative provenance: a channel turn belongs to its (possibly
    // unknown) sender. Only sender-less local runs are the owner's own.
    const externalId = ctx.senderId ?? ctx.channelId ?? ctx.chatId ?? 'unknown';
    const who = platform ? seeContact(platform, externalId) : ownerId;
    const channel = `${platform ?? 'openclaw'}:${ctx.channelId ?? ctx.chatId ?? ctx.sessionKey ?? 'unknown'}`;
    const session = platform
      ? sessionFor(db, {
          platform,
          channel: ctx.channelId ?? ctx.chatId ?? ctx.sessionKey ?? 'unknown',
          peerExternalIds: [externalId],
        })
      : undefined;
    const fragment = {
      content,
      subject: [who],
      topics,
      source: { who, channel, ts: Date.now() },
      acquisitionContext: channel,
      acquisitionAudience: session?.audience ?? [who],
    };
    if (debounceMs <= 0) {
      void capture({ db, ledger, pipeline }, fragment).catch((err) =>
        console.error('[aperture] capture failed:', err),
      );
      return;
    }
    buffer.add(session?.id ?? channel, fragment);
  });

  // egress: second line of defense over the finished outbound reply.
  api.on('message_sending', async (event, ctx) => {
    // Message hooks differ from agent hooks: ctx.channelId is the channel
    // plugin id ("telegram"), and event.to may be provider-prefixed
    // ("telegram:12345"). Observed live, 2026.6.9.
    const platform = ctx.channelId;
    const to = String(event.to ?? '');
    const peer = ctx.senderId ?? (to.startsWith(`${platform}:`) ? to.slice(platform.length + 1) : to);
    const audience = [resolveIdentity(db, platform, peer)];
    const res = await checkEgress(membrane, { audience, reply: event.content });
    if (res.verdict === 'pass') return;
    return { content: EGRESS_PLACEHOLDER };
  });

  api.registerTool(
    (toolCtx) => {
      const platform = toolCtx.messageChannel ?? 'openclaw';
      const peer = toolCtx.requesterSenderId;
      const channel = toolCtx.sessionKey ?? 'unknown';
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: undefined });

      return [
        {
          name: 'aperture_recall',
          label: 'Aperture recall',
          description: 'Search memories permitted for the people in this conversation.',
          parameters: Type.Object({ query: Type.String({ description: 'What to search for' }) }),
          execute: async (_id, params) => {
            const session = sessionFor(db, { platform, channel, peerExternalIds: peer ? [peer] : [] });
            const query = String((params as { query?: unknown }).query ?? '');
            const res = await retrieveForSession(membrane, { sessionId: session.id, query });
            return text(
              res.items.length === 0
                ? '(no permitted memories)'
                : res.items.map((i) => `[L${i.level}] ${i.text}`).join('\n'),
            );
          },
        },
        {
          name: 'aperture_store',
          label: 'Aperture store',
          description: 'Remember something from this conversation (non-owner content stays room-local until promoted).',
          parameters: Type.Object({ content: Type.String({ description: 'The episode to remember' }) }),
          execute: async (_id, params) => {
            const who = resolveIdentity(db, platform, peer ?? 'unknown');
            const session = sessionFor(db, { platform, channel, peerExternalIds: peer ? [peer] : [] });
            const result = await capture(
              { db, ledger, pipeline },
              {
                content: String((params as { content?: unknown }).content ?? ''),
                subject: [who],
                topics,
                source: { who, channel: `${platform}:${channel}`, ts: Date.now() },
                acquisitionContext: `${platform}:${channel}`,
                acquisitionAudience: session.audience,
              },
            );
            if ('gated' in result) return text(`not distilled (${result.gated})`);
            if (!result.ingest.ok) return text('rejected (entailment invariant)');
            if ('skipped' in result.ingest) return text(`skipped (${result.ingest.skipped})`);
            return text(result.ingest.atom.scope === 'local' ? 'stored (room-local until the owner promotes it)' : 'stored');
          },
        },
      ];
    },
    { names: ['aperture_recall', 'aperture_store'] },
  );
}

export interface EndpointConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dim?: number;
}

/**
 * OpenAI-compatible embedder from plugin config (env as fallback); degrades to
 * the deterministic hash stub when unset (retrieval still runs, just without
 * semantic quality).
 */
function makeEmbedder(cfg?: EndpointConfig): Embedder {
  const base = cfg?.baseUrl ?? process.env.APERTURE_EMBED_BASE_URL;
  const model = cfg?.model ?? process.env.APERTURE_EMBED_MODEL;
  const dim = cfg?.dim ?? Number(process.env.APERTURE_EMBED_DIM);
  if (!base || !model || !Number.isInteger(dim)) return hashEmbedder(64);
  return httpEmbedder({
    baseUrl: base,
    apiKey: cfg?.apiKey ?? process.env.APERTURE_EMBED_API_KEY ?? 'ollama',
    model,
    dim: dim as number,
  });
}

/** OpenAI-compatible distillation LLM from plugin config (env fallback); degrades to skip. */
function makeGenerator(cfg?: EndpointConfig): LayerGenerator {
  const base = cfg?.baseUrl ?? process.env.APERTURE_LLM_BASE_URL;
  const key = cfg?.apiKey ?? process.env.APERTURE_LLM_API_KEY;
  const model = cfg?.model ?? process.env.APERTURE_LLM_MODEL;
  if (!base || !key || !model) {
    return { generate: async () => ({ skip: true, reason: 'no-llm-configured' }) };
  }
  const client: LlmClient = {
    async completeJson(system, user) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        // Fail crisply instead of hanging on cold model loads (observed live:
        // undici HeadersTimeoutError). The raw episode is already ledgered as
        // ingress.received, so a failed distillation is replayable later.
        signal: AbortSignal.timeout(180_000),
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

// Mirrors openclaw.plugin.json (the manifest is the validation authority; this
// keeps the runtime entry's schema metadata from drifting to the empty default).
const ENDPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: { type: 'string' },
    apiKey: { type: 'string' },
    model: { type: 'string' },
    dim: { type: 'number' },
  },
};

// dbPath/ownerId are enforced at runtime in register(), not marked required in
// the schema: `plugins install` writes an empty entry then validates, so a
// required-config manifest would deadlock its own install.
const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dbPath: { type: 'string' },
    ownerId: { type: 'string' },
    ownerExternalIds: { type: 'object', additionalProperties: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    debounceMs: { type: 'number' },
    llm: ENDPOINT_SCHEMA,
    embed: ENDPOINT_SCHEMA,
  },
};

export default definePluginEntry({
  id: 'aperture',
  name: 'Aperture',
  description:
    'Disclosure-control memory: resolution-typed retrieval, room-scoped ingest, append-only disclosure ledger.',
  configSchema: () => buildJsonPluginConfigSchema(CONFIG_SCHEMA),
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as {
      dbPath?: string;
      ownerId?: string;
      ownerExternalIds?: Record<string, string>;
      topics?: string[];
      debounceMs?: number;
      llm?: EndpointConfig;
      embed?: EndpointConfig;
    };
    if (!cfg.dbPath || !cfg.ownerId) {
      throw new Error('aperture: pluginConfig.dbPath and pluginConfig.ownerId are required');
    }

    // Owner push: send to the owner's DM on the first configured platform via
    // the channel outbound adapter (the device-pair notification pattern).
    // api.runtime is a trusted-plugin surface — degrade to no pushes without it.
    const [ownerPlatform, ownerAddress] = Object.entries(cfg.ownerExternalIds ?? {})[0] ?? [];
    const notifyOwner =
      ownerPlatform && ownerAddress
        ? async (text: string) => {
            const runtime = (api as { runtime?: { channel?: { outbound?: { loadAdapter?: (id: string) => Promise<unknown> } } } }).runtime;
            const adapter = (await runtime?.channel?.outbound?.loadAdapter?.(ownerPlatform)) as
              | { sendText?: (ctx: { cfg: unknown; to: string; text: string }) => Promise<unknown> }
              | undefined;
            if (!adapter?.sendText) return;
            await adapter.sendText({ cfg: (api as { config?: unknown }).config, to: ownerAddress, text });
          }
        : undefined;

    registerAperture(api, {
      db: openDatabase(cfg.dbPath),
      ownerId: cfg.ownerId,
      ownerExternalIds: cfg.ownerExternalIds,
      generator: makeGenerator(cfg.llm),
      embedder: makeEmbedder(cfg.embed),
      topics: cfg.topics,
      debounceMs: cfg.debounceMs,
      notifyOwner,
    });
  },
});
