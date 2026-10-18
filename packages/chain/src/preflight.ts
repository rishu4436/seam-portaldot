import { hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { encodeAddress } from "@polkadot/util-crypto";
import type { Hex, Plan, PlanStep, RuntimeFacts } from "@seam/compiler";
import { SeamChainError } from "./errors.js";
import { readHead } from "./discover.js";
import {
  rpc,
  toBigInt,
  toSafeNumber,
  withClient,
  type ConnectOptions,
  type Endpoint,
  type RpcClient,
} from "./rpc.js";
import { decodeRuntime, describeDispatchError, encodeRuntime, storageKey } from "./runtime.js";
import { callsForSigning } from "./signing.js";
import { dryRunOne } from "./dryrun.js";
import type { BlockRef, Estimate, PreflightResult, PreflightStep } from "./types.js";

export interface PreflightOptions extends ConnectOptions {
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
  dryRun?: { outcome: "ok" | "failed" | "unknown"; detail: string };
  error?: string;
}

/**
 * SEAM-018: what was really simulated. `basis` per step:
 *   signed_dry_run        system_dryRun of the real signed transaction passed (atomic: the whole batch)
 *   contract_dry_run      ContractsApi_call of this call alone against current state
 *   asset_existence_check only that the asset exists; not balances, permissions or later state
 *   fee_estimate_only     payment_queryInfo only; the call itself was not executed
 */
export type CoverageBasis =
  "signed_dry_run" | "contract_dry_run" | "asset_existence_check" | "fee_estimate_only";
export interface SimulationCoverage {
  /** 'signed_dry_run' only for an atomic plan whose real signed batch dry-ran ok. Otherwise 'none'. Never 'none' hidden behind per-step ok. */
  wholePlan: "signed_dry_run" | "none";
  steps: { actionId: string; basis: CoverageBasis; proves: string }[];
  summary: string;
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

/**
 * Preflight for a compiled plan: next nonce, fee and weight from payment_queryInfo on a fake-signed
 * extrinsic per transaction, contracts_call dry runs for contracts.call steps, an asset-existence check
 * for asset steps, and system_dryRun when real signed extrinsics are given. Anything the node doesn't
 * report is { unknown: true }, never guessed. Read-only.
 */
export async function preflight(
  endpoint: Endpoint,
  plan: Plan,
  facts: RuntimeFacts,
  opts: PreflightOptions = {},
): Promise<PreflightReport> {
  if (plan.fingerprintDigest !== facts.fingerprintDigest)
    throw new SeamChainError("FACTS_MISMATCH", "plan was compiled for different runtime facts");
  const txs = callsForSigning(plan);
  if (opts.signedExtrinsics && opts.signedExtrinsics.length !== txs.length) {
    throw new SeamChainError(
      "PLAN_NOT_SIGNABLE",
      `expected ${txs.length} signed extrinsics, got ${opts.signedExtrinsics.length}`,
    );
  }
  return withClient(
    endpoint,
    async (client) => {
      const atBlock: BlockRef = opts.at
        ? {
            hash: opts.at,
            number: toSafeNumber(
              (await rpc<{ number: unknown }>(client, "chain_getHeader", [opts.at])).number,
            ),
          }
        : await readHead(client);
      const version = await rpc<{ specVersion: number; transactionVersion: number }>(
        client,
        "state_getRuntimeVersion",
        [atBlock.hash],
      );
      if (
        version.specVersion !== facts.fingerprint.specVersion ||
        version.transactionVersion !== facts.fingerprint.transactionVersion
      ) {
        throw new SeamChainError(
          "RUNTIME_CHANGED",
          `node runs spec ${version.specVersion}/tx ${version.transactionVersion}, facts are for spec ${facts.fingerprint.specVersion}/tx ${facts.fingerprint.transactionVersion}; rediscover`,
        );
      }
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
          detail.dryRun = { outcome: d.outcome, detail: `system_dryRun: ${d.detail}` };
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

      const contractDryRuns: Record<string, unknown> = {};
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
        const batchOk = atomic && tx.dryRun?.outcome === "ok";
        const basis: CoverageBasis =
          batchOk || (!atomic && tx.dryRun?.outcome === "ok")
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
          signed_dry_run: atomic
            ? "the whole signed batch dry-ran ok at the current block"
            : "this signed transaction dry-ran ok alone, against current state",
          contract_dry_run:
            "this call alone dry-ran against current state; not the effect of earlier steps",
          asset_existence_check:
            "only that the asset exists; not balances, permissions or state changed by other steps",
          fee_estimate_only: "only a fee and weight estimate; the call was not executed",
        }[basis];
        coverage.push({ actionId: s.actionId, basis, proves });
        notes.push(`simulation coverage: ${basis} (${proves})`);
        steps.push({
          actionId: s.actionId,
          weight: info ? known(info.weight) : UNKNOWN,
          fee: info ? known(info.partialFee) : UNKNOWN,
          storageDeposit: UNKNOWN,
          proofSize,
          dryRun,
          note: notes.join("; "),
        });
      }

      const fees = transactions.map((t) => t.queryInfo?.partialFee);
      const totalFee: Estimate = fees.every((f) => f !== undefined)
        ? known(fees.reduce((a, f) => a + BigInt(f!), 0n))
        : UNKNOWN;
      const wholePlan: SimulationCoverage["wholePlan"] =
        atomic && transactions[0]?.dryRun?.outcome === "ok" ? "signed_dry_run" : "none";
      const signedOk = transactions.filter((t) => t.dryRun?.outcome === "ok").length;
      const summary =
        wholePlan === "signed_dry_run"
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
      };
    },
    opts,
  );
}
