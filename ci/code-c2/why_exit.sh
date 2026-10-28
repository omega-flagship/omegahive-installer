#!/bin/sh
# Diagnostic only: start the runtime-only Code service once with a synthetic config like the probe's and show the tail
# of its stderr (the operator token is random, lives in a file, and is redacted if it ever appears).
set -u
PY=$1; SRC=$2
T=$(mktemp -d); chmod 700 "$T"; mkdir -m 700 "$T/data" "$T/synthetic-repository"
TOKEN=$(head -c 27 /dev/urandom | base64 | tr '+/' '-_'); printf '%s\n' "$TOKEN" > "$T/operator-token"; chmod 600 "$T/operator-token"
printf '{"data_root":"%s/data","operator_token_file":"%s/operator-token","hive_url":"http://127.0.0.1:8700","repositories":{"synthetic":{"path":"%s/synthetic-repository"}}}' "$T" "$T" "$T" > "$T/config.json"
chmod 600 "$T/config.json"
cd "$T"
env -i HOME="$T" LANG=C.UTF-8 PATH=/usr/bin:/bin PYTHONNOUSERSITE=1 PYTHONPATH="$SRC" PYTHONUNBUFFERED=1 TMPDIR="$T" \
  timeout 10 "$PY" -B -s -m omegacode --config "$T/config.json" > "$T/out.txt" 2> "$T/err.txt"
echo "service exit code $?"
echo "--- stderr tail ---"; tail -40 "$T/err.txt" | sed "s#$TOKEN#<redacted>#g"
echo "--- stdout tail ---"; tail -10 "$T/out.txt" | sed "s#$TOKEN#<redacted>#g"
