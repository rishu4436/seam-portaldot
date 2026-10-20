import type { SignerPayloadJSON, SignerPayloadRaw } from "@polkadot/types/types";
import { hexToU8a, isHex, u8aConcat, u8aToHex } from "@polkadot/util";
import { blake2AsU8a, decodeAddress, encodeAddress, signatureVerify } from "@polkadot/util-crypto";
import type { Hex, Plan, RuntimeFacts } from "@seam/compiler";
import { SeamChainError } from "./errors.js";
import { encodeRuntime, extrinsicHash } from "./runtime.js";
import type { BlockRef, SigningEnvelope } from "./types.js";

export type { SignerPayloadJSON, SignerPayloadRaw };

/** Block the transaction's era is anchored to (use readCheckpoint() for the finalized head). */
export type SigningCheckpoint = BlockRef;

export interface EraInfo {
  mortal: boolean;
  /** Blocks the transaction stays valid for (0 when immortal). */
  period: number;
  /** checkpoint % period (0 when immortal). */
  phase: number;
  /** SCALE-encoded era as signed. */
  hex: Hex;
}

/** One transaction for the wallet to sign. An atomic plan gives one (the batch_all); a sequential plan gives one per step. */
export interface SigningRequest {
  /** Submission order, 0-based. */
  index: number;
  /** Plan steps this transaction carries. */
  actionIds: string[];
  /** Exact call bytes (equals the matching entry of @seam/policy callsToSign(plan)). */
  callHex: Hex;
  nonce: number;
  era: EraInfo;
  /** polkadot.js-extension compatible payload: pass to injector.signer.signPayload(payload). */
  payload: SignerPayloadJSON;
  /** For raw-signing wallets (Vault/QR, keyring). Do NOT use the extension's signRaw: it wraps data in <Bytes>. */
  raw: SignerPayloadRaw;
  /** SCALE signing payload: call ++ extra (era, nonce, tip) ++ additional signed (spec, tx version, genesis, block hash). */
  signingPayloadHex: Hex;
  /** Exact bytes the key signs: signingPayloadHex, or its blake2b-256 when longer than 256 bytes. */
  signBytesHex: Hex;
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

function accountIdOf(address: string): Hex {
  try {
    return u8aToHex(decodeAddress(isHex(address) ? hexToU8a(address) : address)) as Hex;
  } catch (e) {
    throw new SeamChainError(
      "ENVELOPE_INVALID",
      `not a valid account: ${address} (${(e as Error).message})`,
    );
  }
}

/** Calls the wallet must sign, with the plan steps each carries. Same order and bytes as @seam/policy callsToSign(). */
export function callsForSigning(plan: Plan): { actionIds: string[]; callHex: Hex }[] {
  if (plan.mode === "unavailable")
    throw new SeamChainError("PLAN_NOT_SIGNABLE", `plan is unavailable: ${plan.modeReason}`);
  if (plan.mode === "atomic_verified" || plan.mode === "atomic_unverified") {
    if (!plan.outerCall?.encodedCall)
      throw new SeamChainError("PLAN_NOT_SIGNABLE", `${plan.mode} plan has no outerCall to sign`);
    return [{ actionIds: plan.steps.map((s) => s.actionId), callHex: plan.outerCall.encodedCall }];
  }
  return plan.steps.map((s) => {
    if (!s.encodedCall)
      throw new SeamChainError("PLAN_NOT_SIGNABLE", `step ${s.actionId} has no encoded call`);
    return { actionIds: [s.actionId], callHex: s.encodedCall };
  });
}

export interface SingleSigningInput {
  signer: string;
  nonce: number;
  mortalityBlocks: number;
  checkpoint: SigningCheckpoint;
}

/** Builds the signing request for one call. Deterministic: same inputs give byte-identical output. Tip is always 0. */
export function buildSigningRequest(
  callHex: Hex,
  facts: RuntimeFacts,
  input: SingleSigningInput,
  meta: { index?: number; actionIds?: string[] } = {},
): SigningRequest {
  const { registry } = encodeRuntime(facts);
  const { nonce, mortalityBlocks, checkpoint } = input;
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw new SeamChainError(
      "ENVELOPE_INVALID",
      `nonce must be a non-negative integer, got ${nonce}`,
    );
  if (
    !Number.isSafeInteger(mortalityBlocks) ||
    mortalityBlocks < 4 ||
    mortalityBlocks > 65536 ||
    !isPow2(mortalityBlocks)
  ) {
    // polkadot.js would silently round other values; SEAM signs exactly what was approved.
    throw new SeamChainError(
      "ENVELOPE_INVALID",
      `mortalityBlocks must be a power of two from 4 to 65536, got ${mortalityBlocks}`,
    );
  }
  if (
    !Number.isSafeInteger(checkpoint.number) ||
    checkpoint.number < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.hash)
  ) {
    throw new SeamChainError(
      "ENVELOPE_INVALID",
      "checkpoint needs a block number and a 32-byte block hash",
    );
  }
  const call = registry.createType("Call", callHex);
  if (call.toHex() !== callHex.toLowerCase())
    throw new SeamChainError(
      "PLAN_NOT_SIGNABLE",
      "call bytes do not round-trip through the pinned runtime",
    );

