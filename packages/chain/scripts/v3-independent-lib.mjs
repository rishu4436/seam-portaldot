// Pure helpers for scripts/v3-independent-verify.mjs: event normalisation, comparison and outcome classification.
// No network, no keys. Unit-tested offline in tests/v3-independent-verify.test.ts.
import { decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

export const OUTCOMES = ["verified", "expected_dispatch_failure", "mismatch", "unverifiable"];

/** Split "a, {"x":1,"y":2}, [1, 2]" at top-level commas. */
export function splitArgs(s) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === "{" || c === "[" || c === "(") depth++;
    if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** "Pallet.Name(a, b)" -> { pallet, name, args } */
export function parseEventString(s) {
  const m = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\((.*)\)$/s.exec(s.trim());
  if (!m) throw new Error(`unparseable event string: ${s}`);
  return { pallet: m[1], name: m[2], args: splitArgs(m[3]) };
}

const isSs58 = (s) => /^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(s);

/** Canonical form for comparing event args written by different tools (ss58 vs hex, JSON strings, number types). */
export function canon(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k.toLowerCase()] = canon(v[k]);
    return o;
  }
  const s = String(v).trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return canon(JSON.parse(s));
    } catch {
      /* not JSON */
    }
  }
  if (isSs58(s)) {
    try {
      return u8aToHex(decodeAddress(s));
    } catch {
      /* not an address */
    }
  }
  if (/^0x[0-9a-fA-F]*$/.test(s)) return s.toLowerCase();
  if (/^-?\d+$/.test(s)) return String(BigInt(s));
  return s.toLowerCase();
}

export const eventKey = (e) => `${e.pallet}.${e.name}`;

/**
 * Compare expected (recorded) events with observed (chain) events for one extrinsic, in order.
 * Returns { match, differences[] }.
 */
export function compareEvents(expected, observed) {
  const differences = [];
  const n = Math.max(expected.length, observed.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const o = observed[i];
    if (!e) {
      differences.push(`event ${i}: unexpected ${eventKey(o)} on chain`);
      continue;
    }
    if (!o) {
      differences.push(`event ${i}: expected ${eventKey(e)}, missing on chain`);
      continue;
    }
    if (eventKey(e) !== eventKey(o)) {
      differences.push(`event ${i}: expected ${eventKey(e)}, chain has ${eventKey(o)}`);
      continue;
    }
    const a = JSON.stringify(canon(e.args));
    const b = JSON.stringify(canon(o.args));
    if (a !== b)
      differences.push(`event ${i} ${eventKey(e)}: args differ: recorded ${a} vs chain ${b}`);
  }
  return { match: differences.length === 0, differences };
}

/**
 * Classify one transaction from independently observed facts.
 * obs: {
 *   readError?: string            // state/block not readable (pruned, RPC error)
 *   canonicalHash?: string        // chain_getBlockHash(recorded number)
 *   recordedBlockHash: string
 *   blockNumber: number, finalizedNumber: number
 *   extrinsicIndex?: number|null  // index of the extrinsic whose blake2 hash equals the tx hash
 *   recordedIndex?: number|null
 *   callMatch?: boolean|null      // null = no recorded call bytes to compare
 *   signerMatch?: boolean|null
 *   dispatch?: { ok: boolean, error?: string }
 *   events?: { match: boolean, differences: string[] } | null
 * }
 * exp: { expectFailure?: boolean, expectedError?: string }
 */
export function classify(obs, exp = {}) {
  const reasons = [];
  if (obs.readError) return { outcome: "unverifiable", reasons: [obs.readError] };
  if (!obs.canonicalHash)
    return {
      outcome: "unverifiable",
      reasons: ["no canonical hash for the recorded block number"],
    };
  let bad = false;
  if (obs.canonicalHash.toLowerCase() !== obs.recordedBlockHash.toLowerCase()) {
    bad = true;
    reasons.push(
      `canonical hash at #${obs.blockNumber} is ${obs.canonicalHash}, recorded ${obs.recordedBlockHash}`,
    );
  }
  if (!(obs.blockNumber <= obs.finalizedNumber)) {
    bad = true;
    reasons.push(`block #${obs.blockNumber} is above the finalized head #${obs.finalizedNumber}`);
  }
  if (obs.extrinsicIndex === null || obs.extrinsicIndex === undefined) {
    return {
      outcome: "mismatch",
      reasons: [...reasons, "no extrinsic in the block hashes to the tx hash"],
    };
  }
  if (
    obs.recordedIndex !== null &&
    obs.recordedIndex !== undefined &&
    obs.recordedIndex !== obs.extrinsicIndex
  ) {
    bad = true;
    reasons.push(`extrinsic index ${obs.extrinsicIndex} on chain, recorded ${obs.recordedIndex}`);
  }
  if (obs.callMatch === false) {
    bad = true;
    reasons.push("call bytes differ from the committed evidence");
  }
  if (obs.signerMatch === false) {
    bad = true;
    reasons.push("signer differs from the committed evidence");
  }
  if (obs.events && !obs.events.match) {
    bad = true;
    reasons.push(...obs.events.differences);
  }
  if (!obs.dispatch)
    return { outcome: "unverifiable", reasons: [...reasons, "no dispatch result event found"] };
  if (exp.expectFailure) {
    if (obs.dispatch.ok) {
      bad = true;
      reasons.push("expected a dispatch failure, chain reports ExtrinsicSuccess");
    } else if (exp.expectedError && obs.dispatch.error !== exp.expectedError) {
      bad = true;
      reasons.push(`expected ${exp.expectedError}, chain reports ${obs.dispatch.error}`);
    }
    if (bad) return { outcome: "mismatch", reasons };
    return {
      outcome: "expected_dispatch_failure",
      reasons: [...reasons, `ExtrinsicFailed ${obs.dispatch.error}, as recorded and intended`],
    };
  }
  if (!obs.dispatch.ok) {
    bad = true;
    reasons.push(`unexpected ExtrinsicFailed ${obs.dispatch.error}`);
  }
  if (bad) return { outcome: "mismatch", reasons };
  return { outcome: "verified", reasons };
}
