import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  capabilitiesFromModel,
  discoverV3,
  readOnlyClient,
  runtimeApiId,
  runtimeModelFromInputs,
  type CapabilityEntry,
  type V3Capabilities,
} from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { snapshotFacts, snapshotInputs } from "./helpers.js";

const status = (caps: CapabilityEntry[], item: string) => caps.find((c) => c.item === item)?.status;
const tmp = () => mkdtempSync(join(tmpdir(), "v3disc-"));
const script = fileURLToPath(new URL("../scripts/v3-discover.mjs", import.meta.url));
const noNetwork = fileURLToPath(new URL("./fixtures/no-network.mjs", import.meta.url));
/** The fixture is the mainnet spec 1002 metadata; give the fake node another genesis so discovery does not (rightly) refuse it as mainnet. */
const nonMainnetNode = () => {
  const inputs = {
    ...snapshotInputs(),
    genesisHash: `0x${"11".repeat(32)}` as const,
    endpoint: undefined,
  };
  return new FakeNode({ inputs, facts: snapshotFacts() });
};

describe("capability extraction from the real spec 1002 metadata (not V3)", () => {
  const model = runtimeModelFromInputs(snapshotInputs(), {
    rpcMethods: ["rpc_methods", "contracts_call"],
  });
  const caps = capabilitiesFromModel(model);
  it("reports what the metadata contains as observed", () => {
    for (const i of [
      "Contracts",
      "Assets",
      "Utility",
      "Contracts.call",
      "Contracts.instantiate_with_code",
      "Assets.transfer_keep_alive",
      "Utility.batch_all",
    ])
      expect(status(caps, i), i).toBe("observed");
    expect(status(caps, "contracts_call")).toBe("observed");
    expect(caps.filter((c) => c.kind === "signedExtension").length).toBeGreaterThan(3);
  });
  it("reports pallets and calls the metadata lacks as absent, not guessed", () => {
    for (const i of ["Revive", "Revive.call", "Revive.instantiate_with_code", "Nfts", "Nfts.mint"])
      expect(status(caps, i), i).toBe("absent");
    expect(status(caps, "ReviveApi")).toBe("absent");
    expect(status(caps, "ContractsApi")).toBe("observed"); // spec 1002 really lists ContractsApi in runtime version apis
    expect(status(caps, "state_call")).toBe("absent");
  });
  it("a pallet that exists without the asked call reports that call absent", () => {
    expect(status(capabilitiesFromModel({ pallets: { Nfts: ["create"] } }), "Nfts.mint")).toBe(
      "absent",
    );
    expect(
      status(capabilitiesFromModel({ pallets: { Nfts: ["create", "mint"] } }), "Nfts.mint"),
    ).toBe("observed");
  });
  it("synthetic model (not a V3 observation): Revive, Nfts and ReviveApi are observed when listed", () => {
    const c = capabilitiesFromModel({
      pallets: {
        Revive: ["call", "instantiate_with_code", "map_account"],
        Nfts: ["mint"],
        Utility: ["batch_all"],
      },
      runtimeVersionApis: [[runtimeApiId("ReviveApi"), 1]],
      signedExtensions: ["CheckNonce"],
    });
    expect(
      [
        "Revive",
        "Revive.call",
        "Revive.instantiate_with_code",
        "Nfts.mint",
        "Utility.batch_all",
        "ReviveApi",
      ].map((i) => status(c, i)),
    ).toEqual(Array(6).fill("observed"));
    expect(status(c, "Revive.upload_code")).toBe("absent");
    expect(status(c, "Contracts")).toBe("absent");
    expect(status(c, "ContractsApi")).toBe("absent");
  });
  it("anything that could not be read is NOT VERIFIED, never absent", () => {
    const c = capabilitiesFromModel({});
    expect(c.every((e) => e.status === "NOT VERIFIED")).toBe(true);
  });
  it("runtimeApiId is the blake2-64 of the name (Core is the known 0xdf6acb689907609b)", () => {
    expect(runtimeApiId("Core")).toBe("0xdf6acb689907609b");
    expect(
      status(
        capabilitiesFromModel({ runtimeVersionApis: [["0xdf6acb689907609b", 3]] }),
        "ReviveApi",
      ),
    ).toBe("absent");
  });
});

