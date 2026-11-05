import { decodeEventLog, encodeFunctionData, keccak256, type Hex } from "viem";
import { guardAbi, tokenAbi } from "./abi.js";
import { DeFiClient, same, gasPriceLimit } from "./client.js";
import { DeFiInvariantError, invariant, parsePlan } from "./model.js";
import type { RecordEntry } from "./store.js";
import { hasReviewedProgram } from "./review.js";
export type Check = { label: string; status: "pass" | "fail" | "unknown"; detail?: string };
export type Verification = {
  status: "verified" | "local-confirmed" | "pending" | "failed" | "reverted";
  checks: Check[];
  hash?: Hex;
  amountOut?: string;
  fee?: string;
  block?: string;
};
export async function verifyRecord(row: RecordEntry): Promise<Verification> {
  const checks: Check[] = [];
  const pass = (label: string) => checks.push({ label, status: "pass" });
  let executionHash: Hex | undefined,
    output: string | undefined,
    totalFee = 0n,
    totalUpfrontLimits = 0n,
    blockNumber: bigint | undefined,
    finality = true,
    reverted = false;
  try {
    const c = new DeFiClient(row.registry),
      p = parsePlan(row.plan, c.registry);
    pass("Plan integrity and market binding");
    // A user-supplied code hash establishes identity, not trusted guard/token semantics.
    // Only the bundled reviewed test program can establish V3 guard/token semantics.
    if (c.registry.mode === "v3-testnet" && !hasReviewedProgram(c.registry)) {
      checks.push({
        label: "Reviewed V3 market required",
        status: "unknown",
        detail:
          "Economic verification is disabled for unreviewed V3 profiles. Self-declared code hashes and events cannot establish trusted economic postconditions.",
      });
      return { status: "pending", checks };
    }
    await c.audit();
    pass("Network, deployment and contract identities");
    const quote = await c.rpc.getBlock({ blockNumber: BigInt(p.quoteBlock) });
    invariant(same(quote.hash, p.quoteBlockHash), "Quote block is no longer canonical");
    invariant(
      p.deadline >= Number(quote.timestamp) + 60 && p.deadline <= Number(quote.timestamp) + 600,
      "Quote lifetime exceeded policy",
    );
    pass("Canonical quote block");
    let executions = 0;
    for (const a of row.attempts) {
      if (!a.hash) {
        if (a.state !== "rejected") {
          checks.push({ label: "Wallet request without a transaction hash", status: "unknown" });
          finality = false;
        }
        continue;
      }
      const tx = await c.rpc.getTransaction({ hash: a.hash }),
        receipt = await c.rpc.getTransactionReceipt({ hash: a.hash });
      const block = await c.rpc.getBlock({ blockNumber: receipt.blockNumber });
      invariant(
        same(block.hash, receipt.blockHash) &&
          same(tx.blockHash, receipt.blockHash) &&
          same(receipt.transactionHash, a.hash),
        "Receipt is not canonical",
      );
      invariant(
        same(tx.from, p.account) && tx.value === 0n,
        "Transaction signer or native value differs from plan",
      );
      const expectedTo = a.phase === "execute" ? c.registry.guard.address : p.tokenIn;
      const expectedData =
        a.phase === "execute"
          ? c.data(p)
          : encodeFunctionData({
              abi: tokenAbi,
              functionName: "approve",
              args: [c.registry.guard.address, a.phase === "approve" ? BigInt(p.amountIn) : 0n],
            });
      invariant(
        same(tx.to, expectedTo) && same(tx.input, expectedData),
        "Transaction does not match the approved action",
      );
      invariant(tx.nonce === a.nonce, "Transaction nonce differs from the saved request");
      invariant(
        receipt.effectiveGasPrice <= BigInt(p.maxGasPrice) &&
          gasPriceLimit(tx) <= BigInt(p.maxGasPrice),
        "Actual gas price exceeded the approved limit",
      );
      totalFee += receipt.gasUsed * receipt.effectiveGasPrice;
      totalUpfrontLimits += tx.gas * gasPriceLimit(tx);
      // A current hash cannot establish which implementation executed in a historical block.
      for (const pin of [
        c.registry.guard,
        c.registry.pool,
        ...c.registry.tokens,
        c.registry.vault,
      ]) {
        const code = await c.rpc.getCode({
          address: pin.address,
          blockNumber: receipt.blockNumber,
        });
        invariant(
          code && same(keccak256(code), pin.codeHash),
          "Historical contract identity mismatch",
        );
      }
      if (a.phase === "execute" && receipt.status === "reverted") reverted = true;
      if (a.phase !== "execute" || receipt.status !== "success") continue;
      executions++;
      invariant(executions === 1, "Multiple successful executions for one intent");
      executionHash = a.hash;
      blockNumber = receipt.blockNumber;
      invariant(Number(block.timestamp) <= p.deadline, "Execution missed the approved deadline");
      const actions = receipt.logs
        .filter((log) => same(log.address, c.registry.guard.address))
        .flatMap((log) => {
          try {
            const decoded = decodeEventLog({
              abi: guardAbi,
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            return decoded.eventName === "ActionExecuted" ? [decoded.args] : [];
          } catch {
            return [];
          }
        });
      invariant(actions.length === 1, "Expected exactly one guard economic result");
      const e = actions[0];
      invariant(
        same(e.planId, p.id) &&
          same(e.actor, p.account) &&
          e.kind === { swap: 0, deposit: 1, redeem: 2 }[p.action] &&
          same(e.target, p.target) &&
          same(e.tokenIn, p.tokenIn) &&
          same(e.tokenOut, p.tokenOut) &&
          e.amountIn === BigInt(p.amountIn) &&
          same(e.recipient, p.recipient) &&
          e.amountOut >= BigInt(p.minAmountOut),
        "Economic result differs from plan",
      );
      output = e.amountOut.toString();
      pass("On-chain action, recipient and minimum output");
      const transfers = receipt.logs.flatMap((log) => {
        try {
          const decoded = decodeEventLog({
            abi: tokenAbi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
          return decoded.eventName === "Transfer" ? [{ token: log.address, ...decoded.args }] : [];
        } catch {
          return [];
        }
      });
      const zero = "0x0000000000000000000000000000000000000000";
      const spent = transfers
        .filter(
          (t) =>
            same(t.token, p.tokenIn) &&
            same(t.from, p.account) &&
            same(t.to, p.action === "redeem" ? zero : c.registry.guard.address),
        )
        .reduce((n, t) => n + t.value, 0n);
      const received = transfers
        .filter((t) => same(t.token, p.tokenOut) && same(t.to, p.recipient))
        .reduce((n, t) => n + t.value, 0n);
      invariant(
        spent === BigInt(p.amountIn) && received === e.amountOut,
        "Token transfer evidence differs from guard result",
      );
      pass("Exact input debit and recipient token transfer evidence");
      const consumed = await c.rpc.readContract({
        address: c.registry.guard.address,
        abi: guardAbi,
        functionName: "consumed",
        args: [p.account, p.id],
        blockNumber: receipt.blockNumber,
      });
      invariant(consumed, "Plan replay marker is missing");
      pass("On-chain replay protection");
    }
    invariant(
      totalFee <= BigInt(p.maxTotalFee),
      "Recorded transaction fees exceed the approved plan budget",
    );
    pass("Actual recorded network fees within budget");
    invariant(
      totalUpfrontLimits <= BigInt(p.maxTotalFee),
      "Submitted upfront gas limits exceed the approved wallet cost budget",
    );
    pass("Submitted upfront wallet cost limits within budget");
    if (!executionHash) {
      if (reverted && finality) {
        checks.push({
          label: "Economic action reverted on chain",
          status: "fail",
          detail: "No accepted action effect. Recorded network fees were charged.",
        });
        return { status: "reverted", checks, fee: totalFee.toString() };
      }
      checks.push({
        label: "Successful economic execution",
        status: "unknown",
        detail: "No successful execution receipt found. Nothing was resent.",
      });
      return { status: "pending", checks, fee: totalFee.toString() };
    }
    pass("Canonical transaction bytes and historical code identities");
    if (c.registry.mode === "local")
      checks.push({
        label: "Finality",
        status: "unknown",
        detail: "Local development-chain inclusion, not testnet consensus finality",
      });
    else {
      try {
        const finalized = await c.rpc.getBlock({ blockTag: "finalized" });
        invariant(
          blockNumber !== undefined && finalized.number >= blockNumber,
          "Execution is not finalized yet",
        );
        pass("Finalized execution block");
      } catch {
        checks.push({ label: "Finalized execution block", status: "unknown" });
        finality = false;
      }
    }
    return {
      status: finality ? (c.registry.mode === "local" ? "local-confirmed" : "verified") : "pending",
      checks,
      hash: executionHash,
      amountOut: output,
      fee: totalFee.toString(),
      block: blockNumber?.toString(),
    };
  } catch (error) {
    const invalid = error instanceof DeFiInvariantError;
    checks.push({
      label: invalid ? "Independent verification" : "Network verification unavailable",
      status: invalid ? "fail" : "unknown",
      detail: (error instanceof Error ? error.message : String(error))
        .replace(/0x[0-9a-f]{130,}/gi, "[transaction data]")
        .slice(0, 1000),
    });
    return { status: invalid ? "failed" : "pending", checks, hash: executionHash };
  }
}
