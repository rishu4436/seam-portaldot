// Manifest Builder state: wallet accounts, the draft Manifest and JSON import/export. Pure helpers, no RPC and no signing.
// Form fields come from the compiler's argFields(); the compiler stays the authority on argument validation and encoding.
import type { InjectedWeb3 } from "./extensionsigner";

export const ACTION_KINDS = [
  "assets.transfer",
  "assets.mint",
  "nfts.mint",
  "contracts.call",
  "revive.call",
  "revive.instantiate_with_code",
  "revive.map_account",
] as const;
export type BuilderKind = (typeof ACTION_KINDS)[number];

export interface DraftAction {
  id: string;
  kind: BuilderKind;
  args: Record<string, string>;
}
export interface DraftManifest {
  version: 1;
  atomicRequired?: boolean;
  chain?: { genesisHash: string; specVersion: number };
  signer: { type: "ss58"; value: string };
  actions: Array<DraftAction & { preferredMode?: "atomic" | "sequential" }>;
}
export type Atomicity = "required" | "preferred" | "sequential";

export interface WalletAccount {
  address: string;
  name?: string;
  source: string;
}
type Res<T> = { ok: true; value: T } | { ok: false; message: string };

/** Lists accounts from every injected extension. Nothing is signed; enabling only asks the wallet to share addresses. */
export async function listWalletAccounts(
  getInjected: () => InjectedWeb3 | undefined = () =>
    (globalThis as { injectedWeb3?: InjectedWeb3 }).injectedWeb3,
  appName = "SEAM console",
): Promise<Res<WalletAccount[]>> {
  const inj = getInjected();
  const names = inj ? Object.keys(inj) : [];
  if (!inj || !names.length)
    return {
      ok: false,
      message: "No wallet extension found. Install polkadot.js or another Substrate wallet.",
    };
  const out: WalletAccount[] = [];
  const errors: string[] = [];
  for (const n of names) {
    try {
      const e = await inj[n].enable(appName);
      const accts = (await e.accounts.get()) as { address: string; name?: string }[];
      for (const a of accts) out.push({ address: a.address, name: a.name, source: n });
    } catch (e) {
      errors.push(`${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!out.length)
    return {
      ok: false,
      message: errors.length
        ? `The wallet did not share accounts (${errors.join("; ")}).`
        : "The wallet has no accounts.",
    };
  return { ok: true, value: out };
}

/** Builds the Manifest the compiler receives. Empty optional fields are dropped; values stay strings for the compiler to validate. */
export function buildManifest(
  signer: string,
  actions: DraftAction[],
  atomicity: Atomicity,
  chain?: { genesisHash: string; specVersion: number },
): DraftManifest {
  return {
    version: 1,
    ...(atomicity === "required" ? { atomicRequired: true } : {}),
    ...(chain ? { chain } : {}),
    signer: { type: "ss58", value: signer },
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      args: Object.fromEntries(Object.entries(a.args).filter(([, v]) => v.trim() !== "")),
      preferredMode: atomicity === "sequential" ? "sequential" : "atomic",
    })),
  };
}

/** Parses an imported Manifest file. Only checks the outer shape; the compiler rejects bad args. */
export function parseManifestJson(
  text: string,
): Res<{ signer?: string; actions: DraftAction[]; atomicity: Atomicity }> {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, message: "Not valid JSON." };
  }
  const m = j as Partial<DraftManifest>;
  if (!m || typeof m !== "object" || m.version !== 1)
    return { ok: false, message: "Not a SEAM Manifest (version must be 1)." };
  if (!Array.isArray(m.actions) || !m.actions.length)
    return { ok: false, message: "The Manifest has no actions." };
  const actions: DraftAction[] = [];
  const ids = new Set<string>();
  for (const a of m.actions) {
    if (!a || typeof a.id !== "string" || !a.id)
      return { ok: false, message: "Every action needs an id." };
    if (ids.has(a.id)) return { ok: false, message: `Duplicate action id "${a.id}".` };
    ids.add(a.id);
    if (!(ACTION_KINDS as readonly string[]).includes(a.kind))
      return { ok: false, message: `Unknown action kind "${String(a.kind)}".` };
    const args = a.args && typeof a.args === "object" ? a.args : {};
    actions.push({
      id: a.id,
      kind: a.kind,
      args: Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
      ),
    });
  }
  const pref = m.actions.every((a) => a.preferredMode === "sequential")
    ? "sequential"
    : "preferred";
  return {
    ok: true,
    value: {
      signer: typeof m.signer?.value === "string" ? m.signer.value : undefined,
      actions,
      atomicity: m.atomicRequired ? "required" : pref,
    },
  };
}

export function emptyAction(kind: BuilderKind, existing: DraftAction[]): DraftAction {
  let n = existing.length + 1;
  while (existing.some((a) => a.id === `step${n}`)) n++;
  return { id: `step${n}`, kind, args: {} };
}
