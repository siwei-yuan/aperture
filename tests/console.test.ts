import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  handleOwnerCommand,
  newContactNotice,
  noteContact,
  promotionNotice,
  type ConsoleDeps,
} from '../src/console.js';
import type { MemoryAtom } from '../src/core/atom.js';
import { Ledger } from '../src/core/ledger.js';
import { check } from '../src/core/rebac.js';
import { AtomStore } from '../src/core/store.js';
import { linkIdentity, resolveIdentity } from '../src/session/router.js';

const OWNER = 'person:owner';

function makeStack(): ConsoleDeps & { db: Database.Database } {
  const db = new Database(':memory:');
  const store = new AtomStore(db);
  const ledger = new Ledger(db);
  linkIdentity(db, 'telegram', 'owner_tg', OWNER);
  return { db, store, ledger, ownerId: OWNER };
}

function localAtom(id: string, who = 'person:bob'): MemoryAtom {
  return {
    id,
    subject: [who],
    source: { who, channel: 'telegram:group', ts: 1_000 },
    acquisitionContext: 'telegram:group',
    acquisitionAudience: [OWNER, who],
    topics: ['general'],
    layers: [{ level: 1, text: 'bob shared some news', entities: [] }],
    scope: 'local',
  };
}

const fromOwner = (text: string) => ({ platform: 'telegram', senderExternalId: 'owner_tg', text });
const fromBob = (text: string) => ({ platform: 'telegram', senderExternalId: 'bob_tg', text });

describe('owner gate', () => {
  it('commands from anyone but the owner are not commands, just words', () => {
    const deps = makeStack();
    deps.store.insert(localAtom('aaaa1111-0000-0000-0000-000000000000'));

    // No refusal reply either — a refusal would leak the command grammar.
    expect(handleOwnerCommand(deps, fromBob('/aperture pending'))).toEqual({ handled: false });
    expect(handleOwnerCommand(deps, fromBob('/aperture promote aaaa1111'))).toEqual({ handled: false });
    expect(deps.store.listLocal()).toHaveLength(1); // nothing promoted
  });

  it('non-command text passes through untouched, even from the owner', () => {
    const deps = makeStack();
    expect(handleOwnerCommand(deps, fromOwner('hello there'))).toEqual({ handled: false });
    expect(handleOwnerCommand(deps, fromOwner('/reset'))).toEqual({ handled: false }); // foreign command
    expect(handleOwnerCommand(deps, fromOwner('/apertureX'))).toEqual({ handled: false }); // not our root
  });

  it('bare /aperture (or an unknown subcommand) replies with help', () => {
    const deps = makeStack();
    const bare = handleOwnerCommand(deps, fromOwner('/aperture'));
    const unknown = handleOwnerCommand(deps, fromOwner('/aperture wat'));
    expect(bare.handled && bare.reply).toContain('owner console');
    expect(unknown.handled && unknown.reply).toContain('owner console');
  });
});

describe('pending, promote and seal', () => {
  it('lists room-local atoms with ready-made promote commands', () => {
    const deps = makeStack();
    deps.store.insert(localAtom('aaaa1111-0000-0000-0000-000000000000'));

    const res = handleOwnerCommand(deps, fromOwner('/aperture pending'));
    expect(res.handled && res.reply).toContain('/aperture promote aaaa1111');
    expect(res.handled && res.reply).toContain('bob shared some news');
  });

  it('promotes by short-id prefix and ledgers the promotion', () => {
    const deps = makeStack();
    deps.store.insert(localAtom('aaaa1111-0000-0000-0000-000000000000'));

    const res = handleOwnerCommand(deps, fromOwner('/aperture promote aaaa1111'));
    expect(res.handled && res.reply).toContain('promoted');
    expect(deps.store.listLocal()).toHaveLength(0);
    expect(deps.store.listGlobal()).toHaveLength(1);
    expect([...deps.ledger.events()].map((e) => e.type)).toContain('atom.promoted');
  });

  it('seals by short-id prefix — visible nowhere afterwards', () => {
    const deps = makeStack();
    deps.store.insert(localAtom('aaaa1111-0000-0000-0000-000000000000'));

    const res = handleOwnerCommand(deps, fromOwner('/aperture seal aaaa1111'));
    expect(res.handled && res.reply).toContain('sealed');
    expect(deps.store.listRetrievable()).toHaveLength(0);
    expect([...deps.ledger.events()].map((e) => e.type)).toContain('atom.sealed');
  });

  it('refuses ambiguous prefixes instead of guessing', () => {
    const deps = makeStack();
    deps.store.insert(localAtom('aaaa1111-0000-0000-0000-000000000000'));
    deps.store.insert(localAtom('aaaa2222-0000-0000-0000-000000000000'));

    const res = handleOwnerCommand(deps, fromOwner('/aperture promote aaaa'));
    expect(res.handled && res.reply).toContain('ambiguous');
    expect(deps.store.listLocal()).toHaveLength(2);
  });
});

describe('grant and revoke', () => {
  it('grants tier membership by platform ref, ledgered, and it feeds the ReBAC evaluator', () => {
    const deps = makeStack();
    const bob = resolveIdentity(deps.db, 'telegram', 'bob_tg');
    // tier policy signed beforehand: friends see L3 on topic:general
    handleOwnerCommand(deps, fromOwner('/aperture grant telegram:bob_tg friend'));

    const acl = [...deps.ledger.events()].filter((e) => e.type === 'acl.granted');
    expect(acl).toHaveLength(1);
    expect(acl[0]!.payload).toMatchObject({ object: 'tier:friend', relation: 'member', subject: bob });

    // widest-path: bob ∈ friend#member, friend capped at 3 ⇒ bob resolves 3
    deps.db
      .prepare('INSERT INTO tuples (object, relation, subject, resolution) VALUES (?, ?, ?, ?)')
      .run('topic:general', 'viewer', 'tier:friend#member', 3);
    expect(check(deps.db, bob, 'topic:general')).toBe(3);

    handleOwnerCommand(deps, fromOwner('/aperture revoke telegram:bob_tg friend'));
    expect(check(deps.db, bob, 'topic:general')).toBe(0);
  });

  it('resolves person:<prefix> refs from the alias table', () => {
    const deps = makeStack();
    const bob = resolveIdentity(deps.db, 'telegram', 'bob_tg');
    const res = handleOwnerCommand(deps, fromOwner(`/aperture grant ${bob.slice(0, 14)} friend`));
    expect(res.handled && res.reply).toContain('tier:friend');
  });
});

describe('notices', () => {
  it('promotion notice discloses only the coarsest layer and offers both verbs', () => {
    const text = promotionNotice({
      atomId: 'aaaa1111-0000-0000-0000-000000000000',
      summary: 'bob shared some news',
      score: 0.9,
    });
    expect(text).toContain('bob shared some news');
    expect(text).toContain('/aperture promote aaaa1111');
    expect(text).toContain('/aperture seal aaaa1111');
  });

  it('noteContact reports first sight exactly once', () => {
    const { db } = makeStack();
    const first = noteContact(db, 'telegram', 'carol_tg');
    const second = noteContact(db, 'telegram', 'carol_tg');
    expect(first.isNew).toBe(true);
    expect(second).toEqual({ personId: first.personId, isNew: false });
    expect(newContactNotice('telegram', 'carol_tg')).toContain('/aperture grant telegram:carol_tg');
  });
});
