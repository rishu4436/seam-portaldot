import type { ActionKind } from "@seam/compiler/browser";
import {
  computeFingerprintDigest,
  computePlanDigest,
  type Hex,
  type Plan,
  type RuntimeFingerprint,
} from "@seam/compiler/browser";
import type { NftsRuntime } from "./outcomes.js";
import { perStepOfBatch } from "./batch-steps.js";
import { reviveAddressOf, type OriginalAccountRead } from "./deploy-outcomes.js";
import {
  checkReceipt,
  receiptShapeProblem,
  verifyStep,
  type ChainEvent,
  type ContractEffect,
  type Receipt,
  type ReceiptCheckStatus,
  type StepOutcome,
} from "./receipt.js";

/**
 * Read-only view of a chain, enough to re-check a receipt. `createChainReader` builds one from @seam/chain;
 * tests pass a mock. Every method must read from the node, never from the receipt.
 */
export interface ReceiptChainReader {
  /** Height of the node's finalized head. */
  finalizedNumber(): Promise<number>;
  /** Hash of the block at this height on the node's canonical chain, or null if there is none. */
  canonicalHash(n: number): Promise<Hex | null>;
  /** The transaction inside that block, decoded; null if the block does not contain it. */
  readTx(
    blockHash: Hex,
    txHash: Hex,
  ): Promise<{
    extrinsicIndex: number;
    signer?: Hex;
    callHex?: Hex;
    /** The nonce decoded from the extrinsic's own signed bytes, when readable. */
    nonce?: number;
    events: ChainEvent[];
  } | null>;
  /**
   * The node's own runtime fingerprint, read live. Needed to use a pinned `runtime`: its genesis, spec name, spec version,
   * transaction version and ss58 prefix must equal the node's. Without it a pinned runtime is not used.
   */
  runtimeFingerprint?(): Promise<RuntimeFingerprint | null>;
  /**
   * Read-only `Revive.OriginalAccount(h160)` at block `at` (finalized head when omitted): the AccountId32 the H160 maps
   * to, or null when it is unmapped. Throws when the value cannot be read or decoded. Used for revive.map_account steps;
   * without it, or when it throws, such a step is `unknown`, never verified and never failed.
   */
  originalAccount?(h160: string, at?: Hex): Promise<Hex | null>;
}

/** The fields a pinned runtime must share with the live node. Only `metadataHash` (storage-default drift) may differ. */
const IDENTITY = [
  "genesisHash",
  "specName",
  "specVersion",
  "transactionVersion",
  "ss58Prefix",
] as const;

export interface LiveVerification {
  status: Exclude<ReceiptCheckStatus, "integrity_checked">;
  problems: string[];
  /** Things that could not be checked, or were skipped, and why. */
  notes: string[];
  steps: { actionId: string; status: "chain_verified" | "unknown" | "failed" | "skipped" }[];
}

const fmt = (e: ChainEvent) => `${e.pallet}.${e.name}(${e.args.join(", ")})`;
const lc = (s?: string) => (s ?? "").toLowerCase();

/**
 * Re-reads the chain and checks, for every step the receipt says ran: the block is on the canonical chain and at or below
 * the finalized head, the block holds the transaction, the signer and call are the planned ones (needs `plan`), and the
 * events the receipt lists are the events the chain shows. Missing data or a failing read is `unknown`, never verified.
 * `chain_verified` needs ALL of: a `plan`; the on-chain call bytes equal to the planned call (each step's call, or for atomic
 * plans the outer batch call); no planned step missing or not run; and every step re-derived as `effect_proven` from the chain's own
 * events (for contract calls this needs the `effects` assertion). No plan, an uncomparable call or a missing assertion gives `unknown`; a mismatch gives `failed`.
 *
 * `runtime` is the RuntimeFingerprint the plan ran on. It turns on the same default nfts.mint / revive.call checks `buildReceipt`
 * uses, so execute and verify-live agree. It is used only if its digest equals the receipt's `fingerprintDigest`; a different
 * fingerprint is a problem (`failed`). The reader's live `runtimeFingerprint()` must also share genesis, spec name, spec version,
 * transaction version and ss58 with it (only the metadata hash may differ); a mismatch is `failed`, an unreadable one leaves it unused. Without it those default checks stay capped, and a step whose receipt says more than the
 * capped re-check gives `unknown`, never `chain_verified`.
 */