  const accountId = accountIdOf(input.signer);
  const address = encodeAddress(accountId, facts.fingerprint.ss58Prefix);
  const era = registry.createType("ExtrinsicEra", {
    current: checkpoint.number,
    period: mortalityBlocks,
  });
  const signerPayload = registry.createType("SignerPayload", {
    address,
    blockHash: checkpoint.hash.toLowerCase(),
    blockNumber: checkpoint.number,
    era,
    genesisHash: facts.fingerprint.genesisHash,
    method: call.toHex(),
    nonce,
    runtimeVersion: {
      specVersion: facts.fingerprint.specVersion,
      transactionVersion: facts.fingerprint.transactionVersion,
    },
    signedExtensions: registry.signedExtensions,
    tip: 0,
    version: 4,
  });
  const payload = signerPayload.toPayload();
  const raw = signerPayload.toRaw();
  const signingPayload = hexToU8a(raw.data);
  const signBytes = signingPayload.length > 256 ? blake2AsU8a(signingPayload, 256) : signingPayload;
  const mortal = era.asMortalEra;
  return {
    index: meta.index ?? 0,
    actionIds: meta.actionIds ?? [],
    callHex: call.toHex() as Hex,
    nonce,
    era: {
      mortal: true,
      period: mortal.period.toNumber(),
      phase: mortal.phase.toNumber(),
      hex: era.toHex() as Hex,
    },
    payload,
    raw,
    signingPayloadHex: raw.data as Hex,
    signBytesHex: u8aToHex(signBytes) as Hex,
  };
}

/**
 * Signing handoff for a compiled plan. `envelope` is the policy's SigningEnvelope (signer, nonce,
 * mortalityBlocks, checkpoint, expiresAt); the era starts at envelope.checkpoint. Sequential plans get one
 * request per step with nonces envelope.nonce, +1, +2, ...; atomic plans get one request for outerCall.
 */
export function buildSigningRequests(
  plan: Plan,
  facts: RuntimeFacts,
  envelope: SigningEnvelope,
): SigningRequest[] {
  if (plan.fingerprintDigest !== facts.fingerprintDigest) {
    throw new SeamChainError(
      "FACTS_MISMATCH",
      "plan was compiled for a different runtime fingerprint than these facts",
    );
  }
  if (accountIdOf(envelope.signer) !== plan.signer.publicKey.toLowerCase()) {
    throw new SeamChainError("ENVELOPE_INVALID", "envelope signer is not the plan's signer");
  }
  return signingRequestsForCalls(callsForSigning(plan), facts, envelope);
}

/** Signing requests for explicit calls (e.g. the SDK's callsToSign(plan)), nonces envelope.nonce + i, era from envelope.checkpoint. */
export function signingRequestsForCalls(
  calls: (Hex | { actionIds: string[]; callHex: Hex })[],
  facts: RuntimeFacts,
  envelope: SigningEnvelope,
): SigningRequest[] {
  if (!envelope.checkpoint)
    throw new SeamChainError(
      "ENVELOPE_INVALID",
      "envelope has no checkpoint block to sign against",
    );
  return calls.map((c, i) => {
    const { actionIds, callHex } = typeof c === "string" ? { actionIds: [], callHex: c } : c;
    return buildSigningRequest(
      callHex,
      facts,
      {
        signer: envelope.signer,
        nonce: envelope.nonce + i,
        mortalityBlocks: envelope.mortalityBlocks,
        checkpoint: envelope.checkpoint,
      },
      { index: i, actionIds },
    );
  });
}

