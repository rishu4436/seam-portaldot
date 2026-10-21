import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isConsoleReceipt,
  pickReceipt,
  verifyConsoleReceiptLive,
  verifyConsoleReceiptOffline,
  type ConsoleReceipt,
  type ReceiptChainReader,
} from "../src/index.js";

// Real console receipts (copied from the LIVE V3 runs, scanned: no keys, seeds, signatures or signed bytes).
const fx = (f: string) => fileURLToPath(new URL(`./fixtures/console/${f}`, import.meta.url));
const SEQ = fx("seq-121390.json"); // 2-step sequential, #121390/#121394, independently verified in evidence/testnet-v3
const SINGLE = fx("single-119996.json"); // single-step builder plan, #119996 (no approvalInputs)
const PARTIAL = fx("seq-120936-partial.json"); // step 1 sent at #120936, step 2 not_run
const load = (f: string) => JSON.parse(readFileSync(f, "utf8")) as ConsoleReceipt;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (...args: string[]) =>
  spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 20000 });
const tmp = (data: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "seam-cr-")), "r.json");
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const st = (
  v: { checks: { check: string; status: string; actionId?: string }[] },
  check: string,
  id?: string,
) =>
  v.checks
    .filter((c) => c.check === check && (id === undefined || c.actionId === id))
    .map((c) => c.status);

describe("console receipts are recognised", () => {
  it("isConsoleReceipt: yes for console receipts, no for SDK receipts and junk", () => {
    for (const f of [SEQ, SINGLE, PARTIAL]) expect(isConsoleReceipt(load(f))).toBe(true);
    for (const v of [null, {}, { receiptVersion: 1 }, { receiptKind: "other" }])
      expect(isConsoleReceipt(v)).toBe(false);
  });
  it("pickReceipt alone still refuses a console receipt (the CLI routes it to the console checks first)", () => {
    expect(() => pickReceipt(load(SEQ), "x.json")).toThrow(/not a SEAM receipt/);
  });
});

describe("offline re-verification of REAL console receipts", () => {
  it("sequential #121390: plan digest and approvalHash recomputed and equal; missing fields not_checked", () => {
    const v = verifyConsoleReceiptOffline(load(SEQ));
    expect(v.kind).toBe("sequential");
    expect(v.status).toBe("integrity_checked");
    expect(st(v, "plan_digest")).toEqual(["pass"]);
    expect(st(v, "approval_hash")).toEqual(["pass"]);
    expect(st(v, "approval_binds_plan")).toEqual(["pass"]);
    expect(st(v, "policy_digest")).toEqual(["not_checked"]);
    expect(st(v, "integrity_hash")).toEqual(["not_checked"]);
    expect(st(v, "evidence_coverage")).toEqual(["not_checked"]);
    // This receipt predates the per-step nonce: not_checked, never pass.
    expect(st(v, "step_nonce")).toEqual(["not_checked", "not_checked"]);
    expect(v.checks.every((c) => c.status !== "fail")).toBe(true);
    expect(v.claimedResult).toBe("verified");
  });
  it("single-step #119996: plan digest recomputed; approval hash not_checked (no approvalInputs)", () => {
    const v = verifyConsoleReceiptOffline(load(SINGLE));
    expect(v.kind).toBe("single");
    expect(v.status).toBe("integrity_checked");
    expect(st(v, "plan_digest")).toEqual(["pass"]);
    expect(st(v, "approval_hash")).toEqual(["not_checked"]);
  });
  it("partial #120936: approvalHash matches; the unsent step is not checked as sent", () => {
    const v = verifyConsoleReceiptOffline(load(PARTIAL));
    expect(v.status).toBe("integrity_checked");
    expect(st(v, "approval_hash")).toEqual(["pass"]);
    expect(v.claimedResult).toBe("partial");
  });
});

