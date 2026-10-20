import { describe, expect, it } from "vitest";
import { planCall } from "../liverequest";
import {
  approveWalletDemo,
  checkWalletDemoPolicy,
  walletDemo,
  walletDemoPlan,
  WALLET_DEMO_ASSET,
} from "../walletdemo";
import transfer from "../../../../../evidence/testnet-v3/runs/assets-transfer-1792410479921.json";

const plan = walletDemoPlan();

describe("V3 wallet demo", () => {
  it("is one assets.transfer of 1 unit of the V3 test asset, encoded like the recorded V3 transfer", () => {
    expect(walletDemo.label).toBe("V3 wallet demo");
    expect(plan.steps).toHaveLength(1);
    const s = plan.steps[0];
    expect(s.capability).toBe("Assets.transfer_keep_alive");
    expect(s.decoded).toMatchObject({ assetId: WALLET_DEMO_ASSET, amount: "1" });
    // Same pallet/call/asset/recipient prefix as the recorded V3 call; only the compact amount (1000 -> 1) differs.
    const prefix = (transfer as { callHex: string }).callHex.slice(0, -6);
    expect(s.encodedCall!.startsWith(prefix)).toBe(true);
    expect(walletDemo.fingerprint.specVersion).toBe(3002);
  });
  it("is signable as a single call", () => {
    const c = planCall(plan);
    expect(c.ok && c.value.callHex).toBe(plan.steps[0].encodedCall);
  });
  it("passes the strict policy and blocks anything wider", () => {
    expect(checkWalletDemoPolicy(plan).allowed).toBe(true);
    const tweak = (d: Partial<(typeof plan.steps)[0]["decoded"]>) =>
      checkWalletDemoPolicy({
        ...plan,
        steps: [{ ...plan.steps[0], decoded: { ...plan.steps[0].decoded, ...d } }],
      });
    expect(tweak({ amount: "11" }).allowed).toBe(false);
    expect(tweak({ amount: "0" }).allowed).toBe(false);
    expect(tweak({ assetId: "1" }).allowed).toBe(false);
    expect(tweak({ recipient: "5Other" }).allowed).toBe(false);
    expect(checkWalletDemoPolicy({ ...plan, steps: [plan.steps[0], plan.steps[0]] }).allowed).toBe(
      false,
    );
  });
  it("approval binds the plan digest for the policy window", () => {
    const a = approveWalletDemo(plan, 0);
    expect(a).toMatchObject({ hash: plan.digest, covers: ["pay"], used: false });
    expect(a.expiresAt).toBe(new Date(300_000).toISOString());
  });
});
