import type { RecordEntry } from "./store.js";
import type { Verification } from "./verify.js";
/** Device-local pilot counters, separated by network. No prices, TVL, APY or revenue inference. */
export function pilotMetrics(
  rows: RecordEntry[],
  results: Record<string, Verification>,
  now = new Date(),
) {
  const unique = [...new Map(rows.map((row) => [row.plan.id, row])).values()];
  const networks = [...new Set(unique.map((r) => `${r.registry.mode}:${r.registry.chainId}`))].map(
    (network) => {
      const selected = unique.filter((r) => `${r.registry.mode}:${r.registry.chainId}` === network);
      const accepted = selected.filter(
        (r) =>
          results[r.plan.id]?.status ===
          (r.registry.mode === "local" ? "local-confirmed" : "verified"),
      );
      return {
        network,
        recordedPlans: selected.length,
        accountsOnThisDevice: new Set(selected.map((r) => r.plan.account.toLowerCase())).size,
        checkedExecutions: {
          swap: accepted.filter((r) => r.plan.action === "swap").length,
          deposit: accepted.filter((r) => r.plan.action === "deposit").length,
          redeem: accepted.filter((r) => r.plan.action === "redeem").length,
        },
        walletRejections: selected.flatMap((r) => r.attempts).filter((a) => a.state === "rejected")
          .length,
        unresolvedRequests: selected
          .flatMap((r) => r.attempts)
          .filter((a) => ["requesting", "submitted", "uncertain"].includes(a.state)).length,
        failedVerifications: selected.filter((r) => results[r.plan.id]?.status === "failed").length,
        revertedExecutions: selected.filter((r) => results[r.plan.id]?.status === "reverted")
          .length,
        recordedFeeWeiOfCheckedExecutions: accepted
          .reduce((sum, r) => sum + BigInt(results[r.plan.id].fee ?? "0"), 0n)
          .toString(),
      };
    },
  );
  return {
    format: "seam.defi.pilot-metrics.v1",
    generatedAt: now.toISOString(),
    scope:
      "This device only; unauthenticated counters. Local activity is not live testnet adoption. No external telemetry was sent.",
    networks,
  };
}
