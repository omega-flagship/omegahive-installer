#!/bin/sh
# Check: rules.json is exactly what omega-mark.metta decides (regenerated through PeTTa and compared byte for byte).
#   PETTA_PATH=/path/to/PeTTa sh check_rules.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
python3 "$here/gen_rules.py" "$tmp/rules.json"
if cmp -s "$tmp/rules.json" "$here/rules.json"; then echo "PASS rules.json matches omega-mark.metta"; else echo "FAIL rules.json differs from omega-mark.metta"; diff "$here/rules.json" "$tmp/rules.json" | head -20; exit 1; fi
