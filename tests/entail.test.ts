import { describe, expect, it } from 'vitest';
import type { Layer } from '../src/core/atom.js';
import { validateLadder } from '../src/core/entail.js';

const bilibiliLadder: Layer[] = [
  { level: 1, text: 'He is at his computer', entities: ['computer'] },
  { level: 2, text: 'He is watching a video on his computer', entities: ['computer', 'video'] },
  { level: 3, text: 'He is watching Bilibili on his computer', entities: ['computer', 'video', 'bilibili'] },
  {
    level: 4,
    text: 'He is watching "Rust async explained" on Bilibili on his computer',
    entities: ['computer', 'video', 'bilibili', 'rust async explained'],
  },
];

describe('ladder entailment invariant', () => {
  it('accepts a valid 4-layer ladder', () => {
    expect(validateLadder(bilibiliLadder)).toEqual({ ok: true, violations: [] });
  });

  it('accepts ladders shorter than 4 (atomic facts)', () => {
    expect(validateLadder(bilibiliLadder.slice(0, 2)).ok).toBe(true);
    expect(validateLadder(bilibiliLadder.slice(0, 1)).ok).toBe(true);
  });

  it('rejects a coarser layer that introduces an entity absent from the finer layer', () => {
    const poisoned = structuredClone(bilibiliLadder);
    // L2 leaks the specific site that only L3+ should carry
    poisoned[1]!.entities.push('bilibili-live-room-777');
    const result = validateLadder(poisoned);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.reason).toContain('bilibili-live-room-777');
    expect(result.violations[0]!.level).toBe(2);
  });

  it('entity comparison is case- and whitespace-insensitive', () => {
    const ladder = structuredClone(bilibiliLadder.slice(0, 2));
    ladder[0]!.entities = ['  Computer '];
    expect(validateLadder(ladder).ok).toBe(true);
  });

  it('rejects non-contiguous or non-ascending levels', () => {
    const gap = [bilibiliLadder[0]!, { ...bilibiliLadder[2]! }];
    expect(validateLadder(gap).ok).toBe(false);

    const reversed = [...bilibiliLadder].reverse();
    expect(validateLadder(reversed).ok).toBe(false);
  });

  it('rejects empty ladders and ladders deeper than 4', () => {
    expect(validateLadder([]).ok).toBe(false);

    const tooDeep = [
      ...structuredClone(bilibiliLadder),
      { level: 5, text: 'even finer', entities: ['computer', 'video', 'bilibili', 'rust async explained', 'x'] },
    ];
    expect(validateLadder(tooDeep).ok).toBe(false);
  });

  it('rejects blank layer text', () => {
    const blank = structuredClone(bilibiliLadder);
    blank[0]!.text = '   ';
    expect(validateLadder(blank).ok).toBe(false);
  });
});
