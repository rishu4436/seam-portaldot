import { lookupTxByHash } from "@seam/chain/browser";
// Persisted, NON-SECRET execution state for LIVE runs (P1-03), so a refresh can recover a pending run and can never
// broadcast it twice. One versioned localStorage key. Only whitelisted fields are written: plan digest, approval hash,
// phase, per-step status, tx hash, nonce, block, timestamps, used approval keys and the single-flight send guard.
// Never stored: signed bytes, signatures, call bytes, metadataHex, keys or any other secret. Every write goes through
// sanitize() and assertNoSecrets(); a value that looks like signed bytes or metadata is refused (the write is dropped).
//
// A run that was signed but not sent can't be resumed after a refresh: the signed bytes lived only in memory. Recovery
// marks such steps "not_sent" and the run "abandoned" (a new approval is needed). A step with a tx hash is reconciled by
// reading the chain for that hash; it is never broadcast again. A send that was claimed but has no tx hash may have
// been broadcast, so it is "uncertain" and its guard is kept (fail closed).
import { InMemoryApprovalStore } from "@seam/policy/browser";

export const RUN_STORE_KEY = "seam.console.runs.v1";
const SEND_GUARD_PREFIX = "seam.console.send.v1:";
export class RunStoreError extends Error {}

export type RunPhase =
  | "approved"
  | "signed"
  | "submitting"
  | "submitted"
  | "finalized"
  | "blocked"
  | "failed"
  | "uncertain"
  | "abandoned";
export type StepState =
  | "pending"
  | "signed"
  | "submitting"
  | "submitted"
  | "in_block"
  | "finalized"
  | "not_found"
  | "not_sent"
  | "blocked"
  | "failed"
  | "uncertain";

export interface StepRecord {
  index: number;
  actionId: string;
  status: StepState;
  txHash?: string;
  nonce?: number;
  block?: { number: number; hash: string };
  note?: string;
  updatedAt: string;
}
export interface RunRecord {
  approvalHash: string;
  planDigest?: string;
  mode?: string;
  phase: RunPhase;
  /** First block the transactions could be in (the envelope checkpoint), for the tx-hash lookup range. */
  fromBlock?: number;
  steps: StepRecord[];
  createdAt: string;
  updatedAt: string;
  note?: string;
}
interface StoreShape {
  version: 1;
  runs: Record<string, RunRecord>;
  /** usageKey(approvalHash, sendIndex) values that were committed: single-use approvals. */
  used: string[];
  /** Single-flight guard: `${approvalHash}#${index}` claimed for broadcast. Never released once claimed. */
  sends: Record<string, { at: string; txHash?: string }>;
}

/** Minimal Storage (window.localStorage in the app; an in-memory fake in tests). */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/**
 * Tx-hash lookup for reconciliation: Chainsmith's lookupTxByHash(rpc, { txHash, fromBlock, toBlock?, maxBlocks? })
 * from @seam/chain/browser, bound to an RPC (chainTxLookup). Run only when the user asks to reconcile (the LIVE panel
 * contacts nothing on its own). Nothing is faked.
 * not_found means "not seen in that range" only: never proof the tx didn't land, so the step stays uncertain and is
 * never re-sent.
 */
export type TxLookup = (q: { txHash: string; fromBlock?: number }) => Promise<
  | {
      status: "found";
      blockNumber: number;
      blockHash: string;
      extrinsicIndex: number;
      success: boolean;
      dispatchError?: unknown;
      events?: unknown;
      finalized?: boolean;
    }
  | { status: "not_found"; scannedFrom: number; scannedTo: number }
  | { status: "unknown"; reason: string }
>;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const empty = (): StoreShape => ({ version: 1, runs: {}, used: [], sends: {} });
const now = () => new Date().toISOString();

/** Throws if anything that could be signed bytes, metadata or a secret is about to be stored. */
export function assertNoSecrets(json: string): void {
  if (/0x[0-9a-fA-F]{130,}/.test(json)) throw new Error("refusing to persist a long hex value");
  if (
    /"(signedTx|signedExtrinsics?|signature|metadataHex|callHex|encodedCall|seed|mnemonic|secret|privateKey)"/i.test(
      json,
    )
  )
    throw new Error("refusing to persist a secret-bearing field");
}

const str = (v: unknown, re?: RegExp) =>
  typeof v === "string" && (!re || re.test(v)) ? v : undefined;
