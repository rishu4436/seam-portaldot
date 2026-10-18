// Test-chain adapter. Everything here comes from Bot 4's REAL runs on a local
// substrate-contracts-node v0.42.0 (ws://127.0.0.1:9944, metadata v14), imported
// by scripts/import-devnode.mjs into src/demo/devnode.json. Nothing is simulated:
// hashes, blocks, events, fees, dry runs and digests are what that chain returned.
// It is a LOCAL TEST CHAIN, not Portaldot. The console replays the recording;
// it does not connect to the node live.
import data from "../demo/devnode.json";
import type { Approval, Capability, Estimate, Hex, Manifest, Plan, PolicyResult, PreflightResult, Receipt, RuntimeFacts, SigningEnvelope } from "./types";
import type { StepEvent } from "./mock";
import type { GateResult } from "./gate";

export type TcScn = "sequential" | "atomic" | "rollback";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const D = data as any;
let current: TcScn = "sequential";
export function setScenario(s: TcScn) { current = s; }
export const scenario = () => current;
const R = () => D[current]; // every run file now carries its own Manifest, facts, policy, preflight and envelope
const SHOWN = ["Assets.transfer_keep_alive", "Assets.mint", "Contracts.call", "Utility.batch_all", "Revive.call", "Nfts.mint"];
const DEC = 12;
export const unit = (base?: string): Estimate => (base != null ? { value: `${(Number(base) / 10 ** DEC).toFixed(6)} ${D.sequential.facts.fingerprint.tokenSymbol}` } : { unknown: true });

export const ENDPOINT: string = D.node.endpoint;
export const node = () => D.node as { endpoint: string; binary: string; rpcSnapshotAt: string; pallets: string[]; declaredToken: { tokenSymbol: string; tokenDecimals: number; source: string } };
export const setup = () => D.setup as { file: string; steps: { what: string; txHash: Hex; block: { number: number; hash: Hex }; success: boolean; events: string[] }[]; state: { contract: Hex; assetId: number } };
export const contractInfo = () => {
  const st = D.setup?.state;
  const deploy = D.setup?.steps?.find((x: any) => x.txHash);
  return st?.contract ? { address: st.contract as Hex, name: st.contractName as string | undefined, codeHash: st.contractCodeHash as Hex | undefined, abi: st.contractAbi as string | undefined, deployTx: (deploy?.txHash ?? st.contractInstantiatedIn?.txHash) as Hex | undefined, deployBlock: (deploy?.block?.number ?? st.contractInstantiatedIn?.block) as number | undefined } : undefined;
};
export interface Emitted { contract: Hex; event: string; signatureTopic: Hex; fields: { name: string; type: string; indexed: boolean; value: string }[]; abi: string }
export function decodedEmitted(actionId: string): Emitted | undefined { return R().decodedEmitted?.[actionId]; }
export const checks = () => D.checks as { what: string; ok: boolean; detail: string }[];
export const importedFrom = () => D.source as { dir: string; picked: string; files: string[] };

export interface RunInfo { kind: string; ranAt: string; evidenceFile: string; runsOfThisKind: number; shimmed?: boolean; compiledMode?: string; compiledModeReason?: string; manifestVerified?: boolean; requireSignedDryRun?: boolean }
export function info(): RunInfo {
  const s = D[current];
  return { kind: s.kind, ranAt: s.ranAt, evidenceFile: s.evidenceFile, runsOfThisKind: s.runsOfThisKind, shimmed: s.shimmed, compiledMode: s.compiledMode, compiledModeReason: s.compiledModeReason, requireSignedDryRun: s.requireSignedDryRun };
}

export function discover(_endpoint?: string): RuntimeFacts {
  const f = R().facts;
  const caps: Capability[] = SHOWN.map((id) => {
    const c = f.capabilities[id] ?? { status: "unknown" };
    return { id, status: c.status, pallet: id.split(".")[0], callIndex: c.palletIndex != null ? [c.palletIndex, c.callIndex] : undefined, argTypesPartial: c.argTypesConfidence === "partial" };
  });
  const rb = D.rollback;
  const at = R().facts.blockNumber ?? 0;
  return {
    endpoint: D.node.endpoint,
    discoveredAtBlock: at,
    fingerprint: { ...f.fingerprint, metadataVersion: f.metadataVersion, typesFileHash: f.fingerprint.typesBundleHash, digest: f.fingerprintDigest },
    capabilities: caps,
    behaviour: [
      { id: "batch_all_rollback", status: rb.batchAllRollback === "verified" ? "confirmed" : "unknown", note: `Discovery alone said "${f.behaviour.batchAllRollback}". Proven by the rollback run in block #${rb.directSubmit.block.number}: the failed batch_all left no transfer or mint. The proof is the separate recording rollback-1792300479791 (balances unchanged except the fee).` },
      { id: "fee_estimate", status: "confirmed", note: "payment_queryInfo answered on this node (Weight V2)." },
      { id: "contract_dry_run", status: "confirmed", note: "ContractsApi_call via state_call (the contracts_call RPC is gone on this node)." },
      { id: "storage_deposit", status: "unknown", note: "This runtime doesn't report storage deposits for these calls." },
    ],
  };
}