describe("offline: tampering fails", () => {
  it("a changed amount in the plan fails the plan digest", () => {
    const r = load(SEQ);
    (r.plan!.steps[0]!.decodedArgs as Record<string, string>).amount = "2";
    const v = verifyConsoleReceiptOffline(r);
    expect(v.status).toBe("failed");
    expect(st(v, "plan_digest")).toEqual(["fail"]);
  });
  it("a changed approvalHash fails", () => {
    const r = load(SEQ);
    r.approvalHash = "0x" + "11".repeat(32);
    expect(st(verifyConsoleReceiptOffline(r), "approval_hash")).toEqual(["fail"]);
  });
  it("changed approval inputs (policy) fail", () => {
    const r = load(SEQ);
    (r.approvalInputs!.policy as Record<string, unknown>).maxSteps = 99;
    expect(verifyConsoleReceiptOffline(r).status).toBe("failed");
  });
  it("a sent step without a tx hash fails", () => {
    const r = load(SEQ);
    delete r.steps![1]!.txHash;
    expect(verifyConsoleReceiptOffline(r).status).toBe("failed");
  });
});

describe("per-step nonce (receipt metadata, nonceSource decoded | signing_request)", () => {
  const withNonces = (a: [number, string], b: [number, string]) => {
    const r = load(SEQ);
    r.steps![0]!.nonce = a[0];
    r.steps![0]!.nonceSource = a[1];
    r.steps![1]!.nonce = b[0];
    r.steps![1]!.nonceSource = b[1];
    return r;
  };
  it("consistent with the envelope (n + sendIndex): still not_checked offline, a claim", () => {
    const v = verifyConsoleReceiptOffline(withNonces([4, "decoded"], [5, "signing_request"]));
    expect(v.status).toBe("integrity_checked");
    expect(st(v, "step_nonce")).toEqual(["not_checked", "not_checked"]);
    expect(
      v.checks.find((c) => c.check === "step_nonce" && c.actionId === "step2")!.detail,
    ).toMatch(/claim/);
  });
  it("a nonce that is not envelope nonce + sendIndex fails", () => {
    expect(
      verifyConsoleReceiptOffline(withNonces([4, "decoded"], [7, "signing_request"])).status,
    ).toBe("failed");
  });
  it("an unknown nonceSource fails", () => {
    expect(verifyConsoleReceiptOffline(withNonces([4, "wallet"], [5, "decoded"])).status).toBe(
      "failed",
    );
  });
  it("Pixel's later fields: policyDigest recomputed from approvalInputs.policy when present", async () => {
    const r = load(SEQ);
    r.policyDigest = "0x" + "22".repeat(32);
    expect(st(verifyConsoleReceiptOffline(r), "policy_digest")).toEqual(["fail"]);
  });
});

// A mock read-only chain built from the receipt's own plan and the values in
// evidence/testnet-v3/seq-transfer-121390-verification.json (nonces 4/5, fees, Assets.Transferred).
function chainFor(
  r: ConsoleReceipt,
  over: { nonces?: (number | undefined)[]; canonical?: string } = {},
): ReceiptChainReader {
  const plan = r.plan!;
  const signer = plan.signer.publicKey as `0x${string}`;
  const fees = ["1470873880829", "1470873873177"];
  return {
    finalizedNumber: async () => 121500,
    canonicalHash: async (n) => {
      const s = r.steps!.find((x) => x.block?.number === n);
      return (over.canonical ?? s?.block?.hash ?? null) as `0x${string}` | null;
    },
    readTx: async (bh, tx) => {
      const i = r.steps!.findIndex((x) => x.txHash === tx && x.block?.hash === bh);
      if (i < 0) return null;
      const a = plan.steps[i]!.decodedArgs as Record<string, string>;
      return {
        extrinsicIndex: 1,
        signer,
        callHex: plan.steps[i]!.encodedCall as `0x${string}`,
        nonce: over.nonces ? over.nonces[i] : [4, 5][i],
        events: [
          {
            pallet: "Assets",
            name: "Transferred",
            args: [a.assetId!, signer, a.recipientAccountId!, a.amount!],
          },
          {
            pallet: "TransactionPayment",
            name: "TransactionFeePaid",
            args: [signer, fees[i]!, "0"],
          },
          { pallet: "System", name: "ExtrinsicSuccess", args: [] },
        ],
      };
    },
  };
}

