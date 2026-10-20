import type { Hex, RuntimeFacts } from "@seam/compiler";
import { withClient, type ConnectOptions, type Endpoint } from "./rpc.js";
import { dryRunOne, type SignedDryRunDetail } from "./dryrun-core.js";
export { dryRunOne, type SignedDryRunDetail } from "./dryrun-core.js";
import type { SignedDryRun } from "./types.js";

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
