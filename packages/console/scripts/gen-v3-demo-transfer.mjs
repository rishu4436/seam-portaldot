// Generates src/demo/v3-demo-transfer.json: the "V3 wallet demo" manifest (one tiny assets.transfer of the V3 test asset),
// a strict policy, and the plan compiled OFFLINE against the committed V3 spec-3002 metadata. Read-only: no RPC, no signer.
// The signer below is the recorded V3 run account; the real wallet run must recompile with the throwaway wallet address.
import fs from "node:fs";
import { compile, factsFromMetadata } from "@seam/compiler";

const root = new URL("../../../", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const snap = JSON.parse(read("evidence/v3-discovery/portaldot-v3-spec3002-snapshot.json"));
const recorded = JSON.parse(read("evidence/testnet-v3/runs/assets-transfer-1792410479921.json"));
const atomicRun = JSON.parse(read("evidence/testnet-v3/runs/plan-atomic-1792411355057.json"));
const fp = atomicRun.facts.fingerprint;

const ASSET = "806707"; // created by evidence/testnet-v3/runs/assets-create-1792409775476.json
const RECIPIENT = "5EkVZovjHsUQ2YLa2CnaVND8259u5c9h8eBtmRVweBpBVHXB"; // recipient of the recorded V3 transfer
const SIGNER = recorded.signer; // placeholder: replace with the throwaway wallet account before the real run
const AMOUNT = "1";

const facts = factsFromMetadata({
  metadataHex: read("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex").trim(),
  genesisHash: fp.genesisHash,
  tokenSymbol: fp.tokenSymbol,
  tokenDecimals: fp.tokenDecimals,
  ss58Prefix: fp.ss58Prefix,
  batchAllRollback: atomicRun.facts.behaviour?.batchAllRollback,
  batchAllRollbackProof: atomicRun.facts.behaviour?.batchAllRollbackProof,
});
const manifest = {
  version: 1,
  chain: { genesisHash: fp.genesisHash, specVersion: fp.specVersion },
  signer: { type: "ss58", value: SIGNER },
  actions: [
    {
      id: "pay",
      kind: "assets.transfer",
      args: { assetId: ASSET, amount: AMOUNT, recipient: RECIPIENT },
      preferredMode: "atomic",
    },
  ],
};
const policy = {
  version: "seam/policy/v1",
  allowedCapabilities: ["Assets.transfer_keep_alive"],
  allowedAssets: [ASSET],
  allowedContracts: [],
  allowedRecipients: [RECIPIENT],
  maxAmountPerAsset: { [ASSET]: "10", "*": "0" },
  maxNativeValue: "0",
  maxFee: "5000000000000", // 0.05 tPOT; the recorded transfer cost ~0.0148 tPOT
  maxSteps: 1,
  allowedModes: ["atomic_verified"],
  requireHumanApproval: true,
  maxApprovalSeconds: 300,
  requireSignedDryRun: true,
  allowUnknown: { storageDeposit: true, dryRun: true },
};
const plan = compile(manifest, facts);
const out = {
  label: "V3 wallet demo",
  note: "One assets.transfer of 1 base unit of V3 test asset 806707. Compiled offline against the committed spec-3002 metadata; recompile with the wallet's own account and live facts before signing.",
  sources: {
    asset: "evidence/testnet-v3/runs/assets-create-1792409775476.json",
    transfer: "evidence/testnet-v3/runs/assets-transfer-1792410479921.json",
    metadata: "evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex",
  },
  manifest,
  policy,
  fingerprint: facts.fingerprint,
  fingerprintDigest: facts.fingerprintDigest,
  plan,
};
fs.writeFileSync(new URL("src/demo/v3-demo-transfer.json", new URL("../", import.meta.url)), JSON.stringify(out, null, 2) + "\n");
console.log(plan.mode, plan.outerCall?.encodedCall, facts.fingerprint.metadataHash);
