// Read-only V3 facts step for LIVE mode. Browser-safe: plain JSON-RPC through an injected transport, no node: imports.
//
// Default path (discoverV3LiveFacts): genesis, runtime version, metadata, system_properties and the finalized head are read live
// and passed to @seam/chain/browser's factsFromChainInputs, so the fingerprint and digest are the node's own. The RECORDED
// SNAPSHOT (public/v3/facts-snapshot.json) is kept only as a labelled comparison and as the legacy fallback discoverV3Facts.
// Nothing is signed or sent here.
import type { RpcTransport } from "./chainclient";

export const V3_HTTPS_RPC = "https://test-node-v3.portaldot.dev";
export const V3_EXPLORER = "https://node-console.portaldot.dev";

export interface FactsSnapshot {
  label: string;
  recordedFrom: string;
  recordedAtBlock: number | null;
  facts: {
    fingerprint: {
      genesisHash: string;
      specName: string;
      specVersion: number;
      transactionVersion: number;
      metadataHash: string;
      [k: string]: unknown;
    };
    fingerprintDigest: string;
    source: { metadataHex: string; typesBundle?: unknown };
    [k: string]: unknown;
  };
}

export interface V3FactsReport {
  /**
   * Where each part came from. "live_chain_inputs": fingerprint and digest built in the browser by factsFromChainInputs from this
   * node's own reads. "snapshot_fingerprint_live_metadata": legacy fallback (recorded fingerprint + live metadata), display only.
   */
  provenance: "live_chain_inputs" | "snapshot_fingerprint_live_metadata";
  /** Live path only: the fingerprint digest built from the live reads. */
  liveFingerprintDigest?: string;
  /** Live path only: whether it equals the recorded snapshot's digest (false is expected on V3 metadata drift). */
  digestMatchesSnapshot?: boolean;
  snapshotFrom: string;
  genesisHash: string;
  specName: string;
  specVersion: number;
  transactionVersion: number;
  finalizedBlock: number | null;
  metadataBytes: number;
  liveMetadataHash: string;
  snapshotMetadataHash: string;
  /** False is expected on V3: metadata bytes drift between blocks without a runtime upgrade (evidence README). */
  metadataHashMatchesSnapshot: boolean;
}

export type V3FactsResult =
  | { ok: true; facts: FactsSnapshot["facts"]; report: V3FactsReport }
  | {
      ok: false;
      reason: "rpc_error" | "mismatch" | "bad_snapshot" | "build_failed";
      message: string;
    };

const isHex = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

export function isFactsSnapshot(s: unknown): s is FactsSnapshot {
  const x = s as FactsSnapshot | null;
  return (
    !!x &&
    typeof x === "object" &&
    isHex(x.facts?.fingerprint?.genesisHash) &&
    typeof x.facts?.fingerprint?.specVersion === "number" &&
    typeof x.facts?.fingerprint?.transactionVersion === "number" &&
    isHex(x.facts?.fingerprintDigest)
  );
}

/** Loads the committed snapshot (static asset). */
export async function loadFactsSnapshot(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  url = `${import.meta.env?.BASE_URL ?? "/"}v3/facts-snapshot.json`,
): Promise<FactsSnapshot | undefined> {
  try {
    const r = await fetchImpl(url);
    if (!r.ok) return undefined;
    const j: unknown = await r.json();
    return isFactsSnapshot(j) ? j : undefined;
  } catch {
    return undefined;
  }
}

/** Reads genesis, runtime version, finalized head and metadata (all read-only) and binds them to the snapshot. */
export async function discoverV3Facts(
  rpc: RpcTransport,
  snapshot: FactsSnapshot | undefined,
  blake2: (hex: string) => string,
): Promise<V3FactsResult> {
  if (!isFactsSnapshot(snapshot))
    return {
      ok: false,
      reason: "bad_snapshot",
      message: "The V3 facts snapshot is missing or malformed.",
    };
  const fp = snapshot.facts.fingerprint;
  let genesis: unknown, rv: unknown, head: unknown, header: unknown, meta: unknown;
  try {
    genesis = await rpc("chain_getBlockHash", [0]);
    rv = await rpc("state_getRuntimeVersion", []);
    meta = await rpc("state_getMetadata", []);
    head = await rpc("chain_getFinalizedHead", []);
    header = isHex(head) ? await rpc("chain_getHeader", [head]) : undefined;
  } catch (e) {
    return { ok: false, reason: "rpc_error", message: e instanceof Error ? e.message : String(e) };
  }
  const v = (rv ?? {}) as {
    specName?: unknown;
    specVersion?: unknown;
    transactionVersion?: unknown;
  };
  const problems: string[] = [];
  if (genesis !== fp.genesisHash)
    problems.push(`genesis ${String(genesis)} is not ${fp.genesisHash}`);
  if (v.specName !== fp.specName)
    problems.push(`spec name ${String(v.specName)} is not ${fp.specName}`);
  if (v.specVersion !== fp.specVersion)
    problems.push(`spec ${String(v.specVersion)} is not ${fp.specVersion}`);
  if (v.transactionVersion !== fp.transactionVersion)
    problems.push(`tx version ${String(v.transactionVersion)} is not ${fp.transactionVersion}`);
  if (!isHex(meta) || meta.length <= 2) problems.push("the node returned no metadata");
  if (problems.length)
    return {
      ok: false,
      reason: "mismatch",
      message: `The node does not match the recorded V3 snapshot: ${problems.join("; ")}. LIVE stays blocked.`,
    };
  const m = meta as string;
  const liveHash = blake2(m);
  const num = (header as { number?: unknown } | undefined)?.number;
  return {
    ok: true,
    facts: { ...snapshot.facts, source: { ...snapshot.facts.source, metadataHex: m } },
    report: {
      provenance: "snapshot_fingerprint_live_metadata",
      snapshotFrom: snapshot.recordedFrom,
      genesisHash: fp.genesisHash,
      specName: fp.specName,
      specVersion: fp.specVersion,
      transactionVersion: fp.transactionVersion,
      finalizedBlock:
        typeof num === "string" ? parseInt(num, 16) : typeof num === "number" ? num : null,
      metadataBytes: (m.length - 2) / 2,
      liveMetadataHash: liveHash,
      snapshotMetadataHash: fp.metadataHash,
      metadataHashMatchesSnapshot: liveHash === fp.metadataHash,
    },
  };
}

