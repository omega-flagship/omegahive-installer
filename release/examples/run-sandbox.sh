#!/usr/bin/env bash
# One throwaway local hive for the examples. See examples/SANDBOX.md.
#
#   examples/run-sandbox.sh [PORT]        # PORT defaults to 8790
#
# It starts one hive process and nothing else:
# - bound to 127.0.0.1 only, on PORT;
# - with a fresh temporary HIVE_DATA_DIR, removed when the hive stops (SANDBOX_KEEP=1 keeps it);
# - offline: new minds default to the mock/echo model, embeddings to mock/hash, no catalogue fetches;
# - with examples/hello-app mounted through HIVE_PLUGIN_DIRS.
# The hive runs in a clean environment: only PATH, HOME, USER, LANG, TMPDIR and the few settings named below are
# passed on, so provider keys and other HIVE_* settings in your shell do not reach it.
#
# Settings read from your environment:
#   PYTHON              the Python 3.12 that has the hive's requirements (default: python3)
#   PETTA_PATH          the PeTTa checkout minds run on (default: ~/PeTTa, as the hive itself defaults)
#   HIVE_PROVIDERS_FILE optional, passed on (see examples/hello-model)
#   HIVE_CHROMADB_LIB   optional, passed on
set -euo pipefail

PORT="${1:-8790}"
case "$PORT" in
  ''|*[!0-9]*) echo "run-sandbox: PORT must be a number, got '$PORT'" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "run-sandbox: PORT must be between 1024 and 65535" >&2; exit 2
fi

EXAMPLES="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname -- "$EXAMPLES")"
PYTHON="${PYTHON:-python3}"
PETTA="${PETTA_PATH:-$HOME/PeTTa}"

if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; then
  echo "run-sandbox: warning: $PYTHON is not Python 3.12 (see examples/README.md)" >&2
fi
if [ ! -f "$PETTA/run.sh" ]; then
  echo "run-sandbox: warning: no PeTTa at $PETTA; the hive starts, but minds will not run (set PETTA_PATH)" >&2
fi
if [ ! -d "$ROOT/hive/ui/dist" ]; then
  echo "run-sandbox: note: the UI is not built, so only the API answers; build it with (cd hive/ui && npm ci && npm run build)" >&2
fi

# Refuse a port that is already taken, rather than disturbing whatever holds it.
if ! "$PYTHON" - "$PORT" <<'PY'
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
then
  echo "run-sandbox: 127.0.0.1:$PORT is in use; pass another port: examples/run-sandbox.sh <port>" >&2
  exit 1
fi

DATA="$(mktemp -d "${TMPDIR:-/tmp}/omegahive-sandbox.XXXXXX")"
cleanup() {
  if [ "${SANDBOX_KEEP:-0}" = "1" ]; then
    echo "run-sandbox: kept $DATA"
  else
    rm -rf -- "$DATA"
  fi
}
trap cleanup EXIT

URL="http://127.0.0.1:$PORT"
echo "run-sandbox: hive URL:            $URL"
echo "run-sandbox: admin password file: $DATA/admin-password (written when the hive starts)"
echo "run-sandbox: data directory:      $DATA"
echo "run-sandbox: mounted app:         $EXAMPLES/hello-app"
echo "run-sandbox: stop with Ctrl-C"

passthrough=()
for var in HIVE_PROVIDERS_FILE HIVE_CHROMADB_LIB; do
  if [ -n "${!var:-}" ]; then passthrough+=("$var=${!var}"); fi
done

cd -- "$ROOT"
set +e
env -i \
  PATH="$PATH" HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
  PETTA_PATH="$PETTA" \
  HIVE_HOST=127.0.0.1 \
  HIVE_PORT="$PORT" \
  HIVE_PUBLIC_URL="$URL" \
  HIVE_DATA_DIR="$DATA" \
  HIVE_DEFAULT_MODEL=mock/echo \
  HIVE_EMBEDDING_MODEL=mock/hash \
  HIVE_OFFLINE=1 \
  HIVE_PLUGIN_DIRS="$EXAMPLES/hello-app" \
  ${passthrough[@]+"${passthrough[@]}"} \
  "$PYTHON" -m hive
status=$?
set -e
exit "$status"
