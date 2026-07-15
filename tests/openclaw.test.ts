import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EGRESS_PLACEHOLDER, registerAperture, type ApertureHostApi } from '../src/adapters/openclaw/index.js';
import type { MemoryAtom } from '../src/core/atom.js';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import type { LayerDraft, LayerGenerator } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';
import { resolveIdentity } from '../src/session/router.js';

const OWNER = 'person:owner';

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
  ],
  acquisitionAudience: [OWNER],
  scope: 'global',
};

const drafts: LayerDraft[] = [
  { level: 1, text: 'bob has news to share', entities: ['bob'] },
  { level: 2, text: 'bob is moving to shanghai', entities: ['bob', 'shanghai'] },
];

/**
 * Fake host implementing the real SDK registration surface: `api.on` collects
 * typed hook handlers, `api.registerTool` collects tools (expanding factories
 * with a runtime tool context, as the gateway does per run).
 */
function fakeHost() {
  const hooks = new Map<string, (event: never, ctx: never) => unknown>();
  const registered: unknown[] = [];
  const commands = new Map<string, (ctx: unknown) => unknown>();
  const api = {
    on: (name: string, handler: unknown) => hooks.set(name, handler as (event: never, ctx: never) => unknown),
    registerTool: (tool: unknown) => registered.push(tool),
    registerCommand: (def: { name: string; handler: (ctx: unknown) => unknown }) =>
      commands.set(def.name, def.handler),
  } as unknown as ApertureHostApi;

  const fire = async (name: string, event: unknown, ctx: unknown): Promise<unknown> =>
    hooks.get(name)!(event as never, ctx as never);

  const command = async (name: string, ctx: Record<string, unknown>): Promise<{ text?: string }> =>
    (await commands.get(name)!(ctx)) as { text?: string };

  const tools = (toolCtx: Record<string, unknown>) => {
    const map = new Map<
      string,
      { execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
    >();
    for (const entry of registered) {
      const made = typeof entry === 'function' ? entry(toolCtx) : entry;
      for (const tool of Array.isArray(made) ? made : [made]) {
        map.set((tool as { name: string }).name, tool as never);
      }
    }
    return map;
  };

  return { api, hooks, fire, command, tools };
}

async function makePlugin(opts?: {
  debounceMs?: number;
  generator?: LayerGenerator;
  topicTaxonomy?: string[];
  sensitiveTopics?: string[];
}) {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  const vectors = new VectorStore(db, hashEmbedder(32));
  const acl = new AclStore(db, ledger);

  store.insert(biliAtom);
  await vectors.index(biliAtom);

  const host = fakeHost();
  const ownerPushes: string[] = [];
  registerAperture(host.api, {
    db,
    ownerId: OWNER,
    ownerExternalIds: { telegram: 'owner_tg' },
    generator: opts?.generator ?? { generate: async () => structuredClone(drafts) },
    embedder: hashEmbedder(32),
    topics: ['activity'],
    topicTaxonomy: opts?.topicTaxonomy,
    sensitiveTopics: opts?.sensitiveTopics,
    // Tests exercise per-turn capture by default; the burst debounce has its
    // own dedicated test below (and core coverage in debounce.test.ts).
    debounceMs: opts?.debounceMs ?? 0,
    notifyOwner: (text) => {
      ownerPushes.push(text);
    },
  });

  // Mirrors the live bootstrap: the owner holds the finest resolution.
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: OWNER, resolution: 4 });
  // Bob exists once the router sees him; grant tier-1 on activity.
  const bob = resolveIdentity(db, 'telegram', 'bob_tg');
  acl.applyGrant({ object: 'topic:activity', relation: 'viewer', subject: bob, resolution: 1 });

  return { db, store, ledger, host, bob, ownerPushes };
}

/** Agent-hook context for a telegram DM turn from bob. */
const agentCtx = (over?: Record<string, unknown>) => ({
  messageProvider: 'telegram',
  channelId: 'dm:bob_tg',
  senderId: 'bob_tg',
  sessionKey: 'agent:main:telegram:dm:bob_tg',
  ...over,
});

