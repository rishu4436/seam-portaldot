import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  consoleIntegrityHash,
  verifyConsoleReceiptOffline,
  type ConsoleReceipt,
} from "../src/index.js";

// sealed-seq-not-run.json was written by the console's own code (bot1/receipt-integrity 17218a7: preSign +
// buildSequentialReceipt + sealReceipt, the same path as its receiptintegrity.test.ts). It is a stopped run on V3 spec
// 3002 facts: nothing signed or sent, so it carries no chain claim. sealed-seq-tampered-hash.json is the same file with
// integrityHash replaced by zeros.
const fx = (f: string) => fileURLToPath(new URL(`./fixtures/console/${f}`, import.meta.url));
const SEALED = fx("sealed-seq-not-run.json");
const TAMPERED = fx("sealed-seq-tampered-hash.json");
const load = (f: string) => JSON.parse(readFileSync(f, "utf8")) as ConsoleReceipt;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (f: string) =>
  spawnSync("node", [cli, "verify", f, "--json"], { encoding: "utf8", timeout: 20000 });
const tmp = (data: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "seam-rih-")), "r.json");
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const row = (v: { checks: { check: string; status: string; code?: string }[] }, check: string) =>
  v.checks.filter((c) => c.check === check).map((c) => `${c.status}:${c.code}`);

describe("console receipt integrityHash", () => {
  it("the console-sealed receipt: recomputed hash equals the console's", () => {
    const r = load(SEALED);
    expect(consoleIntegrityHash(r)).toBe(r.integrityHash);
    const v = verifyConsoleReceiptOffline(r);
    expect(v.status).toBe("integrity_checked");
    expect(row(v, "integrity_hash")).toEqual(["pass:integrity_hash_match"]);
    expect(row(v, "evidence_coverage")).toEqual(["pass:coverage_states_valid"]);
  });
  it("a tampered integrityHash fails", () => {
    const v = verifyConsoleReceiptOffline(load(TAMPERED));
    expect(v.status).toBe("failed");
    expect(row(v, "integrity_hash")).toEqual(["fail:integrity_hash_mismatch"]);
  });
  it("an edited body field with the hash left as is fails", () => {
    const r = load(SEALED);
    r.stopReason = "edited";
    const v = verifyConsoleReceiptOffline(r);
    expect(row(v, "integrity_hash")).toEqual(["fail:integrity_hash_mismatch"]);
    const c = load(SEALED);
    (c.evidenceCoverage as Record<string, string>).signedDryRun = "reported";
    expect(row(verifyConsoleReceiptOffline(c), "integrity_hash")).toEqual([
      "fail:integrity_hash_mismatch",
    ]);
  });
  it("an unsupported integrityAlgo is unknown, never pass", () => {
    const r = load(SEALED);
    r.integrityAlgo = "sha256(something else)";
    const v = verifyConsoleReceiptOffline(r);
    expect(v.status).toBe("unknown");
    expect(row(v, "integrity_hash")).toEqual(["unknown:integrity_algo_unsupported"]);
  });
  it("missing integrityHash: not_present (or unknown when integrityAlgo is there), never pass", () => {
    const r = load(SEALED);
    delete r.integrityHash;
    expect(row(verifyConsoleReceiptOffline(r), "integrity_hash")).toEqual([
      "unknown:integrity_hash_missing",
    ]);
    delete r.integrityAlgo;
    expect(row(verifyConsoleReceiptOffline(r), "integrity_hash")).toEqual([
      "not_checked:integrity_not_present",
    ]);
  });
  it("a malformed integrityHash fails", () => {
    const r = load(SEALED);
    r.integrityHash = "0x1234";
    expect(row(verifyConsoleReceiptOffline(r), "integrity_hash")).toEqual([
      "fail:integrity_hash_malformed",
    ]);
  });
  it("secret keys in a receipt fail (they would sit outside the hash)", () => {
    const r = load(SEALED);
    r.metadataHex = "0xbeef";
    const v = verifyConsoleReceiptOffline(r);
    expect(row(v, "secret_fields")).toEqual(["fail:secret_field_present"]);
    expect(row(v, "integrity_hash")).toEqual(["pass:integrity_hash_match"]);
  });
});

