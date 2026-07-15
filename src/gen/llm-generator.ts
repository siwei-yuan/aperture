import type { LadderViolation } from '../core/entail.js';
import type { LayerDraft, LayerGenerator, RawEvent, SkipDecision } from '../core/ingest.js';

/**
 * The only thing a provider must implement. No vendor SDKs in core — the
 * eval script ships a ~30-line fetch client for any OpenAI-compatible
 * endpoint as the reference implementation.
 */
export interface LlmClient {
  /** Returns the raw model output for a JSON-constrained completion. */
  completeJson(system: string, user: string): Promise<string>;
}

/** Prompt source of truth: docs/layer-generator-prompt.md. */
export const SYSTEM_PROMPT = `You convert a witnessed event (a message batch or an observed behavior) into
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
- For each layer, list \`entities\`: ONLY concrete identifiers — proper
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

Return ONLY JSON, either:
  {"skip": true, "reason": "..."}
or:
  {"layers": [{"level": 1, "text": "...", "entities": ["..."]}, ...]}`;

function renderUser(event: RawEvent, feedback?: LadderViolation[]): string {
  let user = `Episode from ${event.source.channel} at ${event.source.ts}:
Speaker: ${event.source.who}
Subjects: ${event.subject.join(', ')}
Topics: ${event.topics.join(', ')}

${event.content}`;

  if (feedback && feedback.length > 0) {
    user += `\n\nYour previous ladder violated the entailment invariant:\n${feedback
      .map((v) => `- level ${v.level}: ${v.reason}`)
      .join('\n')}\nRegenerate the full ladder. A coarser layer must never introduce information absent from the finer layer. For each violated entity: either remove it from the coarser layer's entities (abstract descriptions are not entities — [] is fine), or copy the identical string into every finer layer's entities.`;
  }
  return user;
}

/**
 * Real LayerGenerator. Correctness is never delegated to the model: the
 * pipeline's entailment invariant backstops every output, and malformed
 * JSON degrades to an empty ladder — which the invariant rejects, feeding
 * the repair loop for free.
 */
export class LlmLayerGenerator implements LayerGenerator {
  constructor(private readonly client: LlmClient) {}

  async generate(event: RawEvent, feedback?: LadderViolation[]): Promise<LayerDraft[] | SkipDecision> {
    const raw = await this.client.completeJson(SYSTEM_PROMPT, renderUser(event, feedback));

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return []; // rejected by validateLadder → repair loop
    }

    if (typeof parsed === 'object' && parsed !== null && (parsed as { skip?: unknown }).skip === true) {
      const reason = (parsed as { reason?: unknown }).reason;
      return { skip: true, reason: typeof reason === 'string' ? reason : 'unspecified' };
    }

    const layers = (parsed as { layers?: unknown }).layers;
    if (!Array.isArray(layers)) return [];

    const drafts: LayerDraft[] = [];
    for (const layer of layers) {
      if (
        typeof layer !== 'object' ||
        layer === null ||
        typeof (layer as { level?: unknown }).level !== 'number' ||
        typeof (layer as { text?: unknown }).text !== 'string' ||
        !Array.isArray((layer as { entities?: unknown }).entities)
      ) {
        return []; // malformed shape → invariant rejects → repair loop
      }
      const l = layer as { level: number; text: string; entities: unknown[] };
      drafts.push({
        level: l.level,
        text: l.text,
        // Model junk dies at the parse boundary: non-strings and blank
        // strings are not entities (observed live: a bare "" failing the
        // subset invariant).
        entities: l.entities.filter((e): e is string => typeof e === 'string' && e.trim().length > 0),
      });
    }
    return drafts;
  }
}
