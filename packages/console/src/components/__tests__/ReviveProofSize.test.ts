// @vitest-environment node
// Live Revive path: the pre-sign gate with requireMeasuredProofSize. Real V3 spec 3002 metadata, fresh compile in-test;
// the preflight proof sizes are synthetic test data (the 7725 static overhead matches Chainsmith's dry-run measurement).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, factsFromMetadata } from "@seam/compiler/browser";
import { definePolicy } from "@seam/policy/browser";
import { runPolicyGate } from "../../lib/policygate";
import { BLOCK_CODE_TEXT, proofSizeText } from "../../lib/signflow";

const root = (p: string) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));
const facts = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: "0x" + "11".repeat(32),
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
} as never);
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // //Alice dev key address, test only
const C = "0x" + "22".repeat(20);
const manifest = {
  version: 1,
  signer: { type: "ss58", value: ALICE },
  actions: [
    {
      id: "call",
      kind: "revive.call",
      args: {
        contract: C,
        value: "0",
        data: "0x00",
        gasLimit: "5000000000",
        proofSize: "1000000",
        storageDepositLimit: "100",
      },
    },
  ],
};
const plan = compile(manifest as never, facts as never) as unknown as {
  steps: { actionId: string }[];
};
const policy = definePolicy({
  allowedContracts: [C],
  maxNativeValue: "0",
  maxGasLimit: "5000000000",
  maxProofSize: "1000000",
  maxStorageDeposit: "100",
  maxFee: "10000000000",
} as never);
const preflight = (sizes: object) => ({
  steps: plan.steps.map((s) => ({
    actionId: s.actionId,
    weight: { value: "200000000" },
    fee: { value: "1500000000" },
    storageDeposit: { value: "0" },
    dryRun: "ok" as const,
    ...sizes,
  })),
  totalFee: { value: "1500000000" },
});
const gate = (sizes: object) =>
  runPolicyGate(
    { policy, plan, facts, manifest, preflight: preflight(sizes) },
    { requireMeasuredProofSize: true },
  );

describe("live revive.call proof size (requireMeasuredProofSize)", () => {
  it("passes with a measured dry run inside the 1M cap and call info 1007725 above it", () => {
    const sizes = { dryRunProofSize: { value: "12998" }, callInfoProofSize: { value: "1007725" } };
    const g = gate(sizes);
    expect(g.ok, JSON.stringify(g)).toBe(true);
    expect(proofSizeText(sizes)).toBe("Proof size: dry run 12998, call info 1007725.");
  });
  it("blocks with PROOF_SIZE_CALL_INFO_MISSING when the call-info proof size is absent", () => {
    const g = gate({ dryRunProofSize: { value: "12998" } });
    expect(g.ok).toBe(false);
    expect(!g.ok && g.codes).toContain("PROOF_SIZE_CALL_INFO_MISSING");
    expect(BLOCK_CODE_TEXT.PROOF_SIZE_CALL_INFO_MISSING).toBeTruthy();
  });
  it("an unknown call-info proof size is not 0 and still blocks", () => {
    const sizes = {
      dryRunProofSize: { value: "12998" },
      callInfoProofSize: { unknown: true as const },
    };
    expect(gate(sizes).ok).toBe(false);
    expect(proofSizeText(sizes)).toBe("Proof size: dry run 12998, call info unknown.");
  });
});
