import {
  computePlanDigest,
  computeManifestDigest,
  computeFingerprintDigest,
  type Plan,
  type Manifest,
  type RuntimeFingerprint,
  type CompileOptions,
} from "@seam/compiler/browser";
import {
  isConsoleReceipt,
  verifyConsoleReceiptOffline,
  type ConsoleReceipt,
  type ConsoleCheck,
} from "./console-receipt.js";
import { checkReceipt, receiptShapeProblem, type Receipt, type ContractEffect } from "./receipt.js";

export interface EvidenceBundle {
  bundleVersion: 1;
  createdAt: string;
  receipt: Receipt | ConsoleReceipt;
  plan: Plan;
  manifest?: Manifest;
  runtime?: RuntimeFingerprint;
  effects?: Record<string, ContractEffect>;
  abis?: CompileOptions["abis"];
}
export interface EvidenceInspection {
  status: "integrity_checked" | "unknown" | "failed";
  checks: ConsoleCheck[];
  summary: { actions: number; mode: string; signer: string; claimedResult: string };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const secret =
  /^(?:__proto__|prototype|constructor|seed|mnemonic|suri|privateKey|secret|authorization|accessKey|signedTx|signedExtrinsics?|signedBytes|signature|metadataHex|preparedMetadataHex|currentMetadataHex)$/i;

/** A portable, secret-free record. Input may be an SDK run, console receipt, or an exported bundle. */
export function prepareEvidenceBundle(input: unknown): EvidenceBundle {
  if (!object(input)) throw new Error("Choose a SEAM receipt, run recording, or evidence bundle.");
  const nested = (key: string) =>
    object(input[key]) ? (input[key] as Record<string, unknown>) : undefined;
  const receipt =
    input.bundleVersion === 1
      ? input.receipt
      : input.receiptVersion === 1 || isConsoleReceipt(input)
        ? input
        : (nested("nftVerdictReceipt")?.receipt ?? nested("run")?.receipt ?? input.receipt);
  if (!object(receipt) || !(receipt.receiptVersion === 1 || isConsoleReceipt(receipt)))
    throw new Error("No supported SEAM receipt was found in this file.");
  const approval = object(receipt.approvalInputs) ? receipt.approvalInputs : undefined;
  const plan = input.plan ?? receipt.plan;
  if (
    !object(plan) ||
    !Array.isArray(plan.steps) ||
    plan.steps.length < 1 ||
    plan.steps.length > 16
  )
    throw new Error("The evidence needs the compiled plan, with 1–16 actions.");
  if (
    typeof plan.mode !== "string" ||
    !object(plan.signer) ||
    typeof plan.signer.value !== "string" ||
    typeof receipt.planDigest !== "string" ||
    typeof receipt.fingerprintDigest !== "string"
  )
    throw new Error("The receipt or compiled plan has an invalid structure.");
  const runtime =
    input.runtime ??
    (object(input.facts) ? input.facts.fingerprint : undefined) ??
    approval?.fingerprint;
  const manifest = input.manifest ?? approval?.manifest;
  const bundle = {
    bundleVersion: 1,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    receipt,
    plan,
    ...(manifest ? { manifest } : {}),
    ...(runtime ? { runtime } : {}),
    ...(input.effects ? { effects: input.effects } : {}),
    ...(input.abis ? { abis: input.abis } : {}),
  } as unknown as EvidenceBundle;
  const stack: { value: unknown; depth: number }[] = [{ value: bundle, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++visited > 20000 || depth > 24)
      throw new Error("This evidence is too complex to import safely.");
    if (typeof value === "string" && /^seam_(root|key)_/.test(value))
      throw new Error("Access keys must not appear in evidence.");
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (secret.test(key))
          throw new Error(
            `Evidence includes a secret-bearing field (${key}). Use a receipt export without signed bytes or raw metadata.`,
          );
        stack.push({ value: item, depth: depth + 1 });
      }
  }
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 512 * 1024)
    throw new Error("Portable evidence must fit within 512 KiB.");
  return bundle;
}

/** Self-consistency only; this function never contacts a node or claims chain verification. */
export function inspectEvidenceBundle(bundle: EvidenceBundle): EvidenceInspection {
  const checks: ConsoleCheck[] = [];
  const add = (check: string, pass: boolean, detail: string) =>
    checks.push({ check, status: pass ? "pass" : "fail", detail });
  try {
    add(
      "plan_digest",
      computePlanDigest(bundle.plan) === bundle.plan.planDigest,
      "The complete plan must match its digest.",
    );
    add(
      "receipt_plan_binding",
      bundle.receipt.planDigest === bundle.plan.planDigest,
      "The receipt and supplied plan must refer to the same intent.",
    );
    if (isConsoleReceipt(bundle.receipt)) {
      checks.push(...verifyConsoleReceiptOffline(bundle.receipt).checks);
      add(
        "embedded_plan",
        !!bundle.receipt.plan && computePlanDigest(bundle.receipt.plan) === bundle.plan.planDigest,
        "The embedded console plan must match the portable plan.",
      );
    } else {
      const shape = receiptShapeProblem(bundle.receipt);
      add(
        "receipt_integrity",
        !shape && checkReceipt(bundle.receipt),
        shape ?? "The receipt digest must match its contents.",
      );
    }
    if (bundle.manifest)
      add(
        "manifest_binding",
        computeManifestDigest(bundle.manifest) === bundle.plan.manifestDigest,
        "The manifest must match the plan's manifest digest.",
      );
    else
      checks.push({
        check: "manifest_binding",
        status: "not_checked",
        detail: "No manifest was included. Intent recompilation is unavailable.",
      });
    if (bundle.runtime)
      add(
        "runtime_binding",
        computeFingerprintDigest(bundle.runtime) === bundle.receipt.fingerprintDigest,
        "The runtime fingerprint must match the receipt.",
      );
  } catch (error) {
    checks.push({
      check: "structure",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    status: checks.some((c) => c.status === "fail")
      ? "failed"
      : checks.some((c) => c.status === "unknown")
        ? "unknown"
        : "integrity_checked",
    checks,
    summary: {
      actions: bundle.plan.steps.length,
      mode: bundle.plan.mode,
      signer: bundle.plan.signer?.value ?? "unknown",
      claimedResult: String(bundle.receipt.result ?? "unknown"),
    },
  };
}
