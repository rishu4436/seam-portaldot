// "V3 wallet demo" for LIVE mode: one tiny assets.transfer of the V3 test asset (806707, created in evidence/testnet-v3) with a
// strict policy. The plan is compiled OFFLINE by scripts/gen-v3-demo-transfer.mjs against the committed spec-3002 metadata;
// nothing here signs, sends or reads a keystore. Before the real run it must be recompiled for the wallet's own account.
import demo from "../demo/v3-demo-transfer.json";
import type { Approval, Hex, Plan, PolicyResult, PolicyRuleResult, RuntimeFacts } from "./types";

export const WALLET_DEMO_LABEL = "V3 wallet demo";
export const WALLET_DEMO_ASSET = "806707";

export interface WalletDemoPolicy {
  allowedCapabilities: string[];
  allowedAssets: string[];
  allowedRecipients: string[];
  maxAmountPerAsset: Record<string, string>;
  maxNativeValue: string;
  maxFee: string;
  maxSteps: number;
  allowedModes: string[];
  maxApprovalSeconds: number;
  requireSignedDryRun: boolean;
  [k: string]: unknown;
}
interface CompiledStep {
  actionId: string;
  kind: string;
  capability: string;
  palletIndex: number;
  callIndex: number;
  decodedArgs: { assetId?: string; amount?: string; recipient?: string };
  encodedCall: Hex;
  status: "ok" | "unavailable";
}
interface Compiled {
  manifestDigest: Hex;
  fingerprintDigest: Hex;
  signer: { value: string };
  mode: string;
  modeReason?: string;
  steps: CompiledStep[];
  planDigest: Hex;
}

export const walletDemo = demo as unknown as {
  label: string;
  note: string;
  sources: Record<string, string>;
  manifest: unknown;
  policy: WalletDemoPolicy;
  fingerprint: RuntimeFacts["fingerprint"] & { digest?: Hex };
  fingerprintDigest: Hex;
  plan: Compiled;
};

/** The compiler's plan in the console's Plan shape. Only fields the compiler produced are mapped; nothing is invented. */
export function walletDemoPlan(c: Compiled = walletDemo.plan): Plan {
  const mode = (
    ["atomic_verified", "atomic_unverified", "sequential"].includes(c.mode) ? c.mode : "unavailable"
  ) as Plan["mode"];
  return {
    manifestDigest: c.manifestDigest,
    fingerprintDigest: c.fingerprintDigest,
    signer: c.signer.value,
    mode,
    modeReason: c.modeReason,
    digest: c.planDigest,
    steps: c.steps.map((s) => ({
      actionId: s.actionId,
      capability: s.capability,
      callIndex: [s.palletIndex, s.callIndex],
      encodedCall: s.encodedCall,
      decoded: {
        assetId: s.decodedArgs.assetId,
        amount: s.decodedArgs.amount,
        recipient: s.decodedArgs.recipient,
      },
      status: s.status,
    })),
  };
}

/**
 * Plan-shaped facts for the live fingerprint match. They carry only the fingerprint, so hasChainFacts() is false and LIVE runs
 * its facts step (see liveFactsStep in components/Modes.tsx) before installing the host.
 */
export function walletDemoFacts(): RuntimeFacts {
  return {
    fingerprint: { ...walletDemo.fingerprint, digest: walletDemo.fingerprintDigest },
    capabilities: [],
    behaviour: [],
    endpoint: "offline compile (spec 3002 metadata)",
    discoveredAtBlock: 0,
  } as RuntimeFacts;
}

const big = (s: string | undefined) => (s != null && /^\d+$/.test(s) ? BigInt(s) : undefined);

/**
 * Console pre-check of the strict demo policy, shown before approval. It is a display aid: the SDK policy engine and the
 * submit gate stay authoritative. Every rule must pass; a missing value blocks.
 */
export function checkWalletDemoPolicy(
  plan: Plan,
  p: WalletDemoPolicy = walletDemo.policy,
): PolicyResult {
  const rules: PolicyRuleResult[] = [];
  const add = (rule: string, ok: boolean, reason: string, actionId?: string) =>
    rules.push({ rule, outcome: ok ? "pass" : "block", reason, actionId });
  add("maxSteps", plan.steps.length <= p.maxSteps, `${plan.steps.length} of max ${p.maxSteps} step(s)`);
  add(
    "singleSignature",
    plan.steps.length === 1,
    "The LIVE wallet flow signs exactly one call",
  );
  for (const s of plan.steps) {
    const a = s.decoded;
    const cap = big(p.maxAmountPerAsset[a.assetId ?? ""] ?? p.maxAmountPerAsset["*"]);
    const amt = big(a.amount);
    add("capability", p.allowedCapabilities.includes(s.capability), s.capability, s.actionId);
    add("asset", !!a.assetId && p.allowedAssets.includes(a.assetId), `asset ${a.assetId ?? "?"}`, s.actionId);
    add(
      "recipient",
      !!a.recipient && p.allowedRecipients.includes(a.recipient),
      `recipient ${a.recipient ?? "?"}`,
      s.actionId,
    );
    add(
      "maxAmount",
      amt != null && cap != null && amt > 0n && amt <= cap,
      `amount ${a.amount ?? "?"} of max ${cap ?? "?"}`,
      s.actionId,
    );
    add("encoded", s.status === "ok" && !!s.encodedCall, "call is encoded", s.actionId);
  }
  return {
    allowed: rules.every((r) => r.outcome === "pass"),
    rules,
    policyDigest: "0x" as Hex,
    explain: "Console pre-check of the strict demo policy. The submit gate re-checks before sending.",
  };
}

/** Human approval of exactly this plan digest, valid for the policy's approval window. Single use. */
export function approveWalletDemo(
  plan: Plan,
  now = Date.now(),
  p: WalletDemoPolicy = walletDemo.policy,
): Approval {
  return {
    hash: plan.digest,
    covers: plan.steps.map((s) => s.actionId),
    expiresAt: new Date(now + p.maxApprovalSeconds * 1000).toISOString(),
    used: false,
  };
}
