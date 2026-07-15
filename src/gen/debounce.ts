import type { RawEvent } from '../core/ingest.js';
import { distill, recordIngress, type CaptureDeps, type CaptureResult } from './capture.js';

/**
 * Session-level capture debounce: a conversation burst becomes ONE distilled
 * atom instead of one fragment per turn.
 *
 * The split of duties is the membrane's usual one:
 * - Recording is a mechanism and stays immediate — every fragment lands on
 *   the ledger as `ingress.received` the moment it arrives. If the process
 *   dies before a flush, nothing is lost that cannot be re-distilled from
 *   the ledger.
 * - Distillation timing is policy — a session's fragments accumulate until
 *   the conversation goes quiet (or a size cap forces the issue), then the
 *   whole burst goes through the normal gates as a single episode.
 */

export interface DebounceConfig {
  /** Flush a session after this much silence. */
  quietMs: number;
  /** Force a flush once this many fragments are buffered. */
  maxFragments: number;
  /** Force a flush once the combined content reaches this many characters. */
  maxChars: number;
}

export const DEFAULT_DEBOUNCE: DebounceConfig = {
  quietMs: 5 * 60_000,
  maxFragments: 12,
  maxChars: 6_000,
};

interface Buffered {
  fragments: RawEvent[];
  timer?: ReturnType<typeof setTimeout>;
}

export class CaptureBuffer {
  private readonly sessions = new Map<string, Buffered>();

  constructor(
    private readonly deps: CaptureDeps,
    private readonly ownerId: string,
    private readonly config: DebounceConfig = DEFAULT_DEBOUNCE,
    /** Observes flush results (e.g. to push owner notices). Errors are the observer's problem. */
    private readonly onFlush?: (result: CaptureResult) => void,
  ) {}

  /**
   * Record a fragment (immediately, gate 0) and buffer it for burst
   * distillation. `sessionKey` scopes the burst — one buffer per room.
   */
  add(sessionKey: string, fragment: RawEvent): void {
    recordIngress(this.deps, fragment);

    const buffered = this.sessions.get(sessionKey) ?? { fragments: [] };
    buffered.fragments.push(fragment);
    this.sessions.set(sessionKey, buffered);

    const size = buffered.fragments.reduce((n, f) => n + f.content.length, 0);
    if (buffered.fragments.length >= this.config.maxFragments || size >= this.config.maxChars) {
      void this.flush(sessionKey);
      return;
    }

    if (buffered.timer) clearTimeout(buffered.timer);
    buffered.timer = setTimeout(() => void this.flush(sessionKey), this.config.quietMs);
    buffered.timer.unref?.();
  }

  /** Distill a session's buffered burst as one episode. */
  async flush(sessionKey: string): Promise<CaptureResult | undefined> {
    const buffered = this.sessions.get(sessionKey);
    if (!buffered || buffered.fragments.length === 0) return undefined;
    if (buffered.timer) clearTimeout(buffered.timer);
    this.sessions.delete(sessionKey);

    const episode = this.merge(buffered.fragments);
    try {
      const result = await distill(this.deps, episode);
      this.onFlush?.(result);
      return result;
    } catch (err) {
      // Already ledgered as ingress.received per fragment — replayable.
      console.error('[aperture] burst distillation failed:', err);
      return undefined;
    }
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.sessions.keys()]) await this.flush(key);
  }

  /** Combined episode with conservative provenance and the union room. */
  private merge(fragments: RawEvent[]): RawEvent {
    const first = fragments[0]!;
    const last = fragments[fragments.length - 1]!;
    // Conservative provenance: if any non-owner spoke in the burst, the
    // episode is theirs — so it lands room-local.
    const who = fragments.find((f) => f.source.who !== this.ownerId)?.source.who ?? this.ownerId;
    const audience = [...new Set(fragments.flatMap((f) => f.acquisitionAudience ?? [f.source.who]))].sort();
    return {
      content: fragments.map((f) => f.content).join('\n'),
      subject: [...new Set(fragments.flatMap((f) => f.subject))],
      topics: [...new Set(fragments.flatMap((f) => f.topics))],
      source: { who, channel: first.source.channel, ts: last.source.ts },
      acquisitionContext: first.acquisitionContext,
      acquisitionAudience: audience,
    };
  }
}
