// Re-binds a compiled plan to freshly read live facts when only allow-listed storage defaults drifted
// (see layout.ts). Pure, browser-safe. The fingerprint and plan digest are unchanged in meaning: a rebound
// plan is a NEW plan with its own digest, compiled against the live facts, which the user then approves.
import { compile, computePlanDigest } from "./compile.js";
import { metadataLayoutHash } from "./layout.js";
import {
  SeamCompileError,
  type CompileOptions,
  type Manifest,
  type Plan,
  type RuntimeFacts,
} from "./types.js";

export type RebindResult =
  | { rebound: false; plan: Plan } // live facts are the plan's own facts: nothing to do
  | { rebound: true; plan: Plan; previousPlanDigest: string; reason: string };

const IDENTITY = [
  "genesisHash",
  "specName",
  "specVersion",
  "transactionVersion",
  "ss58Prefix",
  "tokenSymbol",
  "tokenDecimals",
  "typesBundleHash",
] as const;

function changed(message: string): never {
  throw new SeamCompileError([{ code: "RUNTIME_CHANGED", message }]);
}

/**
 * `plan` must be compile(manifest, planFacts, options). If liveFacts carry the same fingerprint digest the plan
 * is returned as is. Otherwise the runtime identity must match field by field, the v2 layout hash (recomputed
 * from both metadata blobs, never taken from the facts) must match, and recompiling against liveFacts must give
 * the same mode and byte-identical calls. Anything else throws RUNTIME_CHANGED: approve nothing, recompile.
 */
export function rebindPlan(
  manifest: Manifest,
  plan: Plan,
  planFacts: RuntimeFacts,
  liveFacts: RuntimeFacts,
  options: CompileOptions = {},
): RebindResult {
  const original = compile(manifest, planFacts, options);
  if (computePlanDigest(original) !== computePlanDigest(plan))
    changed("the plan is not the compile of this manifest against these plan facts");
  if (plan.fingerprintDigest === liveFacts.fingerprintDigest) return { rebound: false, plan };

  const a = planFacts.fingerprint;
  const b = liveFacts.fingerprint;
  for (const k of IDENTITY)
    if (a[k] !== b[k]) changed(`runtime ${k} changed: ${String(a[k])} -> ${String(b[k])}`);
  let la: string, lb: string;
  try {
    la = metadataLayoutHash(planFacts.source.metadataHex);
    lb = metadataLayoutHash(liveFacts.source.metadataHex);
  } catch (e) {
    changed(`layout hash could not be computed: ${(e as Error).message}`);
  }
  if (la !== lb) changed(`metadata layout changed: ${la} -> ${lb}`);

  const next = compile(manifest, liveFacts, options); // validates liveFacts in full
  if (next.mode !== plan.mode) changed(`execution mode changed: ${plan.mode} -> ${next.mode}`);
  // Everything except the facts binding must be identical: steps, calls, decoded args, signer, mode, outer call.
  const body = (p: Plan) => {
    const { fingerprintDigest: _f, planDigest: _d, ...rest } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
    return JSON.stringify(rest);
  };
  if (body(next) !== body(plan))
    changed("the compiled plan differs on the live runtime (calls, args or signer)");
  return {
    rebound: true,
    plan: next,
    previousPlanDigest: computePlanDigest(plan),
    reason: `only allow-listed storage defaults drifted (metadata ${a.metadataHash} -> ${b.metadataHash}, layout ${la} unchanged); calls are byte-identical`,
  };
}
