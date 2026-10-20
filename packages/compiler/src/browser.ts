/**
 * `@seam/compiler/browser`: everything a browser Manifest Builder needs (live facts, supported kinds, argument
 * fields, compile, digests) with no node builtins. Same function objects as the main entry.
 * The pinned types file is not read here; pass its text in facts (needed only for metadata V13 and older).
 */
export * from "./facts-entry.js";
export {
  compile,
  computePlanDigest,
  computeManifestDigest,
  KIND_TO_CAPABILITY,
  BATCH_CAPABILITY,
  evaluateRollbackProof,
  supportedKinds,
  type KindAvailability,
} from "./compile.js";
export {
  argFields,
  checkManifest,
  type ArgField,
  type ArgFieldType,
  type ManifestCheck,
} from "./builder.js";
export { canonicalJson, digestJson, domainHash, DOMAIN } from "./canonical.js";
export { parseNativeAddress, parseH160, type NativeAddress } from "./address.js";
