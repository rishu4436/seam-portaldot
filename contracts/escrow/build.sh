#!/usr/bin/env bash
# Deterministic build of SeamEscrow for pallet-revive. Pinned: resolc 1.4.0 (sha256 74e051ce…686d) + solc 0.8.30
# (sha256 f3e987dc…28f7). Writes artifacts/: SeamEscrow.pvm (PolkaVM blob), SeamEscrow.evm (solc EVM init code, for
# comparison), SeamEscrow.abi.json and build-info.json (versions, sizes, keccak256 code hashes).
# Usage: RESOLC=/path/resolc SOLC=/path/solc-0.8.30 ./build.sh   (defaults: /home/box/tools/revive/*)
set -euo pipefail
cd "$(dirname "$0")"
RESOLC="${RESOLC:-/home/box/tools/revive/resolc-x86_64-unknown-linux-musl}"
SOLC="${SOLC:-/home/box/tools/revive/solc-0.8.30}"
EXPECT_RESOLC="74e051ce27300c77e82e323f5c47acf2c452819b6a8d0eb21bf5b9111e7a686d"
EXPECT_SOLC="f3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7"
[ "$(sha256sum "$RESOLC" | cut -d' ' -f1)" = "$EXPECT_RESOLC" ] || { echo "resolc is not the pinned 1.4.0 binary" >&2; exit 1; }
[ "$(sha256sum "$SOLC" | cut -d' ' -f1)" = "$EXPECT_SOLC" ] || { echo "solc is not the pinned 0.8.30 binary" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# metadata hash off: the blob then does not embed a hash of the source metadata (paths, settings).
input='{"language":"Solidity","sources":{"Escrow.sol":{"content":'"$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync("Escrow.sol","utf8")))')"'}},
 "settings":{"optimizer":{"enabled":true,"mode":"z"},"metadata":{"bytecodeHash":"none"},
  "outputSelection":{"*":{"*":["abi","evm.bytecode"]}}}}'
echo "$input" | "$RESOLC" --solc "$SOLC" --standard-json > "$tmp/pvm.json"
solcin='{"language":"Solidity","sources":{"Escrow.sol":{"content":'"$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync("Escrow.sol","utf8")))')"'}},
 "settings":{"optimizer":{"enabled":true,"runs":200},"metadata":{"bytecodeHash":"none"},
  "outputSelection":{"*":{"*":["evm.bytecode.object"]}}}}'
echo "$solcin" | "$SOLC" --standard-json > "$tmp/evm.json"
mkdir -p artifacts
RV="$("$RESOLC" --version)" SV="$("$SOLC" --version | tail -1)" node scripts-extract.mjs "$tmp/pvm.json" "$tmp/evm.json" artifacts
