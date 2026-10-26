import { hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { encodeAddress, keccakAsU8a } from "@polkadot/util-crypto";
import type { Hex, Plan, PlanStep, RuntimeFacts, StepReasonCode } from "@seam/compiler";
import { SeamChainError } from "./errors.js";
import { readHead, rpc, toBigInt, toSafeNumber, type RpcClient } from "./rpc-core.js";
import { decodeRuntime, describeDispatchError, encodeRuntime, storageKey } from "./runtime.js";
import { callsForSigning } from "./signing.js";
import { dryRunOne } from "./dryrun-core.js";
import { runtimeApiId } from "./api-id.js";
import type { BlockRef, Estimate, PreflightResult, PreflightStep } from "./types.js";
import { decodeWeightV2Prefix } from "./revive-weight.js";

/** Preflight options shared by the node and browser entries (no connection settings). */
export interface PreflightCoreOptions {
  /** Use this nonce instead of asking the node (system_accountNextIndex). */
  nonce?: number;
  /** Block to estimate at. Default: current best block. */
  at?: Hex;
  /**
   * Real signed extrinsics (same order as the signing requests) to dry-run with system_dryRun. Without them
   * SEAM only has a fake signature, which a dry run rejects, so generic steps get dryRun 'unknown'.
   */
  signedExtrinsics?: Hex[];
}

/** What the node said, per transaction SEAM would send. */
export interface PreflightTxDetail {
  actionIds: string[];
  nonce: number;
  /** payment_queryInfo on the (fake- or really-) signed extrinsic. */
  queryInfo?: {
    weight: string;
    class: string;
    partialFee: string;
    /** 1: weight is a plain number (no proof size). 2: {ref_time, proof_size}. */
    weightVersion: 1 | 2;
    /** proof_size of the Weight V2 answer; absent on Weight V1. */
    proofSize?: string;
  };
  /** payment_queryFeeDetails, when the node returns it. */
  feeDetails?: unknown;
  /** system_dryRun result (only with real signed extrinsics). */
  dryRun?: {
    outcome: "ok" | "failed" | "unknown";
    detail: string;
    /** Raw ApplyExtrinsicResult hex from system_dryRun, when the node answered (absent when unavailable or malformed). */
    raw?: Hex;
    /** The block the dry run ran at. */
    at?: { number: number; hash: Hex };
  };
  error?: string;
}

/**
 * SEAM-018: what was really simulated. `basis` per step:
 *   signed_dry_run        system_dryRun of the real signed transaction passed (atomic: the whole batch)
 *   contract_dry_run      ContractsApi_call of this call alone against current state
 *   asset_existence_check only that the asset exists; not balances, permissions or later state
 *   fee_estimate_only     payment_queryInfo only; the call itself was not executed
 *   unobserved            revive.call / nfts.mint: no real Portaldot V3 metadata has ever been observed, so nothing
 *                         said about these steps is evidence of anything. Never upgraded, whatever the node returns.
 */
export type CoverageBasis =
  | "signed_dry_run"
  | "contract_dry_run"
  | "asset_existence_check"
  | "fee_estimate_only"
  | "unobserved";
export interface SimulationCoverage {
  /** 'signed_dry_run' only for an atomic plan whose real signed batch dry-ran ok. Otherwise 'none'. Never 'none' hidden behind per-step ok. */
  wholePlan: "signed_dry_run" | "none";
  steps: {
    actionId: string;
    basis: CoverageBasis;
    proves: string;
    /** Compiler reason code of an unavailable revive.call / nfts.mint step, passed through unchanged. */
    reasonCode?: StepReasonCode;
  }[];
  summary: string;
}

/** The two step kinds whose layout SEAM has never observed on a real Portaldot V3 chain. */
export const V3_PREFLIGHT_KINDS: readonly string[] = ["revive.call", "nfts.mint"];
const isV3Step = (s: PlanStep) => V3_PREFLIGHT_KINDS.includes(s.kind);

/** What preflight did and did not do for one revive.call / nfts.mint step. */
export interface V3StepPreflight {
  actionId: string;
  kind: "revive.call" | "nfts.mint";
  /** 'encoded': the compiler produced a call. 'unavailable': it did not; reasonCode/reason are the compiler's, unchanged. */
  compiler: "encoded" | "unavailable";
  reasonCode?: StepReasonCode;
  reason?: string;
  simulation: {
    /** True only when the node was actually asked to estimate or dry-run this call. */
    attempted: boolean;
    /** Which node methods answered, e.g. 'payment_queryInfo', 'system_dryRun'. */
    via: string[];
    /** Always a statement of limits; never a claim that the call would succeed. */
    note: string;
  };
  /** Whether state_getRuntimeVersion lists ReviveApi. SEAM never calls ReviveApi_call: its layout is unverified. */
  reviveApi?: "listed" | "not_listed" | "unknown";
}

/**
 * Revive needs the signer's account mapped (Revive.map_account) before it can act. 'unknown' unless the metadata
 * shows the pallet's map_account call AND an OriginalAccount storage entry that, read from chain state, maps the
 * signer's derived H160 back to the signer. Anything else (missing, unreadable, different account) is 'unknown',
 * never 'mapped'. The derivation is the generic pallet-revive rule, NOT verified against Portaldot V3.
 */
export interface AccountMappingInfo {
  status: "unknown" | "mapped";
  mapAccountInMetadata: boolean;
  reason: string;
}

export interface V3PreflightInfo {
  steps: V3StepPreflight[];
  /** Present when the plan has a revive.call step. */
  accountMapping?: AccountMappingInfo;
  /** Set when the node could not be read for an unavailable plan; atBlock and nonce are then placeholders. */
  chainReadError?: string;
}

export interface PreflightReport {
  /** What was and was not simulated (SEAM-018). */
  coverage: SimulationCoverage;
  /** The agreed PreflightResult shape, ready for evaluatePolicy and createApproval. */
  result: PreflightResult;
  /** Next nonce for the signer, from system_accountNextIndex (or options.nonce). */
  nonce: number;
  nonceSource: "node" | "caller";
  atBlock: BlockRef;
  transactions: PreflightTxDetail[];
  /** Raw contracts_call responses per contracts.call step. */
  contractDryRuns: Record<string, unknown>;
  /** Present only when the plan has revive.call / nfts.mint steps. */
  v3?: V3PreflightInfo;
}

const known = (value: bigint | string): Estimate => ({ value: value.toString() });
const UNKNOWN: Estimate = { unknown: true };

/** Builds a fake-signed extrinsic (signature bytes are filler) for fee/weight estimation. Never submittable. */
export function fakeSignedExtrinsic(
  callHex: Hex,
  facts: RuntimeFacts,
  signerAccountId: Hex,
  nonce: number,
  at: BlockRef,
): Hex {
  const { registry } = encodeRuntime(facts);
  const ext = registry.createType("Extrinsic", { method: callHex }, { version: 4 });
  ext.signFake(encodeAddress(signerAccountId, facts.fingerprint.ss58Prefix), {
    blockHash: at.hash,
    genesisHash: facts.fingerprint.genesisHash,
    nonce,
    runtimeVersion: {
      specVersion: facts.fingerprint.specVersion,
      transactionVersion: facts.fingerprint.transactionVersion,
    } as never,
    era: registry.createType("ExtrinsicEra", { current: at.number, period: 64 }),
  });
  return ext.toHex() as Hex;
}

async function queryInfo(
  client: RpcClient,
  extrinsic: Hex,
  at: Hex,
): Promise<PreflightTxDetail["queryInfo"]> {
  const info = await rpc<{ weight: unknown; class: unknown; partialFee: unknown }>(
    client,
    "payment_queryInfo",
    [extrinsic, at],
  );
  // Weight is a plain u64 on spec 1002; newer nodes return { refTime, proofSize }.
  const w = info.weight as unknown;
  // Weight V1 is a number; Weight V2 is {ref_time, proof_size} (RPC JSON is snake_case) or {refTime, proofSize}.
  // SEAM's weight limit is on ref_time (computation); proof_size is not limited by the policy.
  const v2 = typeof w === "object" && w !== null ? (w as Record<string, unknown>) : undefined;
  const weight = v2 ? toBigInt(v2.ref_time ?? v2.refTime) : toBigInt(w);
  const out: NonNullable<PreflightTxDetail["queryInfo"]> = {
    weight: weight.toString(),
    class: String(info.class),
    partialFee: toBigInt(info.partialFee).toString(),
    weightVersion: v2 ? 2 : 1,
  };
  if (v2) {
    const proof = v2.proof_size ?? v2.proofSize;
    // A V2 answer without a proof size stays unknown; never filled with 0.
    if (proof !== undefined && proof !== null) out.proofSize = toBigInt(proof).toString();
  }
  return out;
}

/** ink! dry run with contracts_call (spec 1002 shape: { debugMessage, gasConsumed, result: { Ok | Err } }). */
async function contractDryRun(
  client: RpcClient,
  facts: RuntimeFacts,
  plan: Plan,
  step: PlanStep,
  at: Hex,
): Promise<ContractDryRun> {
  const a = step.decodedArgs;
  const dest = a.contractAccountId ?? a.contract;
  if (!dest || a.data === undefined || a.gasLimit === undefined || a.value === undefined) {
    return {
      outcome: "unknown",
      note: "contract dry run skipped: the plan step is missing contract, value, gasLimit or data",
    };
  }
  const ss58 = (v: string) =>
    v.startsWith("0x") ? encodeAddress(v, facts.fingerprint.ss58Prefix) : v;
  const req = {
    origin: encodeAddress(plan.signer.publicKey, facts.fingerprint.ss58Prefix),
    dest: ss58(dest),
    value: `0x${BigInt(a.value).toString(16)}`,
    gasLimit: `0x${BigInt(a.gasLimit).toString(16)}`,
    inputData: a.data,
  };
  let raw: Record<string, unknown>;
  try {
    raw = await rpc<Record<string, unknown>>(client, "contracts_call", [req, at]);
  } catch (e) {
    const viaApi = await contractDryRunViaRuntimeApi(
      client,
      facts,
      plan.signer.publicKey,
      dest,
      a.value,
      a.data,
      at,
    );
    if (viaApi) return viaApi;
    return {
      outcome: "unknown",
      note: `contracts_call unavailable: ${(e as Error).message.slice(0, 200)}`,
    };
  }
  const result = raw?.result as Record<string, unknown> | undefined;
  const gas = raw?.gasConsumed !== undefined ? ` (gas consumed ${toBigInt(raw.gasConsumed)})` : "";
  if (result && "Err" in result)
    return {
      outcome: "failed",
      note: `contract dry run failed: ${describeDispatchError(facts, result.Err)}${gas}`,
      raw,
    };
  if (result && "Ok" in result) {
    const flags = Number((result.Ok as { flags?: unknown })?.flags ?? 0);
    if (flags & 1)
      return { outcome: "failed", note: `contract dry run reverted (flags ${flags})${gas}`, raw };
    return {
      outcome: "ok",
      note: `contract dry run ok${gas}; state at this block, before earlier steps run`,
      raw,
    };
  }
  return {
    outcome: "unknown",
    note: "contracts_call returned a shape SEAM does not recognise",
    raw,
  };
}

interface ContractDryRun {
  outcome: "ok" | "failed" | "unknown";
  note: string;
  raw?: unknown;
  /** gas_required.proof_size from ContractsApi_call (Weight V2 runtimes), when the node gave it. */
  proofSizeRequired?: string;
}

/** blake2_64("ContractsApi") as listed in RuntimeVersion.apis. */
const CONTRACTS_API_ID = "0x68b66ba122c93fa7";
const CONTRACT_RESULT_V2 = {
  SeamContractStorageDeposit: { _enum: { Refund: "u128", Charge: "u128" } },
  SeamExecReturnValue: { flags: "u32", data: "Bytes" },
  SeamContractResultV2: {
    gasConsumed: "WeightV2",
    gasRequired: "WeightV2",
    storageDeposit: "SeamContractStorageDeposit",
    debugMessage: "Bytes",
    result: "Result<SeamExecReturnValue, DispatchError>",
    events: "Option<Vec<EventRecord>>",
  },
};

/**
 * Newer nodes dropped the contracts_call RPC; the same dry run is the ContractsApi_call runtime API (v2) via
 * state_call. Only used when the runtime lists ContractsApi version 2; gas_limit and storage_deposit_limit are
 * None so the runtime reports what the call needs. Returns undefined when this path doesn't apply.
 */
async function contractDryRunViaRuntimeApi(
  client: RpcClient,
  facts: RuntimeFacts,
  origin: string,
  dest: string,
  value: string,
  data: string,
  at: Hex,
): Promise<ContractDryRun | undefined> {
  try {
    const version = await rpc<{ apis?: [string, number][] }>(client, "state_getRuntimeVersion", [
      at,
    ]);
    const api = version?.apis?.find(([id]) => id === CONTRACTS_API_ID);
    if (!api || api[1] !== 2) return undefined;
    const { registry } = decodeRuntime(facts);
    registry.register(CONTRACT_RESULT_V2 as any);
    const params = u8aConcat(
      registry.createType("AccountId", origin).toU8a(),
      registry.createType("AccountId", dest).toU8a(),
      registry.createType("u128", value).toU8a(),
      registry.createType("Option<WeightV2>", null).toU8a(),
      registry.createType("Option<u128>", null).toU8a(),
      registry.createType("Bytes", data).toU8a(),
    );
    const out = await rpc<string>(client, "state_call", [
      "ContractsApi_call",
      u8aToHex(params),
      at,
    ]);
    const res = registry.createType("SeamContractResultV2", hexToU8a(out)) as any;
    const raw = {
      via: "state_call ContractsApi_call (v2)",
      result: res.toJSON(),
      debugMessage: res.debugMessage.toUtf8(),
    };
    const proofSizeRequired = res.gasRequired.proofSize.toString() as string;
    const gas = ` (gas required refTime ${res.gasRequired.refTime.toString()}, proofSize ${proofSizeRequired})`;
    if (res.result.isErr)
      return {
        outcome: "failed",
        note: `contract dry run failed: ${describeDispatchError(facts, res.result.asErr.toJSON())}${gas}`,
        raw,
        proofSizeRequired,
      };
    const flags = res.result.asOk.flags.toNumber();
    if (flags & 1)
      return {
        outcome: "failed",
        note: `contract dry run reverted (flags ${flags})${gas}`,
        raw,
        proofSizeRequired,
      };
    return {
      outcome: "ok",
      note: `contract dry run ok via ContractsApi_call${gas}; state at this block, before earlier steps run`,
      raw,
      proofSizeRequired,
    };
  } catch (e) {
    return {
      outcome: "unknown",
      note: `ContractsApi_call dry run could not be read: ${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/** Assets steps: an empty Assets.Asset entry means the asset does not exist, so the step must fail. Anything else stays unknown. */
async function assetExists(
  client: RpcClient,
  facts: RuntimeFacts,
  assetId: string,
  at: Hex,
): Promise<boolean | undefined> {
  try {
    const query = (decodeRuntime(facts).decorated().query as any).assets?.asset;
    if (!query) return undefined;
    const key = storageKey(query, assetId);
    const value = await rpc<string | null>(client, "state_getStorage", [key, at]);
    return value !== null && value !== undefined && value !== "0x";
  } catch {
    return undefined;
  }
}

type StorageEntryLoose = Parameters<typeof storageKey>[0] & {
  meta: { type: { isMap: boolean; asMap: { value: unknown }; asPlain: unknown } };
};

/** Reads one storage value and decodes it strictly (every byte must be used). null: no entry. Throws on any other problem. */
async function readStorageValue(
  client: RpcClient,
  facts: RuntimeFacts,
  entry: StorageEntryLoose,
  args: unknown[],
  at: Hex,
): Promise<Record<string, { toBigInt(): bigint }> | null> {
  const { registry } = decodeRuntime(facts);
  const raw = await rpc<string | null>(client, "state_getStorage", [
    storageKey(entry, ...args),
    at,
  ]);
  if (raw === null || raw === undefined || raw === "0x") return null;
  const t = entry.meta.type.isMap ? entry.meta.type.asMap.value : entry.meta.type.asPlain;
  const r = registry as unknown as {
    createLookupType(t: unknown): string;
    createTypeUnsafe(t: string, p: unknown[], o: { isPedantic: boolean }): unknown;
  };
  const v = r.createTypeUnsafe(r.createLookupType(t), [hexToU8a(raw)], { isPedantic: true }) as {
    isSome?: boolean;
    unwrap?: () => unknown;
  };
  const inner = v.isSome === undefined ? v : v.isSome ? v.unwrap!() : null;
  return inner as Record<string, { toBigInt(): bigint }> | null;
}

/**
 * Running asset-balance check for a sequence of assets.transfer steps, before anything is signed. The signer's
 * Assets.Account balance and the asset's minBalance are read at the preflight block, then each step's amount is
 * taken off in plan order. A step fails if its amount exceeds the running balance, or if it would leave the signer
 * with 0 < remaining < minBalance, or (transfer_keep_alive, which the compiler uses for assets.transfer) with
 * remaining < minBalance, i.e. it cannot empty the account. Only failures are reported: a passing check never makes
 * a step 'ok'. If anything cannot be read or decoded, or the call is neither Assets.transfer nor
 * Assets.transfer_keep_alive, the step is left as it was (unknown). Later steps are not checked after a failure.
 */
async function assetBalanceFailures(
  client: RpcClient,
  facts: RuntimeFacts,
  plan: Plan,
  signerSs58: string,
  at: Hex,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!plan.steps.some((s) => s.kind === "assets.transfer")) return out;
  let decorated: {
    query?: { assets?: { account?: StorageEntryLoose; asset?: StorageEntryLoose } };
    tx?: { assets?: Record<string, { callIndex?: Uint8Array } | undefined> };
  };
  try {
    decorated = decodeRuntime(facts).decorated() as never;
  } catch {
    return out;
  }
  const account = decorated.query?.assets?.account;
  const asset = decorated.query?.assets?.asset;
  if (!account || !asset) return out;
  const idx = (n: string) => {
    const c = decorated.tx?.assets?.[n]?.callIndex;
    return c ? u8aToHex(c) : undefined;
  };
  const keepAliveIdx = idx("transferKeepAlive");
  const transferIdx = idx("transfer");
  const running = new Map<string, { balance: bigint; minBalance: bigint } | null>();
  const read = async (assetId: string) => {
    if (running.has(assetId)) return running.get(assetId)!;
    let v: { balance: bigint; minBalance: bigint } | null = null;
    try {
      const details = await readStorageValue(client, facts, asset, [assetId], at);
      if (details?.minBalance) {
        const acct = await readStorageValue(client, facts, account, [assetId, signerSs58], at);
        const balance = acct === null ? 0n : acct.balance?.toBigInt();
        if (balance !== undefined) v = { balance, minBalance: details.minBalance.toBigInt() };
      }
    } catch {
      v = null;
    }
    running.set(assetId, v);
    return v;
  };
  for (const [i, s] of plan.steps.entries()) {
    const a = s.decodedArgs;
    if (s.kind === "assets.mint" && a.assetId !== undefined && a.recipient === signerSs58) {
      const r = running.get(a.assetId);
      if (r && a.amount !== undefined) r.balance += BigInt(a.amount);
      continue;
    }
    if (s.kind !== "assets.transfer" || a.assetId === undefined || a.amount === undefined) continue;
    const ci = s.encodedCall ? s.encodedCall.slice(0, 6).toLowerCase() : undefined;
    const keepAlive = ci !== undefined && ci === keepAliveIdx;
    if (!keepAlive && (ci === undefined || ci !== transferIdx)) {
      running.set(a.assetId, null); // unknown call: stop checking this asset
      continue;
    }
    const r = await read(a.assetId);
    if (!r) continue;
    const amount = BigInt(a.amount);
    const who = `${signerSs58} (the signer)`;
    if (a.recipient === signerSs58) continue; // to itself: balance unchanged
    if (amount > r.balance) {
      out.set(
        s.actionId,
        `asset balance check: step ${i + 1} would transfer ${amount} of asset ${a.assetId} but ${who} would hold only ${r.balance} by then`,
      );
      break;
    }
    const remaining = r.balance - amount;
    if ((remaining > 0n || keepAlive) && remaining < r.minBalance) {
      out.set(
        s.actionId,
        `asset balance check: step ${i + 1} would leave ${who} with ${remaining} of asset ${a.assetId}, below minBalance ${r.minBalance}` +
          (keepAlive ? "; transfer_keep_alive cannot empty the account" : ""),
      );
      break;
    }
    r.balance = remaining;
  }
  return out;
}

/**
 * Native tPOT check before signing (mirrors the asset minBalance check): the signer's System.Account free balance at
 * the preflight block, less each transaction's node-quoted fee (payment_queryInfo partialFee; atomic: one fee for the
 * batch) and each step's native `value`, in plan order. The fee is withdrawn with Preservation::Preserve, so the
 * signer must keep at least max(existential deposit, frozen - reserved) afterwards. A step that would go below it is
 * reported as a failure. Only failures are reported: a pass never makes a step 'ok'. Any fee, value, balance or ED
 * that cannot be read leaves every step as it was (unknown).
 */
async function nativeBalanceFailures(
  client: RpcClient,
  facts: RuntimeFacts,
  plan: Plan,
  signerSs58: string,
  at: Hex,
  transactions: PreflightTxDetail[],
  atomic: boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const d = decodeRuntime(facts).decorated() as unknown as {
      query?: { system?: { account?: StorageEntryLoose } };
      consts?: { balances?: { existentialDeposit?: { toBigInt(): bigint } } };
    };
    const ed = d.consts?.balances?.existentialDeposit?.toBigInt();
    const entry = d.query?.system?.account;
    if (ed === undefined || !entry) return out;
    const acct = (await readStorageValue(client, facts, entry, [signerSs58], at)) as unknown as {
      data?: Record<string, { toBigInt(): bigint } | undefined>;
    } | null;
    // No System.Account entry: the account holds nothing.
    const data = acct === null ? {} : acct.data;
    if (!data) return out;
    const free = acct === null ? 0n : data.free?.toBigInt();
    if (free === undefined) return out;
    const frozen = data.frozen?.toBigInt() ?? data.miscFrozen?.toBigInt() ?? 0n;
    const reserved = data.reserved?.toBigInt() ?? 0n;
    const locked = frozen > reserved ? frozen - reserved : 0n;
    const keep = locked > ed ? locked : ed;
    const fees: bigint[] = [];
    for (const t of atomic ? transactions.slice(0, 1) : transactions) {
      if (!t.queryInfo) return out;
      fees.push(BigInt(t.queryInfo.partialFee));
    }
    const valueKinds = new Set(["contracts.call", "revive.call", "revive.instantiate_with_code"]);
    let balance = free;
    for (const [i, s] of plan.steps.entries()) {
      let spend = 0n;
      if (atomic ? i === 0 : true) {
        const f = fees[atomic ? 0 : i];
        if (f === undefined) return out;
        spend += f;
      }
      if (valueKinds.has(s.kind)) {
        const v = s.decodedArgs.value;
        if (v === undefined || !/^\d+$/.test(String(v))) return out;
        spend += BigInt(v);
      }
      const remaining = balance - spend;
      if (remaining < keep) {
        out.set(
          s.actionId,
          `native balance check: step ${i + 1} needs ${spend} (fee${valueKinds.has(s.kind) ? " + value" : ""}) but ${signerSs58} (the signer) would keep ${remaining < 0n ? 0n : remaining} of ${balance}, below the ${keep === ed ? `existential deposit ${ed}` : `frozen amount ${keep}`} it must keep`,
        );
        break;
      }
      balance = remaining;
    }
  } catch {
    return new Map();
  }
  return out;
}

type DecoratedLoose = {
  tx?: { revive?: { mapAccount?: unknown } };
  query?: { revive?: { originalAccount?: Parameters<typeof storageKey>[0] } };
};

const NOT_MAPPED_UNKNOWN = (mapAccountInMetadata: boolean, reason: string): AccountMappingInfo => ({
  status: "unknown",
  mapAccountInMetadata,
  reason,
});

/** Fail closed: 'mapped' only with map_account in the metadata and a chain-state entry pointing back at the signer. Never throws. */
async function readAccountMapping(
  client: RpcClient,
  facts: RuntimeFacts,
  signerAccountId: Hex,
  at: Hex,
): Promise<AccountMappingInfo> {
  try {
    const decorated = decodeRuntime(facts).decorated() as unknown as DecoratedLoose;
    const hasCall = Boolean(decorated.tx?.revive?.mapAccount);
    if (!hasCall)
      return NOT_MAPPED_UNKNOWN(
        false,
        "the metadata has no Revive.map_account call, so account mapping cannot be observed",
      );
    const query = decorated.query?.revive?.originalAccount;
    if (!query)
      return NOT_MAPPED_UNKNOWN(
        true,
        "Revive.map_account exists in the metadata but there is no OriginalAccount storage entry to confirm a mapping against",
      );
    const h160 = u8aToHex(keccakAsU8a(hexToU8a(signerAccountId)).slice(12));
    const raw = await rpc<string | null>(client, "state_getStorage", [storageKey(query, h160), at]);
    if (raw === null || raw === undefined || raw === "0x")
      return NOT_MAPPED_UNKNOWN(
        true,
        "no OriginalAccount entry for the signer's derived address was found; the account is not known to be mapped",
      );
    const stored = u8aToHex(hexToU8a(raw).slice(0, 32));
    return stored.toLowerCase() === signerAccountId.toLowerCase()
      ? {
          status: "mapped",
          mapAccountInMetadata: true,
          reason:
            "OriginalAccount maps the signer's derived address back to the signer (generic pallet-revive rule; not verified against Portaldot V3)",
        }
      : NOT_MAPPED_UNKNOWN(
          true,
          "an OriginalAccount entry exists for the derived address but points at a different account",
        );
  } catch (e) {
    return NOT_MAPPED_UNKNOWN(
      false,
      `account mapping could not be read: ${(e as Error).message.slice(0, 200)}`,
    );
  }
}

const SIMULATION_LIMITS =
  "no real Portaldot V3 metadata has been observed, so nothing here is evidence that this call would succeed";

/**
 * A plan with revive.call / nfts.mint steps the compiler marked unavailable has no signable calls. Report
 * each step with the compiler's reason code unchanged and attempt NO simulation. The node is read only for the head
 * and nonce; if even that fails the placeholders are flagged in v3.chainReadError. Never throws.
 */
async function preflightUnavailable(
  client: RpcClient,
  plan: Plan,
  facts: RuntimeFacts,
  opts: PreflightCoreOptions,
): Promise<PreflightReport> {
  let atBlock: BlockRef = { number: 0, hash: `0x${"00".repeat(32)}` as Hex };
  let nonce = opts.nonce ?? 0;
  let nonceSource: PreflightReport["nonceSource"] = "caller";
  let chainReadError: string | undefined;
  let mapping: AccountMappingInfo | undefined;
  const hasRevive = plan.steps.some((s) => s.kind === "revive.call");
  try {
    await (async () => {
      atBlock = opts.at
        ? {
            hash: opts.at,
            number: toSafeNumber(
              (await rpc<{ number: unknown }>(client, "chain_getHeader", [opts.at])).number,
            ),
          }
        : await readHead(client);
      if (opts.nonce === undefined) {
        nonce = toSafeNumber(
          await rpc(client, "system_accountNextIndex", [
            encodeAddress(plan.signer.publicKey, facts.fingerprint.ss58Prefix),
          ]),
        );
        nonceSource = "node";
      }
      if (hasRevive)
        mapping = await readAccountMapping(client, facts, plan.signer.publicKey, atBlock.hash);
    })();
  } catch (e) {
    chainReadError = `node not read: ${(e as Error).message.slice(0, 200)}; block and nonce are placeholders`;
  }
  if (hasRevive && !mapping)
    mapping = NOT_MAPPED_UNKNOWN(false, chainReadError ?? "account mapping was not read");
  const steps: PreflightStep[] = [];
  const coverage: SimulationCoverage["steps"] = [];
  const v3Steps: V3StepPreflight[] = [];
  for (const s of plan.steps) {
    const code = s.reasonCode ? `${s.reasonCode}: ` : "";
    const reason = `${code}${s.reason ?? "not executable"}`;
    steps.push({
      actionId: s.actionId,
      weight: UNKNOWN,
      fee: UNKNOWN,
      storageDeposit: UNKNOWN,
      proofSize: UNKNOWN,
      dryRun: "unknown",
      note: `not simulated: the compiler marked this step unavailable (${reason})`,
    });
    if (isV3Step(s)) {
      coverage.push({
        actionId: s.actionId,
        basis: "unobserved",
        proves: "nothing",
        ...(s.reasonCode ? { reasonCode: s.reasonCode } : {}),
      });
      v3Steps.push({
        actionId: s.actionId,
        kind: s.kind as V3StepPreflight["kind"],
        compiler: s.status === "ok" && s.encodedCall ? "encoded" : "unavailable",
        ...(s.reasonCode ? { reasonCode: s.reasonCode } : {}),
        ...(s.reason ? { reason: s.reason } : {}),
        simulation: {
          attempted: false,
          via: [],
          note: `not attempted: the plan is not signable; ${SIMULATION_LIMITS}`,
        },
      });
    } else {
      coverage.push({
        actionId: s.actionId,
        basis: "fee_estimate_only",
        proves: "nothing: no simulation was attempted for an unavailable plan",
        ...(s.reasonCode ? { reasonCode: s.reasonCode } : {}),
      });
    }
  }
  return {
    coverage: {
      wholePlan: "none",
      steps: coverage,
      summary: `Not simulated: the plan is unavailable (${plan.modeReason}). Reason codes are the compiler's, unchanged.`,
    },
    result: { steps, totalFee: UNKNOWN },
    nonce,
    nonceSource,
    atBlock,
    transactions: [],
    contractDryRuns: {},
    v3: {
      steps: v3Steps,
      ...(mapping ? { accountMapping: mapping } : {}),
      ...(chainReadError ? { chainReadError } : {}),
    },
  };
}

/** Revive step kinds that get dryRunProofSize / callInfoProofSize. */
export const REVIVE_PROOF_KINDS: readonly string[] = [
  "revive.call",
  "revive.instantiate_with_code",
];

const hexBody = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
const compactHex = (n: number): string => {
  const le = (v: number, bytes: number) =>
    Array.from({ length: bytes }, (_, i) =>
      ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, "0"),
    ).join("");
  if (n < 1 << 6) return le(n << 2, 1);
  if (n < 1 << 14) return le((n << 2) | 1, 2);
  if (n < 2 ** 30) return le(((n << 2) | 2) >>> 0, 4);
  throw new Error("input too long");
};
const bytesHex = (h: string) => compactHex(hexBody(h).length / 2) + hexBody(h);
const u128Hex = (v: string | undefined) => {
  let x = BigInt(v ?? "0");
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += (x & 0xffn).toString(16).padStart(2, "0");
    x >>= 8n;
  }
  return out;
};
const u32Hex = (n: number) => u128Hex(String(n)).slice(0, 8);

