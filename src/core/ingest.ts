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
        // Provenance rule: information originating outside the owner is
        // quarantined until explicitly approved — it must never silently
        // merge into the profile any session can read from.
        const atom: MemoryAtom = {
          id: randomUUID(),
          subject: event.subject,
          source: event.source,
          acquisitionContext: event.acquisitionContext,
          topics: event.topics,
          layers,
          quarantined: event.source.who !== this.ownerId,
        };

        this.store.insert(atom);
        // Full ladder goes on the ledger so the atom store is a strict projection.
        this.ledger.append('atom.ingested', {
          atomId: atom.id,
          subject: atom.subject,
          source: atom.source,
          acquisitionContext: atom.acquisitionContext,
          topics: atom.topics,
          layers: atom.layers,
          quarantined: atom.quarantined,
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

  /** Only the owner can release an atom from quarantine; approval is a ledger event. */
  approve(atomId: string, approverId: string): void {
    approveAtom({ store: this.store, ledger: this.ledger, ownerId: this.ownerId }, atomId, approverId);
  }
}

/** Standalone approval (used by the pipeline and the owner CLI). */
export function approveAtom(
  deps: { store: AtomStore; ledger: Ledger; ownerId: string },
  atomId: string,
  approverId: string,
): void {
  if (approverId !== deps.ownerId) {
    throw new Error(`only the owner can approve quarantined atoms (got "${approverId}")`);
  }
  const atom = deps.store.get(atomId);
  if (!atom) throw new Error(`unknown atom "${atomId}"`);
  if (!atom.quarantined) throw new Error(`atom "${atomId}" is not quarantined`);

  deps.store.setQuarantined(atomId, false);
  deps.ledger.append('atom.approved', { atomId, approverId });
}
