// Per-step receipt verification with Quill's verifyStep from @seam/sdk/browser (one dispatcher over every step kind),
// replacing the console's transfer-only effect check as the gate for the next step. Read-only: it re-reads the block and
// its System.Events, decodes this extrinsic's events in the shape the SDK checks (accounts as 0x AccountId32 hex,
// integers as decimal strings), and passes the V3 runtime facts so the observed spec-3002 verdicts apply.
// The call bytes given to verifyStep (outcome.callHex) are the call inside the signed extrinsic: for the multi-step path
// decoded from the in-memory signed bytes, for the single-call path read back from the block. Neither is logged, kept
// in state, or put in any receipt: verifyStep's result carries no call bytes.
import { Metadata, TypeRegistry } from "@polkadot/types";
import { u8aToHex } from "@polkadot/util";
import { blake2AsHex, xxhashAsHex } from "@polkadot/util-crypto";
import {
  perStepOfBatch,
  verifyStep,
  type ChainEvent,
  type SdkReceiptStep,
  type StepOutcome,
} from "@seam/sdk/browser";
import type { RpcTransport } from "./chainclient";

type Hex = `0x${string}`;
const EVENTS_KEY = xxhashAsHex("System", 128) + xxhashAsHex("Events", 128).slice(2);
const ACCOUNT_TYPES = /^(T::)?(AccountId|AccountId32|LookupSource|Address)$/;

interface Codecish {
  toU8a(): Uint8Array;
  toRawType(): string;
  toPrimitive(): unknown;
  toBigInt?: () => bigint;
  bitLength?: () => number;
  unwrap?: () => Codecish;
  isNone?: boolean;
}

/** Same rules as @seam/chain's argToString, so events read here compare like the chain adapter's. */
function argToString(c: Codecish, typeName: string): string {
  if (ACCOUNT_TYPES.test(typeName) || c.toRawType() === "AccountId")
    return u8aToHex(c.toU8a().slice(-32));
  const u = typeof c.unwrap === "function" && c.isNone === undefined ? c.unwrap() : c;
  if (typeof u.toBigInt === "function" && typeof u.bitLength === "function")
    return u.toBigInt().toString();
  if (u instanceof Uint8Array) return u8aToHex(u);
  const p = u.toPrimitive();
  if (typeof p === "string" || typeof p === "number" || typeof p === "boolean") return String(p);
  return JSON.stringify(p);
}

export type OutcomeRead =
  { ok: true; outcome: StepOutcome; extrinsic: string } | { ok: false; message: string };

/** Reads one extrinsic's events back from its block (by tx hash), decoded with the metadata at that block. */
export async function readExtrinsicOutcome(
  rpc: RpcTransport,
  actionId: string,
  txHash: string,
  block: { number: number; hash: string },
  status: StepOutcome["status"],
): Promise<OutcomeRead> {
  try {
    const b = (await rpc("chain_getBlock", [block.hash])) as {
      block?: { extrinsics?: string[] };
    } | null;
    const xts = b?.block?.extrinsics ?? [];
    const idx = xts.findIndex((x) => blake2AsHex(x).toLowerCase() === txHash.toLowerCase());
    if (idx < 0) return { ok: false, message: "The transaction hash is not in that block." };
    const metaHex = (await rpc("state_getMetadata", [block.hash])) as string;
    const evHex = (await rpc("state_getStorage", [EVENTS_KEY, block.hash])) as string | null;
    if (!metaHex || !evHex)
      return { ok: false, message: "Could not read metadata or events at that block." };
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, metaHex as Hex);
    registry.setMetadata(metadata);
    const pallets = new Map(
      metadata.asLatest.pallets.map((p) => [p.index.toNumber(), p.name.toString()]),
    );
    const records = registry.createType("Vec<FrameSystemEventRecord>", evHex) as unknown as Array<{
      phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
      event: {
        index: Uint8Array;
        method: string;
        data: Codecish[];
        meta: { args: { toString(): string }[] };
      };
    }>;
    const events: ChainEvent[] = records
      .filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === idx)
      .map((r) => {
        const types = r.event.meta.args.map((a) => a.toString());
        return {
          pallet: pallets.get(r.event.index[0]!) ?? `pallet${r.event.index[0]}`,
          name: r.event.method,
          args: r.event.data.map((d, i) => argToString(d, types[i] ?? "")),
        };
      });
    return {
      ok: true,
      outcome: {
        actionId,
        status,
        txHash: txHash as Hex,
        block: { number: block.number, hash: block.hash as Hex },
        events,
      },
      extrinsic: xts[idx]!,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Could not read the step's events: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface RuntimeLike {
  specName?: string;
  specVersion?: number;
}

