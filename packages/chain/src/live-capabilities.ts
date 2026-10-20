import { stringCamelCase } from "@polkadot/util";
import {
  computeFingerprintDigest,
  type Capability,
  type Hex,
  type RuntimeFacts,
  type RuntimeFingerprint,
  type StepReasonCode,
} from "@seam/compiler/facts";
import { SeamChainError } from "./errors.js";
import { factsFromChainInputs, pinnedInputs, type FactsOptions } from "./facts-core.js";
import { metadataLayoutHash } from "./metadata-layout.js";
import { quietly } from "./quiet.js";
import { loadRuntimeCore } from "./runtime-core.js";
import type { BlockRef, ChainInputs } from "./types.js";

/**
 * Live capabilities (browser-safe, read-only): for each SEAM action kind, whether the connected runtime supports it,
 * read from that runtime's own metadata. Indices, argument names and types come only from the metadata; nothing is
 * guessed. A missing pallet or call, an argument list that differs from what SEAM encodes, or types that cannot be
 * resolved make the action unsupported, with a machine-readable code. The shapes mirror @seam/compiler (V3_SHAPES in
 * v3-bindings.ts and ARG_BINDINGS in compile.ts); tests/live-capabilities.test.ts keeps them identical and checks every
 * verdict against the compiler itself.
 */

export const SEAM_ACTION_KINDS = [
  "assets.transfer",
  "assets.mint",
  "nfts.mint",
  "contracts.call",
  "revive.call",
  "revive.instantiate_with_code",
  "revive.map_account",
] as const;
export type SeamActionKind = (typeof SEAM_ACTION_KINDS)[number];

/** Same mapping as @seam/compiler KIND_TO_CAPABILITY. */
export const ACTION_CAPABILITY: Record<SeamActionKind, string> = {
  "assets.transfer": "Assets.transfer_keep_alive",
  "assets.mint": "Assets.mint",
  "nfts.mint": "Nfts.mint",
  "contracts.call": "Contracts.call",
  "revive.call": "Revive.call",
  "revive.instantiate_with_code": "Revive.instantiate_with_code",
  "revive.map_account": "Revive.map_account",
};

export type ArgClass =
  | "h160"
  | "account"
  | "balance"
  | "optBalance"
  | "weight"
  | "bytes"
  | "id"
  | "optSalt"
  | "optionNone";

/** Expected argument list per kind: camelCased metadata names (with accepted aliases) and type classes. */
export const ACTION_SHAPES: Record<
  SeamActionKind,
  readonly { name: string; class: ArgClass; aliases?: readonly string[]; optional?: boolean }[]
> = {
  "assets.transfer": [
    { name: "id", class: "id" },
    { name: "target", class: "account" },
    { name: "amount", class: "balance" },
  ],
  "assets.mint": [
    { name: "id", class: "id" },
    { name: "beneficiary", class: "account" },
    { name: "amount", class: "balance" },
  ],
  "nfts.mint": [
    { name: "collection", class: "id" },
    { name: "item", class: "id" },
    { name: "mintTo", class: "account" },
    { name: "witnessData", class: "optionNone" },
  ],
  "contracts.call": [
    { name: "dest", class: "account" },
    { name: "value", class: "balance" },
    { name: "gasLimit", class: "weight" },
    // Older pallet-contracts (e.g. Portaldot mainnet spec 1002) has no storage_deposit_limit; the compiler binds by name.
    { name: "storageDepositLimit", class: "optBalance", optional: true },
    { name: "data", class: "bytes" },
  ],
  "revive.call": [
    { name: "dest", class: "h160" },
    { name: "value", class: "balance" },
    { name: "gasLimit", class: "weight", aliases: ["weightLimit"] },
    { name: "storageDepositLimit", class: "optBalance" },
    { name: "data", class: "bytes" },
  ],
  "revive.instantiate_with_code": [
    { name: "value", class: "balance" },
    { name: "gasLimit", class: "weight", aliases: ["weightLimit"] },
    { name: "storageDepositLimit", class: "optBalance" },
    { name: "code", class: "bytes" },
    { name: "data", class: "bytes" },
    { name: "salt", class: "optSalt" },
  ],
  "revive.map_account": [],
};

