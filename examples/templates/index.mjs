// Runs every P1-04 template example (offline). npm run examples:templates   (add --json for one JSON line)
import { run as assetTransfer } from "./asset-transfer.mjs";
import { run as nftMint } from "./nft-mint.mjs";
import { run as assetMint } from "./asset-mint.mjs";
import { run as sequentialTransfers } from "./sequential-transfers.mjs";
import { run as atomicBatch } from "./atomic-batch.mjs";
import { run as reviveCall } from "./revive-call.mjs";
import { run as restrictedDeploy } from "./restricted-deploy.mjs";

const json = process.argv.includes("--json");
const results = [
  assetTransfer,
  nftMint,
  assetMint,
  sequentialTransfers,
  atomicBatch,
  reviveCall,
  restrictedDeploy,
].map((r) => r({ quiet: json }));
if (json) console.log(JSON.stringify(results));
else console.log(`\n${results.length} template examples ran offline; nothing signed or submitted.`);
