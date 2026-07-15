import type Database from 'better-sqlite3';
import type { IngestPipeline, IngestResult, RawEvent } from '../core/ingest.js';
import type { Ledger } from '../core/ledger.js';
import {
  DEFAULT_PREFILTER,
  prefilter,
  recordFingerprint,
  simhash64,
  type PrefilterConfig,
} from './prefilter.js';

export interface CaptureDeps {
  db: Database.Database;
  ledger: Ledger;
  pipeline: IngestPipeline;
}

export type CaptureResult =
  | { gated: string; detail: string }
  | { ingest: IngestResult };

/** Gate 0 alone: the unconditional, immediate tape anchor. */
export function recordIngress(deps: CaptureDeps, episode: RawEvent): void {
  deps.ledger.append(
    'ingress.received',
    {
      who: episode.source.who,
      channel: episode.source.channel,
      len: episode.content.length,
    },
    episode.source.ts,
  );
}

/**
 * Gates 1–2: deterministic prefilter, then exactly one shot at the LLM.
 * Callers must have recorded ingress already (directly or via a buffer).
 */
export async function distill(
  deps: CaptureDeps,
  episode: RawEvent,
  config: PrefilterConfig = DEFAULT_PREFILTER,
): Promise<CaptureResult> {
  const gate = prefilter(deps.db, episode, config);
  if (!gate.pass) return { gated: gate.gate, detail: gate.detail };

  // Fingerprint AFTER ingest returns: the fingerprint means "this content
  // already cost an LLM call". If ingest throws (endpoint down, timeout),
  // nothing was bought — the same content must be allowed to retry.
  // Skip/rejected results DID cost the call, so they are recorded.
  const ingest = await deps.pipeline.ingest(episode);
  recordFingerprint(deps.db, simhash64(episode.content), episode.source.ts, config);
  return { ingest };
}

/**
 * The single-shot ingress entrance. Recording is unconditional (gate 0:
 * every episode lands on the ledger as `ingress.received` — the tape
 * anchor); distillation is adjudicated (gates 1–2). For conversational
 * sources prefer `CaptureBuffer`, which records per message but distills
 * whole bursts.
 */
export async function capture(
  deps: CaptureDeps,
  episode: RawEvent,
  config: PrefilterConfig = DEFAULT_PREFILTER,
): Promise<CaptureResult> {
  recordIngress(deps, episode);
  return distill(deps, episode, config);
}