/** Kinds the compiler encodes only from observed V3 metadata (its V3_KINDS); the other kinds carry no reason code. */
export const V3_ACTION_KINDS: ReadonlySet<SeamActionKind> = new Set<SeamActionKind>([
  "nfts.mint",
  "revive.call",
  "revive.instantiate_with_code",
  "revive.map_account",
]);

/** Reason codes: exactly the compiler's StepReasonCode values (same as supportedKinds / compile()). */
export type CapabilityReasonCode = Extract<
  StepReasonCode,
  "NO_OBSERVED_V3_METADATA" | "V3_ARG_SHAPE_MISMATCH"
>;

/** What was read from the metadata, independent of the support verdict. */
export type CapabilityPresence = "observed" | "pallet_missing" | "call_missing" | "unreadable";

export interface ActionArg {
  /** camelCased metadata name. */
  name: string;
  /** Type name as written in the metadata (polkadot.js sanitised). */
  type: string;
  /** Raw type resolved by the metadata's own registry, or null when it could not be resolved. */
  rawType: string | null;
}

export interface ActionCapability {
  kind: SeamActionKind;
  /** "Pallet.call_name" */
  capability: string;
  /** What the metadata shows for the pallet/call. */
  presence: CapabilityPresence;
  supported: boolean;
  /** Set on unsupported V3 kinds, with the compiler's codes; absent otherwise (as in the compiler). */
  reasonCode?: CapabilityReasonCode;
  reason: string;
  /** From the metadata only; null when the call is not there. */
  palletIndex: number | null;
  callIndex: number | null;
  args: ActionArg[];
}

export interface LiveCapabilities {
  version: 1;
  fingerprint: RuntimeFingerprint;
  fingerprintDigest: Hex;
  metadataVersion: number;
  metadataLayoutHash: Hex;
  atBlock: BlockRef;
  endpoint?: string;
  actions: Record<SeamActionKind, ActionCapability>;
  /** The RuntimeFacts these were derived from: pass them to the compiler (compile / supportedKinds). */
  facts: RuntimeFacts;
}

const UINT = /^u(8|16|32|64|128)$/;
const BALANCE = /^u(64|128)$/;
const stripCompact = (t: string) => t.replace(/^Compact<(.+)>$/, "$1");

export function isWeightV2RawType(rawType: string): boolean {
  try {
    const t = JSON.parse(rawType);
    return !!t && typeof t === "object" && Object.keys(t).sort().join(",") === "proofSize,refTime";
  } catch {
    return false;
  }
}

/** Same rules as @seam/compiler matchesClass. */
export function argMatchesClass(cls: ArgClass, rawType: string): boolean {
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
    case "optBalance":
      return BALANCE.test(stripCompact(rawType.replace(/^Option<(.+)>$/, "$1")));
    case "weight":
      return isWeightV2RawType(rawType) || /^u64$/.test(stripCompact(rawType));
    case "bytes":
      return rawType === "Bytes" || rawType === "Vec<u8>";
    case "id":
      return UINT.test(stripCompact(rawType));
    case "optSalt":
      return rawType === "Option<[u8;32]>" || rawType === "Option<H256>";
    case "optionNone":
      return /^Option</.test(rawType);
  }
}

