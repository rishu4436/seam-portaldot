import { identityDecoding } from "./decoding.js";
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type Hex, type Plan, type RuntimeFacts } from "@seam/compiler";
import { definePolicy, type SigningEnvelope, type SubmitCheck } from "@seam/policy";
import {
  Seam,
  action,
  defineManifest,
  factsFromSnapshot,
  parseAbiFlags,
  parseManifest,
  parseTokenFlag,
  type ChainAdapter,
  type StepEvent,
  type StepOutcome,
  type WalletSigner,
} from "../src/index.js";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const BOB_HEX = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const facts = factsFromSnapshot(p("./fixtures"));
const ERC20 = JSON.parse(readFileSync(p("../../compiler/fixtures/ink/erc20.v5.json"), "utf8"));
const signer = { type: "ss58" as const, value: ALICE, ss58Prefix: 42 };
const base = { contract: BOB, value: "0", gasLimit: "5000000000" };

describe("action.contractCall with the ABI form", () => {
  it("builds message/args/abiRef calls and a Manifest that parses", () => {
    const m = defineManifest({
      signer,
      actions: [
        action.contractCall("t", {
          ...base,
          message: "transfer",
          args: { to: BOB, value: "1000" },
          abiRef: "erc20",
        }),
      ],
    });
    expect(m.actions[0]!.args).toMatchObject({ message: "transfer", abiRef: "erc20" });
  });
  it("keeps the raw data form working", () => {
    const m = defineManifest({
      signer,
      actions: [action.contractCall("t", { ...base, data: "0x633aa551" })],
    });
    expect(m.actions[0]!.args.data).toBe("0x633aa551");
  });
  it("parseManifest accepts proofSize and storageDepositLimit as string or null, and still rejects numbers", () => {
    const ok = (extra: object) =>
      parseManifest({
        version: 1,
        signer,
        actions: [{ id: "c", kind: "contracts.call", args: { ...base, data: "0x00", ...extra } }],
      });
    expect(ok({ proofSize: "1000000", storageDepositLimit: "5" }).ok).toBe(true);
    expect(ok({ storageDepositLimit: null }).ok).toBe(true);
    const bad = ok({ proofSize: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]!.path).toBe("$.actions[0].args.proofSize");
    expect(ok({ value: null }).ok).toBe(false);
  });
});

describe("abis reach the compiler", () => {
  const manifest = () =>
    defineManifest({
      signer,
      actions: [
        action.contractCall("t", {
          ...base,
          message: "transfer",
          args: { to: BOB, value: "1000" },
          abiRef: "erc20",
        }),
      ],
    });
  const noop = {} as ChainAdapter;
  it("Seam.compile uses abis passed per call or as defaults", () => {
    const direct = compile(manifest(), facts, { abis: { erc20: ERC20 } });
    expect(new Seam(noop).compile(manifest(), facts, { abis: { erc20: ERC20 } }).planDigest).toBe(
      direct.planDigest,
    );
    expect(
      new Seam(noop, undefined, { abis: { erc20: ERC20 } }).compile(manifest(), facts).planDigest,
    ).toBe(direct.planDigest);
    expect(direct.steps[0]!.contractMessage).toMatchObject({
      abiRef: "erc20",
      message: "transfer",
    });
  });
  it("a missing ABI is an ABI_INVALID compile error", () => {
    expect(() => new Seam(noop).compile(manifest(), facts)).toThrow(
      /ABI_INVALID|no ABI named "erc20"/,
    );
  });
  it("per-call abis merge with defaults instead of replacing them", () => {
    const s = new Seam(noop, undefined, { abis: { erc20: ERC20 } });
    expect(s.compile(manifest(), facts, { abis: { other: {} } }).steps[0]!.status).toBe("ok");
  });
});

