/**
 * SEAM-001 (chain side): a wallet-provided signedCall is never authoritative. The adapter decodes the actual signed
 * extrinsic and refuses to submit anything that is not exactly the approved request. Every case below must fail
 * closed AND submit zero transactions (asserted on the fake node's RPC log).
 */
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { describe, expect, it } from "vitest";
import { callsToSign } from "@seam/policy";
import type { Hex } from "@seam/compiler";
import * as chain from "../src/index.js";
import {
  createPortaldotAdapter,
  encodeRuntime,
  signBytesOf,
  type SigningRequest,
} from "../src/index.js";
import { FakeNode } from "./fakeNode.js";
import { demoPlan, devKeys, snapshotFacts, snapshotInputs } from "./helpers.js";

const NOW = new Date("2026-10-11T12:00:00Z");
const verify = (chain as any).verifySignedAgainstRequest as (
  tx: Hex,
  req: SigningRequest,
  ctx?: any,
) => any;
const verifyBatch = (chain as any).verifySignedBatch as (
  txs: Hex[],
  reqs: SigningRequest[],
  ctx?: any,
) => any;

async function setup() {
  const keys = await devKeys();
  const facts = snapshotFacts();
  const node = new FakeNode({ inputs: snapshotInputs(), facts, existingAssets: ["1", "2"] });
  const adapter = createPortaldotAdapter(node, {
    allowMainnet: true,
    submitTimeoutMs: 2000,
    now: () => NOW,
    facts,
  });
  await adapter.discover();
  const plan = demoPlan(facts);
  const { envelope } = await adapter.preflight(plan);
  const calls = callsToSign(plan).filter((c): c is Hex => !!c);
  const requests = adapter.signingRequests(calls, envelope); // prepares the operation: these are the approved requests
  const { registry } = encodeRuntime(facts);
  const sign = (pair: any, payload: any) =>
    u8aToHex(pair.sign(hexToU8a(signBytesOf(payload, facts)), { withType: true }));
  /** A signed extrinsic that carries `payload` as-is (even a payload the SDK never asked for), signed by `pair`. */
  const forge = (pair: any, payload: any, signature: string = sign(pair, payload)): Hex => {
    const ext = registry.createType("Extrinsic", { method: payload.method }, { version: 4 });
    ext.addSignature(payload.address, hexToU8a(signature), payload);
    return ext.toHex() as Hex;
  };
  const honest = requests.map((r) => forge(keys.alice, r.payload));
  const submits = () =>
    node.log.filter((l) => /submit/i.test(l.method)).length + node.submitted.length;
  return { keys, facts, node, adapter, requests, honest, sign, forge, submits };
}
/** Flips one byte inside the signature of honest[0] (the extrinsic stays well-formed). */
const corruptSignature = (s: any): Hex => {
  const sig = (chain.extractSignedCall(s.honest[0], s.facts).signature as string).slice(2);
  const flipped = sig.slice(0, 20) + (sig[20] === "a" ? "b" : "a") + sig.slice(21);
  return (s.honest[0] as string).replace(sig, flipped) as Hex;
};
const refused = (o: any) => o.status === "failed" && /not sent/i.test(o.error ?? "");

