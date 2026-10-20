/**
 * Browser-safe entry (`@seam/sdk/browser`): the receipt outcome verifiers with no node builtins and no file or network
 * access. `verifyStep` is the one dispatcher over every step kind (assets.transfer, assets.mint, contracts.call by
 * expected event; nfts.mint, revive.call, revive.instantiate_with_code, revive.map_account by their V3 spec-3002 verdicts).
 * These are the same functions the node entry (`@seam/sdk`) exports, re-exported from the same modules, so there is
 * one copy of the logic; tests/browser-entry.test.ts holds the two entries to identity and the bundle to no node code.
 */
export * from "./receipt.js";
export * from "./outcomes.js";
export * from "./deploy-outcomes.js";
