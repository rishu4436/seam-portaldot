import {
  parseNativeSwapPlan,
  type NativeSwapPlan,
  type NativeSwapVerification,
} from "@seam/chain/browser";
export const NATIVE_SWAP_STORE = "seam.native-swaps.v1";
export type NativeSwapRow = {
  plan: NativeSwapPlan;
  state: "signing" | "not_sent" | "submitted" | "uncertain" | "verified" | "reverted" | "expired";
  hash?: `0x${string}`;
  verification?: NativeSwapVerification;
  note?: string;
};
type KV = Pick<Storage, "getItem" | "setItem">;
const states = ["signing", "not_sent", "submitted", "uncertain", "verified", "reverted", "expired"];
const hash = (v: unknown): v is `0x${string}` =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const redact = (text: string) =>
  text.replace(/0x[0-9a-f]{130,}/gi, "[transaction data]").slice(0, 1000);
function checkedVerification(value: NativeSwapVerification): NativeSwapVerification {
  if (
    !value ||
    !["verified", "reverted", "pending", "failed", "expired"].includes(value.status) ||
    typeof value.message !== "string" ||
    (value.actualOut !== undefined && !/^(0|[1-9]\d*)$/.test(value.actualOut)) ||
    (value.actualFee !== undefined && !/^(0|[1-9]\d*)$/.test(value.actualFee)) ||
    (value.block &&
      (!Number.isSafeInteger(value.block.number) ||
        value.block.number < 0 ||
        !hash(value.block.hash)))
  )
    throw Error("Invalid native verification record.");
  return {
    status: value.status,
    message: redact(value.message),
    ...(value.block ? { block: { number: value.block.number, hash: value.block.hash } } : {}),
    ...(value.actualOut !== undefined ? { actualOut: value.actualOut } : {}),
    ...(value.actualFee !== undefined ? { actualFee: value.actualFee } : {}),
  };
}
function row(input: unknown, imported = false): NativeSwapRow {
  const r = input as NativeSwapRow;
  if (
    !r ||
    !states.includes(r.state) ||
    (r.hash !== undefined && !hash(r.hash)) ||
    (["submitted", "uncertain", "verified", "reverted", "expired"].includes(r.state) && !r.hash)
  )
    throw Error("Invalid native swap journal entry.");
  const plan = parseNativeSwapPlan(r.plan);
  // Imported proofs are claims until the chain is read again. Copy only the allow-listed public fields.
  return {
    plan,
    state: imported ? (r.hash ? "submitted" : "not_sent") : r.state,
    ...(r.hash ? { hash: r.hash } : {}),
    ...(!imported && r.verification ? { verification: checkedVerification(r.verification) } : {}),
    ...(typeof r.note === "string" ? { note: redact(r.note).slice(0, 500) } : {}),
  };
}
export class NativeSwapStore {
  readonly kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }
  list(): NativeSwapRow[] {
    const raw = this.kv.getItem(NATIVE_SWAP_STORE);
    if (!raw) return [];
    if (raw.length > 512000) throw Error("Native swap journal exceeds its storage limit.");
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !Array.isArray(value.rows) || value.rows.length > 100)
      throw Error("Native swap journal is invalid.");
    return value.rows.map((r: unknown) => row(r));
  }
  save(value: NativeSwapRow) {
    const clean = row(value),
      rows = this.list(),
      index = rows.findIndex((r) => r.plan.id === clean.plan.id);
    if (clean.hash && rows.some((r) => r.hash === clean.hash && r.plan.id !== clean.plan.id))
      throw Error("This transaction hash is already attached to another native swap plan.");
    if (index >= 0) rows[index] = clean;
    else rows.unshift(clean);
    if (rows.length > 100)
      throw Error(
        "Export your native swap archive before starting more tests; the journal is full.",
      );
    const raw = JSON.stringify({ version: 1, rows });
    if (raw.length > 512000) throw Error("Native swap journal exceeds its storage limit.");
    this.kv.setItem(NATIVE_SWAP_STORE, raw);
    if (this.kv.getItem(NATIVE_SWAP_STORE) !== raw)
      throw Error("Native swap journal was not persisted. Submission is blocked.");
  }
  assertReady(planId?: string, ownSigning = false) {
    const rows = this.list();
    if (planId && rows.some((r) => r.plan.id === planId && r.hash))
      throw Error(
        "This native swap plan was already submitted. Recover its transaction; do not sign it again.",
      );
    if (
      rows.some(
        (r) =>
          ["submitted", "uncertain"].includes(r.state) ||
          (r.state === "signing" && !(ownSigning && r.plan.id === planId)),
      )
    )
      throw Error("Recover the pending native swap before requesting another signature.");
  }
  abandonUnsigned() {
    for (const r of this.list())
      if (r.state === "signing")
        this.save({
          ...r,
          state: "not_sent",
          note: "Signing was interrupted. Nothing was submitted by Seam.",
        });
  }
  export() {
    return { archiveVersion: 1, kind: "seam-native-swaps", rows: this.list() };
  }
  restore(input: unknown) {
    const a = input as { archiveVersion: number; kind: string; rows: unknown[] };
    if (!a || a.kind !== "seam-native-swaps")
      throw Error(
        "This file is not a native swap archive. Restore composer receipts in Activity & recovery, or inspect them in Receipt inspector.",
      );
    if (a.archiveVersion !== 1 || !Array.isArray(a.rows))
      throw Error("Unsupported or invalid native swap archive format.");
    if (a.rows.length > 100 || JSON.stringify(input).length > 512000)
      throw Error("Native swap archives support at most 100 records and 500 KB.");
    const incoming = a.rows.map((r) => row(r, true)),
      rows = this.list(),
      ids = new Map(rows.map((r) => [r.plan.id, r]));
    for (const r of incoming) {
      const old = ids.get(r.plan.id);
      if (
        r.hash &&
        [...ids.values()].some(
          (existing) => existing.hash === r.hash && existing.plan.id !== r.plan.id,
        )
      )
        throw Error("Conflicting plan for the same transaction hash. Nothing was restored.");
      if (old?.hash && r.hash && old.hash !== r.hash)
        throw Error("Conflicting transaction hash in archive. Nothing was restored.");
      if (!old || (!old.hash && r.hash)) ids.set(r.plan.id, r);
    }
    const merged = [...ids.values()];
    if (merged.length > 100) throw Error("Merged archive would exceed 100 records.");
    const encoded = JSON.stringify({ version: 1, rows: merged });
    if (encoded.length > 512000) throw Error("Merged archive is too large.");
    this.kv.setItem(NATIVE_SWAP_STORE, encoded);
    if (this.kv.getItem(NATIVE_SWAP_STORE) !== encoded) throw Error("Archive storage failed.");
    return incoming.length;
  }
}
