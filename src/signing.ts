import type { SignerPayloadJSON, SignerPayloadRaw } from '@polkadot/types/types';
import { hexToU8a, isHex, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, decodeAddress, encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import type { Hex, Plan, RuntimeFacts } from '@seam/compiler';
import { SeamChainError } from './errors.js';
import { encodeRuntime, extrinsicHash } from './runtime.js';
import type { BlockRef, SigningEnvelope } from './types.js';

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
    throw new SeamChainError('ENVELOPE_INVALID', `not a valid account: ${address} (${(e as Error).message})`);
  }
}

/** Calls the wallet must sign, with the plan steps each carries. Same order and bytes as @seam/policy callsToSign(). */
export function callsForSigning(plan: Plan): { actionIds: string[]; callHex: Hex }[] {
  if (plan.mode === 'unavailable') throw new SeamChainError('PLAN_NOT_SIGNABLE', `plan is unavailable: ${plan.modeReason}`);
  if (plan.mode === 'atomic_verified' || plan.mode === 'atomic_unverified') {
    if (!plan.outerCall?.encodedCall) throw new SeamChainError('PLAN_NOT_SIGNABLE', `${plan.mode} plan has no outerCall to sign`);
    return [{ actionIds: plan.steps.map((s) => s.actionId), callHex: plan.outerCall.encodedCall }];
  }
  return plan.steps.map((s) => {
    if (!s.encodedCall) throw new SeamChainError('PLAN_NOT_SIGNABLE', `step ${s.actionId} has no encoded call`);
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
export function buildSigningRequest(callHex: Hex, facts: RuntimeFacts, input: SingleSigningInput, meta: { index?: number; actionIds?: string[] } = {}): SigningRequest {
  const { registry } = encodeRuntime(facts);
  const { nonce, mortalityBlocks, checkpoint } = input;
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new SeamChainError('ENVELOPE_INVALID', `nonce must be a non-negative integer, got ${nonce}`);
  if (!Number.isSafeInteger(mortalityBlocks) || mortalityBlocks < 4 || mortalityBlocks > 65536 || !isPow2(mortalityBlocks)) {
    // polkadot.js would silently round other values; SEAM signs exactly what was approved.
    throw new SeamChainError('ENVELOPE_INVALID', `mortalityBlocks must be a power of two from 4 to 65536, got ${mortalityBlocks}`);
  }
  if (!Number.isSafeInteger(checkpoint.number) || checkpoint.number < 0 || !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.hash)) {
    throw new SeamChainError('ENVELOPE_INVALID', 'checkpoint needs a block number and a 32-byte block hash');
  }
  const call = registry.createType('Call', callHex);
  if (call.toHex() !== callHex.toLowerCase()) throw new SeamChainError('PLAN_NOT_SIGNABLE', 'call bytes do not round-trip through the pinned runtime');

  const accountId = accountIdOf(input.signer);
  const address = encodeAddress(accountId, facts.fingerprint.ss58Prefix);
  const era = registry.createType('ExtrinsicEra', { current: checkpoint.number, period: mortalityBlocks });
  const signerPayload = registry.createType('SignerPayload', {
    address,
    blockHash: checkpoint.hash.toLowerCase(),
    blockNumber: checkpoint.number,
    era,
    genesisHash: facts.fingerprint.genesisHash,
    method: call.toHex(),
    nonce,
    runtimeVersion: { specVersion: facts.fingerprint.specVersion, transactionVersion: facts.fingerprint.transactionVersion },
    signedExtensions: registry.signedExtensions,
    tip: 0,
    version: 4
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
    era: { mortal: true, period: mortal.period.toNumber(), phase: mortal.phase.toNumber(), hex: era.toHex() as Hex },
    payload,
    raw,
    signingPayloadHex: raw.data as Hex,
    signBytesHex: u8aToHex(signBytes) as Hex
  };
}

/**
 * Signing handoff for a compiled plan. `envelope` is the policy's SigningEnvelope (signer, nonce,
 * mortalityBlocks, expiresAt); `checkpoint` is the block the era starts at. Sequential plans get one
 * request per step with nonces envelope.nonce, +1, +2, ...; atomic plans get one request for outerCall.
 */
export function buildSigningRequests(plan: Plan, facts: RuntimeFacts, envelope: SigningEnvelope, checkpoint: SigningCheckpoint): SigningRequest[] {
  if (plan.fingerprintDigest !== facts.fingerprintDigest) {
    throw new SeamChainError('FACTS_MISMATCH', 'plan was compiled for a different runtime fingerprint than these facts');
  }
  if (accountIdOf(envelope.signer) !== plan.signer.publicKey.toLowerCase()) {
    throw new SeamChainError('ENVELOPE_INVALID', "envelope signer is not the plan's signer");
  }
  return callsForSigning(plan).map((c, i) =>
    buildSigningRequest(c.callHex, facts, { signer: envelope.signer, nonce: envelope.nonce + i, mortalityBlocks: envelope.mortalityBlocks, checkpoint }, { index: i, actionIds: c.actionIds })
  );
}

const SCHEMES = { ed25519: 0, sr25519: 1, ecdsa: 2 } as const;
export type SignatureScheme = keyof typeof SCHEMES;

/** Normalises a wallet signature to MultiSignature bytes (type byte + signature). */
export function toMultiSignature(signature: string, scheme?: SignatureScheme): Uint8Array {
  if (!isHex(signature)) throw new SeamChainError('BAD_SIGNATURE', 'signature must be 0x-prefixed hex');
  const sig = hexToU8a(signature);
  if (scheme) {
    if (sig.length !== (scheme === 'ecdsa' ? 65 : 64)) throw new SeamChainError('BAD_SIGNATURE', `${scheme} signature has wrong length ${sig.length}`);
    return u8aConcat([SCHEMES[scheme]], sig);
  }
  // Already typed (what polkadot.js extensions and keyring with withType return).
  if ((sig.length === 65 && (sig[0] === 0 || sig[0] === 1)) || (sig.length === 66 && sig[0] === 2)) return sig;
  throw new SeamChainError('BAD_SIGNATURE', `untyped ${sig.length}-byte signature: pass the scheme (sr25519, ed25519 or ecdsa); SEAM will not guess it`);
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
export function assembleSignedExtrinsic(payload: SignerPayloadJSON, signature: string, facts: RuntimeFacts, opts: AssembleOptions = {}): Hex {
  const { registry } = encodeRuntime(facts);
  const fp = facts.fingerprint;
  const num = (v: string | number) => Number(BigInt(v));
  const problems: string[] = [];
  if (payload.genesisHash.toLowerCase() !== fp.genesisHash) problems.push('genesisHash');
  if (num(payload.specVersion) !== fp.specVersion) problems.push('specVersion');
  if (num(payload.transactionVersion) !== fp.transactionVersion) problems.push('transactionVersion');
  if (BigInt(payload.tip) !== 0n) problems.push('tip (SEAM always uses 0)');
  if (payload.signedExtensions.join(',') !== registry.signedExtensions.join(',')) problems.push('signedExtensions');
  if (payload.version !== 4) problems.push('version');
  if (problems.length) throw new SeamChainError('PAYLOAD_MISMATCH', `payload does not match the runtime facts: ${problems.join(', ')}`);

  const multi = toMultiSignature(signature, opts.scheme);
  if (opts.verify !== false) {
    const signed = registry.createType('SignerPayload', { ...payload, runtimeVersion: { specVersion: payload.specVersion, transactionVersion: payload.transactionVersion } }).toRaw();
    const data = hexToU8a(signed.data);
    const message = data.length > 256 ? blake2AsU8a(data, 256) : data;
    if (!signatureVerify(message, multi, payload.address).isValid) {
      throw new SeamChainError('BAD_SIGNATURE', `signature does not verify for ${payload.address} over this payload`);
    }
  }
  const ext = registry.createType('Extrinsic', { method: payload.method }, { version: 4 });
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
}

/** The typed MultiSignature (scheme byte + signature) of a signed polkadot.js extrinsic. */
function multiSignatureOf(ext: unknown): { type: string; toHex(): string } {
  return (ext as { inner: { signature: { multiSignature: { type: string; toHex(): string } } } }).inner.signature.multiSignature;
}

/** Reads what is actually inside a signed extrinsic, so the submit gate can compare it with the approved calls. */
export function extractSignedCall(extrinsicHex: string, facts: RuntimeFacts): SignedCall {
  const { registry } = encodeRuntime(facts);
  let ext;
  try {
    ext = registry.createType('Extrinsic', extrinsicHex);
  } catch (e) {
    throw new SeamChainError('NOT_SIGNED', `not a valid extrinsic for this runtime: ${(e as Error).message}`);
  }
  if (ext.toHex() !== extrinsicHex.toLowerCase()) throw new SeamChainError('NOT_SIGNED', 'extrinsic has trailing or non-canonical bytes');
  if (!ext.isSigned) throw new SeamChainError('NOT_SIGNED', 'extrinsic is not signed');
  const callHex = ext.method.toHex() as Hex;
  const { section, method } = registry.findMetaCall(ext.callIndex);
  const pallet = facts.capabilities && Object.entries(facts.capabilities).find(([, c]) => c.palletIndex === ext.callIndex[0] && c.callIndex === ext.callIndex[1]);
  const accountId = u8aToHex(ext.signer.toU8a().slice(-32)) as Hex;
  const multi = multiSignatureOf(ext);
  const era = ext.era;
  const eraInfo: EraInfo = era.isMortalEra
    ? { mortal: true, period: era.asMortalEra.period.toNumber(), phase: era.asMortalEra.phase.toNumber(), hex: era.toHex() as Hex }
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
    txHash: extrinsicHash(extrinsicHex)
  };
}

/** For @seam/policy checkBeforeSubmit({ signedCalls }): the call bytes inside each signed extrinsic, in order. */
export function signedCallsOf(extrinsics: string[], facts: RuntimeFacts): Hex[] {
  return extrinsics.map((x) => extractSignedCall(x, facts).callHex);
}

export interface SignedCheck {
  ok: boolean;
  mismatches: { field: 'call' | 'signer' | 'nonce' | 'era' | 'tip' | 'signature'; expected: string; actual: string }[];
  signed?: SignedCall;
}

/**
 * Compares a signed extrinsic with the signing request it should answer: call bytes, signer, nonce, era,
 * tip, and that the signature verifies over the request's exact payload (so blockHash/genesis/spec match too).
 */
export function checkSignedExtrinsic(extrinsicHex: string, request: SigningRequest, facts: RuntimeFacts): SignedCheck {
  const s = extractSignedCall(extrinsicHex, facts);
  const mismatches: SignedCheck['mismatches'] = [];
  const cmp = (field: SignedCheck['mismatches'][number]['field'], expected: string, actual: string) => {
    if (expected.toLowerCase() !== actual.toLowerCase()) mismatches.push({ field, expected, actual });
  };
  cmp('call', request.callHex, s.callHex);
  cmp('signer', accountIdOf(request.payload.address), s.signer.accountId);
  cmp('nonce', String(request.nonce), String(s.nonce));
  cmp('era', request.era.hex, s.era.hex);
  cmp('tip', '0', s.tip);
  // Verify over what this extrinsic actually carries (its call, era, nonce, tip) plus the request's chain
  // context (spec, tx version, genesis, era block hash): exactly what a node will check.
  const { registry } = encodeRuntime(facts);
  const p = request.payload;
  const actual = registry.createType('ExtrinsicPayload', {
    method: s.callHex, era: s.era.hex, nonce: s.nonce, tip: s.tip,
    specVersion: p.specVersion, transactionVersion: p.transactionVersion, genesisHash: p.genesisHash, blockHash: p.blockHash
  }, { version: 4 }).toU8a({ method: true });
  const message = actual.length > 256 ? blake2AsU8a(actual, 256) : actual;
  if (!signatureVerify(message, hexToU8a(s.signature), s.signer.accountId).isValid) {
    mismatches.push({ field: 'signature', expected: 'valid over the extrinsic contents', actual: 'does not verify' });
  }
  return { ok: mismatches.length === 0, mismatches, signed: s };
}
