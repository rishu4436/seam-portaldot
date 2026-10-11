import { hexToBytes } from "@noble/hashes/utils";
import {
  digest, encodeSs58, definePolicy,
  type Fingerprint, type RuntimeFacts, type Plan, type PreflightResult, type SigningEnvelope, type Manifest, type Hex,
} from "../src/index.js";

// Runtime values come from Bot 4's read-only snapshot of wss://mainnet.portaldot.io at block 2,721,455
// (/workspace/seam-evidence/portaldot-mainnet-snapshot.json). Calls, hashes and estimates below are example data.
export function fingerprint(over: Partial<Fingerprint> = {}): Fingerprint {
  const base = {
    genesisHash: "0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54" as Hex,
    specName: "portaldot",
    specVersion: 1002,
    transactionVersion: 2,
    metadataHash: "0x8b91f644a913a1008086c2e0732a8a2184c1da79909e9384d432c3c5ffac5150" as Hex,
    metadataVersion: 13,
    typesFileHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
    ss58Prefix: 42,
    tokenSymbol: "POT",
    tokenDecimals: 14,
    ...over,
  };
  const { digest: given, ...fields } = base as typeof base & { digest?: Hex };
  return { ...fields, digest: given ?? digest("seam/fingerprint/v1", fields) };
}

export const ALICE = encodeSs58(hexToBytes("d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"), 42);
export const BOB = encodeSs58(hexToBytes("8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"), 42);
export const MALLORY = encodeSs58(hexToBytes("90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22"), 42);
export const CONTRACT = "0x" + "ab".repeat(32);

export function facts(fp = fingerprint(), over: Partial<RuntimeFacts> = {}): RuntimeFacts {
  return {
    fingerprint: fp,
    capabilities: [
      { id: "Assets.transfer_keep_alive", status: "observed", pallet: "Assets", callIndex: [12, 9] },
      { id: "Assets.mint", status: "observed", pallet: "Assets", callIndex: [12, 3] },
      { id: "Contracts.call", status: "observed", pallet: "Contracts", callIndex: [18, 0] },
      { id: "Utility.batch_all", status: "observed", pallet: "Utility", callIndex: [1, 2] },
      { id: "Nfts.mint", status: "not_observed" },
      { id: "Revive.call", status: "not_observed" },
      { id: "Assets.freeze", status: "unknown" },
    ],
    behaviour: [{ id: "batch_all_rollback", status: "unknown" }],
    endpoint: "wss://mainnet.portaldot.io",
    discoveredAtBlock: 2721455,
    ...over,
  };
}

export function plan(fp = fingerprint(), over: Partial<Plan> = {}): Plan {
  const p: Plan = {
    manifestDigest: ("0x" + "01".repeat(32)) as Hex,
    fingerprintDigest: fp.digest,
    signer: ALICE,
    mode: "sequential",
    steps: [
      { actionId: "pay", capability: "Assets.transfer_keep_alive", callIndex: [12, 9], encodedCall: "0x0c09aa01", decoded: { assetId: "7", amount: "1000", recipient: BOB }, status: "ok" },
      { actionId: "settle", capability: "Contracts.call", callIndex: [18, 0], encodedCall: "0x1200bb02", decoded: { contract: CONTRACT, value: "0" }, status: "ok" },
      { actionId: "receipt", capability: "Assets.mint", callIndex: [12, 3], encodedCall: "0x0c03cc03", decoded: { assetId: "8", amount: "1", recipient: ALICE }, status: "ok" },
    ],
    digest: ("0x" + "02".repeat(32)) as Hex,
    ...over,
  };
  return p;
}

export function preflight(over: Partial<PreflightResult> = {}): PreflightResult {
  const step = (actionId: string) => ({ actionId, weight: { value: "200000000" }, fee: { value: "1500000000" }, storageDeposit: { value: "0" }, dryRun: "ok" as const });
  return { steps: [step("pay"), step("settle"), step("receipt")], totalFee: { value: "4500000000" }, ...over };
}

export const NOW = new Date("2026-10-20T10:00:00Z");

export function envelope(over: Partial<SigningEnvelope> = {}): SigningEnvelope {
  return { signer: ALICE, nonce: 5, mortalityBlocks: 64, expiresAt: "2026-10-20T10:30:00Z", ...over };
}

export function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: "seam/manifest/v1",
    signer: { type: "SS58", value: ALICE, ss58Prefix: 42 },
    actions: [
      { id: "pay", kind: "assets.transfer", requires: "Assets.transfer_keep_alive", args: { assetId: "7", amount: "1000", to: { type: "SS58", value: BOB, ss58Prefix: 42 } } },
      { id: "settle", kind: "contracts.call", requires: "Contracts.call", args: { contract: { type: "AccountId32", value: CONTRACT }, value: "0" } },
      { id: "receipt", kind: "assets.mint", requires: "Assets.mint", args: { assetId: "8", amount: "1", to: { type: "SS58", value: ALICE, ss58Prefix: 42 } } },
    ],
    ...over,
  };
}

export const policy = (over = {}) => definePolicy({
  allowedAssets: ["7", "8"],
  allowedContracts: [CONTRACT],
  allowedRecipients: [BOB, ALICE],
  maxAmountPerAsset: { "7": "5000", "8": "1" },
  maxNativeValue: "0",
  maxWeight: "1000000000",
  maxFee: "10000000000",
  maxStorageDeposit: "0",
  ...over,
});