describe("console receipt evidenceCoverage", () => {
  const withCov = (cov: unknown) => ({ ...load(SEALED), evidenceCoverage: cov });
  it("an invalid state fails", () => {
    const r = withCov({ ...load(SEALED).evidenceCoverage!, feeEstimate: "verified" });
    expect(row(verifyConsoleReceiptOffline(r), "evidence_coverage")).toEqual([
      "fail:coverage_invalid_state",
    ]);
  });
  it("a missing key or basis fails; a non-object fails", () => {
    const { verifiedEffect: _v, ...rest } = load(SEALED).evidenceCoverage as Record<string, string>;
    expect(row(verifyConsoleReceiptOffline(withCov(rest)), "evidence_coverage")).toEqual([
      "fail:coverage_invalid_state",
    ]);
    const { basis: _b, ...nob } = load(SEALED).evidenceCoverage as Record<string, string>;
    expect(row(verifyConsoleReceiptOffline(withCov(nob)), "evidence_coverage")).toEqual([
      "fail:coverage_invalid_state",
    ]);
    expect(row(verifyConsoleReceiptOffline(withCov("proven")), "evidence_coverage")).toEqual([
      "fail:coverage_invalid",
    ]);
  });
  it("verifiedEffect proven on a receipt that is not verified fails (never upgraded)", () => {
    const r = withCov({ ...load(SEALED).evidenceCoverage!, verifiedEffect: "proven" });
    expect(row(verifyConsoleReceiptOffline(r), "evidence_coverage")).toEqual([
      "fail:coverage_overclaims",
    ]);
  });
  it("states are reported as recorded: reported stays reported", () => {
    const r = withCov({ ...load(SEALED).evidenceCoverage!, dispatchResult: "reported" });
    const c = verifyConsoleReceiptOffline(r).checks.find((x) => x.check === "evidence_coverage")!;
    expect(c.detail).toMatch(/dispatchResult=reported/);
    expect(c.detail).not.toMatch(/dispatchResult=proven/);
  });
});

describe("seam verify --json on sealed console receipts (CLI)", () => {
  it("honest: integrity_hash pass; exit 7 because the receipt itself claims partial", () => {
    const p = run(SEALED);
    const j = JSON.parse(p.stdout);
    expect(j.status).toBe("integrity_checked");
    expect(row(j.consoleReceipt, "integrity_hash")).toEqual(["pass:integrity_hash_match"]);
    expect(p.status).toBe(7);
  });
  it("tampered integrityHash: failed, exit 5, header does not say self-consistent", () => {
    const p = run(TAMPERED);
    expect(p.status).toBe(5);
    expect(JSON.parse(p.stdout).status).toBe("failed");
    const t = spawnSync("node", [cli, "verify", TAMPERED], { encoding: "utf8", timeout: 20000 });
    expect(t.stdout).toMatch(/FAILED; do not trust this file/);
    expect(t.stdout).not.toMatch(/self-consistent/);
  });
  it("edited body: exit 5; invalid coverage state: exit 5; unsupported algo: exit 6", () => {
    expect(run(tmp({ ...load(SEALED), result: "verified" })).status).toBe(5);
    const bad = { ...load(SEALED) };
    bad.evidenceCoverage = { ...(bad.evidenceCoverage as object), signedDryRun: "maybe" };
    expect(run(tmp(bad)).status).toBe(5);
    const u = run(tmp({ ...load(SEALED), integrityAlgo: "other" }));
    expect(u.status).toBe(6);
    expect(JSON.parse(u.stdout).status).toBe("unknown");
  });
});
