import {
  encodeDeployData,
  parseAbiParameters,
  encodeAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { invariant, type Registry } from "./model.js";
import { V3_PROGRAM } from "./reviewed-v3.js";
export const V3_EVM_GENESIS =
  "0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001" as Hex;
export const V3_RPC = "https://test-evm-rpc-v3.portaldot.dev/";
export const REVIEW_ID = V3_PROGRAM.reviewId;
export type Review = {
  id: Hex;
  factory: { address: Address; codeHash: Hex };
  deployer: Address;
  deploymentTransaction: Hex;
};
export function hasReviewedProgram(registry: Registry) {
  return registry.review?.id === REVIEW_ID;
}
export function factoryCreationData(deploymentId: Hex): Hex {
  return encodeDeployData({
    abi: [
      {
        type: "constructor",
        inputs: [{ name: "deploymentId", type: "bytes32" }],
        stateMutability: "nonpayable",
      },
    ],
    bytecode: V3_PROGRAM.factoryCreationCode,
    args: [deploymentId],
  });
}
type ContractName = keyof typeof V3_PROGRAM.contracts;
export function assertReviewedCode(
  name: ContractName,
  code: Hex,
  bindings: Record<string, string | number>,
) {
  const template = V3_PROGRAM.contracts[name];
  invariant(code.length === template.runtime.length, `Unreviewed ${name} runtime length`);
  let expected = template.runtime as string;
  const ranges = template.immutableReferences as Record<
    string,
    readonly { start: number; length: number }[]
  >;
  invariant(
    Object.keys(ranges).every((key) => bindings[key] !== undefined),
    `Missing reviewed immutable binding for ${name}`,
  );
  for (const [key, positions] of Object.entries(ranges)) {
    const value = bindings[key];
    const encoded =
      typeof value === "number"
        ? toHex(value, { size: 32 })
        : value.length === 66
          ? value
          : encodeAbiParameters(parseAbiParameters("address"), [value as Address]);
    invariant(encoded.length === 66, `Invalid reviewed immutable ${key}`);
    for (const range of positions) {
      invariant(
        range.length === 32 && range.start >= 0 && range.start * 2 + 66 <= code.length,
        "Invalid immutable range in bundled review",
      );
      const offset = 2 + range.start * 2;
      expected = expected.slice(0, offset) + encoded.slice(2) + expected.slice(offset + 64);
    }
  }
  invariant(
    code.toLowerCase() === expected.toLowerCase(),
    `Unreviewed ${name} bytecode or immutable values`,
  );
}
export function reviewedBindings(
  registry: Registry,
): { name: ContractName; address: Address; bindings: Record<string, string | number> }[] {
  invariant(registry.review, "A reviewed market deployment is required");
  const r = registry,
    review = registry.review,
    factory = review.factory.address;
  return [
    {
      name: "SeamTestMarket" as const,
      address: factory,
      bindings: {
        bootstrapper: review.deployer,
        usd: r.tokens[0].address,
        eth: r.tokens[1].address,
        pool: r.pool.address,
        vault: r.vault.address,
        guard: r.guard.address,
      },
    },
    {
      name: "SeamTestToken" as const,
      address: r.tokens[0].address,
      bindings: { issuer: factory, precision: 6 },
    },
    {
      name: "SeamTestToken" as const,
      address: r.tokens[1].address,
      bindings: { issuer: factory, precision: 18 },
    },
    {
      name: "SeamReferencePool" as const,
      address: r.pool.address,
      bindings: { token0: r.tokens[0].address, token1: r.tokens[1].address },
    },
    {
      name: "SeamReferenceVault" as const,
      address: r.vault.address,
      bindings: { _asset: r.tokens[0].address, _underlyingDecimals: 6 },
    },
    {
      name: "SeamGuardRouter" as const,
      address: r.guard.address,
      bindings: { deploymentId: r.deploymentId },
    },
  ];
}
