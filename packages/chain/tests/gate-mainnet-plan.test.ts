/** The gate blocks a mainnet-locked plan on a local Portaldot node. Needs that node: SEAM_PORTALDOT_LOCAL=1 (default ws://127.0.0.1:9966). */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/gate-mainnet-plan.mjs", import.meta.url));
describe("gate-mainnet-plan", () => {
  it("refuses a non-local or mainnet endpoint", () => {
    for (const u of ["wss://mainnet.portaldot.io", "ws://example.com:9944"]) {
      expect(() => execFileSync("node", [script, u], { stdio: "pipe" })).toThrow();
    }
  });
  it.skipIf(process.env.SEAM_PORTALDOT_LOCAL !== "1")(
    "records runtime_changed with both digests and no secrets",
    () => {
      const out = `${mkdtempSync(`${tmpdir()}/gate-`)}/r.json`;
      execFileSync(
        "node",
        [script, process.env.SEAM_PORTALDOT_URL ?? "ws://127.0.0.1:9966", "--out", out],
        { stdio: "pipe" },
      );
      const j = JSON.parse(readFileSync(out, "utf8"));
      expect(j.gate.ok).toBe(false);
      expect(j.gate.reasonCodes).toEqual(["runtime_changed"]);
      expect(j.plannedFingerprintDigest).not.toBe(j.localFingerprintDigest);
      expect(j.label).toMatch(/not V3 testnet, not mainnet/);
      expect(JSON.stringify(j)).not.toMatch(/"signature"|"seed"|"mnemonic"|"suri"|\/\/Alice/);
    },
    60_000,
  );
});
