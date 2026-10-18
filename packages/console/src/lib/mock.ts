import type { GateResult } from "./gate";
// Console data adapter. Every plan, policy result, approval and receipt here was
// produced by the REAL @seam/compiler, @seam/policy and @seam/sdk, run offline
// against Bot 4's saved Portaldot node snapshot (see scripts/gen-demo.mjs).
// Simulated (no V3 testnet run yet): the chain's replies (tx hashes, blocks,
// events). Fees and weights are Bot 4's real payment_queryInfo results.
import data from "../demo/scenarios.json";
import type {
  Approval,
  Capability,
  Manifest,
  Plan,
  PolicyResult,
  PreflightResult,
  Receipt,
  RuntimeFacts,
  SigningEnvelope,
  Hex,
  Estimate,
} from "./types";

type Scn = "happy" | "nft" | "upgrade" | "fail" | "midrun";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const D = data as any;
let current: Scn = "happy";
export function setScenario(s: Scn) {
  current = s;
}
const S = () => D[current];

const SHOWN = [
  "Assets.transfer_keep_alive",
  "Assets.mint",
  "Contracts.call",
  "Utility.batch_all",
  "Revive.call",
  "Nfts.mint",
];
const POT = (planck?: string): Estimate =>
  planck ? { value: `${(Number(planck) / 1e14).toFixed(4)} POT` } : { unknown: true };

export function discover(endpoint: string, upgraded = false): RuntimeFacts {
  const f = D.facts;
  const fp = upgraded && S().fingerprintNow ? S().fingerprintNow : f.fingerprint;
  const caps: Capability[] = SHOWN.map((id) => {
    const c = f.capabilities[id] ?? { status: "unknown" };
    return {
      id,
      status: c.status,
      pallet: id.split(".")[0],
      callIndex: c.palletIndex != null ? [c.palletIndex, c.callIndex] : undefined,
      argTypesPartial: c.argTypesConfidence === "partial",
    };
  });
  return {
    endpoint,
    discoveredAtBlock: f.blockNumber,
    fingerprint: {
      ...fp,
      metadataVersion: 13,
      typesFileHash: fp.typesBundleHash,
      digest: upgraded
        ? (("0x" + "f".repeat(8) + "upgraded".padEnd(56, "0")) as Hex)
        : f.fingerprintDigest,
    },
    capabilities: caps,
    behaviour: [
      {
        id: "batch_all_rollback",
        status: f.behaviour.batchAllRollback === "verified" ? "confirmed" : "unknown",
        note: "Needs a real test run on a V3 testnet.",
      },
      { id: "fee_estimate", status: "confirmed", note: "Live fees read from the Portaldot node." },
      {
        id: "contract_dry_run",
        status: "confirmed",
        note: "contracts_call is available on the node.",
      },
      {
        id: "storage_deposit",
        status: "unknown",
        note: "This runtime doesn't report storage deposits.",
      },
    ],
  };
}

export function demoManifest(_nft: boolean): Manifest {
  return S().manifest;
}
export function manifestDigest(_m: Manifest): Hex {
  return S().manifestDigest;
}

export function compile(_m: Manifest, _facts: RuntimeFacts): Plan {
  const p = S().plan;
  return {
    manifestDigest: p.manifestDigest,
    fingerprintDigest: p.fingerprintDigest,
    signer: typeof p.signer === "string" ? p.signer : (p.signer.address ?? p.signer.value ?? ""),
    mode: p.mode,
    digest: p.planDigest,
    modeReason: p.modeReason,
    explain: S().planText,
    steps: p.steps.map((s: any) => ({
      actionId: s.actionId,
      capability: s.capability,
      callIndex: s.palletIndex != null ? [s.palletIndex, s.callIndex] : undefined,
      encodedCall: s.encodedCall ?? undefined,
      status: s.status === "ok" ? "ok" : "unavailable",
      reason: s.reason ? `${s.reason}, so this step can't run here.` : undefined,
      decoded: {
        assetId: s.decodedArgs.assetId,
        amount: s.decodedArgs.amount,
        recipient: s.decodedArgs.recipient,
        contract: s.decodedArgs.contract,
        value: s.decodedArgs.value,
      },
    })),
  } as Plan;
}

export function preflight(_plan: Plan): PreflightResult {
  const p = S().preflight;
  return {
    steps: p.steps.map((s: any) => ({
      actionId: s.actionId,
      weight: s.weight.unknown ? { unknown: true } : { value: s.weight.value },
      proofSize: s.proofSize?.value
        ? { value: Number(s.proofSize.value).toLocaleString() }
        : { unknown: true },
      fee: POT(s.fee.value),
      storageDeposit: s.storageDeposit.unknown ? { unknown: true } : POT(s.storageDeposit.value),
      dryRun: s.dryRun,
    })),
    totalFee: POT(p.totalFee.value),
  };
}

export function checkPolicy(_plan: Plan): PolicyResult {
  const r = S().policyResult;
  return {
    allowed: r.allowed,
    rules: r.rules,
    policyDigest: r.policyDigest,
    explain: S().policyText,
  } as PolicyResult;
}

export function envelope(): SigningEnvelope {
  return S().envelope;
}

export function approve(_plan: Plan, _policy: PolicyResult, _env: SigningEnvelope): Approval {
  const a = S().approval;
  return { hash: a.hash, covers: a.covers, expiresAt: a.expiresAt, used: false };
}

export function submitBlock(): string | undefined {
  const r = S().run;
  return r && !r.ok ? r.reason : undefined;
}
export type StepEvent = {
  index: number;
  actionId: string;
  phase: "checking" | "sending" | "done" | "blocked";
  detail?: string;
  check?: GateResult;
};
export function timeline(): StepEvent[] {
  return S().timeline ?? [];
}

export function receipt(
  _plan: Plan,
  _policy: PolicyResult,
  _approval: Approval,
  _failAt?: string,
): Receipt {
  const r = S().run.receipt;
  return {
    manifestDigest: r.manifestDigest,
    planDigest: r.planDigest,
    fingerprintDigest: r.fingerprintDigest,
    policyDigest: r.policyDigest,
    approvalHash: r.approvalHash,
    mode: r.mode,
    steps: r.steps.map((s: any) => ({ ...s, events: s.events ?? [] })),
    overall: r.result,
    checks: { confirmed: r.coverage.verified, expected: r.coverage.expected },
    digest: r.receiptDigest,
    explain: S().receiptText,
  } as Receipt;
}