/** Shape of @seam/chain/browser's factsFromChainInputs, injected so tests and the bundle stay decoupled. */
export type FactsBuilder = (inputs: {
  metadataHex: string;
  genesisHash: string;
  runtimeVersion: { specName: string; specVersion: number; transactionVersion: number };
  properties: Record<string, unknown>;
  head: { number: number; hash: string };
  endpoint?: string;
}) => {
  fingerprint: {
    genesisHash: string;
    specName: string;
    specVersion: number;
    transactionVersion: number;
    metadataHash: string;
  };
  fingerprintDigest: string;
  [k: string]: unknown;
};

/**
 * LIVE facts: genesis, runtime version, metadata, system_properties and the finalized head are read over RPC (read-only) and
 * turned into RuntimeFacts by factsFromChainInputs. The snapshot, when given, is only compared against for display. Any RPC
 * failure, malformed reply, or a builder that throws fails closed: no facts, so loadLiveHost installs nothing.
 */
export async function discoverV3LiveFacts(
  rpc: RpcTransport,
  build: FactsBuilder,
  opts: { snapshot?: FactsSnapshot; endpoint?: string } = {},
): Promise<V3FactsResult> {
  let genesis: unknown, rv: unknown, meta: unknown, props: unknown, head: unknown, header: unknown;
  try {
    [genesis, rv, meta, props, head] = await Promise.all([
      rpc("chain_getBlockHash", [0]),
      rpc("state_getRuntimeVersion", []),
      rpc("state_getMetadata", []),
      rpc("system_properties", []),
      rpc("chain_getFinalizedHead", []),
    ]);
    header = isHex(head) ? await rpc("chain_getHeader", [head]) : undefined;
  } catch (e) {
    return { ok: false, reason: "rpc_error", message: e instanceof Error ? e.message : String(e) };
  }
  const v = (rv ?? {}) as {
    specName?: unknown;
    specVersion?: unknown;
    transactionVersion?: unknown;
  };
  const n = (header as { number?: unknown } | undefined)?.number;
  const num = typeof n === "string" ? parseInt(n, 16) : typeof n === "number" ? n : NaN;
  if (
    !isHex(genesis) ||
    typeof v.specName !== "string" ||
    typeof v.specVersion !== "number" ||
    typeof v.transactionVersion !== "number" ||
    !isHex(meta) ||
    meta.length <= 2 ||
    !props ||
    typeof props !== "object" ||
    !isHex(head) ||
    !Number.isFinite(num)
  )
    return {
      ok: false,
      reason: "rpc_error",
      message:
        "The node returned an incomplete reply (genesis, runtime version, metadata, properties or head). LIVE stays blocked.",
    };
  let facts: ReturnType<FactsBuilder>;
  try {
    facts = build({
      metadataHex: meta,
      genesisHash: genesis,
      runtimeVersion: rv as { specName: string; specVersion: number; transactionVersion: number },
      properties: props as Record<string, unknown>,
      head: { number: num, hash: head },
      endpoint: opts.endpoint,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "build_failed",
      message: `Could not build runtime facts from the live node: ${e instanceof Error ? e.message : String(e)}. LIVE stays blocked.`,
    };
  }
  const fp = facts.fingerprint;
  const snap = isFactsSnapshot(opts.snapshot) ? opts.snapshot : undefined;
  return {
    ok: true,
    facts: facts as unknown as FactsSnapshot["facts"],
    report: {
      provenance: "live_chain_inputs",
      snapshotFrom: snap?.recordedFrom ?? "none",
      genesisHash: fp.genesisHash,
      specName: fp.specName,
      specVersion: fp.specVersion,
      transactionVersion: fp.transactionVersion,
      finalizedBlock: num,
      metadataBytes: (meta.length - 2) / 2,
      liveMetadataHash: fp.metadataHash,
      snapshotMetadataHash: snap?.facts.fingerprint.metadataHash ?? "none",
      metadataHashMatchesSnapshot:
        !!snap && fp.metadataHash === snap.facts.fingerprint.metadataHash,
      liveFingerprintDigest: facts.fingerprintDigest,
      digestMatchesSnapshot: !!snap && facts.fingerprintDigest === snap.facts.fingerprintDigest,
    },
  };
}
