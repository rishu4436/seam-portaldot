// Test-chain adapter. Everything here comes from Bot 4's REAL runs on a local
// substrate-contracts-node v0.42.0 (ws://127.0.0.1:9944, metadata v14), imported
// by scripts/import-devnode.mjs into src/demo/devnode.json. Nothing is simulated:
// hashes, blocks, events, fees, dry runs and digests are what that chain returned.
// It is a LOCAL TEST CHAIN, not Portaldot. The console replays the recording;
// it does not connect to the node live.
import data from "../demo/devnode.json";
import type { Approval, Capability, Estimate, Hex, Manifest, Plan, PolicyResult, PreflightResult, Receipt, RuntimeFacts, SigningEnvelope } from "./types";
import type { StepEvent } from "./mock";

export type TcScn = "sequential" | "atomic" | "rollback";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const D = data as any;
let current: TcScn = "sequential";
export function setScenario(s: TcScn) { current = s; }
export const scenario = () => current;
const R = () => (current === "rollback" ? D.sequential : D[current]); // rollback shares the chain's facts
const SHOWN = ["Assets.transfer_keep_alive", "Assets.mint", "Contracts.call", "Utility.batch_all", "Revive.call", "Nfts.mint"];
const DEC = 12;
export const unit = (base?: string): Estimate => (base != null ? { value: `${(Number(base) / 10 ** DEC).toFixed(6)} ${D.facts.fingerprint.tokenSymbol}` } : { unknown: true });

export const ENDPOINT: string = D.node.endpoint;
export const node = () => D.node as { endpoint: string; binary: string; rpcSnapshotAt: string; pallets: string[]; declaredToken: { tokenSymbol: string; tokenDecimals: number; source: string } };
export const setup = () => D.setup as { file: string; steps: { what: string; txHash: Hex; block: { number: number; hash: Hex }; success: boolean; events: string[] }[]; state: { contract: Hex; assetId: number } };
export const checks = () => D.checks as { what: string; ok: boolean; detail: string }[];
export const importedFrom = () => D.source as { dir: string; picked: string; files: string[] };

export interface RunInfo { kind: string; ranAt: string; evidenceFile: string; runsOfThisKind: number; shimmed?: boolean; compiledMode?: string; compiledModeReason?: string; manifestVerified?: boolean; requireSignedDryRun?: boolean }
export function info(): RunInfo {
  const s = current === "rollback" ? D.rollback : D[current];
  return { kind: s.kind, ranAt: s.ranAt, evidenceFile: s.evidenceFile, runsOfThisKind: s.runsOfThisKind, shimmed: s.shimmed, compiledMode: s.compiledMode, compiledModeReason: s.compiledModeReason, manifestVerified: s.manifestVerified, requireSignedDryRun: s.requireSignedDryRun };
}

export function discover(_endpoint?: string): RuntimeFacts {
  const f = D.facts;
  const caps: Capability[] = SHOWN.map((id) => {
    const c = f.capabilities[id] ?? { status: "unknown" };
    return { id, status: c.status, pallet: id.split(".")[0], callIndex: c.palletIndex != null ? [c.palletIndex, c.callIndex] : undefined, argTypesPartial: c.argTypesConfidence === "partial" };
  });
  const rb = D.rollback;
  const at = current === "rollback" ? rb.state.before.block : R().preflightDetail?.atBlock?.number ?? 0;
  return {
    endpoint: D.node.endpoint,
    discoveredAtBlock: at,
    fingerprint: { ...f.fingerprint, metadataVersion: f.metadataVersion, typesFileHash: f.fingerprint.typesBundleHash, digest: f.fingerprintDigest },
    capabilities: caps,
    behaviour: [
      { id: "batch_all_rollback", status: rb.batchAllRollback === "verified" ? "confirmed" : "unknown", note: `Discovery alone said "${f.behaviour.batchAllRollback}". Proven by the rollback run in block #${rb.directSubmit.block.number}: the failed batch_all left no transfer or mint.` },
      { id: "fee_estimate", status: "confirmed", note: "payment_queryInfo answered on this node (Weight V2)." },
      { id: "contract_dry_run", status: "confirmed", note: "ContractsApi_call via state_call (the contracts_call RPC is gone on this node)." },
      { id: "storage_deposit", status: "unknown", note: "This runtime doesn't report storage deposits for these calls." },
    ],
  };
}

