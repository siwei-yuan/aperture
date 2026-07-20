import type { LlmClient } from './llm-generator.js';

/**
 * The slice of `api.runtime.llm.complete` (OpenClaw plugin SDK) this client
 * consumes — structurally compatible with the real `LlmCompleteParams` /
 * `LlmCompleteResult`, fake-able in tests.
 */
export interface HostLlmCompleteParams {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  temperature?: number;
  signal?: AbortSignal;
  purpose?: string;
}

export type HostLlmComplete = (params: HostLlmCompleteParams) => Promise<{ text: string }>;

/**
 * Chat models without a JSON response mode love wrapping output in a
 * ```json fence; the parse boundary downstream wants bare JSON. Anything
 * else malformed still degrades to the repair loop as before.
 */
export function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return match ? match[1]! : text;
}

/**
 * Distillation through the host's own brain: an `LlmClient` backed by the
 * gateway's `runtime.llm.complete`, so the memory system buys its inference
 * from the same model (and credentials) the chat agent already runs on —
 * no separate endpoint to configure or keep warm.
 *
 * The host surface has no `response_format`; the SYSTEM_PROMPT already
 * demands "Return ONLY JSON" and the generator tolerates malformed output.
 */
export function hostLlmClient(complete: HostLlmComplete): LlmClient {
  return {
    async completeJson(system, user) {
      const result = await complete({
        systemPrompt: system,
        messages: [{ role: 'user', content: user }],
        temperature: 0,
        purpose: 'aperture-distillation',
        // Same crisp-failure budget as the endpoint client: the raw episode
        // is already ledgered, so a timed-out distillation is replayable.
        signal: AbortSignal.timeout(180_000),
      });
      return stripCodeFence(result.text);
    },
  };
}
