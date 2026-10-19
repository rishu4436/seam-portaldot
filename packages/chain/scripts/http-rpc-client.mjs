// Kept for scripts/v3-funded-run.mjs and older notes. The transport now lives in @seam/chain (src/http-transport.ts):
// idempotent reads are retried with backoff; author_submitExtrinsic is sent exactly once (the old script version
// retried it, which produced the "1013 Already Imported" uncertain step in the first funded V3 run).
import { httpRpcClient as core } from "../dist/index.js";

export function httpRpcClient(url, { pollMs = 3000, tries = 8 } = {}) {
  return core(url, { pollMs, readAttempts: tries });
}
