import { randomUUID } from 'node:crypto';
import type { MemoryAtom, Source } from './atom.js';
import type { VectorStore } from './embed.js';
import { validateLadder, type LadderViolation } from './entail.js';
import type { Ledger } from './ledger.js';
import type { AtomStore } from './store.js';

export interface RawEvent {
  content: string;
  subject: string[];
  topics: string[];
  source: Source;
  acquisitionContext: string;
  /**
   * Person ids present when this was said (room membership). Defaults to
   * just the speaker; the owner is materialized in at ingest either way.
   */
  acquisitionAudience?: string[];
}

export interface LayerDraft {
  level: number;
  text: string;
  entities: string[];
}

/** "Not worth remembering" — stores nothing; the absence of an atom is the record. */
export interface SkipDecision {
  skip: true;
  reason: string;
}

/**
 * LLM-backed in production; deterministic fake in tests. `feedback` carries
 * entailment violations from the previous attempt (the repair loop).
 */
export interface LayerGenerator {
  generate(event: RawEvent, feedback?: LadderViolation[]): Promise<LayerDraft[] | SkipDecision>;
}

/**
 * Optional semantic entailment check (NLI / LLM judge) layered on top of the
 * deterministic entity-subset invariant. Must return true iff `coarser` is
 * strictly entailed by `finer`.
 */
export interface SemanticEntailment {
  entails(coarser: string, finer: string): Promise<boolean>;
}

export type IngestResult =
  | { ok: true; atom: MemoryAtom }
  | { ok: true; skipped: string }
  | { ok: false; violations: LadderViolation[] };

/** Repair attempts after the first generation (violations fed back each time). */
const MAX_REPAIR_RETRIES = 2;

export class IngestPipeline {
  private readonly store: AtomStore;
  private readonly ledger: Ledger;
  private readonly ownerId: string;
  private readonly generator: LayerGenerator;
  private readonly semantic?: SemanticEntailment;
  private readonly vectors?: VectorStore;

  constructor(opts: {
    store: AtomStore;
    ledger: Ledger;
    ownerId: string;
    generator: LayerGenerator;
    semantic?: SemanticEntailment;
    vectors?: VectorStore;
  }) {
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.ownerId = opts.ownerId;
    this.generator = opts.generator;
    this.semantic = opts.semantic;
    this.vectors = opts.vectors;
  }

  async ingest(event: RawEvent): Promise<IngestResult> {
    let feedback: LadderViolation[] | undefined;
    let lastViolations: LadderViolation[] = [];

    for (let attempt = 0; attempt <= MAX_REPAIR_RETRIES; attempt++) {
      const generated = await this.generator.generate(event, feedback);
      if (!Array.isArray(generated)) {
        // Salience skip: nothing stored, no event — recoverable by replaying
        // the raw ingress stream with a better generator.
        return { ok: true, skipped: generated.reason };
      }

      const layers = generated.map((d) => ({ level: d.level, text: d.text, entities: d.entities }));
      const check = validateLadder(layers);
      const violations = [...check.violations];

      if (check.ok && this.semantic) {
        for (let i = 0; i + 1 < layers.length; i++) {
          const coarser = layers[i]!;
          const finer = layers[i + 1]!;
          if (!(await this.semantic.entails(coarser.text, finer.text))) {
            violations.push({
              level: coarser.level,
              reason: `level ${coarser.level} is not semantically entailed by level ${finer.level}`,
            });
          }
        }
      }

      if (violations.length === 0) {
        // Provenance rule: the owner's own knowledge is global; anything a
        // non-owner said is local to the room it was said in — freely usable
        // there (no new disclosure), but it never silently merges into the
        // globally retrievable profile. Leaving the room takes an
        // owner-signed promotion.
        const acquisitionAudience = [
          ...new Set([...(event.acquisitionAudience ?? [event.source.who]), this.ownerId]),
        ].sort();
        const atom: MemoryAtom = {
          id: randomUUID(),
          subject: event.subject,
          source: event.source,
          acquisitionContext: event.acquisitionContext,
          acquisitionAudience,
          topics: event.topics,
          layers,
          scope: event.source.who === this.ownerId ? 'global' : 'local',
        };

        this.store.insert(atom);
        // Full ladder goes on the ledger so the atom store is a strict projection.
        this.ledger.append('atom.ingested', {
          atomId: atom.id,
          subject: atom.subject,
          source: atom.source,
          acquisitionContext: atom.acquisitionContext,
          acquisitionAudience: atom.acquisitionAudience,
          topics: atom.topics,
          layers: atom.layers,
          scope: atom.scope,
        });
        if (this.vectors) await this.vectors.index(atom);
        return { ok: true, atom };
      }

      lastViolations = violations;
      feedback = violations;
    }

    this.ledger.append('atom.rejected', {
      source: event.source,
      violations: lastViolations,
    });
    return { ok: false, violations: lastViolations };
  }

  /** Only the owner can promote a local atom to global; promotion is a ledger event. */
  promote(atomId: string, approverId: string): void {
    promoteAtom({ store: this.store, ledger: this.ledger, ownerId: this.ownerId }, atomId, approverId);
  }
}

function requireLocalAtom(
  deps: { store: AtomStore; ownerId: string },
  atomId: string,
  actorId: string,
  verb: string,
): void {
  if (actorId !== deps.ownerId) {
    throw new Error(`only the owner can ${verb} atoms (got "${actorId}")`);
  }
  const atom = deps.store.get(atomId);
  if (!atom) throw new Error(`unknown atom "${atomId}"`);
  if (atom.scope !== 'local') throw new Error(`atom "${atomId}" is ${atom.scope}, not local`);
}

/** Owner signature: lift a local atom into the globally retrievable profile. */
export function promoteAtom(
  deps: { store: AtomStore; ledger: Ledger; ownerId: string },
  atomId: string,
  approverId: string,
): void {
  requireLocalAtom(deps, atomId, approverId, 'promote');
  deps.store.setScope(atomId, 'global');
  deps.ledger.append('atom.promoted', { atomId, approverId });
}

/** Owner signature: reject a local atom — visible nowhere, kept on the ledger for audit. */
export function sealAtom(
  deps: { store: AtomStore; ledger: Ledger; ownerId: string },
  atomId: string,
  approverId: string,
): void {
  requireLocalAtom(deps, atomId, approverId, 'seal');
  deps.store.setScope(atomId, 'sealed');
  deps.ledger.append('atom.sealed', { atomId, approverId });
}
