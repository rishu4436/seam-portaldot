// Read-only effect check for a finalized LIVE assets.transfer: re-reads the block and its System.Events at that block
// and accepts only if the extrinsic with this hash succeeded and emitted Assets.Transferred with the planned asset,
// signer, recipient and amount. Anything missing or different is "not verified", never success. No signing, no writes.
import { Metadata, TypeRegistry } from "@polkadot/types";
import { blake2AsHex, xxhashAsHex } from "@polkadot/util-crypto";
import type { RpcTransport } from "./chainclient";

export interface TransferExpectation {
  assetId: string;
  from: string; // ss58 or 0x public key
  to: string;
  amount: string;
}
export type EffectVerdict =
  | {
      verdict: "effect_proven";
      extrinsicIndex: number;
      /** Set by the verifyStep-based check (any step kind): its plain-language reason. */
      reason?: string;
      event: Record<string, string>;
      checkedAt: string;
    }
  | { verdict: "not_verified"; reason: string; checkedAt: string };

const EVENTS_KEY = xxhashAsHex("System", 128) + xxhashAsHex("Events", 128).slice(2);

export async function checkAssetsTransferEffect(
  rpc: RpcTransport,
  txHash: string,
  blockHash: string,
  want: TransferExpectation,
): Promise<EffectVerdict> {
  const at = new Date().toISOString();
  const no = (reason: string): EffectVerdict => ({
    verdict: "not_verified",
    reason,
    checkedAt: at,
  });
  try {
    const block = (await rpc("chain_getBlock", [blockHash])) as {
      block?: { extrinsics?: string[] };
    } | null;
    const xts = block?.block?.extrinsics ?? [];
    const idx = xts.findIndex((x) => blake2AsHex(x).toLowerCase() === txHash.toLowerCase());
    if (idx < 0) return no("The transaction hash is not in that block.");
    const metaHex = (await rpc("state_getMetadata", [blockHash])) as string;
    const evHex = (await rpc("state_getStorage", [EVENTS_KEY, blockHash])) as string | null;
    if (!metaHex || !evHex) return no("Could not read metadata or events at that block.");
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, metaHex as `0x${string}`);
    registry.setMetadata(metadata);
    const records = registry.createType("Vec<FrameSystemEventRecord>", evHex) as unknown as Array<{
      phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
      event: { section: string; method: string; data: Array<{ toString(): string }> };
    }>;
    const mine = records.filter(
      (r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === idx,
    );
    if (mine.some((r) => r.event.section === "system" && r.event.method === "ExtrinsicFailed"))
      return no("The extrinsic failed on chain (System.ExtrinsicFailed).");
    if (!mine.some((r) => r.event.section === "system" && r.event.method === "ExtrinsicSuccess"))
      return no("No System.ExtrinsicSuccess event for this extrinsic.");
    const acct = (a: string) => registry.createType("AccountId32", a).toHex();
    const ev = mine.find((r) => r.event.section === "assets" && r.event.method === "Transferred");
    if (!ev) return no("No Assets.Transferred event for this extrinsic.");
    const [assetId, from, to, amount] = ev.event.data.map((d) => d.toString());
    const got = { assetId, from, to, amount };
    if (assetId !== want.assetId)
      return no(`Asset ${assetId} differs from the planned ${want.assetId}.`);
    if (acct(from) !== acct(want.from)) return no("The sender differs from the plan's signer.");
    if (acct(to) !== acct(want.to)) return no("The recipient differs from the plan's recipient.");
    if (BigInt(amount) !== BigInt(want.amount))
      return no(`Amount ${amount} differs from the planned ${want.amount}.`);
    return { verdict: "effect_proven", extrinsicIndex: idx, event: got, checkedAt: at };
  } catch (e) {
    return no(`Effect check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
