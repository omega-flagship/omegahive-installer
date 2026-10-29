# Mac CI Stage 1: public preparation and native runtime phases

This is the Stage 1 source handoff for the private installer CI branch. It is
based on the exact manifest-listed payloads in the prior Stage 1 R2 bundle,
with only `prep_entry.py` and `native_entry.py` replaced by their bounded
admission-wait revisions. The other source and reference payloads retain their
prior bytes. `STATIC_NATIVE_SOURCE_REVIEW.json` independently covers the actual
wait-enabled native entry, fixed native parent and worker, and native input
producer. The completed independent whole-bundle `STATIC_SOURCE_REVIEW.json`
covers the exact eleven source roles and links the native component review.
Use the final `MANIFEST.sha256` to verify every delivered file. Obtain its
external SHA256 from Studio's separate delivery notice; the manifest does not
hash itself.

Use a fresh, dedicated macOS arm64 CI job with trusted preinstalled Python 3.12
and `GITHUB_ACTIONS=true`. The owner must select an actual arm64 runner and
attest that no other Studio reservation occupies the job. Native work declares
3.125 GiB RAM, 2.25 CPU cores and 8 GiB scratch. Public preparation declares
1.125 GiB RAM, 1.25 CPU cores and 4 GiB scratch. Both obtain fresh advice from
the included unchanged resource policy. These are reservations and observed
RSS/time/log guards; CPU and disk estimates are not kernel quotas.

The fixed job root `/private/tmp/omegahive-ci-r12` must be absent before
preparation. An existing root or launch attempt is retained and refused. Use a
new CI job after a failed or deferred attempt; these entry points do not erase
or resume failed evidence. Never run against Studio's retained local job.

Vendor this complete directory as `ci/mac` in the owner's CI checkout. Keep all
relative paths intact. From inside `ci/mac`, set the task-specific
`STUDIO_STAGE1_MANIFEST_SHA256` to the exact external digest in Studio's notice.
Verify the external manifest checksum first, then every listed payload:

```sh
printf '%s  MANIFEST.sha256\n' "$STUDIO_STAGE1_MANIFEST_SHA256" | shasum -a 256 -c -
shasum -a 256 -c MANIFEST.sha256

python3.12 -I -B -S prep_entry.py \
  --manifest "$PWD/MANIFEST.sha256" \
  --manifest-sha256 "$STUDIO_STAGE1_MANIFEST_SHA256" \
  --static-review "$PWD/STATIC_SOURCE_REVIEW.json" \
  --owner dot-mac-ci \
  --dedicated-ci-job \
  --admission-wait-seconds 600 \
  --run

env HOME=/private/tmp/omegahive-ci-r12/runtime-job/empty-home \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /private/tmp/omegahive-ci-r12/runtime-job/bootstrap/python/bin/python3.12 \
  -I -B -S "$PWD/native_entry.py" \
  --manifest "$PWD/MANIFEST.sha256" \
  --manifest-sha256 "$STUDIO_STAGE1_MANIFEST_SHA256" \
  --static-review "$PWD/STATIC_SOURCE_REVIEW.json" \
  --owner dot-mac-ci \
  --dedicated-ci-job \
  --admission-wait-seconds 600 \
  --run
```

Run preparation first and proceed to the native command only on its actual exit
0. Each `--admission-wait-seconds` is bounded from 0 to 600 seconds (default
600). Preparation spends one shared budget across initial admission, fetch and
stage admission. Native uses its own bounded wait before owner facts and launch
context. Only a `wait` decision is retried. An unknown, cancelled, timed-out or
otherwise rejected admission launches no work for that waiting phase. Evidence
from earlier completed phases is retained. After a native `run`, the entry
rechecks preparation and tool pins and directory identities before constructing
owner facts; the fixed Parent makes its own fresh prelaunch resource check.

Preparation fetches the 60 exact pinned public files and stages source data. Its
extraction handles the official PBS archive's omitted directory/root headers
while retaining exact real-header evidence. It creates the canonical resource
files required by the native launcher. It executes no downloaded interpreter,
package installer, native build or application.

The second command starts with the newly staged exact PBS interpreter. Native
Entry copies the immutable four native source files and raw component review,
binds actual CI-owner UID, job identity, system tool hashes, task completeness,
and source/preparation pins, then replaces itself with the fixed Parent via
`execve`. It generates owner context and input data, never a new source-review
PASS or rewritten executable source. Parent samples resources again immediately
before creating the owned worker. The fixed phases are tools, python, node,
pcre, configure, build, install, deps, janus.

Retain the preparation parent results under `preparation-parent`, the fetch and
preparation receipts in `runtime-job`, native parent attempts under
`native-parent`, worker attempts under `native-build-attempts`, and
`runtime-job/receipts/native-phases-r1.json`. Actual exit 0 plus matching worker
and parent receipts, clean reap and group absence determine native phase
completion. Preserve failures, resource deferrals, cancellation, logs and owner
context history. A source review or owner launch marker is not execution proof.

Control evidence is revision-scoped. The historical 58-control run at
`coordination/studio/20261028/native-entry-fiftyeight-controls-root-r1/actual-run-r1/RESULT_R1.json`
(573ff82e5623f3ace37e8f2c463936fbeeff6b792a332a04db31f944c2c24373) used the
prior native entry `67b49abd8ec84c6798387823b2283af8be77d51a4f55c2e95bd38ad81302e28b`;
it does not qualify the wait-enabled entry. The separate 14-control scoped
synthetic run at
`coordination/remote-control/20261028/ci-admission-wait-fourteen-scoped-run-r1/RESULT_R1.json`
(SHA256 `20596a65d7cb747a60cea1fe529c8b40468c9bde8f84892b12d4ac14bf11a657`)
reports 14/14 controls pass for the pinned wait behavior. It is synthetic
control evidence only; it is not a real CI run, resource admission, fetch,
native build, runtime test, product pass, or deployment qualification.

After actual native phase completion, finalization, native audit, independent
relocation, runtime seal, offline UI build, application assembly, DMG creation
and journey validation remain separate stages. This source set does not claim
those results, signing, deployment, release approval or a complete Assist demo.
Dot retains CI integration, host admission and release ownership. CI uses the
vendored source and pinned public downloads; the MacBook relay and private
runtime contents are not runner dependencies.