describe("discoverV3 over the fake node", () => {
  it("writes snapshot, v3-capabilities.json and .md, and sends only read methods", async () => {
    const node = nonMainnetNode();
    const out = tmp();
    const res = await discoverV3(node, out);
    const json = JSON.parse(
      readFileSync(join(out, "v3-capabilities.json"), "utf8"),
    ) as V3Capabilities;
    expect(json.kind).toBe("v3-capabilities");
    expect(json.readOnly).toBe(true);
    expect(status(json.capabilities, "Revive")).toBe("absent");
    expect(status(json.capabilities, "Contracts.call")).toBe("observed");
    expect(res.files.snapshot && existsSync(res.files.snapshot)).toBe(true);
    const md = readFileSync(join(out, "v3-capabilities.md"), "utf8");
    expect(md).toMatch(/V3 is NOT VERIFIED until this has been run against a real hosted V3 RPC/);
    expect(md).toMatch(/\| Revive \| pallet \| absent \|/);
    expect(node.submitted).toEqual([]);
    expect(
      node.log.map((c) => c.method).filter((m) => /^(author_|system_dryRun|payment_)/.test(m)),
    ).toEqual([]);
    expect(readdirSync(out).sort()).toContain("v3-capabilities.json");
  });
  it("the read-only wrapper refuses submit and other non-read methods before they reach the node", async () => {
    const node = nonMainnetNode();
    const c = readOnlyClient(node);
    for (const m of [
      "author_submitExtrinsic",
      "author_submitAndWatchExtrinsic",
      "system_dryRun",
      "state_getStorage",
    ])
      await expect(c.send(m, ["0x00"])).rejects.toThrow(/read-only discovery refuses/);
    await expect(c.send("state_call", ["ReviveApi_call", "0x"])).rejects.toThrow(
      /refuses state_call/,
    );
    await expect(
      c.subscribe("x", "author_submitAndWatchExtrinsic", [], () => undefined),
    ).rejects.toThrow(/does not subscribe/);
    expect(node.log).toEqual([]);
    expect(node.submitted).toEqual([]);
  });
  it("refuses a node whose genesis is Portaldot mainnet, and writes nothing", async () => {
    const node = new FakeNode({ inputs: snapshotInputs(), facts: snapshotFacts() });
    const out = join(tmp(), "evidence");
    await expect(discoverV3(node, out)).rejects.toThrow(/genesis hash is Portaldot mainnet/);
    expect(existsSync(out)).toBe(false);
    expect(node.submitted).toEqual([]);
  });
  it("rpc_methods failing leaves RPC items NOT VERIFIED (not absent)", async () => {
    const inputs = { ...snapshotInputs(), genesisHash: `0x${"22".repeat(32)}` as const };
    const node = new FakeNode({ inputs, facts: snapshotFacts(), failRpc: ["rpc_methods"] });
    const res = await discoverV3(node, tmp());
    expect(status(res.capabilities.capabilities, "state_call")).toBe("NOT VERIFIED");
    expect(res.capabilities.rpcMethodsRead).toBe(false);
  });
});

describe("scripts/v3-discover.mjs", () => {
  it("refuses the mainnet URL with no network call, and never takes an override", () => {
    for (const args of [
      ["wss://mainnet.portaldot.io"],
      ["wss://mainnet.portaldot.io", "--allow-mainnet"],
      ["wss://mainnet.portaldot.io", "--out", tmp()],
    ]) {
      const r = spawnSync("node", [script, ...args], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: `--import ${noNetwork}`, SEAM_ALLOW_MAINNET: "1" },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/refusing: that is the Portaldot mainnet endpoint/);
      expect(r.stderr).not.toMatch(/NETWORK ATTEMPTED/);
    }
  });
  it("rejects a non-websocket URL and prints help without a network call", () => {
    const env = { ...process.env, NODE_OPTIONS: `--import ${noNetwork}` };
    expect(spawnSync("node", [script, "http://x"], { encoding: "utf8", env }).status).toBe(2);
    const help = execFileSync("node", [script, "ws://127.0.0.1:1", "--help"], {
      encoding: "utf8",
      env,
    });
    expect(help).toMatch(/NOT VERIFIED/);
  });
});
