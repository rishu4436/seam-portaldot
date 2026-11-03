import type { Hex, RuntimeFingerprint } from "@seam/compiler";
import type { ReceiptChainReader } from "./verify-live-core.js";
export * from "./verify-live-core.js";

/**
 * A ReceiptChainReader over a node, using @seam/chain's read functions. `facts` pins the runtime used to decode
 * extrinsics and events. Needs the optional @seam/chain package.
 */
export async function createChainReader(
  endpoint: string,
  facts: unknown,
): Promise<ReceiptChainReader> {
  const chain = await import("@seam/chain").catch(() => {
    throw new Error("live verification needs the @seam/chain package installed");
  });
  const call = <T>(method: string, params: unknown[]) =>
    chain.withClient(endpoint, (c) => c.send(method, params) as Promise<T>);
  return {
    async runtimeFingerprint() {
      return ((facts as { fingerprint?: RuntimeFingerprint } | null)?.fingerprint ??
        null) as RuntimeFingerprint | null;
    },
    async originalAccount(h160, at) {
      // Revive.OriginalAccount: StorageMap<Identity, H160, AccountId32>, so the key is
      // twox128("Revive") ++ twox128("OriginalAccount") ++ the raw 20 H160 bytes.
      if (!/^0x[0-9a-fA-F]{40}$/.test(h160)) throw new Error(`not an H160: ${h160}`);
      const { xxhashAsHex } = await import("@polkadot/util-crypto");
      const key =
        xxhashAsHex("Revive", 128) +
        xxhashAsHex("OriginalAccount", 128).slice(2) +
        h160.slice(2).toLowerCase();
      const block = at ?? (await call<string>("chain_getFinalizedHead", []));
      const v = await call<string | null>("state_getStorage", [key, block]);
      if (v === null || v === undefined) return null;
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v))
        throw new Error("Revive.OriginalAccount value is not a 32-byte AccountId");
      return v.toLowerCase() as Hex;
    },
    async finalizedNumber() {
      const head = await call<string>("chain_getFinalizedHead", []);
      const h = await call<{ number: string | number } | null>("chain_getHeader", [head]);
      if (!h) throw new Error("finalized header not found");
      return Number(h.number);
    },
    async canonicalHash(n) {
      return (await call<string | null>("chain_getBlockHash", [n])) as Hex | null;
    },
    async readTx(blockHash, txHash) {
      const block = await call<{ block: { extrinsics: string[] } } | null>("chain_getBlock", [
        blockHash,
      ]);
      if (!block) return null;
      const idx = block.block.extrinsics.findIndex(
        (x: string) => chain.extrinsicHash(x as Hex) === txHash.toLowerCase(),
      );
      if (idx < 0) return null;
      let signer: Hex | undefined, callHex: Hex | undefined, nonce: number | undefined;
      try {
        const sc = chain.extractSignedCall(
          block.block.extrinsics[idx]! as Hex,
          facts as import("@seam/compiler").RuntimeFacts,
        );
        signer = sc.signer.accountId;
        callHex = sc.callHex;
        nonce = Number.isInteger(sc.nonce) ? sc.nonce : undefined;
      } catch {
        /* unsigned or undecodable: left undefined, reported as unknown */
      }
      const inc = await chain.readEvents(
        endpoint,
        blockHash,
        idx,
        facts as import("@seam/compiler").RuntimeFacts,
      );
      return {
        extrinsicIndex: idx,
        signer,
        callHex,
        nonce,
        events: inc.events.map(chain.toChainEvent),
      };
    },
  };
}
