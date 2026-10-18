# V3 readiness check (read-only; nothing signed or spent)

Run 2026-10-18 13:19-13:20 UTC (18:49-18:50 IST, Asia/Calcutta).

## Commands
- `npm run build`; `node scripts/v3-discover.mjs wss://test-node-v3.portaldot.dev --out evidence/v3-discovery` (13:19:37Z)
- `curl` JSON-RPC to https://test-evm-rpc-v3.portaldot.dev: eth_chainId, eth_blockNumber (x2, ~7s apart)
- Ad-hoc @polkadot/api script (outside repo, deleted): chain_getFinalizedHead + header, twice ~12s apart

## EVM
| Time (UTC) | Method | Result |
|---|---|---|
| 13:19:57 | eth_chainId | 0x190f1ca9 = 420420777 (matches expected) |
| 13:19:57 | eth_blockNumber | 0x15c0a = 89098 |
| 13:20:04 | eth_blockNumber | 0x15c0b = 89099 (advanced) |

## Substrate finalized head
| Time (UTC) | Finalized # | Hash | Best # |
|---|---|---|---|
| 13:20:08 | 89098 | 0xe6bd7646...cdd8b42e | 89100 |
| 13:20:21 | 89100 | 0xdab2ad69...8d6f16 | 89102 |

Finalized head advanced by 2 in ~13s. (Two transient WS 1006 disconnects while the script ran; it reconnected.)

## Discovery (35 observed, 1 absent, 0 flagged)
Pallets observed: Revive, Contracts, Nfts, Assets, Utility.
Calls observed: Revive.call, Revive.instantiate, Revive.instantiate_with_code, Revive.upload_code, Revive.map_account, Nfts.mint, Assets.transfer_keep_alive, Assets.mint, Utility.batch_all.
Runtime API observed: ReviveApi. Absent: RPC method contracts_call.
Unknown signed extensions AuthorizeCall, EthSetOrigin are treated as no-effect by the registry.
Full report: v3-capabilities.md/json, metadata snapshot files in this directory.

## NOT VERIFIED
- Argument layouts of Revive.call, Nfts.mint, map_account, Utility.batch_all against the compiler shape (existence only).
- Any execution: no extrinsic signed, submitted or dry-run; fees, simulation results, map_account behavior and address derivation.
- Funded account behavior (test wallet had 0 balance at last check).
- Behavior of AuthorizeCall / EthSetOrigin extensions.
- This is one node's report, not V3-verified.
