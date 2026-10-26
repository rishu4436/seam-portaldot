// restricted-deploy: Revive.instantiate_with_code with value 0 and explicit caps, checked by checkDeployStep.
// NO deploy happens: the code is an 8-byte test blob, there is no budget, and nothing is signed.
// Known gap: the team rule says proof_size 0 (what the V3 dry runs return) is UNKNOWN. checkDeployStep does not
// enforce that yet (Sentinel's fix is pending); this example prints what it returns today.
import { instantiateTemplate } from "@seam/compiler";
import { checkDeployStep } from "@seam/policy";
import { DEV, isMain, runTemplate } from "./_shared.mjs";

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
  extra: ({ g, log, gate }) => {
    const step = g.plan.steps[0];
    const rules = checkDeployStep(step, g.policy.deploy, g.plan.signer.publicKey);
    const deployRules = rules.map((r) => `${r.rule}:${r.outcome}`);
    log(`checkDeployStep: ${deployRules.join(" ")}`);
    // proof_size 0, as every V3 dry run so far reported it. checkDeployStep alone treats "0" as a number that fits
    // under the cap, so the example applies the team rule on top: 0 is unknown and the deploy is blocked.
    const zero = gate({ ...params, proofSize: "0" }, policyFor(CODE_HASH));
    const zeroRules = checkDeployStep(
      zero.plan.steps[0],
      zero.policy.deploy,
      zero.plan.signer.publicKey,
    );
    const proofRule = zeroRules.filter((r) => r.rule === "deploy_gas_limit").map((r) => r.outcome);
    log(
      `proof_size 0: checkDeployStep returns ${proofRule.join(",")} today (KNOWN GAP: should be unknown/blocked; Sentinel's fix pending)`,
    );
    const wrongValue = checkDeployStep(
      { ...step, decodedArgs: { ...step.decodedArgs, value: "1" } },
      g.policy.deploy,
      g.plan.signer.publicKey,
    );
    return {
      codeHash: step.decodedArgs.codeHash,
      deployRules,
      proofSizeZero: {
        checkDeployStepOutcomes: proofRule,
        knownGap: proofRule.every((x) => x === "pass"),
      },
      valueNonZeroCodes: wrongValue.filter((r) => r.outcome === "block").map((r) => r.code),
      deployed: false,
    };
  },
  summary: (o) =>
    `deploy of an 8-byte test blob (hash ${o.codeHash.slice(0, 12)}…) passes the caps offline, but NOT deployed: no budget, and no real dry-run limits`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
