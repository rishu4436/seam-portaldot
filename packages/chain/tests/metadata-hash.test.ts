/** SEAM-015: events are decoded only if the inclusion block's metadata hash equals the pinned one (spec version alone is not enough). */
import { describe, expect, it } from "vitest";
import { callsToSign } from "@seam/policy";
import type { Hex } from "@seam/compiler";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  chainInputsFromSnapshot,
  createPortaldotAdapter,
  encodeRuntime,
  factsFromChainInputs,
  readEvents,
  signBytesOf,
  type SnapshotJson,
} from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { demoPlan, devKeys, snapshotFacts, snapshotInputs } from "./helpers.js";
import { checkRuntimeLock } from "@seam/policy";
import { patchStorageEntry, withFallback } from "./metadataMutate.js";

const NOW = new Date("2026-10-11T12:00:00Z");
async function run(metadataAtBlocks?: Hex) {
  const keys = await devKeys();
  const facts = snapshotFacts();
  const node = new FakeNode({
    inputs: snapshotInputs(),
    facts,
    existingAssets: ["1", "2"],
    ...(metadataAtBlocks ? { metadataAtBlocks } : {}),
  });
  const adapter = createPortaldotAdapter(node, {
    allowMainnet: true,
    submitTimeoutMs: 2000,
    now: () => NOW,
    facts,
  });
  await adapter.discover();
  const plan = demoPlan(facts);
  const { envelope } = await adapter.preflight(plan);
  const requests = adapter.signingRequests(
    callsToSign(plan).filter((c): c is Hex => !!c),
    envelope,
  );
  const p = requests[0]!.payload;
  const { registry } = encodeRuntime(facts);
  const ext = registry.createType("Extrinsic", { method: p.method }, { version: 4 });
  ext.addSignature(
    p.address,
    hexToU8a(u8aToHex(keys.alice.sign(hexToU8a(signBytesOf(p, facts)), { withType: true }))),
    p,
  );
  const outcome = await adapter.submit(ext.toHex() as Hex, "pay");
  return { outcome, node, facts, adapter };
}

describe("SEAM-015: metadata hash at the inclusion block", () => {
  it("same metadata at the block: events decode and the step is finalized", async () => {
    const { outcome } = await run();
    expect(outcome.status).toBe("finalized");
    expect(outcome.events.length).toBeGreaterThan(0);
  });
  it("same spec version but different metadata at the block: events are NOT decoded or trusted", async () => {
    const other = ("0x" + "00".repeat(4)) as Hex; // not the pinned metadata
    const { outcome, adapter } = await run(other);
    expect(outcome.status).not.toBe("finalized");
    expect(outcome.events).toEqual([]);
    expect(outcome.error ?? "").toMatch(/metadata/i);
    expect(adapter.lastSubmit?.error ?? "").toMatch(/RUNTIME_CHANGED|metadata/i);
  });
  it("readEvents refuses directly too", async () => {
    const bad = await run("0x0000" as Hex);
    const hash = await bad.node.send<Hex>("chain_getBlockHash", [snapshotInputs().head.number + 1]);
    await expect(readEvents(bad.node, hash, 1, bad.facts)).rejects.toThrow(
      /RUNTIME_CHANGED|metadata/i,
    );
  });
});

describe("metadata that differs only in a NON-allow-listed storage default (System.Number) is refused", () => {
  const pinned = snapshotInputs().metadataHex;
  const drifted = withFallback(pinned, "System", "Number", "0x2a000000");
  const renamed = patchStorageEntry(pinned, "System", "Number", (e, reg) => ({
    name: new (e.get("name").constructor)(reg, "Numbr"),
  }));

  it("at the inclusion block: events are NOT decoded (only Revive.EthBlockBuilderIR drift is tolerated)", async () => {
    const { outcome } = await run(drifted);
    expect(outcome.status).not.toBe("finalized");
    expect(outcome.events).toEqual([]);
  });
  it("a real layout change at the inclusion block is still refused", async () => {
    const { outcome } = await run(renamed);
    expect(outcome.status).not.toBe("finalized");
    expect(outcome.events).toEqual([]);
  });
  it("at the head: re-discovery trips RUNTIME_CHANGED and the runtime lock blocks", async () => {
    const facts = snapshotFacts();
    const node = new FakeNode({ inputs: { ...snapshotInputs(), metadataHex: drifted }, facts });
    const adapter = createPortaldotAdapter(node, { allowMainnet: true, now: () => NOW, facts });
    await expect(adapter.discover()).rejects.toThrow(/RUNTIME_CHANGED/);
    const current = await adapter.readFingerprint();
    expect(checkRuntimeLock(facts.fingerprint, current).ok).toBe(false);
  });
  it("at the head: a real layout change still trips re-discovery and the runtime lock", async () => {
    const facts = snapshotFacts();
    const node = new FakeNode({ inputs: { ...snapshotInputs(), metadataHex: renamed }, facts });
    const adapter = createPortaldotAdapter(node, { allowMainnet: true, now: () => NOW, facts });
    await expect(adapter.discover()).rejects.toThrow(/RUNTIME_CHANGED/);
    const current = await adapter.readFingerprint();
    expect(checkRuntimeLock(facts.fingerprint, current)).toMatchObject({
      ok: false,
      changed: ["metadataHash"],
    });
  });
});

describe("V3 finding: metadata that differs only in Revive.EthBlockBuilderIR's default (allow-listed)", () => {
  const ev = (n: string) =>
    fileURLToPath(new URL(`../../../evidence/v3-discovery/${n}`, import.meta.url));
  const snap = JSON.parse(
    readFileSync(ev("portaldot-v3-spec3002-snapshot.json"), "utf8"),
  ) as SnapshotJson;
  const hex = readFileSync(ev("portaldot-v3-spec3002-metadata.hex"), "utf8").trim() as Hex;
  const inputs = chainInputsFromSnapshot(snap, hex);
  const facts = factsFromChainInputs(inputs);
  const drifted = withFallback(hex, "Revive", "EthBlockBuilderIR", "0x2a000000");

  it("at the head: the adapter's re-discovery and re-read fingerprint keep the pinned fingerprint", async () => {
    const node = new FakeNode({ inputs: { ...inputs, metadataHex: drifted }, facts });
    const adapter = createPortaldotAdapter(node, { allowMainnet: true, now: () => NOW, facts });
    await expect(adapter.discover()).resolves.toBe(facts);
    const current = await adapter.readFingerprint();
    expect(checkRuntimeLock(facts.fingerprint, current)).toMatchObject({ ok: true });
  });
});
