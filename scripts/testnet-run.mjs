#!/usr/bin/env node
// Entry point named in docs/testnet-checklist.md. The implementation lives in packages/chain/scripts/testnet-run.mjs
// (it needs that package's build). Same arguments: scripts/testnet-run.mjs RPC_URL [--yes] [options]; --help lists them.
await import('../packages/chain/scripts/testnet-run.mjs');