describe('OpenClaw adapter (real hook contract)', () => {
  it('before_prompt_build injects only the layers the audience may see', async () => {
    const { host } = await makePlugin();
    const res = (await host.fire(
      'before_prompt_build',
      { prompt: 'what is he watching on his computer', messages: [] },
      agentCtx(),
    )) as { prependContext?: string } | undefined;

    expect(res?.prependContext).toContain('[L1] he is at his computer');
    expect(res?.prependContext).not.toContain('bilibili');
  });

  it('unknown audiences get the empty-recall envelope, never content (default deny)', async () => {
    const { host } = await makePlugin();
    const res = (await host.fire(
      'before_prompt_build',
      { prompt: 'what is he watching', messages: [] },
      agentCtx({ channelId: 'dm:mallory_tg', senderId: 'mallory_tg' }),
    )) as { prependContext?: string };
    // The model is told that it does not know — so it asks instead of inventing.
    expect(res.prependContext).toContain('no permitted memories');
    expect(res.prependContext).not.toContain('bilibili');
  });

  it('agent_end lands non-owner episodes room-local, with the room frozen on the atom', async () => {
    const { host, store, bob } = await makePlugin();
    await host.fire(
      'agent_end',
      {
        messages: [
          { role: 'user', content: 'i am moving to shanghai next tuesday, address 88 guangfu road' },
          { role: 'assistant', content: [{ type: 'text', text: 'congrats, noted!' }] },
        ],
        success: true,
      },
      agentCtx(),
    );
    await new Promise((r) => setTimeout(r, 0)); // detached capture settles

    const local = store.listLocal();
    expect(local).toHaveLength(1);
    expect(local[0]!.source.who).toBe(bob);
    expect(local[0]!.acquisitionAudience).toEqual([bob, OWNER].sort());
  });

  it('agent hooks fall back to the conversation id when senderId is absent (owner DM)', async () => {
    // Observed live: some runs omit ctx.senderId; for a DM the conversation
    // target id IS the peer, so the owner's own DM must resolve to the owner.
    const { host, store } = await makePlugin();
    await host.fire(
      'agent_end',
      {
        messages: [{ role: 'user', content: 'note to self: my new office is 500 howard street, floor 3' }],
        success: true,
      },
      agentCtx({ channelId: 'owner_tg', senderId: undefined }),
    );
    expect(store.listLocal()).toHaveLength(0);
    expect(store.listGlobal()).toHaveLength(2); // seeded atom + new owner atom

    const res = (await host.fire(
      'before_prompt_build',
      { prompt: 'what is he watching on his computer', messages: [] },
      agentCtx({ channelId: 'owner_tg', senderId: undefined }),
    )) as { prependContext?: string } | undefined;
    expect(res?.prependContext).toContain('bilibili'); // owner sees the finest layer
  });

  it('agent_end lands owner-sent episodes global directly', async () => {
    const { host, store } = await makePlugin();
    await host.fire(
      'agent_end',
      {
        messages: [{ role: 'user', content: 'reminder to self: annual checkup booked for september 3rd' }],
        success: true,
      },
      agentCtx({ channelId: 'dm:owner_tg', senderId: 'owner_tg' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(store.listLocal()).toHaveLength(0);
    expect(store.listGlobal()).toHaveLength(2); // seeded atom + new owner atom
  });

  it('message_sending rewrites a leaky reply to the safe placeholder', async () => {
    const { host } = await makePlugin();
    const res = (await host.fire(
      'message_sending',
      { to: 'bob_tg', content: 'he is watching bilibili right now' },
      { channelId: 'telegram', senderId: 'bob_tg' },
    )) as { content?: string; cancel?: boolean } | undefined;

    expect(res?.content).toBe(EGRESS_PLACEHOLDER);
    expect(res?.content).not.toContain('bilibili');
  });

  it('message_sending resolves a provider-prefixed event.to when senderId is absent', async () => {
    // Observed live: outbound ctx.channelId is the plugin id ("telegram") and
    // event.to arrives prefixed ("telegram:bob_tg"); senderId may be omitted.
    const { host } = await makePlugin();
    const res = (await host.fire(
      'message_sending',
      { to: 'telegram:bob_tg', content: 'he is watching bilibili right now' },
      { channelId: 'telegram' },
    )) as { content?: string } | undefined;
    expect(res?.content).toBe(EGRESS_PLACEHOLDER);
  });

  it('message_sending passes clean replies untouched', async () => {
    const { host } = await makePlugin();
    const res = await host.fire(
      'message_sending',
      { to: 'bob_tg', content: 'sure, sounds good, see you tomorrow' },
      { channelId: 'telegram', senderId: 'bob_tg' },
    );
    expect(res).toBeUndefined();
  });

  it('demand-driven promotion: writing is silent; another room asking triggers ONE suggestion push', async () => {
    const { host, store, ownerPushes } = await makePlugin();

    // Bob's turn lands room-local — and no push happens at write time.
    await host.fire(
      'agent_end',
      {
        messages: [{ role: 'user', content: 'i am moving to shanghai next tuesday, address 88 guangfu road' }],
        success: true,
      },
      agentCtx(),
    );
    await new Promise((r) => setTimeout(r, 0)); // detached capture settles
    expect(store.listLocal()).toHaveLength(1);
    expect(ownerPushes.filter((t) => t.includes('/aperture promote'))).toHaveLength(0);

    // Bob's own room can use it immediately — no approval, full resolution.
    const bobRoom = (await host.fire(
      'before_prompt_build',
      { prompt: 'bob moving news shanghai', messages: [] },
      agentCtx(),
    )) as { prependContext?: string };
    expect(bobRoom.prependContext).toContain('shanghai');

    // Alice's room asks about it → scope blocks it → the owner gets the suggestion.
    await host.fire(
      'before_prompt_build',
      { prompt: 'bob moving news shanghai', messages: [] },
      agentCtx({ channelId: 'dm:alice_tg', senderId: 'alice_tg' }),
    );
    const notice = ownerPushes.find((t) => t.includes('/aperture promote'));
    expect(notice).toBeDefined();
    expect(notice).not.toContain('shanghai'); // coarsest layer only

    // The owner taps the pushed command; the host routes it around the model.
    const promoteCmd = notice!.match(/\/aperture promote [0-9a-f]+/)![0];
    const res = await host.command('aperture', {
      channelId: 'telegram',
      senderId: 'owner_tg',
      commandBody: promoteCmd,
    });
    expect(res.text).toContain('promoted');
    expect(store.listLocal()).toHaveLength(0);
    expect(store.listGlobal().map((a) => a.id)).toContain(store.listGlobal()[1]?.id);
  });

  it('the /aperture command refuses everyone but the owner', async () => {
    const { host, store } = await makePlugin();
    store.insert({ ...biliAtom, id: 'q1', scope: 'local' });

    const res = await host.command('aperture', {
      channelId: 'telegram',
      senderId: 'bob_tg',
      commandBody: '/aperture pending',
    });
    expect(res.text).toBe('aperture: owner only');
    expect(store.listLocal()).toHaveLength(1);
  });

  it('with debounce on, a burst of turns distills into one atom after the quiet gap', async () => {
    const { host, store } = await makePlugin({ debounceMs: 40 });
    const turn = (text: string) => ({ messages: [{ role: 'user', content: text }], success: true });

    await host.fire('agent_end', turn('bob: I have been apartment hunting'), agentCtx());
    await host.fire('agent_end', turn('bob: settled on 88 guangfu road, moving next month'), agentCtx());
    expect(store.listLocal()).toHaveLength(0); // nothing distilled mid-burst

    await new Promise((r) => setTimeout(r, 120)); // quiet gap elapses
    const local = store.listLocal();
    expect(local).toHaveLength(1); // ONE coherent atom for the whole burst
  });

  it('sensitive-topic confirmation: withheld, pushed once, and the pushed allow command opens it', async () => {
    const { host, ownerPushes } = await makePlugin({ sensitiveTopics: ['activity'] });
    const ask = () =>
      host.fire(
        'before_prompt_build',
        { prompt: 'what is he watching on his computer', messages: [] },
        agentCtx(),
      ) as Promise<{ prependContext?: string }>;

    // Bob is ReBAC-cleared for L1, but the topic is sensitive: nothing enters.
    const first = await ask();
    expect(first.prependContext).toContain('no permitted memories');
    const notice = ownerPushes.find((t) => t.includes('/aperture allow'));
    expect(notice).toContain('activity');

    // Asking again re-pushes nothing (scope.requested is the dedupe record).
    await ask();
    expect(ownerPushes.filter((t) => t.includes('/aperture allow'))).toHaveLength(1);

    // The owner taps the pushed command; the next question flows at bob's ceiling.
    const allowCmd = notice!.match(/\/aperture allow \S+ \S+/)![0];
    const res = await host.command('aperture', {
      channelId: 'telegram',
      senderId: 'owner_tg',
      commandBody: allowCmd,
    });
    expect(res.text).toContain('activity');
    const after = await ask();
    expect(after.prependContext).toContain('[L1] he is at his computer');
    expect(after.prependContext).not.toContain('bilibili');
  });

  it('a distilled topic outside the taxonomy is announced to the owner exactly once', async () => {
    const { host, ledger, ownerPushes } = await makePlugin({
      topicTaxonomy: ['work', 'health'],
      generator: { generate: async () => ({ layers: structuredClone(drafts), topics: ['work/gamma'] }) },
    });
    const turn = (text: string) => ({ messages: [{ role: 'user', content: text }], success: true });

    await host.fire('agent_end', turn('bob: the gamma project kickoff is next monday'), agentCtx());
    await new Promise((r) => setTimeout(r, 0));
    expect(ownerPushes.filter((t) => t.includes('new topic') && t.includes('work/gamma'))).toHaveLength(1);

    // Second atom with the same new topic: the ledger event is the dedupe record.
    await host.fire('agent_end', turn('bob: gamma budget review moved to friday afternoon'), agentCtx());
    await new Promise((r) => setTimeout(r, 0));
    expect(ownerPushes.filter((t) => t.includes('work/gamma'))).toHaveLength(1);
    expect([...ledger.events()].filter((e) => e.type === 'topic.discovered')).toHaveLength(1);
  });

  it('a first-time sender triggers exactly one new-contact push, in the live hook order', async () => {
    const { host, ownerPushes } = await makePlugin();
    const ctx = agentCtx({ channelId: 'dm:dora_tg', senderId: 'dora_tg' });
    const turn = {
      messages: [{ role: 'user', content: 'hey there, this is dora, we met at the conference' }],
      success: true,
    };
    // Live order: recall resolves the identity BEFORE capture ever sees it —
    // the first-sight push must fire from whichever hook runs first.
    await host.fire('before_prompt_build', { prompt: 'hey there', messages: [] }, ctx);
    await host.fire('agent_end', turn, ctx);
    await host.fire('before_prompt_build', { prompt: 'hey again', messages: [] }, ctx);
    await new Promise((r) => setTimeout(r, 0));

    const contactPushes = ownerPushes.filter((t) => t.includes('new contact') && t.includes('dora_tg'));
    expect(contactPushes).toHaveLength(1);
  });

  it('the recall tool goes through the same adjudication as the hook', async () => {
    const { host } = await makePlugin();
    const tools = host.tools({
      messageChannel: 'telegram',
      requesterSenderId: 'bob_tg',
      sessionKey: 'dm:bob_tg',
    });
    const res = await tools.get('aperture_recall')!.execute('call-1', { query: 'watching computer video' });
    const text = res.content[0]!.text;
    expect(text).toContain('[L1]');
    expect(text).not.toContain('bilibili');
  });

  it('the store tool lands peer-attributed content room-local', async () => {
    const { host, store } = await makePlugin();
    const tools = host.tools({
      messageChannel: 'telegram',
      requesterSenderId: 'bob_tg',
      sessionKey: 'dm:bob_tg',
    });
    const res = await tools.get('aperture_store')!.execute('call-2', {
      content: 'bob says he is moving to shanghai, 88 guangfu road',
    });
    expect(res.content[0]!.text).toContain('room-local');
    expect(store.listLocal()).toHaveLength(1);
  });
});
