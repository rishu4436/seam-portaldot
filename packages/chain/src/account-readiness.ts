import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { clientFromSend, rpc, toSafeNumber, type RpcSend } from "./rpc-core.js";
import { decodeRuntime, storageKey } from "./runtime.js";
import { readStorageValue } from "./preflight-core.js";
import { metadataLayoutHash } from "./metadata-layout.js";

export type Observation<T> = { known: true; value: T } | { known: false; reason: string };
export interface AccountReadiness {
  address: string;
  block: { number: number; hash: Hex };
  native: Observation<{
    free: string;
    reserved: string;
    frozen: string;
    existentialDeposit: string;
  }>;
  assets: {
    assetId: string;
    balance: Observation<{ exists: boolean; balance: string; minBalance: string }>;
  }[];
}
type Entry = Parameters<typeof storageKey>[0] & {
  meta: { type: { isMap: boolean; asMap: { value: unknown }; asPlain: unknown } };
};
type NumberCodec = { toBigInt(): bigint };

/** Read-only balance observations at one finalized block. Estimates/signing stay with preflight and the wallet. */
export async function readAccountReadiness(
  send: RpcSend,
  facts: RuntimeFacts,
  address: string,
  assetIds: string[] = [],
): Promise<AccountReadiness> {
  if (!address || assetIds.length > 16 || assetIds.some((id) => !/^(0|[1-9]\d*)$/.test(id)))
    throw new Error("An account and at most 16 integer asset IDs are required.");
  const client = clientFromSend(send);
  const genesis = await rpc<Hex>(client, "chain_getBlockHash", [0]);
  if (genesis.toLowerCase() !== facts.fingerprint.genesisHash.toLowerCase())
    throw new Error("The balance reader is connected to a different chain.");
  const hash = await rpc<Hex>(client, "chain_getFinalizedHead", []);
  const header = await rpc<{ number: string } | null>(client, "chain_getHeader", [hash]);
  if (!header) throw new Error("The finalized block could not be read.");
  const [version, metadata] = await Promise.all([
    rpc<{ specName: string; specVersion: number; transactionVersion: number }>(
      client,
      "state_getRuntimeVersion",
      [hash],
    ),
    rpc<Hex>(client, "state_getMetadata", [hash]),
  ]);
  if (
    version.specName !== facts.fingerprint.specName ||
    version.specVersion !== facts.fingerprint.specVersion ||
    version.transactionVersion !== facts.fingerprint.transactionVersion ||
    metadataLayoutHash(metadata) !== metadataLayoutHash(facts.source.metadataHex)
  )
    throw new Error("The runtime changed. Read live facts again before checking balances.");
  const d = decodeRuntime(facts).decorated() as unknown as {
    query: { system?: { account?: Entry }; assets?: { asset?: Entry; account?: Entry } };
    consts: { balances?: { existentialDeposit?: NumberCodec } };
  };
  let native: AccountReadiness["native"];
  try {
    const entry = d.query.system?.account,
      ed = d.consts.balances?.existentialDeposit;
    if (!entry || !ed) throw new Error("The runtime does not expose the native account layout.");
    const account = (await readStorageValue(client, facts, entry, [address], hash)) as unknown as {
      data: Record<string, NumberCodec | undefined>;
    } | null;
    const free = account === null ? 0n : account.data.free?.toBigInt();
    if (free === undefined) throw new Error("The free balance could not be decoded.");
    native = {
      known: true,
      value: {
        free: String(free),
        reserved: String(account?.data.reserved?.toBigInt() ?? 0n),
        frozen: String(
          account?.data.frozen?.toBigInt() ?? account?.data.miscFrozen?.toBigInt() ?? 0n,
        ),
        existentialDeposit: String(ed.toBigInt()),
      },
    };
  } catch (error) {
    native = { known: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const assets: AccountReadiness["assets"] = [];
  for (const assetId of new Set(assetIds)) {
    try {
      const asset = d.query.assets?.asset,
        account = d.query.assets?.account;
      if (!asset || !account) throw new Error("This runtime does not expose Assets balances.");
      const info = await readStorageValue(client, facts, asset, [assetId], hash);
      const balance = info
        ? await readStorageValue(client, facts, account, [assetId, address], hash)
        : null;
      const amount = balance === null ? 0n : balance.balance?.toBigInt();
      if (amount === undefined || (info && !info.minBalance))
        throw new Error("The asset balance could not be decoded.");
      assets.push({
        assetId,
        balance: {
          known: true,
          value: {
            exists: !!info,
            balance: String(amount),
            minBalance: String(info?.minBalance.toBigInt() ?? 0n),
          },
        },
      });
    } catch (error) {
      assets.push({
        assetId,
        balance: { known: false, reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return { address, block: { hash, number: toSafeNumber(header.number) }, native, assets };
}