function sanitizeStep(s: StepRecord): StepRecord {
  const out: StepRecord = {
    index: Number(s.index),
    actionId: String(s.actionId).slice(0, 128),
    status: s.status,
    updatedAt: str(s.updatedAt) ?? now(),
  };
  const tx = str(s.txHash, HEX32);
  if (tx) out.txHash = tx;
  if (Number.isSafeInteger(s.nonce)) out.nonce = s.nonce;
  if (s.block && Number.isSafeInteger(s.block.number) && HEX32.test(s.block.hash))
    out.block = { number: s.block.number, hash: s.block.hash };
  if (s.note) out.note = String(s.note).slice(0, 300);
  return out;
}
function sanitizeRun(r: RunRecord): RunRecord {
  const out: RunRecord = {
    approvalHash: String(r.approvalHash),
    phase: r.phase,
    steps: (r.steps ?? []).map(sanitizeStep),
    createdAt: str(r.createdAt) ?? now(),
    updatedAt: str(r.updatedAt) ?? now(),
  };
  const pd = str(r.planDigest, HEX32);
  if (pd) out.planDigest = pd;
  if (r.mode) out.mode = String(r.mode).slice(0, 32);
  if (r.note) out.note = String(r.note).slice(0, 300);
  if (Number.isSafeInteger(r.fromBlock)) out.fromBlock = r.fromBlock;
  return out;
}

