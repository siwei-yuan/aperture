import type Database from 'better-sqlite3';
import type { Layer, Source } from './atom.js';
import type { VectorStore } from './embed.js';
import type { Ledger } from './ledger.js';
import { AclStore, type RelationTuple, type TupleRef } from './rebac.js';
import { AtomStore } from './store.js';

interface IngestedPayload {
  atomId: string;
  subject: string[];
  source: Source;
  acquisitionContext: string;
  topics: string[];
  layers: Layer[];
  quarantined: boolean;
}

/**
 * Rebuilds every projection from the ledger. Projections are caches of the
 * event log; this function is what makes that claim true — and testable.
 *
 * Replay must never append to the ledger, so it only touches projection
 * tables directly (via the stores' non-appending write paths).
 *
 * When a VectorStore is passed, vectors are truncated and re-embedded from
 * the ladders on the events (deterministic iff the embedder is). Without
 * one, the vectors table is left untouched.
 */
export async function rebuildProjections(
  ledger: Ledger,
  db: Database.Database,
  opts?: { vectors?: VectorStore },
): Promise<void> {
  const store = new AtomStore(db); // ensures tables exist
  const acl = new AclStore(db, ledger);
  db.exec('DELETE FROM layers; DELETE FROM atoms; DELETE FROM tuples;');
  opts?.vectors?.clear();

  for (const event of ledger.events()) {
    switch (event.type) {
      case 'atom.ingested': {
        const p = event.payload as IngestedPayload;
        store.insert({
          id: p.atomId,
          subject: p.subject,
          source: p.source,
          acquisitionContext: p.acquisitionContext,
          topics: p.topics,
          layers: p.layers,
          quarantined: p.quarantined,
        });
        if (opts?.vectors) await opts.vectors.index({ id: p.atomId, layers: p.layers });
        break;
      }
      case 'atom.approved': {
        const p = event.payload as { atomId: string };
        store.setQuarantined(p.atomId, false);
        break;
      }
      case 'acl.granted': {
        acl.applyGrant(event.payload as RelationTuple);
        break;
      }
      case 'acl.revoked': {
        acl.applyRevoke(event.payload as TupleRef);
        break;
      }
    }
  }
}
