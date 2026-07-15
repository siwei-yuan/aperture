# Aperture

**Disclosure control for personal AI agents.** Your agent remembers everything about you — and now anyone can message it. Aperture decides *who gets to know what*, structurally, before the model ever sees the question.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![Tests](https://img.shields.io/badge/tests-105%20passing-brightgreen)

```text
$ npm run demo

Same question, three askers: "What's he up to? What's he watching?"

Alice   (friend,   tier-3) context gets:  L3 "He's watching Bilibili"
Bob     (stranger, tier-1) context gets:  L1 "He's at his computer"
Mallory (unknown)          context gets:  (empty — default deny)

Ledger: 8 events (3 disclosure adjudications), hash chain OK
```

*Same question, three askers, three different answers — decided by a deterministic
authorization check, not by asking the model to be discreet. (Real captured output.)*

## Why this exists

Agent harnesses like [OpenClaw](https://openclaw.ai) connect your assistant to WhatsApp,
Telegram, and Discord — and their pairing flows exist precisely so **other people** can
talk to it: family, friends, teammates. But once someone is paired in, today's harnesses
give every contact **the same memory and the same brain**. Per-person knowledge control
is an openly acknowledged gap.

Telling the model to "be discreet with strangers" is not a boundary. Anything in the
context window can be extracted by a determined interlocutor; a visible refusal is itself
a leak ("so there *is* something to hide"); and an attacker gets unlimited retries against
a probabilistic judge. A guard that must win every time loses to an attacker who needs to
win once.

Aperture is a **peripheral harness** wrapping any agent's memory read/write path with one
idea:

> **Authorization returns a resolution, not a boolean.**

Instead of allow/deny, every access check answers *which level of detail* this person may
see — so the agent can always say something true, just at the right resolution.

## The four-layer ladder

Every ingested event is distilled — once, at write time — into a generalization ladder:

| Layer | Anchor | Example |
| --- | --- | --- |
| **L1** | state | "He's at his computer" |
| **L2** | category | "He's watching a video" |
| **L3** | context | "He's watching Bilibili" |
| **L4** | detail | "He's watching *Rust async explained* on Bilibili" |

Your relationship graph (ReBAC) and the conversation's task scope decide the **maximum
layer** each audience may retrieve; a group chat is capped by its weakest-privileged
member. Because every layer is true and self-contained, answering coarsely is
indistinguishable from simply not knowing more — graceful deflection is the mechanism's
natural output, not a prompt trick.

## Life of a memory

Two flows, two directions through the same membrane: **writing** (a message becomes
memory) and **reading** (someone asks, and gets exactly their resolution).

### Writing: a message becomes memory

Every turn is captured automatically after it completes (`agent_end` hook, detached —
a slow distillation never blocks a reply). The agent's explicit `aperture_store` tool
goes through the same single entrance; there is no second door.

```text
 You (Telegram) ─► "I'm moving to Shanghai next Tuesday, 88 Guangfu Road"
      │
      ▼
 ①  RECORD — unconditional                       ledger: ingress.received
      every episode lands on the ledger first, even ones that are
      gated next — the tape anchor for later replay
      │
      ▼
 ②  GATES — deterministic, zero model calls
      G1a length   emoji-only / too short dies here
      G1b phatic   "在吗?" / "ok thanks" dies here
      G1c dedup    simhash near-duplicate of a recent episode
      G1d rate     per-source hourly cap (anti-flooding)
      G1e channel  cron / healthcheck noise excluded
      │
      ▼
 ③  DISTILL — one LLM call                       (the only model in the write path)
      draft the L1..L4 generalization ladder, or decide the
      content isn't worth remembering ({"skip": "filler"})
      │
      ▼
 ④  VALIDATE — the model is never trusted        validateLadder()
      entailment invariant: a coarser layer may never introduce
      entities absent from the finer layer below it
      violations are fed back ─► up to 2 repair retries
      still failing ─► ledger: atom.rejected (nothing stored)
      │
      ▼
 ⑤  PROVENANCE — who said this, and in which room?
      you (owner)      ─► global immediately (retrievable everywhere,
                          layer-gated by your matrix)
      anyone else      ─► room-local: instantly usable in the room it was
                          said in (everyone there heard it anyway — no
                          approval needed), but it NEVER silently merges
                          into the globally retrievable profile
      │
      ▼
 ⑥  PERSIST                                      ledger: atom.ingested
      atom + full ladder appended to the ledger;
      each layer embedded and indexed separately
```

### Reading: someone asks about you

```text
 Bob (Telegram) ─► "hey, what's he been up to?"
      │
      ▼
 ①  RECALL (before the model runs)               hook: before_prompt_build
      resolve identity: platform id ─► person node (unknown ids
        become fresh person nodes with resolution 0 — deny by default)
      session = this conversation's audience (group = every member)
      ceiling = min over audience of ReBAC check (max over the atom's
        topics, widest-path over tiers, attenuated by min along the path)
        × the session's task scope
      per-layer exact vector search — ONLY inside the permitted partition
      top-k permitted layers injected as <aperture-memory> context
      ledger: disclosure.adjudicated (what was shown, to whom, why)
      │
      ▼
 ②  the model answers — its context never contained a layer
      Bob wasn't cleared for, so it cannot leak what it never saw
      │
      ▼
 ③  EGRESS (before the reply is delivered)       hook: message_sending
      PII scan + per-sentence similarity vs the BLOCKED complement
        (every layer finer than Bob's ceiling)
      hit ⇒ reply replaced with a safe placeholder, and a
        disclosure.request lands on the ledger for the owner to review
      │
      ▼
 ④  and the turn itself is captured — Bob's words go back through the
      write path above and land room-local to his conversation
```

### Promotion: the only approval, and it is demand-driven

Room-local memory leaves its room exactly one way: an owner-signed
promotion. You are never interrupted at write time. When some OTHER
conversation's retrieval would have used a room-local atom, the atom is
suggested to you once (`promotion.suggested` on the ledger), with its
coarsest layer only:

```text
another conversation wanted a room-local memory:
"bob has news to share"
/aperture promote 8195139e · /aperture seal 8195139e · ignoring keeps it room-local
```

Promote it (global, layer-gated by your matrix), seal it (visible nowhere —
how you reject poison someone tried to plant about you), or ignore it
(stays room-local forever). Approval collapses from "every message" to
"only the facts other rooms actually ask about".

Every step in both flows is an event on one append-only, hash-chained ledger. The atom
store, ACL tuples, vector index, and knowledge graph are *projections* — deletable and
rebuildable by replay (`rebuildProjections`). "Who learned what about me, and when?"
is a query, not an archaeology project.

## Install into OpenClaw

The adapter binds to the real OpenClaw plugin SDK (2026.6.9+) and has been validated
against a live gateway with real Telegram traffic.

```bash
git clone https://github.com/siwei-yuan/aperture ~/Projects/aperture
cd ~/Projects/aperture && npm install
```

Add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    slots: { memory: "aperture" },          // aperture owns the memory slot
    load: { paths: ["~/Projects/aperture"] },
    entries: {
      aperture: {
        enabled: true,
        config: {
          dbPath: "~/.aperture/aperture.db",
          ownerId: "person:owner",
          // your own platform ids, so YOUR messages land global, not room-local:
          ownerExternalIds: { telegram: "123456789" },
          // distillation LLM — any OpenAI-compatible endpoint:
          llm:   { baseUrl: "https://api.openai.com/v1", apiKey: "sk-...", model: "gpt-5-mini" },
          // embeddings — any OpenAI-compatible endpoint (local works great):
          embed: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", model: "nomic-embed-text", dim: 768 }
        }
      }
    }
  }
}
```

Restart the gateway (`openclaw gateway restart`), then grant your contacts a resolution:

```bash
# owner sees everything; friends get L3; strangers get L1
npx tsx bin/aperture.ts --db ~/.aperture/aperture.db grant topic:general viewer person:owner 4
npx tsx bin/aperture.ts --db ~/.aperture/aperture.db grant topic:general viewer tier:friend#member 3
npx tsx bin/aperture.ts --db ~/.aperture/aperture.db grant topic:general viewer tier:stranger#member 1
```

The adapter registers three hooks (auto-recall, auto-capture, egress check) and two
tools (`aperture_recall`, `aperture_store`). No grant, no disclosure: unknown senders
resolve to fresh person nodes with resolution 0.

### Choosing a distillation model (learned the hard way)

The distiller must follow a JSON schema **and** keep ladder discipline (coarse layers
may not name what fine layers don't). Measured on the real pipeline:

- **Reasoning/thinking models are unusable here** — minutes per call, and they tend to
  invent their own output schema. Use an *instruct* model.
- **Very small models (≤3B) fail the ladder semantics** — they put the finest fact in
  L1. The entailment invariant rejects them (by design), so nothing corrupt is stored —
  but nothing is stored at all.
- **Sweet spot**: a mini-tier cloud model (`gpt-5-mini`, `gemini-flash`), or a mid-size
  local instruct model (gemma-class 4B+ works). Distillation runs detached after the
  turn, so latency never blocks a reply.

Without any LLM configured, Aperture degrades honestly: recall still works, capture
records raw ingress on the ledger (replayable later with a better model) but skips
distillation.

## Run as an MCP server (any MCP host)

The audience is a *launch* argument, never a tool parameter — the model gets no way to
choose whose eyes it looks through. One server instance per audience:

```bash
npx tsx bin/aperture-mcp.ts --db ~/.aperture.db \
  --owner person:me --audience person:bob --channel telegram:dm:bob
