import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, parseUnits, toHex } from "viem";
import { hardhat } from "viem/chains";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { buildContracts } from "./build-contracts.mjs";
const here = dirname(fileURLToPath(import.meta.url));
export async function startNode(port = 8545) {
  await new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once("error", () =>
      reject(
        new Error(
          `Local port ${port} is already in use; stop the other service or choose an isolated port.`,
        ),
      ),
    );
    reservation.listen(port, "127.0.0.1", () => reservation.close(resolve));
  });
  // Hardhat prints public development keys on startup. Do not capture or display them.
  const child = spawn(
    process.execPath,
    [
      resolve(here, "../../../node_modules/hardhat/dist/src/cli.js"),
      "node",
      "--network",
      "default",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: resolve(here, ".."), stdio: "ignore", windowsHide: true },
  );
  const url = `http://127.0.0.1:${port}/`,
    rpc = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 1000 }) });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null)
      throw new Error(
        "Local Hardhat node stopped during startup. Check the pinned Hardhat configuration.",
      );
    try {
      if ((await rpc.getChainId()) === 31337) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    child.kill();
    throw new Error("Local chain did not start in 30 seconds");
  }
  return { child, url, rpc, stop: () => child.kill() };
}
export async function bootstrap(url) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname))
    throw new Error("Bootstrap is restricted to loopback development RPCs");
  const rpc = createPublicClient({ transport: http(url) });
  if ((await rpc.getChainId()) !== 31337) throw new Error("Bootstrap requires local chain 31337");
  const accounts = await rpc.request({ method: "eth_accounts" });
  const wallet = createWalletClient({ chain: hardhat, account: accounts[0], transport: http(url) });
  const built = buildContracts(),
    artifacts = built.contracts;
  async function deploy(name, args) {
    const hash = await wallet.deployContract({ ...artifacts[name], args });
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }
  async function write(name, address, functionName, args) {
    const hash = await wallet.writeContract({
      address,
      abi: artifacts[name].abi,
      functionName,
      args,
    });
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Local setup ${functionName} failed`);
  }
  const usd = await deploy("SeamTestToken", ["Local reference dollar", "lUSD", 6]);
  const eth = await deploy("SeamTestToken", ["Local reference ether", "lETH", 18]);
  const pool = await deploy("SeamReferencePool", [usd, eth]);
  const vault = await deploy("SeamReferenceVault", [usd]);
  const deploymentId = toHex(randomBytes(32));
  const guard = await deploy("SeamGuardRouter", [deploymentId]);
  await write("SeamTestToken", usd, "mint", [accounts[0], parseUnits("2000000", 6)]);
  await write("SeamTestToken", eth, "mint", [accounts[0], parseUnits("1000", 18)]);
  for (const account of accounts.slice(1, 4)) {
    await write("SeamTestToken", usd, "mint", [account, parseUnits("10000", 6)]);
    await write("SeamTestToken", eth, "mint", [account, parseUnits("10", 18)]);
  }
  await write("SeamTestToken", usd, "approve", [pool, parseUnits("1000000", 6)]);
  await write("SeamTestToken", eth, "approve", [pool, parseUnits("500", 18)]);
  const head = await rpc.getBlock();
  await write("SeamReferencePool", pool, "addLiquidity", [
    parseUnits("1000000", 6),
    parseUnits("500", 18),
    1n,
    accounts[0],
    head.timestamp + 600n,
  ]);
  await write("SeamTestToken", usd, "approve", [vault, parseUnits("1000", 6)]);
  await write("SeamReferenceVault", vault, "deposit", [parseUnits("1000", 6), accounts[0]]);
  const pin = async (address) => ({ address, codeHash: keccak256(await rpc.getCode({ address })) });
  const registry = {
    version: 1,
    mode: "local",
    chainId: 31337,
    rpcUrl: url,
    genesisHash: (await rpc.getBlock({ blockNumber: 0n })).hash,
    deploymentId,
    guard: await pin(guard),
    tokens: [
      { ...(await pin(usd)), symbol: "lUSD", decimals: 6 },
      { ...(await pin(eth)), symbol: "lETH", decimals: 18 },
    ],
    pool: await pin(pool),
    vault: { ...(await pin(vault)), symbol: "svUSD", decimals: 6 },
    createdAt: new Date().toISOString(),
  };
  return {
    registry,
    accounts,
    artifacts,
    compiler: built.compiler,
    sourceSha256: built.sourceSha256,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const node = await startNode();
  process.on("SIGINT", () => {
    node.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    node.stop();
    process.exit(0);
  });
  try {
    console.log("Local chain started on loopback. Compiling and creating reference markets…");
    const market = await bootstrap(node.url);
    const out = resolve(here, "../../../.seam-defi");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "registry.json"), JSON.stringify(market.registry, null, 2) + "\n");
    writeFileSync(
      resolve(out, "accounts.json"),
      JSON.stringify(
        { chainId: 31337, rpcUrl: node.url, accounts: market.accounts.slice(1, 4) },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Ready: local reference swap + ERC-4626 deposit/redeem. Chain 31337.\nFunded development account: ${market.accounts[1]}\nStart the console in another terminal, then open /console.html?view=defi.\nThe local-only account connector never reads or stores a private key. This chain resets when stopped.`,
    );
    await new Promise((resolve) => node.child.once("exit", resolve));
  } catch (error) {
    node.stop();
    console.error(error.message);
    process.exitCode = 1;
  }
}
