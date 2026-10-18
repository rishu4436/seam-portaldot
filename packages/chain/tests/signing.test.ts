import { describe, expect, it, beforeAll } from "vitest";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { callsToSign } from "@seam/policy";
import {
  assembleSignedExtrinsic,
  buildSigningRequest,
  buildSigningRequests,
  checkSignedExtrinsic,
  extractSignedCall,
  signedCallsOf,
  type SigningEnvelope,
  type SigningRequest,
} from "../src/index.js";
import {
  ALICE,
  ALICE_HEX,
  BOB,
  CHECKPOINT,
  atomicPlan,
  demoPlan,
  devKeys,
  snapshotFacts,
} from "./helpers.js";

const facts = snapshotFacts();
const envelope: SigningEnvelope = {
  signer: ALICE,
  nonce: 7,
  mortalityBlocks: 64,
  checkpoint: CHECKPOINT,
  expiresAt: "2026-10-11T13:00:00.000Z",
};
let keys: Awaited<ReturnType<typeof devKeys>>;
beforeAll(async () => {
  keys = await devKeys();
});

/** Plays the user's wallet. TEST ONLY: signs with the public //Alice dev seed. SEAM itself never holds keys. */
const walletSign = (req: SigningRequest, pair = keys.alice) =>
  u8aToHex(pair.sign(hexToU8a(req.signBytesHex), { withType: true }));