describe("live re-verification (mock reader, read-only)", () => {
  it("the real sequential receipt is chain_verified when the chain agrees (on-chain nonces 4, 5)", async () => {
    const r = load(SEQ);
    const v = await verifyConsoleReceiptLive(r, chainFor(r));
    expect(v.checks.filter((c) => c.status === "fail" || c.status === "unknown")).toEqual([]);
    expect(v.status).toBe("chain_verified");
    expect(st(v, "nonce")).toEqual(["pass", "pass"]);
  });
  it("an on-chain nonce that differs from envelope + sendIndex fails", async () => {
    const r = load(SEQ);
    expect((await verifyConsoleReceiptLive(r, chainFor(r, { nonces: [4, 6] }))).status).toBe(
      "failed",
    );
  });
  it("a signing_request nonce that differs from the on-chain nonce fails (a claim is not proof)", async () => {
    const r = load(SEQ);
    r.steps![1]!.nonce = 5;
    r.steps![1]!.nonceSource = "signing_request";
    r.approvalInputs!.envelope!.nonce = undefined; // only the per-step claim left to compare
    const v = await verifyConsoleReceiptLive(r, chainFor(r, { nonces: [4, 7] }));
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.check === "nonce" && c.status === "fail")!.detail).toMatch(
      /signing_request/,
    );
  });
  it("an unreadable on-chain nonce is unknown, never verified", async () => {
    const r = load(SEQ);
    expect(
      (await verifyConsoleReceiptLive(r, chainFor(r, { nonces: [undefined, undefined] }))).status,
    ).toBe("unknown");
  });
  it("a non-canonical block fails", async () => {
    const r = load(SEQ);
    expect(
      (await verifyConsoleReceiptLive(r, chainFor(r, { canonical: "0x" + "33".repeat(32) })))
        .status,
    ).toBe("failed");
  });
  it("partial receipt: the sent step can match the chain, the claimed result stays partial", async () => {
    const r = load(PARTIAL);
    const reader = chainFor(r, { nonces: [3, undefined] });
    const base = reader.readTx;
    reader.readTx = async (bh, tx) => {
      const t = await base(bh, tx);
      if (!t) return t;
      return {
        ...t,
        events: t.events.map((e) =>
          e.name === "TransactionFeePaid" ? { ...e, args: [e.args[0]!, "1470874750396", "0"] } : e,
        ),
      };
    };
    const v = await verifyConsoleReceiptLive(r, reader);
    expect(v.status).toBe("chain_verified");
    expect(v.claimedResult).toBe("partial");
  });
});

describe("seam verify <console receipt> (offline, CLI)", () => {
  it("the real sequential receipt: integrity_checked, plan digest and approvalHash re-verified, exit 0 (claims verified)", () => {
    const p = run("verify", SEQ);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(/Receipt status: integrity_checked/);
    expect(p.stdout).toMatch(/ok: plan_digest/);
    expect(p.stdout).toMatch(/ok: approval_hash/);
    expect(p.stdout).toMatch(/not on-chain proof/);
  });
  it("--json carries every check", () => {
    const p = run("verify", SEQ, "--json");
    const j = JSON.parse(p.stdout);
    expect(j.status).toBe("integrity_checked");
    expect(j.consoleReceipt.checks.length).toBeGreaterThan(5);
  });
  it("the real single-step receipt: exit 0, approval hash not checked", () => {
    const p = run("verify", SINGLE);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(/not checked: approval_hash/);
  });
  it("the partial receipt: checks pass but the exit code is not 0", () => {
    expect(run("verify", PARTIAL).status).not.toBe(0);
  });
  it("a tampered receipt: exit 5 (integrity_failed)", () => {
    const r = load(SEQ);
    r.approvalHash = "0x" + "11".repeat(32);
    const p = run("verify", tmp(r));
    expect(p.status).toBe(5);
    expect(p.stdout).toMatch(/FAIL: approval_hash/);
  });
});
