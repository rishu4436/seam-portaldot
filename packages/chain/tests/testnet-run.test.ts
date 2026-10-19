/**
 * scripts/testnet-run.mjs end to end against the LOCAL dev node (SEAM_DEVNODE=1; start it with scripts/devnode.sh).
 * Evidence goes to a temp dir, never evidence/testnet-v3. The signer is the public //Alice dev seed passed through
 * SEAM_SIGNER, and the "browser wallet" is a software stand-in for the polkadot.js extension.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const LIVE = process.env.SEAM_DEVNODE === "1";
const NODE_URL = process.env.SEAM_DEVNODE_URL ?? "ws://127.0.0.1:9944";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CLI = here("../../../scripts/testnet-run.mjs");
const DEV = [
  "--types",
  here("../fixtures/devnode-types.json"),
  "--token",
  "UNIT:12",
  "--block-time-ms",
  "6000",
];
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const tmp = () => mkdtempSync(`${tmpdir()}/seam-testnet-run-`);
const run = (args: string[], env: Record<string, string> = {}) => {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CLI, ...args], {
        encoding: "utf8",
        env: { ...process.env, SEAM_SIGNER: "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 280_000,
      }),
    };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};
const files = (dir: string) => readdirSync(`${dir}/runs`).sort();
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const allText = (dir: string) =>
  [
    `${dir}/runtime-report.json`,
    `${dir}/testnet-summary.json`,
    ...files(dir).map((f) => `${dir}/runs/${f}`),
  ]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

describe("testnet-run: refusals (offline: any socket or DNS attempt fails the child)", () => {
  const offline = {
    NODE_OPTIONS: `--import ${pathToFileURL(here("./fixtures/no-network.mjs")).href}`,
  };
  it("refuses the Portaldot mainnet endpoint (by URL, before any network call) and non-ws URLs", () => {
    const m = run(["wss://mainnet.portaldot.io"], offline);
    expect(m.out).toMatch(/refusing: that is the Portaldot mainnet endpoint/);
    expect(m.out).not.toMatch(/NETWORK ATTEMPTED/);
    expect(m.code).not.toBe(0);
    expect(run(["wss://mainnet.portaldot.io:443/ws"], offline).out).toMatch(/mainnet endpoint/);
    expect(run(["http://example.com"], offline).code).toBe(2);
    expect(run([], offline).code).toBe(2);
  }, 60_000);
  it("the offline harness really blocks the network (a non-mainnet URL fails on the network attempt, not silently)", () => {
    const r = run(["ws://127.0.0.1:1"], offline);
    expect(r.code).not.toBe(0);
  }, 60_000);
});

describe.skipIf(!LIVE)("testnet-run against the local dev node (SEAM_DEVNODE=1)", () => {
  // A fresh dev node is at its genesis block, where every signed dry run reports BadProof (see past-genesis.mjs).
  // testnet-run dry-runs its setup calls, so build block 1 first. Real networks are never at genesis.
  beforeAll(() => {
    const head = execFileSync("node", [here("../scripts/devnode/past-genesis.mjs")], {
      encoding: "utf8",
      env: { ...process.env, SEAM_DEVNODE_URL: NODE_URL },
      timeout: 120_000,
    });
    expect(Number(head.trim())).toBeGreaterThan(0);
  }, 120_000);
  it("read-only: writes a plain runtime report and signs nothing", () => {
    const out = tmp();
    const r = run([NODE_URL, ...DEV, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/read-only/);
    const rep = json(`${out}/runtime-report.json`);
    expect(rep).toMatchObject({
      metadataVersion: 14,
      chain: { specName: "substrate-contracts-node", specVersion: 100 },
      token: { symbol: "UNIT", decimals: 12 },
      fingerprintStableOnRefetch: true,
    });
    expect(rep.has).toMatchObject({ Contracts: true, Revive: true, Assets: true });
    expect(rep.contractsCall.shape).toMatch(/^V14/);
    expect(() => readdirSync(`${out}/runs`)).toThrow();
  }, 120_000);

  it("a signer without --yes signs and sends nothing", () => {
    const out = tmp();
    const r = run([NODE_URL, ...DEV, "--out", out], { SEAM_SIGNER: "//Alice" });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/--yes/);
    expect(() => readdirSync(`${out}/runs`)).toThrow();
  }, 120_000);

  let deployed: string | undefined;
  it("--yes: deploys the demo contract through SEAM, then runs sequential, rollback and atomic", () => {
    const out = tmp();
    const r = run([NODE_URL, ...DEV, "--out", out, "--yes", "--asset-id", "1"], {
      SEAM_SIGNER: "//Alice",
    });
    expect(r.out).not.toMatch(/\/\/Alice/);
    expect(r.code).toBe(0);
    const s = json(`${out}/testnet-summary.json`);
    expect(s.deploy).toMatchObject({ ok: true, dryRun: "ok", status: "finalized" });
    expect(s.deploy.contract).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.deploy.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.signer).toBe(ALICE);
    deployed = s.contract;
    expect(s.flows.sequential.result).toBe("verified");
    expect(s.flows.rollback.result).toBe("verified");
    expect(s.flows.atomic).toMatchObject({ mode: "atomic_verified", result: "verified" });
    expect(s.flows.sequential.steps.map((x: any) => x.status)).toEqual([
      "finalized",
      "finalized",
      "finalized",
    ]);
    // sanitized: no seed, derivation path, signature or signed extrinsic anywhere
    const text = allText(out);
    expect(text).not.toMatch(/\/\/Alice|"signature"|"signedTx"|"mnemonic"|"seed"|"suri"/);
    const seq = json(`${out}/runs/${files(out).find((f) => f.startsWith("sequential"))}`);
    expect(
      seq.gateChecks
        .filter((g: any) => g.phase === "sending")
        .every((g: any) => g.check.ok && g.check.passed.length > 0),
    ).toBe(true);
    expect(
      seq.run.receipt.steps[1].events.some((e: string) =>
        e.startsWith("Contracts.ContractEmitted("),
      ),
    ).toBe(true);
  }, 290_000);

  it("--external: every signature comes from a wallet page (software stand-in for the extension)", async () => {
    const out = tmp();
    const { runBridge } = await import(
      pathToFileURL(here("../scripts/external-signer/bridge-client.js")).href
    );
    const { softwareExtension } = await import(
      pathToFileURL(here("../scripts/external-signer/software-wallet.mjs")).href
    );
    const wallet = await softwareExtension("//Alice");
    const args = [
      CLI,
      NODE_URL,
      ...DEV,
      "--out",
      out,
      "--yes",
      "--asset-id",
      "1",
      "--external",
      ALICE,
      "--only",
      "sequential",
      "--contract",
      deployed ?? json(here("../../../evidence/devnode/state.json")).contract,
    ];
    const child = spawn("node", args, { env: { ...process.env, SEAM_SIGNER: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<number>((ok) => child.on("close", (c) => ok(c ?? -1)));
    const url = await new Promise<string>((ok, bad) => {
      const t = setInterval(() => {
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/.exec(stdout);
        if (m) {
          clearInterval(t);
          ok(m[0]);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(t);
        bad(new Error(`no page URL printed: ${stdout}${stderr}`));
      }, 60_000);
    });
    const u = new URL(url);
    const logs: string[] = [];
    let done = false;
    const bridge = runBridge({
      base: u.origin,
      token: u.searchParams.get("t"),
      injected: wallet.injectedWeb3,
      log: (m: string) => logs.push(m),
      stop: () => done,
    });
    const code = await exited;
    done = true;
    expect(code, stdout + stderr).toBe(0);
    await Promise.race([bridge, new Promise((ok) => setTimeout(ok, 2000))]);
    const s = json(`${out}/testnet-summary.json`);
    expect(s.signedBy).toMatch(/external wallet/);
    expect(s.flows.sequential.result).toBe("verified");
    // 2 recipient funding transfers + 3 sequential steps all went through the wallet
    expect(wallet.seen.length).toBe(5);
    expect(wallet.seen.every((p: any) => p.address === ALICE)).toBe(true);
    expect(allText(out)).not.toMatch(/\/\/Alice|"signature"|"signedTx"/);
  }, 290_000);

  it("--external: a wallet that declines stops the run and nothing is sent", async () => {
    const out = tmp();
    const { runBridge } = await import(
      pathToFileURL(here("../scripts/external-signer/bridge-client.js")).href
    );
    const { softwareExtension } = await import(
      pathToFileURL(here("../scripts/external-signer/software-wallet.mjs")).href
    );
    const wallet = await softwareExtension("//Alice", { decline: () => true });
    const child = spawn(
      "node",
      [
        CLI,
        NODE_URL,
        ...DEV,
        "--out",
        out,
        "--yes",
        "--asset-id",
        "1",
        "--external",
        ALICE,
        "--only",
        "sequential",
        "--contract",
        deployed ?? json(here("../../../evidence/devnode/state.json")).contract,
      ],
      { env: { ...process.env, SEAM_SIGNER: "" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<number>((ok) => child.on("close", (c) => ok(c ?? -1)));
    const url = await new Promise<string>((ok, bad) => {
      const t = setInterval(() => {
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/.exec(stdout);
        if (m) {
          clearInterval(t);
          ok(m[0]);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(t);
        bad(new Error("no URL"));
      }, 60_000);
    });
    const u = new URL(url);
    let done = false;
    void runBridge({
      base: u.origin,
      token: u.searchParams.get("t"),
      injected: wallet.injectedWeb3,
      stop: () => done,
    }).catch(() => {});
    const code = await exited;
    done = true;
    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/declined/);
  }, 120_000);
});
