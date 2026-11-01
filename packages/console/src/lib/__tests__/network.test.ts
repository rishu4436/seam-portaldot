import { describe, expect, it } from "vitest";
import {
  HOSTED_V3_GENESIS,
  HOSTED_V3_SPEC,
  PORTALDOT_MAINNET_GENESIS,
  hostedTestnetProblem,
} from "../network";

describe("hosted testnet gate", () => {
  it("allows only the hosted V3 testnet", () => {
    expect(
      hostedTestnetProblem({ genesisHash: HOSTED_V3_GENESIS, specName: HOSTED_V3_SPEC }),
    ).toBeUndefined();
    expect(
      hostedTestnetProblem({
        genesisHash: HOSTED_V3_GENESIS.toUpperCase(),
        specName: HOSTED_V3_SPEC,
      }),
    ).toBeUndefined();
  });
  it("refuses mainnet, another chain, and a missing identity", () => {
    expect(
      hostedTestnetProblem({ genesisHash: PORTALDOT_MAINNET_GENESIS, specName: "portaldot" }),
    ).toMatch(/mainnet/);
    expect(hostedTestnetProblem({ genesisHash: "0x" + "ab".repeat(32), specName: "mock" })).toMatch(
      /hosted V3 testnet/,
    );
    expect(hostedTestnetProblem({ genesisHash: HOSTED_V3_GENESIS })).toMatch(/could not be read/);
    expect(hostedTestnetProblem(undefined)).toMatch(/could not be read/);
  });
});
