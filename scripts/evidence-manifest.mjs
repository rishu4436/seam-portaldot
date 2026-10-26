#!/usr/bin/env node
// Builds docs/evidence-manifest.md from the JSON files under evidence/. Read-only over evidence/.
// Nothing is invented: a field that no evidence file records is printed as "unknown".
// Usage: node scripts/evidence-manifest.mjs [--check]   (--check: exit 1 if the committed file is stale)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EV = join(ROOT, "evidence");
const OUT = join(ROOT, "docs", "evidence-manifest.md");
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TX_KEYS = new Set(["txHash", "tx", "txHashLocal", "directTx", "mapTx", "reviveDeployTx"]);

const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".json")) files.push(p);
  }
})(EV);

const txs = new Map();
const get = (h) => {
  const k = h.toLowerCase();
  if (!txs.has(k))
    txs.set(k, {
      hash: k,
      files: new Set(),
      blocks: new Set(),
      labels: new Set(),
      verif: new Map(),
      dryRunOnly: true,
    });
  return txs.get(k);
};
const isVerification = (rel) => /verification\.json$|recorded-replay-[^/]*\.json$/.test(rel);

function blockOf(o) {
  for (const k of ["block", "blockNumber"]) {
    const b = o[k];
    if (Number.isInteger(b)) return b;
    if (b && typeof b === "object" && Number.isInteger(b.number)) return b.number;
  }
  return undefined;
}

