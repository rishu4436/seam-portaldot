import { keccakAsHex } from "@polkadot/util-crypto";
import type { Hex } from "@seam/compiler";
import type { ChainEvent, StepCode } from "./receipt.js";
import { isObservedV3, type OutcomeVerdict, type V3Runtime } from "./outcomes.js";

/**
 * Outcome verifiers for `revive.instantiate_with_code` and `revive.map_account` on Portaldot V3 (spec 3002 only).
 * Both fail closed: `verified` / `effect_proven` only on a finalized, successful extrinsic whose evidence proves the
 * planned effect; missing or undecodable evidence is `unknown`; a contradiction is `not_verified` / `effect_mismatch`;
 * a failed dispatch is `tx_failed`. Any other runtime is capped at `v3_shape_unobserved`.
 */

/**
 * OBSERVED on Portaldot V3, `portaldot-v3` spec 3002: `Revive.Instantiated(deployer: H160, contract: H160)`.
 * Evidence: evidence/testnet-v3/runs/revive-deploy-1792412368928.json (tx 0xad39bce1…acb2, block #102843), event
 * `Revive.Instantiated(0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec, 0x86b9cc2d456eed16a6872e1d5646f606a59cd95b)`,
 * argTypes `["H160","H160"]`. The deployer is the signer's mapped H160. The event carries NO code hash.
 */
export const V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE = {
  pallet: "Revive",
  name: "Instantiated",
  args: { deployer: 0, contract: 1 },
  arity: 2,
} as const;

/**
 * OBSERVED on V3 spec 3002: `Revive.map_account()` emits NO Revive event. Evidence:
 * evidence/testnet-v3/runs/map-account-1792408724499.json (tx 0x7577717d…1812, block #102233): its events are only
 * Balances.Withdraw, Balances.Deposit, TransactionPayment.TransactionFeePaid and System.ExtrinsicSuccess. That account
 * was ALREADY mapped before the call (`originalAccountBefore` = signer; the runtime auto-maps), so the evidence does not
 * show a fresh mapping. Only a `Revive.OriginalAccount` state read can prove the mapping.
 */
export const V3_SPEC3002_MAP_ACCOUNT_EVENTS: readonly string[] = [];

/**
 * The H160 pallet-revive uses for an AccountId32: the first 20 bytes when the account is Ethereum-derived (last 12
 * bytes all 0xEE), otherwise the last 20 bytes of keccak256(accountId). Checked against the evidence: the V3 signer
 * 0x80270a11…8467 maps to 0x81ed1dfbec067703fdca3daa7efcbeff4ba101ec (`derivedH160`, and the deployer in
 * `Revive.Instantiated`). Undefined for anything that is not a 0x + 64 hex AccountId32.
 */
export function reviveAddressOf(accountId: string): Hex | undefined {
  if (typeof accountId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(accountId)) return undefined;
  const a = accountId.toLowerCase();
  if (a.endsWith("ee".repeat(12))) return a.slice(0, 42) as Hex;
  return ("0x" + keccakAsHex(a).slice(26)) as Hex;
}

/** A Revive.instantiate_with_code as it appears in a V3 spec 3002 extrinsic. */
export interface V3InstantiateWithCode {
  palletIndex: number;
  callIndex: number;
  value: string;
  gasLimit: string;
  proofSize: string;
  storageDepositLimit: string;
  code: Hex;
  data: Hex;
  salt: Hex | null;
}