/**
 * Read-only Revive proof sizes for one step, at the preflight block. dryRunProofSize: ReviveApi_call /
 * ReviveApi_instantiate weight_required.proof_size (gas and deposit limits None, origin = plan signer). A 0 is
 * UNKNOWN (not metered), never known(0); no answer is UNKNOWN. callInfoProofSize: the total proof_size of
 * TransactionPaymentCallApi_query_call_info(call, len). Never throws; every gap is a note.
 */
export async function reviveProofSizes(
  client: RpcClient,
  step: Pick<PlanStep, "kind" | "decodedArgs" | "encodedCall">,
  originAccountId: Hex,
  at: Hex,
  len: number,
): Promise<{ dryRunProofSize: Estimate; callInfoProofSize: Estimate; notes: string[] }> {
  const notes: string[] = [];
  const a = step.decodedArgs;
  let dryRunProofSize: Estimate = UNKNOWN;
  let callInfoProofSize: Estimate = UNKNOWN;
  const isCall = step.kind === "revive.call";
  const apiName = isCall ? "ReviveApi_call" : "ReviveApi_instantiate";
  try {
    const origin = hexBody(originAccountId);
    if (origin.length !== 64) throw new Error("signer is not a 32-byte AccountId");
    const params = isCall
      ? origin +
        hexBody(a.contract ?? "") +
        u128Hex(a.value) +
        "00" +
        "00" +
        bytesHex(a.data ?? "0x")
      : origin +
        u128Hex(a.value) +
        "00" +
        "00" +
        "00" +
        bytesHex(a.code ?? "0x") +
        bytesHex(a.data ?? "0x") +
        (a.salt ? "01" + hexBody(a.salt) : "00");
    if (isCall && hexBody(a.contract ?? "").length !== 40) throw new Error("no H160 contract");
    const raw = await rpc<string>(client, "state_call", [apiName, `0x${params}`, at]);
    const ps = decodeWeightV2Prefix(raw).weightRequired.proofSize;
    if (ps === "0")
      notes.push(
        `dry-run proof size: unknown, ${apiName} weight_required.proof_size is 0 (not metered; not a bound)`,
      );
    else {
      dryRunProofSize = known(ps);
      notes.push(`dry-run proof size ${ps} (${apiName} weight_required.proof_size)`);
    }
  } catch (e) {
    notes.push(
      `dry-run proof size: unknown, ${apiName} gave no answer (${(e as Error).message.slice(0, 120)})`,
    );
  }
  try {
    if (!step.encodedCall) throw new Error("step has no encoded call");
    const raw = await rpc<string>(client, "state_call", [
      "TransactionPaymentCallApi_query_call_info",
      `0x${hexBody(step.encodedCall)}${u32Hex(len)}`,
      at,
    ]);
    // RuntimeDispatchInfo starts with weight: Weight { Compact ref_time, Compact proof_size }.
    const ps = decodeWeightV2Prefix(raw).weightConsumed.proofSize;
    callInfoProofSize = known(ps);
    notes.push(
      `call-info proof size ${ps} (query_call_info total: explicit cap + static overhead)`,
    );
  } catch (e) {
    notes.push(
      `call-info proof size: unknown, query_call_info gave no answer (${(e as Error).message.slice(0, 120)})`,
    );
  }
  return { dryRunProofSize, callInfoProofSize, notes };
}

