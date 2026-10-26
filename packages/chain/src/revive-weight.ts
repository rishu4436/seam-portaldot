// Revive weight helpers (pure, no network).
//
// `decodeWeightV2Prefix` hand-decodes the first two SCALE values of a ReviveApi ContractResultV1
// (weight_consumed, weight_required: Weight { ref_time: Compact<u64>, proof_size: Compact<u64> }).
// It exists so a dry run's decoded proof_size can be cross-checked against the raw bytes.
//
// `reviveWeightBound` turns a dry-run weight_required into an explicit deploy limit with a margin.
// A proof_size of 0 is reported as unknown, never as a limit that passed.

export type WeightV2 = { refTime: string; proofSize: string };
export type ReviveWeightBound =
  | { known: true; refTime: string; proofSize: string; marginPct: number }
  | { known: false; refTime: string | null; reason: string };

function readCompact(b: Uint8Array, at: number): { value: bigint; next: number } {
  const first = b[at];
  if (first === undefined) throw new Error(`compact: out of bytes at ${at}`);
  const mode = first & 3;
  if (mode === 0) return { value: BigInt(first >> 2), next: at + 1 };
  if (mode === 1) {
    if (at + 2 > b.length) throw new Error("compact: truncated (2-byte)");
    return { value: BigInt((first | (b[at + 1]! << 8)) >> 2), next: at + 2 };
  }
  if (mode === 2) {
    if (at + 4 > b.length) throw new Error("compact: truncated (4-byte)");
    const v = (first | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 2 ** 24;
    return { value: BigInt(v) >> 2n, next: at + 4 };
  }
  const len = (first >> 2) + 4;
  if (at + 1 + len > b.length) throw new Error("compact: truncated (big-integer)");
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + 1 + i]!);
  return { value: v, next: at + 1 + len };
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error("not a hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decode weight_consumed and weight_required from the raw SCALE output of ReviveApi_instantiate / _call. */
export function decodeWeightV2Prefix(rawHex: string): {
  weightConsumed: WeightV2;
  weightRequired: WeightV2;
  bytesRead: number;
} {
  const b = hexToBytes(rawHex);
  let p = 0;
  const w = (): WeightV2 => {
    const r = readCompact(b, p);
    const s = readCompact(b, r.next);
    p = s.next;
    return { refTime: r.value.toString(), proofSize: s.value.toString() };
  };
  const weightConsumed = w();
  const weightRequired = w();
  return { weightConsumed, weightRequired, bytesRead: p };
}

type DryRunLike = { weightRequired?: { refTime?: unknown; proofSize?: unknown } | null };

const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(v)) return BigInt(v);
  return null;
};

/**
 * Explicit weight limit from a Revive dry run: weight_required * (1 + margin), rounded up.
 * proof_size 0 (or missing / unparseable) is `known: false` — it is NOT a bound that passed.
 */
export function reviveWeightBound(dryRun: DryRunLike, margin: number): ReviveWeightBound {
  if (!(Number.isFinite(margin) && margin >= 0 && margin <= 10))
    throw new Error("margin must be a number between 0 and 10");
  const ref = big(dryRun.weightRequired?.refTime);
  const proof = big(dryRun.weightRequired?.proofSize);
  const bp = BigInt(Math.round(margin * 10_000));
  const up = (x: bigint) => (x * (10_000n + bp) + 9_999n) / 10_000n;
  if (ref === null || ref === 0n)
    return { known: false, refTime: null, reason: "ref_time missing or 0 in the dry run" };
  if (proof === null)
    return {
      known: false,
      refTime: up(ref).toString(),
      reason: "proof_size missing in the dry run",
    };
  if (proof === 0n)
    return {
      known: false,
      refTime: up(ref).toString(),
      reason: "proof_size 0 in the dry run: unknown, not a passed limit",
    };
  return {
    known: true,
    refTime: up(ref).toString(),
    proofSize: up(proof).toString(),
    marginPct: margin * 100,
  };
}

/**
 * Static proof-size overhead of an extrinsic, from TransactionPaymentCallApi_query_call_info:
 * total pre-dispatch proof_size minus the explicit proof_size cap that was put in the call.
 * Throws when the cap is 0 (unknown, not a bound) or the total does not cover the cap.
 */
export function staticProofOverhead(
  totalProofSize: string | number | bigint,
  cap: string | number | bigint,
): bigint {
  const total = BigInt(totalProofSize);
  const c = BigInt(cap);
  if (c <= 0n) throw new Error("proof_size cap must be non-zero (0 means unknown, not a bound)");
  if (total < c) throw new Error(`query_call_info proof_size ${total} is below the cap ${c}`);
  return total - c;
}
