/**
 * Hero demo: one memory, two viewers, two resolutions.
 *
 *   npm run demo
 *
 * Seeds the owner's "watching Bilibili" atom (4 layers), grants friend-tier
 * L3 and stranger-tier L1 on the activity topic, then asks the same question
 * as Alice (friend) and Bob (stranger).
 */
import Database from 'better-sqlite3';
import { hashEmbedder, VectorStore } from '../src/core/embed.js';
import { IngestPipeline, type LayerGenerator } from '../src/core/ingest.js';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { retrieve } from '../src/core/retrieve.js';
import { AtomStore } from '../src/core/store.js';

const db = new Database(':memory:');
const store = new AtomStore(db);
const ledger = new Ledger(db);
const vectors = new VectorStore(db, hashEmbedder(64));
const acl = new AclStore(db, ledger);

// A canned generator standing in for the LLM (M3 wires the real one).
const generator: LayerGenerator = {
  generate: async () => [
    { level: 1, text: "He's at his computer", entities: ['computer'] },
    { level: 2, text: "He's watching a video", entities: ['computer', 'video'] },
    { level: 3, text: "He's watching Bilibili", entities: ['computer', 'video', 'bilibili'] },
    { level: 4, text: "He's watching \"Rust async explained\" on Bilibili", entities: ['computer', 'video', 'bilibili', 'rust async explained'] },
  ],
};

const pipeline = new IngestPipeline({ store, ledger, ownerId: 'person:owner', generator, vectors });

await pipeline.ingest({
  content: 'screen capture: bilibili video',
  subject: ['person:owner'],
  topics: ['activity'],
  source: { who: 'person:owner', channel: 'screen:capture', ts: Date.now() },
  acquisitionContext: 'private',
});

// The policy matrix is just tuples.
acl.grant({ object: 'topic:activity', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
acl.grant({ object: 'topic:activity', relation: 'viewer', subject: 'tier:stranger#member', resolution: 1 });
acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:alice', resolution: 4 });
acl.grant({ object: 'tier:stranger', relation: 'member', subject: 'person:bob', resolution: 4 });

const question = "What's he up to? What's he watching?";
const deps = { db, ledger, store, vectors };

const alice = await retrieve(deps, { audience: ['person:alice'], query: question });
const bob = await retrieve(deps, { audience: ['person:bob'], query: question });
const mallory = await retrieve(deps, { audience: ['person:mallory'], query: question });

console.log(`Same question, three askers: "${question}"\n`);
console.log(`Alice   (friend,   tier-3) context gets:  L${alice.items[0]?.level} "${alice.items[0]?.text}"`);
console.log(`Bob     (stranger, tier-1) context gets:  L${bob.items[0]?.level} "${bob.items[0]?.text}"`);
console.log(`Mallory (unknown)          context gets:  ${mallory.items.length === 0 ? '(empty — default deny)' : 'ERROR!'}`);

const adjudications = [...ledger.events()].filter((e) => e.type === 'disclosure.adjudicated');
console.log(`\nLedger: ${[...ledger.events()].length} events (${adjudications.length} disclosure adjudications), hash chain ${ledger.verify().ok ? 'OK' : 'BROKEN'}`);

// The demo doubles as an integration check.
if (alice.items[0]?.level !== 3 || bob.items[0]?.level !== 1 || mallory.items.length !== 0) {
  throw new Error('hero demo invariant violated');
}
