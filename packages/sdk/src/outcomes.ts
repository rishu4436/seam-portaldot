import { parseNativeAddress, type Hex, type RuntimeFingerprint } from "@seam/compiler/browser";
import type { Verification } from "@seam/policy/browser";
import type { ChainEvent, StepCode, VerifierCoverage } from "./receipt.js";

/**
 * Outcome verifiers for `revive.call` and `nfts.mint`. They read the decoded events of ONE step's transaction and
 * compare them with the exact binding the caller expected. They fail closed: `effect_proven` / `verified` is returned only
 * when the step finalized, succeeded, an event of the declared shape carries exactly the expected arguments, AND the
 * caller says that event shape was `observedShape` (read from real runtime metadata). Anything else is capped below
 * `effect_proven` and says "not verified on V3".
 *
 * One real event layout is known: `V3_SPEC3002_NFTS_SHAPE`, observed on the hosted Portaldot V3 testnet (spec 3002).
 * V3 has no per-call Revive event, so `verifyReviveCallOutcome` cannot match a real V3 call; `verifyReviveCallV3Outcome`
 * checks the extrinsic's own call bytes instead (weaker, labelled with an `EffectBasis`). The `SYNTHETIC_*` shapes exist only so tests
 * can exercise the logic. Set `observedShape: true` only for a shape read from real metadata of the target runtime.
 */

/** Where in an event's positional args each bound value sits. */
export interface NftsEventShape {
  pallet: string;
  name: string;
  args: { collection: number; item: number; mintTo: number };
}
export interface ReviveEventShape {
  pallet: string;
  name: string;
  args: { dest: number; data: number; value?: number };
}

/** SYNTHETIC. Not observed on Portaldot V3. For tests only; do not pass these with `observedShape: true` in real use. */
export const SYNTHETIC_NFTS_SHAPE: NftsEventShape = {
  pallet: "Nfts",
  name: "Issued",
  args: { collection: 0, item: 1, mintTo: 2 },
};
/** SYNTHETIC. Not observed on Portaldot V3. For tests only. */
export const SYNTHETIC_REVIVE_SHAPE: ReviveEventShape = {
  pallet: "Revive",
  name: "Called",
  args: { dest: 0, value: 1, data: 2 },
};

/**
 * OBSERVED on Portaldot V3, runtime `portaldot-v3` spec 3002 (hosted testnet, genesis 0xd4f9acbc…83bd).
 * `Nfts.Issued(collection, item, owner)`: field names read from the runtime metadata, and the event decoded from real
 * finalized mints. Evidence: evidence/testnet-v3/README.md (txs #3, #13, #15), runs/nfts-mint-1792409706466.json,
 * runs/plan-sequential-1792411270138.json (`nftsIssuedFieldsFromMetadata`) and runs/plan-atomic-1792411355057.json.
 * Treated as observed ONLY for that spec name and version (see `nftsShapeFor`).
 */
export const V3_SPEC3002_NFTS_SHAPE: NftsEventShape = {
  pallet: "Nfts",
  name: "Issued",
  args: { collection: 0, item: 1, mintTo: 2 },
};

/** The runtime facts the default nfts.mint / revive.call checks need. A `RuntimeFingerprint` fits. */
export type V3Runtime = Pick<RuntimeFingerprint, "specName" | "specVersion"> &
  Partial<Pick<RuntimeFingerprint, "ss58Prefix">>;
export type NftsRuntime = V3Runtime;

/** True only for `portaldot-v3` spec 3002, the runtime whose layouts were observed (evidence/testnet-v3). */
export const isObservedV3 = (runtime: V3Runtime | undefined): boolean =>
  runtime?.specName === "portaldot-v3" && runtime.specVersion === 3002;

/**
 * The Nfts shape to use for a runtime, and whether it was observed there. Only `portaldot-v3` spec 3002 is observed;
 * any other runtime (or none) gets the same layout with `observed: false`, so a match is capped at `contract_emitted`.
 */
export function nftsShapeFor(runtime: NftsRuntime | undefined): {
  shape: NftsEventShape;
  observed: boolean;
} {
  const observed = isObservedV3(runtime);
  return { shape: V3_SPEC3002_NFTS_SHAPE, observed };
}

