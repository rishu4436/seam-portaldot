import { decodeAddress } from "@polkadot/util-crypto";
import { hexToU8a, isHex, u8aToHex } from "@polkadot/util";
import type { RpcSend } from "./rpc-core.js";

/**
 * Wallet events: watches an injected browser extension (polkadot.js extension API shape) so the console can catch an
 * extension disconnect, an account switch or a wrong network BEFORE it asks the wallet to sign. Browser-safe and
 * dependency-injected: no window access, no WebSocket, no signing. Fail closed: anything uncertain is not `ready`.
 */

/** One account as the polkadot.js extension injects it. Only `address` is required. */
export interface InjectedAccountLike {
  address: string;
  genesisHash?: string | null;
  name?: string;
  type?: string;
}

/** The part of an injected extension this helper uses (`InjectedExtension.accounts`). */
export interface InjectedExtensionLike {
  accounts: {
    get(anyType?: boolean): Promise<InjectedAccountLike[]>;
    subscribe(
      cb: (accounts: InjectedAccountLike[]) => void | Promise<void>,
    ): (() => void) | Promise<() => void>;
  };
}

/** The extension, or a getter re-evaluated on every check so a removed extension is seen as a disconnect. */
export type ExtensionSource =
  InjectedExtensionLike | null | undefined | (() => InjectedExtensionLike | null | undefined);

export type SignerStatus =
  | "ready"
  | "unknown"
  | "extension_disconnected"
  | "account_missing"
  | "account_switched"
  | "wrong_network";

export interface SignerState {
  status: SignerStatus;
  /** Human-readable reason; always set when status is not `ready`. */
  reason?: string;
  /** Expected signer public key (0x hex), from expectedAddress. */
  expectedPublicKey: string;
  /** The extension's account matching the expected key, when present (its own address format). */
  account?: InjectedAccountLike;
  /** First account in the latest list (what most extensions treat as selected), as a public key. */
  firstPublicKey?: string;
  /** Last genesis hash read from rpc, when rpc was given and the read succeeded. */
  rpcGenesisHash?: string;
  /** Monotonic counter, bumped on every state change. */
  seq: number;
}

export interface WatchSignerOptions {
  extension: ExtensionSource;
  /** Signer address in any SS58 format or as a 0x public key; compared by decoded public key. */
  expectedAddress: string;
  /** Genesis hash of the chain the plan was built for (0x, 32 bytes). */
  expectedGenesisHash: string;
  /** Optional plain JSON-RPC send; when given, chain_getBlockHash(0) must equal expectedGenesisHash. */
  rpc?: RpcSend | { send(method: string, params: unknown[]): Promise<unknown> };
  /** When true, the first account in the list must be the expected one (else `account_switched`). Default false. */
  requireSelected?: boolean;
  onChange?: (state: SignerState) => void;
}

export interface SignerWatch {
  current(): SignerState;
  /** Fresh accounts.get() and (with rpc) a fresh genesis read; resolves the state if `ready`, else throws SignerNotReadyError. */
  assertReadyToSign(): Promise<SignerState>;
  stop(): void;
}

export class SignerNotReadyError extends Error {
  readonly code: Exclude<SignerStatus, "ready">;
  readonly state: SignerState;
  constructor(state: SignerState) {
    const code = state.status === "ready" ? "unknown" : state.status;
    super(`SIGNER_NOT_READY: ${code}${state.reason ? ` (${state.reason})` : ""}`);
    this.name = "SignerNotReadyError";
    this.code = code;
    this.state = state;
  }
}

