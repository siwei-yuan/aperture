import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getSession, linkIdentity, resolveIdentity, sessionFor } from '../src/session/router.js';

describe('identity resolution and session routing', () => {
  it('unknown platform ids get fresh, distinct person nodes', () => {
    const db = new Database(':memory:');
    const p1 = resolveIdentity(db, 'telegram', 'U1');
    const p2 = resolveIdentity(db, 'telegram', 'U2');
    expect(p1).toMatch(/^person:/);
    expect(p1).not.toBe(p2);
    // stable on repeat lookups
    expect(resolveIdentity(db, 'telegram', 'U1')).toBe(p1);
  });

  it('linked identities resolve to the same person across platforms', () => {
    const db = new Database(':memory:');
    const alice = resolveIdentity(db, 'telegram', 'alice_tg');
    linkIdentity(db, 'wechat', 'alice_wx', alice);
    expect(resolveIdentity(db, 'wechat', 'alice_wx')).toBe(alice);
  });

  it('session id is stable per channel; audience refreshes on peer changes', () => {
    const db = new Database(':memory:');
    const s1 = sessionFor(db, { platform: 'telegram', channel: 'group:42', peerExternalIds: ['U1', 'U2'] });
    const s2 = sessionFor(db, { platform: 'telegram', channel: 'group:42', peerExternalIds: ['U1', 'U2', 'U3'] });

    expect(s2.id).toBe(s1.id);
    expect(s1.audience).toHaveLength(2);
    expect(s2.audience).toHaveLength(3);
    expect(getSession(db, s1.id)!.audience).toHaveLength(3);
  });

  it('different channels are different sessions even with the same peers', () => {
    const db = new Database(':memory:');
    const dm = sessionFor(db, { platform: 'telegram', channel: 'dm:U1', peerExternalIds: ['U1'] });
    const group = sessionFor(db, { platform: 'telegram', channel: 'group:42', peerExternalIds: ['U1'] });
    expect(dm.id).not.toBe(group.id);
  });
});
