#!/usr/bin/env bash
# Local SEAM dev chain: substrate-contracts-node (prebuilt release binary, checksum-verified).
# Runtime has Assets, Contracts (ink!), Utility and Balances. Instant seal: one block per transaction,
# finalized after --finalize-delay-sec (default 1 s here). Dev accounts (//Alice ...) are public keys:
# LOCAL USE ONLY.
#
#   scripts/devnode.sh start [--fresh]   start in the background on ws://127.0.0.1:9944
#   scripts/devnode.sh stop | status | logs
#
# Env: SEAM_DEVNODE_DIR (binary + data, default /workspace/tools/substrate-contracts-node),
#      SEAM_DEVNODE_PORT (default 9944), SEAM_DEVNODE_FINALIZE_DELAY (default 1).
set -euo pipefail

VERSION=v0.42.0
SHA256=a631b4e83dd05e4beaccbd770be709ac41914183d443116c2e4d244161590265
URL="https://github.com/paritytech/substrate-contracts-node/releases/download/${VERSION}/substrate-contracts-node-linux.tar.gz"
DIR="${SEAM_DEVNODE_DIR:-/workspace/tools/substrate-contracts-node}"
PORT="${SEAM_DEVNODE_PORT:-9944}"
DELAY="${SEAM_DEVNODE_FINALIZE_DELAY:-1}"
BIN="$DIR/substrate-contracts-node-linux/substrate-contracts-node"
DATA="$DIR/data"
PIDFILE="$DIR/devnode.pid"
LOG="$DIR/devnode.log"

install() {
  [ -x "$BIN" ] && return
  mkdir -p "$DIR"
  echo "downloading substrate-contracts-node $VERSION"
  curl -sSL -o "$DIR/node.tar.gz" "$URL"
  echo "$SHA256  $DIR/node.tar.gz" | sha256sum -c -
  tar xzf "$DIR/node.tar.gz" -C "$DIR"
  chmod +x "$BIN"
}

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  start)
    install
    if running; then echo "already running (pid $(cat "$PIDFILE")) on ws://127.0.0.1:$PORT"; exit 0; fi
    [ "${2:-}" = "--fresh" ] && rm -rf "$DATA"
    mkdir -p "$DATA"
    # --dev = dev chain spec, --alice, force authoring; persistent --base-path keeps assets/contracts across restarts.
    nohup "$BIN" --dev --base-path "$DATA" --rpc-port "$PORT" --rpc-methods unsafe --rpc-cors all \
      --finalize-delay-sec "$DELAY" >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    for _ in $(seq 1 60); do
      if curl -s -H 'Content-Type: application/json' -d '{"id":1,"jsonrpc":"2.0","method":"system_health","params":[]}' "http://127.0.0.1:$PORT" >/dev/null; then
        echo "substrate-contracts-node $("$BIN" --version | awk '{print $2}') running (pid $(cat "$PIDFILE")) on ws://127.0.0.1:$PORT, log $LOG"
        exit 0
      fi
      sleep 0.5
    done
    echo "node did not come up; see $LOG" >&2; exit 1 ;;
  stop)
    if running; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo stopped; else echo "not running"; fi ;;
  status)
    if running; then echo "running (pid $(cat "$PIDFILE")) on ws://127.0.0.1:$PORT"; else echo "not running"; exit 1; fi ;;
  logs) tail -n 50 "$LOG" ;;
  *) echo "usage: $0 start [--fresh] | stop | status | logs" >&2; exit 2 ;;
esac
