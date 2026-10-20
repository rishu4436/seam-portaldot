// Builds src/demo/v3-evidence.json and public/v3/facts-snapshot.json from the committed V3 testnet recordings in
// evidence/testnet-v3/ (hosted Portaldot V3 testnet, spec 3002). Every value is copied from those files; nothing is
// invented. Receipt statuses are the ones SEAM's receipts in the records say, plus the recorded nfts verdict receipt.
// usage: node scripts/import-v3-evidence.mjs && npx prettier --write src/demo/v3-evidence.json public/v3
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DIR = join(REPO, "evidence/testnet-v3");
const read = (f) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const readme = readFileSync(join(DIR, "README.md"), "utf8");

// Every table row with a tx hash (and the one not-sent dry run) in README.md.
const rows = [];
for (const line of readme.split("\n")) {
  if (!line.startsWith("| ")) continue;
  const c = line
    .split("|")
    .slice(1, -1)
    .map((s) => s.trim());
  if (c.length !== 10 || !/^R?\d+$/.test(c[0])) continue;
  const [id, step, , hashCell, blockCell, finalized, , outcome, explorerCell, recordCell] = c;
  const hash = /`(0x[0-9a-f]{64})`/.exec(hashCell)?.[1] ?? null;
  const explorer = /\((https:\/\/[^)]+)\)/.exec(explorerCell)?.[1] ?? null;
  const record = /`(runs\/[^`]+)`/.exec(recordCell)?.[1] ?? null;
  rows.push({
    id,
    step,
    txHash: hash,
    block: blockCell ? Number(blockCell.replace("#", "")) : null,
    finalized: finalized === "yes",
    chainOutcome: outcome.replace(/`|\*\*/g, ""),
    explorer,
    record: record ? `evidence/testnet-v3/${record}` : null,
  });
}

// SEAM receipt status per tx, from the records themselves.
const receiptFor = (row) => {
  if (!row.txHash) return { kind: "not_sent", label: "not sent: signed dry run only" };
  if (/attempt/.test(row.step))
    return {
      kind: "none",
      label: /uncertain/.test(row.step)
        ? "earlier attempt: SEAM marked the step uncertain; rebuilt from chain"
        : "earlier attempt: SEAM recording lost; rebuilt from chain",
    };
  if (!row.record) return { kind: "none", label: "no record" };
  const d = read(row.record.replace("evidence/testnet-v3/", ""));
  const steps = d.run?.receipt?.steps;
  if (!steps) {
    if (d.kind === "seam-plan-rollback" || d.batchAllRollback)
      return {
        kind: "gate_blocked",
        label: "SEAM gate blocked it before sending; test-only direct send failed and rolled back",
      };
    return { kind: "none", label: "setup tx, no SEAM receipt" };
  }
  // Prefer the later receipt built with the nfts verdict (nftVerdictReceipt.receipt) when the record has one.
  const later = d.nftVerdictReceipt?.receipt;
  const rec = later?.steps ? later : d.run.receipt;
  const mine = rec.steps.filter((x) => x.txHash === row.txHash);
  return {
    kind: "receipt",
    shown: later?.steps ? "nftVerdictReceipt.receipt (with nfts verdict)" : "run.receipt",
    result: rec.result,
    fingerprintDigest: rec.fingerprintDigest,
    steps: mine.map((s) => {
      const nv = later?.steps ? null : d.nftVerdictReceipt?.verdicts?.[s.actionId];
      return {
        actionId: s.actionId,
        status: s.status,
        verification: s.verification,
        coverage: s.coverage,
        code: s.code ?? null,
        withNftsVerdict: nv ? { verification: nv.verification, coverage: nv.coverage } : null,
      };
    }),
  };
};

const out = {
  source: "evidence/testnet-v3/README.md + runs/*.json",
  chain: "PortaldotV3 Test",
  specName: "portaldot-v3",
  specVersion: 3002,
  ss58: 42,
  token: "tPOT",
  decimals: 14,
  rows: rows.map((r) => ({ ...r, receipt: receiptFor(r) })),
};
writeFileSync(
  fileURLToPath(new URL("../src/demo/v3-evidence.json", import.meta.url)),
  JSON.stringify(out, null, 2) + "\n",
);

// Facts snapshot: the RuntimeFacts recorded with the revive.call plan, minus the metadata bytes (not recorded).
const FACTS_FROM = "runs/plan-revive-call-1792412445848.json";
const f = read(FACTS_FROM).facts;
const snap = {
  label: "RECORDED SNAPSHOT, not a live discovery",
  recordedFrom: `evidence/testnet-v3/${FACTS_FROM}`,
  recordedAtBlock: f.blockNumber ?? null,
  facts: { ...f, source: { metadataHex: "0x", typesBundle: f.source?.typesBundle ?? null } },
};
writeFileSync(
  fileURLToPath(new URL("../public/v3/facts-snapshot.json", import.meta.url)),
  JSON.stringify(snap) + "\n",
);
console.log(`rows ${out.rows.length}`);
