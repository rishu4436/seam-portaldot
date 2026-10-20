/**
 * Fast, offline checks for the dev-node demo flow (scripts/devnode/flow.mjs). The dev-node suite itself
 * (devnode.test.ts) only runs weekly against a live local node, so these pin the two things it broke on:
 * - SEAM-004: a contracts.call is verified only against a committed expected effect, so the flow must pass one
 *   (settleEffect). Without it the contract step stays unproven and a sequential run stops before the mint.
 * - SEAM-012: an atomic_verified plan needs a rollback proof whose composition covers every kind in the plan, so
 *   the rollback batch (rollbackActions) must contain every kind of the atomic demo manifest.
 */
import { describe, expect, it } from "vitest";
import { evaluateRollbackProof } from "@seam/compiler";
// @ts-expect-error plain .mjs script, no types
import { devManifest, rollbackActions, settleEffect } from "../scripts/devnode/flow.mjs";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const CHARLIE = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const CONTRACT = "0x211531d1c46e9085f4473c486a19a5eb0f04f46a9d90d2a50421b57beb378389";
const H = (c: string) => `0x${c.repeat(64)}`;

describe("dev-node demo flow", () => {
  it("settleEffect commits the exact Settled event data the seam_demo contract emits", () => {
    // data of Contracts.ContractEmitted recorded on the local dev node (sequential run, order 7, amount 2500)
    expect(settleEffect(ALICE)).toEqual({
      emittedData:
        "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0700000000000000c4090000000000000000000000000000",
    });
  });

  it("the rollback batch covers every kind of the atomic demo plan, so its proof is accepted", () => {
    const atomicKinds = devManifest({
      alice: ALICE,
      bob: BOB,
      charlie: CHARLIE,
      contract: CONTRACT,
      genesis: H("e"),
      atomic: true,
    }).actions.map((a: { kind: string }) => a.kind);
    const rollback = rollbackActions({ bob: BOB, charlie: CHARLIE, contract: CONTRACT });
    // the failing step is last, so every kind before it actually ran inside the batch before the rollback
    expect(rollback.at(-1).kind).toBe("assets.mint");
    const facts = (composition: string[]) =>
      ({
        fingerprint: { genesisHash: H("e"), metadataHash: H("d"), specVersion: 100 },
        fingerprintDigest: H("f"),
        behaviour: {
          batchAllRollback: "verified",
          batchAllRollbackProof: {
            genesisHash: H("e"),
            metadataHash: H("d"),
            specVersion: 100,
            fingerprintDigest: H("f"),
            txHash: H("1"),
            preState: { alice: "1" },
            postState: { alice: "1" },
            composition,
          },
        },
      }) as unknown as Parameters<typeof evaluateRollbackProof>[0];
    const composition = [...new Set(rollback.map((a: { kind: string }) => a.kind))] as string[];
    expect(evaluateRollbackProof(facts(composition), atomicKinds)).toEqual({ ok: true });
    // what the old rollback batch (transfer, failing transfer, mint) proved: not enough for the contract step
    expect(evaluateRollbackProof(facts(["assets.transfer", "assets.mint"]), atomicKinds)).toEqual({
      ok: false,
      reason:
        "the rollback proof is rejected: composition covers assets.transfer, assets.mint but this plan also uses contracts.call",
    });
  });
});
