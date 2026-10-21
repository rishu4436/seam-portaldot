/**
 * P1-05 release readiness: package.json shape, every export path resolves to a built file, the documented API in
 * docs/sdk.md equals the real exports, and the offline consumer example runs. Needs `npm run build` first (CI does).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${pkgDir}package.json`, "utf8"));

describe("@seam/sdk release readiness", () => {
  it("stays private, licensed, versioned and engine-pinned", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("Apache-2.0");
    expect(existsSync(`${pkgDir}LICENSE`)).toBe(true);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "LICENSE", "README.md"]));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.engines?.node).toBe(">=20");
  });

  it("every export, types and bin path exists after build", () => {
    const paths: string[] = [pkg.main, pkg.types, ...Object.values<string>(pkg.bin)];
    for (const v of Object.values<string | Record<string, string>>(pkg.exports))
      paths.push(...(typeof v === "string" ? [v] : Object.values(v)));
    for (const p of paths) expect(existsSync(`${pkgDir}${p}`), p).toBe(true);
  });

  it("docs/sdk.md API reference equals the real exports", () => {
    execFileSync("node", [`${root}scripts/sdk-api-doc.mjs`, "--check"], { stdio: "pipe" });
  });

  it("the offline consumer example runs through the public package names", () => {
    const out = execFileSync("node", [`${root}examples/consumer/index.mjs`], { encoding: "utf8" });
    expect(out).toContain("Plan for 1 step");
    expect(out).toContain("outcome: partial");
    expect(out).toContain("recorded receipt: checkReceipt=true; integrity: integrity_checked");
    expect(out).toContain("tampered receipt: checkReceipt=false");
  });
});
