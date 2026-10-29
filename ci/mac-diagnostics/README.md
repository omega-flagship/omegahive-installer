# CI diagnostic and pre-execution source R2

Reader R8 and fixed PBS pre-execution helper R2 with their exact independent
source reviews. Local focused validation passed 39 reader cases, 18 intercepted
pre-execution cases, and 16 native-admission cases, all unfiltered with no
failures, errors or skips. These are fixture results, not real CI/native/runtime
or full collector qualification. Both failed CI attempts remain failed.

The workflow must authenticate this external MANIFEST.sha256 and every payload
before either helper runs. The metadata reader remains in the trusted selected
setup Python, with -I -B -S, exact --source-sha256, --owner dot-mac-ci,
--dedicated-ci-job --run and GITHUB_ACTIONS=true. Its existing 15s/128MiB,
2MiB per general control, 12MiB total reads and 64KiB retained-report bounds stay.
Stage2 and native selection are independent. Native selection requires the
current Entry launch and exact four-field selector, mode0400 and at most4096B,
with source/context cross-binding and strict duplicate/nonfinite JSON rejection.
Only finite labels and bounded numbers are emitted; raw control bodies are not.

Before full collection, the workflow independently authenticates this set again
and runs exec_verified_pbs_collector.py in the trusted selected setup Python:
--collector-root "$GITHUB_WORKSPACE/ci/mac-collect"
--manifest-sha256 "$STUDIO_COLLECT_MANIFEST_SHA256".
Its fixed PBS18652104/aed8... and unchanged collector31539/c50b... are checked by
byte/hash/owner/mode/link and held path/file identities before one fixed exec.
Missing, partial or changed PBS fails nonzero. Original15s/128MiB bounds and the
collector's own checks remain; no chmod, copies, sudo, guard relaxation or retry.
The canonical check-to-exec race class and actual runner-ancestor compatibility
remain unqualified. The metadata fallback must be retained before this step.

This packet grants no third CI attempt, membership, deployment, real native or
collector pass, runtime custody/restore, UI/app/DMG or complete Assist demo.
Canonical artifact bytes remain on MacBook; only this explicit small text source
set may be selectively pulled. Access URLs, tokens and account data are excluded.
