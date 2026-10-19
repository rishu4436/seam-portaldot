/**
 * End to end on a LOCAL substrate-contracts-node (scripts/devnode.sh start), gated on SEAM_DEVNODE=1.
 * Signs with the public //Alice dev seed: local dev chain only (lib.mjs refuses non-localhost endpoints and
 * Portaldot mainnet). Each run writes its evidence under /workspace/seam-evidence/devnode/runs/.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LIVE = process.env.SEAM_DEVNODE === "1";
const script = (name: string) =>
  fileURLToPath(new URL(`../scripts/devnode/${name}`, import.meta.url));
const run = (name: string, ...args: string[]) =>
  execFileSync("node", [script(name), ...args], { encoding: "utf8", timeout: 240_000 });
const evidenceOf = (stdout: string) => {
  const file = stdout.trim().split(/\s/)[0]!;
  return { file, json: JSON.parse(readFileSync(file, "utf8")) };
};

describe.skipIf(!LIVE)("local dev node (SEAM_DEVNODE=1)", () => {
  it("setup: asset 1 and the seam_demo ink! contract exist", () => {
    const out = JSON.parse(run("setup.mjs"));
    expect(out.state.assetId).toBe(1);
    expect(out.state.contractName).toBe("seam_demo");
    expect(out.state.contract).toMatch(/^0x[0-9a-f]{64}$/);
  }, 240_000);

  it("sequential transfer -> contract call -> mint, strict policy, per-step gate: receipt verified", () => {
    const { json } = evidenceOf(run("run-sequential.mjs"));
    expect(json.policy.requireSignedDryRun).toBe(true);
    // complete recording: Manifest, facts, policy, rule-by-rule result, the SDK's own gate result (onStep check) per step
    expect(json.recordingVersion).toBe(2);
    expect(json.manifest.actions).toHaveLength(3);
    expect(json.facts.fingerprintDigest).toBe(json.fingerprintDigest);
    expect(json.policyResult.rules.length).toBeGreaterThan(0);
    // gate results are read from the SDK's onStep events, not recomputed
    expect(
      json.gateChecks
        .filter((g: any) => g.phase === "sending")
        .map((g: any) => [g.index, g.check.ok]),
    ).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    for (const g of json.gateChecks.filter((x: any) => x.phase === "sending")) {
      const codes = g.check.passed.map((p: any) => p.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          "step_order",
          "approval_unused",
          "approval_intact",
          "approval_matches",
          "runtime_unchanged",
          "signed_bytes_match",
          "signed_dry_run_ok",
        ]),
      );
      expect(g.check.reasons).toEqual([]);
    }
    expect(json.gateChecks.filter((g: any) => g.phase === "done")).toHaveLength(3);
    // tightened policy: message name, pinned interface hash, selector; no storage-deposit cap
    expect(json.policy.allowedMessages[json.manifest.actions[1].args.contract]).toEqual(["settle"]);
    expect(json.policy.pinnedAbiHashes[json.manifest.actions[1].args.contract]).toBe(
      json.plan.steps[1].contractMessage.abiHash,
    );
    expect(json.policy.maxStorageDeposit).toBeUndefined();
    const rules = json.policyResult.rules
      .filter((r: any) => r.outcome === "pass")
      .map((r: any) => r.rule);
    expect(rules).toEqual(
      expect.arrayContaining(["message_allowed", "abi_pinned", "selector_allowed"]),
    );
    expect(JSON.stringify(json)).not.toMatch(/"signature"|\/\/Alice/);
    expect(json.policyResult.allowed).toBe(true);
    const sent = json.gateChecks.filter((g: any) => g.phase === "sending");
    expect(sent.map((g: any) => g.dryRun.map((d: any) => d.outcome))).toEqual([
      ["ok"],
      ["ok"],
      ["ok"],
    ]);
    expect(json.run.receipt.result).toBe("verified");
    expect(json.receiptIntact).toBe(true);
    const steps = json.run.receipt.steps;
    expect(steps.map((s: any) => s.status)).toEqual(["finalized", "finalized", "finalized"]);
    expect(new Set(steps.map((s: any) => s.txHash)).size).toBe(3);
    expect(steps[1].events.some((e: string) => e.startsWith("Contracts.ContractEmitted("))).toBe(
      true,
    );
    // the contract step is written by message name + ABI; the compiler binds the V14 shape, no run-script patching
    const callAction = json.manifest.actions[1].args;
    expect(callAction).toMatchObject({
      message: "settle",
      args: { order_id: 7, amount: "2500" },
      abiRef: "seam_demo",
      storageDepositLimit: null,
    });
    expect(callAction.data).toBeUndefined();
    const callStep = json.plan.steps[1];
    expect(callStep.status).toBe("ok");
    expect(callStep.shim).toBeUndefined();
    expect(callStep.decodedArgs.shim).toBeUndefined();
    expect(callStep.decodedArgs.storageDepositLimit).toBeNull();
    expect(callStep.contractMessage).toMatchObject({
      message: "settle",
      selector: "0x6c337222",
      args: { order_id: "7", amount: "2500" },
    });
    // ContractEmitted comes from the demo contract and carries Settled { caller, order_id 7, amount 2500 }
    const emitted = steps[1].events.find((e: string) =>
      e.startsWith("Contracts.ContractEmitted("),
    )!;
    expect(emitted).toContain(json.manifest.actions[1].args.contract);
    expect(emitted).toMatch(/0700000000000000c4090000000000000000000000000000\)$/);
    // Weight V2 runtime: every preflight step has a real proof size from payment_queryInfo
    for (const p of json.preflight.steps) expect(p.proofSize.value).toMatch(/^[1-9][0-9]*$/);
    expect(
      json.preflightDetail.transactions.every((t: any) => t.queryInfo.weightVersion === 2),
    ).toBe(true);
    // the contract call's queried proof size covers the gas_limit proof size; the contract itself needs far less
    const call = json.preflight.steps[1];
    const needed = /contract needs proof size (\d+)/.exec(call.note)![1]!;
    expect(BigInt(call.proofSize.value)).toBeGreaterThan(BigInt(needed));
  }, 240_000);

  it("batch_all rollback: the gate blocks the failing batch; sent directly, nothing from the transfer, contract call or mint sticks", () => {
    const { file, json } = evidenceOf(run("run-rollback.mjs"));
    expect(json.seamGate).toMatchObject({ ok: false, stage: "submit_gate", nothingSent: true });
    expect(json.recordingVersion).toBe(2);
    // the batch covers every kind of the atomic plan (SEAM-012): transfer, contract call, mint, then a failing transfer
    expect(json.preflight.steps).toHaveLength(4);
    expect(json.plan.steps.map((s: { kind: string }) => s.kind)).toEqual([
      "assets.transfer",
      "contracts.call",
      "assets.mint",
      "assets.transfer",
    ]);
    expect(json.envelope.checkpoint.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.gateChecks).toHaveLength(1);
    expect(json.gateChecks[0]).toMatchObject({ phase: "blocked", check: { ok: false } });
    expect(json.seamGate.passed.map((p: any) => p.code)).not.toContain("signed_dry_run_ok");
    expect(json.directSubmit.statuses.map((s: any) => s.status)).toEqual([
      "submitted",
      "in_block",
      "finalized",
    ]);
    expect(JSON.stringify(json)).not.toMatch(/"signature"|\/\/Alice/);
    expect(json.seamGate.reasons.map((r: any) => r.code)).toEqual(["signed_dry_run_failed"]);
    expect(json.directSubmit).toMatchObject({ status: "finalized", success: false });
    expect(json.directSubmit.dispatchError).toMatch(/assets\.BalanceLow/);
    expect(json.innerEffects).toEqual([]);
    expect(json.state.after.asset).toEqual(json.state.before.asset);
    expect(json.state.after.aliceNonce).toBe(json.state.before.aliceNonce + 1);
    expect(json.batchAllRollback).toBe("verified");

    const atomic = evidenceOf(run("run-atomic.mjs", file)).json;
    expect(atomic.plan.mode).toBe("atomic_verified");
    expect(atomic.facts.behaviour.batchAllRollbackProof.composition).toEqual(
      expect.arrayContaining(["assets.transfer", "contracts.call", "assets.mint"]),
    );
    expect(atomic.run.receipt.result).toBe("verified");
    expect(new Set(atomic.run.receipt.steps.map((s: any) => s.txHash)).size).toBe(1);
  }, 480_000);
});
