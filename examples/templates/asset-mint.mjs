// asset-mint: mint 500 base units of a test asset to dev Bob. Offline; nothing is signed.
import { DEV, isMain, runTemplate } from "./_shared.mjs";
const assetPolicy = (recipients, max = "1000") => ({
  allowedCapabilities: ["Assets.transfer_keep_alive", "Assets.transfer", "Assets.mint"],
  allowedAssets: [DEV.ASSET],
  allowedRecipients: recipients,
  maxAmountPerAsset: { [DEV.ASSET]: max },
});

export const spec = {
  id: "asset-mint",
  params: { signer: DEV.ALICE, recipient: DEV.BOB, assetId: DEV.ASSET, amount: "500" },
  policy: assetPolicy([DEV.BOB]),
  block: { what: "amount over the asset cap (1001 > 1000)", params: { amount: "1001" } },
  edit: { recipient: DEV.CHARLIE },
  summary: (o) =>
    `mint 500 of asset ${DEV.ASSET} to dev Bob, ${o.mode}, policy ${o.policyAllowed ? "allows" : "blocks"} it`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
