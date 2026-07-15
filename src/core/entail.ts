import type { Layer } from './atom.js';

export const MAX_LAYERS = 4;

export interface LadderViolation {
  level: number;
  reason: string;
}

export interface LadderCheck {
  ok: boolean;
  violations: LadderViolation[];
}

function normalizeEntity(e: string): string {
  return e.trim().toLowerCase();
}

/**
 * Deterministic part of the entailment invariant:
 * - levels are contiguous 1..n, n in [1, MAX_LAYERS]
 * - every coarser layer's entity set is a subset of the next finer layer's
 *   (a coarse layer must never introduce information absent from the finer one)
 *
 * Subset is checked between adjacent layers, which gives the full chain by
 * transitivity. The semantic (NLI/LLM) check is a separate, pluggable hook —
 * see `SemanticEntailment` in ingest.ts.
 */
export function validateLadder(layers: Layer[]): LadderCheck {
  const violations: LadderViolation[] = [];

  if (layers.length === 0) {
    return { ok: false, violations: [{ level: 0, reason: 'ladder is empty' }] };
  }
  if (layers.length > MAX_LAYERS) {
    violations.push({
      level: layers.length,
      reason: `ladder has ${layers.length} layers, max is ${MAX_LAYERS}`,
    });
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    if (layer.level !== i + 1) {
      violations.push({
        level: layer.level,
        reason: `levels must be contiguous ascending from 1; expected ${i + 1}, got ${layer.level}`,
      });
    }
    if (layer.text.trim().length === 0) {
      violations.push({ level: layer.level, reason: 'layer text is empty' });
    }
  }

  for (let i = 0; i + 1 < layers.length; i++) {
    const coarser = layers[i]!;
    const finer = layers[i + 1]!;
    const finerEntities = new Set(finer.entities.map(normalizeEntity));
    for (const entity of coarser.entities) {
      if (!finerEntities.has(normalizeEntity(entity))) {
        violations.push({
          level: coarser.level,
          reason: `entity "${entity}" at level ${coarser.level} is absent from finer level ${finer.level}`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
