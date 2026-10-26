// atomic-batch: two transfers in one Utility.batch_all. Atomic is REQUESTED; with no rollback proof for this
// runtime the compiler labels it atomic_unverified, and the policy must opt in to that mode explicitly. Offline.
import { DEV, isMain, runTemplate } from "./_shared.mjs";
const assetPolicy = (recipients, max = "1000") => ({
  allowedCapabilities: ["Assets.transfer_keep_alive", "Assets.transfer", "Assets.mint"],
  allowedAssets: [DEV.ASSET],
  allowedRecipients: recipients,
  maxAmountPerAsset: { [DEV.ASSET]: max },
});

export const spec = {
  id: "atomic-batch",
  opts: { allowAtomicUnverified: true },
  params: {
    signer: DEV.ALICE,
    assetId: DEV.ASSET,
    recipient1: DEV.BOB,
    amount1: "10",
    recipient2: DEV.CHARLIE,
    amount2: "20",
  },
  policy: {
    ...assetPolicy([DEV.BOB, DEV.CHARLIE]),
    maxSteps: 2,
    allowedModes: ["atomic_unverified"],
  },
  block: {
    what: "policy does not accept atomic_unverified",
    policy: {
      ...assetPolicy([DEV.BOB, DEV.CHARLIE]),
      maxSteps: 2,
      allowedModes: ["sequential", "atomic_verified"],
    },
  },
  edit: { recipient2: DEV.DAVE },
  summary: (o) => `batch of 2 transfers, ${o.mode} (requested atomic, rollback NOT proven)`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
