#!/usr/bin/env node
// READ-ONLY: Revive.OriginalAccount storage layout on live V3 spec 3002, a hand-built key vs the decorated key, and a
// state read at a recent finalized block. Writes evidence/testnet-v3/original-account-check.json.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { compactStripLength, u8aConcat, u8aToHex, hexToU8a } from "@polkadot/util";
import { encodeAddress, xxhashAsU8a } from "@polkadot/util-crypto";
import { httpRpcClient } from "../dist/index.js";

const URL_ = "https://test-node-v3.portaldot.dev";
const H160 = "0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec"; // derivedH160 in runs/map-account-1792408724499.json
const EXPECT_SIGNER = "5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1";
const c = httpRpcClient(URL_, { requestTimeoutMs: 90_000 });
try {
  const fin = await c.send("chain_getFinalizedHead", []);
  const hdr = await c.send("chain_getHeader", [fin]);
  const rv = await c.send("state_getRuntimeVersion", [fin]);
  const meta = await c.send("state_getMetadata", [fin]);
  const reg = new TypeRegistry();
  const md = new Metadata(reg, meta);
  reg.setMetadata(md);
  const pallet = md.asLatest.pallets.find((p) => p.name.toString() === "Revive");
  const entry = pallet.storage.unwrap().items.find((e) => e.name.toString() === "OriginalAccount");
  const map = entry.type.asMap;
  const layout = {
    prefix: pallet.storage.unwrap().prefix.toString(),
    modifier: entry.modifier.toString(),
    hashers: map.hashers.map((h) => h.toString()),
    keyType: reg.lookup.getTypeDef(map.key).type,
    valueType: reg.lookup.getTypeDef(map.value).type,
  };
  const handKey = u8aToHex(
    u8aConcat(xxhashAsU8a("Revive", 128), xxhashAsU8a("OriginalAccount", 128), hexToU8a(H160)), // Identity hasher
  );
  const decorated = (await import("@polkadot/types")).expandMetadata(reg, md);
  // the decorated query fn returns the key SCALE-encoded as Vec<u8> (compact length prefix); strip it
  const decoratedKey = u8aToHex(
    compactStripLength(decorated.query.revive.originalAccount(H160))[1],
  );
  const raw = await c.send("state_getStorage", [decoratedKey, fin]);
  const value = raw ? reg.createType("AccountId32", raw) : null;
  const out = {
    generatedAt: new Date().toISOString(),
    endpoint: URL_,
    specVersion: rv.specVersion,
    atBlock: { number: parseInt(hdr.number, 16), hash: fin },
    layout,
    h160: H160,
    handBuiltKey: handKey,
    decoratedKey,
    keysEqual: handKey === decoratedKey,
    rawValue: raw,
    mapsTo: value ? encodeAddress(value.toU8a(), 42) : null,
    mapsToExpectedSigner: value ? encodeAddress(value.toU8a(), 42) === EXPECT_SIGNER : false,
  };
  console.log(JSON.stringify(out, null, 2));
  writeFileSync(
    fileURLToPath(
      new URL("../../../evidence/testnet-v3/original-account-check.json", import.meta.url),
    ),
    JSON.stringify(out, null, 2) + "\n",
  );
} finally {
  c.close();
}
