// No real wallet or transaction. These regressions check which extension receives a signing request.
import { expect, it, vi } from "vitest";
import { encodeAddress, decodeAddress } from "@polkadot/util-crypto";
import { createExtensionSigner } from "../extensionsigner";
import { openSignerWatch } from "../walletwatch";
const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const provider = (address: string) => {
  const signPayload = vi.fn(async () => ({ signature: "0xaa" }));
  const enabled = {
    accounts: {
      get: async () => [{ address }],
      subscribe: (callback: (accounts: { address: string }[]) => void) => {
        callback([{ address }]);
        return () => {};
      },
    },
    signer: { signPayload },
  };
  return { enabled, signPayload, injected: { enable: vi.fn(async () => enabled) } };
};
it("finds the approved account in a second installed wallet", async () => {
  const first = provider(bob),
    selected = provider(alice);
  const signer = createExtensionSigner({
    getInjected: () => ({ first: first.injected, selected: selected.injected }),
    assemble: () => "0x01",
  });
  expect((await signer.sign({ address: alice, payload: { address: alice } })).ok).toBe(true);
  expect(first.signPayload).not.toHaveBeenCalled();
  expect(selected.signPayload).toHaveBeenCalledTimes(1);
});
it("respects the chosen extension even when another wallet exposes the same account", async () => {
  const first = provider(alice),
    selected = provider(alice);
  const signer = createExtensionSigner({
    extension: "selected",
    getInjected: () => ({ first: first.injected, selected: selected.injected }),
    assemble: () => "0x01",
  });
  await signer.sign({ address: alice, payload: { address: alice } });
  expect(first.injected.enable).not.toHaveBeenCalled();
  expect(first.signPayload).not.toHaveBeenCalled();
  expect(selected.signPayload).toHaveBeenCalledTimes(1);
});
it("matches the same public key across SS58 prefixes", async () => {
  const wallet = provider(encodeAddress(decodeAddress(alice), 0));
  const signer = createExtensionSigner({
    getInjected: () => ({ wallet: wallet.injected }),
    assemble: () => "0x01",
  });
  expect((await signer.sign({ address: alice, payload: { address: alice } })).ok).toBe(true);
});
it("does not silently switch providers when the explicitly chosen wallet loses the account", async () => {
  const first = provider(alice),
    chosen = provider(bob);
  const signer = createExtensionSigner({
    extension: "chosen",
    getInjected: () => ({ first: first.injected, chosen: chosen.injected }),
    assemble: () => "0x01",
  });
  expect((await signer.sign({ address: alice, payload: { address: alice } })).ok).toBe(false);
  expect(first.signPayload).not.toHaveBeenCalled();
  expect(chosen.signPayload).not.toHaveBeenCalled();
});
it("the wallet watch uses the selected provider too", async () => {
  const first = provider(bob),
    selected = provider(alice);
  const watch = await openSignerWatch({
    expectedAddress: alice,
    expectedGenesisHash: `0x${"aa".repeat(32)}`,
    extension: "selected",
    getInjected: () => ({ first: first.injected, selected: selected.injected }),
    rpc: async () => `0x${"aa".repeat(32)}`,
  });
  expect((await watch.assertReadyToSign()).status).toBe("ready");
  expect(first.injected.enable).not.toHaveBeenCalled();
  watch.stop();
});
