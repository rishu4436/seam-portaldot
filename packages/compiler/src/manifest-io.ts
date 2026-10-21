// Manifest JSON import/export for a Manifest Builder. Pure: no node builtins, safe for @seam/compiler/browser.
// Export is canonical JSON (sorted keys, no whitespace), so the same manifest always gives the same bytes and
// parse(serialize(m)) has the same manifestDigest and compiles to the same planDigest. Import is strict: unknown
// fields, unknown kinds, unknown args, floats and unsafe integers are rejected, never dropped or rounded.
// Values are not rewritten on import, so the digest of an imported manifest is the digest of its bytes' content.
import { NotCanonicalError, canonicalJson } from "./canonical.js";
import { ARG_SCHEMA, KIND_TO_CAPABILITY, validateManifestShape } from "./compile.js";
import { checkManifest, type ManifestCheck } from "./builder.js";
import {
  SeamCompileError,
  type CompileOptions,
  type RuntimeFacts,
  type ActionKind,
  type CompileIssue,
  type Manifest,
} from "./types.js";

/** Every field a version-1 manifest may carry, per object. Anything else is rejected. */
export const MANIFEST_FIELDS = {
  manifest: ["version", "atomicRequired", "chain", "signer", "actions"],
  chain: ["genesisHash", "specVersion"],
  signer: ["type", "value", "ss58Prefix"],
  action: ["id", "kind", "args", "preferredMode"],
} as const;

export type ParseManifestResult =
  | {
      ok: true;
      manifest: Manifest;
      issues: [];
      /** Present when facts were passed: the full compile() check (arg values, addresses, live availability). */
      check?: ManifestCheck;
    }
  | { ok: false; issues: CompileIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** bigint -> decimal string (amounts stay exact); everything else is returned unchanged. */
function bigintsToStrings(v: unknown): unknown {
  if (typeof v === "bigint") {
    if (v < 0n) throw new NotCanonicalError("$", "negative bigint values are not allowed");
    return v.toString();
  }
  if (Array.isArray(v)) return v.map(bigintsToStrings);
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = bigintsToStrings(x);
    return o;
  }
  return v;
}

function unknownFields(
  obj: unknown,
  allowed: readonly string[],
  path: string,
  issues: CompileIssue[],
): void {
  if (!isObj(obj)) return;
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && !allowed.includes(k))
      issues.push({
        code: "MANIFEST_INVALID",
        path: path ? `${path}.${k}` : k,
        message: `unknown field "${k}"`,
      });
  }
}

/** Structural checks shared by import and export. Value checks (addresses, amount ranges) stay in compile(). */
function strictIssues(m: unknown): CompileIssue[] {
  const issues: CompileIssue[] = [];
  if (!validateManifestShape(m, issues)) return issues;
  unknownFields(m, MANIFEST_FIELDS.manifest, "", issues);
  unknownFields(m.chain, MANIFEST_FIELDS.chain, "chain", issues);
  unknownFields(m.signer, MANIFEST_FIELDS.signer, "signer", issues);
  m.actions.forEach((a, i) => {
    unknownFields(a, MANIFEST_FIELDS.action, `actions[${i}]`, issues);
    if (!isObj(a) || !(typeof a.kind === "string" && a.kind in KIND_TO_CAPABILITY)) return;
    if (!isObj(a.args)) {
      issues.push({
        code: "MANIFEST_INVALID",
        path: `actions[${i}].args`,
        message: "args must be an object",
      });
      return;
    }
    const s = ARG_SCHEMA[a.kind as ActionKind];
    for (const k of Object.keys(a.args))
      if (a.args[k] !== undefined && !s.required.includes(k) && !s.optional.includes(k))
        issues.push({
          code: "MANIFEST_INVALID",
          path: `actions[${i}].args.${k}`,
          message: `unknown argument "${k}" for ${a.kind}`,
        });
    for (const k of s.required)
      if (a.args[k] === undefined)
        issues.push({
          code: "MANIFEST_INVALID",
          path: `actions[${i}].args.${k}`,
          message: `missing required argument "${k}" for ${a.kind}`,
        });
  });
  try {
    canonicalJson(m);
  } catch (e) {
    if (!(e instanceof NotCanonicalError)) throw e;
    issues.push({ code: "NOT_CANONICAL", path: e.path.replace(/^\$\.?/, ""), message: e.message });
  }
  return issues;
}

/**
 * Manifest -> canonical JSON text. bigint values become decimal strings. Throws SeamCompileError on a manifest
 * that parseManifest would reject, so an exported file always imports.
 */
export function serializeManifest(manifest: Manifest): string {
  let m: unknown;
  try {
    m = bigintsToStrings(manifest);
  } catch (e) {
    if (e instanceof NotCanonicalError)
      throw new SeamCompileError([{ code: "NOT_CANONICAL", path: e.path, message: e.message }]);
    throw e;
  }
  const issues = strictIssues(m);
  if (issues.length) throw new SeamCompileError(issues);
  return canonicalJson(m);
}

/** JSON text -> Manifest, strictly validated. Never throws; reports every problem with a path. */
export function parseManifest(
  text: string,
  facts?: RuntimeFacts,
  options: CompileOptions = {},
): ParseManifestResult {
  if (typeof text !== "string")
    return {
      ok: false,
      issues: [{ code: "MANIFEST_INVALID", message: "manifest JSON must be a string" }],
    };
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      issues: [{ code: "MANIFEST_INVALID", message: `not valid JSON: ${(e as Error).message}` }],
    };
  }
  // A bare number JSON.parse could not hold exactly (e.g. a 20-digit amount) is not a safe integer and is rejected.
  const issues = strictIssues(m);
  if (issues.length) return { ok: false, issues };
  const manifest = m as Manifest;
  if (!facts) return { ok: true, manifest, issues: [] };
  // With live facts, also run compile() itself: every value error (address, amount range, ABI) comes back with a
  // path, and kinds this runtime cannot run come back as check.unavailable. Facts are never substituted.
  const check = checkManifest(manifest, facts, options);
  if (check.issues.length) return { ok: false, issues: check.issues };
  return { ok: true, manifest, issues: [], check };
}