/**
 * The exact bytes a key signs for a SignerPayloadJSON: the SCALE payload, or its blake2b-256 when longer
 * than 256 bytes. What a polkadot.js extension's signPayload signs internally.
 */
export function signBytesOf(payload: SignerPayloadJSON, facts: RuntimeFacts): Hex {
  const { registry } = encodeRuntime(facts);
  const raw = registry
    .createType("SignerPayload", {
      ...payload,
      runtimeVersion: {
        specVersion: payload.specVersion,
        transactionVersion: payload.transactionVersion,
      },
    })
    .toRaw();
  const data = hexToU8a(raw.data);
  return u8aToHex(data.length > 256 ? blake2AsU8a(data, 256) : data) as Hex;
}

const SCHEMES = { ed25519: 0, sr25519: 1, ecdsa: 2 } as const;
export type SignatureScheme = keyof typeof SCHEMES;

/** Normalises a wallet signature to MultiSignature bytes (type byte + signature). */
export function toMultiSignature(signature: string, scheme?: SignatureScheme): Uint8Array {
  if (!isHex(signature))
    throw new SeamChainError("BAD_SIGNATURE", "signature must be 0x-prefixed hex");
  const sig = hexToU8a(signature);
  if (scheme) {
    if (sig.length !== (scheme === "ecdsa" ? 65 : 64))
      throw new SeamChainError(
        "BAD_SIGNATURE",
        `${scheme} signature has wrong length ${sig.length}`,
      );
    return u8aConcat([SCHEMES[scheme]], sig);
  }
  // Already typed (what polkadot.js extensions and keyring with withType return).
  if ((sig.length === 65 && (sig[0] === 0 || sig[0] === 1)) || (sig.length === 66 && sig[0] === 2))
    return sig;
  throw new SeamChainError(
    "BAD_SIGNATURE",
    `untyped ${sig.length}-byte signature: pass the scheme (sr25519, ed25519 or ecdsa); SEAM will not guess it`,
  );
}

export interface AssembleOptions {
  /** Scheme for an untyped 64/65-byte signature. Typed signatures need none. */
  scheme?: SignatureScheme;
  /** Check the signature against the payload before assembling. Default true. */
  verify?: boolean;
}

/**
 * Wallet signature + payload -> signed extrinsic hex, ready for submitAndWatch. Refuses a payload made for
 * another chain/runtime and, by default, a signature that does not verify against the payload.
 */
export function assembleSignedExtrinsic(
  payload: SignerPayloadJSON,
  signature: string,
  facts: RuntimeFacts,
  opts: AssembleOptions = {},
): Hex {
  const { registry } = encodeRuntime(facts);
  const fp = facts.fingerprint;
  const num = (v: string | number) => Number(BigInt(v));
  const problems: string[] = [];
  if (payload.genesisHash.toLowerCase() !== fp.genesisHash) problems.push("genesisHash");
  if (num(payload.specVersion) !== fp.specVersion) problems.push("specVersion");
  if (num(payload.transactionVersion) !== fp.transactionVersion)
    problems.push("transactionVersion");
  if (BigInt(payload.tip) !== 0n) problems.push("tip (SEAM always uses 0)");
  if (payload.signedExtensions.join(",") !== registry.signedExtensions.join(","))
    problems.push("signedExtensions");
  if (payload.version !== 4) problems.push("version");
  if (problems.length)
    throw new SeamChainError(
      "PAYLOAD_MISMATCH",
      `payload does not match the runtime facts: ${problems.join(", ")}`,
    );

  const multi = toMultiSignature(signature, opts.scheme);
  if (opts.verify !== false) {
    const message = hexToU8a(signBytesOf(payload, facts));
    if (!signatureVerify(message, multi, payload.address).isValid) {
      throw new SeamChainError(
        "BAD_SIGNATURE",
        `signature does not verify for ${payload.address} over this payload`,
      );
    }
  }
  const ext = registry.createType("Extrinsic", { method: payload.method }, { version: 4 });
  ext.addSignature(payload.address, multi, payload);
  return ext.toHex() as Hex;
}

