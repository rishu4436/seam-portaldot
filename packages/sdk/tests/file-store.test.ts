/** SEAM-005: a durable ReservableApprovalStore. State survives restarts; a damaged file fails closed. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isReservableStore } from "@seam/policy";
import * as sdk from "../src/index.js";

const FileApprovalStore = (sdk as any).FileApprovalStore as new (path: string) => any;
const file = () => join(mkdtempSync(join(tmpdir(), "seam-store-")), "approvals.json");
const K = "0xaaaa";
const H = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("FileApprovalStore", () => {
  it("is a ReservableApprovalStore with the in-memory lifecycle", () => {
    const s = new FileApprovalStore(file());
    expect(isReservableStore(s)).toBe(true);
    expect(s.has(K)).toBe(false);
    expect(s.stateOf(K)).toBeUndefined();
    const r = s.reserve(K, { idempotencyKey: "attempt-1" });
    expect(r.ok).toBe(true);
    expect(s.has(K)).toBe(true);
    expect(s.reserve(K, { idempotencyKey: "attempt-2" })).toMatchObject({
      ok: false,
      reason: "reserved",
    });
    s.commit(K, { txHash: H });
    expect(s.stateOf(K)).toMatchObject({
      state: "committed",
      txHash: H,
      idempotencyKey: "attempt-1",
    });
    expect(s.reserve(K, { idempotencyKey: "x" })).toMatchObject({
      ok: false,
      reason: "committed",
      txHash: H,
    });
    expect(() => s.release(K)).toThrow();
  });
  it("release makes a reserved key reservable again; reconcile settles uncertain", () => {
    const s = new FileApprovalStore(file());
    s.reserve("a", { idempotencyKey: "1" });
    s.release("a");
    expect(s.has("a")).toBe(false);
    expect(s.reserve("a", { idempotencyKey: "2" }).ok).toBe(true);
    s.markUncertain("a", { note: "timeout" });
    expect(() => s.release("a")).toThrow(/uncertain|reconciled/);
    s.reconcile("a", { outcome: "broadcast", txHash: H });
    expect(s.stateOf("a")).toMatchObject({ state: "committed", txHash: H });
    s.reserve("b", { idempotencyKey: "3" });
    s.markUncertain("b", {});
    s.reconcile("b", { outcome: "not_broadcast" });
    expect(s.has("b")).toBe(false);
  });
  it("legacy markUsed is a committed record", () => {
    const s = new FileApprovalStore(file());
    s.markUsed("m");
    expect(s.stateOf("m")?.state).toBe("committed");
  });

  it("reserved, uncertain and committed survive a restart (a new instance on the same file) and keep blocking", () => {
    const path = file();
    const a = new FileApprovalStore(path);
    a.reserve("r", { idempotencyKey: "ir" });
    a.reserve("u", { idempotencyKey: "iu" });
    a.markUncertain("u", { txHash: H, note: "lost connection" });
    a.reserve("c", { idempotencyKey: "ic" });
    a.commit("c", { txHash: H });
    const b = new FileApprovalStore(path); // "after the crash"
    expect(b.stateOf("r")).toMatchObject({ state: "reserved", idempotencyKey: "ir" });
    expect(b.stateOf("u")).toMatchObject({
      state: "uncertain",
      txHash: H,
      note: "lost connection",
    });
    expect(b.stateOf("c")).toMatchObject({ state: "committed", txHash: H });
    for (const k of ["r", "u", "c"]) {
      expect(b.has(k)).toBe(true);
      expect(b.reserve(k, { idempotencyKey: "again" }).ok).toBe(false);
    }
    expect(() => b.release("u")).toThrow(); // uncertain cannot be released...
    b.reconcile("u", { outcome: "broadcast", txHash: H }); // ...only reconciled
    expect(new FileApprovalStore(path).stateOf("u")?.state).toBe("committed");
  });

  it("two instances on one file never lose each other's updates", () => {
    const path = file();
    const a = new FileApprovalStore(path),
      b = new FileApprovalStore(path);
    for (let i = 0; i < 30; i++) {
      (i % 2 ? a : b).reserve(`k${i}`, { idempotencyKey: `i${i}` });
    }
    const c = new FileApprovalStore(path);
    for (let i = 0; i < 30; i++) expect(c.has(`k${i}`)).toBe(true);
    // the same key from two instances: exactly one wins
    expect(
      [
        a.reserve("same", { idempotencyKey: "x" }).ok,
        b.reserve("same", { idempotencyKey: "y" }).ok,
      ].filter(Boolean),
    ).toHaveLength(1);
  });

  it("separate processes racing for one key: exactly one reserves", () => {
    const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    if (!existsSync(dist)) return; // needs `npm run build`
    const path = file();
    const code = `import { FileApprovalStore } from ${JSON.stringify(pathToFileURL(dist).href)};
      const s = new FileApprovalStore(${JSON.stringify(path)}); let won = 0;
      for (let i = 0; i < 20; i++) if (s.reserve('k' + i, { idempotencyKey: String(process.pid) }).ok) won++;
      console.log(won);`;
    const procs = Array.from({ length: 4 }, () =>
      Number(
        execFileSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" }).trim(),
      ),
    );
    expect(procs.reduce((a, b) => a + b, 0)).toBe(20); // each of 20 keys won exactly once
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).records)).toHaveLength(20);
  }, 60_000);

  it("writes atomically: no temp or lock files left behind, valid JSON after every operation", () => {
    const path = file();
    const s = new FileApprovalStore(path);
    s.reserve("a", { idempotencyKey: "1" });
    s.commit("a", { txHash: H });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
    expect(readdirSync(join(path, "..")).sort()).toEqual(["approvals.json"]);
  });

  it.each([
    ["not JSON", "this is not json {{{"],
    ["empty", ""],
    ["wrong version", JSON.stringify({ version: 99, records: {} })],
    ["bad record", JSON.stringify({ version: 1, records: { a: { key: "a", state: "weird" } } })],
    ["truncated", '{"version":1,"records":{"a":{"key":"a","sta'],
  ])(
    "a corrupt store file (%s) fails closed: every operation throws, nothing is treated as unused",
    (_n, content) => {
      const path = file();
      writeFileSync(path, content);
      const s = new FileApprovalStore(path);
      expect(() => s.has("a")).toThrow(/approval store/i);
      expect(() => s.reserve("a", { idempotencyKey: "1" })).toThrow(/approval store/i);
      expect(() => s.stateOf("a")).toThrow(/approval store/i);
      expect(() => s.markUsed("a")).toThrow(/approval store/i);
      expect(readFileSync(path, "utf8")).toBe(content); // never overwritten or "repaired"
    },
  );
  it("an unreadable path (a directory) fails closed; a missing file is a fresh empty store", () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-store-"));
    expect(() => new FileApprovalStore(dir).has("a")).toThrow(/approval store/i);
    expect(new FileApprovalStore(join(dir, "new.json")).has("a")).toBe(false);
  });
});