```

Exposes `aperture_recall` (pre-adjudicated retrieval) and `aperture_store` (gated
ingest). Note MCP's protocol limits: no turn lifecycle means no auto-recall injection
and no egress checking — those need harness hooks (see the OpenClaw adapter, or embed
the library).

## Embed in your own harness

Everything the adapters do goes through the public API (`src/index.ts`) — an adapter
for another harness is ~150 lines. The three mount points you need from your host:

```ts
import Database from 'better-sqlite3';
import {
  AtomStore, Ledger, VectorStore, IngestPipeline,
  capture, retrieveForSession, checkEgress, sessionFor, resolveIdentity,
} from 'aperture';

const db = new Database('aperture.db');
const ledger = new Ledger(db);
const store = new AtomStore(db);
const vectors = new VectorStore(db, myEmbedder);          // { dim, embed(texts) }
const pipeline = new IngestPipeline({ store, ledger, ownerId, generator, vectors });

// 1. before the model runs: inject adjudicated memory
const session = sessionFor(db, { platform, channel, peerExternalIds });
const { items } = await retrieveForSession({ db, ledger, store, vectors },
  { sessionId: session.id, query: userPrompt });

// 2. after the turn: capture through the ingress gates (detached)
void capture({ db, ledger, pipeline }, {
  content, subject: [who], topics: ['general'],
  source: { who, channel, ts: Date.now() }, acquisitionContext: channel,
});

