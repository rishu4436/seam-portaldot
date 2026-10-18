import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  compile,
  type AtomicRollbackProof,
  type Manifest,
  type Plan,
  type RuntimeFacts,
} from "@seam/compiler";
import {
  chainInputsFromSnapshot,
  factsFromChainInputs,
  type ChainInputs,
  type SnapshotJson,
} from "../src/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export const snapshot = JSON.parse(
  readFileSync(fixture("portaldot-mainnet-snapshot.json"), "utf8"),
) as SnapshotJson;
export const metadataHex = readFileSync(fixture("portaldot-mainnet-metadata.hex"), "utf8").trim();
export const eventsFixture = JSON.parse(
  readFileSync(fixture("mainnet-events-2721116.json"), "utf8"),
);
export const snapshotInputs = (): ChainInputs => chainInputsFromSnapshot(snapshot, metadataHex);
export const snapshotFacts = (over: Partial<RuntimeFacts> = {}): RuntimeFacts => ({
  ...factsFromChainInputs(snapshotInputs()),
  ...over,
});
/** Rollback proof that matches `f` (genesis, metadata hash, spec) and covers the demo plan's call kinds, like compiler tests' withRollback. */
export const rollbackProofFor = (f: RuntimeFacts): AtomicRollbackProof => ({
  genesisHash: f.fingerprint.genesisHash,
  metadataHash: f.fingerprint.metadataHash,
  specVersion: f.fingerprint.specVersion,
  txHash: `0x${"ab".repeat(32)}`,
  blockHash: `0x${"cd".repeat(32)}`,
  preState: { aliceBalance: "100" },
  postState: { aliceBalance: "100" },
  composition: ["assets.transfer", "assets.mint", "contracts.call"],
});
export const verifiedRollback = (f: RuntimeFacts): RuntimeFacts => ({
  ...f,
  behaviour: { batchAllRollback: "verified", batchAllRollbackProof: rollbackProofFor(f) },
});

// Well-known dev accounts (SS58 prefix 42). TEST ONLY: //Alice is a public dev seed, never a real key.
export const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
export const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
export const BOB_HEX = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
export const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";

export async function devKeys() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  return { alice: keyring.addFromUri("//Alice"), bob: keyring.addFromUri("//Bob") };
}

/** Snapshot checkpoint (block 2,721,455). */
export const CHECKPOINT = { number: snapshot.block, hash: snapshot.block_hash };

export function demoManifest(): Manifest {
  return {
    version: 1,
    chain: { genesisHash: snapshot.genesis, specVersion: 1002 },
    signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
    actions: [
      {
        id: "pay",
        kind: "assets.transfer",
        args: { assetId: "1", amount: "2500000000000000", recipient: BOB },
      },
      {
        id: "call",
        kind: "contracts.call",
        args: { contract: CHARLIE, value: "0", gasLimit: "5000000000", data: "0x633aa551" },
      },
      { id: "receipt", kind: "assets.mint", args: { assetId: "2", amount: "1", recipient: BOB } },
    ],
  };
}

export const demoPlan = (facts: RuntimeFacts = snapshotFacts()): Plan =>
  compile(demoManifest(), facts);
export const atomicPlan = (): { plan: Plan; facts: RuntimeFacts } => {
  const facts = verifiedRollback(snapshotFacts());
  return { plan: compile(demoManifest(), facts), facts };
};
