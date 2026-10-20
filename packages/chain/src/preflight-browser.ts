import type { Plan, RuntimeFacts } from "@seam/compiler/facts";
import { clientFromSend, type RpcClient, type RpcSend } from "./rpc-core.js";
import {
  preflightWithClient,
  type PreflightCoreOptions,
  type PreflightReport,
} from "./preflight-core.js";
import type { PreflightResult } from "./types.js";

const asClient = (rpc: RpcSend | RpcClient): RpcClient =>
  typeof rpc === "function" ? clientFromSend(rpc) : rpc;

/**
 * Browser preflight, full report: the same core as the node entry's preflight (preflightWithClient), over a plain
 * JSON-RPC `send` (or an RpcClient). Read-only: it never signs or submits.
 */
export function preflightReport(
  rpc: RpcSend | RpcClient,
  plan: Plan,
  facts: RuntimeFacts,
  opts: PreflightCoreOptions = {},
): Promise<PreflightReport> {
  return preflightWithClient(asClient(rpc), plan, facts, opts);
}

/**
 * Browser preflight: the PreflightResult @seam/policy's gate takes ({ steps, totalFee }, one step per plan step).
 * Anything the node does not answer is { unknown: true } / dryRun "unknown"; nothing is filled in.
 */
export async function preflight(
  rpc: RpcSend | RpcClient,
  plan: Plan,
  facts: RuntimeFacts,
  opts: PreflightCoreOptions = {},
): Promise<PreflightResult> {
  return (await preflightReport(rpc, plan, facts, opts)).result;
}
