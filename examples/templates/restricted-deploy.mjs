// restricted-deploy: Revive.instantiate_with_code with value 0 and explicit caps, checked by checkDeployStep.
// NO deploy happens: the code is an 8-byte test blob, there is no budget, and nothing is signed.
// Proof size: V3 does not meter proof_size on instantiate, so the deploy needs its own non-zero cap. A cap of "0" is
// unknown and blocks (DEPLOY_PROOF_SIZE_UNKNOWN); strict mode also needs a measured query_call_info total.
import { instantiateTemplate } from "@seam/compiler";
import { checkDeployStep } from "@seam/policy";
import { DEV, codesOf, isMain, runTemplate, strictProofSize } from "./_shared.mjs";

const caps = {
  maxStorageDepositLimit: "10000000000000",
  maxGasLimit: "5000000000",
  maxProofSize: "200000",
};
const params = {
  signer: DEV.ALICE,
  code: "0x50564d00deadbeef",
  data: "0x",
  gasLimit: "5000000000",
  proofSize: "200000",
  storageDepositLimit: "10000000000000",
};
// The allow-list holds the hash of THIS code (the same keccak-256 the compiler puts in decodedArgs.codeHash).
const CODE_HASH = instantiateTemplate("restricted-deploy", params).codeHash;
const policyFor = (h) => ({
  allowedCapabilities: ["Revive.instantiate_with_code"],
  deploy: { allowedCodeHashes: [h], ...caps },
});
export const spec = {
  id: "restricted-deploy",
  params,
  policy: policyFor(CODE_HASH),
  block: { what: "different code (hash not allow-listed)", params: { code: "0x50564d00cafebabe" } },
  edit: { storageDepositLimit: "9000000000000" },
  extra: ({ g, facts, log, gate }) => {
    const step = g.plan.steps[0];
    const rules = checkDeployStep(step, g.policy.deploy, g.plan.signer.publicKey);
    const deployRules = rules.map((r) => `${r.rule}:${r.outcome}`);
    log(`checkDeployStep: ${deployRules.join(" ")}`);
    // A proof size cap of "0" is unknown, never a bound: the gate blocks it.
    const zero = gate({ ...params, proofSize: "0" }, policyFor(CODE_HASH));
    const zeroCodes = codesOf(zero.gr);
    log(`[error] proof size cap "0": allowed=${zero.gr.allowed} codes=${zeroCodes.join(",")}`);
    // Strict mode: cap 200,000, so a measured query_call_info total must be above it (example: cap + 6,823).
    const strict = strictProofSize(g, facts, "206823");
    log(
      `[strict] requireMeasuredProofSize, no callInfoProofSize: allowed=${strict.withoutCallInfo.allowed} codes=${strict.withoutCallInfo.codes.join(",")}`,
    );
    log(
      `[strict] with callInfoProofSize ${strict.callInfoProofSize} (> cap): allowed=${strict.withCallInfo.allowed}`,
    );
    const wrongValue = checkDeployStep(
      { ...step, decodedArgs: { ...step.decodedArgs, value: "1" } },
      g.policy.deploy,
      g.plan.signer.publicKey,
    );
    return {
      codeHash: step.decodedArgs.codeHash,
      deployRules,
      proofSizeZero: { allowed: zero.gr.allowed, codes: zeroCodes },
      strictProofSize: strict,
      valueNonZeroCodes: wrongValue.filter((r) => r.outcome === "block").map((r) => r.code),
      deployed: false,
    };
  },
  summary: (o) =>
    `deploy of an 8-byte test blob (hash ${o.codeHash.slice(0, 12)}…) passes the caps offline, but NOT deployed: no budget, and no real dry-run limits`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