export interface NftsMintExpectation {
  collection: string;
  item: string;
  mintTo: Hex;
}
export interface ReviveCallExpectation {
  dest: Hex;
  value: string;
  data: Hex;
}

export interface OutcomeInput<S> {
  /** Status of the step's transaction as the chain layer reported it. */
  status: "finalized" | "included" | "submitted" | "failed";
  /** Decoded events of that transaction only. */
  events: ChainEvent[];
  /** True only if `shape` was read from real runtime metadata for the target chain. Default false: capped. */
  observedShape?: boolean;
  shape: S;
  /** If set, an SS58 account in an event is compared as its AccountId. Some decoders print owners in SS58. */
  ss58Prefix?: number;
}

/** What a verifier concluded. Feed it to `buildReceipt({ verdicts: { [actionId]: verdict } })`. */
export interface OutcomeVerdict {
  verification: Verification;
  coverage: VerifierCoverage;
  reason: string;
  code?: StepCode;
  /** The event (as `Pallet.name(args)`) that matched the binding. Required for `verified`; the receipt re-checks it is in the step's events. */
  matchedEvent?: string;
  /** What the conclusion rests on, when it is not a plain event match. See `EffectBasis`. */
  basis?: EffectBasis;
}

/**
 * What a revive.call verdict on V3 rests on. Both are weaker than a per-call event, which V3 does not have:
 * - `call_args_and_success`: the finalized extrinsic's own call bytes decode to exactly the planned dest, value, weight,
 *   deposit limit and data, and it succeeded. Shows the planned call ran without reverting, not what the contract did.
 *   Never `effect_proven`.
 * - `call_args_success_and_emitted`: the above, plus the `Revive.ContractEmitted` the caller expected, from `dest`, with
 *   the expected data (and topics, if given). `effect_proven`, but only as strong as that expected event.
 */
export type EffectBasis =
  | "call_args_and_success"
  | "call_args_success_and_emitted"
  /** instantiate_with_code: call bytes match the plan (incl. keccak256 of the code), success, and Revive.Instantiated by the signer's H160. */
  | "call_args_success_and_instantiated"
  /** map_account without a state read: the call succeeded; V3 emits no event, so nothing more is shown. */
  | "call_success"
  /** map_account: a supplied Revive.OriginalAccount read for the signer's H160. */
  | "original_account_readback";

const lc = (s: string | undefined) => (s ?? "").toLowerCase();
const fmt = (e: ChainEvent) => `${e.pallet}.${e.name}(${e.args.join(", ")})`;

export const NOT_VERIFIED_ON_V3 =
  "A matching event was found, but its shape has not been observed from real V3 metadata, so this is not verified on V3.";

type Bound = { index: number; expected: string; account?: boolean }[];

/** An account arg as a lowercase 0x AccountId when it is SS58 with the given prefix; otherwise unchanged. */
function asAccountId(v: string | undefined, ss58Prefix: number | undefined): string {
  if (v === undefined || ss58Prefix === undefined || v.startsWith("0x")) return lc(v);
  return lc(parseNativeAddress(v, ss58Prefix, "event", [])?.accountId ?? v);
}

