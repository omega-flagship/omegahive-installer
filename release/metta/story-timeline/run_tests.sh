#!/bin/sh
# Compile the fixture stories with PeTTa (single-threaded) and run the tests.
D=$(cd "$(dirname "$0")" && pwd); cd $D; set -e
fail=0
S="story.metta look.metta gen_timeline.metta"
./compile.sh story.metta > rec.txt;            node tojson.mjs rec.txt timeline.json $S
./compile.sh story.metta > rec2.txt;           node tojson.mjs rec2.txt timeline2.json $S
./compile.sh story_edit.metta > rec_e.txt;     node tojson.mjs rec_e.txt timeline_edit.json story_edit.metta look.metta gen_timeline.metta
./compile.sh story.metta lt_cumulative.metta > rec_c.txt;      node tojson.mjs rec_c.txt timeline_cum.json $S
./compile.sh story_edit.metta lt_cumulative.metta > rec_ec.txt; node tojson.mjs rec_ec.txt timeline_edit_cum.json story_edit.metta look.metta gen_timeline.metta
cmp -s timeline.json timeline2.json && echo "PASS 5 determinism: two compiles byte-equal" || { echo "FAIL 5 determinism"; fail=1; }
set +e
./compile.sh story_gap.metta > rec_g.txt; node tojson.mjs rec_g.txt timeline_gap.json story_gap.metta 2>/dev/null
[ $? -eq 3 ] && echo "PASS checks: gapped story refused ($(grep 'check tiling' rec_g.txt))" || { echo "FAIL checks: gapped story not refused"; fail=1; }
node test.mjs || fail=1
echo "sha timeline.json: $( (sha256sum timeline.json 2>/dev/null || shasum -a 256 timeline.json) | cut -c1-16)"
[ "$fail" -eq 0 ] || { echo "FAIL: story-timeline tests failed" >&2; exit 1; }
