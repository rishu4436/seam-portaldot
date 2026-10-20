// Compile the V3 wallet-demo Manifest with the browser-safe entries, from Node.
// Run from the repo root after `npm run build`: node docs/examples/builder-compile.mjs
// Facts come from the read-only V3 capabilities evidence; nothing connects, signs or submits.
import { readFileSync } from "node:fs";
import { argFields, checkManifest, compile, supportedKinds } from "@seam/compiler/browser";
import { assertPolicyAllows, explainPolicy, PolicyBlockedError } from "@seam/policy/browser";

const caps = JSON.parse(
  readFileSync("evidence/testnet-v3/capabilities-1792508589179.json", "utf8"),
);
const demo = JSON.parse(readFileSync("packages/console/src/demo/v3-demo-transfer.json", "utf8"));
const seq = JSON.parse(
  readFileSync("packages/console/src/demo/v3-demo-transfer-policy-sequential.json", "utf8"),
);
const facts = caps.facts; // LiveCapabilities.facts: hand straight to the compiler

for (const k of supportedKinds(facts))
  console.log(k.kind, k.supported ? `${k.palletIndex}/${k.callIndex}` : `unsupported: ${k.reason}`);
console.log(
  "assets.transfer fields:",
  argFields("assets.transfer")
    .map((f) => f.name)
    .join(", "),
);

const check = checkManifest(demo.manifest, facts);
console.log("checkManifest ok:", check.ok, "issues:", check.issues.length);

const plan = compile(demo.manifest, facts);
console.log("mode:", plan.mode, "planDigest:", plan.planDigest);
// The plan digest binds the runtime fingerprint. The capabilities read (#118808) saw a different raw metadataHash than
// the facts the committed demo plan was compiled from, so the digest differs from demo.plan.planDigest. The same calls.
console.log(
  "same metadataHash as the demo plan's facts:",
  facts.fingerprint.metadataHash === demo.fingerprint.metadataHash,
);
console.log(
  "same call bytes as the demo plan:",
  JSON.stringify(plan.steps.map((s) => s.encodedCall)) ===
    JSON.stringify(demo.plan.steps.map((s) => s.encodedCall)),
);

// No preflight given: the gate must block (PREFLIGHT_UNKNOWN), whichever policy is used.
try {
  assertPolicyAllows(
    { policy: seq.policy, plan, facts, manifest: demo.manifest },
    { acknowledgedDowngrade: true },
  );
  console.log("gate: allowed (unexpected)");
} catch (e) {
  if (!(e instanceof PolicyBlockedError)) throw e;
  console.log("gate blocked:", e.codes.join(", "));
  for (const x of explainPolicy(e.gate.result).filter((x) => x.status !== "pass"))
    console.log(" ", x.message);
}
