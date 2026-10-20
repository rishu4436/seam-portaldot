# V3 metadata stability (read-only)

`stability-1792412979539.json` comes from `node packages/chain/scripts/v3-metadata-stability.mjs https://test-node-v3.portaldot.dev --blocks 4 --ws wss://test-node-v3.portaldot.dev`, run on 2026-10-19 between 17:59 and 18:00 IST. It is read-only: it uses `chain_getHeader`, `chain_getBlockHash`, `state_getMetadata`, `state_getRuntimeVersion` and `system_properties` over HTTPS, plus 5 `chain_getHeader` reads over WSS. Nothing was signed or sent, and no wallet was used.

## Findings

| block | spec | raw metadata hash | layout hash (storage defaults blanked) |
|---|---|---|---|
| #102937 | 3002 | `0xa6414b20…89e1` | `0x8baafefc…c1a6` |
| #102941 (4 blocks later) | 3002 | `0x7abbd16e…e998` | `0x8baafefc…c1a6` |
| #102837 | 3002 | `0xead4d72c…8f4f` | `0x8baafefc…c1a6` |
| #102437 | 3002 | `0xd7880997…782f` | `0x8baafefc…c1a6` |
| 2026-10-18 discovery blob | 3002 | `0x1840e6c6…1ba9` | `0x8baafefc…c1a6` |

- **Raw hash vs layout hash.** The raw hash changed between blocks only 4 apart, with no runtime upgrade. The layout hash is the same across every read.
- **What differs.** Comparing each pair, the only difference is the default value of `Revive.EthBlockBuilderIR` (388 bytes).
- **Proof that this is the only difference.** `packages/chain/tests/metadata-layout.test.ts` takes the 2026-10-18 blob and swaps in the live `Revive.EthBlockBuilderIR` default from #102937 and #102941. The result reproduces those blocks' raw hashes byte for byte. The fixture holds only those default bytes and the hashes: `packages/chain/tests/fixtures/v3-spec3002-ethblockbuilderir-fallbacks.json`.
- **Effect on the runtime lock.** At #102942, the fingerprint without a pin was `0xbf6e9b85…7a99`. Pinned to each earlier blob (a plan prepared then), `fingerprintFromChainInputs(…, { pinnedMetadataHex })` returns that blob's own digest, so the runtime lock would pass. A drift record names the live and pinned raw hashes.
- **WSS smoke.** 5 of 5 reads succeeded in this run, so no drop was seen this time. The drops reported in the funded run (code 1006) are intermittent.

## Not verified

- A layout change on V3 itself, because none happened. Fail-closed behaviour for call, argument, type, storage and event changes is shown on real blobs edited offline (unit tests), not on a V3 runtime upgrade.

## Update 2026-10-20: layout hash narrowed to an allow-list (layout v2)

The earlier runs above used layout hash **v1**, which blanked **every** storage entry's default value in every pallet. That was broader than needed: only `Revive.EthBlockBuilderIR` was ever seen to drift.

`@seam/chain` now uses **v2** (`seam/metadata-layout/v2`). It blanks only the defaults listed in the exported `BLANKED_STORAGE_DEFAULTS`, which today holds just `Revive.EthBlockBuilderIR`. Any other storage default change, for example a one-byte change in `System.Number`'s default, now changes the layout hash, so the runtime lock fails closed.

- The v1 value `0x8baafefc…2c1a6` in the files above is historical.
- The spec 3002 v2 value is `0x221ba8f7dd81e0341fca9f0074a3e433659c97300cbbb2f874dbd5f0d998b304`.
- Run `stability-1792500177396.json` (2026-10-20, read-only, 3 blocks) shows the same v2 layout hash at every block. `Revive.EthBlockBuilderIR` was the only default that differed.
- `@seam/compiler`'s own copy (`packages/compiler/src/layout.ts`) still implements v1 until it is mirrored.
