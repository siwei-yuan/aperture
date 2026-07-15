# LayerGenerator prompt (working draft for T3.1)

One structured-output LLM call per episode (temperature 0, JSON-schema
constrained), combining salience triage and ladder generation. Correctness is
never delegated to this prompt: the deterministic entailment invariant
(`validateLadder`) backstops it, with a repair loop feeding structured
violations back for up to 2 retries, then `atom.rejected`.

## System prompt

```text
You convert a witnessed event (a message batch or an observed behavior) into
a "generalization ladder" for a personal memory system — or decide it is not
worth remembering.

## Step 1 — Decide: distill or skip
Skip if the content contains no durable fact about any person, plan,
preference, decision, relationship, routine, or state change — e.g. pure
greetings, fillers, acknowledgments, emoji-only reactions, or
meta-commentary about the conversation itself.
If skipping, return: {"skip": true, "reason": "<greeting|filler|ack|meta|ephemeral>"}

## Step 2 — Build the ladder (coarsest first, 1 to 4 layers)
Each layer must be a complete, true, self-contained statement.
- L1 (state): generalized state words only. No activity category.
    e.g. "X is at his computer" / "X is busy"
- L2 (category): may add the activity or event category. No platform,
    venue, or names.   e.g. "X is watching a video"
- L3 (context): may add platform / venue / object class. No proper nouns,
    titles, numbers, or addresses.   e.g. "X is watching Bilibili"
- L4 (detail): the full fact, with proper nouns, titles, names, quantities.
    e.g. "X is watching 'Rust async explained' on Bilibili"

Hard rules:
- A coarser layer must NEVER contain information absent from the finer
  layer below it.
- For each layer, list `entities`: ONLY concrete identifiers — proper
  nouns, place names, person names, titles, platforms, quantities, dates.
  Abstract descriptions ("a video", "a new location", "a meeting") are NOT
  entities. Coarse layers typically have FEW or NO entities; [] is correct.
- Every entity string at layer k MUST also appear, character-identical, in
  layer k+1's entity list. Never rephrase an entity between layers.
  e.g. entities per layer: L1 [] / L2 [] / L3 ["Bilibili"] /
  L4 ["Bilibili", "Rust async explained"]
- Stop early if the fact is too atomic to support 4 layers (a preference
  like "X likes oolong tea" may support only 2).
- Do not invent, soften, or editorialize. Distill only what is witnessed.

## Also extract
- subject: who each fact is ABOUT (not necessarily the speaker)
- topics: see Step 3

Return JSON matching the provided schema.
```

When the owner configured a `topicTaxonomy`, a third step is appended
(`LlmLayerGenerator` constructor argument):

```text
## Step 3 — Tag topics (only when distilling)
Pick 1 to 3 topics from the owner's controlled vocabulary (hierarchical
paths, "/" nests a subtopic under its parent):
{taxonomy, comma-joined}
Only if none fits, propose ONE new path nested under an existing path
(e.g. "work/gamma" under "work"); it must match [a-z0-9-]+(/[a-z0-9-]+)*.
Add the tags to the JSON: {"topics": ["work/alpha"], "layers": [...]}
```

The parser enforces the path grammar deterministically: malformed topics are
dropped; a topics array that yields nothing valid falls back to `general`
(zero grants unless the owner signed some); a missing topics field leaves the
caller's suggested topics in force. A proposed topic outside the taxonomy is
stored as-is — new topics have no grants, so they are invisible until the
owner signs a resolution — and announced to the owner once
(`topic.discovered` on the ledger is the dedupe record).

## User message template

```text
Episode from {channel} at {ts}:
Speaker: {source.who}
Participants: {peers}

{episode content — turn batch or behavior description}
```

## Output schema

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "skip": { "const": true },
        "reason": { "enum": ["greeting", "filler", "ack", "meta", "ephemeral"] }
      },
      "required": ["skip", "reason"]
    },
    {
      "type": "object",
      "properties": {
        "subject": { "type": "array", "items": { "type": "string" } },
        "topics": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
        "layers": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "properties": {
              "level": { "type": "integer", "minimum": 1, "maximum": 4 },
              "text": { "type": "string" },
              "entities": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["level", "text", "entities"]
          }
        }
      },
      "required": ["subject", "topics", "layers"]
    }
  ]
}
```

## Repair loop

On `validateLadder` failure, retry with the structured violations appended:

```text
Your previous ladder violated the entailment invariant:
- level {k}: entity "{e}" is absent from finer level {k+1}
Regenerate the full ladder. A coarser layer must never introduce information
absent from the finer layer.
```

Max 2 retries, then reject (`atom.rejected` ledger event).

## Model selection

High-frequency background call → cheap/fast tier (local small model or mini
API tier). Quality is measured by the T3.1 eval script (entailment pass rate,
information monotonicity over a sample set), never assumed; correctness is
enforced by the invariant regardless of model quality.
