import { describe, expect, it } from "vitest";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { compile } from "@seam/compiler";
import * as chainNode from "@seam/chain";
import * as chainBrowser from "@seam/chain/browser";
import metadataHex from "../../../../chain/fixtures/portaldot-mainnet-metadata.hex?raw";
import snapshot from "../../../../chain/fixtures/portaldot-mainnet-snapshot.json";
import { createLiveHost, hasChainFacts, loadLiveHost } from "../host";

// Synthetic: facts come from the repo's recorded snapshot, the call is a hand-made assets.transfer. No V3 chain, no real wallet.
const facts = chainNode.factsFromChainInputs(
  chainNode.chainInputsFromSnapshot(snapshot as never, metadataHex.trim()),
);
const hash = (h: string) => "0x" + "ee".repeat(32) + h.length;
const CALL = "0x0600" as const;

async function signed() {
  await cryptoWaitReady();
  const alice = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri("//Alice");
  const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const plan = compile(
    {
      version: 1,
      chain: {
        genesisHash: facts.fingerprint.genesisHash,
        specVersion: facts.fingerprint.specVersion,
      },
      signer: { type: "ss58", value: ALICE, ss58Prefix: 42 },
      actions: [
        {
          id: "pay",
          kind: "assets.transfer",
          args: { assetId: "1", amount: "1000", recipient: BOB },
        },
      ],
    },
    facts,
  );
  const call = plan.steps[0]!.encodedCall!;
  const request = chainNode.buildSigningRequest(
    call as `0x${string}`,
    facts,
    {
      signer: alice.address,
      nonce: 3,
      mortalityBlocks: 64,
      checkpoint: { number: 100, hash: ("0x" + "bb".repeat(32)) as `0x${string}` },
    },
    { actionIds: ["a1"] },
  );
  const sig = u8aToHex(alice.sign(hexToU8a(request.signBytesHex), { withType: true }));
  return { request, sig };
}

describe("loadLiveHost", () => {
  it("fails closed with no facts, local demo facts, or facts without metadata", async () => {
    expect(await loadLiveHost()).toBeUndefined();
    expect(
      await loadLiveHost({
        fingerprint: { genesisHash: "0xab", specVersion: 1, transactionVersion: 1 },
        capabilities: [],
      }),
    ).toBeUndefined();
    expect(
      await loadLiveHost({ ...facts, source: { metadataHex: "0x", typesBundle: "" } }),
    ).toBeUndefined();
    expect(hasChainFacts(null)).toBe(false);
    expect(hasChainFacts(facts)).toBe(true);
  });
  it("installs a host from real-shape facts, loading the browser entry lazily", async () => {
    const host = await loadLiveHost(facts);
    expect(host).toBeDefined();
    expect(typeof host!.verifyBinding).toBe("function");
    expect(host!.extrinsicHash("0x00")).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("buildRequest says unavailable while the browser entry has no request builder", () => {
    const host = createLiveHost(chainBrowser, facts, hash);
    const has = "buildSigningRequest" in chainBrowser;
    const r = host.buildRequest({
      signer: "x",
      callHex: CALL,
      actionIds: [],
      context: {
        genesisHash: "0x",
        specVersion: 1,
        transactionVersion: 1,
        nonce: 0,
        checkpointHash: "0x",
        checkpointNumber: 1,
        mortalityBlocks: 64,
      },
    });
    if (!has) expect(r).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("host verifyBinding with the real browser entry", () => {
  it("accepts the exact signed extrinsic and rejects tampered bytes", async () => {
    const host = createLiveHost(chainBrowser, facts, hash);
    const { request, sig } = await signed();
    const tx = (await host.assemble(sig, request)) as string;
    expect(await host.verifyBinding(tx, request)).toEqual({ ok: true, reasons: [] });
    const bytes = hexToU8a(tx);
    bytes[bytes.length - 1] ^= 1; // flip a bit in the call bytes
    const bad = await host.verifyBinding(u8aToHex(bytes), request);
    expect(bad.ok).toBe(false);
    expect(bad.reasons.length).toBeGreaterThan(0);
    expect((await host.verifyBinding("0xdeadbeef", request)).ok).toBe(false);
  });
  it("rejects a different request than the one signed", async () => {
    const host = createLiveHost(chainBrowser, facts, hash);
    const { request, sig } = await signed();
    const tx = (await host.assemble(sig, request)) as string;
    const other = { ...request, nonce: request.nonce + 1 };
    expect((await host.verifyBinding(tx, other)).ok).toBe(false);
  });
});
