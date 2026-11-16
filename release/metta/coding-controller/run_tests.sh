#!/bin/sh
# Run all synthetic controller tests with a local PeTTa checkout.
set -eu
: "${PETTA_RUN:?Set PETTA_RUN to the absolute path of PeTTa/run.sh}"
case "$PETTA_RUN" in
    /*) ;;
    *) printf '%s\n' 'PETTA_RUN must be an absolute path' >&2; exit 2 ;;
esac
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
log=$(mktemp "${TMPDIR:-/tmp}/coding-controller-tests.XXXXXX")
trap 'rm -f "$log"' 0
trap 'exit 130' 1 2 3 15
cd "$here"
status=0
sh "$PETTA_RUN" "$here/test_coding_controller.metta" >"$log" 2>&1 || status=$?
cat "$log"
if [ "$status" -ne 0 ]; then
    exit "$status"
fi
passed=$(grep -c '✅' "$log" || true)
failed=$(grep -c '❌' "$log" || true)
if [ "$passed" -ne 185 ] || [ "$failed" -ne 0 ]; then
    printf 'FAIL: expected 185 passing tests; got %s passes and %s failures\n' "$passed" "$failed" >&2
    exit 1
fi
printf '%s\n' 'PASS: 185/185 coding-controller tests'
