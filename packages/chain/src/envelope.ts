import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { SeamChainError } from "./errors.js";
import { decodeRuntime } from "./runtime.js";
import type { SigningEnvelope } from "./types.js";

/**
 * Block time in ms from the runtime's own metadata constants: Babe.ExpectedBlockTime, else 2 x Timestamp.MinimumPeriod.
 * undefined when the metadata does not say (no Babe constant and no Timestamp.MinimumPeriod, or a MinimumPeriod under
 * 500 ms, i.e. manual/instant seal). Never a default. Browser-safe; the node and browser entries export this one function.
 */
export function blockTimeFromFacts(facts: RuntimeFacts): number | undefined {
  const consts = decodeRuntime(facts).decorated().consts as unknown as Record<
    string,
    Record<string, { toNumber(): number } | undefined> | undefined
  >;
  const expected = consts.babe?.expectedBlockTime?.toNumber();
  if (expected && Number.isSafeInteger(expected) && expected > 0) return expected;
  const min = consts.timestamp?.minimumPeriod?.toNumber();
  // Below a second means manual/instant seal (substrate-contracts-node: MinimumPeriod 5 ms): blocks come per
  // transaction, so metadata says nothing about real block time. Make the caller pass blockTimeMs.
  return min && Number.isSafeInteger(min) && min * 2 >= 1000 ? min * 2 : undefined;
}

export interface SigningEnvelopeInput {
  /** The signer's address as the policy and wallet see it (SS58 for the runtime's prefix). */
  signer: string;
  /** Next nonce for the signer (system_accountNextIndex). */
  nonce: number;
  /** The finalized block the mortal era starts from; the wallet signs against its hash. */
  checkpoint: { number: number; hash: Hex | string };
  /** Era length in blocks. Default 64. */
  mortalityBlocks?: number;
  /** Clock for expiresAt. */
  now: Date;
  /** Runtime facts; block time is read from their metadata when blockTimeMs is not given. */
  facts: RuntimeFacts;
  /** Explicit block time (ms). Overrides the metadata; must be a positive integer. */
  blockTimeMs?: number;
}

const bad = (msg: string) => new SeamChainError("NODE_MISSING_VALUE", msg);

/**
 * The signing envelope @seam/policy (assertPolicyAllows / createApproval) expects:
 * { signer, nonce, mortalityBlocks, checkpoint: { number, hash }, expiresAt }.
 * expiresAt = now + (mortalityBlocks - 1) x block time (the era counts from the checkpoint, so one block of margin).
 * Fails closed (throws SeamChainError NODE_MISSING_VALUE) when the block time is unknown or any input is malformed;
 * nothing is defaulted except mortalityBlocks. Pure and browser-safe; the node adapter uses this same function.
 */
export function buildSigningEnvelope(i: SigningEnvelopeInput): SigningEnvelope {
  const mortalityBlocks = i.mortalityBlocks ?? 64;
  if (typeof i.signer !== "string" || !i.signer) throw bad("signing envelope: no signer");
  if (!Number.isSafeInteger(i.nonce) || i.nonce < 0) throw bad("signing envelope: no valid nonce");
  if (!Number.isSafeInteger(mortalityBlocks) || mortalityBlocks < 2)
    throw bad("signing envelope: mortalityBlocks must be an integer >= 2");
  if (
    !i.checkpoint ||
    !Number.isSafeInteger(i.checkpoint.number) ||
    i.checkpoint.number < 0 ||
    typeof i.checkpoint.hash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(i.checkpoint.hash)
  )
    throw bad("signing envelope: no valid checkpoint block");
  if (!(i.now instanceof Date) || Number.isNaN(i.now.getTime()))
    throw bad("signing envelope: no valid clock");
  const blockTimeMs = i.blockTimeMs ?? blockTimeFromFacts(i.facts);
  if (blockTimeMs === undefined) throw bad("block time not in metadata; pass options.blockTimeMs");
  if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0)
    throw bad("signing envelope: block time must be a positive integer (ms)");
  return {
    signer: i.signer,
    nonce: i.nonce,
    mortalityBlocks,
    checkpoint: { number: i.checkpoint.number, hash: i.checkpoint.hash as Hex },
    expiresAt: new Date(i.now.getTime() + (mortalityBlocks - 1) * blockTimeMs).toISOString(),
  };
}
