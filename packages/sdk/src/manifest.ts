import { computeManifestDigest } from "@seam/compiler";
import type { ActionKind, Hex, Manifest, ManifestAction, ManifestSigner } from "@seam/compiler";

export const ACTION_KINDS: readonly ActionKind[] = [
  "assets.transfer",
  "assets.mint",
  "contracts.call",
  "revive.call",
  "nfts.mint",
];
const SIGNER_TYPES = ["ss58", "accountId32", "h160"] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const AMOUNT_KEYS = ["amount", "value", "gasLimit", "proofSize", "storageDepositLimit"];

export interface ManifestIssue {
  path: string;
  message: string;
}
export type ParseResult =
  { ok: true; manifest: Manifest; digest: Hex } | { ok: false; issues: ManifestIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks the shape of a Manifest before it reaches the compiler, with a plain message per problem.
 * The compiler still does the chain-specific checks (address prefixes, argument names, encoding).
 */
export function parseManifest(input: string | unknown): ParseResult {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return {
        ok: false,
        issues: [{ path: "$", message: `not valid JSON: ${(e as Error).message}` }],
      };
    }
  }
  const issues: ManifestIssue[] = [];
  if (!isObj(raw))
    return { ok: false, issues: [{ path: "$", message: "a Manifest must be a JSON object" }] };
  for (const k of Object.keys(raw))
    if (!["version", "chain", "signer", "actions", "atomicRequired"].includes(k))
      issues.push({ path: `$.${k}`, message: `unknown field "${k}"` });
  if (raw.atomicRequired !== undefined && typeof raw.atomicRequired !== "boolean")
    issues.push({ path: "$.atomicRequired", message: "atomicRequired must be true or false" });
  if (raw.version !== 1) issues.push({ path: "$.version", message: "version must be 1" });

  if (raw.chain !== undefined) {
    const c = raw.chain;
    if (
      !isObj(c) ||
      typeof c.genesisHash !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(c.genesisHash) ||
      !Number.isSafeInteger(c.specVersion)
    ) {
      issues.push({
        path: "$.chain",
        message: "chain must be { genesisHash: 0x + 64 lowercase hex, specVersion: integer }",
      });
    }
  }

  const s = raw.signer;
  if (!isObj(s)) issues.push({ path: "$.signer", message: "signer is required: { type, value }" });
  else {
    if (!SIGNER_TYPES.includes(s.type as any))
      issues.push({
        path: "$.signer.type",
        message: `signer type must be one of ${SIGNER_TYPES.join(", ")}`,
      });
    if (typeof s.value !== "string" || !s.value)
      issues.push({ path: "$.signer.value", message: "signer value must be an address string" });
    if (s.ss58Prefix !== undefined && !Number.isSafeInteger(s.ss58Prefix))
      issues.push({ path: "$.signer.ss58Prefix", message: "ss58Prefix must be an integer" });
  }

  const acts = raw.actions;
  if (!Array.isArray(acts) || acts.length === 0)
    issues.push({ path: "$.actions", message: "actions must be a non-empty list" });
  else {
    const seen = new Set<string>();
    acts.forEach((a, i) => {
      const p = `$.actions[${i}]`;
      if (!isObj(a)) {
        issues.push({ path: p, message: "each action must be an object" });
        return;
      }
      if (typeof a.id !== "string" || !ID_RE.test(a.id))
        issues.push({ path: `${p}.id`, message: 'id must be 1-32 letters, digits, "-" or "_"' });
      else if (seen.has(a.id))
        issues.push({ path: `${p}.id`, message: `id "${a.id}" is used twice` });
      else seen.add(a.id);
      if (!ACTION_KINDS.includes(a.kind as ActionKind))
        issues.push({
          path: `${p}.kind`,
          message: `kind must be one of ${ACTION_KINDS.join(", ")}`,
        });
      if (!isObj(a.args)) issues.push({ path: `${p}.args`, message: "args must be an object" });
      else
        for (const k of AMOUNT_KEYS) {
          const v = a.args[k];
          if (v === null && k === "storageDepositLimit") continue; // null = explicitly no limit
          if (v !== undefined && (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v))) {
            issues.push({
              path: `${p}.args.${k}`,
              message: `${k} must be a whole number in base units written as a string, like "1000000"`,
            });
          }
        }
      if (
        a.preferredMode !== undefined &&
        a.preferredMode !== "atomic" &&
        a.preferredMode !== "sequential"
      ) {
        issues.push({
          path: `${p}.preferredMode`,
          message: 'preferredMode must be "atomic" or "sequential"',
        });
      }
      for (const k of Object.keys(a))
        if (!["id", "kind", "args", "preferredMode"].includes(k))
          issues.push({ path: `${p}.${k}`, message: `unknown field "${k}"` });
    });
  }
  if (issues.length) return { ok: false, issues };
  const manifest = raw as unknown as Manifest;
  return { ok: true, manifest, digest: computeManifestDigest(manifest) };
}

/** Converts a human amount like "2.5" into base units for a token with `decimals`, without floating point. */
export function toBaseUnits(amount: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`"${amount}" is not a plain decimal number`);
  const frac = m[2] ?? "";
  if (frac.length > decimals)
    throw new Error(`"${amount}" has more than ${decimals} decimal places`);
  return (
    BigInt(m[1]!) * 10n ** BigInt(decimals) +
    BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")
  ).toString();
}

/** Fields every contracts.call has. `proofSize` is for runtimes with two-part weights; `storageDepositLimit: null` means "no limit" on purpose. */
export interface ContractCallBase {
  contract: string;
  value: string;
  gasLimit: string;
  proofSize?: string;
  storageDepositLimit?: string | null;
}
/** Raw form: you supply the encoded call bytes. */
export interface ContractCallRaw extends ContractCallBase {
  data: Hex;
}
/** ABI form: name an ink! message and its arguments; the compiler encodes them. Give exactly one of `abi` or `abiRef`. */
export interface ContractCallAbi extends ContractCallBase {
  message: string;
  /** Keyed by the ABI's argument labels, or positional. */
  args?: Record<string, unknown> | unknown[];
  /** The ink! metadata.json object, inline. */
  abi?: unknown;
  /** A key of the `abis` you pass to the compiler (or to `new Seam(chain, store, { abis })`). */
  abiRef?: string;
  /** Optional pin: compiling fails with ABI_HASH_MISMATCH if the ABI hashes to something else. */
  abiHash?: Hex;
}
export type ContractCallArgs = ContractCallRaw | ContractCallAbi;

/** Small builders so app code reads like the intent. */
export const action = {
  transfer: (
    id: string,
    args: { assetId: string; amount: string; recipient: string },
  ): ManifestAction => ({ id, kind: "assets.transfer", args }),
  mint: (
    id: string,
    args: { assetId: string; amount: string; recipient: string },
  ): ManifestAction => ({ id, kind: "assets.mint", args }),
  contractCall: (id: string, args: ContractCallArgs): ManifestAction => ({
    id,
    kind: "contracts.call",
    args: args as unknown as ManifestAction["args"],
  }),
};

export function defineManifest(m: {
  signer: ManifestSigner;
  actions: ManifestAction[];
  chain?: Manifest["chain"];
  atomicRequired?: boolean;
}): Manifest {
  const r = parseManifest({ version: 1, ...m });
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  return r.manifest;
}

export { computeManifestDigest as manifestDigest };