export interface SignedCall {
  /** Exact call bytes inside the extrinsic. */
  callHex: Hex;
  /** 'Pallet.call_name' as named in the runtime metadata (e.g. 'Assets.transfer_keep_alive'). */
  capability: string;
  palletIndex: number;
  callIndex: number;
  signer: { accountId: Hex; ss58: string };
  nonce: number;
  era: EraInfo;
  tip: string;
  signature: Hex;
  signatureScheme: SignatureScheme;
  /** blake2b-256 of the extrinsic: the hash the node reports. */
  txHash: Hex;
  /** CheckMetadataHash mode as signed (0 Disabled, 1 Enabled); absent if the runtime has no such extension or it cannot be read. */
  metadataHashMode?: 0 | 1;
}

/** The CheckMetadataHash mode decoded from the extrinsic's own extension bytes, or undefined (fail closed). */
export function metadataHashModeOf(
  ext: unknown,
  signedExtensions: readonly string[],
): 0 | 1 | undefined {
  if (!signedExtensions.includes("CheckMetadataHash")) return undefined;
  try {
    const m = (ext as { inner: { signature: { mode?: { toNumber(): number } } } }).inner.signature
      .mode;
    const n = m?.toNumber();
    return n === 0 || n === 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** The typed MultiSignature (scheme byte + signature) of a signed polkadot.js extrinsic. */
function multiSignatureOf(ext: unknown): { type: string; toHex(): string } {
  return (ext as { inner: { signature: { multiSignature: { type: string; toHex(): string } } } })
    .inner.signature.multiSignature;
}

/** Reads what is actually inside a signed extrinsic, so the submit gate can compare it with the approved calls. */
export function extractSignedCall(extrinsicHex: string, facts: RuntimeFacts): SignedCall {
  const { registry } = encodeRuntime(facts);
  let ext;
  try {
    ext = registry.createType("Extrinsic", extrinsicHex);
  } catch (e) {
    throw new SeamChainError(
      "NOT_SIGNED",
      `not a valid extrinsic for this runtime: ${(e as Error).message}`,
    );
  }
  if (ext.toHex() !== extrinsicHex.toLowerCase())
    throw new SeamChainError("NOT_SIGNED", "extrinsic has trailing or non-canonical bytes");
  if (!ext.isSigned) throw new SeamChainError("NOT_SIGNED", "extrinsic is not signed");
  const callHex = ext.method.toHex() as Hex;
  const { section, method } = registry.findMetaCall(ext.callIndex);
  const pallet =
    facts.capabilities &&
    Object.entries(facts.capabilities).find(
      ([, c]) => c.palletIndex === ext.callIndex[0] && c.callIndex === ext.callIndex[1],
    );
  const accountId = u8aToHex(ext.signer.toU8a().slice(-32)) as Hex;
  const multi = multiSignatureOf(ext);
  const era = ext.era;
  const eraInfo: EraInfo = era.isMortalEra
    ? {
        mortal: true,
        period: era.asMortalEra.period.toNumber(),
        phase: era.asMortalEra.phase.toNumber(),
        hex: era.toHex() as Hex,
      }
    : { mortal: false, period: 0, phase: 0, hex: era.toHex() as Hex };
  return {
    callHex,
    capability: pallet ? pallet[0] : `${section}.${method}`,
    palletIndex: ext.callIndex[0]!,
    callIndex: ext.callIndex[1]!,
    signer: { accountId, ss58: encodeAddress(accountId, facts.fingerprint.ss58Prefix) },
    nonce: ext.nonce.toNumber(),
    era: eraInfo,
    tip: ext.tip.toBigInt().toString(),
    signature: multi.toHex() as Hex,
    signatureScheme: multi.type.toLowerCase() as SignatureScheme,
    txHash: extrinsicHash(extrinsicHex),
    ...(() => {
      const mode = metadataHashModeOf(ext, registry.signedExtensions);
      return mode === undefined ? {} : { metadataHashMode: mode };
    })(),
  };
}

/** For @seam/policy checkBeforeSubmit({ signedCalls }): the call bytes inside each signed extrinsic, in order. */
export function signedCallsOf(extrinsics: string[], facts: RuntimeFacts): Hex[] {
  return extrinsics.map((x) => extractSignedCall(x, facts).callHex);
}

export interface SignedCheck {
  ok: boolean;
  mismatches: {
    field: "call" | "signer" | "nonce" | "era" | "tip" | "signature";
    expected: string;
    actual: string;
  }[];
  signed?: SignedCall;
}

/**
 * Compares a signed extrinsic with the signing request it should answer: call bytes, signer, nonce, era,
 * tip, and that the signature verifies over the request's exact payload (so blockHash/genesis/spec match too).
 */
export function checkSignedExtrinsic(
  extrinsicHex: string,
  request: SigningRequest,
  facts: RuntimeFacts,
): SignedCheck {
  const s = extractSignedCall(extrinsicHex, facts);
  const mismatches: SignedCheck["mismatches"] = [];
  const cmp = (
    field: SignedCheck["mismatches"][number]["field"],
    expected: string,
    actual: string,
  ) => {
    if (expected.toLowerCase() !== actual.toLowerCase())
      mismatches.push({ field, expected, actual });
  };
  cmp("call", request.callHex, s.callHex);
  cmp("signer", accountIdOf(request.payload.address), s.signer.accountId);
  cmp("nonce", String(request.nonce), String(s.nonce));
  cmp("era", request.era.hex, s.era.hex);
  cmp("tip", "0", s.tip);
  // Verify over what this extrinsic actually carries (its call, era, nonce, tip) plus the request's chain
  // context (spec, tx version, genesis, era block hash): exactly what a node will check.
  const { registry } = encodeRuntime(facts);
  const p = request.payload;
  const actual = registry
    .createType(
      "ExtrinsicPayload",
      {
        method: s.callHex,
        era: s.era.hex,
        nonce: s.nonce,
        tip: s.tip,
        specVersion: p.specVersion,
        transactionVersion: p.transactionVersion,
        genesisHash: p.genesisHash,
        blockHash: p.blockHash,
      },
      { version: 4 },
    )
    .toU8a({ method: true });
  const message = actual.length > 256 ? blake2AsU8a(actual, 256) : actual;
  if (!signatureVerify(message, hexToU8a(s.signature), s.signer.accountId).isValid) {
    mismatches.push({
      field: "signature",
      expected: "valid over the extrinsic contents",
      actual: "does not verify",
    });
  }
  return { ok: mismatches.length === 0, mismatches, signed: s };
}

/** Precise, stable reason codes of verifySignedAgainstRequest. */
export type SignedMismatchCode =
  | "facts_missing"
  | "not_decodable"
  | "not_signed"
  | "signature_invalid"
  | "signer_mismatch"
  | "call_mismatch"
  | "nonce_mismatch"
  | "era_mismatch"
  | "era_immortal"
  | "tip_mismatch"
  | "genesis_mismatch"
  | "spec_version_mismatch"
  | "tx_version_mismatch"
  | "count_mismatch";

export interface SignedVerification {
  ok: boolean;
  /** The call bytes decoded from the signed extrinsic itself (never anything the wallet reported), or null if undecodable. */
  signedCall: Hex | null;
  signer: { accountId: Hex; ss58: string } | null;
  nonce: number | null;
  era: EraInfo | null;
  tip: string | null;
  /** The genesis hash the signature was checked against (the request's chain context); null if nothing was decoded. */
  genesis: Hex | null;
  /** Empty exactly when ok. Codes from SignedMismatchCode. */
  reasons: string[];
}

/**
 * SEAM-001. Decodes the ACTUAL signed extrinsic and checks it against the approved signing request. Never throws,
 * fails closed (ok false with reasons) on anything it cannot prove:
 * decodable and signed; signature valid over the extrinsic's own contents plus the request's chain context
 * (genesis, spec, tx version, era block hash); signer == request signer; call bytes == approved call; nonce; era
 * (mortal and equal to the request's checkpoint era); tip == 0; and the request's genesis/spec/tx version equal the
 * runtime facts in ctx. A wallet-provided `signedCall` is never consulted. `ctx.facts` is required: without it
 * nothing can be decoded and the result is `facts_missing`.
 */
export function verifySignedAgainstRequest(
  signedTx: string,
  request: SigningRequest,
  ctx?: { facts?: RuntimeFacts },
): SignedVerification {
  const empty: SignedVerification = {
    ok: false,
    signedCall: null,
    signer: null,
    nonce: null,
    era: null,
    tip: null,
    genesis: null,
    reasons: [],
  };
  const facts = ctx?.facts;
  if (!facts) return { ...empty, reasons: ["facts_missing"] };
  let s: SignedCall;
  try {
    s = extractSignedCall(signedTx, facts);
  } catch (e) {
    const notSigned = e instanceof SeamChainError && /not signed/.test(e.message);
    return { ...empty, reasons: [notSigned ? "not_signed" : "not_decodable"] };
  }
  const reasons = new Set<string>();
  const p = request.payload;
  const fp = facts.fingerprint;
  try {
    if (accountIdOf(p.address) !== s.signer.accountId.toLowerCase()) reasons.add("signer_mismatch");
  } catch {
    reasons.add("signer_mismatch");
  }
  if (s.callHex.toLowerCase() !== request.callHex.toLowerCase()) reasons.add("call_mismatch");
  if (s.nonce !== request.nonce) reasons.add("nonce_mismatch");
  if (!s.era.mortal) {
    reasons.add("era_immortal");
    reasons.add("era_mismatch");
  } else if (s.era.hex.toLowerCase() !== request.era.hex.toLowerCase()) reasons.add("era_mismatch");
  if (s.tip !== "0") reasons.add("tip_mismatch");
  // The request must itself be for this chain and runtime; the signature then proves the wallet signed for it.
  if (p.genesisHash.toLowerCase() !== fp.genesisHash.toLowerCase()) reasons.add("genesis_mismatch");
  if (Number(BigInt(p.specVersion)) !== fp.specVersion) reasons.add("spec_version_mismatch");
  if (Number(BigInt(p.transactionVersion)) !== fp.transactionVersion)
    reasons.add("tx_version_mismatch");
  try {
    const { registry } = encodeRuntime(facts);
    const actual = registry
      .createType(
        "ExtrinsicPayload",
        {
          method: s.callHex,
          era: s.era.hex,
          nonce: s.nonce,
          tip: s.tip,
          specVersion: p.specVersion,
          transactionVersion: p.transactionVersion,
          genesisHash: p.genesisHash,
          blockHash: p.blockHash,
        },
        { version: 4 },
      )
      .toU8a({ method: true });
    const message = actual.length > 256 ? blake2AsU8a(actual, 256) : actual;
    if (!signatureVerify(message, hexToU8a(s.signature), s.signer.accountId).isValid)
      reasons.add("signature_invalid");
  } catch {
    reasons.add("signature_invalid");
  }
  return {
    ok: reasons.size === 0,
    signedCall: s.callHex,
    signer: s.signer,
    nonce: s.nonce,
    era: s.era,
    tip: s.tip,
    genesis: p.genesisHash.toLowerCase() as Hex,
    reasons: [...reasons],
  };
}

export interface SignedBatchVerification {
  ok: boolean;
  reasons: string[];
  results: SignedVerification[];
}

/** Verifies a whole set: exactly one signed transaction per request, in request order (fewer, extra or reordered fail closed). */
export function verifySignedBatch(
  signedTxs: string[],
  requests: SigningRequest[],
  ctx?: { facts?: RuntimeFacts },
): SignedBatchVerification {
  const reasons: string[] = [];
  if (signedTxs.length !== requests.length) reasons.push("count_mismatch");
  const results = requests
    .slice(0, Math.min(requests.length, signedTxs.length))
    .map((r, i) => verifySignedAgainstRequest(signedTxs[i]!, r, ctx));
  results.forEach((r, i) => {
    if (!r.ok) reasons.push(...r.reasons.map((x) => `step_${i}:${x}`));
  });
  return { ok: reasons.length === 0, reasons, results };
}

/** What @seam/policy's checkBeforeSubmit({ decodeSignedExtrinsic }) expects from a trusted decoder (SEAM-001, Bot 3). */
export interface DecodedSignedExtrinsic {
  /** The call bytes inside the extrinsic, decoded from the extrinsic itself. */
  call: Hex;
  signer: string;
  nonce?: number;
  tip?: string;
  /** The genesis hash the signature verifies against; only set when it does. */
  genesisHash?: Hex;
  /** True only if the signature verifies for the signer over the extrinsic's contents and a known request's chain context. */
  signatureValid: boolean;
  /** Extra reporting for evidence: the era as signed. */
  era?: EraInfo;
  /** CheckMetadataHash mode from the extension bytes (0 Disabled, 1 Enabled); absent when it cannot be decoded. */
  metadataHashMode?: 0 | 1;
}

/**
 * The chain context of an approved signing envelope (e.g. @seam/policy's SigningEnvelope): the checkpoint block the mortal
 * era was built from. Genesis, spec and transaction version come from the facts. Signer and nonce are NOT taken from
 * here; checkBeforeSubmit compares them to the envelope itself.
 */
export interface SignatureContext {
  checkpoint: { hash: string };
}

function envelopeContext(
  ctx: SignatureContext,
  facts: RuntimeFacts,
  s: SignedCall,
): Pick<SigningRequest, "nonce" | "payload">[] {
  const hash = ctx?.checkpoint?.hash;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return []; // fail closed: nothing verifies
  const fp = facts.fingerprint;
  return [
    {
      nonce: s.nonce,
      payload: {
        address: s.signer.ss58,
        specVersion: fp.specVersion,
        transactionVersion: fp.transactionVersion,
        genesisHash: fp.genesisHash,
        // An immortal era signs against genesis; a mortal one against its checkpoint block.
        blockHash: (s.era.mortal ? hash : fp.genesisHash) as Hex,
      } as unknown as SigningRequest["payload"],
    },
  ];
}

/**
 * Builds the trusted decoder for checkBeforeSubmit. Pass the approved signing requests: they supply the chain
 * context a signature commits to (genesis, spec, tx version, era block hash), which the extrinsic itself does not
 * carry. The returned function never trusts wallet-provided values: it decodes the extrinsic, and signatureValid is
 * true only if the signature verifies under the context of an approved request with the same signer and nonce.
 * Instead of the requests, the approved envelope ({ checkpoint: { hash } }) can be passed: the payload is then rebuilt
 * from the extrinsic's own call, era, nonce and tip plus the facts' genesis, spec and transaction version.
 * With neither (the default), no signature can be checked and signatureValid is always false (the gate blocks).
 * Returns null when the bytes are not a decodable signed extrinsic (the gate then fails closed). Never throws.
 */
export function signedExtrinsicDecoder(
  facts: RuntimeFacts,
  context: SigningRequest[] | SignatureContext = [],
): (extrinsic: Hex) => DecodedSignedExtrinsic | null {
  return (extrinsic: Hex) => {
    let s: SignedCall;
    try {
      s = extractSignedCall(extrinsic, facts);
    } catch {
      return null;
    }
    const { registry } = encodeRuntime(facts);
    let signatureValid = false;
    let genesisHash: Hex | undefined;
    const requests: Pick<SigningRequest, "nonce" | "payload">[] = Array.isArray(context)
      ? context
      : envelopeContext(context, facts, s);
    // Mode 1 commits to a metadata digest SEAM never signs with and cannot rebuild here: never call it valid.
    for (const r of s.metadataHashMode === 1 ? [] : requests) {
      const p = r.payload;
      try {
        if (accountIdOf(p.address) !== s.signer.accountId.toLowerCase() || r.nonce !== s.nonce)
          continue;
        const bytes = registry
          .createType(
            "ExtrinsicPayload",
            {
              method: s.callHex,
              era: s.era.hex,
              nonce: s.nonce,
              tip: s.tip,
              specVersion: p.specVersion,
              transactionVersion: p.transactionVersion,
              genesisHash: p.genesisHash,
              blockHash: p.blockHash,
            },
            { version: 4 },
          )
          .toU8a({ method: true });
        const message = bytes.length > 256 ? blake2AsU8a(bytes, 256) : bytes;
        if (signatureVerify(message, hexToU8a(s.signature), s.signer.accountId).isValid) {
          signatureValid = true;
          genesisHash = p.genesisHash.toLowerCase() as Hex;
          break;
        }
      } catch {
        /* try the next request */
      }
    }
    return {
      call: s.callHex,
      signer: s.signer.ss58,
      nonce: s.nonce,
      tip: s.tip,
      era: s.era,
      signatureValid,
      ...(genesisHash ? { genesisHash } : {}),
      ...(s.metadataHashMode === undefined ? {} : { metadataHashMode: s.metadataHashMode }),
    };
  };
}
