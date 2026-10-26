// Wallet events for the LIVE console: Chainsmith's watchSigner (@seam/chain/browser). Signing is only allowed while the
// watch says `ready`; assertReadyToSign() runs (with fresh reads) before every signPayload and again before every
// submit. On SignerNotReadyError the run stops and nothing is broadcast. Read-only: the watch never signs.
import {
  SignerNotReadyError,
  watchSigner,
  type SignerState,
  type SignerStatus,
  type SignerWatch,
} from "@seam/chain/browser";

export type { SignerState, SignerWatch };

/** Plain words for each signer status. */
export const SIGNER_STATUS_TEXT: Record<SignerStatus, string> = {
  ready: "Wallet ready: the expected account is connected on the right network.",
  unknown: "Wallet state unknown, so signing is disabled.",
  extension_disconnected:
    "The wallet extension is disconnected or not installed, so signing is disabled.",
  account_missing: "The plan's signer account is not in the wallet, so signing is disabled.",
  account_switched: "The wallet switched to a different account, so signing is disabled.",
  wrong_network:
    "The wallet or node is on a different network than the plan, so signing is disabled.",
};

export function signerStateText(s: SignerState | undefined): string {
  if (!s) return SIGNER_STATUS_TEXT.unknown;
  const base = SIGNER_STATUS_TEXT[s.status] ?? SIGNER_STATUS_TEXT.unknown;
  return s.status !== "ready" && s.reason ? `${base} (${s.reason})` : base;
}

/** Sign stays disabled unless the status is exactly `ready`. */
export const canSign = (s: SignerState | undefined): boolean => s?.status === "ready";

/** assertReadyToSign with fresh reads; a not-ready signer becomes a stop message (nothing signed or sent). */
export async function readyOrStop(
  watch: Pick<SignerWatch, "assertReadyToSign">,
  when: "sign" | "submit",
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  try {
    await watch.assertReadyToSign();
    return { ok: true };
  } catch (e) {
    const code = e instanceof SignerNotReadyError ? e.code : "unknown";
    const text =
      e instanceof SignerNotReadyError
        ? signerStateText(e.state)
        : `${SIGNER_STATUS_TEXT.unknown} (${e instanceof Error ? e.message : String(e)})`;
    return {
      ok: false,
      code,
      message: `SIGNER_NOT_READY before ${when}: ${text} Nothing was ${when === "sign" ? "signed" : "sent"}.`,
    };
  }
}

type InjectedLike = Record<string, { enable(app: string): Promise<unknown> }>;

/**
 * Opens the first injected extension and starts the watch. With no extension the watch still starts and reports
 * extension_disconnected, so signing stays disabled.
 */
export async function openSignerWatch(args: {
  expectedAddress: string;
  expectedGenesisHash: string;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  onChange?: (s: SignerState) => void;
  getInjected?: () => InjectedLike | undefined;
  watch?: typeof watchSigner;
}): Promise<SignerWatch> {
  const inj = (
    args.getInjected ?? (() => (globalThis as { injectedWeb3?: InjectedLike }).injectedWeb3)
  )();
  const name = inj ? Object.keys(inj)[0] : undefined;
  let ext: unknown;
  try {
    ext = name ? await inj![name]!.enable("SEAM console") : undefined;
  } catch {
    ext = undefined;
  }
  return (args.watch ?? watchSigner)({
    extension: () => ext as never,
    expectedAddress: args.expectedAddress,
    expectedGenesisHash: args.expectedGenesisHash,
    rpc: args.rpc as never,
    onChange: args.onChange,
  });
}
