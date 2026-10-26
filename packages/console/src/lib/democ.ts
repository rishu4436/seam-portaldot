// Sentinel's Demo C (packages/policy/demo/demo-c.json): a policy violation blocked before the wallet opens. Example
// data only: no keys, no chain writes. Each Manifest is compiled fresh on the given facts and run through the
// authoritative pre-sign gate (runPolicyGate). A block means the signing request is never built.
import { parsePolicy } from "@seam/policy/browser";
import demoCFile from "../../../policy/demo/demo-c.json";
import { runPolicyGate, type GateOutcome } from "./policygate";

export interface DemoCCase {
  id: string;
  expectCode: string;
  manifest: Record<string, unknown>;
}

export const demoC = demoCFile as unknown as {
  policy: unknown;
  cases: Record<string, { expectCode: string; manifest: Record<string, unknown> }>;
};

export function demoCCases(): DemoCCase[] {
  return Object.entries(demoC.cases).map(([id, c]) => ({ id, ...c }));
}

export function demoCPolicy(): unknown {
  const p = parsePolicy(demoC.policy);
  if (!p.ok) throw new Error("Demo C policy does not parse.");
  return p.policy;
}

/**
 * Runs one Demo C case: compile the Manifest fresh on `facts`, then the pre-sign gate. `requestSignature` is only
 * called when the gate allows, which for Demo C it never should.
 */
export function runDemoC(args: {
  c: DemoCCase;
  facts: unknown;
  chain: unknown;
  compile: (m: unknown, f: unknown) => unknown;
  preflight: (plan: unknown) => unknown;
  envelope: { expiresAt: string };
  now: Date;
  requestSignature: (plan: unknown) => void;
}): { gate: GateOutcome; plan: unknown } {
  const manifest = { ...args.c.manifest, chain: args.chain };
  const plan = args.compile(manifest, args.facts);
  const gate = runPolicyGate(
    { policy: demoCPolicy(), plan, facts: args.facts, manifest, preflight: args.preflight(plan) },
    { request: { envelope: args.envelope }, now: args.now },
  );
  if (gate.ok) args.requestSignature(plan);
  return { gate, plan };
}
