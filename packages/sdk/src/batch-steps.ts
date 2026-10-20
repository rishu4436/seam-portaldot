/**
 * Browser-safe: splits an atomic plan's one batch outcome into per-step outcomes (moved verbatim from flow.ts, which
 * re-exports it). No node builtins, no file store.
 */
import type { Hex, Plan } from "@seam/compiler";
import type { StepOutcome } from "./receipt.js";

/** SCALE compact encoding of a small count, as hex without 0x. */
function compactHex(n: number): string | undefined {
  const b = (x: number, k: number) =>
    Array.from({ length: k }, (_, i) => ((x >> (8 * i)) & 0xff).toString(16).padStart(2, "0")).join(
      "",
    );
  if (n < 0 || !Number.isInteger(n)) return undefined;
  if (n < 1 << 6) return b(n << 2, 1);
  if (n < 1 << 14) return b((n << 2) | 1, 2);
  if (n < 1 << 30) return b(((n << 2) | 2) >>> 0, 4);
  return undefined;
}

/**
 * Atomic plans send one transaction, so the adapter reports one outcome ("batch"). Each step's receipt check still
 * needs that step's own call as it was executed. It is taken from the signed batch call only when that call is
 * exactly `[pallet, call] ++ compact(n) ++ step1 ++ … ++ stepN` with the plan's encoded calls in order: then each
 * step's bytes are a verified slice of what was signed. Otherwise no step gets call bytes (a check that needs them
 * stays unknown). Events, status, hash and block stay those of the whole batch, as before.
 */
export function perStepOfBatch(
  plan: Plan,
  outcomes: StepOutcome[],
  signedBatchCall: Hex | undefined,
): StepOutcome[] {
  const batch = outcomes.find((o) => o.actionId === "batch");
  if (!batch) return outcomes;
  const inner = plan.steps.map((s) => s.encodedCall);
  const count = compactHex(inner.length);
  const call = (batch.callHex ?? signedBatchCall)?.toLowerCase();
  const body = inner.every((c): c is Hex => !!c)
    ? inner.map((c) => c.slice(2).toLowerCase()).join("")
    : undefined;
  const exact =
    !!call &&
    call === plan.outerCall?.encodedCall?.toLowerCase() &&
    body !== undefined &&
    count !== undefined &&
    /^0x[0-9a-f]{4}/.test(call) &&
    call === `${call.slice(0, 6)}${count}${body}`;
  const withBatchCall =
    signedBatchCall && !batch.callHex ? { ...batch, callHex: signedBatchCall } : batch;
  return [
    withBatchCall,
    ...plan.steps
      .filter((s) => !outcomes.some((o) => o.actionId === s.actionId))
      .map((s) => {
        const { callHex: _whole, ...rest } = batch;
        return {
          ...rest,
          actionId: s.actionId,
          ...(exact && s.encodedCall ? { callHex: s.encodedCall } : {}),
        };
      }),
  ];
}