const bytesOf = (h: string): Uint8Array | undefined => {
  if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h)) return undefined;
  const b = new Uint8Array(h.length / 2 - 1);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return b;
};
const hexOf = (u: Uint8Array) =>
  ("0x" + Array.from(u, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
function compactAt(b: Uint8Array, at: number): { value: bigint; next: number } | undefined {
  const first = b[at];
  if (first === undefined) return undefined;
  const mode = first & 3;
  const n = mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : (first >> 2) + 5;
  if (at + n > b.length || (mode === 3 && n - 1 > 16)) return undefined;
  let v = 0n;
  const from = mode === 3 ? at + 1 : at;
  for (let i = at + n - 1; i >= from; i--) v = (v << 8n) | BigInt(b[i]!);
  return { value: mode === 3 ? v : v >> 2n, next: at + n };
}

/**
 * Decodes Revive.instantiate_with_code bytes with the layout observed on V3 spec 3002: pallet index, call index, then
 * `value`, `weight_limit.ref_time`, `weight_limit.proof_size`, `storage_deposit_limit` (each Compact), `code` (Vec<u8>),
 * `data` (Vec<u8>), `salt` (Option<[u8; 32]>). Evidence: runs/revive-deploy-1792412368928.json (`call`, `callHex`).
 * Undefined for anything malformed, including trailing bytes.
 */
export function decodeV3InstantiateWithCode(callHex: Hex): V3InstantiateWithCode | undefined {
  const b = bytesOf(callHex);
  if (!b || b.length < 2) return undefined;
  let at = 2;
  const nums: bigint[] = [];
  for (let k = 0; k < 4; k++) {
    const c = compactAt(b, at);
    if (!c) return undefined;
    nums.push(c.value);
    at = c.next;
  }
  const vec = (): Uint8Array | undefined => {
    const l = compactAt(b, at);
    if (!l) return undefined;
    const end = l.next + Number(l.value);
    if (end > b.length) return undefined;
    const out = b.subarray(l.next, end);
    at = end;
    return out;
  };
  const code = vec();
  const data = code && vec();
  if (!code || !data) return undefined;
  let salt: Hex | null;
  if (b[at] === 0) {
    salt = null;
    at += 1;
  } else if (b[at] === 1 && at + 33 <= b.length) {
    salt = hexOf(b.subarray(at + 1, at + 33));
    at += 33;
  } else return undefined;
  if (at !== b.length) return undefined;
  return {
    palletIndex: b[0]!,
    callIndex: b[1]!,
    value: nums[0]!.toString(),
    gasLimit: nums[1]!.toString(),
    proofSize: nums[2]!.toString(),
    storageDepositLimit: nums[3]!.toString(),
    code: hexOf(code),
    data: hexOf(data),
    salt,
  };
}

/** keccak256 of the `code` argument as submitted. For EVM code this is the hash of the INIT code, not CodeInfoOf's hash. */
export const instantiateCodeHash = (code: Hex): Hex => keccakAsHex(code) as Hex;

export interface ReviveInstantiateExpectation {
  palletIndex: number | null;
  callIndex: number | null;
  /** keccak256 of the planned `code` bytes (`instantiateCodeHash`). */
  codeHash: string | undefined;
  value: string | undefined;
  gasLimit: string | undefined;
  proofSize: string | undefined;
  storageDepositLimit: string | null | undefined;
}

interface V3Input {
  status: "finalized" | "included" | "submitted" | "failed";
  /** Decoded events of that extrinsic only. */
  events: ChainEvent[];
  /** Must be `portaldot-v3` spec 3002. */
  runtime?: V3Runtime;
  /** The signer's AccountId32 (0x + 64 hex). */
  signerAccountId: string;
}

export interface ReviveInstantiateInput extends V3Input {
  /** The call bytes of the extrinsic as signed and included. Missing means unknown. */
  callHex?: Hex;
}

const lc = (s: string | undefined | null) => (s ?? "").toLowerCase();
const fmt = (e: ChainEvent) => `${e.pallet}.${e.name}(${e.args.join(", ")})`;

/** Shared head: failure, success, finality, runtime. Undefined when the step may be judged further. */
function gate(input: V3Input, what: string): OutcomeVerdict | undefined {
  const { status, events } = input;
  if (
    status === "failed" ||
    events.some(
      (e) =>
        (e.pallet === "System" && e.name === "ExtrinsicFailed") ||
        (e.pallet === "Revive" && e.name === "EthExtrinsicRevert"),
    )
  )
    return {
      verification: "not_verified",
      coverage: "none",
      code: "tx_failed",
      reason: `The ${what} failed on chain.`,
    };
  if (!events.some((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess"))
    return {
      verification: "unknown",
      coverage: "none",
      code: "no_trace",
      reason: `No success event was found for the ${what}.`,
    };
  if (status !== "finalized")
    return {
      verification: "unknown",
      coverage: "call_dispatched",
      code: "not_finalized",
      reason: `The ${what} is in a block that isn't finalized yet, so it cannot be checked.`,
    };
  if (!isObservedV3(input.runtime))
    return capped(
      `The ${what} layout was observed only on portaldot-v3 spec 3002; this runtime is not that one, so it was not checked.`,
      "v3_shape_unobserved",
    );
  return undefined;
}
const capped = (reason: string, code: StepCode = "effect_unproven"): OutcomeVerdict => ({
  verification: "unknown",
  coverage: "extrinsic_finalized",
  code,
  reason,
});

/**
 * Verifies a `revive.instantiate_with_code` step on V3 spec 3002. `verified` / `effect_proven`
 * (basis `call_args_success_and_instantiated`) needs ALL of: the extrinsic's own call bytes decode to exactly the planned
 * value, weight limit, storage deposit limit and pallet/call index, with keccak256(code) equal to the plan's `codeHash`;
 * `System.ExtrinsicSuccess`; and a `Revive.Instantiated(deployer, contract)` whose deployer is the signer's mapped H160.
 * The event has no code hash, so the code is proven by the call bytes, not by the event.
 */
export function verifyReviveInstantiateOutcome(
  input: ReviveInstantiateInput,
  want: ReviveInstantiateExpectation,
): OutcomeVerdict {
  const head = gate(input, "contract deploy");
  if (head) return head;
  const deployer = reviveAddressOf(input.signerAccountId);
  if (!deployer) return capped("The signer is not an AccountId32, so its H160 is not known.");
  if (!input.callHex)
    return capped(
      "The extrinsic's call bytes were not reported, so SEAM cannot confirm the planned code was deployed.",
    );
  const got = decodeV3InstantiateWithCode(input.callHex);
  if (!got)
    return capped(
      "The extrinsic's call bytes could not be decoded as a V3 Revive.instantiate_with_code.",
    );
  if (
    want.palletIndex === null ||
    want.callIndex === null ||
    [want.codeHash, want.value, want.gasLimit, want.proofSize].some((x) => typeof x !== "string") ||
    typeof want.storageDepositLimit !== "string"
  )
    return capped(
      "The plan step does not carry every instantiate_with_code argument, so it cannot be compared.",
    );
  const diffs: string[] = [];
  if (got.palletIndex !== want.palletIndex || got.callIndex !== want.callIndex) diffs.push("call");
  if (lc(instantiateCodeHash(got.code)) !== lc(want.codeHash)) diffs.push("code hash");
  if (got.value !== want.value) diffs.push("value");
  if (got.gasLimit !== want.gasLimit || got.proofSize !== want.proofSize)
    diffs.push("weight_limit");
  if (got.storageDepositLimit !== want.storageDepositLimit) diffs.push("storage_deposit_limit");
  if (diffs.length)
    return {
      verification: "not_verified",
      coverage: "extrinsic_finalized",
      code: "effect_mismatch",
      reason: `The deploy that ran on chain differs from the plan in: ${diffs.join(", ")}.`,
    };
  const s = V3_SPEC3002_REVIVE_INSTANTIATED_SHAPE;
  const inst = input.events.filter(
    (e) => e.pallet === s.pallet && e.name === s.name && e.args.length === s.arity,
  );
  // The events of a finalized extrinsic are complete: no Instantiated means no contract was created.
  const hit = inst.find((e) => lc(e.args[s.args.deployer]) === deployer);
  if (!hit)
    return {
      verification: "not_verified",
      coverage: "extrinsic_finalized",
      code: "effect_mismatch",
      reason: inst.length
        ? `A Revive.Instantiated was emitted, but not with deployer ${deployer} (the signer's H160).`
        : "The deploy call matches the plan and succeeded, but no Revive.Instantiated event was emitted.",
      basis: "call_args_and_success",
    };
  return {
    verification: "verified",
    coverage: "effect_proven",
    reason: `The on-chain deploy matches the plan exactly (code hash, value, weight, deposit limit), it succeeded, and Revive.Instantiated shows contract ${hit.args[s.args.contract]} deployed by the signer's H160 ${deployer}.`,
    matchedEvent: fmt(hit),
    basis: "call_args_success_and_instantiated",
  };
}

/** A `Revive.OriginalAccount` storage read: the H160 key and the AccountId32 it maps to (null if absent). */
export interface OriginalAccountRead {
  h160: string;
  accountId: string | null;
  /** The same read at the parent block, if known. Only used to say whether the mapping is new. */
  before?: string | null;
}

export interface MapAccountInput extends V3Input {
  originalAccount?: OriginalAccountRead;
}

/**
 * Verifies a `revive.map_account` step on V3 spec 3002. V3 emits no event for it, so events alone give at most
 * `unknown` / `extrinsic_finalized` (basis `call_success`). With a supplied `Revive.OriginalAccount` read for the signer's
 * H160 that returns the signer, it is `verified` / `effect_proven` (basis `original_account_readback`). A read for another
 * H160 is ignored (unknown); a read showing no mapping or another account is `effect_mismatch`.
 */
export function verifyMapAccountOutcome(input: MapAccountInput): OutcomeVerdict {
  const head = gate(input, "account mapping");
  if (head) return head;
  const h160 = reviveAddressOf(input.signerAccountId);
  if (!h160) return capped("The signer is not an AccountId32, so its H160 is not known.");
  const read = input.originalAccount;
  if (!read)
    return {
      ...capped(
        "map_account succeeded, but V3 emits no event for it and no Revive.OriginalAccount read was supplied, so the mapping is not proven.",
      ),
      basis: "call_success",
    };
  if (lc(read.h160) !== h160)
    return {
      ...capped(
        `The supplied Revive.OriginalAccount read is for ${read.h160}, not the signer's H160 ${h160}, so it was not used.`,
      ),
      basis: "call_success",
    };
  if (!read.accountId || lc(read.accountId) !== lc(input.signerAccountId))
    return {
      verification: "not_verified",
      coverage: "extrinsic_finalized",
      code: "effect_mismatch",
      reason: read.accountId
        ? `Revive.OriginalAccount(${h160}) maps to ${read.accountId}, not the signer.`
        : `map_account succeeded, but Revive.OriginalAccount(${h160}) is empty.`,
      basis: "original_account_readback",
    };
  const already = read.before !== undefined && lc(read.before) === lc(input.signerAccountId);
  return {
    verification: "verified",
    coverage: "effect_proven",
    reason: already
      ? `Revive.OriginalAccount(${h160}) maps to the signer. It already did before this call, so this shows the mapping holds, not that this call created it.`
      : `Revive.OriginalAccount(${h160}) maps to the signer.`,
    basis: "original_account_readback",
  };
}
