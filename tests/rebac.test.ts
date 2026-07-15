import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/core/ledger.js';
import { AclStore } from '../src/core/rebac.js';
import { rebuildProjections } from '../src/core/replay.js';

function makeAcl() {
  const db = new Database(':memory:');
  const ledger = new Ledger(db);
  const acl = new AclStore(db, ledger);
  return { db, ledger, acl };
}

function tupleRows(db: Database.Database): unknown[] {
  return db.prepare('SELECT * FROM tuples ORDER BY object, relation, subject').all();
}

describe('ACL tuple store as ledger projection', () => {
  it('grant/revoke round trip with ledger events', () => {
    const { db, ledger, acl } = makeAcl();

    acl.grant({ object: 'topic:activity', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
    acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:alice', resolution: 4 });
    expect(tupleRows(db)).toHaveLength(2);

    acl.revoke({ object: 'tier:friend', relation: 'member', subject: 'person:alice' });
    expect(tupleRows(db)).toHaveLength(1);

    expect([...ledger.events()].map((e) => e.type)).toEqual([
      'acl.granted',
      'acl.granted',
      'acl.revoked',
    ]);
    expect(ledger.verify().ok).toBe(true);
  });

  it('re-granting the same tuple updates its resolution (upsert)', () => {
    const { db, acl } = makeAcl();
    acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 2 });
    acl.grant({ object: 'topic:health', relation: 'viewer', subject: 'tier:friend#member', resolution: 0 });
    const rows = tupleRows(db) as Array<{ resolution: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolution).toBe(0);
  });

  it('rejects out-of-range resolutions', () => {
    const { acl } = makeAcl();
    expect(() =>
      acl.grant({ object: 'topic:x', relation: 'viewer', subject: 'person:bob', resolution: 5 }),
    ).toThrow(RangeError);
    expect(() =>
      acl.grant({ object: 'topic:x', relation: 'viewer', subject: 'person:bob', resolution: 2.5 }),
    ).toThrow(RangeError);
  });

  it('tuples table rebuilt from the ledger is row-for-row identical', () => {
    const { db, ledger, acl } = makeAcl();
    acl.grant({ object: 'topic:activity', relation: 'viewer', subject: 'tier:friend#member', resolution: 3 });
    acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:alice', resolution: 4 });
    acl.grant({ object: 'tier:friend', relation: 'member', subject: 'person:carol', resolution: 4 });
    acl.revoke({ object: 'tier:friend', relation: 'member', subject: 'person:carol' });
    acl.grant({ object: 'topic:activity', relation: 'viewer', subject: 'tier:friend#member', resolution: 2 });

    const before = tupleRows(db);
    db.exec('DELETE FROM tuples');
    rebuildProjections(ledger, db);

    expect(tupleRows(db)).toEqual(before);
    expect(ledger.verify().ok).toBe(true);
  });
});
