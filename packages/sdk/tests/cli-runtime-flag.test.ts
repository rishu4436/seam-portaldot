import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprintDigest } from "@seam/compiler";
import { parseRuntimeFlag } from "../src/cliargs.js";

const RUN = fileURLToPath(
  new URL("../../../evidence/testnet-v3/runs/plan-sequential-1792411270138.json", import.meta.url),
);
const load = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const record = load(RUN);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("--runtime <file> (REAL V3 run record)", () => {
  it("a run record gives its own fingerprint, unchanged, and it is the one the receipt is for", () => {
    const fp = parseRuntimeFlag(RUN, load)!;
    expect(fp).toEqual(record.fingerprint);
    expect(fp.specName).toBe("portaldot-v3");
    expect(fp.specVersion).toBe(3002);
    expect(computeFingerprintDigest(fp)).toBe(record.nftVerdictReceipt.receipt.fingerprintDigest);
  });

  it("a bare RuntimeFingerprint JSON is accepted as is", () => {
    const d = mkdtempSync(join(tmpdir(), "seam-rt-"));
    const f = join(d, "fp.json");
    writeFileSync(f, JSON.stringify(record.fingerprint));
    expect(parseRuntimeFlag(f, load)).toEqual(record.fingerprint);
  });

  it("no flag gives undefined", () => {
    expect(parseRuntimeFlag(undefined, load)).toBeUndefined();
  });

  it("a bad file gives a clear error", () => {
    const d = mkdtempSync(join(tmpdir(), "seam-rt-"));
    const notFp = join(d, "plan.json");
    writeFileSync(notFp, JSON.stringify(record.plan));
    const broken = join(d, "broken.json");
    writeFileSync(broken, "{not json");
    expect(() => parseRuntimeFlag(notFp, load)).toThrow(
      /neither a run record with a "fingerprint" nor a RuntimeFingerprint/,
    );
    expect(() => parseRuntimeFlag(broken, load)).toThrow(/--runtime: cannot read/);
    expect(() => parseRuntimeFlag(join(d, "missing.json"), load)).toThrow(/--runtime: cannot read/);
    expect(() => parseRuntimeFlag("", load)).toThrow(/--runtime needs a file/);
  });
});

describe.skipIf(!existsSync(cli))("seam verify --runtime (CLI)", () => {
  it("a bad --runtime file is a usage error before any node is contacted", () => {
    const d = mkdtempSync(join(tmpdir(), "seam-rt-"));
    const receipt = join(d, "receipt.json");
    writeFileSync(receipt, JSON.stringify(record.nftVerdictReceipt.receipt));
    const bad = join(d, "bad.json");
    writeFileSync(bad, JSON.stringify({ hello: 1 }));
    // Port 9 on localhost: if the CLI tried to connect first, the error would be about the node, not --runtime.
    const r = spawnSync(
      "node",
      [cli, "verify", "--endpoint", "ws://127.0.0.1:9", "--runtime", bad, receipt],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/--runtime: .* is neither a run record/);
  });
});
