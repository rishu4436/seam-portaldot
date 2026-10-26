// @vitest-environment node
// Console receipt integrity: policyDigest, evidenceCoverage and integrityHash, with no secret bytes. A real console
// receipt (real engine approval on V3 spec 3002 facts, offline) is run through main's `seam verify` CLI.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { blockTimeFromFacts, buildSigningEnvelope } from "@seam/chain/browser";
import { policyDigest } from "@seam/policy/browser";
import { preSign, type ChainFns } from "../signflow";
import { buildSequentialReceipt } from "../seqreceipt";
import { checkIntegrity, integrityHashOf, sealReceipt, SECRET_KEYS } from "../receiptintegrity";

const root = (p: string) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const demo = json("packages/console/src/demo/v3-demo-transfer.json");
const seq = json("packages/console/src/demo/v3-demo-transfer-policy-sequential.json");
const recorded = json("evidence/testnet-v3/preflight-1792509095721.json").result;
const facts = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});
const chain: ChainFns = {
  preflight: vi.fn(async () => recorded),
  signedExtrinsicDecoder: () => () => null,
  blockTimeFromFacts: blockTimeFromFacts as never,
  buildSigningEnvelope: buildSigningEnvelope as never,
};
const CLI = root("packages/sdk/dist/cli.js");

async function realReceipt() {
  const pre = await preSign({
    chain,
    send: async () => null,
    input: { policy: seq.policy, plan: demo.plan, manifest: demo.manifest },
    facts,
    signer: demo.manifest.signer.value,
    ctx: {
      nonce: 0,
      mortalityBlocks: 64,
      checkpointNumber: 118892,
      checkpointHash: "0x" + "11".repeat(32),
    },
    now: new Date("2026-10-26T12:00:00Z"),
  });
  if (!pre.res.ok) throw new Error(pre.res.message);
  const p = pre.res.value;
  return buildSequentialReceipt({
    ok: false,
    signRequests: 0,
    steps: demo.plan.steps.map((s: { actionId: string }, index: number) => ({
      index,
      actionId: s.actionId,
      status: "not_run",
      message: "Not run.",
    })),
    stoppedAt: 0,
    message: "Stopped at step 1: test run, nothing signed.",
    approval: { hash: p.approval.hash, inputs: { ...p.approvalInput, now: p.approvedAt } },
    plan: demo.plan,
  });
}

function verify(r: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "seam-receipt-"));
  const f = join(dir, "receipt.json");
  writeFileSync(f, JSON.stringify(r));
  let stdout: string;
  try {
    stdout = execFileSync("node", [CLI, "verify", f, "--json"], { encoding: "utf8" });
  } catch (e) {
    stdout = (e as { stdout: string }).stdout; // non-zero exit: the receipt claims not_verified
  }
  const out = JSON.parse(stdout) as {
    consoleReceipt: {
      status: string;
      checks: { check: string; status: string; code?: string; detail: string }[];
    };
  };
  const by = (c: string) => out.consoleReceipt.checks.filter((x) => x.check === c);
  return { out, by };
}

describe("console receipt integrity", () => {
  it("adds policyDigest, evidenceCoverage, integrityAlgo and integrityHash; the hash covers every other field", async () => {
    const r = await realReceipt();
    expect(r.policyDigest).toBe(policyDigest(seq.policy));
    expect(r.evidenceCoverage).toMatchObject({
      dispatchResult: "unknown",
      verifiedEffect: "unknown",
    });
    expect(r.integrityHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(checkIntegrity(r as never)).toBe(true);
    expect(checkIntegrity({ ...r, result: "verified" } as never)).toBe(false);
    expect(checkIntegrity({ ...r, policyDigest: "0x" + "00".repeat(32) } as never)).toBe(false);
  });

  it("never carries secret bytes: signed bytes and metadataHex are dropped before hashing", () => {
    const sealed = sealReceipt(
      {
        receiptKind: "seam/console-live-receipt/v1",
        x: { signedTx: "0xdead", metadataHex: "0xbeef", keep: 1 },
      } as Record<string, unknown>,
      {
        feeEstimate: "unknown",
        signedDryRun: "unknown",
        dispatchResult: "unknown",
        verifiedEffect: "unknown",
        basis: "t",
      },
    );
    const text = JSON.stringify(sealed);
    for (const k of SECRET_KEYS) expect(text).not.toContain(`"${k}"`);
    expect(text).not.toContain("0xdead");
    expect(integrityHashOf(sealed as never)).toBe(sealed.integrityHash);
  });

  it("seam verify CLI checks the real receipt: approval hash, policyDigest, integrity_hash_match and coverage_states_valid pass", async () => {
    const r = await realReceipt();
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/metadataHex|signedTx|signedExtrinsics/);
    const { out, by } = verify(r);
    expect(out.consoleReceipt.status).toBe("integrity_checked");
    expect(by("approval_hash")[0]!.status).toBe("pass");
    expect(by("policy_digest")[0]!.status).toBe("pass");
    // seam verify recomputes integrityHash (CONSOLE_INTEGRITY_ALGO) and checks the coverage states.
    expect(by("integrity_hash")[0]!.status).toBe("pass");
    expect(by("integrity_hash")[0]!.code).toBe("integrity_hash_match");
    expect(by("evidence_coverage")[0]!.status).toBe("pass");
    expect(by("evidence_coverage")[0]!.code).toBe("coverage_states_valid");
  });

  it("a tampered policyDigest fails main's seam verify", async () => {
    const r = await realReceipt();
    const { out, by } = verify({ ...r, policyDigest: "0x" + "00".repeat(32) });
    expect(out.consoleReceipt.status).toBe("failed");
    expect(by("policy_digest")[0]!.status).toBe("fail");
  });
});
