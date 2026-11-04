import { createReceiptReader, createReadFailover } from "@seam/chain/browser";
import { verifyPlan } from "@seam/compiler/browser";
import type { RuntimeFacts } from "@seam/compiler/browser";
import {
  inspectEvidenceBundle,
  isConsoleReceipt,
  verifyConsoleReceiptLive,
  verifyReceiptLive,
  type EvidenceBundle,
} from "@seam/sdk/browser";

export const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const reads = new Set([
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "chain_getBlock",
  "state_getRuntimeVersion",
  "state_getMetadata",
  "state_getStorage",
  "system_properties",
]);
export function evidenceRpc() {
  const deadline = Date.now() + 45000;
  const send = createReadFailover({ deadline });
  return async (method: string, params: unknown[]): Promise<unknown> => {
    if (!reads.has(method)) throw new Error("Only read-only RPC methods are permitted.");
    return send(method, params);
  };
}
export async function verifyEvidence(bundle: EvidenceBundle) {
  const offline = inspectEvidenceBundle(bundle);
  if (offline.status === "failed") return { status: "failed", checks: offline.checks };
  let facts: RuntimeFacts | undefined;
  const reader = createReceiptReader(evidenceRpc(), {
    expectedGenesis: V3_GENESIS,
    expectedSpec: "portaldot-v3",
    onBlockFacts: (value) => {
      facts ??= value;
    },
  });
  const live = isConsoleReceipt(bundle.receipt)
    ? await verifyConsoleReceiptLive(bundle.receipt, reader)
    : await verifyReceiptLive(bundle.receipt, reader, {
        plan: bundle.plan,
        runtime: bundle.runtime,
        effects: bundle.effects,
      });
  const result = {
    ...live,
    problems: "problems" in live ? live.problems : ([] as string[]),
    notes: "notes" in live ? live.notes : ([] as string[]),
  };
  if (bundle.manifest && facts) {
    const bytes = verifyPlan(bundle.manifest, bundle.plan, facts, {
      abis: bundle.abis,
      allowAtomicUnverified: bundle.plan.mode === "atomic_unverified",
    });
    if (!bytes.ok) {
      result.status = "failed";
      (result.problems ??= []).push(
        `Intent recompilation failed: ${bytes.issues.map((issue) => issue.code).join(", ")}`,
      );
    }
  } else {
    if (result.status === "chain_verified") result.status = "unknown";
    (result.notes ??= []).push(
      "A manifest and historical runtime are required to independently bind intent to call bytes.",
    );
  }
  return result;
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
