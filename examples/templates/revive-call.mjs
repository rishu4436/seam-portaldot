// revive-call: call a pallet-revive contract with explicit limits. The contract address is made up; nothing
// is called, dry-run or signed. Offline.
import { DEV, isMain, runTemplate } from "./_shared.mjs";

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
  summary: (o) =>
    `call test contract ${DEV.TEST_CONTRACT} with selector 0x12345678, ${o.mode}, value 0`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
