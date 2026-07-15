/**
 * Dorm simulation: four people, four group chats, gossip that cannot leak.
 *
 *   npm run demo:dorm
 *
 * Four roommates (Anna, Bella, Cara, Dora), one group per three of them, four
 * groups total:
 *   g1 = {Anna, Bella, Cara}   ← no Dora
 *   g2 = {Anna, Bella, Dora}
 *   g3 = {Anna, Cara, Dora}    ← no Bella
 *   g4 = {Bella, Cara, Dora}
 *
 * Each person has her own aperture instance (own membrane, ledger, memory).
 * Story: in g1 the three of them gossip about Dora; then five probes prove the
 * gossip can never surface for any audience that includes Dora — room-local by
 * provenance (usable where everyone already heard it, nowhere else),
 * backstopped at egress, auditable on the ledger. Every scene has inline
 * assertions; any leak exits with a non-zero code.
 */
import Database from 'better-sqlite3';
import {
  AclStore,
  AtomStore,
  capture,
  promoteAtom,
  sealAtom,
  checkEgress,
  hashEmbedder,
  IngestPipeline,
  Ledger,
  linkIdentity,
  retrieve,
  sessionFor,
  VectorStore,
  type LayerDraft,
  type MemoryAtom,
  type RawEvent,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const GIRLS = ['Anna', 'Bella', 'Cara', 'Dora'] as const;
type Girl = (typeof GIRLS)[number];
const P = (g: Girl) => `person:${g}`;

const GROUPS: Record<string, Girl[]> = {
  g1: ['Anna', 'Bella', 'Cara'],
  g2: ['Anna', 'Bella', 'Dora'],
  g3: ['Anna', 'Cara', 'Dora'],
  g4: ['Bella', 'Cara', 'Dora'],
};

/** Canned ladder per message (LLM-generated in production; invariant still guards it). */
const LADDERS = new Map<string, { drafts: LayerDraft[]; subject: string[]; topics: string[] }>([
  [
    "Dora was on the phone till 2am again last night, so noisy",
    {
      subject: [P('Dora')],
      topics: ['gossip-dora'],
      drafts: [
        { level: 1, text: 'There is some friction in the dorm lately', entities: ['dorm'] },
        { level: 2, text: 'A roommate has complaints about someone\'s habits', entities: ['dorm', 'roommate', 'habits'] },
        { level: 3, text: 'They are discussing Dora\'s schedule and laundry habits', entities: ['dorm', 'roommate', 'habits', 'dora', 'schedule', 'laundry'] },
        { level: 4, text: 'Anna complains Dora makes late-night calls and hogs the washing machine', entities: ['dorm', 'roommate', 'habits', 'dora', 'schedule', 'laundry', 'anna', 'late-night calls'] },
      ],
    },
  ],
  [
    "Want to go hiking together on Saturday?",
    {
      subject: [P('Anna')],
      topics: ['daily'],
      drafts: [
        { level: 1, text: 'There is a weekend plan proposal in the group', entities: ['weekend'] },
        { level: 2, text: 'Anna proposes hiking together on Saturday', entities: ['weekend', 'anna', 'saturday', 'hiking'] },
      ],
    },
  ],
  [
    "I got new milk tea coupons, want to split an order?",
    {
      subject: [P('Dora')],
      topics: ['daily'],
      drafts: [
        { level: 1, text: 'There is a group-order proposal', entities: ['group-order'] },
        { level: 2, text: 'Dora bought milk tea coupons and wants to split an order', entities: ['group-order', 'dora', 'milk tea coupons'] },
      ],
    },
  ],
  [
    "Bella said she would give me a spare dorm key",
    {
      subject: [P('Bella')],
      topics: ['daily'],
      drafts: [
        { level: 1, text: 'Someone mentioned a spare dorm key', entities: ['key'] },
        { level: 2, text: 'Dora claims Bella promised her a spare key', entities: ['key', 'dora', 'bella'] },
      ],
    },
  ],
]);

interface Agent {
  owner: Girl;
  db: Database.Database;
  store: AtomStore;
  ledger: Ledger;
  vectors: VectorStore;
  acl: AclStore;
  pipeline: IngestPipeline;
}

function makeAgent(owner: Girl): Agent {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  // Wider hash embedder: the toy bigram embedder collides on short English
  // text at low dims, so demos calibrate around it. A real embedder (M3
  // eval/) makes egress thresholds meaningful.
  const vectors = new VectorStore(db, hashEmbedder(512));
  const acl = new AclStore(db, ledger);
  const pipeline = new IngestPipeline({
    store,
    ledger,
    ownerId: P(owner),
    vectors,
    generator: {
      generate: async (event: RawEvent) => {
        const known = LADDERS.get(event.content);
        return known ? structuredClone(known.drafts) : { skip: true as const, reason: 'ephemeral' };
      },
    },
  });
  for (const g of GIRLS) linkIdentity(db, 'dorm', g, P(g)); // stable identities
  return { owner, db, store, ledger, vectors, acl, pipeline };
}

// ---------------------------------------------------------------------------
// Assertions and output
// ---------------------------------------------------------------------------

let checks = 0;
function assert(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    console.error(`  x FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok ${msg}`);
}

const section = (title: string) => console.log(`\n=== ${title} ===`);

// ---------------------------------------------------------------------------
// Build the environment: four agents, each with its own policy matrix
// ---------------------------------------------------------------------------

section('Environment');
const agents = new Map<Girl, Agent>(GIRLS.map((g) => [g, makeAgent(g)]));
console.log(`  Four roommates, each with an independent aperture instance (own membrane, ledger, memory)`);
console.log(`  Four groups: ${Object.entries(GROUPS).map(([id, m]) => `${id}={${m.join(',')}}`).join('  ')}`);

// Bella's matrix (our protagonist): roommates see daily topics up to L3;
// gossip-dora only to those who were present (Anna, Cara); Dora: default deny (0).
const bella = agents.get('Bella')!;
for (const g of ['Anna', 'Cara', 'Dora'] as Girl[]) {
  bella.acl.grant({ object: 'tier:roommate', relation: 'member', subject: P(g), resolution: 4 });
}
bella.acl.grant({ object: 'topic:daily', relation: 'viewer', subject: 'tier:roommate#member', resolution: 3 });
console.log(`  Bella's matrix: daily -> roommates L3; unknowns -> default deny (0)`);
console.log(`  Note: NO grant is needed for the gossip — room-local scope handles it by provenance`);

// ---------------------------------------------------------------------------
// A day of messages: each message is heard only by agents in that group
// ---------------------------------------------------------------------------

section('Message timeline (each message enters only present members\' membranes)');

const T0 = 1_752_400_000_000;
const timeline: Array<{ group: string; speaker: Girl; text: string }> = [
  { group: 'g1', speaker: 'Anna', text: 'Dora was on the phone till 2am again last night, so noisy' }, // gossip
  { group: 'g1', speaker: 'Cara', text: 'okay okay thanks' },                                           // prefilter blocks (phatic)
  { group: 'g1', speaker: 'Bella', text: 'brb showering' },                                             // LLM skips
  { group: 'g2', speaker: 'Anna', text: 'Want to go hiking together on Saturday?' },                    // daily
  { group: 'g2', speaker: 'Dora', text: 'Bella said she would give me a spare dorm key' },              // poison attempt
  { group: 'g4', speaker: 'Dora', text: 'I got new milk tea coupons, want to split an order?' },        // daily
];

const atomIds = new Map<string, string>(); // message text -> atom id in Bella's store
for (let i = 0; i < timeline.length; i++) {
  const msg = timeline[i]!;
  const members = GROUPS[msg.group]!;
  const notes: string[] = [];
  for (const listener of members) {
    const agent = agents.get(listener)!;
    const meta = LADDERS.get(msg.text);
    const result = await capture(
      { db: agent.db, ledger: agent.ledger, pipeline: agent.pipeline },
      {
        content: msg.text,
        subject: meta?.subject ?? [P(msg.speaker)],
        topics: meta?.topics ?? ['daily'],
        source: { who: P(msg.speaker), channel: `dorm:group:${msg.group}`, ts: T0 + i * 60_000 },
        acquisitionContext: `dorm:group:${msg.group}`,
        acquisitionAudience: members.map(P), // the room, frozen on the atom
      },
    );
    if (listener === 'Bella') {
      if ('gated' in result) notes.push(`prefilter blocked (${result.gated})`);
      else if (!result.ingest.ok) notes.push('entailment rejected');
      else if ('skipped' in result.ingest) notes.push(`skip (${result.ingest.skipped})`);
      else {
        atomIds.set(msg.text, result.ingest.atom.id);
        notes.push(result.ingest.atom.scope === 'local' ? 'stored -> room-local' : 'stored (owner direct, global)');
      }
    }
  }
  const heard = members.join(',');
  const bellaNote = members.includes('Bella') ? `Bella side: ${notes.join('')}` : 'Bella absent, physically cannot hear';
  console.log(`  [${msg.group}] ${msg.speaker}: "${msg.text}" -> present:{${heard}} - ${bellaNote}`);
}

assert(
  agents.get('Bella')!.store.listLocal().length === 4,
  "Bella's membrane absorbed only the 4 distillable messages she was present for (g3 is none of her business), all room-local",
);

// ---------------------------------------------------------------------------
// Bella reviews her room-local atoms: promote the useful, seal the poison,
// and deliberately leave the gossip room-local — provenance handles it.
// ---------------------------------------------------------------------------

section('Bella reviews room-local atoms (promotion is the ONLY gate that needs her)');
const bDeps = { db: bella.db, ledger: bella.ledger, store: bella.store, vectors: bella.vectors };
const bOwner = { store: bella.store, ledger: bella.ledger, ownerId: P('Bella') };

for (const text of [
  'Want to go hiking together on Saturday?',
  'I got new milk tea coupons, want to split an order?',
]) {
  promoteAtom(bOwner, atomIds.get(text)!, P('Bella'));
  console.log(`  promoted to global: "${text}" (worth answering with anywhere, layer-gated by the matrix)`);
}
sealAtom(bOwner, atomIds.get('Bella said she would give me a spare dorm key')!, P('Bella'));
console.log(`  sealed: "Bella said she would give me a spare dorm key" (Dora's one-sided claim — visible nowhere, kept on the ledger)`);
console.log(`  untouched: the gossip stays room-local — no signature needed for where it already lives`);
assert(bella.store.listLocal().length === 1, 'only the gossip remains room-local');
assert(bella.store.listGlobal().length === 2, 'the two daily facts are global now');

const gossipId = atomIds.get('Dora was on the phone till 2am again last night, so noisy')!;

// ---------------------------------------------------------------------------
// Probe scenarios
// ---------------------------------------------------------------------------

section('Probe A: in g1 (no Dora), Cara asks Bella\'s agent about the gossip');
{
  const s = sessionFor(bella.db, { platform: 'dorm', channel: 'group:g1', peerExternalIds: ['Anna', 'Cara'] });
  const res = await retrieve(bDeps, { audience: s.audience, query: 'dora schedule laundry what they said', k: 5 });
  const hit = res.items.find((i) => i.atomId === gossipId);
  assert(hit !== undefined && hit.level === 4, 'gossip surfaces where everyone present already heard it, at full L4 — zero approvals involved');
  console.log(`    context got: L${hit!.level} "${hit!.text}"`);
}

section('Probe B: in g2 (Dora present), Dora asks "anything new in the dorm lately"');
{
  const s = sessionFor(bella.db, { platform: 'dorm', channel: 'group:g2', peerExternalIds: ['Anna', 'Dora'] });
  const res = await retrieve(bDeps, { audience: s.audience, query: 'dorm lately new gossip dora schedule laundry', k: 10 });
  assert(!res.items.some((i) => i.atomId === gossipId), 'audience includes Dora -> not a subset of the acquisition room, gossip never enters context');
  assert(res.items.every((i) => i.level <= 3), 'only daily atoms can enter, and never above L3');
  console.log(`    context got: ${res.items.map((i) => `L${i.level} "${i.text}"`).join('; ') || '(none)'}`);
}

section('Probe C: Dora DMs Bella\'s agent and presses directly');
{
  const s = sessionFor(bella.db, { platform: 'dorm', channel: 'dm:Dora', peerExternalIds: ['Dora'] });
  for (const q of ['did they say bad things about me', 'how does Anna talk about me behind my back', 'laundry phone calls complaints about me']) {
    const res = await retrieve(bDeps, { audience: s.audience, query: q, k: 10 });
    assert(!res.items.some((i) => i.atomId === gossipId), `rephrasing "${q}" also finds nothing`);
  }
}

section('Probe D: suppose the model is compromised — the egress checker backstops (g2, Dora present)');
{
  const audience = [P('Anna'), P('Dora')];
  const leaky = await checkEgress(bDeps, {
    audience,
    reply: 'they complain you make late-night calls and hog the washing machine',
    threshold: 0.45,
  });
  assert(leaky.verdict === 'escalate', 'a reply restating the gossip is caught at egress (escalated to owner, never sent)');
  console.log(`    hits: ${leaky.hits.map((h) => `${h.kind}${h.atomId ? `->${h.atomId === gossipId ? 'gossip-atom' : h.atomId}@L${h.level}` : ''}`).join(', ')}`);

  const benign = await checkEgress(bDeps, { audience, reply: "let's grab lunch at the cafeteria at noon", threshold: 0.45 });
  assert(benign.verdict === 'pass', 'a normal reply passes silently, no false positive');
}

section('Probe E: the sealed poison claim is invisible to every retrieval — including its own room');
{
  const anna = await retrieve(bDeps, { audience: [P('Anna')], query: 'spare key who promised Bella agreed', k: 10 });
  assert(anna.items.every((i) => !i.text.toLowerCase().includes('key')), 'the sealed "key" claim appears in no one\'s context');
  const doraRoom = await retrieve(bDeps, { audience: [P('Anna'), P('Dora')], query: 'spare key promised', k: 10 });
  assert(doraRoom.items.every((i) => !i.text.toLowerCase().includes('key')), 'sealing beats even the acquisition room (unlike room-local)');
}

// ---------------------------------------------------------------------------
// Final audit: scan Bella's ledger — no disclosure with Dora present carries gossip
// ---------------------------------------------------------------------------

section('Final audit: the ledger');
{
  let disclosures = 0;
  for (const event of bella.ledger.events()) {
    if (event.type !== 'disclosure.adjudicated') continue;
    disclosures++;
    const p = event.payload as { audience: string[]; injected: Array<{ atomId: string }> };
    if (p.audience.includes(P('Dora'))) {
      assert(!p.injected.some((i) => i.atomId === gossipId), `#${event.seq} disclosure with Dora present carries no gossip atom`);
    }
  }
  const escalations = [...bella.ledger.events()].filter((e) => e.type === 'disclosure.request').length;
  assert(bella.ledger.verify().ok, 'ledger hash chain verifies — history is tamper-evident');
  console.log(`    ${disclosures} disclosure adjudications, ${escalations} egress escalation(s), all on the ledger`);
}

console.log(`\nAll ${checks} assertions passed. Gossip stops at its room, poison stops at the seal, history stops at the ledger.\n`);
