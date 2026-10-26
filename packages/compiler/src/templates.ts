// P1-04 action templates. Pure: no node builtins, safe for @seam/compiler/browser.
// A template is a parameterised version-1 Manifest. instantiateTemplate fills it from caller params, exports it with
// serializeManifest and re-imports it with parseManifest (and, when facts are given, the full compile() check), so a
// template never bypasses the normal import path. There are no default wallet addresses: every account, asset and
// amount is a required parameter. A missing parameter is reported, never invented. templateSkeleton() gives the
// manifest with explicit "{{param}}" placeholders, which parseManifest with live facts (and compile) reject.
// Template ids and modes say what is REQUESTED; they prove nothing about execution. The atomic batch template only
// asks for atomic mode: the compiler labels it atomic_unverified unless a matching rollback proof is in the facts.
import { keccakAsHex } from "@polkadot/util-crypto";
import { parseManifest, serializeManifest } from "./manifest-io.js";
import type { ManifestCheck } from "./builder.js";
import type { ActionKind, CompileIssue, CompileOptions, Manifest, RuntimeFacts } from "./types.js";

export type TemplateId =
  | "asset-transfer"
  | "nft-mint"
  | "asset-mint"
  | "sequential-transfers"
  | "atomic-batch"
  | "revive-call"
  | "restricted-deploy";

export interface TemplateParam {
  name: string;
  description: string;
  /** Hint for a form field. Values are always strings (base units, SS58, H160 or hex). */
  type: "address" | "h160" | "assetId" | "amount" | "uint" | "hex";
  optional?: boolean;
}

export interface TemplateInfo {
  id: TemplateId;
  title: string;
  description: string;
  kinds: ActionKind[];
  /** Requested execution mode. "atomic" means atomicRequired: never silently downgraded to sequential. */
  mode: "single" | "sequential" | "atomic";
  params: TemplateParam[];
  /** Plain-language caveat shown next to the template, when there is one. */
  note?: string;
}

export type TemplateParams = Record<string, string | undefined>;

export type InstantiateResult =
  | {
      ok: true;
      id: TemplateId;
      /** Canonical manifest JSON from serializeManifest, already re-validated by parseManifest. */
      manifestText: string;
      manifest: Manifest;
      /** Present when facts were passed: the parseManifest/compile check against those live facts. */
      check?: ManifestCheck;
      /** restricted-deploy only: keccak-256 of `code`, the same value compile() puts in decodedArgs.codeHash. */
      codeHash?: `0x${string}`;
    }
  | { ok: false; id: string; issues: CompileIssue[] };

const P = {
  signer: {
    name: "signer",
    type: "address",
    description: "Signing account (SS58 or AccountId32 hex)",
  },
  recipient: { name: "recipient", type: "address", description: "Receiving account" },
  assetId: { name: "assetId", type: "assetId", description: "Asset id (integer string)" },
  amount: { name: "amount", type: "amount", description: "Amount in the asset's base units" },
} as const satisfies Record<string, TemplateParam>;
const p = (name: string, type: TemplateParam["type"], description: string, optional = false) =>
  ({ name, type, description, ...(optional ? { optional } : {}) }) as TemplateParam;

