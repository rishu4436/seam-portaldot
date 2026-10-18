// Pure helpers for the Risk limits panel. Field names follow packages/policy/src/policy.ts (Policy) and
// packages/policy/src/compilerTypes.ts / packages/compiler/src/types.ts (RuntimeBehaviour, AtomicRollbackProof).
// Nothing is invented: a limit the policy does not set is shown as "not set", and no policy at all is "not provided".

export interface PolicyLike {
  allowedCapabilities?: string[] | "any";
  allowedAssets?: string[] | "any";
  allowedContracts?: string[] | "any";
  allowedRecipients?: string[] | "any";
  maxAmountPerAsset?: Record<string, string>;
  maxNativeValue?: string;
  maxGasLimit?: string;
  maxWeight?: string;
  maxProofSize?: string;
  maxFee?: string;
  maxStorageDeposit?: string;
  maxSteps?: number;
  allowedModes?: string[];
  requireHumanApproval?: boolean;
  maxApprovalSeconds?: number;
  requireSignedDryRun?: boolean;
  allowUnknown?: Record<string, boolean | undefined>;
}
export interface LimitRow {
  key: string;
  label: string;
  value: string;
  set: boolean;
}
export interface LimitGroup {
  title: string;
  rows: LimitRow[];
}

const list = (v: unknown): string =>
  v === "any"
    ? "any (no restriction)"
    : Array.isArray(v)
      ? v.length
        ? v.join(", ")
        : "none allowed"
      : "not set";
const num = (v: unknown): string => (v == null ? "not set" : String(v));

export function pallets(caps: unknown): string[] {
  if (!Array.isArray(caps)) return [];
  return [...new Set(caps.map((c) => String(c).split(".")[0]))];
}

export function policyLimitGroups(p?: PolicyLike): LimitGroup[] | undefined {
  if (!p) return undefined;
  const row = (key: string, label: string, value: string): LimitRow => ({
    key,
    label,
    value,
    set: value !== "not set",
  });
  const per = p.maxAmountPerAsset
    ? Object.entries(p.maxAmountPerAsset)
        .map(([k, v]) => `${k === "*" ? "any other asset" : "asset " + k}: ${v}`)
        .join("; ")
    : "not set";
  const unk = p.allowUnknown
    ? Object.entries(p.allowUnknown)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "none (unknowns block)"
    : "not set";
  return [
    {
      title: "Allowed",
      rows: [
        row("allowedCapabilities", "Capabilities", list(p.allowedCapabilities)),
        row(
          "pallets",
          "Pallets (from capabilities)",
          p.allowedCapabilities === "any"
            ? "any"
            : pallets(p.allowedCapabilities).join(", ") || "none",
        ),
        row("allowedAssets", "Assets", list(p.allowedAssets)),
        row("allowedContracts", "Contracts", list(p.allowedContracts)),
        row("allowedRecipients", "Recipients", list(p.allowedRecipients)),
        row("allowedModes", "Plan modes", list(p.allowedModes)),
      ],
    },
    {
      title: "Caps",
      rows: [
        row("maxAmountPerAsset", "Max amount per asset", per),
        row("maxNativeValue", "Max native value", num(p.maxNativeValue)),
        row("maxGasLimit", "Max gas limit", num(p.maxGasLimit)),
        row("maxStorageDeposit", "Max storage deposit", num(p.maxStorageDeposit)),
        row("maxSteps", "Max steps", num(p.maxSteps)),
      ],
    },
    {
      title: "Fee and weight ceilings",
      rows: [
        row("maxFee", "Max fee", num(p.maxFee)),
        row("maxWeight", "Max weight (refTime)", num(p.maxWeight)),
        row("maxProofSize", "Max proof size", num(p.maxProofSize)),
      ],
    },
    {
      title: "Controls",
      rows: [
        row(
          "requireHumanApproval",
          "Human approval required",
          p.requireHumanApproval == null ? "not set" : p.requireHumanApproval ? "yes" : "no",
        ),
        row("maxApprovalSeconds", "Approval lifetime (s)", num(p.maxApprovalSeconds)),
        row(
          "requireSignedDryRun",
          "Signed dry run required",
          p.requireSignedDryRun == null ? "not set" : p.requireSignedDryRun ? "yes" : "no",
        ),
        row("allowUnknown", "Unknowns allowed to pass", unk),
      ],
    },
  ];
}

export interface RollbackProofLike {
  genesisHash?: string;
  metadataHash?: string;
  specVersion?: number;
  txHash?: string;
  blockHash?: string;
  fingerprintDigest?: string;
}
export interface BehaviourLike {
  batchAllRollback?: string;
  batchAllRollbackProof?: RollbackProofLike;
}
export type AtomicitySource = {
  status: "atomic_verified" | "not_proven";
  label: string;
  detail: string;
  missing: string[];
  proof?: RollbackProofLike;
};

/** atomic_verified only with a proof carrying genesisHash, metadataHash, specVersion and a txHash or blockHash. */
export function atomicitySource(b?: BehaviourLike): AtomicitySource {
  const p = b?.batchAllRollbackProof;
  if (!p) {
    const claimed = b?.batchAllRollback === "verified";
    return {
      status: "not_proven",
      label: "Atomicity: not proven",
      missing: ["batchAllRollbackProof"],
      detail: claimed
        ? 'A verdict of "verified" was recorded, but no batchAllRollbackProof (genesis, metadata hash, spec version, tx or block hash) is attached here, so it is not shown as proven.'
        : "No batchAllRollbackProof was provided.",
    };
  }
  const missing: string[] = [];
  if (!p.genesisHash) missing.push("genesisHash");
  if (!p.metadataHash) missing.push("metadataHash");
  if (typeof p.specVersion !== "number") missing.push("specVersion");
  if (!p.txHash && !p.blockHash) missing.push("txHash or blockHash");
  if (missing.length)
    return {
      status: "not_proven",
      label: "Atomicity: not proven",
      missing,
      detail: `The proof is incomplete: missing ${missing.join(", ")}.`,
      proof: p,
    };
  return {
    status: "atomic_verified",
    label: "Atomicity: verified by rollback proof",
    missing: [],
    detail: "A failing batch_all was observed on this runtime and left no effects.",
    proof: p,
  };
}
