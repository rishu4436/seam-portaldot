import type { Hex } from "viem";
import {
  digest,
  exactKeys,
  hash,
  invariant,
  object,
  parsePlan,
  parseRegistry,
  type Plan,
  type Registry,
} from "./model.js";
export type Attempt = {
  phase: "reset" | "approve" | "execute" | "revoke";
  to: string;
  data: Hex;
  nonce: number;
  fromBlock: string;
  gas: string;
  gasPrice: string;
  hash?: Hex;
  state: "requesting" | "submitted" | "confirmed" | "reverted" | "rejected" | "uncertain";
  fee?: string;
};
export type RecordEntry = {
  version: 1;
  registry: Registry;
  plan: Plan;
  attempts: Attempt[];
  createdAt: string;
  updatedAt: string;
};
export type StorageLike = Pick<Storage, "getItem" | "setItem">;
export const STORE_KEY = "seam.defi.records.v1";
// A single write is atomic in localStorage. Failure aborts the wallet request.
// Restored evidence never restores a send permission or removes an existing claim.
export class DeFiStore {
  constructor(private readonly storage: StorageLike) {}
  list(): RecordEntry[] {
    const text = this.storage.getItem(STORE_KEY);
    if (!text) return [];
    invariant(text.length <= 4_000_000, "Local DeFi journal exceeds size limit");
    const rows: unknown = JSON.parse(text);
    invariant(Array.isArray(rows) && rows.length <= 200, "Invalid local DeFi journal");
    return rows.map(validateRecord);
  }
  save(row: RecordEntry) {
    validateRecord(row);
    const rows = this.list(),
      at = rows.findIndex((r) => r.plan.id === row.plan.id);
    if (at < 0) {
      invariant(
        rows.length < 200,
        "Export receipts before starting more plans; local journal is full",
      );
      rows.unshift(row);
    } else rows[at] = row;
    const text = JSON.stringify(rows);
    invariant(text.length <= 4_000_000, "Journal full; export evidence before continuing");
    this.storage.setItem(STORE_KEY, text);
  }
  export() {
    const records = this.list();
    return JSON.stringify(
      { format: "seam.defi.archive.v1", records, integrity: digest(records) },
      null,
      2,
    );
  }
  remove(id: string) {
    const rows = this.list(),
      row = rows.find((r) => r.plan.id === id);
    if (!row) return false;
    invariant(
      !row.attempts.some((a) => ["requesting", "submitted", "uncertain"].includes(a.state)),
      "Unresolved wallet claims cannot be removed. Recover or reconcile them first.",
    );
    this.storage.setItem(STORE_KEY, JSON.stringify(rows.filter((r) => r.plan.id !== id)));
    return true;
  }
  restore(text: string) {
    invariant(text.length <= 4_000_000, "Archive exceeds 4 MB limit");
    const archive = object(JSON.parse(text));
    exactKeys(archive, ["format", "records", "integrity"]);
    invariant(
      archive.format === "seam.defi.archive.v1" &&
        Array.isArray(archive.records) &&
        archive.records.length <= 200,
      "Unsupported DeFi archive",
    );
    invariant(archive.integrity === digest(archive.records), "Archive integrity mismatch");
    const incoming = archive.records.map(validateRecord),
      rows = this.list();
    let added = 0;
    for (const row of incoming) {
      const old = rows.find((r) => r.plan.id === row.plan.id);
      if (old) {
        invariant(
          digest(old.plan) === digest(row.plan) && digest(old.registry) === digest(row.registry),
          "Conflicting plan identity",
        );
        continue;
      }
      // Imports are evidence only: requesting/confirmed/etc are rechecked live before display.
      rows.push(row);
      added++;
    }
    invariant(rows.length <= 200, "Merged archive exceeds 200 plans");
    const out = JSON.stringify(rows);
    invariant(out.length <= 4_000_000, "Merged archive exceeds size limit");
    this.storage.setItem(STORE_KEY, out);
    return { checked: incoming.length, added };
  }
  unresolved(account: string, chainId: number) {
    return this.list().flatMap((row) =>
      row.registry.chainId === chainId && row.plan.account.toLowerCase() === account.toLowerCase()
        ? row.attempts
            .filter((a) => ["requesting", "submitted", "uncertain"].includes(a.state))
            .map((attempt) => ({ row, attempt }))
        : [],
    );
  }
}
function validateRecord(input: unknown): RecordEntry {
  const v = object(input);
  exactKeys(v, ["version", "registry", "plan", "attempts", "createdAt", "updatedAt"]);
  invariant(
    v.version === 1 && Array.isArray(v.attempts) && v.attempts.length <= 20,
    "Invalid journal record",
  );
  const registry = parseRegistry(v.registry),
    plan = parsePlan(v.plan, registry);
  invariant(
    typeof v.createdAt === "string" &&
      Number.isFinite(Date.parse(v.createdAt)) &&
      typeof v.updatedAt === "string" &&
      Number.isFinite(Date.parse(v.updatedAt)),
    "Invalid journal time",
  );
  for (const item of v.attempts) {
    const a = object(item);
    exactKeys(a, [
      "phase",
      "to",
      "data",
      "nonce",
      "fromBlock",
      "gas",
      "gasPrice",
      "state",
      ...(a.hash !== undefined ? ["hash"] : []),
      ...(a.fee !== undefined ? ["fee"] : []),
    ]);
    invariant(
      ["reset", "approve", "execute", "revoke"].includes(String(a.phase)) &&
        ["requesting", "submitted", "confirmed", "reverted", "rejected", "uncertain"].includes(
          String(a.state),
        ),
      "Invalid attempt state",
    );
    invariant(
      typeof a.to === "string" &&
        /^0x[0-9a-f]{40}$/i.test(a.to) &&
        typeof a.data === "string" &&
        /^0x(?:[0-9a-f]{2}){0,4096}$/i.test(a.data),
      "Invalid attempt payload",
    );
    invariant(Number.isSafeInteger(a.nonce) && Number(a.nonce) >= 0, "Invalid nonce");
    for (const n of [a.fromBlock, a.gas, a.gasPrice, ...(a.fee !== undefined ? [a.fee] : [])])
      invariant(typeof n === "string" && /^(0|[1-9]\d{0,77})$/.test(n), "Invalid attempt number");
    if (a.hash !== undefined) hash(a.hash);
    invariant(
      !["submitted", "confirmed", "reverted"].includes(String(a.state)) || a.hash !== undefined,
      "A network-confirmed attempt requires a transaction hash",
    );
    invariant(
      a.state !== "rejected" || a.hash === undefined,
      "A rejected wallet request cannot contain a submitted hash",
    );
  }
  return {
    version: 1,
    registry,
    plan,
    attempts: v.attempts as Attempt[],
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}
