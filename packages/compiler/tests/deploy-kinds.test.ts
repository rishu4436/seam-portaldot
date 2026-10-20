// revive.instantiate_with_code and revive.map_account against the REAL committed V3 spec 3002 metadata blob
// (evidence/v3-discovery). Offline: these tests prove encoding and the decodedArgs Sentinel's deploy policy reads.
// They prove nothing about execution on V3: no deploy or mapping was sent by this suite.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { keccakAsHex } from "@polkadot/util-crypto";
import { describe, expect, it } from "vitest";
import { compile, factsFromMetadata, type Manifest } from "../src/index.js";
import { ALICE, H160, expectIssue, realFacts } from "./helpers.js";
import { syntheticFacts } from "./synthetic-v3.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const metadataHex = readFileSync(
  root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
  "utf8",
).trim();
const GENESIS = "0x" + "11".repeat(32);
const v3 = () =>
  factsFromMetadata({ metadataHex, genesisHash: GENESIS, tokenSymbol: "tPOT", tokenDecimals: 14 });
const reg = new TypeRegistry();
reg.setMetadata(new Metadata(reg, metadataHex as `0x${string}`));
const decode = (hex: string) => reg.createType("Call", hex).toHuman() as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const CODE = "0x50564d00deadbeef";
const deployArgs = (extra: Record<string, unknown> = {}) => ({
  value: "0",
  gasLimit: "5000000000",
  proofSize: "200000",
  storageDepositLimit: "10000000000000",
  code: CODE,
  data: "0x",
  ...extra,
});
const m = (
  actions: { kind: string; args: Record<string, unknown> }[],
  signer: Manifest["signer"] = { type: "ss58", value: ALICE },
): Manifest =>
  ({
    version: 1,
    signer,
    actions: actions.map((a, i) => ({ id: `a${i}`, ...a })),
  }) as Manifest;

describe("revive.instantiate_with_code on real V3 spec 3002 metadata (offline)", () => {
  it("encodes Revive.instantiate_with_code at 80/3 with every argument from the manifest", () => {
    const s = compile(m([{ kind: "revive.instantiate_with_code", args: deployArgs() }]), v3())
      .steps[0]!;
    expect(s).toMatchObject({ status: "ok", palletIndex: 80, callIndex: 3 });
    expect(s.encodedCall!.startsWith("0x5003")).toBe(true);
    const d = decode(s.encodedCall!);
    expect(d.section).toBe("revive");
    expect(d.method).toBe("instantiateWithCode");
    expect(d.args.code).toBe(CODE);
    expect(d.args.salt).toBeNull();
  });
  it("decodedArgs carry exactly the fields the deploy policy reads, with codeHash computed from code", () => {
    const s = compile(m([{ kind: "revive.instantiate_with_code", args: deployArgs() }]), v3())
      .steps[0]!;
    expect(s.decodedArgs).toMatchObject({
      codeHash: keccakAsHex(CODE, 256),
      value: "0",
      gasLimit: "5000000000",
      proofSize: "200000",
      storageDepositLimit: "10000000000000",
    });
  });
  it("a caller-supplied codeHash is rejected", () =>
    expectIssue(
      () =>
        compile(
          m([
            {
              kind: "revive.instantiate_with_code",
              args: deployArgs({ codeHash: "0x" + "00".repeat(32) }),
            },
          ]),
          v3(),
        ),
      "MANIFEST_INVALID",
      "codeHash",
    ));
  it("salt is encoded when given and must be 32 bytes", () => {
    const salt = "0x" + "ab".repeat(32);
    const s = compile(
      m([{ kind: "revive.instantiate_with_code", args: deployArgs({ salt }) }]),
      v3(),
    ).steps[0]!;
    expect(decode(s.encodedCall!).args.salt).toBe(salt);
    expectIssue(
      () =>
        compile(
          m([{ kind: "revive.instantiate_with_code", args: deployArgs({ salt: "0x01" }) }]),
          v3(),
        ),
      "MANIFEST_INVALID",
      "salt",
    );
  });
  it("missing limits, a null storage limit and empty code are refused", () => {
    for (const k of ["gasLimit", "proofSize", "storageDepositLimit", "code"]) {
      const a = deployArgs();
      delete (a as Record<string, unknown>)[k];
      expectIssue(
        () => compile(m([{ kind: "revive.instantiate_with_code", args: a }]), v3()),
        "MANIFEST_INVALID",
        k,
      );
    }
    expectIssue(
      () =>
        compile(
          m([
            {
              kind: "revive.instantiate_with_code",
              args: deployArgs({ storageDepositLimit: null }),
            },
          ]),
          v3(),
        ),
      "MANIFEST_INVALID",
      "storageDepositLimit",
    );
    expectIssue(
      () =>
        compile(
          m([{ kind: "revive.instantiate_with_code", args: deployArgs({ code: "0x" }) }]),
          v3(),
        ),
      "MANIFEST_INVALID",
      "code",
    );
  });
  it("fails closed off V3: no call (Portaldot mainnet) or a different shape (dev node)", () => {
    for (const [f, code] of [
      [realFacts(), "NO_OBSERVED_V3_METADATA"],
      [syntheticFacts(), "V3_ARG_SHAPE_MISMATCH"],
    ] as const) {
      const s = compile(m([{ kind: "revive.instantiate_with_code", args: deployArgs() }]), f)
        .steps[0]!;
      expect(s.status).toBe("unavailable");
      expect(s.encodedCall).toBeNull();
      expect(s.reasonCode).toBe(code);
    }
  });
  it("an h160 signer is refused", () =>
    expectIssue(
      () =>
        compile(
          m([{ kind: "revive.instantiate_with_code", args: deployArgs() }], {
            type: "h160",
            value: H160,
          }),
          { ...v3(), signingAccountBytes: 20 },
        ),
      "ADDRESS_TYPE",
    ));
});

describe("revive.map_account on real V3 spec 3002 metadata (offline)", () => {
  it("encodes Revive.map_account at 80/7 with no arguments, account = the signer", () => {
    const s = compile(m([{ kind: "revive.map_account", args: {} }]), v3()).steps[0]!;
    expect(s).toMatchObject({ status: "ok", palletIndex: 80, callIndex: 7, encodedCall: "0x5007" });
    expect(s.decodedArgs).toEqual({ account: ALICE });
  });
  it("takes no manifest arguments", () =>
    expectIssue(
      () => compile(m([{ kind: "revive.map_account", args: { account: ALICE } }]), v3()),
      "MANIFEST_INVALID",
      "account",
    ));
  it("map_account then deploy compiles as two steps, deterministically", () => {
    const man = m([
      { kind: "revive.map_account", args: {} },
      { kind: "revive.instantiate_with_code", args: deployArgs() },
    ]);
    const a = compile(man, v3());
    const b = compile(man, v3());
    expect(a.steps.map((s) => s.status)).toEqual(["ok", "ok"]);
    expect(a.planDigest).toBe(b.planDigest);
  });
});
