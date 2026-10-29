# Stage2 diagnostic successor source bundle

This is a Source envelope, not execution admission or runtime qualification.
The ten staged roles preserve nine exact bodies from the original sealed Stage2
bundle. Only `stage2-source/stage2_entry.py` changes: the frozen diagnostic
successor is 83,586 bytes, SHA-256
`21114bcff7f08b20bae043e853e44e41b5588cfc5ab360b183ee5347ba78f39d`.
It adds bounded sanitized failure stdout while preserving success/source-plan
output and the original receipt, admission, resource, launch, cleanup, clock and
outcome behavior. It adds no CLI argument or environment read.

Use this envelope only after the genuine independent
`STATIC_STAGE2_SOURCE_REVIEW.json` and final `MANIFEST.sha256` are present and
Root independently supplies the final manifest digest. The review must cover
all ten exact roles, including the replacement Entry. The old review is retained
as provenance elsewhere; it is not the current review. No generated per-run PASS
or author-created review is a substitute. The manifest seals exactly ten role
files, this README and the raw genuine new review (12 payload files; 13 shipping
files including the manifest). `SOURCE_INVENTORY_R1.json` and work/evidence records
are separate unsealed coordination support and must not be mistaken for payload
review subjects or copied as additional execution inputs.

The predecessor envelope remains immutable: original manifest 1,162 bytes,
SHA-256 `c96530bde3b024b2226b767075d4682d91c90448d610095bce548060f1aded8c`;
original review 2,914 bytes, SHA-256
`95d4a623e9c055e2256f5ae5c29ab753f42b04b06d2aa3ea9aa4855ad7eb7ae5`.
Earlier failed, unrun and superseded Source/CI receipts remain preserved. The
cause of the earlier actual Stage2 failure remains unknown; this packaging does
not diagnose it or authorize a rerun. Earlier scoped controls do not establish
this envelope's actual Stage2 outcome.

## Verification and invocation contract

Root supplies independently delivered Stage1 and Stage2 manifest digests. Verify
the exact raw manifests against those external digests, then every standard
checksum entry before invoking any entry. Never obtain the trusted digest from
the manifest being checked. The Stage1 dependency is the wait-enabled sealed
Stage1 envelope admitted for the same fresh macOS arm64 GitHub Actions job.
Keep the original Stage1 files unchanged.

The read-only Source plan CLI is:

```text
/absolute/trusted/python3.12 -I -B -S /absolute/stage2-source/stage2-source/stage2_entry.py --manifest /absolute/stage2-source/MANIFEST.sha256 --manifest-sha256 EXTERNALLY_SUPPLIED_STAGE2_SHA256
```

It is not run by this packet. The actual same-job Stage2 CLI, only after Root's
separate workflow/resource/owner admission, is:

```text
/private/tmp/omegahive-ci-r12/runtime-job/bootstrap/python/bin/python3.12 -I -B -S /absolute/stage2-source/stage2-source/stage2_entry.py --manifest /absolute/stage2-source/MANIFEST.sha256 --manifest-sha256 EXTERNALLY_SUPPLIED_STAGE2_SHA256 --stage1-manifest /absolute/stage1-source/MANIFEST.sha256 --stage1-manifest-sha256 EXTERNALLY_SUPPLIED_STAGE1_SHA256 --owner OWNER_APPROVED_LABEL --dedicated-ci-job --run
```

Both invocations require the canonical system PATH `/usr/bin:/bin:/usr/sbin:/sbin`.
Actual Stage2 requires the exact prepared PBS interpreter, isolated flags, real
GitHub Actions environment, positive matching real/effective UID and the fresh
same-job CI root. `--dedicated-ci-job` is the owner's completeness attestation;
optional closed `--current-tasks` may carry other actual reservations. It is not
a distributed membership or goal lease. Fresh pinned resource advice independently
admits every phase; unknown or insufficient headroom prevents launch. No actual
owner label, UID, process, reservation, lease or resource observation is invented
by these placeholder invocation examples.

## Unchanged operational and evidence scope

Five serial owned phase processes perform finalization, original-runtime audit,
closed-inventory copy, relocation audit and data-only sealing. The declared
reservation remains 3.125 GiB RAM, 2.25 CPU and 4 GiB additional scratch. Worker
plus owned command groups remain under 3 GiB; parent allowance is 0.125 GiB.
CPU and scratch are declared reservations, not kernel quotas. Each audit envelope
is 1,800 seconds with at most 1,500 seconds work and 300 seconds reserve. Data
phase envelopes are 935 seconds. Complete serial controller wall bound is 6,900
seconds. Per-command output is 64 KiB, audit aggregate output 64 MiB and complete
runner closure at most 8 MiB. Actual command registration/birth identity, parent
ACK, cleanup, reap and group absence remain mandatory.

Final Stage2 results are reported under the fixed
`/private/tmp/omegahive-ci-r12/stage2-parent/attempt-<32 lowercase hex>/` namespace;
pre-parent terminal failures explicitly report null paths. Sanitized failure
stdout is bounded by 2,048 ASCII bytes excluding newline. Reported fixed result
and phase targets are not observed receipt custody. The Entry does not read
receipts or guess worker exit/reap/group/signals for this diagnostic. Original
argparse stderr is unchanged and is outside the terminal-stdout sanitization
contract. Independent retained stdout wiring is a separate reviewed workflow
change; this packet does not implement it.

Retain named successful/failed receipts, genuine reviews, checksum manifests,
bounded logs and command registration/ACK records through a separately approved
custody mechanism. No broad runtime/private/home walk, secrets or account records
belong in shipping evidence. Source review, synthetic controls and receipt
consistency do not establish fresh liveness, restored runtime, native/product,
UI/DMG/installer, Assist, membership or deployment qualification. Root alone owns
publication/selective pull, consumer pin rebinding and actual admission.
