#!/bin/sh
# compile.sh <story.metta> [extra.metta] -> raw records on stdout (single-threaded PeTTa)
# Set PETTA_RUN to your PeTTa run.sh (https://github.com/trueagi-io/PeTTa); SWI-Prolog 10.1+ on PATH.
set -e
D=$(cd "$(dirname "$0")" && pwd); tmp=$(mktemp -d $D/run.XXXX)
cat "$@" $D/look.metta $D/gen_timeline.metta > $tmp/run.metta
"${PETTA_RUN:-petta/run.sh}" $tmp/run.metta 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^\((timeline-film|seg|trans|event-at|endcard|check) '
rm -rf $tmp
