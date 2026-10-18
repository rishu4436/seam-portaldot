import type { ActionKind, Capability } from "./types.js";

/**
 * Metadata-driven argument-shape contracts for the two kinds whose runtime layout SEAM has never observed on a
 * real Portaldot V3 chain: revive.call and nfts.mint.
 *
 * This is NOT a call layout and holds no pallet/call indices. It states which argument NAMES (in order) and which
 * type CLASSES the compiler is able to fill. A step becomes executable only when the supplied facts observe the
 * capability AND the call's argument list, read from that metadata, matches the contract exactly. Anything else is
 * refused with V3_ARG_SHAPE_MISMATCH. Types are classified from the metadata's own type registry (toRawType), never
 * assumed.
 */
export type ShapeClass =
  | "h160" // contract address: H160 / [u8;20]
  | "account" // native account: AccountId32 / [u8;32] / MultiAddress (Id variant)
  | "balance" // Compact<u64|u128> or u64|u128
  | "optBalance" // balance, or Option<balance>
  | "weight" // Weight v2 { refTime, proofSize } or a single u64 (v1)
  | "bytes" // Bytes / Vec<u8>
  | "id" // Compact<uN> or uN (collection / item ids)
  | "optionNone"; // Option<..>: SEAM always supplies None (it never invents a witness)

export interface ShapeArg {
  /** camelCased metadata argument name. */
  name: string;
  class: ShapeClass;
  /** Manifest/encode key that feeds it. '__none' means "encode None"; the manifest has no such input. */
  seamKey: string;
}

export const V3_SHAPES: Partial<Record<ActionKind, readonly ShapeArg[]>> = {
  "revive.call": [
    { name: "dest", class: "h160", seamKey: "contract" },
    { name: "value", class: "balance", seamKey: "value" },
    { name: "gasLimit", class: "weight", seamKey: "gasLimit" },
    { name: "storageDepositLimit", class: "optBalance", seamKey: "storageDepositLimit" },
    { name: "data", class: "bytes", seamKey: "data" },
  ],
  "nfts.mint": [
    { name: "collection", class: "id", seamKey: "collection" },
    { name: "item", class: "id", seamKey: "item" },
    { name: "mintTo", class: "account", seamKey: "recipient" },
    { name: "witnessData", class: "optionNone", seamKey: "__none" },
  ],
};

export const V3_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["revive.call", "nfts.mint"]);

const UINT = /^u(8|16|32|64|128)$/;
const BALANCE = /^u(64|128)$/;
const stripCompact = (t: string) => t.replace(/^Compact<(.+)>$/, "$1");

/** Whether the metadata-derived raw type satisfies a shape class. Weight v2 is detected by the caller's JSON check. */
export function matchesClass(cls: ShapeClass, rawType: string, isWeightV2: boolean): boolean {
  switch (cls) {
    case "h160":
      return rawType === "H160" || rawType === "[u8;20]";
    case "account":
      return (
        rawType === "AccountId32" ||
        rawType === "[u8;32]" ||
        rawType === "AccountId" ||
        rawType.includes('"Id":"AccountId"')
      );
    case "balance":
      return BALANCE.test(stripCompact(rawType));
    case "optBalance": {
      const inner = rawType.replace(/^Option<(.+)>$/, "$1");
      return BALANCE.test(stripCompact(inner));
    }
    case "weight":
      return isWeightV2 || /^u64$/.test(stripCompact(rawType));
    case "bytes":
      return rawType === "Bytes" || rawType === "Vec<u8>";
    case "id":
      return UINT.test(stripCompact(rawType));
    case "optionNone":
      return /^Option</.test(rawType);
  }
}

/**
 * Returns undefined when the observed argument list satisfies the contract for `kind`, else a human reason.
 * `args` are the metadata arguments in order, with camelCased names and raw (registry-derived) types.
 */
export function checkV3Shape(
  kind: ActionKind,
  cap: Capability,
  metadataVersion: number,
  args: { name: string; rawType: string; isWeightV2: boolean }[],
): string | undefined {
  const shape = V3_SHAPES[kind];
  if (!shape) return `no argument-shape contract exists for ${kind}`;
  if (metadataVersion < 14)
    return `metadata V${metadataVersion} is not self-describing, so the argument types cannot be verified`;
  if (cap.argTypesConfidence !== "full")
    return "the facts do not carry fully-resolved argument types for this call";
  const observed = args.map((a) => `${a.name}: ${a.rawType}`).join(", ");
  if (args.length !== shape.length) {
    return `expected ${shape.length} arguments (${shape.map((s) => s.name).join(", ")}), metadata has ${args.length} (${observed})`;
  }
  for (let i = 0; i < shape.length; i++) {
    const want = shape[i]!;
    const got = args[i]!;
    if (got.name !== want.name) {
      return `argument ${i} should be "${want.name}" (${want.class}), metadata has "${got.name}" (${observed})`;
    }
    if (!matchesClass(want.class, got.rawType, got.isWeightV2)) {
      return `argument "${want.name}" should be ${want.class}, metadata has ${got.rawType} (${observed})`;
    }
  }
  return undefined;
}
