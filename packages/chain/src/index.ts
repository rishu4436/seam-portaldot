import "./quiet.js"; // must stay first: sets the polkadot.js duplicate-package flag before any @polkadot import
export * from "./types.js";
export * from "./errors.js";
export { quietly } from "./quiet.js";
export { connect, withClient, type RpcClient, type Endpoint, type ConnectOptions } from "./rpc.js";
export {
  httpRpcClient,
  isIdempotentRead,
  READ_METHODS,
  READ_PREFIXES,
  type HttpRpcClient,
  type HttpRpcOptions,
} from "./http-transport.js";
export {
  discover,
  readChainInputs,
  factsFromChainInputs,
  fingerprintFromChainInputs,
  readFingerprint,
  refetchFingerprint,
  readCheckpoint,
  readSigningCheckpoint,
  listRpcMethods,
  signedExtensionsOf,
  snapshotFromNode,
  snapshotFromChainInputs,
  chainInputsFromSnapshot,
  tokenInfo,
  pinnedInputs,
  type DiscoverOptions,
  type FactsOptions,
  type SnapshotExtra,
  type SnapshotFiles,
} from "./discover.js";
export {
  metadataLayoutHash,
  sameMetadataLayout,
  blankStorageFallbacks,
  pinMetadata,
  METADATA_LAYOUT_DOMAIN,
  BLANKED_STORAGE_DEFAULTS,
  type MetadataDrift,
} from "./metadata-layout.js";
export {
  buildSigningRequests,
  buildSigningRequest,
  signingRequestsForCalls,
  callsForSigning,
  assembleSignedExtrinsic,
  extractSignedCall,
  signedCallsOf,
  checkSignedExtrinsic,
  toMultiSignature,
  signBytesOf,
  type SigningRequest,
  type SigningCheckpoint,
  type SingleSigningInput,
  type SignedCall,
  type SignedCheck,
  type EraInfo,
  type AssembleOptions,
  type SignatureScheme,
  type SignerPayloadJSON,
  type SignerPayloadRaw,
  verifySignedAgainstRequest,
  verifySignedBatch,
  signedExtrinsicDecoder,
  type DecodedSignedExtrinsic,
  type SignedVerification,
  type SignedBatchVerification,
  type SignedMismatchCode,
} from "./signing.js";
export {
  preflight,
  fakeSignedExtrinsic,
  type PreflightOptions,
  type PreflightReport,
  type PreflightTxDetail,
} from "./preflight.js";
export {
  decodeBlockEvents,
  outcomeForExtrinsic,
  argToString,
  toChainEvent,
  type ChainEvent,
  type DecodedEvent,
  type ExtrinsicOutcome,
} from "./events.js";
export {
  submitAndWatch,
  waitFinalized,
  readEvents,
  readInclusion,
  findExtrinsicIndex,
  PORTALDOT_MAINNET_GENESIS,
  type TxStatus,
  type StatusUpdate,
  type SubmitResult,
  type SubmitOptions,
  type InclusionResult,
  type FinalityResult,
} from "./submit.js";
export {
  DECODE_TYPES,
  SYSTEM_EVENTS_KEY,
  metadataVersionOf,
  storageKey,
  decodeRuntime,
  encodeRuntime,
  extrinsicHash,
  describeDispatchError,
} from "./runtime.js";
export {
  createPortaldotAdapter,
  toStepOutcome,
  blockTimeFromFacts,
  type PortaldotAdapter,
  type PortaldotAdapterOptions,
  type ChainAdapter,
  type StepOutcome,
  type WalletSigner,
} from "./adapter.js";
export { dryRunSigned, dryRunOne, type SignedDryRunDetail } from "./dryrun.js";
export { lookupExtrinsic, type TxLookup, type LookupOptions } from "./lookup.js";
export { checkSigningWindow, type WindowCheck, type WindowReason } from "./window.js";
export type {
  SimulationCoverage,
  CoverageBasis,
  V3PreflightInfo,
  V3StepPreflight,
  AccountMappingInfo,
} from "./preflight.js";
export { V3_PREFLIGHT_KINDS } from "./preflight.js";
export {
  discoverV3,
  capabilitiesFromModel,
  capabilitiesMarkdown,
  runtimeModelFromInputs,
  runtimeApiId,
  readOnlyClient,
  READ_ONLY_RPC_METHODS,
  type CapabilityStatus,
  type CapabilityEntry,
  type RuntimeModel,
  type V3Capabilities,
  type DiscoverV3Result,
} from "./capabilities.js";
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
export { clientFromSend, type RpcSend } from "./rpc-core.js";
export { preflightWithClient, type PreflightCoreOptions } from "./preflight-core.js";
export { preflightReport as preflightReportFromSend } from "./preflight-browser.js";
