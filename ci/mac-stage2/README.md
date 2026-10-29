# Stage2 runtime-input source bundle

**Status: source review complete; actual pipeline qualification pending.**
The independent `STATIC_STAGE2_SOURCE_REVIEW.json` covers the ten exact source
roles and their interfaces. Separate admitted runs passed 30 mocked runner
checks and 12 mocked controller checks. Use the final `MANIFEST.sha256` and its
independently supplied external digest to verify the complete package before
any entry executes. Actual owner admission and pipeline evidence remain
required for a CI run.

Stage2 is intended to run only after the new wait-enabled Stage1 preparation,
in the same fresh macOS arm64 GitHub Actions job, against the same private CI
root. The old Stage1 run remains evidence for its earlier source and is not a
substitute for the package whose final checksum will be supplied with the Stage1
handoff. Stage2 does not build the UI, an app or DMG, demonstrate Assist, register
a Hive host, or deploy a program.

## Verify both packages before execution

Obtain each manifest digest from its independent sealed handoff. Do not derive a
trusted digest from the manifest file being checked. After both packages have
their final external digests, verify the Stage1 and Stage2 manifest files first,
then verify each listed file:

```sh
STUDIO_STAGE1_SOURCE=/absolute/ci/source-stage1
STUDIO_STAGE2_SOURCE=/absolute/ci/source-stage2
STUDIO_STAGE1_MANIFEST_SHA256=<externally-supplied-stage1-seal>
STUDIO_STAGE2_MANIFEST_SHA256=<externally-supplied-stage2-seal>

(
  cd "$STUDIO_STAGE1_SOURCE"
  printf '%s  MANIFEST.sha256\n' "$STUDIO_STAGE1_MANIFEST_SHA256" | shasum -a 256 -c -
  shasum -a 256 -c MANIFEST.sha256
)
(
  cd "$STUDIO_STAGE2_SOURCE"
  printf '%s  MANIFEST.sha256\n' "$STUDIO_STAGE2_MANIFEST_SHA256" | shasum -a 256 -c -
  shasum -a 256 -c MANIFEST.sha256
)
```

The Stage2 checksum must identify the final reviewed ten-role package in the
owner's source handoff. The Stage1 checksum must identify the
wait-enabled Stage1 package delivered for the same owner and job.

The owner must review the actual CI workflow before launch. Invoke Stage1
preparation with the absolute trusted setup-Python executable and the system
PATH `/usr/bin:/bin:/usr/sbin:/sbin`; the setup interpreter may live outside
those directories. Stage1 native and Stage2 use the exact prepared PBS
interpreter and the same system PATH. This is a required workflow condition,
pending actual workflow review. The sealed Stage1 files remain unchanged.

## Source CLI and admitted run

The source-only plan uses trusted Python 3.12 and performs no runtime probes:

```sh
STUDIO_TRUSTED_SETUP_PYTHON=/absolute/trusted/python3.12
/usr/bin/env PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$STUDIO_TRUSTED_SETUP_PYTHON" -I -B -S "$STUDIO_STAGE2_SOURCE/stage2-source/stage2_entry.py" \
  --manifest "$STUDIO_STAGE2_SOURCE/MANIFEST.sha256" \
  --manifest-sha256 "$STUDIO_STAGE2_MANIFEST_SHA256"
```

Only after the package review, controls and separate owner admission authorize
the real run, require both Stage1 and Stage2 exits to be zero and use this exact
Stage1 dependency and Stage2 entry in the same job:

```sh
/usr/bin/env PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /private/tmp/omegahive-ci-r12/runtime-job/bootstrap/python/bin/python3.12 \
  -I -B -S "$STUDIO_STAGE2_SOURCE/stage2-source/stage2_entry.py" \
  --manifest "$STUDIO_STAGE2_SOURCE/MANIFEST.sha256" \
  --manifest-sha256 "$STUDIO_STAGE2_MANIFEST_SHA256" \
  --stage1-manifest "$STUDIO_STAGE1_SOURCE/MANIFEST.sha256" \
  --stage1-manifest-sha256 "$STUDIO_STAGE1_MANIFEST_SHA256" \
  --owner dot-mac-ci --dedicated-ci-job --run
```

The entry requires the prepared PBS interpreter, positive matching real and
effective UID, isolated flags, and the runner's genuine `GITHUB_ACTIONS`
environment. Setting that environment variable manually does not establish an
actual CI run. `--dedicated-ci-job` is the owner's explicit completeness
attestation: no other Studio reservations exist unless supplied through the
optional closed `--current-tasks` owner-attestation JSON. It is not
authenticated Hive membership or a distributed lease. Fresh pinned resource
advice independently admits each phase; unknown or insufficient headroom
prevents launch.

The entry uses five separate owned phase processes: finalization,
original-runtime audit, closed-inventory copy, relocated-runtime audit, and
data-only sealing. Each process starts in its own session. Audit commands
require the parent to acknowledge their actual registration and kernel birth
identity before the held bridge can execute the pinned command. An audit receipt
is emitted only after the runner sampler and all owned command groups close
cleanly. Failed or partial attempts remain preserved; no phase or existing
Stage2 launch is resumed.

## Resource and evidence scope

The serial reservation is 3.125 GiB RAM, 2.25 CPU cores and 4 GiB additional
scratch. The worker and every owned command group are observed under 3 GiB; the
external parent allowance is 0.125 GiB. CPU and scratch figures are declared
reservations, not kernel quotas. Per-command output is at most 64 KiB; the audit
aggregate limit is 64 MiB. A successful full runner-closure vector is at most
8 MiB and includes every command group.

Each audit has its own original 1,800-second controller envelope, including
startup and cleanup, with at most 1,500 seconds for audit work and 300 seconds
of controller reserve. Data phases have 935-second envelopes covering 15
seconds of startup, the helper's full 900-second bound and 20 seconds of
cleanup. The complete serial Stage2 controller has a 6,900-second wall bound.
Configure the CI job timeout for Stage1 and Stage2 together; a shorter timeout
does not establish that the phase bounds were met.

The intended sealed runtime input is
`/private/tmp/omegahive-ci-r12/runtime-job/receipts/sealed-runtime-input-r1.json`.
The original Stage2 result and each phase result remain under
`/private/tmp/omegahive-ci-r12/stage2-parent/attempt-<32 lowercase hex>/`.
Retain failed and successful receipts, source reviews, checksum manifests,
command registration/acknowledgement records and bounded logs. Receipt
consistency is not current process liveness. Keep source bytes and large
artifacts on this MacBook; use the allowlisted selective pull transport for
owner-requested files. Do not publish credentials, private environment data or
account records.

UI, application/DMG, clean-user installer behavior, Assist demonstration and
deployment still require separate actual evidence and owner gates. Source
review and mocked controls grant no Stage2 run, runtime, product or deployment
qualification.