/** Pure check of observed args against the kind's shape. Returns undefined when they match, else a reason. */
export function shapeMismatch(kind: SeamActionKind, args: ActionArg[]): string | undefined {
  const full = ACTION_SHAPES[kind];
  const names = new Set(args.map((a) => a.name));
  // An optional argument is dropped from the expected list only when the metadata does not have it at all.
  const shape = full.filter(
    (s) => !s.optional || names.has(s.name) || (s.aliases ?? []).some((al) => names.has(al)),
  );
  const observed = args.map((a) => `${a.name}: ${a.rawType ?? a.type}`).join(", ") || "none";
  if (args.length !== shape.length)
    return `expected ${shape.length} arguments (${shape.map((s) => s.name).join(", ") || "none"}), metadata has ${args.length} (${observed})`;
  for (let i = 0; i < shape.length; i++) {
    const want = shape[i]!;
    const got = args[i]!;
    if (got.name !== want.name && !want.aliases?.includes(got.name))
      return `argument ${i} should be "${want.name}", metadata has "${got.name}" (${observed})`;
    if (got.rawType === null)
      return `the type of "${got.name}" (${got.type}) could not be resolved`;
    if (!argMatchesClass(want.class, got.rawType))
      return `argument "${want.name}" should be ${want.class}, metadata has ${got.rawType} (${observed})`;
  }
  return undefined;
}

function palletNames(loaded: ReturnType<typeof loadRuntimeCore>): Set<string> {
  return new Set(
    (loaded.metadata.asLatest.pallets as unknown as { name: { toString(): string } }[]).map((p) =>
      p.name.toString(),
    ),
  );
}

type Reg = ReturnType<typeof loadRuntimeCore>["registry"];
/**
 * The raw type of a metadata type name. Named aliases (V13 types such as AssetId, BalanceOf, Weight) are resolved
 * through the registry, also inside Compact<..> and Option<..>, so the class check sees primitives. Throws if unknown.
 */
function resolveRaw(registry: Reg, type: string, depth = 0): string {
  if (depth > 8) throw new Error(`type ${type} does not resolve`);
  const raw = quietly(() =>
    registry.createType(type as Parameters<Reg["createType"]>[0]).toRawType(),
  );
  const m = /^(Compact|Option)<([A-Za-z_][A-Za-z0-9_]*)>$/.exec(raw);
  if (m && !/^(u|i)(8|16|32|64|128|256)$|^(H160|H256|Bytes|bool)$/.test(m[2]!))
    return `${m[1]}<${resolveRaw(registry, m[2]!, depth + 1)}>`;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && raw !== type && !/^(u|i)\d+$/.test(raw))
    return resolveRaw(registry, raw, depth + 1);
  return raw;
}

/**
 * Pure: chain inputs (as read from a node) -> live capabilities. Uses the same facts builder as discovery, so the
 * fingerprint and its digest are identical to the compiler's. `opts` as for factsFromChainInputs (V13 needs typesBundle).
 */
