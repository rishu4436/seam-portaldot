import type { Hex, RuntimeFacts } from "@seam/compiler";
import { rpc, withClient, type ConnectOptions, type Endpoint, type RpcClient } from "./rpc.js";
import { decodeRuntime, describeDispatchError, extrinsicHash } from "./runtime.js";
import type { SignedDryRun } from "./types.js";

export interface SignedDryRunDetail {
  txHash: Hex;
  outcome: SignedDryRun;
  /** Plain reason, e.g. "dispatch ok", "dispatch failed: assets.BalanceLow ...", "invalid: Stale". */
  detail: string;
  /** Raw ApplyExtrinsicResult hex from system_dryRun, when the node answered. */
  raw?: Hex;
}

/**
 * system_dryRun of one signed extrinsic at `at` (default best block). `position` is its place in a sequential
 * run: an Invalid(Future) nonce for position > 0 only means the earlier transactions aren't on chain yet, so it
 * is 'unknown' (dry-run it again right before it is submitted), never 'ok'.
 */
export async function dryRunOne(
  client: RpcClient,
  facts: RuntimeFacts,
  extrinsic: Hex,
  position = 0,
  at?: Hex,
): Promise<SignedDryRunDetail> {
  const txHash = extrinsicHash(extrinsic);
  let raw: Hex;
  try {
    raw = await rpc<Hex>(client, "system_dryRun", at ? [extrinsic, at] : [extrinsic]);
  } catch (e) {
    return {
      txHash,
      outcome: "unknown",
      detail: `system_dryRun unavailable: ${(e as Error).message.slice(0, 200)}`,
    };
  }
  const { registry } = decodeRuntime(facts);
  let res: any;
  try {
    res = registry.createType("ApplyExtrinsicResult", raw);
  } catch (e) {
    return {
      txHash,
      outcome: "unknown",
      detail: `could not decode the dry-run result: ${(e as Error).message}`,
      raw,
    };
  }
  if (res.isErr) {
    const err = res.asErr; // TransactionValidityError
    if (err.isInvalid && err.asInvalid.isFuture && position > 0) {
      return {
        txHash,
        outcome: "unknown",
        detail:
          "nonce is in the future: the earlier transactions of this run are not on chain yet; dry-run again right before submitting",
        raw,
      };
    }
    if (err.isUnknown)
      return {
        txHash,
        outcome: "unknown",
        detail: `validity unknown: ${err.asUnknown.toString()}`,
        raw,
      };
    return {
      txHash,
      outcome: "failed",
      detail: `invalid transaction: ${err.isInvalid ? err.asInvalid.type : err.type}`,
      raw,
    };
  }
  if (res.asOk.isErr)
    return {
      txHash,
      outcome: "failed",
      detail: `dispatch failed: ${describeDispatchError(facts, res.asOk.asErr.toU8a())}`,
      raw,
    };
  return { txHash, outcome: "ok", detail: "dispatch ok", raw };
}

/**
 * system_dryRun of each signed transaction, in order. `results` goes straight into @seam/policy
 * checkBeforeSubmit({ signedDryRun }).
 */
export async function dryRunSigned(
  endpoint: Endpoint,
  signedExtrinsics: Hex[],
  facts: RuntimeFacts,
  opts: ConnectOptions & { at?: Hex } = {},
): Promise<{ results: SignedDryRun[]; details: SignedDryRunDetail[] }> {
  return withClient(
    endpoint,
    async (client) => {
      const details: SignedDryRunDetail[] = [];
      for (const [i, x] of signedExtrinsics.entries())
        details.push(await dryRunOne(client, facts, x, i, opts.at));
      return { results: details.map((d) => d.outcome), details };
    },
    opts,
  );
}