describe("--token parsing", () => {
  it("parses SYMBOL:DECIMALS", () => {
    expect(parseTokenFlag("UNIT:12")).toEqual({ tokenSymbol: "UNIT", tokenDecimals: 12 });
    expect(parseTokenFlag(undefined)).toBeUndefined();
  });
  it.each(["UNIT", "UNIT:", ":12", "UNIT:x", "UNIT:-1", "UNIT:99", "UNIT:12:3", ""])(
    'rejects "%s" with a usage message',
    (v) => {
      expect(() => parseTokenFlag(v)).toThrow(/--token needs SYMBOL:DECIMALS/);
    },
  );
  it("parseAbiFlags builds the abis map and rejects bad input", () => {
    expect(parseAbiFlags([], () => 1)).toBeUndefined();
    expect(parseAbiFlags(["a=x.json", "b=y.json"], (f) => ({ f }))).toEqual({
      a: { f: "x.json" },
      b: { f: "y.json" },
    });
    expect(() => parseAbiFlags(["nofile"], () => 1)).toThrow(/NAME=<file>/);
    expect(() => parseAbiFlags(["a="], () => 1)).toThrow(/NAME=<file>/);
    expect(() => parseAbiFlags(["a=x", "a=y"], () => 1)).toThrow(/twice/);
    expect(() =>
      parseAbiFlags(["a=x"], () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/cannot read x/);
  });
});

describe("declaredToken for snapshots without a token", () => {
  const dir = mkdtempSync(join(tmpdir(), "seam-tok-"));
  cpSync(p("./fixtures"), dir, { recursive: true });
  const snapFile = join(dir, "portaldot-mainnet-snapshot.json");
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  delete snap.properties.tokenSymbol;
  delete snap.properties.tokenDecimals;
  delete snap.declaredToken;
  writeFileSync(snapFile, JSON.stringify(snap));

  it("refuses to guess without it, and says how to fix it", () => {
    expect(() => factsFromSnapshot(dir)).toThrow(/--token SYMBOL:DECIMALS/);
  });
  it("uses the declared token", () => {
    const f = factsFromSnapshot(dir, { declaredToken: { tokenSymbol: "UNIT", tokenDecimals: 12 } });
    expect(f.fingerprint.tokenSymbol).toBe("UNIT");
  });
  it("a token the node does report wins, and a conflicting declaration fails", () => {
    expect(() =>
      factsFromSnapshot(p("./fixtures"), {
        declaredToken: { tokenSymbol: "XXX", tokenDecimals: 1 },
      }),
    ).toThrow(/differs from the declared/);
    expect(
      factsFromSnapshot(p("./fixtures"), {
        declaredToken: { tokenSymbol: "POT", tokenDecimals: facts.fingerprint.tokenDecimals },
      }).fingerprint.tokenSymbol,
    ).toBe("POT");
  });

  const cli = p("../dist/cli.js");
  const man = join(dir, "m.json");
  writeFileSync(
    man,
    JSON.stringify({
      version: 1,
      signer,
      actions: [
        { id: "pay", kind: "assets.transfer", args: { assetId: "1", amount: "1", recipient: BOB } },
      ],
    }),
  );
  const run = (...a: string[]) => spawnSync("node", [cli, ...a], { encoding: "utf8" });
  it.skipIf(!existsSync(cli))(
    "CLI: compile fails without --token, works with it, and rejects a bad format with exit 1",
    () => {
      const no = run("compile", man, "--snapshot", dir);
      expect(no.status).toBe(1);
      expect(no.stderr).toMatch(/--token SYMBOL:DECIMALS/);
      const yes = run("compile", man, "--snapshot", dir, "--token", "UNIT:12");
      expect(yes.status).toBe(0);
      expect(yes.stdout).toMatch(/\(UNIT\)/);
      const bad = run("compile", man, "--snapshot", dir, "--token", "UNIT");
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/--token needs SYMBOL:DECIMALS/);
    },
  );
  it.skipIf(!existsSync(cli))("CLI: --abi NAME=file makes abiRef manifests compile", () => {
    const am = join(dir, "abi.json");
    writeFileSync(
      am,
      JSON.stringify({
        version: 1,
        signer,
        actions: [
          {
            id: "c",
            kind: "contracts.call",
            args: {
              ...base,
              message: "transfer",
              args: { to: BOB, value: "1000" },
              abiRef: "erc20",
            },
          },
        ],
      }),
    );
    const abiFile = p("../../compiler/fixtures/ink/erc20.v5.json");
    expect(run("compile", am, "--snapshot", p("./fixtures")).status).toBe(2);
    const ok = run("compile", am, "--snapshot", p("./fixtures"), "--abi", `erc20=${abiFile}`);
    expect(ok.status).toBe(0);
    expect(run("compile", am, "--snapshot", p("./fixtures"), "--abi", "erc20").status).toBe(1);
  });
});

