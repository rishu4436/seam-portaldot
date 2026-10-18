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

/** Swap point. Replace the body with `(await import("@seam/chain/browser")).createLiveHost()` once that entry exists. */
export async function loadLiveHost(): Promise<LiveHost | undefined> {
  return undefined;
}