function record(o, h, rel, path) {
  const t = get(h);
  t.files.add(rel);
  if (/\.previous$/.test(path)) return;
  const b = blockOf(o);
  if (b !== undefined) t.blocks.add(b);
  // A hash only seen inside a signed dry run (".signedDryRun" / ".dryRun") was never broadcast.
  if (!/dryRun/i.test(path)) t.dryRunOnly = false;
  const call =
    typeof o.call === "string"
      ? o.call
      : Array.isArray(o.calls) && typeof o.calls[0]?.call === "string"
        ? o.calls.map((c) => c.call).join(" + ")
        : undefined;
  const named = o.label ?? o.what ?? o.actionId;
  const label =
    typeof named === "string" ? (call && !/[.(]/.test(named) ? `${named}: ${call}` : named) : call;
  if (typeof label === "string")
    t.labels.add(label.length > 70 ? label.slice(0, 67) + "..." : label);
  // ".nonce.previous" only names the signer's previous tx for the nonce-gap check; it is not that tx's verification.
  if (isVerification(rel) && !/\.previous$/.test(path)) {
    const v = o.outcome ?? o.verdict;
    if (typeof v === "string") t.verif.set(rel, v);
    else if (!t.verif.has(rel)) t.verif.set(rel, "unknown");
  }
}

function walkJson(o, rel, path) {
  if (Array.isArray(o)) return o.forEach((v, i) => walkJson(v, rel, `${path}[${i}]`));
  if (!o || typeof o !== "object") return;
  // Single-tx verification/record objects keep the tx hash as "hash" next to "kind" and a numeric "block".
  if (
    typeof o.kind === "string" &&
    typeof o.hash === "string" &&
    HASH.test(o.hash) &&
    blockOf(o) !== undefined
  )
    record(o, o.hash, rel, path);
  for (const [k, v] of Object.entries(o)) {
    if (TX_KEYS.has(k) && typeof v === "string" && HASH.test(v)) record(o, v, rel, path);
    walkJson(v, rel, `${path}.${k}`);
  }
}

for (const f of files) {
  const rel = relative(ROOT, f);
  const j = JSON.parse(readFileSync(f, "utf8"));
  // A verification file's top-level verdict is authoritative for the txs it verifies (nested "outcome" fields can be
  // intermediate tool output, e.g. the atomic-view v3-find-tx result recorded in the #120936 file).
  walkJson(j, rel, "");
  if (isVerification(rel) && typeof (j.verdict ?? j.outcome) === "string")
    for (const t of txs.values()) if (t.verif.has(rel)) t.verif.set(rel, j.verdict ?? j.outcome);
}

function network(t) {
  const f = [...t.files][0];
  if (f.startsWith("evidence/testnet-v3/")) return "Portaldot V3 testnet (spec 3002)";
  if (f.startsWith("evidence/portaldot-local-node/"))
    return "local Portaldot dev node (spec 1002, --dev --tmp)";
  if (f.startsWith("evidence/devnode/")) return "local substrate-contracts-node (devnode)";
  return "unknown";
}
function runType(t) {
  if (t.dryRunOnly) return "not sent (signed dry run only)";
  if ([...t.files][0].startsWith("evidence/testnet-v3/")) return "live (V3, sent; recorded)";
  return "devnode (local, recorded)";
}

// Hashes only ever seen inside a signed dry run were never broadcast. They are not listed as transactions; their
// files are listed in the "DRY RUN ONLY (nothing sent)" section instead (no tx hash column there).
const dryOnlyFiles = new Set();
for (const t of txs.values()) if (t.dryRunOnly) for (const f of t.files) dryOnlyFiles.add(f);
const rows = [...txs.values()]
  .filter((t) => !t.dryRunOnly)
  .sort((a, b) => {
    const na = network(a),
      nb = network(b);
    if (na !== nb) return na < nb ? 1 : -1;
    const ba = Math.min(...a.blocks, Infinity),
      bb = Math.min(...b.blocks, Infinity);
    return ba - bb || (a.hash < b.hash ? -1 : 1);
  });

const cell = (s) => String(s).replace(/\|/g, "\\|");
const lines = [];
lines.push("# Evidence manifest");
lines.push("");
lines.push(
  "Generated by `node scripts/evidence-manifest.mjs` from the JSON files under `evidence/`. Do not edit by hand; re-run the script.",
);
lines.push(
  "Every transaction hash recorded under a transaction-hash key (`txHash`, `tx`, `txHashLocal`, `directTx`, `mapTx`, `reviveDeployTx`, or a top-level `hash` next to `block` in a single-tx record) is listed once. A field that no evidence file records is `unknown`.",
);
lines.push("");
lines.push("Run types:");
lines.push("");
lines.push(
  "- **live (V3, sent; recorded)**: broadcast on the hosted Portaldot V3 testnet and recorded in `evidence/testnet-v3/`. The files are records of past runs; a replay of them is a recorded run, not a live one.",
);
lines.push(
  "- **devnode (local, recorded)**: a disposable local chain on the build machine. Not V3, not mainnet.",
);
lines.push(
  "- **not sent**: signed or unsigned dry runs and estimates; nothing was broadcast. These are not in the transaction table; see **DRY RUN ONLY (nothing sent)** below.",
);
lines.push("");
lines.push(
  "**Verification** names an independent read-only verification file (`*verification.json`) that lists the hash, with its verdict. `none` means the hash appears only in run records written by the run itself; that is not independent verification. Nothing on V3 counts as V3-verified without a verification file. No hash here is a mainnet transaction.",
);
lines.push("");
// Evidence known to exist on unmerged branches. Listed only while the files are absent here; never counted as verified.
const PENDING = [
  [
    "evidence/testnet-v3/recorded-replay-102671-1792553452393.{json,md}",
    "#102671 atomic batch_all: recorded run, replayed read-only",
    "7dfca89 (bot4/recorded-replay)",
  ],
  [
    "evidence/testnet-v3/recorded-replay-102665-1792553452393.{json,md}",
    "#102665 rollback probe (ExtrinsicFailed assets.BalanceLow, no inner events): recorded run, replayed read-only",
    "7dfca89 (bot4/recorded-replay)",
  ],
  [
    "evidence/testnet-v3/dryrun-capability-*",
    "V3 system_dryRun capability on signed bytes",
    "33fcca7 (bot4/browser-dryrun)",
  ],
].filter(
  ([f]) =>
    !existsSync(join(ROOT, f.replace(/\{.*\}|\*$/, "json"))) &&
    !(
      f.endsWith("*") &&
      readdirSync(join(EV, "testnet-v3")).some((n) => n.startsWith("dryrun-capability-"))
    ),
);
if (PENDING.length) {
  lines.push("Pending merge (not on this branch, not counted below):");
  lines.push("");
  for (const [f, what, c] of PENDING) lines.push(`- \`${f}\`: ${what}. Pending merge (${c}).`);
  lines.push("");
}
const counts = {};
for (const t of rows) counts[runType(t)] = (counts[runType(t)] ?? 0) + 1;
lines.push(
  `Totals: ${rows.length} hashes; ` +
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join("; ") +
    ".",
);
lines.push("");
lines.push(
  "| # | tx hash | block | network | what | run type | verification (verdict) | evidence files |",
);
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
rows.forEach((t, i) => {
  const blocks = t.blocks.size
    ? [...t.blocks]
        .sort((a, b) => a - b)
        .map((b) => `#${b}`)
        .join(", ")
    : "unknown";
  const what = t.labels.size ? [...t.labels].join("; ") : "unknown";
  const ver = t.verif.size
    ? [...t.verif].map(([f, v]) => `\`${f.replace("evidence/", "")}\` (${v})`).join("<br>")
    : "none";
  const ev =
    [...t.files]
      .filter((f) => !t.verif.has(f))
      .map((f) => `\`${f.replace("evidence/", "")}\``)
      .join("<br>") || "-";
  lines.push(
    `| ${i + 1} | \`${t.hash}\` | ${blocks} | ${network(t)} | ${cell(what)} | ${runType(t)} | ${ver} | ${ev} |`,
  );
});
lines.push("");

// ---- DRY RUN ONLY (nothing sent) ----
const dryJson = new Map(); // rel -> parsed JSON
for (const f of files) {
  const rel = relative(ROOT, f);
  const j = JSON.parse(readFileSync(f, "utf8"));
  const isDry =
    dryOnlyFiles.has(rel) ||
    /dry-?run/i.test(f.split("/").pop()) ||
    (typeof j.kind === "string" && /dry-?run/i.test(j.kind)) ||
    (typeof j.label === "string" && /^DRY RUN ONLY/i.test(j.label)) ||
    (typeof j.outcome === "string" && /^not sent/i.test(j.outcome));
  if (isDry) dryJson.set(rel, j);
}
const num = (v) => (Number.isInteger(v) ? v : undefined);
function dryBlock(j) {
  const b = blockOf(j);
  const parts = [];
  if (b !== undefined) parts.push(`#${b}`);
  else if (num(j.checkpoint?.number) !== undefined)
    parts.push(`#${j.checkpoint.number} (checkpoint)`);
  else if (num(j.bestBlockAtStart) !== undefined) parts.push(`best #${j.bestBlockAtStart}`);
  else if (num(j.stateBefore?.block) !== undefined)
    parts.push(`#${j.stateBefore.block} (state before)`);
  if (Array.isArray(j.runs)) {
    const rb = j.runs.map((r) => num(r?.block)).filter((x) => x !== undefined);
    if (rb.length) parts.push(`replays of ${rb.map((x) => `#${x}`).join(", ")}`);
  }
  return parts.join("; ") || "unknown";
}
function dryRuntime(rel, j) {
  const net = rel.startsWith("evidence/testnet-v3/")
    ? "Portaldot V3 testnet"
    : rel.startsWith("evidence/portaldot-local-node/")
      ? "local Portaldot dev node"
      : rel.startsWith("evidence/devnode/")
        ? "local substrate-contracts-node (devnode)"
        : "unknown network";
  const specs = new Set();
  if (num(j.specVersion) !== undefined) specs.add(j.specVersion);
  if (Array.isArray(j.runs))
    for (const r of j.runs) if (num(r?.specVersion) !== undefined) specs.add(r.specVersion);
  return `${net}; spec ${specs.size ? [...specs].join(", ") : "unknown"}`;
}
function dryEstimate(j) {
  const out = [];
  if (Array.isArray(j.results))
    for (const r of j.results)
      if (typeof r?.totalFmt === "string")
        out.push(`${r.variant?.id ?? "unknown"}: total ${r.totalFmt}`);
  const fit = j.budget?.fit;
  if (fit && typeof fit === "object")
    for (const [k, v] of Object.entries(fit))
      if (typeof v?.total?.tPOT === "string") out.push(`${k}: total ${v.total.tPOT}`);
  if (typeof j.estimatedFeeTpot === "string") out.push(`fee ${j.estimatedFeeTpot} tPOT`);
  if (typeof j.expectedDeposit === "string")
    out.push(`expected deposit ${j.expectedDeposit} planck`);
  return out.join("<br>") || "unknown";
}
function dryOrigin(j) {
  const out = new Set();
  for (const k of ["origin", "signer"]) if (typeof j[k] === "string") out.add(`${k} \`${j[k]}\``);
  if (j.accounts && typeof j.accounts === "object")
    for (const [k, v] of Object.entries(j.accounts))
      if (typeof v?.address === "string") out.add(`${k} \`${v.address}\``);
  if (typeof j.budgetAccount?.address === "string")
    out.add(`budgetAccount \`${j.budgetAccount.address}\``);
  if (typeof j.plan?.signer?.value === "string") out.add(`signer \`${j.plan.signer.value}\``);
  return [...out].join("<br>") || "unknown";
}
function dryOutcome(j) {
  if (typeof j.outcome === "string") return j.outcome;
  if (typeof j.signedDryRun?.result === "string") return `signed dry run: ${j.signedDryRun.result}`;
  if (typeof j.label === "string")
    return j.label.length > 90 ? j.label.slice(0, 87) + "..." : j.label;
  return "unknown";
}
const dryRows = [...dryJson.keys()].sort().map((rel) => {
  const j = dryJson.get(rel);
  return [
    `\`${rel.replace("evidence/", "")}\``,
    dryBlock(j),
    dryRuntime(rel, j),
    typeof j.kind === "string" ? j.kind : "unknown",
    dryEstimate(j),
    dryOrigin(j),
    dryOutcome(j),
  ];
});
const dryLines = [];
dryLines.push("## DRY RUN ONLY (nothing sent)");
dryLines.push("");
dryLines.push(
  "Evidence files that record only dry runs, estimates or read-only replays. Nothing in these rows was broadcast, so there is no transaction-hash column. A file is listed if its name, `kind` or `label` marks it as a dry run, its top-level `outcome` says it was not sent, or it holds a hash seen only inside a signed dry run. Values are copied from the JSON as written; a value the file does not record is `unknown`.",
);
dryLines.push("");
dryLines.push(`Totals: ${dryRows.length} dry-run-only files.`);
dryLines.push("");
dryLines.push(
  "| # | file | block | network / spec | kind | estimated (as written) | origin / signer (as recorded) | outcome / label |",
);
dryLines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
dryRows.forEach((r, i) => dryLines.push(`| ${i + 1} | ${r.map(cell).join(" | ")} |`));
dryLines.push("");
const dryText = dryLines.join("\n");
// This section never carries a tx hash or claims verification.
if (/verif/i.test(dryText))
  throw new Error("DRY RUN ONLY section must not contain the word verified");
if (/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(dryText.replace(/`5[1-9A-HJ-NP-Za-km-z]{47}`/g, "")))
  throw new Error("DRY RUN ONLY section must not contain a 32-byte hash");
lines.push(...dryLines);
// Formatted with the repo's prettier so the committed file passes `prettier --check`.
const prettier = await import("prettier");
const md = await prettier.format(lines.join("\n"), {
  parser: "markdown",
  ...(await prettier.resolveConfig(OUT)),
});

if (process.argv.includes("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== md) {
    console.error("docs/evidence-manifest.md is stale: run node scripts/evidence-manifest.mjs");
    process.exit(1);
  }
  console.log(`evidence manifest up to date (${rows.length} hashes)`);
} else {
  writeFileSync(OUT, md);
  console.log(`wrote ${relative(ROOT, OUT)} (${rows.length} hashes)`);
}
