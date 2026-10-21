/* eslint-disable @typescript-eslint/no-explicit-any -- raw JSON-RPC answers and polkadot.js codecs */
// Read-only: replays already-included V3 signed extrinsics through system_dryRun at their parent block (should be ok),
// at their own block (stale) and at the best block, with SEAM's own mapping (dryRunOne). Never signs or submits.
// Usage: npx vite-node packages/chain/scripts/v3-dryrun-replay.ts -- <out.json> <block>:<txHash> ...
import { writeFileSync } from "node:fs";
import { clientFromSend, factsFromChainInputs } from "../src/browser.js";
import { dryRunOne } from "../src/dryrun-core.js";
import { extrinsicHash } from "../src/runtime.js";

const R = process.env.V3_RPC ?? "https://test-node-v3.portaldot.dev";
const raw: { method: string; params: unknown[]; response: unknown }[] = [];
const send = async (method: string, params: unknown[]) => {
  const r = await fetch(R, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await r.json();
  if (method === "system_dryRun" || method === "state_call" || method === "rpc_methods")
    raw.push({
      method,
      params:
        method === "rpc_methods"
          ? []
          : params.map((p) =>
              typeof p === "string" && p.length > 140
                ? `${p.slice(0, 20)}…(${(p.length - 2) / 2} bytes, see extrinsicHex)`
                : p,
            ),
      response:
        method === "rpc_methods"
          ? {
              dryRunMethods: (j.result?.methods ?? []).filter((m: string) =>
                /dryRun|state_call/.test(m),
              ),
            }
          : j,
    });
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};
const [out, ...targets] = process.argv.slice(2).filter((a) => a !== "--");
const c = clientFromSend(send);
await send("rpc_methods", []);
const bestHeader: any = await send("chain_getHeader", []);
const runs = [];
for (const t of targets) {
  const [bn, txHash] = t.split(":");
  const n = Number(bn);
  const H = await send("chain_getBlockHash", [n]);
  const P = await send("chain_getBlockHash", [n - 1]);
  const xs: string[] = (await send("chain_getBlock", [H])).block.extrinsics;
  const idx = xs.findIndex((x) => extrinsicHash(x) === txHash!.toLowerCase());
  if (idx < 0) throw new Error(`${txHash} not in #${n}`);
  const facts = factsFromChainInputs({
    metadataHex: await send("state_getMetadata", [P]),
    genesisHash: await send("chain_getBlockHash", [0]),
    runtimeVersion: await send("state_getRuntimeVersion", [P]),
    properties: await send("system_properties", []),
    head: { number: n - 1, hash: P },
  } as never);
  const at = async (label: string, hash: string | undefined, number: number) => ({
    label,
    at: { number, hash: hash ?? null },
    result: await dryRunOne(c, facts, xs[idx] as never, 0, hash as never),
  });
  const applyAtParent = await send("state_call", ["BlockBuilder_apply_extrinsic", xs[idx], P]);
  runs.push({
    block: n,
    blockHash: H,
    parentHash: P,
    extrinsicIndex: idx,
    txHash,
    extrinsicHex: xs[idx],
    specVersion: facts.fingerprint.specVersion,
    dryRuns: [
      await at("parent block (state before inclusion): expected ok", P, n - 1),
      await at("its own block (nonce already used): expected Stale", H, n),
      await at(
        "best block (mortal era passed): expected invalid",
        undefined,
        Number(bestHeader.number),
      ),
    ],
    stateCallApplyExtrinsicAtParent: applyAtParent,
  });
}
writeFileSync(
  out!,
  JSON.stringify(
    {
      kind: "dryrun-capability",
      label:
        "read-only replay of already-included V3 transactions through system_dryRun; nothing signed or submitted",
      endpoint: R,
      readAt: new Date().toISOString(),
      bestBlockAtStart: Number(bestHeader.number),
      runs,
      rawRpc: raw,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    runs.map((r) => ({
      block: r.block,
      idx: r.extrinsicIndex,
      d: r.dryRuns.map((d) => `${d.result.outcome}:${d.result.detail}:${d.result.raw}`),
      sc: r.stateCallApplyExtrinsicAtParent,
    })),
    null,
    1,
  ),
);
