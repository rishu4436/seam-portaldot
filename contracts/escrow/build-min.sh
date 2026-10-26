#!/usr/bin/env bash
# Deterministic EVM builds of EscrowMin.sol (SeamEscrowMin, SeamEscrowOne) with the same pinned solc 0.8.30 as build.sh,
# at optimizer runs=1 and runs=200, metadata hash off. Writes artifacts/min/<Contract>-r<runs>.{init,runtime} and
# artifacts/min/build-info.json (sizes + keccak256). EVM only: V3 has allowEVMBytecode=true and PVM is ~6x larger.
# Usage: SOLC=/path/solc-0.8.30 ./build-min.sh
set -euo pipefail
cd "$(dirname "$0")"
SOLC="${SOLC:-/home/box/tools/revive/solc-0.8.30}"
EXPECT_SOLC="f3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7"
[ "$(sha256sum "$SOLC" | cut -d' ' -f1)" = "$EXPECT_SOLC" ] || { echo "solc is not the pinned 0.8.30 binary" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
src="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync("EscrowMin.sol","utf8")))')"
for runs in 1 200; do
  echo '{"language":"Solidity","sources":{"EscrowMin.sol":{"content":'"$src"'}},
   "settings":{"optimizer":{"enabled":true,"runs":'"$runs"'},"metadata":{"bytecodeHash":"none","appendCBOR":false},
    "outputSelection":{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object","evm.deployedBytecode.immutableReferences"]}}}}' \
    | "$SOLC" --standard-json > "$tmp/r$runs.json"
done
mkdir -p artifacts/min
SV="$("$SOLC" --version | tail -1)" node scripts-extract-min.mjs "$tmp" artifacts/min
