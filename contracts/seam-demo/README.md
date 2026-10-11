# seam_demo: SEAM's demo ink! contract

`settle(order_id: u64, amount: Balance)` stores the caller's last settlement and emits
`Settled { caller, order_id, amount }` (topics: caller, order_id) on **every** call. A SEAM receipt sees
`Contracts.ContractEmitted` from this contract, so the `contracts.call` step can be marked **verified** instead of unknown.

| message | selector | args | returns | payable |
|---|---|---|---|---|
| `settle` | `0x6c337222` | `order_id: u64`, `amount: u128` | – | no |
| `last_settlement` | `0x0d9613e2` | – | `Option<Settlement { caller, order_id, amount, block }>` | no |
| `settlement_count` | `0x9f37bde5` | – | `u64` | no |
| constructor `new` | `0x9bae9d5e` | – | – | no |

Selectors are ink!'s defaults (first 4 bytes of blake2b-256 of the label), so they are the same in any ink! version.

## Built artifacts (`artifacts/`)

| file | what |
|---|---|
| `seam_demo.contract` | metadata + wasm bundle: deploy this (e.g. `instantiate_with_code`, polkadot.js `CodePromise`, Contracts UI) |
| `seam_demo.wasm` | the code, 21759 bytes, code hash `0x1fa93c546eaf0e392aca9ffcb6e5acadf674f5e39d70b058fd7228a98f606128` |
| `metadata.json` | the ABI (ink! metadata V5) for SEAM's `message`/`abi` form of `contracts.call` |

- **ink! 5.1.1**, built with `rustc 1.99.0 (b940084d7 2026-09-28)` by `build.sh` (rebuilds are byte-identical).
- **Not built with cargo-contract.** cargo-contract 5.x needs a C++ compiler (it links binaryen for wasm-opt) and the
  shared box has none. `build.sh` does cargo-contract's steps by hand: wasm32 cdylib with core/alloc rebuilt for
  `target-cpu=mvp`, imported memory (max 16 pages), 64 KiB stack, only `call`/`deploy` exported, custom sections
  stripped, metadata from `#[ink::contract]`'s own `__ink_generate_metadata` (`metadata-gen/`) wrapped the way
  cargo-contract wraps it. No wasm-opt pass (size only). With a C++ toolchain, `cargo contract build --release`
  (cargo-contract 5.x) should give an equivalent, smaller contract with the same ABI and selectors.
- **Checked against the local dev node** (substrate-contracts-node v0.42.0, ws://127.0.0.1:9944): a read-only
  `ContractsApi_instantiate` dry run with `Code::Upload` of this wasm returns `Ok` (flags 0), gas required
  ref_time 180,136,134 / proof_size 26,643, storage deposit 510,765,000,000. Nothing was submitted.
- Off-chain unit test: `cargo test` (settle stores and emits, twice).

## Portaldot mainnet (spec 1002): this build will NOT run there

Portaldot spec 1002 runs an old `pallet-contracts` (rent era: `claim_surcharge`, Weight v1 `gas_limit: Compact<u64>`).
This ink! 5 wasm imports `seal1.get_storage` and `seal2.set_storage`, which that pallet doesn't have, so instantiation
would fail. For mainnet the contract needs an ink! release from the rent era, **ink! 3.0.0-rc4 / rc5** (2021; rent APIs
were removed in rc7, which also needs a pallet newer than Nov 2021), built with the matching cargo-contract (0.13–0.15)
and a 2021 nightly. The same source works with ink! 3's syntax changes (`ink_lang as ink`, `#[ink(storage)]` with
`ink_storage` traits, `Self::env().emit_event`), and the selectors stay the same. That build was **not** attempted:
it needs a 2021 toolchain and old crates; we target the dev node for the demo.

## Use it from a SEAM Manifest

```jsonc
{ "id": "settle", "kind": "contracts.call",
  "args": { "contract": "<deployed address>", "value": "0", "gasLimit": "<ref_time>",
            "message": "settle", "args": { "order_id": 7, "amount": "2500000000000000" },
            "abiRef": "seam_demo" } }   // compile(manifest, facts, { abis: { seam_demo: <artifacts/metadata.json> } })
```

## Rebuild

```bash
rustup toolchain install stable -c rust-src -t wasm32-unknown-unknown   # rustc >= 1.88
cargo install wasm-tools --locked
./build.sh            # writes artifacts/
```
