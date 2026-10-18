#!/usr/bin/env bash
# Automatic end-to-end test: starts a throwaway LOCAL substrate-contracts-node via packages/chain/scripts/devnode.sh
# (own port, own data dir, fresh genesis), runs the existing dev-node suite (setup + demo contract, sequential,
# batch_all rollback, atomic) against it, then always stops the node. Evidence goes to a temp dir, not the repo.
# Not Portaldot. Uses the public //Alice dev account only. Needs curl + network for the first binary download
# (sha256-checked); reuses an existing binary if SEAM_DEVNODE_BIN_DIR (or /workspace/tools/...) has one.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
export SEAM_DEVNODE_DIR="$TMP/node"
export SEAM_DEVNODE_PORT="${SEAM_E2E_PORT:-9955}"
export SEAM_DEVNODE_URL="ws://127.0.0.1:$SEAM_DEVNODE_PORT"
export SEAM_EVIDENCE_DIR="$TMP/evidence"
export SEAM_REPO_EVIDENCE_DIR="$TMP/repo-evidence"
export SEAM_DEVNODE=1
DEVNODE="$ROOT/packages/chain/scripts/devnode.sh"
cleanup() {
  "$DEVNODE" stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
EXISTING="${SEAM_DEVNODE_BIN_DIR:-/workspace/tools/substrate-contracts-node}/substrate-contracts-node-linux"
mkdir -p "$SEAM_DEVNODE_DIR"
[ -d "$EXISTING" ] && ln -s "$EXISTING" "$SEAM_DEVNODE_DIR/substrate-contracts-node-linux"
"$DEVNODE" start --fresh
cd "$ROOT/packages/chain"
npx vitest run tests/devnode.test.ts
