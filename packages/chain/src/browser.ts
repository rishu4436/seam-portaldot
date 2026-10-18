import "./quiet.js"; // must stay first, like index.ts
/**
 * Browser-safe entry (`@seam/chain/browser`): the offline signature checks and the extrinsic assembler, with no node builtins,
 * no WebSocket client and no @seam/compiler runtime import (the compiler reads a file with node:fs at load time).
 * Everything here is pure: bytes in, verdict or bytes out. It never connects anywhere.
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