describe("signing handoff (offline, spec 1002 snapshot)", () => {
  it("is deterministic: same plan + envelope + checkpoint give byte-identical payloads", () => {
    const a = buildSigningRequests(demoPlan(), facts, envelope);
    const b = buildSigningRequests(demoPlan(), facts, { ...envelope }, { ...CHECKPOINT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.map((r) => r.nonce)).toEqual([7, 8, 9]);
    expect(a.map((r) => r.actionIds)).toEqual([["pay"], ["call"], ["receipt"]]);
  });

  it("builds an extension-compatible SignerPayloadJSON with the right chain values", () => {
    const [r] = buildSigningRequests(demoPlan(), facts, envelope);
    expect(r!.payload).toMatchObject({
      address: ALICE,
      blockHash: CHECKPOINT.hash,
      blockNumber: "0x002986af",
      genesisHash: facts.fingerprint.genesisHash,
      method: demoPlan().steps[0]!.encodedCall,
      nonce: "0x00000007",
      specVersion: "0x000003ea",
      transactionVersion: "0x00000002",
      tip: "0x00000000000000000000000000000000",
      version: 4,
      signedExtensions: [
        "CheckSpecVersion",
        "CheckTxVersion",
        "CheckGenesis",
        "CheckMortality",
        "CheckNonce",
        "CheckWeight",
        "ChargeTransactionPayment",
      ],
    });
    expect(r!.era).toEqual({
      mortal: true,
      period: 64,
      phase: CHECKPOINT.number % 64,
      hex: r!.payload.era,
    });
    // payload = call ++ era ++ Compact(nonce) ++ Compact(tip) ++ spec ++ txVersion ++ genesis ++ blockHash
    expect(r!.signingPayloadHex).toBe(
      `${r!.callHex}${r!.era.hex.slice(2)}1c00ea03000002000000${facts.fingerprint.genesisHash.slice(2)}${CHECKPOINT.hash.slice(2)}`,
    );
    expect(r!.signBytesHex).toBe(r!.signingPayloadHex); // short enough to sign directly
    expect(r!.raw).toEqual({ address: ALICE, data: r!.signingPayloadHex, type: "payload" });
  });

  it("sign -> assemble -> extractSignedCall round-trips to exactly the plan's call bytes", () => {
    const plan = demoPlan();
    const reqs = buildSigningRequests(plan, facts, envelope);
    const signed = reqs.map((r) => assembleSignedExtrinsic(r.payload, walletSign(r), facts));
    const extracted = signed.map((x) => extractSignedCall(x, facts));
    expect(extracted.map((e) => e.callHex)).toEqual(plan.steps.map((s) => s.encodedCall));
    expect(signedCallsOf(signed, facts)).toEqual(callsToSign(plan as never));
    expect(extracted[0]).toMatchObject({
      capability: "Assets.transfer_keep_alive",
      palletIndex: 26,
      callIndex: 6,
      signer: { accountId: ALICE_HEX, ss58: ALICE },
      nonce: 7,
      tip: "0",
      signatureScheme: "sr25519",
      era: reqs[0]!.era,
    });
    expect(extracted[1]!.capability).toBe("Contracts.call");
    expect(extracted[2]!.capability).toBe("Assets.mint");
    reqs.forEach((r, i) =>
      expect(checkSignedExtrinsic(signed[i]!, r, facts)).toMatchObject({
        ok: true,
        mismatches: [],
      }),
    );
  });

  it("atomic plans sign exactly one call: the batch_all outerCall", () => {
    const { plan, facts: f } = atomicPlan();
    expect(plan.mode).toBe("atomic_verified");
    const reqs = buildSigningRequests(plan, f, envelope);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.callHex).toBe(plan.outerCall!.encodedCall);
    expect(reqs[0]!.actionIds).toEqual(["pay", "call", "receipt"]);
    const tx = assembleSignedExtrinsic(reqs[0]!.payload, walletSign(reqs[0]!), f);
    expect(extractSignedCall(tx, f)).toMatchObject({
      callHex: plan.outerCall!.encodedCall,
      capability: "Utility.batch_all",
    });
  });

  it("hashes payloads longer than 256 bytes before signing, like polkadot.js", () => {
    const remark = facts.capabilities["System.remark"]!;
    const hex2 = (n: number) => n.toString(16).padStart(2, "0");
    // System.remark(300 bytes): Compact(300) = 0xb104
    const call =
      `0x${hex2(remark.palletIndex!)}${hex2(remark.callIndex!)}b104${"aa".repeat(300)}` as const;
    const long = buildSigningRequest(call, facts, {
      signer: ALICE,
      nonce: 0,
      mortalityBlocks: 64,
      checkpoint: CHECKPOINT,
    });
    expect(hexToU8a(long.signingPayloadHex).length).toBeGreaterThan(256);
    expect(hexToU8a(long.signBytesHex).length).toBe(32);
    const tx = assembleSignedExtrinsic(long.payload, walletSign(long), facts);
    expect(checkSignedExtrinsic(tx, long, facts).ok).toBe(true);
  });

  it("detects a tampered call inside a signed extrinsic", () => {
    const plan = demoPlan();
    const [r] = buildSigningRequests(plan, facts, envelope);
    const tx = assembleSignedExtrinsic(r!.payload, walletSign(r!), facts);
    // Change the last byte of the amount (inside the call, after the signature).
    const tampered = (tx.slice(0, -2) + (tx.endsWith("09") ? "0a" : "09")) as `0x${string}`;
    const ex = extractSignedCall(tampered, facts);
    expect(ex.callHex).not.toBe(plan.steps[0]!.encodedCall);
    const check = checkSignedExtrinsic(tampered, r!, facts);
    expect(check.ok).toBe(false);
    expect(check.mismatches.map((m) => m.field)).toEqual(["call", "signature"]);
  });

  it("refuses a signature that does not match the payload, or a wrong signer", () => {
    const [r, r2] = buildSigningRequests(demoPlan(), facts, envelope);
    expect(() => assembleSignedExtrinsic(r!.payload, walletSign(r2!), facts)).toThrow(
      /BAD_SIGNATURE/,
    );
    expect(() => assembleSignedExtrinsic(r!.payload, walletSign(r!, keys.bob), facts)).toThrow(
      /BAD_SIGNATURE/,
    );
    // untyped 64-byte signatures need the scheme, never guessed
    const raw = u8aToHex(keys.alice.sign(hexToU8a(r!.signBytesHex)));
    expect(() => assembleSignedExtrinsic(r!.payload, raw, facts)).toThrow(/pass the scheme/);
    expect(
      extractSignedCall(
        assembleSignedExtrinsic(r!.payload, raw, facts, { scheme: "sr25519" }),
        facts,
      ).callHex,
    ).toBe(r!.callHex);
  });

  it("refuses a payload edited for another chain, runtime or tip", () => {
    const [r] = buildSigningRequests(demoPlan(), facts, envelope);
    const sig = walletSign(r!);
    expect(() =>
      assembleSignedExtrinsic({ ...r!.payload, genesisHash: `0x${"11".repeat(32)}` }, sig, facts),
    ).toThrow(/PAYLOAD_MISMATCH: .*genesisHash/);
    expect(() =>
      assembleSignedExtrinsic({ ...r!.payload, specVersion: "0x000003eb" }, sig, facts),
    ).toThrow(/specVersion/);
    expect(() => assembleSignedExtrinsic({ ...r!.payload, tip: "0x01" }, sig, facts)).toThrow(
      /tip/,
    );
  });

  it("checks the envelope: signer, nonce, mortality, plan/facts match", () => {
    const plan = demoPlan();
    expect(() => buildSigningRequests(plan, facts, { ...envelope, signer: BOB })).toThrow(
      /ENVELOPE_INVALID: envelope signer/,
    );
    expect(() => buildSigningRequests(plan, facts, { ...envelope, mortalityBlocks: 100 })).toThrow(
      /power of two/,
    );
    expect(() => buildSigningRequests(plan, facts, { ...envelope, nonce: -1 })).toThrow(/nonce/);
    expect(() =>
      buildSigningRequests({ ...plan, fingerprintDigest: `0x${"00".repeat(32)}` }, facts, envelope),
    ).toThrow(/FACTS_MISMATCH/);
    expect(() => buildSigningRequests({ ...plan, mode: "unavailable" }, facts, envelope)).toThrow(
      /PLAN_NOT_SIGNABLE/,
    );
    expect(() =>
      buildSigningRequests(plan, facts, { ...envelope, checkpoint: undefined as never }),
    ).toThrow(/no checkpoint/);
    expect(() =>
      buildSigningRequests(plan, facts, { ...envelope, checkpoint: { number: 1, hash: "0x12" } }),
    ).toThrow(/32-byte block hash/);
    // accepts the signer as AccountId32 hex too
    expect(
      buildSigningRequests(plan, facts, { ...envelope, signer: ALICE_HEX })[0]!.payload.address,
    ).toBe(ALICE);
  });

  it("rejects unsigned or non-canonical extrinsics", () => {
    const [r] = buildSigningRequests(demoPlan(), facts, envelope);
    const tx = assembleSignedExtrinsic(r!.payload, walletSign(r!), facts);
    expect(() => extractSignedCall(`${tx}00`, facts)).toThrow(/NOT_SIGNED/);
    expect(() => extractSignedCall("0x280403000b00a08429a101", facts)).toThrow(/not signed/);
  });
});
