import type { Hex, Plan } from "@seam/compiler";
import {
  checkReceipt,
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
  ): Promise<{ extrinsicIndex: number; signer?: Hex; callHex?: Hex; events: ChainEvent[] } | null>;
}

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
 * `chain_verified` means the receipt's recorded facts match the chain; read the receipt's `result` for what they prove.
 */
export async function verifyReceiptLive(
  receipt: Receipt,
  reader: ReceiptChainReader,
  opts: { plan?: Plan; effects?: Record<string, ContractEffect> } = {},
): Promise<LiveVerification> {
  const problems: string[] = [];
  const notes: string[] = [];
  const steps: LiveVerification["steps"] = [];
  const { plan } = opts;
  if (!checkReceipt(receipt))
    return {
      status: "failed",
      problems: ["The receipt does not match its own digest."],
      notes,
      steps,
    };
  if (plan && plan.planDigest !== receipt.planDigest)
    problems.push("The plan given is not the plan this receipt is for (plan digest differs).");
  if (!plan)
    notes.push(
      "No plan was given, so the signer and call of each transaction were not compared with what was planned.",
    );
  const atomic = receipt.mode === "atomic_verified" || receipt.mode === "atomic_unverified";
  if (atomic && plan)
    notes.push(
      "Atomic receipt: signer and events were checked; the batch call bytes were not compared step by step.",
    );

  let unknown = false;
  let finalized: number;
  try {
    finalized = await reader.finalizedNumber();
  } catch (e) {
    return {
      status: "unknown",
      problems,
      notes: [...notes, `Could not read the finalized head: ${(e as Error).message}`],
      steps,
    };
  }

  for (const s of receipt.steps) {
    const mine = problems.length;
    const mark = (st: LiveVerification["steps"][number]["status"]) =>
      steps.push({ actionId: s.actionId, status: st });
    if (s.status === "not_run") {
      notes.push(`${s.actionId}: not run, nothing to check.`);
      mark("skipped");
      continue;
    }
    if (s.status !== "finalized") {
      notes.push(
        `${s.actionId}: receipt status is ${s.status}, not finalized, so it cannot be chain_verified.`,
      );
      unknown = true;
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
        unknown = true;
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
      const planStep = plan?.steps.find((p) => p.actionId === s.actionId);
      if (plan) {
        if (!atomic && !planStep) problems.push(`${s.actionId}: not a step of the plan.`);
        if (tx.signer === undefined) {
          notes.push(`${s.actionId}: the signer could not be read from the block.`);
          unknown = true;
        } else if (lc(tx.signer) !== lc(plan.signer.publicKey))
          problems.push(
            `${s.actionId}: signed by ${tx.signer}, the plan's signer is ${plan.signer.publicKey}.`,
          );
        if (!atomic && planStep?.encodedCall) {
          if (tx.callHex === undefined) {
            notes.push(`${s.actionId}: the call could not be read from the block.`);
            unknown = true;
          } else if (lc(tx.callHex) !== lc(planStep.encodedCall))
            problems.push(`${s.actionId}: the call on chain is not the planned call.`);
        }
      }
      const chainEvents = tx.events.map(fmt);
      if (chainEvents.length !== s.events.length || chainEvents.some((e, i) => e !== s.events[i])) {
        problems.push(`${s.actionId}: the events in the receipt are not the events on chain.`);
      } else if (plan && planStep) {
        const outcome: StepOutcome = {
          actionId: s.actionId,
          status: "finalized",
          txHash: s.txHash,
          block: s.block,
          events: tx.events,
        };
        const again = verifyStep(
          planStep,
          plan.signer.publicKey,
          outcome,
          opts.effects?.[s.actionId],
        );
        if (again.verification !== s.verification)
          problems.push(
            `${s.actionId}: the receipt says ${s.verification}, the chain's events give ${again.verification}.`,
          );
      }
    } catch (e) {
      notes.push(`${s.actionId}: could not read the chain: ${(e as Error).message}`);
      unknown = true;
      mark("unknown");
      continue;
    }
    mark(problems.length > mine ? "failed" : "chain_verified");
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

/**
 * A ReceiptChainReader over a node, using @seam/chain's read functions. `facts` pins the runtime used to decode
 * extrinsics and events. Needs the optional @seam/chain package.
 */
export async function createChainReader(
  endpoint: string,
  facts: unknown,
): Promise<ReceiptChainReader> {
  const chain: any = await import("@seam/chain").catch(() => {
    throw new Error("live verification needs the @seam/chain package installed");
  });
  const call = <T>(method: string, params: unknown[]) =>
    chain.withClient(endpoint, (c: any) => c.send(method, params) as Promise<T>);
  return {
    async finalizedNumber() {
      const head = await call<string>("chain_getFinalizedHead", []);
      const h = await call<{ number: string | number } | null>("chain_getHeader", [head]);
      if (!h) throw new Error("finalized header not found");
      return Number(h.number);
    },
    async canonicalHash(n) {
      return (await call<string | null>("chain_getBlockHash", [n])) as Hex | null;
    },
    async readTx(blockHash, txHash) {
      const block = await call<{ block: { extrinsics: string[] } } | null>("chain_getBlock", [
        blockHash,
      ]);
      if (!block) return null;
      const idx = block.block.extrinsics.findIndex(
        (x: string) => chain.extrinsicHash(x) === txHash.toLowerCase(),
      );
      if (idx < 0) return null;
      let signer: Hex | undefined, callHex: Hex | undefined;
      try {
        const sc = chain.extractSignedCall(block.block.extrinsics[idx]!, facts);
        signer = sc.signer.accountId;
        callHex = sc.callHex;
      } catch {
        /* unsigned or undecodable: left undefined, reported as unknown */
      }
      const inc = await chain.readEvents(endpoint, blockHash, idx, facts);
      return { extrinsicIndex: idx, signer, callHex, events: inc.events.map(chain.toChainEvent) };
    },
  };
}
