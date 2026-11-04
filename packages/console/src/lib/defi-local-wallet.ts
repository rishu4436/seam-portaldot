import type { Wallet } from "@seam/defi";
// This module is imported only in Vite's development branch and excluded from production builds.
export async function localWallet(rpcUrl: string): Promise<{ wallet: Wallet; account: string }> {
  const url = new URL(rpcUrl);
  if (
    !import.meta.env.DEV ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new Error("Local account connector is restricted to development on loopback");
  let id = 0;
  const request: Wallet["request"] = async ({ method, params = [] }) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Local chain RPC unavailable");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error("Invalid local RPC response");
    const result = body as { result?: unknown; error?: { message: string; code: number } };
    if (result.error)
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.result;
  };
  const chain = await request({ method: "eth_chainId" });
  if (chain !== "0x7a69") throw new Error("Local account connector requires chain 31337");
  const accounts = await request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || typeof accounts[1] !== "string")
    throw new Error("No funded local account found");
  const account = accounts[1];
  return {
    account,
    wallet: {
      request: (input) =>
        input.method === "eth_accounts" ? Promise.resolve([account]) : request(input),
    },
  };
}
