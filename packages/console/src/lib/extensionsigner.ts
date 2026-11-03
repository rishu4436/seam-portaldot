// WalletSigner over a Polkadot-style browser extension (window.injectedWeb3), accessed lazily at sign time.
// The extension signs a payload; turning that signature into submittable extrinsic bytes needs SCALE encoding, which this
// console does not bundle, so the host passes `assemble`. Without it, sign() answers unavailable instead of faking bytes.
import type { Res, SignedPayload, WalletSigner } from "./live";
import { decodeAddress } from "@polkadot/util-crypto";

export interface InjectedSigner {
  signPayload?: (p: unknown) => Promise<{ id?: number; signature: string }>;
}
export interface InjectedExt {
  enable: (
    origin: string,
  ) => Promise<{ accounts: { get: () => Promise<{ address: string }[]> }; signer: InjectedSigner }>;
}
export type InjectedWeb3 = Record<string, InjectedExt>;
export interface SignRequest {
  address?: string;
  payload: unknown;
}
/** A host SigningRequest carries the signer inside payload.address and the extension payload in payload. */
const asSignRequest = (request: unknown): SignRequest | undefined => {
  const r = request as { address?: string; payload?: { address?: string } } | undefined;
  if (!r || typeof r !== "object" || r.payload == null) return undefined;
  return {
    address: r.address ?? (typeof r.payload === "object" ? r.payload.address : undefined),
    payload: r.payload,
  };
};
export interface ExtensionOptions {
  extension?: string;
  appName?: string;
  assemble?: (signature: string, payload: unknown, request: unknown) => string | Promise<string>;
  getInjected?: () => InjectedWeb3 | undefined;
}

const REJECT = /cancel|reject|denied|declin|refus/i;
const un = (message: string): Res<never> => ({ ok: false, reason: "unavailable", message });

export function sameWalletAccount(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const left = decodeAddress(a),
      right = decodeAddress(b);
    return left.length === right.length && left.every((byte, i) => byte === right[i]);
  } catch {
    return false;
  }
}
type EnabledProvider = {
  accounts: { get(): Promise<{ address: string }[]> };
  signer?: InjectedSigner;
};
class WalletUnavailableError extends Error {}
/** Select the chosen wallet, or locate the provider holding the approved account for older callers. Never signs. */
export async function walletProviderFor(args: {
  address?: string;
  extension?: string;
  appName?: string;
  getInjected?: () => Record<string, { enable(app: string): Promise<unknown> }> | undefined;
}): Promise<EnabledProvider> {
  const injected = (
    args.getInjected ?? (() => (globalThis as { injectedWeb3?: InjectedWeb3 }).injectedWeb3)
  )();
  if (!injected || !Object.keys(injected).length)
    throw new WalletUnavailableError(
      "No wallet extension found. Connect a Substrate wallet first.",
    );
  const names = args.extension ? [args.extension] : Object.keys(injected);
  let fallback: EnabledProvider | undefined, failure: unknown;
  for (const name of names) {
    if (!injected[name])
      throw new WalletUnavailableError(`Wallet extension "${name}" is not installed.`);
    try {
      const provider = (await injected[name].enable(
        args.appName ?? "SEAM console",
      )) as EnabledProvider;
      if (!provider?.accounts?.get)
        throw new Error(`Wallet extension "${name}" cannot list accounts.`);
      if (args.extension || !args.address) return provider;
      fallback ??= provider;
      const accounts = await provider.accounts.get();
      if (accounts.some((account) => sameWalletAccount(account.address, args.address!)))
        return provider;
    } catch (error) {
      if (args.extension) throw error;
      failure = error;
    }
  }
  if (fallback) return fallback;
  throw failure instanceof Error ? failure : new Error("No connected wallet is available.");
}

export function createExtensionSigner(opts: ExtensionOptions = {}): WalletSigner {
  return {
    async sign(request: unknown): Promise<Res<SignedPayload>> {
      const r = asSignRequest(request);
      if (!r) return { ok: false, reason: "failed", message: "No signable payload was provided." };
      if (!opts.assemble)
        return un(
          "No extrinsic assembler is wired, so a wallet signature cannot be turned into submittable bytes.",
        );
      try {
        const enabled = await walletProviderFor({ ...opts, address: r.address });
        if (!enabled.signer?.signPayload)
          return un("This wallet does not support transaction signing.");
        if (r.address) {
          const accts = await enabled.accounts.get();
          if (!accts.some((a) => sameWalletAccount(a.address, r.address!)))
            return {
              ok: false,
              reason: "failed",
              message: "The approved signer account is not available in this wallet.",
            };
        }
        const sig = await enabled.signer.signPayload(r.payload);
        if (!sig || typeof sig.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig.signature))
          return { ok: false, reason: "failed", message: "Wallet returned no usable signature." };
        const signedTx = await opts.assemble(sig.signature, r.payload, request);
        return { ok: true, value: { signedTx } };
      } catch (e) {
        if (e instanceof WalletUnavailableError) return un(e.message);
        const m = e instanceof Error ? e.message : String(e);
        return REJECT.test(m)
          ? { ok: false, reason: "rejected", message: m }
          : { ok: false, reason: "failed", message: m };
      }
    },
  };
}
