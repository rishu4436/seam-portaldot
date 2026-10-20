#!/usr/bin/env node
// READ-ONLY: which live V3 metadata a plan's fingerprintDigest was built from. Reads the runtime version, metadata and
// properties at each block from --from to --to and computes the fingerprint digest (raw metadata, as the browser builder
// does) and the v2 metadata layout hash. Reports the blocks whose digest equals --digest. Signs and sends nothing.
//   node packages/chain/scripts/v3-plan-fingerprint.mjs --digest 0x… --from <n> --to <n>
import { factsFromChainInputs, httpRpcClient, metadataLayoutHash } from "../dist/index.js";

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const WANT = String(opt("--digest")).toLowerCase();
const FROM = Number(opt("--from"));
const TO = Number(opt("--to"));
const c = httpRpcClient("https://test-node-v3.portaldot.dev", { requestTimeoutMs: 90_000 });
const send = (m, p) => {
  if (!/^(chain_get|state_get|system_properties$)/.test(m)) throw new Error(`refusing ${m}`);
  return c.send(m, p);
};
try {
  const genesisHash = await send("chain_getBlockHash", [0]);
  const properties = await send("system_properties", []);
  const rows = [];
  for (let n = TO; n >= FROM; n--) {
    const hash = await send("chain_getBlockHash", [n]);
    const [runtimeVersion, metadataHex] = await Promise.all([
      send("state_getRuntimeVersion", [hash]),
      send("state_getMetadata", [hash]),
    ]);
    const facts = factsFromChainInputs({
      metadataHex,
      genesisHash,
      runtimeVersion,
      properties,
      head: { number: n, hash },
    });
    rows.push({
      block: n,
      hash,
      specVersion: runtimeVersion.specVersion,
      metadataHash: facts.fingerprint.metadataHash,
      fingerprintDigest: facts.fingerprintDigest,
      layoutHash: metadataLayoutHash(metadataHex),
      match: facts.fingerprintDigest.toLowerCase() === WANT,
      fingerprint: facts.fingerprint,
    });
  }
  console.log(
    JSON.stringify(
      { want: WANT, genesisHash, matches: rows.filter((r) => r.match), rows },
      null,
      2,
    ),
  );
} finally {
  c.close();
}