/**
 * Preflight for a compiled plan: next nonce, fee and weight from payment_queryInfo on a fake-signed
 * extrinsic per transaction, contracts_call dry runs for contracts.call steps, an asset-existence check
 * for asset steps, and system_dryRun when real signed extrinsics are given. Anything the node doesn't
 * report is { unknown: true }, never guessed. Read-only.
 */
export async function preflightWithClient(
  client: RpcClient,
  plan: Plan,
  facts: RuntimeFacts,
  opts: PreflightCoreOptions = {},
): Promise<PreflightReport> {
  if (plan.fingerprintDigest !== facts.fingerprintDigest)
    throw new SeamChainError("FACTS_MISMATCH", "plan was compiled for different runtime facts");
  if (plan.mode === "unavailable" && plan.steps.some(isV3Step))
    return preflightUnavailable(client, plan, facts, opts);
  const txs = callsForSigning(plan);
  if (opts.signedExtrinsics && opts.signedExtrinsics.length !== txs.length) {
    throw new SeamChainError(
      "PLAN_NOT_SIGNABLE",
      `expected ${txs.length} signed extrinsics, got ${opts.signedExtrinsics.length}`,
    );
  }
  return (async () => {
    const atBlock: BlockRef = opts.at
      ? {
          hash: opts.at,
          number: toSafeNumber(
            (await rpc<{ number: unknown }>(client, "chain_getHeader", [opts.at])).number,
          ),
        }
      : await readHead(client);
    const version = await rpc<{
      specVersion: number;
      transactionVersion: number;
      apis?: [string, number][];
    }>(client, "state_getRuntimeVersion", [atBlock.hash]);
    if (
      version.specVersion !== facts.fingerprint.specVersion ||
      version.transactionVersion !== facts.fingerprint.transactionVersion
    ) {
      throw new SeamChainError(
        "RUNTIME_CHANGED",
        `node runs spec ${version.specVersion}/tx ${version.transactionVersion}, facts are for spec ${facts.fingerprint.specVersion}/tx ${facts.fingerprint.transactionVersion}; rediscover`,
      );
    }
    const reviveApi: V3StepPreflight["reviveApi"] = Array.isArray(version.apis)
      ? version.apis.some(([id]) => id === runtimeApiId("ReviveApi"))
        ? "listed"
        : "not_listed"
      : "unknown";
    const signerSs58 = encodeAddress(plan.signer.publicKey, facts.fingerprint.ss58Prefix);
    let nonce: number;
    let nonceSource: PreflightReport["nonceSource"];
    if (opts.nonce !== undefined) {
      nonce = opts.nonce;
      nonceSource = "caller";
    } else {
      nonce = toSafeNumber(await rpc(client, "system_accountNextIndex", [signerSs58]));
      nonceSource = "node";
    }

    const transactions: PreflightTxDetail[] = [];
    for (const [i, tx] of txs.entries()) {
      const detail: PreflightTxDetail = { actionIds: tx.actionIds, nonce: nonce + i };
      const ext =
        opts.signedExtrinsics?.[i] ??
        fakeSignedExtrinsic(tx.callHex, facts, plan.signer.publicKey, nonce + i, atBlock);
      try {
        detail.queryInfo = await queryInfo(client, ext, atBlock.hash);
      } catch (e) {
        detail.error = (e as Error).message;
      }
      try {
        detail.feeDetails = await rpc(client, "payment_queryFeeDetails", [ext, atBlock.hash]);
      } catch {
        /* optional */
      }
      if (opts.signedExtrinsics?.[i]) {
        const d = await dryRunOne(client, facts, ext, i, atBlock.hash);
        detail.dryRun = {
          outcome: d.outcome,
          detail: `system_dryRun: ${d.detail}`,
          ...(d.raw ? { raw: d.raw } : {}),
          at: { number: atBlock.number, hash: atBlock.hash },
        };
      }
      transactions.push(detail);
    }

    const atomic = plan.mode === "atomic_verified" || plan.mode === "atomic_unverified";
    // Atomic: the batch is charged once (totalFee), but the policy limits weight per step, so each inner
    // call is also estimated on its own.
    const standalone = new Map<string, PreflightTxDetail["queryInfo"] | undefined>();
    if (atomic) {
      for (const s of plan.steps) {
        try {
          standalone.set(
            s.actionId,
            await queryInfo(
              client,
              fakeSignedExtrinsic(s.encodedCall!, facts, plan.signer.publicKey, nonce, atBlock),
              atBlock.hash,
            ),
          );
        } catch {
          standalone.set(s.actionId, undefined);
        }
      }
    }

    // Before signing only: with real signed extrinsics each step's own system_dryRun decides, and earlier steps may
    // already be on chain (their amounts are then in the balance read here).
    const balanceFailures = opts.signedExtrinsics
      ? new Map<string, string>()
      : await assetBalanceFailures(client, facts, plan, signerSs58, atBlock.hash);
    const nativeFailures = opts.signedExtrinsics
      ? new Map<string, string>()
      : await nativeBalanceFailures(
          client,
          facts,
          plan,
          signerSs58,
          atBlock.hash,
          transactions,
          atomic,
        );
    const contractDryRuns: Record<string, unknown> = {};
    const v3Steps: V3StepPreflight[] = [];
    const steps: PreflightStep[] = [];
    const coverage: SimulationCoverage["steps"] = [];
    for (const [i, s] of plan.steps.entries()) {
      const tx = atomic ? transactions[0]! : transactions[i]!;
      const info = atomic ? standalone.get(s.actionId) : tx.queryInfo;
      const notes: string[] = [];
      let dryRun: PreflightStep["dryRun"] = "unknown";
      let contractProof: string | undefined;
      if (s.kind === "contracts.call") {
        const c = await contractDryRun(client, facts, plan, s, atBlock.hash);
        dryRun = c.outcome;
        notes.push(c.note);
        contractProof = c.proofSizeRequired;
        if (c.raw !== undefined) contractDryRuns[s.actionId] = c.raw;
      } else if (
        (s.kind === "assets.transfer" || s.kind === "assets.mint") &&
        s.decodedArgs.assetId !== undefined
      ) {
        const exists = await assetExists(client, facts, s.decodedArgs.assetId, atBlock.hash);
        if (exists === false) {
          dryRun = "failed";
          notes.push(
            `asset ${s.decodedArgs.assetId} does not exist on chain (Assets.Asset is empty)`,
          );
        }
        const balanceNote = balanceFailures.get(s.actionId);
        if (balanceNote && dryRun !== "failed") {
          dryRun = "failed";
          notes.push(balanceNote);
        }
      }
      const nativeNote = nativeFailures.get(s.actionId);
      if (nativeNote) {
        dryRun = "failed";
        notes.push(nativeNote);
      }
      if (tx.dryRun && dryRun !== "failed") {
        if (tx.dryRun.outcome === "failed") dryRun = "failed";
        else if (tx.dryRun.outcome === "ok" && !atomic && s.kind !== "contracts.call")
          dryRun = "ok";
        notes.push(tx.dryRun.detail);
      } else if (!tx.dryRun && dryRun === "unknown") {
        notes.push(
          "no dry run: needs the real signed transaction (system_dryRun rejects a fake signature)",
        );
      }
      if (atomic)
        notes.push(
          "atomic: weight and fee here are for this call on its own; the batch is charged once (totalFee)",
        );
      if (!info)
        notes.push(
          `payment_queryInfo gave no answer${tx.error ? ` (${tx.error.slice(0, 120)})` : ""}`,
        );
      notes.push("storage deposit: not reported by this runtime");
      // proofSize: the transaction's pre-dispatch proof_size (for a contract call it already includes the
      // gas_limit's proof_size, so it is the upper bound the chain will accept). Never 0 when not reported.
      let proofSize: Estimate = UNKNOWN;
      if (info?.weightVersion === 1)
        notes.push(
          "proof size: unknown, this runtime has no proof size (Weight V1: weight is a single number)",
        );
      else if (info?.proofSize !== undefined) proofSize = known(info.proofSize);
      else
        notes.push(
          info
            ? "proof size: unknown, payment_queryInfo gave a two-part weight without proof_size"
            : "proof size: unknown, payment_queryInfo gave no answer",
        );
      if (contractProof !== undefined)
        notes.push(`contract needs proof size ${contractProof} (ContractsApi_call gas_required)`);
      let reviveProof: { dryRunProofSize: Estimate; callInfoProofSize: Estimate } | undefined;
      if (REVIVE_PROOF_KINDS.includes(s.kind)) {
        const ext = s.encodedCall
          ? fakeSignedExtrinsic(s.encodedCall, facts, plan.signer.publicKey, nonce, atBlock)
          : "0x";
        const r = await reviveProofSizes(
          client,
          s,
          plan.signer.publicKey,
          atBlock.hash,
          (ext.length - 2) / 2,
        );
        reviveProof = {
          dryRunProofSize: r.dryRunProofSize,
          callInfoProofSize: r.callInfoProofSize,
        };
        notes.push(...r.notes);
      }
      const batchOk = atomic && tx.dryRun?.outcome === "ok";
      const v3 = isV3Step(s);
      const basis: CoverageBasis = v3
        ? "unobserved"
        : batchOk || (!atomic && tx.dryRun?.outcome === "ok")
          ? "signed_dry_run"
          : s.kind === "contracts.call" && dryRun !== "unknown"
            ? "contract_dry_run"
            : (s.kind === "assets.transfer" || s.kind === "assets.mint") &&
                s.decodedArgs.assetId !== undefined &&
                dryRun !== "failed" &&
                !tx.dryRun
              ? "asset_existence_check"
              : "fee_estimate_only";
      const proves = {
        unobserved: "nothing",
        signed_dry_run: atomic
          ? "the whole signed batch dry-ran ok at the current block"
          : "this signed transaction dry-ran ok alone, against current state",
        contract_dry_run:
          "this call alone dry-ran against current state; not the effect of earlier steps",
        asset_existence_check:
          "only that the asset exists; not balances, permissions or state changed by other steps",
        fee_estimate_only: "only a fee and weight estimate; the call was not executed",
      }[basis];
      if (v3) {
        // Never upgrade: a node 'ok' for an unobserved layout is not evidence. A failure still counts.
        if (dryRun === "ok") dryRun = "unknown";
        const via: string[] = [];
        if (info) via.push("payment_queryInfo");
        if (tx.dryRun && tx.dryRun.outcome !== "unknown") via.push("system_dryRun");
        v3Steps.push({
          actionId: s.actionId,
          kind: s.kind as V3StepPreflight["kind"],
          compiler: "encoded",
          simulation: {
            attempted: via.length > 0,
            via,
            note:
              (via.length
                ? `the node answered ${via.join(" and ")}`
                : "the node gave no estimate or dry-run") +
              `; ${SIMULATION_LIMITS}. ReviveApi_call / _instantiate are read only for proof sizes, never as evidence (layout unverified)`,
          },
          ...(s.kind === "revive.call" ? { reviveApi } : {}),
        });
      }
      coverage.push({ actionId: s.actionId, basis, proves });
      notes.push(`simulation coverage: ${basis} (${proves})`);
      steps.push({
        actionId: s.actionId,
        weight: info ? known(info.weight) : UNKNOWN,
        fee: info ? known(info.partialFee) : UNKNOWN,
        storageDeposit: UNKNOWN,
        proofSize,
        ...(reviveProof ?? {}),
        dryRun,
        note: notes.join("; "),
      });
    }

    const fees = transactions.map((t) => t.queryInfo?.partialFee);
    const totalFee: Estimate = fees.every((f) => f !== undefined)
      ? known(fees.reduce((a, f) => a + BigInt(f!), 0n))
      : UNKNOWN;
    const hasV3 = v3Steps.length > 0;
    const wholePlan: SimulationCoverage["wholePlan"] =
      !hasV3 && atomic && transactions[0]?.dryRun?.outcome === "ok" ? "signed_dry_run" : "none";
    const signedOk = transactions.filter((t) => t.dryRun?.outcome === "ok").length;
    const summary = hasV3
      ? "The plan contains revive.call / nfts.mint steps whose layout has never been observed on a real Portaldot V3 chain. Nothing about them is proven, and the plan is not simulated as a whole."
      : wholePlan === "signed_dry_run"
        ? "A signed dry-run of the whole atomic batch passed at the current block. State can still change before it is sent."
        : atomic
          ? "The batch was not simulated as a whole (no signed dry-run of it yet). Per-step results are estimates and checks only."
          : signedOk > 0
            ? `The plan was not simulated as a whole. Only the first step's signed transaction can be dry-run now; later steps depend on earlier ones (${signedOk} of ${transactions.length} signed transactions dry-ran ok).`
            : "The plan was not simulated as a whole. Each step is checked alone against current state; later steps depend on earlier ones.";
    return {
      coverage: { wholePlan, steps: coverage, summary },
      result: { steps, totalFee },
      nonce,
      nonceSource,
      atBlock,
      transactions,
      contractDryRuns,
      ...(hasV3
        ? {
            v3: {
              steps: v3Steps,
              ...(plan.steps.some((x) => x.kind === "revive.call")
                ? {
                    accountMapping: await readAccountMapping(
                      client,
                      facts,
                      plan.signer.publicKey,
                      atBlock.hash,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };
  })();
}
