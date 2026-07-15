/**
 * Aperture public API. Everything not exported here is an internal detail.
 */

// Memory atoms and the ladder invariant
export type { Layer, MemoryAtom, Source } from './core/atom.js';
export { MAX_LAYERS, validateLadder } from './core/entail.js';
export type { LadderCheck, LadderViolation } from './core/entail.js';

// The ledger (single source of truth) and projection replay
export { canonicalJson, Ledger } from './core/ledger.js';
export type { LedgerEvent } from './core/ledger.js';
export { rebuildProjections } from './core/replay.js';

// Stores (projections)
export { AtomStore } from './core/store.js';
export { cosine, hashEmbedder, httpEmbedder, VectorStore } from './core/embed.js';
export type { Embedder, KnnHit } from './core/embed.js';

// Resolution-typed ReBAC
export { AclStore, check, lookupVisibleLayers, resolutionForAtom } from './core/rebac.js';
export type { RelationTuple, TupleRef } from './core/rebac.js';

// Ingest (membrane, inbound)
export { approveAtom, IngestPipeline } from './core/ingest.js';
export type {
  IngestResult,
  LayerDraft,
  LayerGenerator,
  RawEvent,
  SemanticEntailment,
  SkipDecision,
} from './core/ingest.js';
export { capture } from './gen/capture.js';
export type { CaptureDeps, CaptureResult } from './gen/capture.js';
export { DEFAULT_PREFILTER, hamming64, prefilter, recordFingerprint, simhash64 } from './gen/prefilter.js';
export type { PrefilterConfig, PrefilterResult } from './gen/prefilter.js';
export { LlmLayerGenerator, SYSTEM_PROMPT } from './gen/llm-generator.js';
export type { LlmClient } from './gen/llm-generator.js';

// Retrieval (adjudication)
export { retrieve, retrieveForSession } from './core/retrieve.js';
export type { RetrieveDeps, RetrievedItem, RetrieveRequest } from './core/retrieve.js';

// Mosaic tracking (cumulative disclosure projection + budgets)
export { applyMosaicBudget, disclosureProfile } from './core/disclosure-profile.js';
export type { DisclosedAtom, MosaicConfig, WithheldItem } from './core/disclosure-profile.js';

// Egress (membrane, outbound)
export { checkEgress } from './core/egress.js';
export type { EgressDeps, EgressHit, EgressResult } from './core/egress.js';

// Knowledge-graph projection
export { ensureGraphTables, foldAtoms, invalidateEdge, resetGraph } from './graph/fold.js';
export type { ExtractedEntity, ExtractedFact, FactExtractor, FoldDeps } from './graph/fold.js';
export { neighbors } from './graph/query.js';
export type { EdgeView, GraphQueryDeps } from './graph/query.js';

// Owner CLI (also available programmatically)
export { runCli } from './cli.js';
export type { CliDeps } from './cli.js';

// Owner console (chat-native: model-bypassing commands + owner pushes)
export {
  handleOwnerCommand,
  newContactNotice,
  noteContact,
  quarantineNotice,
  shortId,
} from './console.js';
export type { ConsoleDeps, ConsoleResult } from './console.js';

// Sessions and TBAC scope
export {
  getSession,
  linkIdentity,
  narrowScope,
  peekIdentity,
  resolveIdentity,
  sessionFor,
  widenScope,
} from './session/router.js';
export type { Session } from './session/router.js';