describe("SEAM-001 chain: verifySignedAgainstRequest", () => {
  it("exports the verifier", () => {
    expect(typeof verify).toBe("function");
    expect(typeof verifyBatch).toBe("function");
  });

  it("accepts exactly the approved extrinsic and reports the decoded (not wallet-claimed) call", async () => {
    const s = await setup();
    const r = verify(s.honest[0]!, s.requests[0]!, { facts: s.facts });
    expect(r).toMatchObject({
      ok: true,
      reasons: [],
      signedCall: s.requests[0]!.callHex,
      nonce: s.requests[0]!.nonce,
      tip: "0",
    });
    expect(r.genesis).toBe(s.facts.fingerprint.genesisHash);
  });

  it("a different call under a VALID signature is call_mismatch, and signedCall is the real (different) call", async () => {
    const s = await setup();
    const tx = s.forge(s.keys.alice, { ...s.requests[0]!.payload, method: s.requests[1]!.callHex });
    const r = verify(tx, s.requests[0]!, { facts: s.facts });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("call_mismatch");
    expect(r.signedCall).toBe(s.requests[1]!.callHex);
  });

  it.each([
    [
      "another signer",
      "signer_mismatch",
      (s: any) => s.forge(s.keys.bob, { ...s.requests[0].payload, address: s.keys.bob.address }),
    ],
    [
      "nonce tampering",
      "nonce_mismatch",
      (s: any) =>
        s.forge(s.keys.alice, {
          ...s.requests[0].payload,
          nonce: s.requests[0].payload.nonce.replace(/.$/, "9"),
        }),
    ],
    [
      "immortal era",
      "era_mismatch",
      (s: any) => s.forge(s.keys.alice, { ...s.requests[0].payload, era: "0x00" }),
    ],
    [
      "tip tampering",
      "tip_mismatch",
      (s: any) => s.forge(s.keys.alice, { ...s.requests[0].payload, tip: "0x01" }),
    ],
    [
      "another chain (genesis)",
      "signature_invalid",
      (s: any) =>
        s.forge(
          s.keys.alice,
          { ...s.requests[0].payload, genesisHash: "0x" + "11".repeat(32) },
          s.sign(s.keys.alice, { ...s.requests[0].payload, genesisHash: "0x" + "11".repeat(32) }),
        ),
    ],
    [
      "another spec version",
      "signature_invalid",
      (s: any) => s.forge(s.keys.alice, { ...s.requests[0].payload, specVersion: "0x0000ffff" }),
    ],
    ["corrupted signature", "signature_invalid", (s: any) => corruptSignature(s)],
    [
      "truncated extrinsic",
      "not_decodable",
      (s: any) => (s.honest[0] as string).slice(0, -20) as Hex,
    ],
    [
      "signature bytes cut short (malformed)",
      "not_decodable",
      (s: any) =>
        (s.honest[0] as string).replace(
          (chain.extractSignedCall(s.honest[0], s.facts).signature as string).slice(2),
          (chain.extractSignedCall(s.honest[0], s.facts).signature as string).slice(2, 100),
        ) as Hex,
    ],
  ])("%s fails closed with %s", async (_n, code, make) => {
    const s = await setup();
    const r = verify(make(s), s.requests[0]!, { facts: s.facts });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(code);
  });

  it("a missing ctx cannot pass (fail closed)", async () => {
    const s = await setup();
    expect(verify(s.honest[0]!, s.requests[0]!).ok).toBe(false);
  });

  it("batch: fewer, extra and reordered signed transactions are refused", async () => {
    const s = await setup();
    expect(verifyBatch(s.honest, s.requests, { facts: s.facts }).ok).toBe(true);
    expect(verifyBatch(s.honest.slice(0, 2), s.requests, { facts: s.facts })).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["count_mismatch"]),
    });
    expect(verifyBatch([...s.honest, s.honest[0]!], s.requests, { facts: s.facts })).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["count_mismatch"]),
    });
    const swapped = [s.honest[1]!, s.honest[0]!, s.honest[2]!];
    expect(verifyBatch(swapped, s.requests, { facts: s.facts }).ok).toBe(false);
  });
});

describe("SEAM-001 chain: adapter.submit is bound to the approved requests and submits nothing otherwise", () => {
  const attacks: [string, (s: any) => Hex][] = [
    [
      "signedTx carries a different call",
      (s) => s.forge(s.keys.alice, { ...s.requests[0].payload, method: s.requests[1].callHex }),
    ],
    [
      "another signer",
      (s) => s.forge(s.keys.bob, { ...s.requests[0].payload, address: s.keys.bob.address }),
    ],
    [
      "another chain (genesis)",
      (s) =>
        s.forge(s.keys.alice, { ...s.requests[0].payload, genesisHash: "0x" + "11".repeat(32) }),
    ],
    [
      "nonce tampering",
      (s) => s.forge(s.keys.alice, { ...s.requests[0].payload, nonce: "0x00000009" }),
    ],
    ["era tampering", (s) => s.forge(s.keys.alice, { ...s.requests[0].payload, era: "0x00" })],
    ["tip tampering", (s) => s.forge(s.keys.alice, { ...s.requests[0].payload, tip: "0x05" })],
    [
      "corrupted signature",
      (s) => {
        const tx: string = s.honest[0];
        return (tx.slice(0, -2) + (tx.endsWith("00") ? "01" : "00")) as Hex;
      },
    ],
    ["wrong order (step 2 first)", (s) => s.honest[1]],
  ];
  it.each(attacks)("%s: refused, zero submits", async (_n, make) => {
    const s = await setup();
    const out = await s.adapter.submit(make(s), "pay");
    expect(refused(out)).toBe(true);
    expect(s.submits()).toBe(0);
    expect(s.adapter.lastSubmit).toBeUndefined();
  });

  it("submit with no prepared (approved) request is refused", async () => {
    const s = await setup();
    const fresh = createPortaldotAdapter(s.node, {
      allowMainnet: true,
      facts: s.facts,
      now: () => NOW,
    });
    const out = await fresh.submit(s.honest[0]!, "pay");
    expect(refused(out)).toBe(true);
    expect(s.submits()).toBe(0);
  });

  it("honest transactions in order are submitted; a replay and an extra transaction are refused", async () => {
    const s = await setup();
    const a = await s.adapter.submit(s.honest[0]!, "pay");
    expect(refused(a)).toBe(false);
    const before = s.submits();
    expect(before).toBeGreaterThan(0);
    const replay = await s.adapter.submit(s.honest[0]!, "pay");
    expect(refused(replay)).toBe(true);
    expect(s.submits()).toBe(before);
    await s.adapter.submit(s.honest[1]!, "call");
    await s.adapter.submit(s.honest[2]!, "receipt");
    const afterAll = s.submits();
    const extra = await s.adapter.submit(s.honest[2]!, "receipt");
    expect(refused(extra)).toBe(true);
    expect(s.submits()).toBe(afterAll);
  });

  it("a refused submit does not consume the request: the honest tx still goes through afterwards", async () => {
    const s = await setup();
    const bad = await s.adapter.submit(
      s.forge(s.keys.bob, { ...s.requests[0]!.payload, address: s.keys.bob.address }),
      "pay",
    );
    expect(refused(bad)).toBe(true);
    const good = await s.adapter.submit(s.honest[0]!, "pay");
    expect(refused(good)).toBe(false);
  });
});

