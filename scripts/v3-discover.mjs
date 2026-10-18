#!/usr/bin/env node
// Entry point: the implementation lives in packages/chain/scripts/v3-discover.mjs (it needs that package's build).
// Same arguments: scripts/v3-discover.mjs WS_RPC_URL [--out evidence/v3-discovery]; --help lists them.
await import('../packages/chain/scripts/v3-discover.mjs');
