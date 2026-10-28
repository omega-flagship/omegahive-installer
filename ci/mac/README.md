# Mac CI stage 1: public preparation and native runtime phases

This is the source handoff requested by Dot for the private installer CI branch.
It contains runnable preparation and native entry points, exact public input
locks, the fixed native worker and parent, and two genuine immutable source
reviews. `MANIFEST.sha256` binds every delivered file; its external SHA256 comes
from Studio's delivery notice. It does not hash itself.

Use a fresh, dedicated macOS arm64 CI job with a trusted preinstalled Python 3.12
and `GITHUB_ACTIONS=true`. The owner must select an actual arm64 runner and
attest that no other Studio reservation occupies the job. Native work declares
3.125 GiB RAM, 2.25 CPU cores and 8 GiB scratch. Public preparation declares
1.125 GiB RAM, 1.25 CPU cores and 4 GiB scratch. Both obtain fresh advice from the
included unchanged resource policy. These are reservations and observed RSS/
time/log guards; CPU and disk estimates are not kernel quotas.

The fixed job root `/private/tmp/omegahive-ci-r12` must be absent before
preparation. An existing root or launch attempt is retained and refused. Use a
new CI job after a failed or deferred attempt; these entry points do not erase
or resume failed evidence. Never run against Studio's retained local job.

Vendor this complete directory as `ci/mac` in the owner's CI checkout. Keep all
relative paths intact. From inside `ci/mac`, set the task-specific
`STUDIO_STAGE1_MANIFEST_SHA256` to the exact external digest in Studio's notice,
then use these commands:

```sh
printf '%s  MANIFEST.sha256\n' "$STUDIO_STAGE1_MANIFEST_SHA256" | shasum -a 256 -c -
shasum -a 256 -c MANIFEST.sha256

python3.12 -I -B -S prep_entry.py \
  --manifest "$PWD/MANIFEST.sha256" \
  --manifest-sha256 "$STUDIO_STAGE1_MANIFEST_SHA256" \
  --static-review "$PWD/STATIC_SOURCE_REVIEW.json" \
  --owner dot-mac-ci \
  --dedicated-ci-job --run

env HOME=/private/tmp/omegahive-ci-r12/runtime-job/empty-home \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /private/tmp/omegahive-ci-r12/runtime-job/bootstrap/python/bin/python3.12 \
  -I -B -S "$PWD/native_entry.py" \
  --manifest "$PWD/MANIFEST.sha256" \
  --manifest-sha256 "$STUDIO_STAGE1_MANIFEST_SHA256" \
  --static-review "$PWD/STATIC_SOURCE_REVIEW.json" \
  --owner dot-mac-ci \
  --dedicated-ci-job --run
```

Run preparation first and proceed to the native command only on its actual exit
0. Preparation downloads the 60 exact pinned public files and stages source
data. Its extraction handles the official PBS archive's omitted directory/root
headers while retaining exact real header evidence. It creates the canonical
resource files required by the native launcher. It executes no downloaded
interpreter, package installer, native build or application.

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

Studio has actually passed a corrected isolated public fetch and extraction on
the MacBook. It also passed the scoped archive-layout, preparation admission,
canonical resource-copy, cancellation, and 58 native entry/Parent integration
controls. The integration controls use mocked filesystem/process/CI seams; no
native build or CI run was performed by those controls.

After actual native phase completion, finalization, native audit, independent
relocation, runtime seal, offline UI build, application assembly, DMG creation
and journey validation remain separate stages. This source set does not claim
those results, signing, deployment, release approval or a complete Assist demo.
Dot retains CI integration, host admission and release ownership. CI uses the
vendored source and pinned public downloads; the MacBook relay and private
runtime contents are not runner dependencies.
