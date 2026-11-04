import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { StorageKey } from "@polkadot/types";
import { u8aToHex } from "@polkadot/util";
import { clientFromSend, rpc, toSafeNumber, type RpcSend } from "./rpc-core.js";
import { decodeRuntime, storageKey } from "./runtime.js";
import { readStorageValue } from "./storage-read.js";
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
    providers?: number;
  }>;
  assets: {
    assetId: string;
    balance: Observation<{
      exists: boolean;
      balance: string;
      minBalance: string;
      isSufficient?: boolean;
      accountExists?: boolean;
    }>;
  }[];
  discovery?: { complete: boolean; scanned: number; nextCursor?: string; reason?: string };
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
  options: { discover?: boolean; after?: string; at?: Hex; pageSize?: number } = {},
): Promise<AccountReadiness> {
  if (!address || assetIds.length > 16 || assetIds.some((id) => !/^(0|[1-9]\d*)$/.test(id)))
    throw new Error("An account and at most 16 integer asset IDs are required.");
  const client = clientFromSend(send);
  const genesis = await rpc<Hex>(client, "chain_getBlockHash", [0]);
  if (genesis.toLowerCase() !== facts.fingerprint.genesisHash.toLowerCase())
    throw new Error("The balance reader is connected to a different chain.");
  const hash = options.at ?? (await rpc<Hex>(client, "chain_getFinalizedHead", []));
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
      providers?: NumberCodec;
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
        ...(account === null
          ? { providers: 0 }
          : account.providers
            ? { providers: Number(account.providers.toBigInt()) }
            : {}),
      },
    };
  } catch (error) {
    native = { known: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const discovered: string[] = [];
  let discovery: AccountReadiness["discovery"];
  if (options.discover) {
    try {
      const pageSize = options.pageSize ?? 32;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 32)
        throw new Error("Discovery pages contain at most 32 assets.");
      const asset = d.query.assets?.asset as (Entry & { keyPrefix(): Uint8Array }) | undefined;
      if (!asset) throw new Error("Asset discovery is unavailable on this runtime.");
      const prefix = u8aToHex(asset.keyPrefix()).toLowerCase();
      if (
        options.after &&
        (!/^0x[0-9a-f]+$/i.test(options.after) ||
          !options.after.toLowerCase().startsWith(prefix) ||
          options.after.length > 256)
      )
        throw new Error("Invalid asset discovery cursor.");
      const keys = await rpc<unknown>(client, "state_getKeysPaged", [
        prefix,
        pageSize,
        options.after ?? null,
        hash,
      ]);
      if (!Array.isArray(keys) || keys.length > pageSize)
        throw new Error("Invalid asset discovery response.");
      let previous = options.after?.toLowerCase() ?? prefix;
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          !/^0x[0-9a-f]+$/i.test(key) ||
          !key.toLowerCase().startsWith(prefix) ||
          key.toLowerCase() <= previous ||
          key.length > 256
        )
          throw new Error("Asset discovery returned invalid or repeated keys.");
        const decoded = new StorageKey(decodeRuntime(facts).registry, key).setMeta(
          asset.meta as never,
        );
        const id = decoded.args[0]?.toString();
        if (
          !id ||
          !/^(0|[1-9]\d*)$/.test(id) ||
          storageKey(asset, id).toLowerCase() !== key.toLowerCase()
        )
          throw new Error("An asset storage key could not be decoded safely.");
        discovered.push(id);
        previous = key.toLowerCase();
      }
      discovery = {
        complete: keys.length < pageSize,
        scanned: keys.length,
        ...(keys.length === pageSize ? { nextCursor: previous } : {}),
      };
    } catch (error) {
      discovered.length = 0;
      discovery = {
        complete: false,
        scanned: 0,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const assets: AccountReadiness["assets"] = [];
  const ids = [...new Set([...assetIds, ...discovered])];
  const readAsset = async (assetId: string) => {
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
      const sufficient = (
        info as unknown as { isSufficient?: { toJSON(): unknown } } | null
      )?.isSufficient?.toJSON();
      assets.push({
        assetId,
        balance: {
          known: true,
          value: {
            exists: !!info,
            balance: String(amount),
            minBalance: String(info?.minBalance.toBigInt() ?? 0n),
            ...(typeof sufficient === "boolean" ? { isSufficient: sufficient } : {}),
            accountExists: balance !== null,
          },
        },
      });
    } catch (error) {
      assets.push({
        assetId,
        balance: { known: false, reason: error instanceof Error ? error.message : String(error) },
      });
    }
  };
  for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(readAsset));
  assets.sort((a, b) => (BigInt(a.assetId) < BigInt(b.assetId) ? -1 : 1));
  return {
    address,
    block: { hash, number: toSafeNumber(header.number) },
    native,
    assets: assets.filter(
      (a) =>
        assetIds.includes(a.assetId) || !a.balance.known || BigInt(a.balance.value.balance) > 0n,
    ),
    ...(discovery ? { discovery } : {}),
  };
}
