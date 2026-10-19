// READ-ONLY: checks the metadata layout fingerprint against the live Portaldot V3 test node. Signs and sends nothing.
// Reads state_getMetadata at several blocks over HTTPS (src/http-transport.ts), then compares raw blake2b-256 hashes,
// SEAM's metadata layout hash (storage defaults blanked) and the fingerprint digest with and without the pinned
// metadata. Lists exactly which storage defaults differ. Writes evidence/v3-metadata-stability/<timestamp>.json.
//   node packages/chain/scripts/v3-metadata-stability.mjs [https://test-node-v3.portaldot.dev] [--blocks 3] [--ws wss://...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Metadata, TypeRegistry } from "@polkadot/types";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { blake2AsHex } from "@polkadot/util-crypto";
import {
  fingerprintFromChainInputs,
  httpRpcClient,
  metadataLayoutHash,
  readChainInputs,
  withClient,
} from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const URL_ = args.find((a) => /^https?:\/\//.test(a)) ?? "https://test-node-v3.portaldot.dev";
if (/mainnet/i.test(URL_)) throw new Error("refusing: this script is for the V3 test node");
const WAIT_BLOCKS = Number(flag("--blocks") ?? 3);
const WS = flag("--ws");
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const raw = (h) => blake2AsHex(hexToU8a(h), 256);

function fallbacks(hex) {
  const m = new Metadata(new TypeRegistry(), hexToU8a(hex));
  const out = new Map();
  for (const p of m.asLatest.pallets) {
    if (p.storage.isNone) continue;
    for (const e of p.storage.unwrap().items)
      out.set(`${p.name}.${e.name}`, u8aToHex(e.fallback.toU8a(true)));
  }
  return out;
}
function fallbackDiff(a, b) {
  const fa = fallbacks(a);
  const fb = fallbacks(b);
  return [...fa.keys()]
    .filter((k) => fa.get(k) !== fb.get(k))
    .map((k) => ({
      entry: k,
      bytesA: (fa.get(k).length - 2) / 2,
      bytesB: ((fb.get(k)?.length ?? 2) - 2) / 2,
    }));
}

const client = httpRpcClient(URL_, { requestTimeoutMs: 90_000 });
const genesis = await client.send("chain_getBlockHash", [0]);
if (genesis !== V3_GENESIS) throw new Error(`not the V3 test node (genesis ${genesis})`);
const head = async () => parseInt((await client.send("chain_getHeader", [])).number, 16);
const metaAt = async (n) => {
  const hash = await client.send("chain_getBlockHash", [n]);
  const [hex, ver] = await Promise.all([
    client.send("state_getMetadata", [hash]),
    client.send("state_getRuntimeVersion", [hash]),
  ]);
  return {
    block: n,
    hash,
    hex: hex.toLowerCase(),
    specVersion: ver.specVersion,
    transactionVersion: ver.transactionVersion,
  };
};

const startedAt = new Date().toISOString();
const a = await metaAt(await head());
const target = a.block + WAIT_BLOCKS;
while ((await head()) < target) await new Promise((r) => setTimeout(r, 3000));
const b = await metaAt(target);
const earlier = await metaAt(Math.max(1, a.block - 100)).catch((e) => ({ error: e.message }));
const earlier500 = await metaAt(Math.max(1, a.block - 500)).catch((e) => ({ error: e.message }));
const pinnedFile = fileURLToPath(
  new URL("../../../evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex", import.meta.url),
);
const pinned2026_10_18 = readFileSync(pinnedFile, "utf8").trim().toLowerCase();

const reads = [a, b, ...[earlier, earlier500].filter((r) => r.hex)];
const row = (r) => ({
  block: r.block,
  blockHash: r.hash,
  specVersion: r.specVersion,
  transactionVersion: r.transactionVersion,
  metadataBytes: (r.hex.length - 2) / 2,
  rawMetadataHash: raw(r.hex),
  layoutHash: metadataLayoutHash(r.hex),
});

// Fingerprint at B, as SEAM computes it: without a pin (raw bytes) and pinned to each earlier metadata blob
// (what a plan prepared then would hold). Equal digests mean the runtime lock would pass; a drift record shows why.
const inputsB = await readChainInputs(client);
const fpRaw = fingerprintFromChainInputs(inputsB);
const pins = [
  ["A", a.hex],
  ...[earlier, earlier500].filter((r) => r.hex).map((r) => [`block ${r.block}`, r.hex]),
  ["2026-10-18 discovery", pinned2026_10_18],
];
const pinnedResults = pins.map(([label, hex]) => {
  const prepared = fingerprintFromChainInputs({ ...inputsB, metadataHex: hex });
  const now = fingerprintFromChainInputs(inputsB, { pinnedMetadataHex: hex });
  return {
    pinnedTo: label,
    preparedDigest: prepared.fingerprintDigest,
    digestNowWithoutPin: fpRaw.fingerprintDigest,
    digestNowPinned: now.fingerprintDigest,
    lockWouldPass: now.fingerprintDigest === prepared.fingerprintDigest,
    rawHashesEqual: raw(hex) === raw(inputsB.metadataHex),
    drift: now.metadataDrift ?? null,
  };
});

let ws;
if (WS) {
  const t0 = Date.now();
  ws = await withClient(WS, async (c) => {
    const ok = [];
    for (let i = 0; i < 5; i++)
      ok.push(
        await c.send("chain_getHeader", []).then(
          () => true,
          (e) => e.message,
        ),
      );
    return { url: WS, reads: ok, ms: Date.now() - t0 };
  }).catch((e) => ({ url: WS, error: e.message }));
}

const out = {
  kind: "v3-metadata-stability",
  note: "READ-ONLY. state_getMetadata over HTTPS at several blocks; no signing, no submission, no wallet.",
  endpoint: URL_,
  genesis,
  startedAt,
  finishedAt: new Date().toISOString(),
  reads: reads.map(row),
  storageDefaultsThatDiffer: {
    [`${a.block}->${b.block}`]: fallbackDiff(a.hex, b.hex),
    ...(earlier.hex ? { [`${earlier.block}->${a.block}`]: fallbackDiff(earlier.hex, a.hex) } : {}),
    ...(earlier500.hex
      ? { [`${earlier500.block}->${a.block}`]: fallbackDiff(earlier500.hex, a.hex) }
      : {}),
    [`2026-10-18-discovery->${a.block}`]: fallbackDiff(pinned2026_10_18, a.hex),
  },
  discovery2026_10_18: {
    rawMetadataHash: raw(pinned2026_10_18),
    layoutHash: metadataLayoutHash(pinned2026_10_18),
  },
  fingerprintAtB: { atBlock: inputsB.head, pins: pinnedResults },
  ...(earlier.error ? { earlierReadError: earlier.error } : {}),
  ...(earlier500.error ? { earlier500ReadError: earlier500.error } : {}),
  httpRequests: client.stats,
  ...(ws ? { websocketSmoke: ws } : {}),
};
const dir = fileURLToPath(new URL("../../../evidence/v3-metadata-stability/", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}stability-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(file);
console.log(
  JSON.stringify(
    {
      reads: out.reads,
      diff: out.storageDefaultsThatDiffer,
      fp: out.fingerprintAtB,
      ws: out.websocketSmoke,
    },
    null,
    1,
  ),
);
client.close();