export class RunStore {
  private kv: KV | undefined;
  constructor(kv: KV | undefined) {
    this.kv = kv;
  }
  private read(): StoreShape {
    try {
      if (!this.kv) throw new Error("Persistent browser storage is unavailable.");
      const raw = this.kv.getItem(RUN_STORE_KEY);
      if (raw === null) return empty();
      assertNoSecrets(raw);
      const v = JSON.parse(raw) as StoreShape;
      const record = (value: unknown) =>
        !!value && typeof value === "object" && !Array.isArray(value);
      const phases: RunPhase[] = [
        "approved",
        "signed",
        "submitting",
        "submitted",
        "finalized",
        "blocked",
        "failed",
        "uncertain",
        "abandoned",
      ];
      const states: StepState[] = [
        "pending",
        "signed",
        "submitting",
        "submitted",
        "in_block",
        "finalized",
        "not_found",
        "not_sent",
        "blocked",
        "failed",
        "uncertain",
      ];
      if (
        !record(v) ||
        v.version !== 1 ||
        !record(v.runs) ||
        !Array.isArray(v.used) ||
        v.used.some((key) => typeof key !== "string") ||
        !record(v.sends)
      )
        throw new Error("The saved execution journal has an invalid format.");
      for (const [key, run] of Object.entries(v.runs)) {
        if (
          !record(run) ||
          key !== run.approvalHash ||
          !phases.includes(run.phase) ||
          !Array.isArray(run.steps) ||
          run.steps.length > 100 ||
          run.steps.some(
            (step) =>
              !record(step) ||
              !Number.isSafeInteger(step.index) ||
              step.index < 0 ||
              typeof step.actionId !== "string" ||
              !states.includes(step.status) ||
              (step.txHash !== undefined && !HEX32.test(step.txHash)),
          )
        )
          throw new Error("The saved execution journal contains a damaged run.");
      }
      for (const send of Object.values(v.sends))
        if (
          !record(send) ||
          typeof send.at !== "string" ||
          (send.txHash !== undefined && !HEX32.test(send.txHash))
        )
          throw new Error("The saved execution journal contains a damaged send guard.");
      return v;
    } catch (error) {
      throw new RunStoreError(
        `${error instanceof Error ? error.message : String(error)} Signing is blocked to preserve duplicate-send protection. Export or repair the journal; do not clear it to retry an uncertain transaction.`,
      );
    }
  }
  problem(): string | undefined {
    try {
      this.read();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  private write(s: StoreShape): void {
    const clean: StoreShape = {
      version: 1,
      runs: Object.fromEntries(Object.entries(s.runs).map(([k, r]) => [k, sanitizeRun(r)])),
      used: [...new Set(s.used.map(String))],
      sends: Object.fromEntries(
        Object.entries(s.sends).map(([k, v]) => [
          k,
          { at: str(v.at) ?? now(), ...(str(v.txHash, HEX32) ? { txHash: v.txHash } : {}) },
        ]),
      ),
    };
    const json = JSON.stringify(clean);
    assertNoSecrets(json);
    if (!this.kv)
      throw new RunStoreError("Persistent storage is unavailable. Nothing can be sent.");
    this.kv.setItem(RUN_STORE_KEY, json);
    if (this.kv.getItem(RUN_STORE_KEY) !== json)
      throw new RunStoreError("The execution journal could not be persisted. Nothing can be sent.");
  }
  runs(): RunRecord[] {
    return Object.values(this.read().runs);
  }
  run(approvalHash: string): RunRecord | undefined {
    return this.read().runs[approvalHash];
  }
  upsertRun(r: Omit<RunRecord, "createdAt" | "updatedAt"> & { createdAt?: string }): void {
    const s = this.read();
    const prev = s.runs[r.approvalHash];
    s.runs[r.approvalHash] = {
      ...prev,
      ...r,
      createdAt: prev?.createdAt ?? r.createdAt ?? now(),
      updatedAt: now(),
    } as RunRecord;
    this.write(s);
  }
  updateStep(
    approvalHash: string,
    index: number,
    patch: Partial<StepRecord>,
    phase?: RunPhase,
  ): void {
    const s = this.read();
    const r = s.runs[approvalHash];
    if (!r) return;
    const st = r.steps.find((x) => x.index === index);
    if (st) Object.assign(st, patch, { updatedAt: now() });
    if (phase) r.phase = phase;
    r.updatedAt = now();
    this.write(s);
  }
  usedKeys(): string[] {
    return this.read().used;
  }
  markUsed(key: string): void {
    const s = this.read();
    if (!s.used.includes(key)) s.used.push(key);
    this.write(s);
  }
  /**
   * Single-flight guard keyed by approvalHash + step index. Returns false when this step was ever claimed before (in
   * this tab or any earlier session): it must never be broadcast again. The claim is persisted BEFORE the broadcast.
   */
  claimSend(approvalHash: string, index: number): boolean {
    const key = `${approvalHash}#${index}`;
    const s = this.read();
    if (s.sends[key] || this.kv?.getItem(SEND_GUARD_PREFIX + key)) return false;
    // Dedicated append-only keys cannot be erased by another tab updating its run-history snapshot.
    const guard = JSON.stringify({ at: now() });
    this.kv!.setItem(SEND_GUARD_PREFIX + key, guard);
    if (this.kv!.getItem(SEND_GUARD_PREFIX + key) !== guard)
      throw new RunStoreError("The send guard could not be persisted.");
    s.sends[key] = { at: now() };
    this.write(s);
    return true;
  }
  /** Serialize claims across browser tabs. A browser without Web Locks cannot safely submit. */
  async claimSendOnce(approvalHash: string, index: number): Promise<boolean> {
    if (typeof window === "undefined") return this.claimSend(approvalHash, index);
    if (!navigator.locks?.request)
      throw new RunStoreError(
        "This browser cannot coordinate sends across tabs. Use a browser with Web Locks support.",
      );
    return navigator.locks.request(`seam-send:${approvalHash}#${index}`, () =>
      this.claimSend(approvalHash, index),
    );
  }
  recordSent(approvalHash: string, index: number, txHash: string): void {
    const s = this.read();
    const key = `${approvalHash}#${index}`;
    s.sends[key] = { ...(s.sends[key] ?? { at: now() }), txHash };
    this.write(s);
    this.updateStep(approvalHash, index, { status: "submitted", txHash }, "submitted");
  }
  isClaimed(approvalHash: string, index: number): boolean {
    const key = `${approvalHash}#${index}`;
    return !!(this.read().sends[key] || this.kv?.getItem(SEND_GUARD_PREFIX + key));
  }

  /**
   * After a refresh: reconcile every unfinished run. Steps with a tx hash are looked up on chain (never re-sent);
   * signed-but-unsent steps become not_sent and the run abandoned; a claimed send with no tx hash is uncertain.
   */
  async recover(lookup: TxLookup | undefined, onlyApprovalHash?: string): Promise<RunRecord[]> {
    const done: RunPhase[] = ["finalized", "abandoned", "failed", "blocked"];
    for (const r of this.runs()) {
      if (onlyApprovalHash && r.approvalHash !== onlyApprovalHash) continue;
      if (done.includes(r.phase)) continue;
      let uncertain = false;
      let abandoned = false;
      for (const st of r.steps) {
        if (st.status === "finalized" || st.status === "failed" || st.status === "blocked")
          continue;
        if (st.txHash) {
          if (!lookup) {
            this.updateStep(r.approvalHash, st.index, {
              note: "reconcile unavailable: no tx-hash lookup wired in the browser yet (needs @seam/chain lookupExtrinsic)",
            });
            uncertain = true;
            continue;
          }
          let res: Awaited<ReturnType<TxLookup>>;
          try {
            res = await lookup({
              txHash: st.txHash,
              ...(r.fromBlock !== undefined ? { fromBlock: r.fromBlock } : {}),
            });
          } catch (e) {
            res = { status: "unknown", reason: (e as Error).message };
          }
          if (res.status === "found") {
            // The lookup reports inclusion, not finality: "in_block" until a finality read says otherwise.
            this.updateStep(r.approvalHash, st.index, {
              status: res.success
                ? res.finalized
                  ? "finalized"
                  : "in_block"
                : res.finalized
                  ? "failed"
                  : "in_block",
              block: { number: res.blockNumber, hash: res.blockHash },
              note: res.success
                ? `reconciled by tx hash: in block #${res.blockNumber} (extrinsic ${res.extrinsicIndex}); ${res.finalized ? "canonical finality confirmed; effect verification is separate" : "finality not read"}`
                : `reconciled by tx hash: in block #${res.blockNumber}, dispatch failed`,
            });
            if (!res.finalized) uncertain = true;
          } else {
            this.updateStep(r.approvalHash, st.index, {
              status: "uncertain",
              note:
                res.status === "not_found"
                  ? `not seen in blocks #${res.scannedFrom}..#${res.scannedTo} (not proof it didn't land); not sent again`
                  : `lookup unknown: ${res.reason}`,
            });
            uncertain = true;
          }
        } else if (this.isClaimed(r.approvalHash, st.index)) {
          this.updateStep(r.approvalHash, st.index, {
            status: "uncertain",
            note: "a send was started but no tx hash was recorded; it may have been broadcast. Not sent again.",
          });
          uncertain = true;
        } else if (st.status === "signed" || st.status === "pending") {
          this.updateStep(r.approvalHash, st.index, {
            status: "not_sent",
            note: "signed bytes are gone after the refresh; not sent. A new approval is needed.",
          });
          abandoned = true;
        }
      }
      const steps = this.run(r.approvalHash)!.steps;
      const phase: RunPhase = steps.every((s) => s.status === "finalized")
        ? "finalized"
        : uncertain
          ? "uncertain"
          : abandoned
            ? "abandoned"
            : steps.some((s) => s.status === "failed")
              ? "failed"
              : steps.some((s) => s.status === "blocked")
                ? "blocked"
                : r.phase;
      this.upsertRun({ ...this.run(r.approvalHash)!, phase });
    }
    return this.runs();
  }
}

/** The policy's in-memory approval store, seeded from and persisting used keys (single-use across refreshes). */
export class PersistedApprovalStore extends InMemoryApprovalStore {
  private runStore: RunStore;
  constructor(runStore: RunStore) {
    super();
    this.runStore = runStore;
    // Storage failures are surfaced by RunStore.problem() and every write/claim. Construction must allow read-only UI.
    try {
      for (const k of runStore.usedKeys()) super.markUsed(k);
    } catch {
      /* signing remains blocked */
    }
  }
  override markUsed(key: string): void {
    this.runStore.markUsed(key);
    super.markUsed(key);
  }
}

/** window.localStorage when available (browser), else undefined (nothing persisted). */
export function browserKV(): KV | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real reconcile lookup: @seam/chain/browser lookupTxByHash over the given RPC, from the era birth block (the
 * envelope checkpoint) recorded with the run. Without a recorded birth block it answers unknown; it never guesses one.
 */
export function chainTxLookup(
  send: (method: string, params: unknown[]) => Promise<unknown>,
): TxLookup {
  return async (q) => {
    if (q.fromBlock === undefined)
      return { status: "unknown", reason: "no era birth block was recorded for this run" };
    const result = await lookupTxByHash(send as never, {
      txHash: q.txHash as `0x${string}`,
      fromBlock: q.fromBlock,
      maxBlocks: 128,
    });
    if (result.status !== "found") return result;
    const head = await send("chain_getFinalizedHead", []);
    const header = (await send("chain_getHeader", [head])) as { number?: string } | null;
    const canonical = await send("chain_getBlockHash", [result.blockNumber]);
    const number = header?.number ? Number(BigInt(header.number)) : NaN;
    return {
      ...result,
      finalized:
        Number.isSafeInteger(number) &&
        result.blockNumber <= number &&
        canonical === result.blockHash,
    };
  };
}
