// LIVE V3 mode goes through this single seam. The console never talks to a chain or
// wallet directly. Real implementations (SDK + chain package, injected-extension
// signer) plug in through ChainClient / WalletSigner. Until one is provided every
// call answers "unavailable" and the outcome is blocked/unknown, never success.
import type { Coverage, Provenance, SigningStatus, SimulationBasis, TxState } from "./modes";

export type Res<T> = { ok: true; value: T } | { ok: false; reason: "unavailable" | "rpc_error" | "rejected" | "ambiguous" | "failed"; message: string };

export interface LiveFingerprint { genesisHash?: string; specName?: string; specVersion?: number; transactionVersion?: number; metadataHash?: string; digest?: string; fingerprintSchemaVersion?: number }
export interface SignedPayload { signedTx: string }
export interface SubmitResult { txHash: string; state: TxState }
export interface VerifyResult { provenance: Provenance; note?: string }
export interface BindingCheck { ok: boolean; reasons: string[] }

export interface ChainClient {
  discover(): Promise<Res<LiveFingerprint>>;
  preflight(request: unknown): Promise<Res<{ simulation: SimulationBasis }>>;
  submit(signed: SignedPayload): Promise<Res<SubmitResult>>;
  verify(txHash: string): Promise<Res<VerifyResult>>;
}
export interface WalletSigner { sign(request: unknown): Promise<Res<SignedPayload>> }
/**
 * Adapter over @seam/chain verifySignedAgainstRequest(signedTx, request, ctx?). Not imported here: @seam/chain pulls
 * node-only/polkadot deps into the browser bundle, so the host injects it. Result fields match chain's SignedVerification
 * (ok, reasons[] of SignedMismatchCode). Only signedTx (the real signed bytes) is passed: a wallet-reported signedCall is never used.
 */
export type SignedBindingVerifier = (signedTx: string, request: unknown) => BindingCheck | Promise<BindingCheck>;

const NO = (what: string): Res<never> => ({ ok: false, reason: "unavailable", message: `${what} is not wired in this build.` });
export const unavailableChain: ChainClient = {
  discover: async () => NO("The chain client"), preflight: async () => NO("The chain client"),
  submit: async () => NO("The chain client"), verify: async () => NO("The chain client"),
};
export const unavailableSigner: WalletSigner = { sign: async () => NO("A wallet signer") };

export type LiveStatus = "blocked" | "unknown" | "rejected" | "failed" | "uncertain" | "unverified" | "verified";
export interface LiveOutcome {
  status: LiveStatus;
  message: string;
  fingerprint?: LiveFingerprint;
  /** Receipt coverage: what the chain showed. Stays "none" until a verifier reports more. */
  coverage: Coverage;
  /** Preflight simulation basis. */
  simulation: SimulationBasis;
  signing: SigningStatus;
  txState: TxState;
  provenance: Provenance;
  txHash?: string;
  rpcAttempts: number;
  submitted: boolean;
}

export interface LiveDeps { chain?: ChainClient; signer?: WalletSigner; verifyBinding?: SignedBindingVerifier; maxRpcAttempts?: number }

export function v3RpcUrl(raw?: string): string | undefined {
  const s = (raw ?? "").trim();
  return /^(wss?|https?):\/\/\S+$/i.test(s) ? s : undefined;
}

export async function runLive(rpcUrl: string | undefined, request: unknown, deps: LiveDeps = {}): Promise<LiveOutcome> {
  const o: LiveOutcome = { status: "blocked", message: "", coverage: "none", simulation: "none", signing: "not_started", txState: "not_run", provenance: "unknown", rpcAttempts: 0, submitted: false };
  const done = (status: LiveStatus, message: string, patch: Partial<LiveOutcome> = {}): LiveOutcome => Object.assign(o, { status, message }, patch);
  const url = v3RpcUrl(rpcUrl);
  if (!url) return done("blocked", "No V3 RPC URL is configured. LIVE V3 is blocked; nothing was contacted.");
  const chain = deps.chain ?? unavailableChain;
  const signer = deps.signer ?? unavailableSigner;

  const max = deps.maxRpcAttempts ?? 3;
  let d: Res<LiveFingerprint> = NO("The chain client");
  for (let i = 0; i < max; i++) {
    o.rpcAttempts = i + 1;
    d = await chain.discover();
    if (d.ok || d.reason !== "rpc_error") break;
  }
  if (!d.ok) return done(d.reason === "unavailable" ? "blocked" : "unknown", d.reason === "unavailable" ? d.message : `V3 RPC unreachable after ${o.rpcAttempts} attempt(s): ${d.message}`);
  o.fingerprint = d.value;

  const pf = await chain.preflight(request);
  if (pf.ok) o.simulation = pf.value.simulation; // otherwise stays "none"

  if (!deps.verifyBinding) return done("blocked", "Signed-bytes check is not wired, so nothing will be signed or sent.", { signing: "binding_unchecked" });

  o.signing = "awaiting_wallet";
  const s = await signer.sign(request);
  if (!s.ok) {
    if (s.reason === "rejected") return done("rejected", "You rejected the request in your wallet. Nothing was sent.", { signing: "rejected", txState: "rejected" });
    return done(s.reason === "unavailable" ? "blocked" : "failed", s.message, { signing: s.reason === "unavailable" ? "unavailable" : "not_started" });
  }
  o.signing = "signed";
  const b = await deps.verifyBinding(s.value.signedTx, request);
  if (!b.ok) return done("blocked", `Signed bytes differ from the approved request (${b.reasons.join(", ") || "no reason given"}). Nothing was sent.`, { signing: "binding_mismatch" });
  o.signing = "binding_ok";

  const sub = await chain.submit(s.value);
  o.submitted = true;
  if (!sub.ok) {
    if (sub.reason === "ambiguous") return done("uncertain", `Submit result is uncertain: ${sub.message}. Check the chain before retrying.`, { txState: "uncertain" });
    return done(sub.reason === "rpc_error" ? "uncertain" : "failed", sub.message, { txState: sub.reason === "rpc_error" ? "uncertain" : "failed" });
  }
  o.txHash = sub.value.txHash;
  o.txState = sub.value.state;
  if (sub.value.state === "failed") return done("failed", "The transaction failed on chain.", { provenance: "failed" });
  if (sub.value.state === "uncertain" || sub.value.state === "unknown") return done("uncertain", "The transaction state is uncertain.");
  const v = await chain.verify(sub.value.txHash);
  o.provenance = v.ok ? v.value.provenance : "unknown";
  if (sub.value.state !== "finalized") return done("unverified", `Transaction is ${sub.value.state}, not finalized. Not reported as success.`);
  if (o.provenance !== "chain_verified") return done("unverified", "Finalized, but the result was not verified against the chain. Not reported as success.");
  return done("verified", "Finalized and verified against the chain.");
}
