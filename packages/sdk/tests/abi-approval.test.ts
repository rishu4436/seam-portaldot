import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Seam,
  factsFromSnapshot,
  action,
  defineManifest,
  type ChainAdapter,
} from "../src/index.js";
import {
  definePolicy,
  evaluatePolicy,
  checkBeforeSubmit,
  InMemoryApprovalStore,
  callsToSign,
} from "@seam/policy";
it("keeps configured ABI references available through strict approval and the submit gate", () => {
  const facts = factsFromSnapshot(fileURLToPath(new URL("./fixtures", import.meta.url)));
  const abi = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../compiler/fixtures/ink/erc20.v5.json", import.meta.url)),
      "utf8",
    ),
  );
  const abis = { erc20: abi },
    bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const manifest = defineManifest({
    signer: {
      type: "ss58",
      value: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      ss58Prefix: 42,
    },
    actions: [
      action.contractCall("call", {
        contract: bob,
        value: "0",
        gasLimit: "5000000000",
        message: "transfer",
        args: { to: bob, value: "1000" },
        abiRef: "erc20",
      }),
    ],
  });
  const seam = new Seam({} as ChainAdapter, undefined, { abis });
  const plan = seam.compile(manifest, facts),
    policy = definePolicy({ allowedContracts: [bob] });
  const preflight = {
    steps: [
      {
        actionId: "call",
        weight: { value: "1" },
        fee: { value: "1" },
        storageDeposit: { value: "0" },
        dryRun: "ok" as const,
      },
    ],
    totalFee: { value: "1" },
  };
  const policyResult = evaluatePolicy({
    policy,
    plan,
    facts,
    preflight,
    manifest,
    liveFacts: facts,
    requirePlanVerified: true,
    abis,
  });
  expect(policyResult.allowed).toBe(true);
  const now = new Date("2026-11-02T12:00:00Z"),
    envelope = {
      signer: manifest.signer.value,
      nonce: 0,
      mortalityBlocks: 64,
      checkpoint: { number: 1, hash: ("0x" + "11".repeat(32)) as `0x${string}` },
      expiresAt: "2026-11-02T12:05:00Z",
    };
  const approval = seam.approve({
    plan,
    policy,
    preflight,
    policyResult,
    envelope,
    facts,
    manifest,
    requirePlanVerified: true,
    now,
  });
  if (!approval.ok) throw new Error(approval.reason);
  expect(
    checkBeforeSubmit({
      plan,
      policy,
      preflight,
      policyResult,
      envelope,
      manifest,
      liveFacts: facts,
      abis,
      manifestDigest: plan.manifestDigest,
      preparedFingerprint: facts.fingerprint,
      currentFingerprint: facts.fingerprint,
      approval: approval.approval,
      signedCalls: callsToSign(plan) as `0x${string}`[],
      signedDryRun: ["ok"],
      now,
      store: new InMemoryApprovalStore(),
    }).ok,
  ).toBe(true);
});
