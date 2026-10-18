// WalletSigner over a Polkadot-style browser extension (window.injectedWeb3), accessed lazily at sign time.
// The extension signs a payload; turning that signature into submittable extrinsic bytes needs SCALE encoding, which this
// console does not bundle, so the host passes `assemble`. Without it, sign() answers unavailable instead of faking bytes.
import type { Res, SignedPayload, WalletSigner } from "./live";

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
export interface ExtensionOptions {
  extension?: string;
  appName?: string;
  assemble?: (signature: string, payload: unknown) => string | Promise<string>;
  getInjected?: () => InjectedWeb3 | undefined;
}

const REJECT = /cancel|reject|denied|declin|refus/i;
const un = (message: string): Res<never> => ({ ok: false, reason: "unavailable", message });

export function createExtensionSigner(opts: ExtensionOptions = {}): WalletSigner {
  return {
    async sign(request: unknown): Promise<Res<SignedPayload>> {
      const get =
        opts.getInjected ?? (() => (globalThis as { injectedWeb3?: InjectedWeb3 }).injectedWeb3);
      const inj = get();
      const names = inj ? Object.keys(inj) : [];
      if (!inj || !names.length)
        return un("No wallet extension found (window.injectedWeb3 is empty).");
      const name = opts.extension ?? names[0];
      const ext = inj[name];
      if (!ext) return un(`Wallet extension "${name}" is not installed.`);
      const r = request as SignRequest | undefined;
      if (!r || typeof r !== "object" || r.payload == null)
        return { ok: false, reason: "failed", message: "No signable payload was provided." };
      if (!opts.assemble)
        return un(
          "No extrinsic assembler is wired, so a wallet signature cannot be turned into submittable bytes.",
        );
      try {
        const enabled = await ext.enable(opts.appName ?? "SEAM console");
        if (!enabled.signer.signPayload) return un("This wallet does not support signPayload.");
        if (r.address) {
          const accts = await enabled.accounts.get();
          if (!accts.some((a) => a.address === r.address))
            return {
              ok: false,
              reason: "failed",
              message: "The approved signer account is not available in this wallet.",
            };
        }
        const sig = await enabled.signer.signPayload(r.payload);
        if (!sig || typeof sig.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig.signature))
          return { ok: false, reason: "failed", message: "Wallet returned no usable signature." };
        const signedTx = await opts.assemble(sig.signature, r.payload);
        return { ok: true, value: { signedTx } };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        return REJECT.test(m)
          ? { ok: false, reason: "rejected", message: m }
          : { ok: false, reason: "failed", message: m };
      }
    },
  };
}
