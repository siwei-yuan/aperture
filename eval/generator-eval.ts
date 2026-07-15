/**
 * Quality eval for the LLM LayerGenerator — NOT in CI (needs a live model).
 *
 *   APERTURE_LLM_BASE_URL=https://api.openai.com/v1 \
 *   APERTURE_LLM_API_KEY=sk-... \
 *   APERTURE_LLM_MODEL=gpt-4o-mini \
 *   npx tsx eval/generator-eval.ts
 *
 * Measures: skip precision on phatic samples, entailment pass rate (before
 * repair), and information monotonicity (strictly growing entity sets).
 */
import { validateLadder } from '../src/core/entail.js';
import type { RawEvent } from '../src/core/ingest.js';
import { LlmLayerGenerator, type LlmClient } from '../src/gen/llm-generator.js';

// Reference LlmClient: any OpenAI-compatible endpoint, no SDK.
function fetchClient(): LlmClient {
  const base = process.env.APERTURE_LLM_BASE_URL;
  const key = process.env.APERTURE_LLM_API_KEY;
  const model = process.env.APERTURE_LLM_MODEL;
  if (!base || !key || !model) {
    console.error('Set APERTURE_LLM_BASE_URL / APERTURE_LLM_API_KEY / APERTURE_LLM_MODEL');
    process.exit(1);
  }
  return {
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
      if (!res.ok) throw new Error(`LLM endpoint ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return body.choices[0]!.message.content;
    },
  };
}

const event = (content: string): RawEvent => ({
  content,
  subject: ['person:owner'],
  topics: ['activity'],
  source: { who: 'person:owner', channel: 'eval', ts: Date.now() },
  acquisitionContext: 'private',
});

const PHATIC = ['在吗？', '哈哈哈哈👍', 'ok thanks!', '收到收到', '早上好呀'];
const FACTUAL = [
  '我下周二搬去上海，新地址光复路88号',
  'He just started watching "Rust async explained" on Bilibili',
  '老板把周会改到每周四下午三点了',
  'Alice said she is allergic to peanuts',
  '我把年度体检约在了 9 月 3 号协和医院',
];

const generator = new LlmLayerGenerator(fetchClient());

let skipHits = 0;
for (const sample of PHATIC) {
  const out = await generator.generate(event(sample));
  const skipped = !Array.isArray(out);
  if (skipped) skipHits++;
  console.log(`[phatic]  ${skipped ? 'SKIP ✓' : 'DISTILLED ✗'}  ${sample}`);
}

let entailPass = 0;
let monotone = 0;
for (const sample of FACTUAL) {
  const out = await generator.generate(event(sample));
  if (!Array.isArray(out) || out.length === 0) {
    console.log(`[factual] NO LADDER ✗  ${sample}`);
    continue;
  }
  const check = validateLadder(out);
  if (check.ok) entailPass++;
  const growing = out.every((l, i) => i === 0 || l.entities.length > out[i - 1]!.entities.length);
  if (growing) monotone++;
  console.log(`[factual] entail ${check.ok ? '✓' : `✗ ${check.violations[0]?.reason}`} · info-monotone ${growing ? '✓' : '✗'} · ${sample}`);
}

console.log(`\nskip precision: ${skipHits}/${PHATIC.length}`);
console.log(`entailment pass rate (no repair): ${entailPass}/${FACTUAL.length}`);
console.log(`information monotonicity: ${monotone}/${FACTUAL.length}`);
