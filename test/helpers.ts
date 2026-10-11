import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile, factsFromMetadata, readPinnedTypes } from "@seam/compiler";
import { definePolicy, type Manifest, type Plan, type PreflightResult, type RuntimeFacts, type SigningEnvelope } from "../src/index.js";

// Real data: Bot 4's read-only snapshot of wss://mainnet.portaldot.io at block 2,721,455 (spec 1002),
// compiled by Bot 2's compiler. Preflight estimates and the signing envelope are example data.
const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const snapshot = JSON.parse(readFileSync(fx("portaldot-mainnet-snapshot.json"), "utf8"));
const metadataHex = readFileSync(fx("portaldot-mainnet-metadata.hex"), "utf8").trim();
const typesBundle = readPinnedTypes();

export const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
export const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
export const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
export const BOB_POLKADOT = "14E5nqKAp3oAJcmzgZhUD2RcptBeUBScxKHgJKU4HPNcKVf3";

export function realFacts(over: Record<string, unknown> = {}): RuntimeFacts {
  return factsFromMetadata({
    metadataHex, typesBundle,
    genesisHash: snapshot.genesis,
    tokenSymbol: snapshot.properties.tokenSymbol,
    tokenDecimals: snapshot.properties.tokenDecimals,
    specName: snapshot.runtime.specName,
    specVersion: snapshot.runtime.specVersion,
    transactionVersion: snapshot.runtime.transactionVersion,
    ss58Prefix: snapshot.properties.ss58Format,
    endpoint: snapshot.endpoint,
    blockNumber: snapshot.block,
    ...over,
  } as Parameters<typeof factsFromMetadata>[0]) as unknown as RuntimeFacts;
}

export function demoManifest(): Manifest {
  return {
    version: 1,
    chain: { genesisHash: snapshot.genesis, specVersion: 1002 },
    signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
    actions: [
      { id: "pay", kind: "assets.transfer", args: { assetId: "1", amount: "2500000000000000", recipient: BOB } },
      { id: "call", kind: "contracts.call", args: { contract: CHARLIE, value: "0", gasLimit: "5000000000", data: "0x633aa551" } },
      { id: "receipt", kind: "assets.mint", args: { assetId: "2", amount: "1", recipient: BOB } },
    ],
  };
}

export const compilePlan = (m: Manifest = demoManifest(), f: RuntimeFacts = realFacts(), opts = {}): Plan =>
  compile(m as never, f as never, opts) as unknown as Plan;

export function preflight(plan: Plan): PreflightResult {
  return {
    steps: plan.steps.map((s) => ({ actionId: s.actionId, weight: { value: "200000000" }, fee: { value: "1500000000" }, storageDeposit: { value: "0" }, dryRun: "ok" as const })),
    totalFee: { value: "4500000000" },
  };
}

export const NOW = new Date("2026-10-20T10:00:00Z");
export const envelope = (over: Partial<SigningEnvelope> = {}): SigningEnvelope =>
  ({ signer: ALICE, nonce: 5, mortalityBlocks: 64, expiresAt: "2026-10-20T10:30:00Z", ...over });

export const policy = (over = {}) => definePolicy({
  allowedAssets: ["1", "2"],
  allowedContracts: [CHARLIE],
  allowedSelectors: { [CHARLIE]: ["0x633aa551"] },
  allowedRecipients: [BOB],
  maxAmountPerAsset: { "1": "5000000000000000", "2": "1" },
  maxNativeValue: "0",
  maxGasLimit: "10000000000",
  maxWeight: "1000000000",
  maxFee: "10000000000",
  maxStorageDeposit: "0",
  ...over,
});
