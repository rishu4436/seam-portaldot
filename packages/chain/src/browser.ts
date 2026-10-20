import "./quiet.js"; // must stay first, like index.ts
/**
 * Browser-safe entry (`@seam/chain/browser`): the offline signature checks, the extrinsic assembler and the facts builder,
 * with no node builtins and no WebSocket client. From @seam/compiler it imports only the pure `@seam/compiler/facts` path
 * (the main compiler entry reads its pinned types file with node:fs). Everything here is pure: bytes in, verdict, facts or
 * bytes out. It never connects anywhere and never signs.
 * The node entry (`@seam/chain`) is unchanged and exports the same functions; tests/browser-entry.test.ts holds the two to the same behaviour.
 */
export { SeamChainError, type SeamChainErrorCode } from "./errors.js";
export {
  buildSigningRequest,
  buildSigningRequests,
  verifySignedAgainstRequest,
  verifySignedBatch,
  assembleSignedExtrinsic,
  extractSignedCall,
  signBytesOf,
  toMultiSignature,
  checkSignedExtrinsic,
  signedExtrinsicDecoder,
  type SigningRequest,
  type SigningCheckpoint,
  type SingleSigningInput,
  type SignerPayloadJSON,
  type SignedVerification,
  type SignedBatchVerification,
  type SignedMismatchCode,
  type AssembleOptions,
  type SignedCall,
  type SignatureScheme,
  type DecodedSignedExtrinsic,
  type EraInfo,
} from "./signing.js";
// Facts from chain inputs read by the browser (genesis hash, runtime version, metadata, properties, head). The same
// function as the node entry's pure core: identical inputs give identical RuntimeFacts, fingerprint digest and layout hash.
// No default types file: metadata V14+ needs none; V13 and older must be given `typesBundle` (fails closed otherwise).
export {
  factsFromChainInputs,
  fingerprintFromChainInputs,
  tokenInfo,
  type FactsOptions,
} from "./facts-core.js";
export type {
  ChainInputs,
  ChainPropertiesJson,
  RuntimeVersionJson,
  BlockRef,
  FreshFingerprint,
} from "./types.js";
// Live capabilities: per SEAM action, whether the connected runtime supports it (read-only, from its own metadata).
export {
  liveCapabilities,
  readLiveCapabilities,
  SEAM_ACTION_KINDS,
  ACTION_CAPABILITY,
  type SeamActionKind,
  type CapabilityReasonCode,
  type CapabilityPresence,
  type ActionArg,
  type ActionCapability,
  type LiveCapabilities,
} from "./live-capabilities.js";
export { clientFromSend, type RpcSend, type RpcClient } from "./rpc-core.js";
// Preflight: one implementation with the node entry (preflightWithClient), over a plain send. Read-only.
export { preflight, preflightReport } from "./preflight-browser.js";
export {
  preflightWithClient,
  fakeSignedExtrinsic,
  type PreflightCoreOptions,
  type PreflightReport,
  type PreflightTxDetail,
  type SimulationCoverage,
  type CoverageBasis,
  type V3PreflightInfo,
  type V3StepPreflight,
  type AccountMappingInfo,
} from "./preflight-core.js";
export type { Estimate, PreflightResult, PreflightStep } from "./types.js";
// Signing envelope (the one @seam/policy's gate and approval take) and block time from metadata: same functions as node.
export { blockTimeFromFacts, buildSigningEnvelope, type SigningEnvelopeInput } from "./envelope.js";
export type { SigningEnvelope } from "./types.js";
