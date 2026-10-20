import type { Plan, RuntimeFacts } from "@seam/compiler";
import { withClient, type ConnectOptions, type Endpoint, type RpcClient } from "./rpc.js";
import {
  preflightWithClient,
  type PreflightCoreOptions,
  type PreflightReport,
} from "./preflight-core.js";
export * from "./preflight-core.js";

export interface PreflightOptions extends ConnectOptions, PreflightCoreOptions {}

/** A client whose every request fails with `error`: lets the unavailable-plan path report a connection failure. */
function failingClient(error: unknown): RpcClient {
  const fail = () => Promise.reject(error);
  return { send: fail, subscribe: fail, unsubscribe: fail };
}

/**
 * Preflight for a compiled plan (node entry): opens `endpoint` and runs the shared core, preflightWithClient, which the
 * browser entry runs over a plain `send`. Read-only. See preflight-core.ts for what is and is not simulated.
 */
export async function preflight(
  endpoint: Endpoint,
  plan: Plan,
  facts: RuntimeFacts,
  opts: PreflightOptions = {},
): Promise<PreflightReport> {
  try {
    return await withClient(
      endpoint,
      (client) => preflightWithClient(client, plan, facts, opts),
      opts,
    );
  } catch (e) {
    // As before the split: an unavailable V3 plan never throws on a connection failure; it reports it.
    if (
      plan.mode === "unavailable" &&
      plan.steps.some((s) => s.kind === "revive.call" || s.kind === "nfts.mint") &&
      plan.fingerprintDigest === facts.fingerprintDigest
    )
      return preflightWithClient(failingClient(e), plan, facts, opts);
    throw e;
  }
}
