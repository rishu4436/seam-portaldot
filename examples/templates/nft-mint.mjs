// nft-mint: mint item 7 of collection 1 to dev Bob. Offline; nothing is signed.
import { DEV, isMain, runTemplate } from "./_shared.mjs";

export const spec = {
  id: "nft-mint",
  params: { signer: DEV.ALICE, recipient: DEV.BOB, collection: "1", item: "7" },
  policy: { allowedCapabilities: ["Nfts.mint"], allowedRecipients: [DEV.BOB] },
  block: { what: "wrong recipient (Dave is not allow-listed)", params: { recipient: DEV.DAVE } },
  edit: { recipient: DEV.CHARLIE },
  summary: (o) =>
    `mint NFT 1/7 to dev Bob, ${o.mode}, policy ${o.policyAllowed ? "allows" : "blocks"} it`,
};

export const run = (o) => runTemplate(spec, o);
if (isMain(import.meta.url)) run();
