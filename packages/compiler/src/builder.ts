// Helpers for a Manifest Builder UI. Pure: no node builtins, so the browser entry can use them.
// Field lists describe the manifest arguments compile() accepts; validation is compile() itself, never a copy.
import { ARG_SCHEMA, compile } from "./compile.js";
import {
  SeamCompileError,
  type ActionKind,
  type CompileIssue,
  type CompileOptions,
  type Manifest,
  type Plan,
  type RuntimeFacts,
} from "./types.js";

export type ArgFieldType =
  | "amount" // non-negative integer string, chain base units
  | "id" // non-negative integer string (asset, collection, item)
  | "accountAddress" // SS58 account
  | "contractAddress" // contract address as this runtime expects it (H160 for Revive)
  | "hexBytes" // 0x-prefixed bytes
  | "weight" // non-negative integer string
  | "salt" // 0x + 32 bytes
  | "json"; // ink! ABI fields of contracts.call

export interface ArgField {
  name: string;
  type: ArgFieldType;
  required: boolean;
  description: string;
}

const T: Record<string, [ArgFieldType, string]> = {
  assetId: ["id", "Asset id"],
  amount: ["amount", "Amount in the asset's base units"],
  recipient: ["accountAddress", "Recipient account"],
  collection: ["id", "NFT collection id"],
  item: ["id", "NFT item id"],
  contract: ["contractAddress", "Contract address"],
  value: ["amount", "Native value sent with the call, in base units"],
  gasLimit: ["weight", "Weight limit: ref_time"],
  proofSize: ["weight", "Weight limit: proof_size"],
  storageDepositLimit: ["amount", "Storage deposit limit, in base units"],
  data: ["hexBytes", "Call data or constructor input"],
  code: ["hexBytes", "Contract code to deploy. Its keccak-256 becomes the plan's codeHash"],
  salt: ["salt", "Optional 32-byte salt"],
  message: ["json", "ink! message name"],
  args: ["json", "ink! message arguments"],
  abi: ["json", "ink! ABI"],
  abiRef: ["json", "Reference to an ink! ABI"],
  abiHash: ["hexBytes", "Expected ABI hash"],
};

/** The manifest arguments each kind takes. Derived from the compiler's own schema, so they cannot drift apart. */
export function argFields(kind: ActionKind): ArgField[] {
  const s = ARG_SCHEMA[kind];
  if (!s) throw new Error(`unknown action kind ${kind}`);
  const f = (name: string, required: boolean): ArgField => {
    const [type, description] = T[name] ?? ["json", name];
    return { name, type, required, description };
  };
  return [...s.required.map((n) => f(n, true)), ...s.optional.map((n) => f(n, false))];
}

export interface ManifestCheck {
  ok: boolean;
  /** Manifest-level errors, each with a path such as actions[0].args.amount. */
  issues: CompileIssue[];
  /** Steps compile() marked unavailable on this runtime, with the reason. */
  unavailable: { step: number; actionId: string; reason: string; reasonCode?: string }[];
  plan?: Plan;
}

/** Runs compile() and reports every problem by field or step instead of throwing. */
export function checkManifest(
  manifest: Manifest,
  facts: RuntimeFacts,
  options: CompileOptions = {},
): ManifestCheck {
  let plan: Plan;
  try {
    plan = compile(manifest, facts, options);
  } catch (e) {
    if (e instanceof SeamCompileError) return { ok: false, issues: e.issues, unavailable: [] };
    throw e;
  }
  const unavailable = plan.steps
    .map((s, step) => ({ s, step }))
    .filter(({ s }) => s.status !== "ok")
    .map(({ s, step }) => ({
      step,
      actionId: s.actionId,
      reason: s.reason ?? "unavailable",
      ...(s.reasonCode ? { reasonCode: s.reasonCode } : {}),
    }));
  return { ok: unavailable.length === 0, issues: [], unavailable, plan };
}
