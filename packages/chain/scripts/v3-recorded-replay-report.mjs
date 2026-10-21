// Adds checks + verdict to a v3-recorded-replay.ts JSON and writes the .md. Usage: node v3-recorded-replay-report.mjs <file.json> ok|fail
import fs from "node:fs";
const [f, kind] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(f));
const big = (x) => BigInt(x);
const nat = d.state.native;
const freeDelta = big(nat.parent.free) - big(nat.block.free);
const resDelta = big(nat.block.reserved) - big(nat.parent.reserved);
const fee = big(d.feePaid.actualFee);
const ev = d.events.map((e) => `${e.pallet}.${e.name}`);
const checks = [];
const c = (name, ok, detail) => checks.push({ name, ok, detail });
c(
  "block canonical and finalized",
  d.block.finalized,
  `#${d.block.number} ${d.block.hash}, finalized head #${d.block.finalizedHead}`,
);
c(
  "signature valid (CheckMetadataHash mode 0)",
  d.signatureValid && d.metadataHashMode === 0,
  `era birth #${d.eraBirthBlock}, genesis ${d.signatureGenesis}`,
);
c("call is utility.batchAll", d.call.name === "utility.batchAll", d.call.innerCalls.join(", "));
c("fee from TransactionFeePaid", !!d.feePaid, `${d.feePaid.actualFee} (tip ${d.feePaid.tip})`);
if (kind === "ok") {
  c(
    "ExtrinsicSuccess + BatchCompleted",
    d.success === true && ev.includes("Utility.BatchCompleted"),
    ev.join(", "),
  );
  c(
    "two ItemCompleted (mint, nfts.mint)",
    ev.filter((e) => e === "Utility.ItemCompleted").length === 2 &&
      ev.includes("Assets.Issued") &&
      ev.includes("Nfts.Issued"),
    "Assets.Issued, Nfts.Issued",
  );
  const sup = big(d.state.assetSupply.block) - big(d.state.assetSupply.parent);
  c(
    "asset 806707 supply +7 (mint applied)",
    sup === 7n,
    `${d.state.assetSupply.parent} → ${d.state.assetSupply.block}`,
  );
  c(
    "signer native: free -= fee + reserved delta (NFT deposit)",
    freeDelta === fee + resDelta,
    `free −${freeDelta}, reserved +${resDelta}, fee ${fee}`,
  );
} else {
  c(
    "ExtrinsicFailed with the exact dispatch error, no BatchCompleted/ItemCompleted",
    d.success === false && !ev.some((e) => e.startsWith("Utility.")),
    `${d.dispatchError}; events ${ev.join(", ")}`,
  );
  c("no inner effects (no Assets/Nfts events)", !ev.some((e) => /^(Assets|Nfts)\./.test(e)), "");
  c(
    "asset 806707 supply unchanged",
    d.state.assetSupply.parent === d.state.assetSupply.block,
    `${d.state.assetSupply.parent} → ${d.state.assetSupply.block}`,
  );
  c(
    "every asset account in the call unchanged",
    Object.values(d.state.assetAccounts).every((v) => v.parent === v.block),
    JSON.stringify(d.state.assetAccounts),
  );
  c(
    "signer native: only the fee left, reserved unchanged",
    freeDelta === fee && resDelta === 0n,
    `free −${freeDelta}, reserved +${resDelta}, fee ${fee}`,
  );
}
const allOk = checks.every((x) => x.ok);
d.checks = checks;
d.verdict = allOk
  ? kind === "ok"
    ? "verified (recorded run, replayed read-only)"
    : "expected_dispatch_failure verified: rolled back (recorded run, replayed read-only)"
  : "mismatch";
fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
let m =
  `# Recorded run, replayed read-only: #${d.block.number}\n\n**Label: recorded run, replayed read-only.** This tx was recorded earlier (see \`independent-verification.md\`). Nothing was signed, submitted or spent now; every value below was re-read from ${d.endpoint} at ${d.readAt} and decoded with the block's own runtime (metadata at the parent, spec ${d.runtime.specVersion}).\n\n- tx \`${d.txHash}\`\n- block #${d.block.number} \`${d.block.hash}\`, extrinsic index ${d.extrinsicIndex}\n- signer ${d.signer}, nonce ${d.nonce}, mortal era period ${d.era.period} from #${d.eraBirthBlock}\n- call \`${d.call.name}\` [${d.call.innerCalls.join(", ")}]\n- fee ${d.feePaid.actualFee} (TransactionFeePaid)\n- outcome: ${d.success ? "ExtrinsicSuccess" : "ExtrinsicFailed: " + d.dispatchError}\n- events: ${ev.join(", ")}\n\n| check | result | detail |\n|---|---|---|\n` +
  checks.map((x) => `| ${x.name} | ${x.ok ? "pass" : "FAIL"} | ${x.detail} |`).join("\n") +
  `\n\n**Verdict: ${d.verdict}.**\n\nState is compared at the parent block vs the block itself, so it covers this block's other extrinsics too (only the inherent timestamp at index 0 here).` +
  (kind === "ok"
    ? ""
    : ` utility.batch_all reverts every inner call when one fails, so the chain shows ExtrinsicFailed (not Utility.BatchInterrupted, which is what non-atomic utility.batch emits).`) +
  `\n\nScript: \`packages/chain/scripts/v3-recorded-replay.ts\`. Data: \`${f.split("/").pop()}\`.\n`;
fs.writeFileSync(f.replace(/\.json$/, ".md"), m);
console.log(
  d.verdict,
  checks.filter((x) => !x.ok),
);