export async function verifyReceiptLive(
  receipt: Receipt,
  reader: ReceiptChainReader,
  opts: {
    plan?: Plan;
    effects?: Record<string, ContractEffect>;
    runtime?: RuntimeFingerprint;
  } = {},
): Promise<LiveVerification> {
  const problems: string[] = [];
  const notes: string[] = [];
  const steps: LiveVerification["steps"] = [];
  const { plan } = opts;
  if (plan) {
    try {
      if (computePlanDigest(plan) !== plan.planDigest)
        problems.push("The plan contents do not match the plan digest.");
    } catch {
      problems.push("The plan contents could not be validated.");
    }
  }
  const shape = receiptShapeProblem(receipt);
  if (shape)
    return { status: "failed", problems: [`This is not a SEAM receipt (${shape}).`], notes, steps };
  if (!checkReceipt(receipt))
    return {
      status: "failed",
      problems: ["The receipt does not match its own digest."],
      notes,
      steps,
    };
  if (plan && plan.planDigest !== receipt.planDigest)
    problems.push("The plan given is not the plan this receipt is for (plan digest differs).");
  const atomic = receipt.mode === "atomic_verified" || receipt.mode === "atomic_unverified";
  // The runtime for the default checks, bound to the receipt by fingerprint digest. Anything else is not used.
  let runtime: NftsRuntime | undefined;
  if (opts.runtime) {
    let d: Hex | undefined;
    try {
      d = computeFingerprintDigest(opts.runtime);
    } catch {
      d = undefined;
    }
    if (!d || lc(d) !== lc(receipt.fingerprintDigest))
      problems.push(
        "The runtime given is not the runtime this receipt is for (fingerprint digest differs).",
      );
    else {
      let live: RuntimeFingerprint | null = null;
      try {
        live = reader.runtimeFingerprint ? await reader.runtimeFingerprint() : null;
      } catch {
        live = null;
      }
      if (!live)
        notes.push(
          "The node's runtime could not be read, so the pinned runtime was not used; nfts.mint and revive.call checks stay capped.",
        );
      else {
        const pinned = opts.runtime;
        const differs = IDENTITY.filter(
          (k) => String(pinned[k]).toLowerCase() !== String(live![k]).toLowerCase(),
        );
        if (differs.length)
          problems.push(
            `The node is not the runtime this receipt is for (${differs.map((k) => `${k} ${String(pinned[k])} vs live ${String(live![k])}`).join("; ")}).`,
          );
        else {
          runtime = pinned;
          if (lc(pinned.metadataHash) !== lc(live.metadataHash))
            notes.push(
              `The node's metadata hash differs from the pinned one (${pinned.metadataHash} vs ${live.metadataHash}); genesis, spec, transaction version and ss58 match, so the pinned runtime is used.`,
            );
        }
      }
    }
  }
  // Fail closed: chain_verified is only reachable with a plan, a planned-vs-on-chain call comparison and proven effects.
  let unknown = false;
  if (!plan) {
    notes.push(
      "No plan was given, so the signer and call of each transaction were not compared with what was planned. Without a plan the result cannot be chain_verified.",
    );
    unknown = true;
  } else {
    if (plan.mode !== receipt.mode)
      problems.push(`The receipt's mode is ${receipt.mode}, the plan's mode is ${plan.mode}.`);
    if (atomic && !plan.outerCall?.encodedCall) {
      notes.push(
        "Atomic plan has no outer batch call to compare, so the on-chain batch call cannot be checked.",
      );
      unknown = true;
    }
    const ran = new Set(receipt.steps.map((x) => x.actionId));
    for (const ps of plan.steps)
      if (!ran.has(ps.actionId))
        problems.push(`${ps.actionId}: a step of the plan is missing from the receipt.`);
  }

  let finalized: number;
  try {
    finalized = await reader.finalizedNumber();
  } catch (e) {
    return {
      status: problems.length ? "failed" : "unknown",
      problems,
      notes: [...notes, `Could not read the finalized head: ${(e as Error).message}`],
      steps,
    };
  }

  let atomicIdentity: string | undefined;
  const seenTx = new Set<string>();
  const seenExtrinsic = new Set<string>();
  const seenActions = new Set<string>();
  let previous: { block: number; index: number; nonce?: number; planIndex: number } | undefined;
  for (const s of receipt.steps) {
    const mine = problems.length;
    if (seenActions.has(s.actionId)) problems.push(`${s.actionId}: duplicate receipt action.`);
    seenActions.add(s.actionId);
    // A receipt that itself says not_verified is a failed run, whatever the chain shows.
    if (s.verification === "not_verified") {
      problems.push(
        `${s.actionId}: the receipt says not_verified${s.code ? ` (${s.code})` : ""}, so the run is not verified.`,
      );
      steps.push({ actionId: s.actionId, status: "failed" });
      continue;
    }
    let stepUnknown = false;
    const flag = () => {
      unknown = true;
      stepUnknown = true;
    };
    const mark = (st: LiveVerification["steps"][number]["status"]) =>
      steps.push({ actionId: s.actionId, status: st });
    if (s.status === "not_run") {
      notes.push(
        `${s.actionId}: not run, nothing to check; the planned effect did not happen, so the run cannot be chain_verified.`,
      );
      flag();
      mark("skipped");
      continue;
    }
    if (s.status !== "finalized") {
      notes.push(
        `${s.actionId}: receipt status is ${s.status}, not finalized, so it cannot be chain_verified.`,
      );
      flag();
      mark("unknown");
      continue;
    }
    if (!s.txHash || !s.block) {
      problems.push(`${s.actionId}: marked finalized but lists no transaction hash or block.`);
      mark("failed");
      continue;
    }
    try {
      if (s.block.number > finalized) {
        notes.push(
          `${s.actionId}: block ${s.block.number} is above the finalized head ${finalized}.`,
        );
        flag();
        mark("unknown");
        continue;
      }
      const canon = await reader.canonicalHash(s.block.number);
      if (!canon || lc(canon) !== lc(s.block.hash)) {
        problems.push(
          `${s.actionId}: block ${s.block.number} ${s.block.hash} is not the canonical block at that height${canon ? ` (the chain has ${canon})` : ""}.`,
        );
        mark("failed");
        continue;
      }
      const tx = await reader.readTx(s.block.hash, s.txHash);
      if (!tx) {
        problems.push(`${s.actionId}: transaction ${s.txHash} is not in block ${s.block.hash}.`);
        mark("failed");
        continue;
      }
      if (atomic) {
        const identity = `${lc(s.block.hash)}:${tx.extrinsicIndex}:${lc(s.txHash)}`;
        if (atomicIdentity !== undefined && atomicIdentity !== identity)
          problems.push(`${s.actionId}: atomic steps must share one batch transaction.`);
        atomicIdentity = identity;
      }
      if (!atomic) {
        const identity = `${lc(s.block.hash)}:${tx.extrinsicIndex}`;
        const planIndex = plan?.steps.findIndex((p) => p.actionId === s.actionId) ?? -1;
        if (seenTx.has(lc(s.txHash)) || seenExtrinsic.has(identity))
          problems.push(`${s.actionId}: sequential steps must use distinct transactions.`);
        if (!Number.isSafeInteger(tx.extrinsicIndex) || tx.extrinsicIndex < 0)
          problems.push(`${s.actionId}: invalid extrinsic index.`);
        if (
          previous &&
          (s.block.number < previous.block ||
            (s.block.number === previous.block && tx.extrinsicIndex <= previous.index) ||
            (plan && planIndex <= previous.planIndex) ||
            (tx.nonce !== undefined && previous.nonce !== undefined && tx.nonce <= previous.nonce))
        )
          problems.push(`${s.actionId}: sequential transactions are out of order.`);
        seenTx.add(lc(s.txHash));
        seenExtrinsic.add(identity);
        previous = { block: s.block.number, index: tx.extrinsicIndex, nonce: tx.nonce, planIndex };
      }
      const planStep = plan?.steps.find((p) => p.actionId === s.actionId);
      if (plan) {
        if (!atomic && !planStep) problems.push(`${s.actionId}: not a step of the plan.`);
        if (tx.signer === undefined) {
          notes.push(`${s.actionId}: the signer could not be read from the block.`);
          flag();
        } else if (lc(tx.signer) !== lc(plan.signer.publicKey))
          problems.push(
            `${s.actionId}: signed by ${tx.signer}, the plan's signer is ${plan.signer.publicKey}.`,
          );
        if (atomic && !planStep) problems.push(`${s.actionId}: not a step of the plan.`);
        // The call that was planned: the outer batch call for atomic plans, the step's own call for sequential ones.
        const planned = atomic ? plan.outerCall?.encodedCall : planStep?.encodedCall;
        const what = atomic ? "the batch call" : "the call";
        if (!planned) {
          if (!atomic && planStep) {
            notes.push(
              `${s.actionId}: the plan has no encoded call for this step, so ${what} cannot be compared.`,
            );
            flag();
          }
        } else if (tx.callHex === undefined) {
          notes.push(`${s.actionId}: ${what} could not be read from the block.`);
          flag();
        } else if (lc(tx.callHex) !== lc(planned))
          problems.push(
            `${s.actionId}: ${what} on chain is not the planned ${atomic ? "batch call" : "call"}.`,
          );
      }
      const chainEvents = tx.events.map(fmt);
      if (chainEvents.length !== s.events.length || chainEvents.some((e, i) => e !== s.events[i])) {
        problems.push(`${s.actionId}: the events in the receipt are not the events on chain.`);
      } else if (plan && planStep) {
        // The step's own call: for atomic plans its exact slice of the on-chain batch call (perStepOfBatch gives none
        // unless the batch is exactly the planned one), for sequential plans the on-chain call itself.
        const stepCall = atomic
          ? tx.callHex === undefined
            ? undefined
            : perStepOfBatch(
                plan,
                [
                  {
                    actionId: "batch",
                    status: "finalized",
                    txHash: s.txHash,
                    block: s.block,
                    events: tx.events,
                    callHex: tx.callHex,
                  },
                ],
                undefined,
              ).find((o) => o.actionId === s.actionId)?.callHex
          : tx.callHex;
        const outcome: StepOutcome = {
          actionId: s.actionId,
          status: "finalized",
          txHash: s.txHash,
          block: s.block,
          events: tx.events,
          ...(stepCall !== undefined ? { callHex: stepCall } : {}),
        };
        // revive.map_account: the mapping is proven only by a live Revive.OriginalAccount read from the node. A read
        // supplied by the caller in `effects` is never used here. No reader method, a failing read or an undecodable
        // value leaves the step unknown.
        let effect = opts.effects?.[s.actionId];
        // Expected values are assertions. A caller's `actual` is never a chain observation.
        const stateReadUnavailable = !!effect?.stateReadback;
        if (effect?.stateReadback) {
          effect = { ...effect, stateReadback: { expected: effect.stateReadback.expected } };
          notes.push(
            `${s.actionId}: caller-supplied state was not read by the chain reader; state verification is unknown.`,
          );
          flag();
        }
        let mapReadMissing: string | undefined;
        if (planStep.kind === "revive.map_account") {
          if (effect?.originalAccount) {
            const { originalAccount: _ignored, ...rest } = effect;
            effect = rest;
          }
          const h160 = reviveAddressOf(plan.signer.publicKey);
          if (!h160)
            mapReadMissing = "the plan's signer is not an AccountId32, so its H160 is not known";
          else if (!reader.originalAccount)
            mapReadMissing = "the reader cannot read Revive.OriginalAccount";
          else {
            try {
              const got = await reader.originalAccount(h160, s.block.hash);
              if (got !== null && (typeof got !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(got)))
                mapReadMissing = "the Revive.OriginalAccount value could not be decoded";
              else {
                const read: OriginalAccountRead = { h160, accountId: got };
                effect = { ...(effect ?? {}), originalAccount: read };
              }
            } catch (e) {
              mapReadMissing = `the Revive.OriginalAccount read failed (${(e as Error).message})`;
            }
          }
        }
        const again = verifyStep(
          planStep,
          plan.signer.publicKey,
          outcome,
          effect,
          undefined,
          runtime,
        );
        if (stateReadUnavailable && again.verification === "unknown") {
          mark("unknown");
          continue;
        }
        if (mapReadMissing && again.verification !== "not_verified") {
          notes.push(
            `${s.actionId}: ${mapReadMissing}, so the mapping cannot be proven from the chain; it is unknown, not failed.`,
          );
          flag();
          mark("unknown");
          continue;
        }
        if (
          planStep.kind === "revive.map_account" &&
          again.verification === "verified" &&
          s.verification !== "verified"
        ) {
          notes.push(
            `${s.actionId}: Revive.OriginalAccount now maps to the signer, but the receipt says ${s.verification}, so it is not chain_verified.`,
          );
          flag();
          mark("unknown");
          continue;
        }
        const needsRuntime = (
          [
            "nfts.mint",
            "revive.call",
            "revive.instantiate_with_code",
            "revive.map_account",
          ] as readonly ActionKind[]
        ).includes(planStep.kind);
        if (again.verification === "not_verified")
          problems.push(
            `${s.actionId}: the receipt says ${s.verification}, the chain's events give not_verified${again.code ? ` (${again.code})` : ""}.`,
          );
        else if (again.verification !== s.verification && !runtime && needsRuntime) {
          notes.push(
            `${s.actionId}: the receipt says ${s.verification}, but without the runtime fingerprint the ${planStep.kind} check is capped at ${again.verification}, so it is not chain_verified.`,
          );
          flag();
          mark("unknown");
          continue;
        } else if (again.verification !== s.verification)
          problems.push(
            `${s.actionId}: the receipt says ${s.verification}, the chain's events give ${again.verification}.`,
          );
        else if (again.coverage !== "effect_proven" || again.verification !== "verified") {
          notes.push(
            `${s.actionId}: the chain's events give coverage ${again.coverage}, not effect_proven (no complete state assertion), so it is not chain_verified.`,
          );
          flag();
          mark("unknown");
          continue;
        }
      }
    } catch (e) {
      notes.push(`${s.actionId}: could not read the chain: ${(e as Error).message}`);
      flag();
      mark("unknown");
      continue;
    }
    mark(problems.length > mine ? "failed" : plan && !stepUnknown ? "chain_verified" : "unknown");
  }
  if (
    !steps.some(
      (x) => x.status === "chain_verified" || x.status === "failed" || x.status === "unknown",
    )
  ) {
    notes.push("No step ran, so there is nothing on chain to verify.");
    unknown = true;
  }
  return {
    status: problems.length ? "failed" : unknown ? "unknown" : "chain_verified",
    problems,
    notes,
    steps,
  };
}
