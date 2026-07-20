import { describe, expect, it } from 'vitest';
import type { RawEvent } from '../src/core/ingest.js';
import { hostLlmClient, stripCodeFence, type HostLlmCompleteParams } from '../src/gen/host-llm.js';
import { LlmLayerGenerator } from '../src/gen/llm-generator.js';

const event: RawEvent = {
  content: 'bob: settled on 88 guangfu road, moving next month',
  subject: ['person:bob'],
  topics: ['general'],
  source: { who: 'person:bob', channel: 'telegram:dm', ts: 1_000 },
  acquisitionContext: 'telegram:dm',
};

const LADDER_JSON = JSON.stringify({
  layers: [
    { level: 1, text: 'bob has news to share', entities: [] },
    { level: 2, text: 'bob is moving to 88 guangfu road', entities: ['bob', '88 guangfu road'] },
  ],
});

/** Fake host complete that records its params and returns a canned text. */
function fakeComplete(text: string) {
  const calls: HostLlmCompleteParams[] = [];
  const complete = async (params: HostLlmCompleteParams) => {
    calls.push(params);
    return { text };
  };
  return { calls, complete };
}

describe('host LLM client (runtime.llm.complete backed distillation)', () => {
  it('maps system → systemPrompt and user → a single user message, deterministic and audited', async () => {
    const { calls, complete } = fakeComplete('{"skip": true, "reason": "ack"}');
    await hostLlmClient(complete).completeJson('SYSTEM RULES', 'the episode');

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.systemPrompt).toBe('SYSTEM RULES');
    expect(params.messages).toEqual([{ role: 'user', content: 'the episode' }]);
    expect(params.temperature).toBe(0);
    expect(params.purpose).toBe('aperture-distillation');
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes bare JSON through untouched', async () => {
    const { complete } = fakeComplete(LADDER_JSON);
    expect(await hostLlmClient(complete).completeJson('s', 'u')).toBe(LADDER_JSON);
  });

  it('strips a ```json code fence (hosts have no response_format guarantee)', async () => {
    const { complete } = fakeComplete('```json\n' + LADDER_JSON + '\n```');
    expect(await hostLlmClient(complete).completeJson('s', 'u')).toBe(LADDER_JSON);
  });

  it('strips a bare ``` fence with surrounding whitespace', () => {
    expect(stripCodeFence('  ```\n{"a":1}\n```  ')).toBe('{"a":1}');
    expect(stripCodeFence('no fence at all')).toBe('no fence at all');
    // A fence in the MIDDLE of prose is not an envelope — leave it alone.
    expect(stripCodeFence('prefix ```json\n{}\n``` suffix')).toBe('prefix ```json\n{}\n``` suffix');
  });

  it('a fenced host reply still parses into a ladder through LlmLayerGenerator', async () => {
    const { complete } = fakeComplete('```json\n' + LADDER_JSON + '\n```');
    const generator = new LlmLayerGenerator(hostLlmClient(complete));

    const generated = await generator.generate(event);
    expect(Array.isArray(generated)).toBe(true);
    const drafts = generated as Array<{ level: number; text: string; entities: string[] }>;
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toEqual({ level: 1, text: 'bob has news to share', entities: [] });
    expect(drafts[1]!.entities).toEqual(['bob', '88 guangfu road']);
  });

  it('a fenced skip decision survives the same path', async () => {
    const { complete } = fakeComplete('```\n{"skip": true, "reason": "greeting"}\n```');
    const generator = new LlmLayerGenerator(hostLlmClient(complete));
    expect(await generator.generate(event)).toEqual({ skip: true, reason: 'greeting' });
  });
});
