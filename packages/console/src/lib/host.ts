// The single seam for everything that needs SCALE / signature crypto. The console deliberately has NO local verifier or
// extrinsic assembler: two copies would drift from the SDK/chain ones. The host (planned: `@seam/chain/browser`) supplies
// them through LiveHost. Until loadLiveHost() returns one, LIVE stays blocked before anything is signed or sent.
import type { Res, SignedBindingVerifier } from "./live";

/** Chain state read over JSON-RPC that a signing request is built from. */
export interface SigningContext {
  genesisHash: string;
  specVersion: number;
  transactionVersion: number;
  nonce: number;
  checkpointHash: string;
  checkpointNumber: number;
  mortalityBlocks: number;
}
export interface BuildRequestInput {
  signer: string;
  callHex: string;
  actionIds: string[];
  context: SigningContext;
}

export interface LiveHost {
  /** Builds the full signing request (payload, era, signing bytes) from the approved call and chain context. */
  buildRequest(input: BuildRequestInput): Res<unknown> | Promise<Res<unknown>>;
  /** Checks only the signed bytes against the request (same contract as the SDK's verifySignedAgainstRequest). */
  verifyBinding: SignedBindingVerifier;
  /** Turns the wallet signature + request into submittable extrinsic bytes. */
  assemble(signature: string, request: unknown): string | Promise<string>;
  /** Extrinsic hash as the chain computes it (blake2-256 of the encoded extrinsic). */
  extrinsicHash(extrinsicHex: string): string;
  /** Optional: an encoded extrinsic fit for payment_queryInfo (fee estimate only, never a dry run). */
  feeEstimateExtrinsic?(request: unknown): string | Promise<string>;
}

type ChainBrowser = typeof import("@seam/chain/browser");
// buildSigningRequest is the real request builder. The browser entry does not export it yet, so it is feature-detected;
// without it buildRequest reports "unavailable" and LIVE blocks before signing (no local copy of it here).
type BuildFn = (
  callHex: string,
  facts: unknown,
  input: {
    signer: string;
    nonce: number;
    mortalityBlocks: number;
    checkpoint: { number: number; hash: string };
  },
  meta: { actionIds: string[] },
) => unknown;

/** 64 bytes of 0x01: a placeholder signature for fee estimation only. */
export const FILLER_SIG = "0x" + "01".repeat(64);

const isHex = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

/** True only for facts that carry what the chain package needs to decode and encode (the compiler's RuntimeFacts shape). */
export function hasChainFacts(f: unknown): boolean {
  const x = f as {
    fingerprint?: { genesisHash?: unknown; specVersion?: unknown; transactionVersion?: unknown };
    fingerprintDigest?: unknown;
    source?: { metadataHex?: unknown };
  } | null;
  return (
    !!x &&
    typeof x === "object" &&
    isHex(x.fingerprint?.genesisHash) &&
    typeof x.fingerprint?.specVersion === "number" &&
    typeof x.fingerprint?.transactionVersion === "number" &&
    isHex(x.fingerprintDigest) &&
    isHex(x.source?.metadataHex) &&
    (x.source?.metadataHex?.length ?? 0) > 2
  );
}

/** Builds a host over an already-loaded browser entry and real facts. Exported for tests (they pass the real entry and synthetic facts). */
export function createLiveHost(
  mod: ChainBrowser,
  facts: unknown,
  hash: (extrinsicHex: string) => string,
): LiveHost {
  const f = facts as Parameters<ChainBrowser["signBytesOf"]>[1];
  const build = (mod as unknown as { buildSigningRequest?: BuildFn }).buildSigningRequest;
  return {
    buildRequest(input) {
      if (!build)
        return {
          ok: false,
          reason: "unavailable",
          message:
            "The chain package's browser entry does not export the signing request builder yet, so nothing can be signed.",
        };
      try {
        const c = input.context;
        return {
          ok: true,
          value: build(
            input.callHex,
            f,
            {
              signer: input.signer,
              nonce: c.nonce,
              mortalityBlocks: c.mortalityBlocks,
              checkpoint: { number: c.checkpointNumber, hash: c.checkpointHash },
            },
            { actionIds: input.actionIds },
          ),
        };
      } catch (e) {
        return { ok: false, reason: "unavailable", message: (e as Error).message };
      }
    },
    // Only the signed bytes are checked. A wallet-reported signedCall is never read.
    verifyBinding(signedTx, request) {
      try {
        const v = mod.verifySignedAgainstRequest(
          signedTx,
          request as Parameters<ChainBrowser["verifySignedAgainstRequest"]>[1],
          { facts: f },
        );
        return { ok: v.ok, reasons: v.reasons };
      } catch (e) {
        return { ok: false, reasons: ["verifier_error: " + (e as Error).message] };
      }
    },
    assemble(signature, request) {
      const r = request as { payload: Parameters<ChainBrowser["assembleSignedExtrinsic"]>[0] };
      return mod.assembleSignedExtrinsic(r.payload, signature, f);
    },
    extrinsicHash: hash,
    // Fee estimate only: the approved payload with a FILLER signature (not verified, never valid), sent to payment_queryInfo.
    // The node cannot accept it as a transaction; it exists so the fee is known before the wallet is asked.
    feeEstimateExtrinsic(request) {
      const r = request as { payload: Parameters<ChainBrowser["assembleSignedExtrinsic"]>[0] };
      return mod.assembleSignedExtrinsic(r.payload, FILLER_SIG, f, {
        scheme: "sr25519",
        verify: false,
      });
    },
  };
}

/**
 * Installs the host only when real RuntimeFacts (from a V3 discovery) are supplied. With no facts, or facts that are not the
 * chain package's shape, this returns undefined and LIVE stays blocked before anything is signed or sent.
 */
export async function loadLiveHost(facts?: unknown): Promise<LiveHost | undefined> {
  if (!hasChainFacts(facts)) return undefined;
  const [mod, crypto] = await Promise.all([
    import("@seam/chain/browser"),
    import("@polkadot/util-crypto"),
  ]);
  return createLiveHost(mod, facts, (hex) => crypto.blake2AsHex(hex, 256));
}
