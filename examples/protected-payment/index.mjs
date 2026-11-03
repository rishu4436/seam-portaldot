// Importable Node integration. Preparing is read-only; execute is an explicit separate call.
// The application provides its chain adapter, external wallet and current block/nonce readers.
import { Seam, action, defineManifest, explainPlan, prepareEvidenceBundle } from "@seam/sdk";
import { portaldotPolicy } from "@seam/policy";
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
/** @param {{adapter: import('@seam/sdk').ChainAdapter, journalPath: string, signer: import('@seam/compiler').ManifestSigner, recipient: string, assetId: string, amount: string, maxFee: string}} options */
export async function preparePayment({
  adapter,
  journalPath,
  signer,
  recipient,
  assetId,
  amount,
  maxFee,
}) {
  if (!journalPath)
    throw new Error("Supply a durable approval journal path for duplicate-send protection.");
  if (
    ![amount, maxFee, assetId].every(
      (value) => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value),
    ) ||
    BigInt(amount) === 0n
  )
    throw new Error("Use positive payment amounts and integer base-unit strings.");
  const seam = new Seam(adapter, journalPath);
  const facts = await seam.discover();
  if (facts.fingerprint.genesisHash !== V3_GENESIS || facts.fingerprint.specName !== "portaldot-v3")
    throw new Error("This integration is restricted to Portaldot V3 testnet.");
  const manifest = defineManifest({
    chain: { genesisHash: V3_GENESIS, specVersion: facts.fingerprint.specVersion },
    signer,
    actions: [action.transfer("payment", { assetId, amount, recipient })],
  });
  const policy = portaldotPolicy({
    allowedCapabilities: ["Assets.transfer_keep_alive"],
    allowedAssets: [assetId],
    allowedRecipients: [recipient],
    maxAmountPerAsset: { [assetId]: amount },
    maxNativeValue: "0",
    maxFee,
    maxSteps: 1,
    allowedModes: ["sequential"],
    requireSignedDryRun: true,
  });
  const prepared = await seam.prepare(manifest, facts, policy);
  return { seam, facts, manifest, policy, ...prepared, review: explainPlan(prepared.plan) };
}
/**
 * @param {Awaited<ReturnType<typeof preparePayment>>} prepared
 * @param {{reviewedPlanDigest: import('@seam/compiler').Hex, wallet: import('@seam/sdk').WalletSigner, live: {currentBlockNumber: () => number | Promise<number>, currentAccountNonce: () => number | Promise<number>}, onStep?: (event: import('@seam/sdk').StepEvent) => void}} options
 */
export async function executeReviewedPayment(
  prepared,
  { reviewedPlanDigest, wallet, live, onStep },
) {
  if (reviewedPlanDigest !== prepared.plan.planDigest)
    throw new Error("Present and explicitly approve the exact plan digest before execution.");
  if (!live?.currentBlockNumber || !live?.currentAccountNonce)
    throw new Error("Live block and nonce readers are required.");
  const { seam, facts, manifest, policy, plan, preflight, envelope, policyResult, compileOptions } =
    prepared;
  const approval = seam.approve({
    facts,
    manifest,
    policy,
    plan,
    preflight,
    envelope,
    policyResult,
    compileOptions,
    requirePlanVerified: true,
  });
  if (!approval.ok) return { ok: false, stage: "approval", reason: approval.reason };
  const result = await seam.execute({
    facts,
    manifest,
    policy,
    plan,
    preflight,
    envelope,
    policyResult,
    compileOptions,
    approval: approval.approval,
    wallet,
    live,
    onStep,
  });
  return {
    ...result,
    ...(result.ok
      ? {
          evidence: prepareEvidenceBundle({
            plan,
            manifest,
            runtime: facts.fingerprint,
            receipt: result.receipt,
          }),
        }
      : {}),
  };
}