describe("SEAM-001 chain: adapter.verifySigned (what the SDK calls before the gate)", () => {
  it("returns the decoded calls for honest transactions", async () => {
    const s = await setup();
    const calls = s.requests.map((r) => r.callHex);
    const { envelope } = await s.adapter.preflight(demoPlan(s.facts));
    expect(s.adapter.verifySigned(s.honest, calls, envelope)).toEqual({
      ok: true,
      signedCalls: calls,
      reasons: [],
    });
  });
  it("reports the real call when the transaction was swapped, and fails closed on fewer/extra/reordered", async () => {
    const s = await setup();
    const calls = s.requests.map((r) => r.callHex);
    const { envelope } = await s.adapter.preflight(demoPlan(s.facts));
    const swapped = s.forge(s.keys.alice, {
      ...s.requests[0]!.payload,
      method: s.requests[1]!.callHex,
    });
    const r = s.adapter.verifySigned([swapped, s.honest[1]!, s.honest[2]!], calls, envelope);
    expect(r.ok).toBe(false);
    expect(r.signedCalls[0]).toBe(s.requests[1]!.callHex); // decoded, not the approved one
    expect(r.reasons.join()).toMatch(/step_0:call_mismatch/);
    expect(s.adapter.verifySigned(s.honest.slice(0, 2), calls, envelope).ok).toBe(false);
    expect(s.adapter.verifySigned([...s.honest, s.honest[0]!], calls, envelope).ok).toBe(false);
    expect(
      s.adapter.verifySigned([s.honest[1]!, s.honest[0]!, s.honest[2]!], calls, envelope).ok,
    ).toBe(false);
    expect(s.submits()).toBe(0);
  });
});

describe("SEAM-001 chain: signedExtrinsicDecoder (the trusted decoder for checkBeforeSubmit)", () => {
  it("decodes the real call, signer, nonce, tip, genesis; signatureValid only under an approved request context", async () => {
    const s = await setup();
    const dec = chain.signedExtrinsicDecoder(s.facts, s.requests);
    const d = dec(s.honest[1]!)!;
    expect(d).toMatchObject({
      call: s.requests[1]!.callHex,
      signer: s.keys.alice.address,
      nonce: s.requests[1]!.nonce,
      tip: "0",
      signatureValid: true,
      genesisHash: s.facts.fingerprint.genesisHash,
    });
    // no requests (no known chain context): the signature cannot be proven
    expect(chain.signedExtrinsicDecoder(s.facts)(s.honest[1]!)!.signatureValid).toBe(false);
    // swapped call under a valid signature: reports the REAL call
    const swapped = s.forge(s.keys.alice, {
      ...s.requests[0]!.payload,
      method: s.requests[1]!.callHex,
    });
    expect(dec(swapped)!.call).toBe(s.requests[1]!.callHex);
    // another signer and a corrupted signature are not valid; garbage gives null
    expect(
      dec(s.forge(s.keys.bob, { ...s.requests[0]!.payload, address: s.keys.bob.address }))!
        .signatureValid,
    ).toBe(false);
    expect(dec(corruptSignature(s))!.signatureValid).toBe(false);
    expect(dec("0x1234")).toBeNull();
  });
});

describe("SEAM-001 chain: adapter.signedDecoder", () => {
  it("is bound to the approved requests for the calls", async () => {
    const s = await setup();
    const { envelope } = await s.adapter.preflight(demoPlan(s.facts));
    const dec = s.adapter.signedDecoder(
      s.requests.map((r) => r.callHex),
      envelope,
    );
    expect(dec(s.honest[0]!)).toMatchObject({ signatureValid: true, call: s.requests[0]!.callHex });
  });
});