describe("onStep receives the gate result", () => {
  const policy = definePolicy({
    allowedAssets: ["1", "2"],
    allowedContracts: [BOB],
    allowedRecipients: [BOB],
    allowUnknown: { storageDeposit: true },
  });
  const ok = (n: number): StepOutcome["block"] => ({
    number: n,
    hash: `0x${n.toString(16).padStart(64, "0")}` as Hex,
  });
  const fake = (dry: "ok" | "failed" = "ok") => {
    const chain: ChainAdapter = {
      discover: async () => facts,
      readFingerprint: async () => facts.fingerprint,
      preflight: async (plan: Plan) => ({
        preflight: {
          steps: plan.steps.map((s) => ({
            actionId: s.actionId,
            weight: { value: "1" },
            fee: { value: "1" },
            storageDeposit: { unknown: true },
            dryRun: "ok" as const,
          })),
          totalFee: { value: "2" },
        },
        envelope: {
          signer: ALICE,
          nonce: 1,
          mortalityBlocks: 64,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          checkpoint: { number: 1, hash: `0x${"ab".repeat(32)}` },
        } satisfies SigningEnvelope,
      }),
      dryRunSigned: async (txs: Hex[]) => txs.map((_, i) => (i === 0 ? dry : "unknown")),
      ...identityDecoding(ALICE),
      submit: async (_tx: Hex, id: string): Promise<StepOutcome> => ({
        actionId: id,
        status: "finalized",
        txHash: "0xaa",
        block: ok(1),
        events: [
          {
            pallet: "Assets",
            name: "Transferred",
            args: ["1", ALICE_HEX, BOB_HEX, id === "a" ? "1" : "2"],
          },
          { pallet: "System", name: "ExtrinsicSuccess", args: ["{}"] },
        ],
      }),
    };
    return chain;
  };
  const wallet: WalletSigner = {
    sign: async (calls) => calls.map((c) => ({ signedTx: c, signedCall: c })),
  };
  const two = [
    action.transfer("a", { assetId: "1", amount: "1", recipient: BOB }),
    action.transfer("b", { assetId: "1", amount: "2", recipient: BOB }),
  ];
  const manifest = defineManifest({
    signer,
    actions: two.map((a) => ({ ...a, preferredMode: "sequential" as const })),
  });
  async function go(dry: "ok" | "failed", events: StepEvent[], m = manifest, options = {}) {
    const seam = new Seam(fake(dry));
    const pol =
      "allowAtomicUnverified" in options
        ? { ...policy, allowedModes: [...policy.allowedModes, "atomic_unverified" as const] }
        : policy;
    const pr = await seam.prepare(m, facts, pol, options);
    const a = seam.approve({ ...pr, policy: pol, facts });
    if (!a.ok) throw new Error(a.reason);
    return seam.execute({
      ...pr,
      policy: pol,
      facts,
      approval: a.approval,
      wallet,
      onStep: (e) => events.push(e),
    });
  }
  it("sending and done events carry the passing gate result; checking has none", async () => {
    const events: StepEvent[] = [];
    await go("ok", events);
    const byPhase = (ph: string) => events.filter((e) => e.phase === ph);
    expect(byPhase("checking").every((e) => e.check === undefined)).toBe(true);
    for (const e of [...byPhase("sending"), ...byPhase("done")]) {
      expect(e.check?.ok).toBe(true);
    }
    expect(byPhase("sending").length).toBe(2);
    expect(events.map((e) => `${e.actionId}:${e.phase}`)).toEqual([
      "a:checking",
      "a:sending",
      "a:done",
      "b:checking",
      "b:sending",
      "b:done",
    ]);
  });
  it("an atomic batch reports one gate result for the whole batch", async () => {
    const events: StepEvent[] = [];
    await go(
      "ok",
      events,
      defineManifest({
        signer,
        actions: two.map((a) => ({ ...a, preferredMode: "atomic" as const })),
      }),
      { allowAtomicUnverified: true },
    );
    expect(events.map((e) => `${e.actionId}:${e.phase}`)).toEqual([
      "batch:checking",
      "batch:sending",
      "batch:done",
    ]);
    expect(events[1]!.check?.ok).toBe(true);
    expect(events[2]!.check?.ok).toBe(true);
  });
  it("a blocked step reports the failing gate result with its reasons", async () => {
    const events: StepEvent[] = [];
    const run = await go("failed", events);
    expect(run.ok).toBe(false);
    const blocked = events.find((e) => e.phase === "blocked");
    expect(blocked?.check?.ok).toBe(false);
    const check = blocked!.check as Extract<SubmitCheck, { ok: false }>;
    expect(check.reasons.length).toBeGreaterThan(0);
    expect(blocked!.detail).toBe(check.reasons.map((r) => r.message).join(" "));
  });
  it("old callbacks that read only index/actionId/phase/detail keep working", async () => {
    const log: string[] = [];
    await go("ok", []);
    const seam = new Seam(fake());
    const pr = await seam.prepare(manifest, facts, policy);
    const a = seam.approve({ ...pr, policy, facts });
    if (!a.ok) throw new Error(a.reason);
    await seam.execute({
      ...pr,
      policy,
      facts,
      approval: a.approval,
      wallet,
      onStep: ({ index, actionId, phase, detail }) =>
        log.push(`${index}${actionId}${phase}${detail ?? ""}`),
    });
    expect(log.length).toBe(6);
  });
});
