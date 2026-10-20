import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptIntegrity, verifyReceiptLive, type Receipt } from "../src/index.js";

const runs = (f: string) =>
  fileURLToPath(new URL(`../../../evidence/testnet-v3/runs/${f}`, import.meta.url));
const SEQ = runs("plan-sequential-1792411270138.json");
const ATOMIC = runs("plan-atomic-1792411355057.json");
const REVIVE = runs("plan-revive-call-1792412445848.json");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (...args: string[]) =>
  spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 20000 });
const tmp = (name: string, data: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "seam-rr-")), name);
  writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
  return f;
};
const noReader = new Proxy({}, { get: () => () => Promise.reject(new Error("no network")) });

describe("receipt checks never crash on a non-receipt (the '.find' crash)", () => {
  it("receiptIntegrity on a whole REAL run record is failed, not a TypeError", () => {
    for (const f of [SEQ, ATOMIC]) {
      const rec = JSON.parse(readFileSync(f, "utf8"));
      const r = receiptIntegrity(rec as Receipt);
      expect(r.status).toBe("failed");
      expect(r.note).toMatch(/not a SEAM receipt/);
    }
  });
  it("receiptIntegrity on junk is failed", () => {
    for (const v of [
      null,
      1,
      "x",
      [],
      {},
      { receiptVersion: 1 },
      { receiptVersion: 1, steps: [null] },
    ])
      expect(receiptIntegrity(v as unknown as Receipt).status).toBe("failed");
  });
  it("verifyReceiptLive on a run record fails cleanly before any chain read", async () => {
    const rec = JSON.parse(readFileSync(SEQ, "utf8"));
    const live = await verifyReceiptLive(rec as Receipt, noReader as never);
    expect(live.status).toBe("failed");
    expect(live.problems.join(" ")).toMatch(/not a SEAM receipt/);
  });
});

describe.skipIf(!existsSync(cli))("seam verify <run record> (offline, CLI)", () => {
  it("sequential and atomic REAL records: uses nftVerdictReceipt.receipt, says so, verified", () => {
    for (const f of [SEQ, ATOMIC]) {
      const r = run("verify", f);
      expect(r.stderr).not.toMatch(/Cannot read properties/);
      expect(r.stdout).toContain(`checking its "nftVerdictReceipt.receipt"`);
      expect(r.stdout).toContain("Receipt status: integrity_checked");
      expect(r.stdout).toContain("Verified: all 2 steps finalized");
      expect(r.status).toBe(0);
    }
  });
  it("a record without nftVerdictReceipt falls back to run.receipt", () => {
    const r = run("verify", REVIVE);
    expect(r.stdout).toContain(`checking its "run.receipt"`);
    expect(r.stdout).toContain("Receipt status: integrity_checked");
  });
  it("a malformed record: clear error naming the file and the fields, no crash", () => {
    const f = tmp("bad-record.json", { kind: "seam-run", plan: {}, run: { ok: true } });
    const r = run("verify", f);
    expect(r.stderr + r.stdout).not.toMatch(/Cannot read properties/);
    expect(r.stderr).toContain(f);
    expect(r.stderr).toMatch(/nftVerdictReceipt\.receipt, run\.receipt, receipt/);
    expect(r.status).toBe(1);
  });
  it("a record whose receipt field is broken: failed integrity, no crash", () => {
    const f = tmp("broken-receipt.json", { run: { receipt: { receiptVersion: 1 } } });
    const r = run("verify", f);
    expect(r.stderr + r.stdout).not.toMatch(/Cannot read properties/);
    expect(r.stdout).toMatch(/not a SEAM receipt \(it has no "steps" list\)/);
    expect(r.status).toBe(5);
  });
});
