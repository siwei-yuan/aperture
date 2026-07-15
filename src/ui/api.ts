import type Database from 'better-sqlite3';
import { disclosureProfile } from '../core/disclosure-profile.js';
import type { Ledger } from '../core/ledger.js';
import { check, type AclStore, type RelationTuple } from '../core/rebac.js';
import type { AtomStore } from '../core/store.js';
import { ensureSessionTables } from '../session/router.js';

/**
 * Read-projection assembly for the owner UI. Everything here is a pure
 * read: explicit values come straight from the tuples table (the same
 * only-read enumeration the CLI performs), effective values are computed
 * with the real `check()` evaluator — the UI never re-implements policy
 * semantics, so it can never disagree with retrieval.
 */

export interface UiDeps {
  db: Database.Database;
  ledger: Ledger;
  store: AtomStore;
  acl: AclStore;
  ownerId: string;
}

export interface PersonInfo {
  personId: string;
  aliases: Array<{ platform: string; externalId: string }>;
  tiers: string[];
  isOwner: boolean;
}

export interface MatrixCell {
  /** Resolution of the explicit tuple, if one exists for this exact (object, subject). */
  explicit: number | null;
  /** What check() actually evaluates to — the value retrieval will use. */
  effective: number;
  /** For derived person cells: the tier path contributing the effective value. */
  derivedFrom: string | null;
}

export interface UiState {
  ownerId: string;
  headSeq: number;
  people: PersonInfo[];
  tiers: Array<{ name: string; members: string[] }>;
  topics: Array<{ name: string; atomCount: number }>;
  matrix: {
    tierRows: Array<{ tier: string; cells: Record<string, MatrixCell> }>;
    personRows: Array<{ personId: string; tiers: string[]; cells: Record<string, MatrixCell> }>;
  };
  pending: Array<{ atomId: string; who: string; channel: string; ts: number; topics: string[]; summary: string }>;
}

export function headSeq(db: Database.Database): number {
  const row = db.prepare('SELECT max(seq) AS seq FROM ledger').get() as { seq: number | null };
  return row.seq ?? 0;
}

function tupleRows(db: Database.Database): RelationTuple[] {
  return db.prepare('SELECT object, relation, subject, resolution FROM tuples').all() as RelationTuple[];
}

export function buildState(deps: UiDeps): UiState {
  const { db, store, ownerId } = deps;
  ensureSessionTables(db);
  const tuples = tupleRows(db);

  // --- tiers: no registry — a tier exists iff a member or policy tuple names it
  const tierNames = new Set<string>();
  const membersOf = new Map<string, string[]>();
  for (const t of tuples) {
    if (t.relation === 'member' && t.object.startsWith('tier:')) {
      const name = t.object.slice('tier:'.length);
      tierNames.add(name);
      const list = membersOf.get(name) ?? [];
      list.push(t.subject);
      membersOf.set(name, list);
    }
    if (t.relation === 'viewer' && t.subject.startsWith('tier:') && t.subject.endsWith('#member')) {
      tierNames.add(t.subject.slice('tier:'.length, -'#member'.length));
    }
  }
  const tiers = [...tierNames].sort().map((name) => ({ name, members: (membersOf.get(name) ?? []).sort() }));

  // --- people: alias table ∪ member-tuple subjects ∪ the owner
  const aliasRows = db
    .prepare('SELECT platform, external_id, person_id FROM aliases ORDER BY platform, external_id')
    .all() as Array<{ platform: string; external_id: string; person_id: string }>;
  const personIds = new Set<string>([ownerId]);
  for (const a of aliasRows) personIds.add(a.person_id);
  for (const t of tuples) if (t.subject.startsWith('person:')) personIds.add(t.subject);
  const people: PersonInfo[] = [...personIds].sort().map((personId) => ({
    personId,
    aliases: aliasRows
      .filter((a) => a.person_id === personId)
      .map((a) => ({ platform: a.platform, externalId: a.external_id })),
    tiers: tiers.filter((t) => t.members.includes(personId)).map((t) => t.name),
    isOwner: personId === ownerId,
  }));

  // --- topics: policy objects ∪ atom topics (both directions of the gap matter)
  const atomTopicCounts = new Map<string, number>();
  for (const atom of store.listRetrievable()) {
    for (const topic of atom.topics) atomTopicCounts.set(topic, (atomTopicCounts.get(topic) ?? 0) + 1);
  }
  const topicNames = new Set<string>(atomTopicCounts.keys());
  for (const t of tuples) if (t.object.startsWith('topic:')) topicNames.add(t.object.slice('topic:'.length));
  const topics = [...topicNames].sort().map((name) => ({ name, atomCount: atomTopicCounts.get(name) ?? 0 }));

  // --- matrix
  const explicitFor = (object: string, subject: string): number | null => {
    const hit = tuples.find((t) => t.object === object && t.relation === 'viewer' && t.subject === subject);
    return hit ? hit.resolution : null;
  };

  const tierRows = tiers.map(({ name }) => {
    const subject = `tier:${name}#member`;
    const cells: Record<string, MatrixCell> = {};
    for (const { name: topic } of topics) {
      const object = `topic:${topic}`;
      const explicit = explicitFor(object, subject);
      const effective = check(db, subject, object);
      cells[topic] = { explicit, effective, derivedFrom: null };
    }
    return { tier: name, cells };
  });

  // Exception rows: only people with at least one direct topic tuple (plus the
  // owner, whose grants are direct by convention).
  const directSubjects = new Set(
    tuples
      .filter((t) => t.relation === 'viewer' && t.object.startsWith('topic:') && t.subject.startsWith('person:'))
      .map((t) => t.subject),
  );
  const personRows = people
    .filter((p) => directSubjects.has(p.personId))
    .map((p) => {
      const cells: Record<string, MatrixCell> = {};
      for (const { name: topic } of topics) {
        const object = `topic:${topic}`;
        const explicit = explicitFor(object, p.personId);
        const effective = check(db, p.personId, object);
        cells[topic] = {
          explicit,
          effective,
          derivedFrom: explicit === null && effective > 0 ? derivationSource(db, tuples, p, object, effective) : null,
        };
      }
      return { personId: p.personId, tiers: p.tiers, cells };
    });

  return {
    ownerId,
    headSeq: headSeq(db),
    people,
    tiers,
    topics,
    matrix: { tierRows, personRows },
    pending: store.listLocal().map((a) => ({
      atomId: a.id,
      who: a.source.who,
      channel: a.source.channel,
      ts: a.source.ts,
      topics: a.topics,
      summary: a.layers[0]?.text ?? '',
    })),
  };
}