// 3. before delivering the reply: egress check
const verdict = await checkEgress({ db, ledger, store, vectors },
  { audience: [peerPersonId], reply });
if (verdict.verdict !== 'pass') reply = 'Let me get back to you on that.';
```

If your host can't provide one of the three mount points, you lose that line of
defense and keep the others — the layers are independent.

## Owner CLI

```bash
aperture --db <path> pending                    # list room-local atoms
aperture --db <path> promote <atomId>           # lift into the global profile
aperture --db <path> seal <atomId>              # reject (visible nowhere, ledgered)
aperture --db <path> grant <obj> viewer <subj> <0-4>
aperture --db <path> revoke <obj> viewer <subj>
aperture --db <path> check person:bob topic:health
aperture --db <path> disclosures --viewer person:bob   # what Bob has learned
aperture --db <path> verify                     # verify the ledger hash chain
```

The same verbs are available in chat when the OpenClaw adapter is installed
(`/aperture pending` etc.) — commands are routed by the host around the model,
so the model can neither see nor forge an owner signature.

## Design commitments

- **Sessions are partitioned by audience.** Each DM peer and each group chat is an
  isolated session; they share state only through the gated memory store. The context
  window is a single trust domain, so the isolation unit is *who can see it*, not *who
  sent it*.
- **Provenance and disclosure rights are separate dimensions.** Where knowledge came
  from (the room, frozen at write time) and who may see it now (owner-signed grants,
  evaluated at read time) never collapse into each other. Room-local content flows
  freely where no new disclosure happens; everything beyond that is policy.
- **Classification happens at write time** (contextual integrity). Provenance, the
  acquisition audience, and the ladder are frozen artifacts, so every later disclosure
  decision is deterministic and replayable — not a fresh guess at answer time.
- **Authorization is an ordinal lift of ReBAC.** Grants carry a resolution capacity;
  paths attenuate by `min`, combine by `max` (a widest-path computation). Boolean ReBAC
  is the special case. The policy "matrix" is just tuples.
- **Correctness is never delegated to a model.** The entailment invariant, the ReBAC
  evaluator, the prefilter gates, the egress comparison — every security decision is
  deterministic code. LLMs draft; invariants judge.
- **Everything is on the ledger.** One hash chain; stores are rebuildable projections.

## Quickstart (no harness required)

```bash
npm install
npm run demo        # same question, three resolutions
npm run demo:dorm   # four roommates, four group chats, gossip that cannot leak
```

The **dorm demo** simulates the hard case directly: three roommates gossip about the
fourth in the one group chat she isn't in. Nineteen inline assertions prove the gossip
is available where everyone already heard it (room-local by provenance — zero approvals
involved), structurally absent from every room she is in, blocked at egress even if the
model hallucinates it, and fully auditable afterwards.

## Status

Core complete (M0–M6) plus a live-validated OpenClaw binding. 105 invariant tests, two
runnable demos, real Telegram traffic through all three defense lines. Before trusting
it with real secrets:

- **Calibrate egress thresholds** with your embedder (`checkEgress` defaults to cosine
  0.82; the right value depends on the embedding model — sweep it against paraphrases
  of your blocked content).
- The knowledge-graph projection and mosaic tracking (M5/M6) are implemented and tested
  but young.

| Milestone | Delivers |
| --- | --- |
| M0 | Memory atoms · ladder entailment invariant · hash-chained ledger · room-scoped provenance |
| M1 | Resolution-typed ReBAC: ledger-projected tuples · (max, min) evaluator |
| M2 | Audience sessions · task scope · layered retrieval |
| M3 | Ingress gates + LLM ladder generator · MCP server · OpenClaw adapter (live-validated) |
| M4 | Egress checker (PII + blocked-complement similarity) · owner CLI |
| M5 | Knowledge-graph projection · edge invalidation · gated graph queries |
| M6 | Mosaic tracking: cumulative disclosure projection · per-topic novelty budgets |

## Learn more

- [docs/layer-generator-prompt.md](docs/layer-generator-prompt.md) — the distillation prompt and its contract

## Development

```bash
npm install
npm test          # 105 invariant tests (business logic only, no schema tests)
npm run typecheck
```

Tests cover invariants, not schemas: ladder entailment, ReBAC monotonicity, the
no-cross-session-leakage property (fuzzed with an adversarial corpus), ledger integrity,
graph/atom parity, and the real-hook-contract adapter behaviors found in live smoke
testing. LLM and embedding calls sit behind injected interfaces, so the suite is fully
deterministic.

## License

[MIT](LICENSE)
