// sequential-transfers: two transfers, one after the other (step 2 only if step 1 is verified). Offline.
import { DEV, isMain, runTemplate } from "./_shared.mjs";
const assetPolicy = (recipients, max = "1000") => ({
  allowedCapabilities: ["Assets.transfer_keep_alive", "Assets.transfer", "Assets.mint"],
  allowedAssets: [DEV.ASSET],
  allowedRecipients: recipients,
  maxAmountPerAsset: { [DEV.ASSET]: max },
});

export const spec = {
  id: "sequential-transfers",
  params: {
    signer: DEV.ALICE,
    assetId: DEV.ASSET,
    recipient1: DEV.BOB,
    amount1: "10",
    recipient2: DEV.CHARLIE,
    amount2: "20",
  },
  policy: { ...assetPolicy([DEV.BOB, DEV.CHARLIE]), maxSteps: 2, allowedModes: ["sequential"] },
  block: {
    what: "wrong step-2 recipient (Dave is not allow-listed)",
    params: { recipient2: DEV.DAVE },
  },
  edit: { recipient2: DEV.BOB, amount2: "900" },
  summary: (o) =>
    `${o.steps} sequential transfers (Bob 10, Charlie 20), ${o.mode}; if step 2 fails, step 1 stays executed`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