const DEFS: Record<TemplateId, TemplateInfo & { build: (v: TemplateParams) => Manifest }> = {
  "asset-transfer": {
    id: "asset-transfer",
    title: "Asset transfer",
    description: "Send an amount of one asset to one recipient (Assets.transfer_keep_alive).",
    kinds: ["assets.transfer"],
    mode: "single",
    params: [P.signer, P.recipient, P.assetId, P.amount],
    build: (v) =>
      base(v, [
        {
          id: "transfer",
          kind: "assets.transfer",
          args: { assetId: v.assetId, amount: v.amount, recipient: v.recipient },
        },
      ]),
  },
  "nft-mint": {
    id: "nft-mint",
    title: "NFT mint",
    description:
      "Mint one item of an existing collection to a recipient (Nfts.mint, no witness data).",
    kinds: ["nfts.mint"],
    mode: "single",
    params: [
      P.signer,
      P.recipient,
      p("collection", "uint", "Collection id"),
      p("item", "uint", "Item id"),
    ],
    build: (v) =>
      base(v, [
        {
          id: "mint-nft",
          kind: "nfts.mint",
          args: { collection: v.collection, item: v.item, recipient: v.recipient },
        },
      ]),
  },
  "asset-mint": {
    id: "asset-mint",
    title: "Asset mint",
    description: "Mint new units of an asset the signer issues to a recipient (Assets.mint).",
    kinds: ["assets.mint"],
    mode: "single",
    params: [P.signer, P.recipient, P.assetId, P.amount],
    build: (v) =>
      base(v, [
        {
          id: "mint",
          kind: "assets.mint",
          args: { assetId: v.assetId, amount: v.amount, recipient: v.recipient },
        },
      ]),
  },
  "sequential-transfers": {
    id: "sequential-transfers",
    title: "Multi-step sequential plan",
    description:
      "Two asset transfers signed and submitted one after another; step 2 runs only if step 1 is verified.",
    kinds: ["assets.transfer"],
    mode: "sequential",
    params: [
      P.signer,
      P.assetId,
      p("recipient1", "address", "Step 1 recipient"),
      p("amount1", "amount", "Step 1 amount (base units)"),
      p("recipient2", "address", "Step 2 recipient"),
      p("amount2", "amount", "Step 2 amount (base units)"),
    ],
    note: "Sequential: if step 2 fails, step 1 stays executed (partial execution).",
    build: (v) =>
      base(v, [
        {
          id: "step-1",
          kind: "assets.transfer",
          preferredMode: "sequential",
          args: { assetId: v.assetId, amount: v.amount1, recipient: v.recipient1 },
        },
        {
          id: "step-2",
          kind: "assets.transfer",
          preferredMode: "sequential",
          args: { assetId: v.assetId, amount: v.amount2, recipient: v.recipient2 },
        },
      ]),
  },
  "atomic-batch": {
    id: "atomic-batch",
    title: "Atomic batch",
    description:
      "Two asset transfers in one Utility.batch_all; atomic mode is required, never downgraded to sequential.",
    kinds: ["assets.transfer"],
    mode: "atomic",
    params: [
      P.signer,
      P.assetId,
      p("recipient1", "address", "Transfer 1 recipient"),
      p("amount1", "amount", "Transfer 1 amount (base units)"),
      p("recipient2", "address", "Transfer 2 recipient"),
      p("amount2", "amount", "Transfer 2 amount (base units)"),
    ],
    note: "Requests atomic mode only. The plan is atomic_unverified (and needs allowAtomicUnverified) unless the runtime facts carry a matching rollback proof; only then is it atomic_verified.",
    build: (v) => ({
      ...base(v, [
        {
          id: "batch-1",
          kind: "assets.transfer",
          preferredMode: "atomic",
          args: { assetId: v.assetId, amount: v.amount1, recipient: v.recipient1 },
        },
        {
          id: "batch-2",
          kind: "assets.transfer",
          preferredMode: "atomic",
          args: { assetId: v.assetId, amount: v.amount2, recipient: v.recipient2 },
        },
      ]),
      atomicRequired: true,
    }),
  },
  "revive-call": {
    id: "revive-call",
    title: "Revive contract call",
    description:
      "Call a pallet-revive contract with raw call data, explicit weight and storage-deposit limits.",
    kinds: ["revive.call"],
    mode: "single",
    params: [
      P.signer,
      p("contract", "h160", "Contract address (H160)"),
      p("data", "hex", "Call data (0x hex, selector first)"),
      p("value", "uint", "Native value sent (base units); use 0 unless the message is payable"),
      p("gasLimit", "uint", "weight_limit.ref_time"),
      p("proofSize", "uint", "weight_limit.proof_size"),
      p("storageDepositLimit", "uint", "Max storage deposit (base units)"),
    ],
    build: (v) =>
      base(v, [
        {
          id: "call",
          kind: "revive.call",
          args: {
            contract: v.contract,
            value: v.value,
            data: v.data,
            gasLimit: v.gasLimit,
            proofSize: v.proofSize,
            storageDepositLimit: v.storageDepositLimit,
          },
        },
      ]),
  },
  "restricted-deploy": {
    id: "restricted-deploy",
    title: "Restricted deployment",
    description:
      "Deploy contract code with Revive.instantiate_with_code: value fixed at 0 and explicit finite gas, proof-size and storage-deposit limits. The code hash is computed from the code.",
    kinds: ["revive.instantiate_with_code"],
    mode: "single",
    params: [
      P.signer,
      p("code", "hex", "Contract code (0x hex)"),
      p("data", "hex", "Constructor data (0x hex, may be 0x)"),
      p("gasLimit", "uint", "weight_limit.ref_time"),
      p("proofSize", "uint", "weight_limit.proof_size"),
      p("storageDepositLimit", "uint", "Max storage deposit (base units)"),
      p("salt", "hex", "Optional 32-byte salt", true),
    ],
    note: "Policy still decides: the deploy is blocked unless Policy.deploy allow-lists this code hash and caps gas, proof size and storage deposit.",
    build: (v) =>
      base(v, [
        {
          id: "deploy",
          kind: "revive.instantiate_with_code",
          args: {
            value: "0",
            gasLimit: v.gasLimit,
            proofSize: v.proofSize,
            storageDepositLimit: v.storageDepositLimit,
            code: v.code,
            data: v.data,
            ...(v.salt !== undefined ? { salt: v.salt } : {}),
          },
        },
      ]),
  },
};