/**
 * Which tier path yields the effective value for a derived person cell?
 * Mirrors the evaluator: a userset tuple (topic, viewer, tier:X#member, r)
 * contributes min(r, check(person reachable via tier:X#member)).
 */
function derivationSource(
  db: Database.Database,
  tuples: RelationTuple[],
  person: PersonInfo,
  object: string,
  effective: number,
): string | null {
  for (const t of tuples) {
    if (t.object !== object || t.relation !== 'viewer') continue;
    const hash = t.subject.indexOf('#');
    if (hash <= 0) continue;
    const via = check(db, person.personId, t.subject.slice(0, hash), t.subject.slice(hash + 1));
    if (via > 0 && Math.min(t.resolution, via) === effective) return t.subject;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reverse view: "what does this person know about me, as of the ledger"
// ---------------------------------------------------------------------------

export interface ViewerReport {
  viewer: string;
  summary: { atomCount: number; deepCount: number; topicCount: number; lastTs: number | null };
  knownAtoms: Array<{
    atomId: string;
    topics: string[];
    seenLevel: number;
    ladderDepth: number;
    seenText: string;
    hiddenDeeper: number;
    /** Full ladder — the owner may expand; the default rendering stops at seenLevel. */
    layers: Array<{ level: number; text: string }>;
    firstTs: number;
  }>;
  timeline: Array<{
    seq: number;
    ts: number;
    kind: 'adjudicated' | 'throttled' | 'escalated';
    items: Array<{ atomId: string; level: number; text: string; topics: string[] }>;
    detail: string | null;
  }>;
}

export function viewerReport(deps: UiDeps, viewer: string): ViewerReport {
  const { ledger, store } = deps;
  const profile = disclosureProfile(ledger, viewer);

  const layerText = (atomId: string, level: number): { text: string; topics: string[] } => {
    const atom = store.get(atomId);
    if (!atom) return { text: '(atom missing)', topics: [] };
    const clamped = Math.min(level, atom.layers.length);
    return { text: atom.layers[clamped - 1]?.text ?? '', topics: atom.topics };
  };

  const knownAtoms = [...profile.entries()]
    .map(([atomId, info]) => {
      const atom = store.get(atomId);
      const ladderDepth = atom?.layers.length ?? 0;
      const seenLevel = Math.min(info.maxLevel, ladderDepth || info.maxLevel);
      return {
        atomId,
        topics: atom?.topics ?? [],
        seenLevel,
        ladderDepth,
        seenText: atom?.layers[seenLevel - 1]?.text ?? '(atom missing)',
        hiddenDeeper: Math.max(0, ladderDepth - seenLevel),
        layers: (atom?.layers ?? []).map((l) => ({ level: l.level, text: l.text })),
        firstTs: info.firstTs,
      };
    })
    .sort((a, b) => b.firstTs - a.firstTs);

  const topicSet = new Set(knownAtoms.flatMap((a) => a.topics));

  const timeline: ViewerReport['timeline'] = [];
  for (const event of ledger.events()) {
    if (event.type === 'disclosure.adjudicated') {
      const p = event.payload as { audience: string[]; injected?: Array<{ atomId: string; level: number }> };
      if (!p.audience.includes(viewer)) continue;
      timeline.push({
        seq: event.seq,
        ts: event.ts,
        kind: 'adjudicated',
        items: (p.injected ?? []).map((i) => ({ atomId: i.atomId, level: i.level, ...layerText(i.atomId, i.level) })),
        detail: (p.injected ?? []).length === 0 ? 'asked — nothing was disclosable' : null,
      });
    } else if (event.type === 'disclosure.throttled') {
      const p = event.payload as {
        audience: string[];
        withheld: Array<{ atomId: string; level: number; topic: string; viewer: string }>;
      };
      if (!p.audience.includes(viewer)) continue;
      timeline.push({
        seq: event.seq,
        ts: event.ts,
        kind: 'throttled',
        items: p.withheld.map((w) => ({ atomId: w.atomId, level: w.level, text: '(withheld)', topics: [w.topic] })),
        detail: 'mosaic budget withheld these',
      });
    } else if (event.type === 'disclosure.request') {
      const p = event.payload as { audience: string[]; hits?: Array<{ kind: string }> };
      if (!p.audience.includes(viewer)) continue;
      timeline.push({
        seq: event.seq,
        ts: event.ts,
        kind: 'escalated',
        items: [],
        detail: `egress escalation — ${p.hits?.length ?? 0} hit(s), reply escrowed`,
      });
    }
  }
  timeline.reverse();

  return {
    viewer,
    summary: {
      atomCount: knownAtoms.length,
      deepCount: knownAtoms.filter((a) => a.seenLevel >= 3).length,
      topicCount: topicSet.size,
      lastTs: timeline[0]?.ts ?? null,
    },
    knownAtoms,
    timeline,
  };
}

function topicNames(deps: UiDeps): string[] {
  const names = new Set<string>();
  for (const atom of deps.store.listRetrievable()) for (const t of atom.topics) names.add(t);
  for (const t of tupleRows(deps.db)) if (t.object.startsWith('topic:')) names.add(t.object.slice('topic:'.length));
  return [...names].sort();
}

/** Audit mode: one person's effective resolution on every topic — check() verbatim. */
export function effectiveRow(deps: UiDeps, person: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const topic of topicNames(deps)) out[topic] = check(deps.db, person, `topic:${topic}`);
  return out;
}

class Rollback extends Error {}

/**
 * The confirmation card's per-topic diff for a hypothetical tier move.
 * The move is applied projection-only inside a transaction that always
 * rolls back — no ledger event, no observable state change; the numbers
 * come from the real evaluator against the hypothetical tuple set.
 */
export function movePreview(
  deps: UiDeps,
  person: string,
  from: string | null,
  to: string,
): Array<{ topic: string; before: number; after: number }> {
  const topics = topicNames(deps);
  const before = topics.map((t) => check(deps.db, person, `topic:${t}`));
  let after: number[] = [];
  const tx = deps.db.transaction(() => {
    if (from) deps.acl.applyRevoke({ object: `tier:${from}`, relation: 'member', subject: person });
    deps.acl.applyGrant({ object: `tier:${to}`, relation: 'member', subject: person, resolution: 4 });
    after = topics.map((t) => check(deps.db, person, `topic:${t}`));
    throw new Rollback();
  });
  try {
    tx();
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return topics.map((topic, i) => ({ topic, before: before[i]!, after: after[i]! }));
}

/**
 * Tier move = the sequential composition of the two existing primitives
 * (revoke old membership, grant new), exactly what the design doc fixes:
 * two honest ledger events, no synthetic transaction. A failure between
 * the two leaves the strictly-safer "out but not yet in" state.
 */
export function tierMove(acl: AclStore, person: string, from: string | null, to: string): void {
  if (from) acl.revoke({ object: `tier:${from}`, relation: 'member', subject: person });
  acl.grant({ object: `tier:${to}`, relation: 'member', subject: person, resolution: 4 });
}
