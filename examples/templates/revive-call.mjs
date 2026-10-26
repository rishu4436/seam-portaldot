// revive-call: call a pallet-revive contract with explicit limits. The contract address is made up; nothing
// is called, dry-run or signed. Offline.
import { DEV, isMain, runTemplate, strictProofSize } from "./_shared.mjs";

const limits = {
  maxNativeValue: "0",
  maxGasLimit: "5000000000",
  maxProofSize: "1000000",
  maxStorageDeposit: "100",
};
export const spec = {
  id: "revive-call",
  params: {
    signer: DEV.ALICE,
    contract: DEV.TEST_CONTRACT,
    data: "0x12345678",
    value: "0",
    gasLimit: "5000000000",
    proofSize: "1000000",
    storageDepositLimit: "100",
  },
  policy: {
    allowedCapabilities: ["Revive.call"],
    allowedContracts: [DEV.TEST_CONTRACT],
    ...limits,
  },
  block: { what: "wrong contract (not allow-listed)", params: { contract: DEV.OTHER_CONTRACT } },
  edit: { data: "0xdeadbeef" },
  extra: ({ g, facts, log }) => {
    // Strict mode: the cap is 1,000,000, so a measured query_call_info total must be above it (example: cap + 7,725).
    const strict = strictProofSize(g, facts, "1007725");
    log(
      `[strict] requireMeasuredProofSize, no callInfoProofSize: allowed=${strict.withoutCallInfo.allowed} codes=${strict.withoutCallInfo.codes.join(",")}`,
    );
    log(
      `[strict] with callInfoProofSize ${strict.callInfoProofSize} (> cap): allowed=${strict.withCallInfo.allowed}`,
    );
    return { strictProofSize: strict };
  },
  summary: (o) =>
    `call test contract ${DEV.TEST_CONTRACT} with selector 0x12345678, ${o.mode}, value 0`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
