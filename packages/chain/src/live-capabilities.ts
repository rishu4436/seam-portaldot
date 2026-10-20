import { stringCamelCase } from "@polkadot/util";
import {
  computeFingerprintDigest,
  KIND_TO_CAPABILITY,
  supportedKinds,
  type ActionKind,
  type Capability,
  type Hex,
  type KindAvailability,
  type RuntimeFacts,
  type RuntimeFingerprint,
  type StepReasonCode,
} from "@seam/compiler/browser";
import { SeamChainError } from "./errors.js";
import { factsFromChainInputs, pinnedInputs, type FactsOptions } from "./facts-core.js";
import { metadataLayoutHash } from "./metadata-layout.js";
import { quietly } from "./quiet.js";
import { loadRuntimeCore } from "./runtime-core.js";
import type { RpcSend } from "./rpc-core.js";
import type { BlockRef, ChainInputs } from "./types.js";
export type { RpcSend } from "./rpc-core.js";

/**
 * Live capabilities (browser-safe, read-only): for each SEAM action kind, what the connected runtime's own metadata
 * shows (pallet and call indices, argument names and types) and whether SEAM supports it. The support verdict
 * (`supported`, `reasonCode`, `reason`) is the compiler's: @seam/compiler/browser `supportedKinds(facts)`, unchanged.
 * This module only reads; it has no support rules of its own. Indices are taken only when the metadata reading and
 * supportedKinds agree; if they ever differ the action is reported unsupported (fail closed).
 */

/** The compiler's kinds, in its order. */
export const SEAM_ACTION_KINDS = Object.keys(KIND_TO_CAPABILITY) as ActionKind[];
export type SeamActionKind = ActionKind;

/** The compiler's KIND_TO_CAPABILITY (same object). */
export const ACTION_CAPABILITY: Record<SeamActionKind, string> = KIND_TO_CAPABILITY;

/** Reason codes: the compiler's StepReasonCode values, as supportedKinds sets them. */
export type CapabilityReasonCode = StepReasonCode;

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
  /** supportedKinds' reasonCode for an unsupported kind, unchanged; absent when it gives none. */
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

type Reading = Pick<ActionCapability, "presence" | "palletIndex" | "callIndex" | "args">;

/** What the metadata shows for one call: presence, indices and arguments. No verdict. */
function readCall(
  loaded: ReturnType<typeof loadRuntimeCore>,
  pallets: Set<string>,
  pallet: string,
  cap: Capability | undefined,
): Reading {
  const none = (presence: CapabilityPresence): Reading => ({
    presence,
    palletIndex: null,
    callIndex: null,
    args: [],
  });
  if (!pallets.has(pallet)) return none("pallet_missing");
  if (!cap || cap.status === "not_observed") return none("call_missing");
  if (
    cap.status !== "observed" ||
    !Number.isInteger(cap.palletIndex) ||
    !Number.isInteger(cap.callIndex)
  )
    return none("unreadable");
  try {
    const fn = loaded.registry.findMetaCall(new Uint8Array([cap.palletIndex!, cap.callIndex!]));
    const args = fn.meta.args.map((a) => {
      let rawType: string | null = null;
      try {
        rawType = resolveRaw(loaded.registry, a.type.toString());
      } catch {
        /* stays null */
      }
      return { name: stringCamelCase(a.name.toString()), type: a.type.toString(), rawType };
    });
    return { presence: "observed", palletIndex: cap.palletIndex!, callIndex: cap.callIndex!, args };
  } catch {
    return none("unreadable");
  }
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
  // The verdict: the compiler's, for these exact facts. Invalid facts throw there; surface that as FACTS_MISMATCH.
  let verdicts: KindAvailability[];
  try {
    verdicts = supportedKinds(facts);
  } catch (e) {
    throw new SeamChainError(
      "FACTS_MISMATCH",
      `supportedKinds rejected the facts: ${(e as Error).message}`,
    );
  }
  const byKind = new Map(verdicts.map((v) => [v.kind, v]));
  const actions = {} as Record<SeamActionKind, ActionCapability>;
  for (const kind of SEAM_ACTION_KINDS) {
    const capability = ACTION_CAPABILITY[kind];
    const [pallet] = capability.split(".");
    const cap: Capability | undefined = facts.capabilities[capability];
    const reading = readCall(loaded, pallets, pallet!, cap);
    const v = byKind.get(kind);
    const unsupported = (reason: string, reasonCode?: StepReasonCode): ActionCapability => ({
      kind,
      capability,
      ...reading,
      supported: false,
      ...(reasonCode ? { reasonCode } : {}),
      reason,
    });
    if (!v) actions[kind] = unsupported("the compiler's supportedKinds did not report this kind");
    else if (!v.supported) actions[kind] = unsupported(v.reason, v.reasonCode);
    else if (
      reading.presence !== "observed" ||
      reading.palletIndex !== v.palletIndex ||
      reading.callIndex !== v.callIndex
    )
      actions[kind] = unsupported(
        `the compiler reports ${capability} at ${v.palletIndex}/${v.callIndex}, but the metadata reading is ${reading.presence} at ${reading.palletIndex ?? "-"}/${reading.callIndex ?? "-"}`,
      );
    else
      actions[kind] = {
        kind,
        capability,
        ...reading,
        supported: true,
        reason: `${capability} is call ${v.palletIndex}/${v.callIndex}; the compiler can encode it on this runtime`,
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
