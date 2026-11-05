import { blake2AsHex } from "@polkadot/util-crypto";
import {
  assembleSignedExtrinsic,
  clientFromSend,
  dryRunOne,
  nativeSwapSigningRequest,
  recheckNativeSwap,
  verifySignedAgainstRequest,
  type NativeSwapPlan,
  type RpcSend,
} from "@seam/chain/browser";
import { browserExclusive, JOURNAL_LOCK, type Exclusive } from "@seam/defi";
import { NativeSwapStore, type NativeSwapRow } from "./native-swap-store";
export async function submitNativeSwap(args: {
  send: RpcSend;
  plan: NativeSwapPlan;
  store: NativeSwapStore;
  sign: (payload: unknown) => Promise<{ signature: string }>;
  assertAccount: () => Promise<void>;
  notify?: (text: string) => void;
  exclusive?: Exclusive;
}) {
  return (args.exclusive ?? browserExclusive)(JOURNAL_LOCK, async () => {
    const { send, plan, store, notify = () => {} } = args;
    store.assertReady(plan.id);
    const ctx = await recheckNativeSwap(send, plan),
      request = nativeSwapSigningRequest(ctx, plan);
    await args.assertAccount();
    if (Date.now() >= plan.expiresAt)
      throw Error("The quote expired before the wallet request. Read a new quote.");
    const record: NativeSwapRow = { plan, state: "signing" };
    store.save(record);
    let signed: `0x${string}`;
    try {
      notify("Review the native swap in your wallet. Signing alone does not submit it.");
      const signature = await args.sign(request.payload);
      signed = assembleSignedExtrinsic(request.payload, signature.signature, ctx.facts);
      if (!verifySignedAgainstRequest(signed, request, { facts: ctx.facts }).ok)
        throw Error("The signed bytes do not match the approved swap.");
      notify("Checking the signed transaction before submission…");
      await recheckNativeSwap(send, plan, Date.now(), signed);
      const dry = await dryRunOne(clientFromSend(send), ctx.facts, signed, 0);
      if (dry.outcome !== "ok")
        throw Error(`The signed dry run did not pass: ${dry.detail}. Nothing was submitted.`);
      await args.assertAccount();
      // Recheck after the dry run too: long wallet/RPC waits must not outlive the approved quote.
      if (Date.now() >= plan.expiresAt)
        throw Error("The quote expired while checking the signature. Nothing was submitted.");
      store.assertReady(plan.id, true);
    } catch (error) {
      store.save({
        ...record,
        state: "not_sent",
        note: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const txHash = blake2AsHex(signed, 256);
    record.hash = txHash;
    record.state = "submitted";
    // Persist the locally computed hash BEFORE the one and only broadcast. Never persist signed bytes.
    store.save(record);
    notify("Submitting once. Waiting for finalized execution evidence…");
    try {
      const result = await send("author_submitExtrinsic", [signed]);
      if (result !== txHash) throw Error("The node did not confirm the expected transaction hash.");
    } catch (error) {
      store.save({
        ...record,
        state: "uncertain",
        note: "The submit response was lost or refused. Recover by hash; do not resend.",
      });
      throw error;
    }
    return record;
  });
}
