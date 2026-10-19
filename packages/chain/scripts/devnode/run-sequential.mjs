// Real sequential SEAM run on the local dev node: transfer -> contract call (emits event) -> mint, strict policy.
import { devFacts, devKeys, loadState, saveEvidence } from "./lib.mjs";
import { devManifest, devPolicy, runFlow, settleEffect } from "./flow.mjs";

const facts = await devFacts();
const k = await devKeys();
const st = loadState();
if (!st.contract) throw new Error("run setup.mjs first");
const manifest = devManifest({
  alice: k.alice.address,
  bob: k.bob.address,
  charlie: k.charlie.address,
  contract: st.contract,
  genesis: facts.fingerprint.genesisHash,
});
const policy = devPolicy({ bob: k.bob.address, charlie: k.charlie.address, contract: st.contract });
const out = await runFlow({
  facts,
  manifest,
  policy,
  alice: k.alice,
  effects: { call: settleEffect(k.alice.address) },
});
const file = saveEvidence(`runs/sequential-${Date.now()}.json`, {
  kind: "sequential",
  recordingVersion: 2,
  ranAt: new Date().toISOString(),
  requireSignedDryRun: policy.requireSignedDryRun,
  ...out,
});
const r = out.run?.receipt;
console.log(
  file,
  out.stage ?? "",
  JSON.stringify(out.policyResult?.rules?.filter((x) => x.outcome !== "pass")),
  out.approval?.reason ?? "",
);
if (r)
  console.log(
    r.result,
    out.run.stoppedReason ?? "",
    JSON.stringify(
      r.steps.map((s) => [
        s.actionId,
        s.status,
        s.verification,
        s.txHash,
        s.block?.number,
        s.reason,
      ]),
      null,
      1,
    ),
  );
else console.log(JSON.stringify(out.run, null, 1)?.slice(0, 3000));
