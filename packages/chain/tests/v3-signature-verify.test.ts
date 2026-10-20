/* eslint-disable @typescript-eslint/no-explicit-any -- raw polkadot.js objects */
/**
 * Signature verification against ground truth: 19 real finalized V3 (spec 3002) signed extrinsics, including the
 * extension-signed demo transfer 0x8a2c8b92…a4ad in #118310, and a dev-key (//Alice) round trip with polkadot.js's own
 * signPayload (ExtrinsicPayload.sign) and Extrinsic.sign as references. No network; no test keystore.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import {
  assembleSignedExtrinsic,
  buildSigningRequest,
  chainInputsFromSnapshot,
  encodeRuntime,
  factsFromChainInputs,
  signedExtrinsicDecoder,
  type SnapshotJson,
} from "../src/index.js";
import { devKeys } from "./helpers.js";

const ev = (n: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../evidence/v3-discovery/${n}`, import.meta.url)),
    "utf8",
  );
const facts = factsFromChainInputs(
  chainInputsFromSnapshot(
    JSON.parse(ev("portaldot-v3-spec3002-snapshot.json")) as SnapshotJson,
    ev("portaldot-v3-spec3002-metadata.hex").trim() as `0x${string}`,
  ),
);
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/v3-signed-extrinsics.json", import.meta.url), "utf8"),
) as {
  transactions: {
    label: string;
    txHash: string;
    block: number;
    extrinsic: `0x${string}`;
    signer: string;
    nonce: number;
    birthHash: `0x${string}`;
  }[];
};
const fp = facts.fingerprint;
const requestFor = (t: (typeof fixture.transactions)[number]) =>
  ({
    nonce: t.nonce,
    payload: {
      address: t.signer,
      specVersion: fp.specVersion,
      transactionVersion: fp.transactionVersion,
      genesisHash: fp.genesisHash,
      blockHash: t.birthHash,
    },
  }) as any;
const DEMO = fixture.transactions.find((t) => t.txHash.startsWith("0x8a2c8b92"))!;

describe("real V3 extrinsics accepted by the chain verify", () => {
  it("fixture: 19 finalized txs, the demo transfer at #118310 signed by 5HEuRG…", () => {
    expect(fixture.transactions).toHaveLength(19);
    expect(DEMO).toMatchObject({
      block: 118310,
      signer: "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE",
      nonce: 0,
    });
  });

  it.each(fixture.transactions.map((t) => [t.label, t] as const))(
    "%s: valid under its signing request and under the envelope checkpoint",
    (_l, t) => {
      const a = signedExtrinsicDecoder(facts, [requestFor(t)])(t.extrinsic);
      expect(a?.signatureValid).toBe(true);
      expect(a?.genesisHash).toBe(fp.genesisHash);
      const b = signedExtrinsicDecoder(facts, { checkpoint: { hash: t.birthHash } })(t.extrinsic);
      expect(b?.signatureValid).toBe(true);
    },
  );

  it("#118310 (extension-signed): fails closed on a wrong checkpoint, a tampered signature, or no context", () => {
    const wrong = ("0x" + "11".repeat(32)) as `0x${string}`;
    expect(
      signedExtrinsicDecoder(facts, { checkpoint: { hash: wrong } })(DEMO.extrinsic)
        ?.signatureValid,
    ).toBe(false);
    const bytes = hexToU8a(DEMO.extrinsic);
    bytes[bytes.length - 50] ^= 1; // inside the call: the signature no longer covers it
    const tampered = u8aToHex(bytes) as `0x${string}`;
    expect(
      signedExtrinsicDecoder(facts, [requestFor(DEMO)])(tampered)?.signatureValid ?? false,
    ).toBe(false);
    // The default (no requests, no envelope) can check nothing: always false. This is the call the console made.
    expect(signedExtrinsicDecoder(facts)(DEMO.extrinsic)?.signatureValid).toBe(false);
    expect(
      signedExtrinsicDecoder(facts, { checkpoint: { hash: "0x12" } })(DEMO.extrinsic)
        ?.signatureValid,
    ).toBe(false);
  });

  it("browser entry: the same decoder", () => {
    expect(browser.signedExtrinsicDecoder).toBe(signedExtrinsicDecoder);
  });
});

describe("dev-key (//Alice) round trip with polkadot.js as the reference", () => {
  const checkpoint = { number: 118900, hash: DEMO.birthHash };
  const callHex =
    "0x2709ce3c31000076d0e8b40899d424129b4ec688f889b3ce5cb12cadfa72c8898f4cb25d7cb17204" as const;

  it("signPayload -> console assembly (assembleSignedExtrinsic) == polkadot.js Extrinsic.sign, and both verify", async () => {
    const { alice } = await devKeys();
    const signer = alice.address;
    const req = buildSigningRequest(callHex, facts, {
      signer,
      nonce: 1,
      mortalityBlocks: 64,
      checkpoint,
    });
    const { registry } = encodeRuntime(facts);
    // What a polkadot.js extension's signPayload does: sign the ExtrinsicPayload (blake2 if > 256 bytes), typed sig.
    const { signature } = registry
      .createType("ExtrinsicPayload", req.payload, { version: 4 })
      .sign(alice);
    const assembled = assembleSignedExtrinsic(req.payload, signature, facts);
    // Reference: polkadot.js builds and signs the whole extrinsic itself.
    const ref = registry.createType("Extrinsic", { method: callHex }, { version: 4 }) as any;
    ref.sign(alice, {
      blockHash: checkpoint.hash,
      genesisHash: fp.genesisHash,
      era: registry.createType("ExtrinsicEra", req.payload.era),
      nonce: 1,
      runtimeVersion: { specVersion: fp.specVersion, transactionVersion: fp.transactionVersion },
      signedExtensions: registry.signedExtensions,
    });
    // sr25519 signatures are randomised, so compare everything but the signature, then verify both.
    const strip = (hex: string) => {
      const x = registry.createType("Extrinsic", hex) as any;
      return {
        signer: x.signer.toHex(),
        era: x.era.toHex(),
        nonce: x.nonce.toNumber(),
        tip: x.tip.toString(),
        method: x.method.toHex(),
        // after compact length: 0x84 (signed v4), MultiAddress tag, 32-byte id, MultiSignature tag
        tags: (() => {
          const b = x.toU8a(true) as Uint8Array;
          return [b[0], b[1], b[34]];
        })(),
        len: x.toU8a().length,
      };
    };
    expect(strip(assembled)).toEqual(strip(ref.toHex()));
    expect(strip(assembled).tags).toEqual([0x84, 0x00, 0x01]); // signed v4, MultiAddress::Id, sr25519
    for (const x of [assembled, ref.toHex() as `0x${string}`]) {
      expect(signedExtrinsicDecoder(facts, [req])(x)?.signatureValid).toBe(true);
      expect(signedExtrinsicDecoder(facts, { checkpoint })(x)?.signatureValid).toBe(true);
      // Reproduces the LIVE symptom: decoder built without requests or envelope -> signed_signature_invalid.
      expect(signedExtrinsicDecoder(facts)(x)?.signatureValid).toBe(false);
    }
  });
});