export function demoManifest(): Manifest { return R().manifest as Manifest; }
export function manifestDigest(): Hex { return R().manifestDigest; }

export function compile(): Plan {
  const p = R().plan;
  return {
    manifestDigest: p.manifestDigest, fingerprintDigest: p.fingerprintDigest, signer: p.signer.value, mode: p.mode, digest: p.planDigest, modeReason: p.modeReason, explain: R().planText,
    steps: p.steps.map((s: any) => {
      const a = s.decodedArgs;
      const cm = s.contractMessage;
      const argText = cm ? Object.entries(cm.args).map(([k, v]) => `${k}: ${v}`).join(", ") : undefined;
      return {
        actionId: s.actionId, capability: s.capability, callIndex: [s.palletIndex, s.callIndex], encodedCall: s.encodedCall, status: s.status === "ok" ? "ok" : "unavailable",
        shim: a.shim,
        decoded: { assetId: a.assetId, amount: a.amount, recipient: a.recipient, contract: a.contract, value: a.value, message: cm?.message ?? a.message, selector: cm?.selector ?? a.selector, abiHash: cm?.abiHash ?? a.abiHash, abiRef: cm?.abiRef, args: argText ?? (a.args != null ? (typeof a.args === "string" ? a.args : JSON.stringify(a.args)) : undefined) },
      };
    }),
  } as Plan;
}
export function outerCall(): { capability: string; encodedCall: Hex } | undefined { return R().plan.outerCall; }

export function preflight(): PreflightResult {
  const p = R().preflight;
  return { steps: p.steps.map((s: any) => ({ actionId: s.actionId, weight: s.weight.unknown ? { unknown: true } : { value: Number(s.weight.value).toLocaleString() }, proofSize: s.proofSize?.value ? { value: Number(s.proofSize.value).toLocaleString() } : { unknown: true }, fee: unit(s.fee.value), storageDeposit: s.storageDeposit.unknown ? { unknown: true } : unit(s.storageDeposit.value), dryRun: s.dryRun, note: s.note })), totalFee: unit(p.totalFee.value) };
}
/** Proof size the chain actually used per step (from ExtrinsicSuccess). Atomic: one batch, so the same total for every step. */
export function usedProofSize(actionId: string): { value: string; shared: boolean } | undefined {
  const u = R().usedProofSize?.[actionId];
  return u ? { value: Number(u.value).toLocaleString(), shared: current === "atomic" } : undefined;
}
export function preflightAt() { return R().preflightAt as { number: number; hash: Hex } | undefined; }

export function checkPolicy(): PolicyResult {
  const r = R().policyResult;
  return { allowed: r.allowed, rules: r.rules, policyDigest: r.policyDigest, explain: R().policyText };
}
export function policyFile() { return R().policy; }

export function envelope(): SigningEnvelope { return R().envelope; }
export function checkpoint(): { number: number; hash: Hex } | undefined { return R().envelope.checkpoint; }
export function signing() { return R().signing as { count: number; specVersion: string; transactionVersion: string; era: string; signedExtensions: string[]; genesisHash: Hex }; }

export function approve(): Approval {
  const a = R().approval;
  return { hash: a.hash, covers: a.covers, expiresAt: a.expiresAt, used: false };
}

export function submitBlock(): string | undefined { return current === "rollback" ? D.rollback.seamGate.reasons.map((r: any) => r.message).join(" ") : undefined; }

export interface GateCheck { index: number; actionId: string; phase?: string; source?: string; dryRun?: { outcome: string; detail: string }[]; sendIndex?: number | null; sdkOutcome?: string; result: GateResult; agreesWithSdk?: boolean; checksPerformed?: string[]; note?: string; inputs?: { runtimeUnchanged?: boolean; signedDryRun?: string[]; dryRunDetails?: { outcome: string; detail: string }[]; previousSteps?: { actionId: string; status: string; block?: number }[] } }
/** The gate result the SDK gave for step i (atomic and rollback send one batch, so its check covers every step). */
export function gateFor(i: number): GateResult | undefined {
  const l = gateChecks().filter((g) => (current === "sequential" ? g.index === i : g.index === 0));
  return l[l.length - 1]?.result;
}
export function gateChecks(): GateCheck[] { return (R().gateChecks ?? []) as GateCheck[]; }

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