/** Shared fail-closed logic: dispatch errors, finality, event presence, exact match, then the observed-shape cap. */
function judge(
  input: OutcomeInput<{ pallet: string; name: string }>,
  bound: Bound,
  arity: number,
  what: string,
): OutcomeVerdict {
  const { status, events } = input;
  const failedEvent = events.some((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
  if (status === "failed" || failedEvent) {
    return {
      verification: "not_verified",
      coverage: "none",
      code: "tx_failed",
      reason: `The ${what} transaction failed on chain.`,
    };
  }
  const ok = events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
  if (!ok)
    return {
      verification: "unknown",
      coverage: "none",
      code: "no_trace",
      reason: `No success event was found for the ${what} transaction.`,
    };
  if (status !== "finalized") {
    return {
      verification: "unknown",
      coverage: "call_dispatched",
      code: "not_finalized",
      reason: `The ${what} is in a block that isn't finalized yet, so its effect cannot be proven.`,
    };
  }
  const named = events.filter(
    (e) => e.pallet === input.shape.pallet && e.name === input.shape.name,
  );
  if (!named.length) {
    return {
      verification: "unknown",
      coverage: "extrinsic_finalized",
      code: "effect_unproven",
      reason: `The ${what} finalized, but no ${input.shape.pallet}.${input.shape.name} event was found, so its effect is not proven.`,
    };
  }
  const wellFormed = named.filter((e) => e.args.length === arity);
  if (!wellFormed.length) {
    return {
      verification: "unknown",
      coverage: "contract_emitted",
      code: "effect_unproven",
      reason: `An ${input.shape.pallet}.${input.shape.name} event was found but its arguments do not have the expected shape, so it was not used as proof.`,
    };
  }
  const hit = wellFormed.find((e) =>
    bound.every((b) =>
      b.account
        ? asAccountId(e.args[b.index], input.ss58Prefix) === lc(b.expected)
        : lc(e.args[b.index]) === lc(b.expected),
    ),
  );
  if (!hit) {
    return {
      verification: "not_verified",
      coverage: "contract_emitted",
      code: "effect_mismatch",
      reason: `The ${what} emitted ${input.shape.pallet}.${input.shape.name}, but not with the arguments that were requested.`,
    };
  }
  if (input.observedShape !== true) {
    return {
      verification: "unknown",
      coverage: "contract_emitted",
      code: "v3_shape_unobserved",
      reason: NOT_VERIFIED_ON_V3,
      matchedEvent: fmt(hit),
    };
  }
  return {
    verification: "verified",
    coverage: "effect_proven",
    reason: `The ${what} finalized and the chain shows exactly the requested arguments.`,
    matchedEvent: fmt(hit),
  };
}

/** Verifies an `nfts.mint` step: collection, item and owner must all match exactly. */
export function verifyNftsMintOutcome(
  input: OutcomeInput<NftsEventShape>,
  want: NftsMintExpectation,
): OutcomeVerdict {
  const a = input.shape.args;
  return judge(
    input,
    [
      { index: a.collection, expected: want.collection },
      { index: a.item, expected: want.item },
      { index: a.mintTo, expected: want.mintTo, account: true },
    ],
    Math.max(a.collection, a.item, a.mintTo) + 1,
    "NFT mint",
  );
}

/**
 * Verifies a `revive.call` step: destination, value and call data must all match exactly. If the shape has no `value`
 * position, a non-zero expected value cannot be proven and the result is capped at `contract_emitted`.
 */
export function verifyReviveCallOutcome(
  input: OutcomeInput<ReviveEventShape>,
  want: ReviveCallExpectation,
): OutcomeVerdict {
  const a = input.shape.args;
  const bound: Bound = [
    { index: a.dest, expected: want.dest },
    { index: a.data, expected: want.data },
  ];
  if (a.value !== undefined) bound.push({ index: a.value, expected: want.value });
  const v = judge(input, bound, Math.max(a.dest, a.data, a.value ?? 0) + 1, "Revive call");
  if (v.verification === "verified" && a.value === undefined && want.value !== "0") {
    return {
      verification: "unknown",
      coverage: "contract_emitted",
      code: "effect_unproven",
      reason:
        "The event does not carry the transferred value, so the requested value was not proven.",
      matchedEvent: v.matchedEvent,
    };
  }
  return v;
}

/** A Revive.call as it appears in a V3 spec 3002 extrinsic: `dest H160, value, weight_limit, storage_deposit_limit, data`. */
export interface V3ReviveCall {
  palletIndex: number;
  callIndex: number;
  dest: Hex;
  value: string;
  gasLimit: string;
  proofSize: string;
  storageDepositLimit: string;
  data: Hex;
}

/** SCALE compact integer at `at`; undefined when malformed. */
function compactAt(b: Uint8Array, at: number): { value: bigint; next: number } | undefined {
  const first = b[at];
  if (first === undefined) return undefined;
  const mode = first & 3;
  const n = mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : (first >> 2) + 5;
  if (at + n > b.length) return undefined;
  if (mode === 3 && n - 1 > 16) return undefined;
  let v = 0n;
  const from = mode === 3 ? at + 1 : at;
  for (let i = at + n - 1; i >= from; i--) v = (v << 8n) | BigInt(b[i]!);
  return { value: mode === 3 ? v : v >> 2n, next: at + n };
}

/**
 * Decodes Revive.call bytes with the layout observed on Portaldot V3 spec 3002: pallet index, call index, `dest` (20 bytes),
 * then `value`, `weight_limit.ref_time`, `weight_limit.proof_size`, `storage_deposit_limit` (each `Compact<u128/u64>`), then
 * `data` (`Vec<u8>`). Evidence: evidence/testnet-v3/README.md phase 2 and runs/plan-revive-call-1792412445848.json.
 * Returns undefined for anything malformed, including trailing bytes. It does not check which pallet/call the indices name.
 */
export function decodeV3ReviveCall(callHex: Hex): V3ReviveCall | undefined {
  if (typeof callHex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(callHex)) return undefined;
  const b = new Uint8Array(callHex.length / 2 - 1);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(callHex.slice(2 + 2 * i, 4 + 2 * i), 16);
  if (b.length < 22) return undefined;
  const hex = (u: Uint8Array) =>
    ("0x" + Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
  let at = 22;
  const nums: bigint[] = [];
  for (let k = 0; k < 5; k++) {
    const c = compactAt(b, at);
    if (!c) return undefined;
    nums.push(c.value);
    at = c.next;
  }
  const len = Number(nums[4]);
  if (at + len !== b.length) return undefined;
  return {
    palletIndex: b[0]!,
    callIndex: b[1]!,
    dest: hex(b.subarray(2, 22)),
    value: nums[0]!.toString(),
    gasLimit: nums[1]!.toString(),
    proofSize: nums[2]!.toString(),
    storageDepositLimit: nums[3]!.toString(),
    data: hex(b.subarray(at)),
  };
}

/** What the plan says a V3 revive.call must be, plus the contract event the caller expects (optional). */
export interface ReviveCallV3Expectation {
  palletIndex: number | null;
  callIndex: number | null;
  contract: string;
  value: string;
  data: string;
  gasLimit: string;
  proofSize: string;
  storageDepositLimit: string | null;
  /** Exact `data` of the `Revive.ContractEmitted` the contract must emit. Without it the verdict is capped. */
  emittedData?: Hex;
  /** Exact topics of that event, in order. Checked only when given. */
  emittedTopics?: Hex[];
}

export interface ReviveCallV3Input {
  status: "finalized" | "included" | "submitted" | "failed";
  /** Decoded events of that extrinsic only. */
  events: ChainEvent[];
  /** The call bytes of the extrinsic as it was signed and included. Missing means unknown. */
  callHex?: Hex;
  /** Must be `portaldot-v3` spec 3002, the only runtime whose Revive.call layout was observed. */
  runtime?: V3Runtime;
}

/** `[]`, `[0xaa, 0xbb]` or `["0xaa","0xbb"]` as recorded; undefined if it isn't one of those. */
function parseTopics(s: string | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const parts = inner.split(",").map((x) => x.trim().replace(/^"|"$/g, "").toLowerCase());
  return parts.every((x) => /^0x[0-9a-f]*$/.test(x)) ? parts : undefined;
}

/**
 * Verifies a `revive.call` step on Portaldot V3 (spec 3002), where no event carries the call's (dest, data, value).
 * Requires ALL of: the extrinsic's own call bytes decode to exactly the planned pallet/call index, dest, value, weight limit,
 * storage deposit limit and data; `System.ExtrinsicSuccess`; and, when `emittedData` is expected, a `Revive.ContractEmitted`
 * from `dest` with that data (and topics, if given). Fails closed: missing or undecodable input is `unknown`, a mismatch is
 * `not_verified` / `effect_mismatch`, a failed dispatch is `tx_failed`. See `EffectBasis` for how strong each result is.
 */
export function verifyReviveCallV3Outcome(
  input: ReviveCallV3Input,
  want: ReviveCallV3Expectation,
): OutcomeVerdict {
  const { status, events } = input;
  const failed =
    status === "failed" ||
    events.some(
      (e) =>
        (e.pallet === "System" && e.name === "ExtrinsicFailed") ||
        (e.pallet === "Revive" && e.name === "EthExtrinsicRevert"),
    );
  if (failed)
    return {
      verification: "not_verified",
      coverage: "none",
      code: "tx_failed",
      reason: "The Revive call failed on chain.",
    };
  if (!events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess"))
    return {
      verification: "unknown",
      coverage: "none",
      code: "no_trace",
      reason: "No success event was found for the Revive call.",
    };
  if (status !== "finalized")
    return {
      verification: "unknown",
      coverage: "call_dispatched",
      code: "not_finalized",
      reason: "The Revive call is in a block that isn't finalized yet, so it cannot be checked.",
    };
  const capped = (reason: string, code: StepCode = "effect_unproven"): OutcomeVerdict => ({
    verification: "unknown",
    coverage: "extrinsic_finalized",
    code,
    reason,
  });
  if (!isObservedV3(input.runtime))
    return capped(
      "The Revive.call layout was observed only on portaldot-v3 spec 3002; this runtime is not that one, so the call was not checked.",
      "v3_shape_unobserved",
    );
  if (!input.callHex)
    return capped(
      "The extrinsic's call bytes were not reported, so SEAM cannot confirm the planned call is the one that ran.",
    );
  const got = decodeV3ReviveCall(input.callHex);
  if (!got) return capped("The extrinsic's call bytes could not be decoded as a V3 Revive.call.");
  if (
    want.palletIndex === null ||
    want.callIndex === null ||
    want.storageDepositLimit === null ||
    [want.contract, want.value, want.data, want.gasLimit, want.proofSize].some(
      (x) => typeof x !== "string",
    )
  )
    return capped(
      "The plan step does not carry every Revive.call argument, so it cannot be compared.",
    );
  const diffs: string[] = [];
  if (got.palletIndex !== want.palletIndex || got.callIndex !== want.callIndex) diffs.push("call");
  if (lc(got.dest) !== lc(want.contract)) diffs.push("dest");
  if (got.value !== want.value) diffs.push("value");
  if (got.gasLimit !== want.gasLimit || got.proofSize !== want.proofSize)
    diffs.push("weight_limit");
  if (got.storageDepositLimit !== want.storageDepositLimit) diffs.push("storage_deposit_limit");
  if (lc(got.data) !== lc(want.data)) diffs.push("data");
  if (diffs.length)
    return {
      verification: "not_verified",
      coverage: "extrinsic_finalized",
      code: "effect_mismatch",
      reason: `The call that ran on chain differs from the plan in: ${diffs.join(", ")}.`,
    };
  if (want.emittedData === undefined)
    return {
      ...capped(
        "The on-chain call matches the plan exactly (dest, value, weight, deposit limit, data) and succeeded. V3 has no per-call event and no expected contract event was given, so what the contract did is not proven.",
      ),
      basis: "call_args_and_success",
    };
  // The events of a finalized extrinsic are complete, so an expected event that is not there is a mismatch, not a gap.
  const fromDest = events.filter(
    (e) =>
      e.pallet === "Revive" &&
      e.name === "ContractEmitted" &&
      e.args.length === 3 &&
      lc(e.args[0]) === lc(want.contract),
  );
  const wantTopics = want.emittedTopics?.map((t) => t.toLowerCase());
  const hit = fromDest.find((e) => {
    if (lc(e.args[1]) !== lc(want.emittedData)) return false;
    if (!wantTopics) return true;
    const t = parseTopics(e.args[2]);
    return !!t && t.length === wantTopics.length && t.every((x, i) => x === wantTopics[i]);
  });
  if (!hit)
    return {
      verification: "not_verified",
      coverage: fromDest.length ? "contract_emitted" : "extrinsic_finalized",
      code: "effect_mismatch",
      reason: fromDest.length
        ? "The call matches the plan, but the contract did not emit the expected event data or topics."
        : "The call matches the plan, but no Revive.ContractEmitted came from the target contract.",
      basis: "call_args_and_success",
    };
  return {
    verification: "verified",
    coverage: "effect_proven",
    reason:
      "The on-chain call matches the plan exactly, it succeeded, and the contract emitted the expected event. (V3 has no per-call event; this rests on the call bytes plus that event.)",
    matchedEvent: fmt(hit),
    basis: "call_args_success_and_emitted",
  };
}
