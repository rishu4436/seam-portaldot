#!/usr/bin/env bash
# Builds the seam_demo ink! 5 contract into artifacts/: seam_demo.wasm, metadata.json, seam_demo.contract.
#
# Why not `cargo contract build`? cargo-contract 5.x links binaryen (C++) and the shared SEAM box has no C++ compiler.
# This script does the same steps by hand:
#   1. rustc -> wasm32 cdylib with core/alloc rebuilt for target-cpu=mvp (no reference-types/multivalue, which
#      pallet-contracts rejects), imported memory capped at 16 pages, 64 KiB stack (cargo-contract's defaults);
#   2. keep only the `call`/`deploy` exports and strip custom sections (cargo-contract's post-processing);
#   3. no wasm-opt pass (only a size optimisation; the code is ~20 KiB without it);
#   4. metadata from #[ink::contract]'s own __ink_generate_metadata (metadata-gen/), wrapped like cargo-contract does
#      with source.hash = blake2b-256(wasm), language, compiler and contract info.
# Needs: rustup toolchain with rust-src and wasm32-unknown-unknown (stable >= 1.88), wasm-tools, python3.
set -euo pipefail
cd "$(dirname "$0")"
TOOLCHAIN="${TOOLCHAIN:-stable}"
OUT="${OUT:-artifacts}"
mkdir -p "$OUT"

RUSTC_BOOTSTRAP=1 \
RUSTFLAGS="-C target-cpu=mvp -C link-arg=-zstack-size=65536 -C link-arg=--import-memory -C link-arg=--max-memory=1048576" \
cargo "+$TOOLCHAIN" rustc --release --lib --crate-type cdylib --target wasm32-unknown-unknown \
  --no-default-features -Zbuild-std=core,alloc --target-dir target/wasm

RAW=target/wasm/wasm32-unknown-unknown/release/seam_demo.wasm
wasm-tools print "$RAW" | grep -vE '^\s*\(export "(memcpy|memcmp|memmove|memset)"' > "$OUT/seam_demo.wat"
wasm-tools parse "$OUT/seam_demo.wat" -o "$OUT/seam_demo.full.wasm"
wasm-tools strip --all "$OUT/seam_demo.full.wasm" -o "$OUT/seam_demo.wasm"
rm -f "$OUT/seam_demo.full.wasm" "$OUT/seam_demo.wat"
wasm-tools validate --features=mvp,mutable-global "$OUT/seam_demo.wasm"

(cd metadata-gen && cargo "+$TOOLCHAIN" run -q --release) > "$OUT/ink_project.json"

python3 - "$OUT" "$(rustc "+$TOOLCHAIN" --version)" <<'PY'
import hashlib, json, sys
out, rustc = sys.argv[1], sys.argv[2]
wasm = open(f"{out}/seam_demo.wasm", "rb").read()
code_hash = "0x" + hashlib.blake2b(wasm, digest_size=32).hexdigest()
project = json.load(open(f"{out}/ink_project.json"))
meta = {
    "source": {"hash": code_hash, "language": "ink! 5.1.1", "compiler": rustc,
               "build_info": {"build_mode": "Release", "built_by": "contracts/seam-demo/build.sh (no wasm-opt)",
                              "target": "wasm32-unknown-unknown, target-cpu=mvp"}},
    "contract": {"name": "seam_demo", "version": "0.1.0", "authors": ["SEAM team"],
                 "description": "SEAM demo: settle(order_id, amount) emits Settled on every call", "license": "MIT"},
    "image": None,
    **project,
}
json.dump(meta, open(f"{out}/metadata.json", "w"), indent=2); open(f"{out}/metadata.json", "a").write("\n")
bundle = dict(meta); bundle["source"] = dict(meta["source"], wasm="0x" + wasm.hex())
json.dump(bundle, open(f"{out}/seam_demo.contract", "w"), indent=2)
print(f"code hash {code_hash}, {len(wasm)} bytes")
PY
rm -f "$OUT/ink_project.json"
