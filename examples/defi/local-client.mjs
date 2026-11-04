// Read-only integration example. Start `npm run defi:local` first.
import { readFile } from "node:fs/promises";
import { DeFiClient, parseRegistry } from "@seam/defi";
const registry=parseRegistry(JSON.parse(await readFile(new URL("../../.seam-defi/registry.json",import.meta.url),"utf8")));
const {accounts}=JSON.parse(await readFile(new URL("../../.seam-defi/accounts.json",import.meta.url),"utf8"));
const client=new DeFiClient(registry);
const positions=await client.positions(accounts[0]);
const quote=await client.quote({action:"swap",account:accounts[0],recipient:accounts[0],amount:"1",slippageBps:50,ttlSeconds:300,maxTotalFee:"10000000000000000"});
console.log(JSON.stringify({network:registry.mode,positions,quote,encodedCall:client.data(quote),submitted:false},null,2));
// Browser integrations supply an EIP-1193 wallet + durable DeFiStore to Executor.
// Reads/quotes never request a signature. Calling Executor.execute is an explicit wallet flow.
