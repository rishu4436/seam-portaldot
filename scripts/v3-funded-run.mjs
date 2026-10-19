#!/usr/bin/env node
// Entry point for the funded Portaldot V3 testnet run. The implementation lives in
// packages/chain/scripts/v3-funded-run.mjs (it needs that package's build). --help: see the header there.
await import("../packages/chain/scripts/v3-funded-run.mjs");