/**
 * verifyStep for one plan step. callHex is the call inside the signed extrinsic (never the signed bytes themselves).
 * Only "verified" lets a later step run; the policy engine's canRunNextStep enforces that again at submit.
 */
export function verifyPlanStep(
  step: unknown,
  signerAccountId: string,
  outcome: StepOutcome,
  runtime: RuntimeLike | undefined,
  callHex?: string,
): SdkReceiptStep {
  return verifyStep(
    step as never,
    signerAccountId as Hex,
    { ...outcome, ...(callHex ? { callHex: callHex as Hex } : {}) },
    undefined,
    undefined,
    runtime as never,
  );
}

/** The call inside signed extrinsic bytes, via the chain package's trusted decoder. undefined when it can't decode. */
export function callOfSigned(
  decode: ((x: Hex) => unknown) | undefined,
  signed: string | undefined,
): string | undefined {
  if (!decode || !signed) return undefined;
  try {
    const d = decode(signed as Hex) as { call?: unknown } | null;
    return typeof d?.call === "string" ? d.call : undefined;
  } catch {
    return undefined;
  }
}

export interface CompiledStepContext {
  /** The compiled plan's step (compiler PlanStep). */
  step: unknown;
  signerAccountId: string;
  runtime?: RuntimeLike;
  /** Decoder for signed extrinsics (@seam/chain/browser signedExtrinsicDecoder(facts)); gives the call read back. */
  decode?: (x: Hex) => unknown;
}

/**
 * Single-call receipt check with verifyStep (any step kind). The call bytes come from the extrinsic as read back from the
 * finalized block, decoded by the chain package; they are not kept. Returns the console's EffectVerdict shape.
 */
export async function stepEffectCheck(
  rpc: RpcTransport,
  txHash: string,
  block: { number: number; hash: string },
  ctx: CompiledStepContext,
): Promise<import("./effectcheck").EffectVerdict> {
  const at = new Date().toISOString();
  const actionId = (ctx.step as { actionId?: string })?.actionId ?? "";
  const r = await readExtrinsicOutcome(rpc, actionId, txHash, block, "finalized");
  if (!r.ok) return { verdict: "not_verified", reason: r.message, checkedAt: at };
  const v = verifyPlanStep(
    ctx.step,
    ctx.signerAccountId,
    r.outcome,
    ctx.runtime,
    callOfSigned(ctx.decode, r.extrinsic),
  );
  return v.verification === "verified"
    ? { verdict: "effect_proven", extrinsicIndex: -1, event: {}, reason: v.reason, checkedAt: at }
    : {
        verdict: "not_verified",
        reason: `${v.verification}${v.code ? ` (${v.code})` : ""}: ${v.reason}`,
        checkedAt: at,
      };
}

/**
 * Atomic plans: one batch outcome. perStepOfBatch (@seam/sdk/browser) gives each step its own outcome, with its call
 * bytes only when the signed batch call is exactly batch_all of the plan's calls; verifyStep checks each. This is a
 * per-step check of the batch's events, not a chain_verified provenance.
 */
export function atomicStepReceipts(
  plan: unknown,
  batchOutcome: StepOutcome,
  signedBatchCall: string | undefined,
  signerAccountId: string,
  runtime: RuntimeLike | undefined,
): SdkReceiptStep[] {
  const p = plan as { steps: { actionId: string }[] };
  const per = perStepOfBatch(
    plan as never,
    [{ ...batchOutcome, actionId: "batch" }],
    signedBatchCall as Hex | undefined,
  );
  return p.steps.map((step) => {
    const o = per.find((x) => x.actionId === step.actionId);
    return verifyStep(
      step as never,
      signerAccountId as Hex,
      o,
      undefined,
      undefined,
      runtime as never,
    );
  });
}