function base(v: TemplateParams, actions: Manifest["actions"]): Manifest {
  return { version: 1, signer: { type: "ss58", value: v.signer as string }, actions };
}

/** "{{name}}": the explicit marker for an unfilled parameter. */
export const PLACEHOLDER = /\{\{[^}]*\}\}/;
const placeholder = (name: string) => `{{${name}}}`;

/** Metadata for every template, in a fixed order. */
export function listTemplates(): TemplateInfo[] {
  return Object.values(DEFS).map(({ build: _b, ...info }) => ({
    ...info,
    kinds: [...info.kinds],
    params: info.params.map((x) => ({ ...x })),
  }));
}

/**
 * The template's manifest text with every parameter left as an explicit "{{name}}" placeholder. It is NOT a
 * usable manifest: parseManifest with live facts, and compile(), reject it.
 */
export function templateSkeleton(id: TemplateId): string {
  const def = DEFS[id];
  if (!def) throw new Error(`unknown template "${id}"`);
  const v: TemplateParams = {};
  for (const x of def.params) if (!x.optional) v[x.name] = placeholder(x.name);
  return JSON.stringify(def.build(v), null, 2);
}

/**
 * Fill a template and return its manifest via serializeManifest -> parseManifest (with facts: the full compile
 * check too). Missing, empty, placeholder or unknown parameters are rejected with a path; nothing is defaulted.
 */
export function instantiateTemplate(
  id: string,
  params: TemplateParams,
  facts?: RuntimeFacts,
  options: CompileOptions = {},
): InstantiateResult {
  const def = (DEFS as Record<string, (typeof DEFS)[TemplateId]>)[id];
  if (!def)
    return {
      ok: false,
      id,
      issues: [{ code: "MANIFEST_INVALID", message: `unknown template "${id}"` }],
    };
  const issues: CompileIssue[] = [];
  const known = new Set(def.params.map((x) => x.name));
  for (const k of Object.keys(params))
    if (!known.has(k))
      issues.push({
        code: "MANIFEST_INVALID",
        path: `params.${k}`,
        message: `unknown parameter "${k}" for ${id}`,
      });
  for (const x of def.params) {
    const val = params[x.name];
    if (val === undefined) {
      if (!x.optional)
        issues.push({
          code: "MANIFEST_INVALID",
          path: `params.${x.name}`,
          message: `missing required parameter "${x.name}"`,
        });
    } else if (typeof val !== "string" || val.trim() === "" || PLACEHOLDER.test(val))
      issues.push({
        code: "MANIFEST_INVALID",
        path: `params.${x.name}`,
        message: `parameter "${x.name}" is unfilled or not a string`,
      });
  }
  if (issues.length) return { ok: false, id, issues };
  let text: string;
  try {
    text = serializeManifest(def.build(params));
  } catch (e) {
    const is = (e as { issues?: CompileIssue[] }).issues;
    if (is) return { ok: false, id, issues: is };
    throw e;
  }
  const parsed = parseManifest(text, facts, options);
  if (!parsed.ok) return { ok: false, id, issues: parsed.issues };
  return {
    ok: true,
    id: def.id,
    manifestText: text,
    manifest: parsed.manifest,
    ...(parsed.check ? { check: parsed.check } : {}),
    ...(id === "restricted-deploy" ? { codeHash: keccakAsHex(params.code as string, 256) } : {}),
  };
}