export function liveCapabilities(inputs: ChainInputs, opts: FactsOptions = {}): LiveCapabilities {
  const pinned = pinnedInputs(inputs, opts.pinnedMetadataHex);
  const facts = factsFromChainInputs(pinned, opts);
  let loaded: ReturnType<typeof loadRuntimeCore>;
  try {
    loaded = quietly(() =>
      loadRuntimeCore(pinned.metadataHex, facts.metadataVersion! >= 14 ? null : opts.typesBundle),
    );
  } catch (e) {
    throw new SeamChainError("FACTS_MISMATCH", (e as Error).message);
  }
  const pallets = palletNames(loaded);
  const actions = {} as Record<SeamActionKind, ActionCapability>;
  for (const kind of SEAM_ACTION_KINDS) {
    const capability = ACTION_CAPABILITY[kind];
    const [pallet] = capability.split(".");
    const cap: Capability | undefined = facts.capabilities[capability];
    const base = { kind, capability, palletIndex: null, callIndex: null, args: [] as ActionArg[] };
    const v3 = V3_ACTION_KINDS.has(kind);
    const missing = (presence: CapabilityPresence, reason: string): ActionCapability => ({
      ...base,
      presence,
      supported: false,
      ...(v3 ? { reasonCode: "NO_OBSERVED_V3_METADATA" as const } : {}),
      reason,
    });
    if (!pallets.has(pallet!)) {
      actions[kind] = missing("pallet_missing", `this runtime has no ${pallet} pallet`);
      continue;
    }
    if (!cap || cap.status === "not_observed") {
      actions[kind] = missing(
        "call_missing",
        `the ${pallet} pallet has no ${capability} call on this runtime`,
      );
      continue;
    }
    if (
      cap.status !== "observed" ||
      !Number.isInteger(cap.palletIndex) ||
      !Number.isInteger(cap.callIndex)
    ) {
      actions[kind] = {
        ...base,
        presence: "unreadable",
        supported: false,
        reason: `${capability} could not be read completely from the metadata`,
      };
      continue;
    }
    const palletIndex = cap.palletIndex!;
    const callIndex = cap.callIndex!;
    let args: ActionArg[];
    let unresolved = false;
    try {
      const fn = loaded.registry.findMetaCall(new Uint8Array([palletIndex, callIndex]));
      args = fn.meta.args.map((a) => {
        let rawType: string | null = null;
        try {
          rawType = resolveRaw(loaded.registry, a.type.toString());
        } catch {
          unresolved = true;
        }
        return { name: stringCamelCase(a.name.toString()), type: a.type.toString(), rawType };
      });
    } catch (e) {
      actions[kind] = {
        ...base,
        presence: "unreadable",
        supported: false,
        reason: `${capability} (${palletIndex}/${callIndex}) could not be decoded: ${(e as Error).message}`,
      };
      continue;
    }
    const mismatch = shapeMismatch(kind, args);
    const located = { ...base, presence: "observed" as const, palletIndex, callIndex, args };
    if (mismatch)
      actions[kind] = {
        ...located,
        supported: false,
        ...(v3 ? { reasonCode: "V3_ARG_SHAPE_MISMATCH" as const } : {}),
        reason: `${capability} is on this runtime but its arguments are not the shape SEAM encodes: ${unresolved ? "(some types could not be resolved) " : ""}${mismatch}`,
      };
    else
      actions[kind] = {
        ...located,
        supported: true,
        reason: `${capability} is call ${palletIndex}/${callIndex} with the argument shape SEAM encodes`,
      };
  }
  const out: LiveCapabilities = {
    version: 1,
    fingerprint: facts.fingerprint,
    fingerprintDigest: computeFingerprintDigest(facts.fingerprint),
    metadataVersion: facts.metadataVersion!,
    metadataLayoutHash: metadataLayoutHash(pinned.metadataHex),
    atBlock: pinned.head,
    actions,
    facts,
  };
  if (pinned.endpoint) out.endpoint = pinned.endpoint;
  return out;
}

/** Minimal JSON-RPC sender (e.g. a fetch wrapper in the browser, or @seam/chain's httpRpcClient().send). */
export type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Read-only: reads genesis hash, the finalized head, runtime version and metadata at that head, and system_properties,
 * through `send`, then returns liveCapabilities. Never signs or submits.
 */
export async function readLiveCapabilities(
  send: RpcSend,
  opts: FactsOptions & { endpoint?: string } = {},
): Promise<LiveCapabilities> {
  const genesisHash = (await send("chain_getBlockHash", [0])) as Hex;
  const headHash = (await send("chain_getFinalizedHead", [])) as Hex;
  const header = (await send("chain_getHeader", [headHash])) as { number: string | number } | null;
  if (!header || !genesisHash)
    throw new SeamChainError("NODE_MISSING_VALUE", "node returned no head or genesis");
  const [runtimeVersion, metadataHex, properties] = await Promise.all([
    send("state_getRuntimeVersion", [headHash]),
    send("state_getMetadata", [headHash]),
    send("system_properties", []),
  ]);
  const inputs: ChainInputs = {
    metadataHex: metadataHex as Hex,
    genesisHash,
    runtimeVersion: runtimeVersion as ChainInputs["runtimeVersion"],
    properties: (properties ?? {}) as ChainInputs["properties"],
    head: { number: Number(header.number), hash: headHash },
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
  };
  return liveCapabilities(inputs, opts);
}
