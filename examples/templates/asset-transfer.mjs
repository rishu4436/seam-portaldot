// asset-transfer: send 1000 base units of a test asset from dev Alice to dev Bob. Offline; nothing is signed.
import { DEV, isMain, runTemplate } from "./_shared.mjs";
const assetPolicy = (recipients, max = "1000") => ({
  allowedCapabilities: ["Assets.transfer_keep_alive", "Assets.transfer", "Assets.mint"],
  allowedAssets: [DEV.ASSET],
  allowedRecipients: recipients,
  maxAmountPerAsset: { [DEV.ASSET]: max },
});

export const spec = {
  id: "asset-transfer",
  params: { signer: DEV.ALICE, recipient: DEV.BOB, assetId: DEV.ASSET, amount: "1000" },
  policy: assetPolicy([DEV.BOB]),
  block: { what: "wrong recipient (Dave is not allow-listed)", params: { recipient: DEV.DAVE } },
  edit: { recipient: DEV.CHARLIE },
  summary: (o) =>
    `transfer 1000 of asset ${DEV.ASSET} to dev Bob, ${o.mode}, policy ${o.policyAllowed ? "allows" : "blocks"} it`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