function rollbackManifest() {
  const rb = D.rollback;
  return {
    note: "Not a Manifest: this test was built by Bot 4's run-rollback.mjs to prove batch_all rollback. Steps as recorded.", planMode: rb.planMode,
    actions: rb.steps.map((s: any) => { const [cap] = capOf(s.call); return { id: s.actionId, kind: cap === "Assets.mint" ? "assets.mint" : "assets.transfer", requires: cap, args: s.args }; }),
  };
}
export function demoManifest(): Manifest { return (current === "rollback" ? rollbackManifest() : R().manifest) as unknown as Manifest; }
export function manifestDigest(): Hex | undefined { return current === "rollback" ? undefined : R().manifestDigest; }
export function manifestVerified(): boolean { return current !== "rollback" && !!R().manifestVerified; }

const capOf = (call: string): [string, number, number] => {
  const p = parseInt(call.slice(2, 4), 16), c = parseInt(call.slice(4, 6), 16);
  const hit = Object.entries(D.facts.capabilities as Record<string, any>).find(([, v]) => v.palletIndex === p && v.callIndex === c);
  return [hit ? hit[0] : `call [${p}, ${c}]`, p, c];
};

export function compile(): Plan {
  if (current === "rollback") {
    const rb = D.rollback;
    return {
      manifestDigest: "0x" as Hex, fingerprintDigest: D.facts.fingerprintDigest, signer: D.sequential.plan.signer.value, mode: rb.planMode, digest: "0x" as Hex,
      modeReason: `All 3 steps in one ${rb.outerCall.capability}. Step "overdraw" asks for more than Alice holds, on purpose.`,
      steps: rb.steps.map((s: any) => { const [cap, p, c] = capOf(s.call); return { actionId: s.actionId, capability: cap, callIndex: [p, c], encodedCall: s.call, status: "ok", decoded: { assetId: s.args.assetId, amount: s.args.amount, recipient: s.args.recipient } }; }),
    } as Plan;
  }
  const p = R().plan;
  return {
    manifestDigest: p.manifestDigest, fingerprintDigest: p.fingerprintDigest, signer: p.signer.value, mode: p.mode, digest: p.planDigest, modeReason: p.modeReason, explain: R().planText,
    steps: p.steps.map((s: any) => ({
      actionId: s.actionId, capability: s.capability, callIndex: [s.palletIndex, s.callIndex], encodedCall: s.encodedCall, status: s.status === "ok" ? "ok" : "unavailable",
      shim: s.decodedArgs.shim,
      decoded: { assetId: s.decodedArgs.assetId, amount: s.decodedArgs.amount, recipient: s.decodedArgs.recipient, contract: s.decodedArgs.contract, value: s.decodedArgs.value },
    })),
  } as Plan;
}
export function outerCall(): { capability: string; encodedCall: Hex } | undefined { return current === "rollback" ? D.rollback.outerCall : R().plan.outerCall; }

/** undefined in the rollback test: its evidence has no preflight. */
export function preflight(): PreflightResult | undefined {
  if (current === "rollback") return undefined;
  const p = R().preflight;
  return { steps: p.steps.map((s: any) => ({ actionId: s.actionId, weight: s.weight.unknown ? { unknown: true } : { value: Number(s.weight.value).toLocaleString() }, proofSize: s.proofSize?.value ? { value: Number(s.proofSize.value).toLocaleString() } : { unknown: true }, fee: unit(s.fee.value), storageDeposit: s.storageDeposit.unknown ? { unknown: true } : unit(s.storageDeposit.value), dryRun: s.dryRun, note: s.note })), totalFee: unit(p.totalFee.value) };
}
/** Proof size the chain actually used per step (from ExtrinsicSuccess). Atomic: one batch, so the same total for every step. */
export function usedProofSize(actionId: string): { value: string; shared: boolean } | undefined {
  if (current === "rollback") return undefined;
  const u = R().usedProofSize?.[actionId];
  return u ? { value: Number(u.value).toLocaleString(), shared: current === "atomic" } : undefined;
}
export function preflightAt() { return current === "rollback" ? undefined : R().preflightDetail?.atBlock as { number: number; hash: Hex } | undefined; }

