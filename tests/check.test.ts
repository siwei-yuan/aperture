import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/core/ledger.js';
import {
  AclStore,
  check,
  lookupVisibleLayers,
  resolutionForAtom,
  type RelationTuple,
} from '../src/core/rebac.js';

function withAcl(tuples: RelationTuple[]) {
  const db = new Database(':memory:');
  const acl = new AclStore(db, new Ledger(db));
  for (const t of tuples) acl.applyGrant(t); // projection-only writes: evaluator tests don't need the ledger
  return db;
}

const T = (object: string, relation: string, subject: string, resolution: number): RelationTuple => ({
  object,
  relation,
  subject,
  resolution,
});

describe('(max, min) semiring evaluator — concrete semantics', () => {
  it('policy matrix scenario: topic grant via tier membership', () => {
    const db = withAcl([
      T('topic:activity', 'viewer', 'tier:friend#member', 3),
      T('tier:friend', 'member', 'person:alice', 4),
      T('atom:a1', 'viewer', 'person:bob', 4),
    ]);
    const atom = { id: 'a1', topics: ['activity'] };

    expect(resolutionForAtom(db, 'person:alice', atom)).toBe(3); // via topic
    expect(resolutionForAtom(db, 'person:bob', atom)).toBe(4); // direct beats nothing else
    expect(resolutionForAtom(db, 'person:stranger', atom)).toBe(0); // default deny
  });

  it('attenuation: capacity is the min along a path', () => {
    const db = withAcl([
      T('topic:x', 'viewer', 'g:a#member', 3),
      T('g:a', 'member', 'g:b#member', 2),
      T('g:b', 'member', 'person:p', 4),
    ]);
    expect(check(db, 'person:p', 'topic:x')).toBe(2); // min(3, min(2, 4))
  });

  it('union: multiple paths take the max', () => {
    const db = withAcl([
      T('topic:x', 'viewer', 'g:a#member', 2),
      T('g:a', 'member', 'person:p', 4),
      T('topic:x', 'viewer', 'g:b#member', 3),
      T('g:b', 'member', 'person:p', 4),
    ]);
    expect(check(db, 'person:p', 'topic:x')).toBe(3);
  });

  it('depth cap: 4 levels of nesting resolve, 5 do not', () => {
    const chain4 = withAcl([
      T('topic:x', 'viewer', 'g:1#member', 4),
      T('g:1', 'member', 'g:2#member', 4),
      T('g:2', 'member', 'g:3#member', 4),
      T('g:3', 'member', 'g:4#member', 4),
      T('g:4', 'member', 'person:p', 4),
    ]);
    expect(check(chain4, 'person:p', 'topic:x')).toBe(4);

    const chain5 = withAcl([
      T('topic:x', 'viewer', 'g:1#member', 4),
      T('g:1', 'member', 'g:2#member', 4),
      T('g:2', 'member', 'g:3#member', 4),
      T('g:3', 'member', 'g:4#member', 4),
      T('g:4', 'member', 'g:5#member', 4),
      T('g:5', 'member', 'person:p', 4),
    ]);
    expect(check(chain5, 'person:p', 'topic:x')).toBe(0);
  });

  it('membership cycles terminate and grants still resolve', () => {
    const db = withAcl([
      T('g:a', 'member', 'g:b#member', 4),
      T('g:b', 'member', 'g:a#member', 4),
      T('g:a', 'member', 'person:p', 4),
      T('topic:x', 'viewer', 'g:b#member', 3),
    ]);
    // p ∈ a, a ⊆ b's members via cycle tuple: path topic→b#member→a#member→p
    expect(check(db, 'person:p', 'topic:x')).toBe(3);
    expect(check(db, 'person:q', 'topic:x')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

const PERSONS = ['person:p0', 'person:p1'];
const GROUPS = ['g:a', 'g:b', 'g:c'];
const TOPICS = ['topic:t0', 'topic:t1'];

const subjectArb = fc.constantFrom(...PERSONS, ...GROUPS.map((g) => `${g}#member`));
const tupleArb: fc.Arbitrary<RelationTuple> = fc.oneof(
  fc.record({
    object: fc.constantFrom(...TOPICS),
    relation: fc.constant('viewer'),
    subject: subjectArb,
    resolution: fc.integer({ min: 0, max: 4 }),
  }),
  fc.record({
    object: fc.constantFrom(...GROUPS),
    relation: fc.constant('member'),
    subject: subjectArb,
    resolution: fc.integer({ min: 0, max: 4 }),
  }),
);
const tuplesArb = fc.array(tupleArb, { maxLength: 12 });

function allChecks(db: Database.Database): number[] {
  const out: number[] = [];
  for (const s of PERSONS) for (const o of TOPICS) out.push(check(db, s, o));
  return out;
}

describe('(max, min) semiring evaluator — properties', () => {
  it('monotonicity: adding a fresh tuple never lowers any check', () => {
    fc.assert(
      fc.property(tuplesArb, tupleArb, (tuples, extra) => {
        const collides = tuples.some(
          (t) => t.object === extra.object && t.relation === extra.relation && t.subject === extra.subject,
        );
        fc.pre(!collides);
        const before = allChecks(withAcl(tuples));
        const after = allChecks(withAcl([...tuples, extra]));
        for (let i = 0; i < before.length; i++) expect(after[i]!).toBeGreaterThanOrEqual(before[i]!);
      }),
      { numRuns: 60 },
    );
  });

  it('revocation: revoking a tuple key never raises any check', () => {
    // Revocation deletes by key (AclStore.revoke semantics). Modeling it as
    // "remove one grant from a history" is wrong: with upsert semantics an
    // earlier, higher grant would "resurrect" — a state the real system can
    // never be in, since state is the table, not the grant history.
    fc.assert(
      fc.property(tuplesArb, fc.nat(), (tuples, pick) => {
        fc.pre(tuples.length > 0);
        const target = tuples[pick % tuples.length]!;
        const db = new Database(':memory:');
        const acl = new AclStore(db, new Ledger(db));
        for (const t of tuples) acl.applyGrant(t);

        const before = allChecks(db);
        acl.applyRevoke(target);
        const after = allChecks(db);
        for (let i = 0; i < before.length; i++) expect(after[i]!).toBeLessThanOrEqual(before[i]!);
      }),
      { numRuns: 60 },
    );
  });

  it('boolean degeneration: with all capacities = 4, check ≡ 4 × reachability', () => {
    const boolTuplesArb = fc.array(
      tupleArb.map((t) => ({ ...t, resolution: 4 })),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(boolTuplesArb, (tuples) => {
        const db = withAcl(tuples);
        for (const s of PERSONS) {
          for (const o of TOPICS) {
            expect(check(db, s, o)).toBe(reachable(tuples, s, o) ? 4 : 0);
          }
        }
      }),
      { numRuns: 60 },
    );

    // Independent iterative reference (worklist instead of recursion).
    function reachable(tuples: RelationTuple[], subject: string, object: string): boolean {
      const frontier: Array<{ object: string; relation: string; depth: number }> = [
        { object, relation: 'viewer', depth: 0 },
      ];
      while (frontier.length > 0) {
        const cur = frontier.pop()!;
        if (cur.depth > 4) continue;
        for (const t of tuples) {
          if (t.object !== cur.object || t.relation !== cur.relation) continue;
          if (t.subject === subject) return true;
          const hash = t.subject.indexOf('#');
          if (hash > 0) {
            frontier.push({
              object: t.subject.slice(0, hash),
              relation: t.subject.slice(hash + 1),
              depth: cur.depth + 1,
            });
          }
        }
      }
      return false;
    }
  });

  it('forward/reverse consistency: lookupVisibleLayers ≡ per-atom resolutionForAtom', () => {
    const atomsArb = fc.array(
      fc.record({
        id: fc.constantFrom('a1', 'a2', 'a3'),
        topics: fc.uniqueArray(fc.constantFrom('t0', 't1'), { maxLength: 2 }),
      }),
      { maxLength: 3 },
    ).map((atoms) => atoms.filter((a, i) => atoms.findIndex((b) => b.id === a.id) === i));

    fc.assert(
      fc.property(tuplesArb, atomsArb, (tuples, atoms) => {
        const db = withAcl(tuples);
        for (const s of PERSONS) {
          const looked = lookupVisibleLayers(db, s, atoms);
          for (const atom of atoms) {
            const direct = resolutionForAtom(db, s, atom);
            expect(looked.get(atom.id) ?? 0).toBe(direct);
          }
        }
      }),
      { numRuns: 60 },
    );
  });
});