/** Public key (0x hex) of an SS58 address or 0x key; undefined if it does not decode. */
export function publicKeyOf(address: string): string | undefined {
  try {
    return u8aToHex(decodeAddress(isHex(address) ? hexToU8a(address) : address)).toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when two addresses (any SS58 prefix or 0x key) carry the same public key. */
export function sameSigner(a: string, b: string): boolean {
  const ka = publicKeyOf(a);
  return ka !== undefined && ka === publicKeyOf(b);
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

export function watchSigner(opts: WatchSignerOptions): SignerWatch {
  const expectedPublicKey = publicKeyOf(opts.expectedAddress);
  if (!expectedPublicKey)
    throw new Error(`watchSigner: expectedAddress does not decode: ${opts.expectedAddress}`);
  if (!HASH32.test(opts.expectedGenesisHash))
    throw new Error(`watchSigner: expectedGenesisHash is not a 32-byte 0x hash`);
  const expectedGenesis = opts.expectedGenesisHash.toLowerCase();
  const send = opts.rpc
    ? typeof opts.rpc === "function"
      ? opts.rpc
      : (m: string, p: unknown[]) => (opts.rpc as { send: RpcSend }).send(m, p)
    : undefined;

  let stopped = false;
  let unsub: (() => void) | undefined;
  let disconnected: string | undefined;
  let subFailed = false; // the subscription itself failed: stays disconnected until a new watch
  let accounts: InjectedAccountLike[] | undefined;
  let rpcGenesis: string | undefined;
  let rpcError: string | undefined;
  let lastFirstKey: string | undefined; // first-account key at the last moment the expected key was first
  let switched = false;
  let state: SignerState = {
    status: "unknown",
    reason: "no account list received yet",
    expectedPublicKey,
    seq: 0,
  };

  const resolveExt = (): InjectedExtensionLike | undefined => {
    try {
      const e = typeof opts.extension === "function" ? opts.extension() : opts.extension;
      return e && e.accounts && typeof e.accounts.get === "function" ? e : undefined;
    } catch {
      return undefined;
    }
  };

  const compute = (): Omit<SignerState, "seq"> => {
    const base = { expectedPublicKey, rpcGenesisHash: rpcGenesis };
    if (stopped) return { ...base, status: "unknown", reason: "watch stopped" };
    if (disconnected || !resolveExt())
      return {
        ...base,
        status: "extension_disconnected",
        reason: disconnected ?? "extension not available",
      };
    if (!accounts) return { ...base, status: "unknown", reason: "no account list received yet" };
    const keys = accounts.map((a) => publicKeyOf(a.address));
    const firstPublicKey = keys[0];
    const idx = keys.indexOf(expectedPublicKey);
    if (idx < 0)
      return {
        ...base,
        firstPublicKey,
        status: "account_missing",
        reason: "expected signer not in the extension's accounts",
      };
    const account = accounts[idx];
    const withAcc = { ...base, firstPublicKey, account };
    if (switched || (opts.requireSelected && idx !== 0))
      return {
        ...withAcc,
        status: "account_switched",
        reason: "the selected (first) account is not the expected signer",
      };
    const accGenesis = account.genesisHash;
    if (accGenesis && accGenesis.toLowerCase() !== expectedGenesis)
      return {
        ...withAcc,
        status: "wrong_network",
        reason: `account is restricted to genesis ${accGenesis}`,
      };
    if (send) {
      if (rpcError)
        return { ...withAcc, status: "unknown", reason: `genesis read failed: ${rpcError}` };
      if (!rpcGenesis) return { ...withAcc, status: "unknown", reason: "genesis not read yet" };
      if (rpcGenesis !== expectedGenesis)
        return {
          ...withAcc,
          status: "wrong_network",
          reason: `node genesis ${rpcGenesis} differs from expected`,
        };
    }
    return { ...withAcc, status: "ready" };
  };

  const update = () => {
    const next = compute();
    const changed =
      next.status !== state.status ||
      next.reason !== state.reason ||
      next.firstPublicKey !== state.firstPublicKey ||
      next.account?.address !== state.account?.address ||
      next.rpcGenesisHash !== state.rpcGenesisHash;
    if (!changed) return;
    state = { ...next, seq: state.seq + 1 };
    if (!stopped || next.reason === "watch stopped") {
      try {
        opts.onChange?.(state);
      } catch {
        /* a listener error must not break the watch */
      }
    }
  };

  const setAccounts = (list: unknown) => {
    if (stopped) return;
    if (
      !Array.isArray(list) ||
      list.some((a) => !a || typeof (a as InjectedAccountLike).address !== "string")
    ) {
      disconnected = "extension sent an invalid account list";
      accounts = undefined;
      update();
      return;
    }
    if (disconnected && !subFailed) disconnected = undefined;
    const prev = accounts;
    accounts = list as InjectedAccountLike[];
    const first = publicKeyOf(accounts[0]?.address ?? "");
    // Switch detection: the expected signer was first, and now a different account is first while it is still listed.
    if (
      prev &&
      lastFirstKey === expectedPublicKey &&
      first !== expectedPublicKey &&
      accounts.some((a) => publicKeyOf(a.address) === expectedPublicKey)
    )
      switched = true;
    if (first === expectedPublicKey) switched = false;
    lastFirstKey = first;
    update();
  };

  const readGenesis = async () => {
    if (!send) return;
    try {
      const g = await send("chain_getBlockHash", [0]);
      if (typeof g !== "string" || !HASH32.test(g))
        throw new Error(`unexpected genesis value ${JSON.stringify(g)}`);
      rpcGenesis = g.toLowerCase();
      rpcError = undefined;
    } catch (e) {
      rpcGenesis = undefined;
      rpcError = (e as Error)?.message ?? String(e);
    }
  };

  // Start: subscribe (errors -> disconnected), seed with get(), read genesis.
  const ext = resolveExt();
  if (!ext) {
    disconnected = "extension not available";
    update();
  } else {
    try {
      const r = ext.accounts.subscribe((list) => setAccounts(list));
      Promise.resolve(r).then(
        (u) => {
          if (stopped) {
            try {
              u?.();
            } catch {
              /* ignore */
            }
          } else unsub = u;
        },
        (e) => {
          subFailed = true;
          disconnected = `account subscription failed: ${(e as Error)?.message ?? e}`;
          update();
        },
      );
    } catch (e) {
      subFailed = true;
      disconnected = `account subscription failed: ${(e as Error)?.message ?? e}`;
      update();
    }
    ext.accounts.get().then(
      (list) => {
        if (!accounts) setAccounts(list);
      },
      (e) => {
        disconnected = `accounts.get failed: ${(e as Error)?.message ?? e}`;
        update();
      },
    );
  }
  void readGenesis().then(update);

  return {
    current: () => state,
    async assertReadyToSign() {
      if (stopped)
        throw new SignerNotReadyError({ ...state, status: "unknown", reason: "watch stopped" });
      const e = resolveExt();
      if (!e) {
        disconnected = "extension not available";
      } else if (!subFailed) {
        try {
          setAccounts(await e.accounts.get());
        } catch (err) {
          disconnected = `accounts.get failed: ${(err as Error)?.message ?? err}`;
        }
      }
      await readGenesis();
      update();
      const s = compute();
      if (s.status !== "ready") throw new SignerNotReadyError({ ...s, seq: state.seq });
      return state;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        unsub?.();
      } catch {
        /* ignore */
      }
      unsub = undefined;
      update();
    },
  };
}