export function checkPolicy(): PolicyResult {
  if (current === "rollback") return { allowed: !!D.rollback.policyAllowed, rules: [], policyDigest: "0x" as Hex, explain: "The evidence records only allowed: true for this test, not the rule-by-rule result." };
  const r = R().policyResult;
  return { allowed: r.allowed, rules: r.rules, policyDigest: r.policyDigest, explain: R().policyText };
}
export function policyFile() { return current === "rollback" ? undefined : R().policy; }

export function envelope(): SigningEnvelope | undefined { return current === "rollback" ? undefined : R().envelope; }
export function checkpoint(): { number: number; hash: Hex } | undefined { return current === "rollback" ? undefined : R().envelope.checkpoint; }
export function signing() { return current === "rollback" ? undefined : R().signing as { count: number; specVersion: string; transactionVersion: string; era: string; signedExtensions: string[]; genesisHash: Hex }; }

export function approve(): Approval {
  if (current === "rollback") return { hash: D.rollback.approvalHash, covers: [], expiresAt: "", used: false };
  const a = R().approval;
  return { hash: a.hash, covers: a.covers, expiresAt: a.expiresAt, used: false };
}

export function submitBlock(): string | undefined { return current === "rollback" ? D.rollback.seamGate.reasons.map((r: any) => r.message).join(" ") : undefined; }

/** The SDK's real onStep log. Atomic runs send one batch, so its events apply to every step. Rollback: derived from the gate result. */
export function timeline(): StepEvent[] {
  const n = compile().steps.length;
  if (current === "rollback") {
    const idx = [...Array(n).keys()];
    const ev: StepEvent[] = idx.map((i) => ({ index: i, actionId: "batch", phase: "checking" }));
    return ev.concat(idx.map((i) => ({ index: i, actionId: "batch", phase: "blocked", detail: "signed dry run failed" })));
  }
  const log: StepEvent[] = R().timeline;
  if (current === "atomic") return log.flatMap((e) => [...Array(n)].map((_, i) => ({ ...e, index: i })));
  return log;
}
export function dryRunFor(index: number): { txHash: Hex; outcome: string; detail: string } | undefined {
  if (current === "rollback") return D.rollback.seamGate.dryRun[0];
  const log = R().timeline as any[];
  const e = log.find((x) => x.phase === "sending" && (current === "atomic" || x.index === index));
  return e?.dryRun?.[0];
}
export function history(txHash?: string): { status: string; at: string; blockHash?: Hex }[] { return txHash ? (R().statuses as any[]).filter((s) => s.txHash === txHash) : []; }

export function receipt(): Receipt | undefined {
  if (current === "rollback") return undefined;
  const r = R().run.receipt;
  return {
    manifestDigest: r.manifestDigest, planDigest: r.planDigest, fingerprintDigest: r.fingerprintDigest, policyDigest: r.policyDigest, approvalHash: r.approvalHash, mode: r.mode,
    steps: r.steps.map((s: any) => ({ ...s, events: s.events ?? [] })), overall: r.result, checks: { confirmed: r.coverage.verified, expected: r.coverage.expected }, digest: r.receiptDigest, explain: R().receiptText,
  } as Receipt;
}
export function rawReceipt() { return current === "rollback" ? undefined : R().run.receipt; }

export interface Rollback {
  gate: { stage: string; ok: boolean; reasons: { code: string; message: string }[]; dryRun: { txHash: Hex; outcome: string; detail: string; raw: string }[]; nothingSent: boolean };
  bypass: { note: string; txHash: Hex; status: string; history: string[]; block: { number: number; hash: Hex }; extrinsicIndex: number; success: boolean; dispatchError: string; events: string[] };
  state: Record<"before" | "afterGate" | "after", { block: number; aliceNonce: number; asset: Record<string, string> }>;
  innerEffects: unknown[]; conclusion: string; verdict: string; evidenceFile: string;
}
export function rollback(): Rollback {
  const r = D.rollback;
  return { gate: r.seamGate, bypass: r.directSubmit, state: r.state, innerEffects: r.innerEffects, conclusion: r.conclusion, verdict: r.batchAllRollback, evidenceFile: r.evidenceFile };
}
