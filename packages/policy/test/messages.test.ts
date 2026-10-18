import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { computeAbiHash } from "@seam/compiler";
import {
  evaluatePolicy, createApproval, checkBeforeSubmit, InMemoryApprovalStore, callsToSign, parsePolicy, planDigest,
  type BoundApproval, type Hex, type Plan,
} from "../src/index.js";
import * as H from "./helpers.js";

const DEMO = JSON.parse(readFileSync(fileURLToPath(new URL("../../compiler/fixtures/ink/seam_demo.v5.json", import.meta.url)), "utf8"));
const FLIPPER = JSON.parse(readFileSync(fileURLToPath(new URL("../../compiler/fixtures/ink/flipper.v3.json", import.meta.url)), "utf8"));
const facts = H.realFacts();
const HASH = computeAbiHash(DEMO) as string;

function planFor(message: string, args: Record<string, unknown>, abi: unknown = DEMO): Plan {
  const m = H.demoManifest();
  m.actions[1] = { id: "call", kind: "contracts.call", args: { contract: H.CHARLIE, value: "0", gasLimit: "5000000000", message, args, abiRef: "abi" } } as never;
  return H.compilePlan(m, facts, { abis: { abi } });
}
const settle = () => planFor("settle", { order_id: 7, amount: "100" });
const base = { allowedSelectors: undefined };
const rules = (plan: Plan, over = {}) => evaluatePolicy({ policy: H.policy({ ...base, ...over }), plan, facts, preflight: H.preflight(plan), manifest: undefined });
const bad = (r: ReturnType<typeof rules>) => r.rules.filter((x) => x.outcome !== "pass").map((x) => x.rule);

describe("allowedMessages and pinnedAbiHashes", () => {
  it("compiled plan carries the name, selector 0x6c337222 and ABI hash", () => {
    const cm = settle().steps[1]!.contractMessage!;
    expect(cm.message).toBe("settle");
    expect(cm.selector).toBe("0x6c337222");
    expect(cm.abiHash).toBe(HASH);
  });
  it("allows a listed message with the pinned hash", () => {
    const r = rules(settle(), { allowedMessages: { [H.CHARLIE]: ["settle"] }, pinnedAbiHashes: { [H.CHARLIE]: HASH } });
    expect(bad(r)).toEqual([]);
    expect(r.rules.map((x) => x.rule)).toEqual(expect.arrayContaining(["message_allowed", "abi_pinned"]));
  });
  it("blocks a message not on the list", () => {
    expect(bad(rules(settle(), { allowedMessages: { [H.CHARLIE]: ["refund"] } }))).toEqual(["message_not_allowed"]);
  });
  it("blocks a raw-data call to a contract with allowedMessages", () => {
    expect(bad(rules(H.compilePlan(), { allowedMessages: { [H.CHARLIE]: ["settle"] } }))).toEqual(["message_not_allowed"]);
  });
  it("blocks a different ABI that reuses the name, and a missing ABI", () => {
    const other = planFor("flip", {}, FLIPPER);
    expect(bad(rules(other, { pinnedAbiHashes: { [H.CHARLIE]: HASH } }))).toEqual(["abi_hash_mismatch"]);
    expect(bad(rules(H.compilePlan(), { pinnedAbiHashes: { [H.CHARLIE]: HASH } }))).toEqual(["abi_hash_missing"]);
  });
  it("a tampered contractMessage is caught by the plan digest", () => {
    const p = structuredClone(settle());
    p.steps[1]!.contractMessage!.message = "refund";
    expect(bad(rules(p, {}))).toContain("plan_integrity");
  });
  it("reads decodedArgs.message / abiHash when there is no contractMessage", () => {
    const p = structuredClone(H.compilePlan());
    Object.assign(p.steps[1]!.decodedArgs, { message: "settle", abiHash: HASH });
    const q = { ...p, planDigest: planDigest(p) };
    expect(bad(rules(q, { allowedMessages: { [H.CHARLIE]: ["settle"] }, pinnedAbiHashes: { [H.CHARLIE]: HASH } }))).toEqual([]);
  });
  it("policy file: parses, validates and warns", () => {
    const ok = parsePolicy({ allowedMessages: { [H.CHARLIE]: ["settle"] }, pinnedAbiHashes: { [H.CHARLIE]: HASH } });
    expect(ok.ok && ok.warnings).toEqual([]);
    const warn = parsePolicy({ allowedMessages: { [H.CHARLIE]: ["settle"] } });
    expect(warn.ok && warn.warnings.map((w) => w.path)).toEqual(["allowedMessages"]);
    const empty = parsePolicy({ allowedMessages: { [H.CHARLIE]: [] }, pinnedAbiHashes: { [H.CHARLIE]: HASH } });
    expect(empty.ok && empty.warnings.length).toBe(1);
    const badP = parsePolicy({ allowedMessages: { a: [1] }, pinnedAbiHashes: { a: "0x12" } });
    expect(!badP.ok && badP.issues.map((i) => i.path)).toEqual(["allowedMessages.a", "pinnedAbiHashes.a"]);
  });
});

describe("checkBeforeSubmit lists passed checks", () => {
  const plan = H.compilePlan();
  const policy = H.policy();
  const preflight = H.preflight(plan);
  const policyResult = evaluatePolicy({ policy, plan, facts, preflight, manifest: H.demoManifest() });
  const envelope = H.envelope();
  const out = createApproval({ manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult, fingerprint: facts.fingerprint, now: H.NOW });
  if (!out.ok) throw new Error(out.reason);
  const approval = out.approval as BoundApproval;
  const gate = (over = {}) => checkBeforeSubmit({
    approval, manifestDigest: plan.manifestDigest, plan, envelope, preflight, policy, policyResult,
    preparedFingerprint: facts.fingerprint, currentFingerprint: facts.fingerprint,
    signedCalls: callsToSign(plan) as Hex[], signedDryRun: callsToSign(plan).map(() => "ok" as const), now: H.NOW, store: new InMemoryApprovalStore(), ...over,
  });
  it("passing gate has no reasons and every check listed", () => {
    const r = gate();
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.passed.map((p) => p.code)).toEqual(["approval_unused", "approval_valid_time", "approval_intact", "approval_matches", "runtime_unchanged", "signed_bytes_match", "signed_dry_run_ok"]);
    expect(r.passed.every((p) => p.detail.length > 0)).toBe(true);
  });
  it("blocked gate lists the failure and not the same check as passed", () => {
    const r = gate({ signedCalls: ["0x00"] });
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("signed_bytes_mismatch");
    expect(r.passed.map((p) => p.code)).not.toContain("signed_bytes_match");
    expect(r.passed.map((p) => p.code)).toContain("approval_intact");
  });
});
