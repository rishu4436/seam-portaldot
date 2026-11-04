import type { Hex, RuntimeFacts } from "@seam/compiler/facts";
import { readAccountReadiness, type AccountReadiness } from "./account-readiness.js";
import type { RpcSend } from "./rpc-core.js";

export interface RecipientReadiness {
  status: "ready" | "needs_funding" | "blocked" | "unknown";
  message: string;
  nativeShortfall?: string;
  block: AccountReadiness["block"];
}

export function assessRecipientReadiness(
  observed: AccountReadiness,
  assetId: string,
  amount: string,
): RecipientReadiness {
  const result = (status: RecipientReadiness["status"], message: string): RecipientReadiness => ({
    status,
    message,
    block: observed.block,
  });
  if (!/^[1-9]\d*$/.test(amount))
    return result("unknown", "Enter a positive amount in asset base units.");
  const asset = observed.assets.find((a) => a.assetId === assetId)?.balance;
  if (!asset?.known)
    return result(
      "unknown",
      "The recipient's asset requirements could not be read. Retry the check.",
    );
  if (!asset.value.exists)
    return result("blocked", `Asset ${assetId} does not exist on this network.`);
  if (BigInt(asset.value.balance) + BigInt(amount) < BigInt(asset.value.minBalance))
    return result(
      "blocked",
      `The recipient would hold less than the asset minimum of ${asset.value.minBalance} base units. Increase the amount.`,
    );
  if (asset.value.isSufficient === true || asset.value.accountExists)
    return result(
      "ready",
      "The recipient meets this asset's account and minimum-balance requirements at the checked block.",
    );
  if (
    asset.value.isSufficient === undefined ||
    !observed.native.known ||
    observed.native.value.providers === undefined
  )
    return result(
      "unknown",
      "Recipient account requirements are unavailable. No readiness is assumed.",
    );
  if (observed.native.value.providers > 0)
    return result(
      "ready",
      "The recipient has an existing provider account for this asset. Fees are paid by the sender.",
    );
  const minimum = BigInt(observed.native.value.existentialDeposit),
    free = BigInt(observed.native.value.free);
  return {
    ...result(
      "needs_funding",
      "This asset is not self-sufficient. Fund the recipient with native tPOT before signing so its account can hold the asset.",
    ),
    nativeShortfall: String(minimum > free ? minimum - free : 0n),
  };
}

/** Account readiness, never execution proof. The signed dry run remains authoritative. */
export async function readRecipientReadiness(
  send: RpcSend,
  facts: RuntimeFacts,
  recipient: string,
  assetId: string,
  amount: string,
  at?: Hex,
): Promise<RecipientReadiness> {
  const observed = await readAccountReadiness(send, facts, recipient, [assetId], { at });
  return assessRecipientReadiness(observed, assetId, amount);
}
