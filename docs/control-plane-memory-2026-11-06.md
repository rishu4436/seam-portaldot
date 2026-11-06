# Control-plane memory incident, 6 November 2026

The Railway control-plane process stopped with `Reached heap limit` after roughly eight hours. Its last GC messages showed about 475 MiB of retained heap. The native frontend calls V3 directly and does not depend on this optional team backend.

## Cause and change

V3 raw metadata changes as the allow-listed `Revive.EthBlockBuilderIR` storage default changes. Compiler runtime loading cached a complete polkadot.js registry for every metadata/types hash forever. Chain encoding and decorated decoding had the same unbounded ownership pattern. Each registry retains substantial metadata/type objects, so regular monitoring accumulated historical registries.

All three caches now retain at most two recently used exact-hash entries. Cache hits refresh recency; eviction drops cache ownership before constructing another registry. Active callers retain their own references. Historical metadata can be rebuilt when needed. Raw fingerprints, layout normalization rules, authorization gates and approval invalidation are unchanged; metadata is not conflated by runtime version or layout hash.

The backend logs numeric process memory counters on startup and every five minutes. No credential values are included. The heap limit was not raised to conceal growth, and persistent-volume configuration and database schema are unchanged.

## Local reproduction and regression

The same real V3 fixture was changed only at the allow-listed storage default. Forced GC between iterations measured retained heap rather than temporary allocations. Measurements are MiB and specific to this local Node/platform; production values can differ.

| Probe | First iteration | Eighth iteration |
| --- | --- | --- |
| Original monitor-style facts/layout reads | 44.68 | 141.75 |
| Fixed, identical monitor-style reads | 44.69 | 58.82 |

A heavier 64-iteration run exercised compiler facts, chain encoder and decorated decoder together inside a 256 MiB heap. Retained heap was 108.83 MiB at iteration 8 and 109.19 MiB at iteration 64 (maximum 109.20 MiB). RSS was 349.61 MiB at iteration 8 and 346.09 MiB at iteration 64. This is bounded local regression evidence, not an hours-long production soak.

The committed backend regression runs 40 changing metadata fixtures through the real `createLiveServices().runtime()` path in a separate 256 MiB process. It asserts bounded retained heap and continued detection of raw metadata drift while the allowed layout remains unchanged. Separate compiler/chain tests pressure both cold and hot entries, check eviction, and confirm identical metadata and call bytes after rebuilding an evicted runtime. All 14 backend tests passed, including encrypted backup/restore, authentication, tenant isolation and read-only RPC restrictions.

## Deployment boundary

Deploy only the backend branch/image to the existing Railway service and existing `/data` volume. Keep the demo frontend pinned to `79fe8c6b`. Validate `/healthz`, workspace data, scheduled/manual runtime checks, backup health and live memory after deployment. A short live observation does not establish long-term availability; the new memory logs support subsequent diagnosis.
