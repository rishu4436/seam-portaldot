import { describe, expect, it, vi } from "vitest";
import { encodeAddress } from "@polkadot/util-crypto";
import {
  watchSigner,
  sameSigner,
  SignerNotReadyError,
  type InjectedAccountLike,
  type InjectedExtensionLike,
  type SignerState,
} from "../src/browser.js";
import * as nodeEntry from "../src/index.js";

/** Real Portaldot V3 testnet genesis, read live: chain_getBlockHash(0) on https://test-node-v3.portaldot.dev (2026-10-21). */
const V3_GENESIS = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
const OTHER_GENESIS = "0x" + "11".repeat(32);

// Well-known public dev keys (Alice, Bob); no secrets.
const ALICE_PK = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const BOB_PK = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48";
const ALICE_42 = encodeAddress(ALICE_PK, 42);
const ALICE_0 = encodeAddress(ALICE_PK, 0);
const BOB_42 = encodeAddress(BOB_PK, 42);

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeExtension implements InjectedExtensionLike {
  list: InjectedAccountLike[];
  subs = new Set<(a: InjectedAccountLike[]) => void>();
  unsubCalls = 0;
  failSubscribe = false;
  failGet = false;
  constructor(list: InjectedAccountLike[]) {
    this.list = list;
  }
  accounts = {
    get: async () => {
      if (this.failGet) throw new Error("extension gone");
      return this.list;
    },
    subscribe: (cb: (a: InjectedAccountLike[]) => void) => {
      if (this.failSubscribe) throw new Error("port closed");
      this.subs.add(cb);
      queueMicrotask(() => cb(this.list));
      return () => {
        this.unsubCalls++;
        this.subs.delete(cb);
      };
    },
  };
  emit(list: InjectedAccountLike[] | unknown) {
    this.list = list as InjectedAccountLike[];
    for (const cb of this.subs) cb(this.list);
  }
}

function rpcOf(genesis: string | (() => Promise<unknown>)) {
  return vi.fn(async (method: string) => {
    expect(method).toBe("chain_getBlockHash");
    return typeof genesis === "string" ? genesis : genesis();
  });
}

async function start(
  ext: FakeExtension | (() => FakeExtension | undefined),
  extra: Partial<Parameters<typeof watchSigner>[0]> = {},
) {
  const states: SignerState[] = [];
  const w = watchSigner({
    extension: ext,
    expectedAddress: ALICE_42,
    expectedGenesisHash: V3_GENESIS,
    onChange: (s) => states.push(s),
    ...extra,
  });
  await tick();
  await tick();
  return { w, states };
}

describe("watchSigner", () => {
  it("is exported from both the browser and node entries", () => {
    expect(nodeEntry.watchSigner).toBe(watchSigner);
    expect(nodeEntry.SignerNotReadyError).toBe(SignerNotReadyError);
  });

  it("starts unknown, then ready on the first account list", async () => {
    const ext = new FakeExtension([{ address: ALICE_42 }]);
    const w = watchSigner({
      extension: ext,
      expectedAddress: ALICE_42,
      expectedGenesisHash: V3_GENESIS,
    });
    expect(w.current().status).toBe("unknown");
    await tick();
    expect(w.current().status).toBe("ready");
    await expect(w.assertReadyToSign()).resolves.toMatchObject({ status: "ready" });
  });

  it("treats the same key in different SS58 formats (and as 0x) as the same signer", async () => {
    expect(sameSigner(ALICE_0, ALICE_42)).toBe(true);
    expect(sameSigner(ALICE_PK, ALICE_42)).toBe(true);
    expect(sameSigner(ALICE_42, BOB_42)).toBe(false);
    expect(sameSigner("not-an-address", "not-an-address")).toBe(false);
    const { w } = await start(new FakeExtension([{ address: ALICE_0 }]));
    expect(w.current().status).toBe("ready");
    expect(w.current().account?.address).toBe(ALICE_0);
  });

  it("extension disconnect mid-flow: subscription error, invalid list, missing extension, get() failure", async () => {
    const ext = new FakeExtension([{ address: ALICE_42 }]);
    let present = true;
    const { w, states } = await start(() => (present ? ext : undefined));
    expect(w.current().status).toBe("ready");
    present = false;
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "extension_disconnected" });
    expect(states.at(-1)?.status).toBe("extension_disconnected");
    present = true;
    ext.emit(null);
    expect(w.current().status).toBe("extension_disconnected");
    ext.emit([{ address: ALICE_42 }]);
    expect(w.current().status).toBe("ready");
    ext.failGet = true;
    await expect(w.assertReadyToSign()).rejects.toBeInstanceOf(SignerNotReadyError);
    expect(w.current().status).toBe("extension_disconnected");

    const bad = new FakeExtension([{ address: ALICE_42 }]);
    bad.failSubscribe = true;
    const r2 = await start(bad);
    expect(r2.w.current().status).toBe("extension_disconnected");
    await expect(r2.w.assertReadyToSign()).rejects.toMatchObject({
      code: "extension_disconnected",
    });

    const none = await start(() => undefined);
    expect(none.w.current().status).toBe("extension_disconnected");
  });

  it("account removed mid-flow -> account_missing", async () => {
    const ext = new FakeExtension([{ address: ALICE_42 }, { address: BOB_42 }]);
    const { w } = await start(ext);
    ext.emit([{ address: BOB_42 }]);
    expect(w.current().status).toBe("account_missing");
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "account_missing" });
    ext.emit([]);
    expect(w.current().status).toBe("account_missing");
  });

  it("account switch mid-flow -> account_switched, and back to ready when switched back", async () => {
    const ext = new FakeExtension([{ address: ALICE_42 }, { address: BOB_42 }]);
    const { w } = await start(ext);
    expect(w.current().status).toBe("ready");
    ext.emit([{ address: BOB_42 }, { address: ALICE_42 }]);
    expect(w.current().status).toBe("account_switched");
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "account_switched" });
    ext.emit([{ address: ALICE_0 }, { address: BOB_42 }]);
    expect(w.current().status).toBe("ready");
  });

  it("requireSelected: expected signer must be first", async () => {
    const { w } = await start(new FakeExtension([{ address: BOB_42 }, { address: ALICE_42 }]), {
      requireSelected: true,
    });
    expect(w.current().status).toBe("account_switched");
    const { w: w2 } = await start(new FakeExtension([{ address: BOB_42 }, { address: ALICE_42 }]));
    expect(w2.current().status).toBe("ready");
  });

  it("account restricted to another genesis -> wrong_network; same genesis or null is fine", async () => {
    const ext = new FakeExtension([{ address: ALICE_42, genesisHash: OTHER_GENESIS }]);
    const { w } = await start(ext);
    expect(w.current().status).toBe("wrong_network");
    ext.emit([{ address: ALICE_42, genesisHash: V3_GENESIS.toUpperCase().replace("0X", "0x") }]);
    expect(w.current().status).toBe("ready");
    ext.emit([{ address: ALICE_42, genesisHash: null }]);
    expect(w.current().status).toBe("ready");
  });

  it("rpc genesis mismatch -> wrong_network; match -> ready; assert re-reads genesis fresh", async () => {
    let g = V3_GENESIS;
    const rpc = rpcOf(async () => g);
    const { w } = await start(new FakeExtension([{ address: ALICE_42 }]), { rpc });
    expect(w.current().status).toBe("ready");
    expect(w.current().rpcGenesisHash).toBe(V3_GENESIS);
    const before = rpc.mock.calls.length;
    g = OTHER_GENESIS;
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "wrong_network" });
    expect(rpc.mock.calls.length).toBe(before + 1);
    g = V3_GENESIS;
    await expect(w.assertReadyToSign()).resolves.toMatchObject({ status: "ready" });
  });

  it("accepts an rpc client object with send()", async () => {
    const client = { send: vi.fn(async () => OTHER_GENESIS) };
    const { w } = await start(new FakeExtension([{ address: ALICE_42 }]), { rpc: client });
    expect(w.current().status).toBe("wrong_network");
  });

  it("rpc error or garbage genesis -> unknown (fail closed)", async () => {
    let mode: "err" | "junk" | "ok" = "err";
    const rpc = rpcOf(async () => {
      if (mode === "err") throw new Error("ECONNRESET");
      return mode === "junk" ? "0x1234" : V3_GENESIS;
    });
    const { w } = await start(new FakeExtension([{ address: ALICE_42 }]), { rpc });
    expect(w.current().status).toBe("unknown");
    expect(w.current().reason).toMatch(/ECONNRESET/);
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "unknown" });
    mode = "junk";
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "unknown" });
    mode = "ok";
    await expect(w.assertReadyToSign()).resolves.toMatchObject({ status: "ready" });
  });

  it("stop() unsubscribes, ignores later events and makes assert fail", async () => {
    const ext = new FakeExtension([{ address: ALICE_42 }]);
    const { w, states } = await start(ext);
    w.stop();
    w.stop();
    expect(ext.unsubCalls).toBe(1);
    expect(ext.subs.size).toBe(0);
    expect(w.current().status).toBe("unknown");
    const n = states.length;
    ext.emit([{ address: BOB_42 }]);
    expect(states.length).toBe(n);
    await expect(w.assertReadyToSign()).rejects.toMatchObject({ code: "unknown" });
  });

  it("unsubscribes even when the extension resolves its unsub after stop()", async () => {
    let unsubbed = 0;
    const ext: InjectedExtensionLike = {
      accounts: {
        get: async () => [{ address: ALICE_42 }],
        subscribe: async () => () => void unsubbed++,
      },
    };
    const w = watchSigner({
      extension: ext,
      expectedAddress: ALICE_42,
      expectedGenesisHash: V3_GENESIS,
    });
    w.stop();
    await tick();
    expect(unsubbed).toBe(1);
  });

  it("rejects bad inputs up front", () => {
    const ext = new FakeExtension([]);
    expect(() =>
      watchSigner({ extension: ext, expectedAddress: "nope", expectedGenesisHash: V3_GENESIS }),
    ).toThrow();
    expect(() =>
      watchSigner({ extension: ext, expectedAddress: ALICE_42, expectedGenesisHash: "0x12" }),
    ).toThrow();
  });

  it("a throwing onChange listener does not break the watch", async () => {
    const ext = new FakeExtension([{ address: ALICE_42 }]);
    const w = watchSigner({
      extension: ext,
      expectedAddress: ALICE_42,
      expectedGenesisHash: V3_GENESIS,
      onChange: () => {
        throw new Error("boom");
      },
    });
    await tick();
    expect(w.current().status).toBe("ready");
  });
});
