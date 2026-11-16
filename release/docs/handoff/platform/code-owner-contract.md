# Linux Code owner contract: consolidated rules (base contract and its amendments)

This is the effective contract between the Platform owner and the Code owner for confined Code runs on the Linux cloud host. It merges the reviewed base contract (its fourth revision) with the first amendment (final revision) and the second amendment and its two follow-ups. Rules below are labelled by the amendment they come from: A1 is the first amendment, A2 the second, and A2.1 to A2.5 its numbered follow-up points. Where an amendment changed or clarified the base contract, the amended rule is what appears here.

Status as of 2026-10-09: the contract text is reviewed (the base contract passed both independent reviews; the second amendment and its follow-ups passed one independent review). Nothing in it has been built, installed or probed on the target. Every probe-gated item is still gated.

## Purpose and roles

- **Platform** supplies an immutable runtime bundle, a fd-mode launcher, a single-threaded supervisor, the host unit and account, and the hard host guard.
- **Code** owns its daemon, its adapter, authority checks, the per-execution validation lock and execution receipts. Code's daemon talks to the supervisor; the supervisor launches confined workloads.
- The hive service itself is not changed by this contract. It keeps no delegation and gains no authority over Code runs.

## 1. Runtime bundle

- One bundle per release under a root-owned runtime directory, outside the hive's own tree. Read-only, never modified in place. Bundle ids follow a fixed pattern.
- Contents: a materialised Python tree with zero symlinks, the launcher, the supervisor (which also acts as the gate), and a manifest file.
- The manifest lists every regular file except itself, every directory, the four executed files (`exec_set`), allowed read roots, the three merged-usr system symlinks, the custody lock path, the unit identity, the state roots, the mount policy and the schema names.
- Digest domains: `bundle_sha256` (raw manifest bytes), `files_sha256`, `mount_policy_sha256`, `supervisor_sha256`.
- Code pins the bundle id, `bundle_sha256`, `files_sha256` and the four `exec_set` paths and hashes as one pin set. No pin may be made before Platform sends the post-probe (P1) bundle pin.
- Schema names bound by the Code owner's next revision: `code-linux-execution/2`, `code-env/2`, `landlock-profile/3`, `omegahive-runtime-bundle/2`, `code-mount-policy/1`.

## 2. Trees and profile

- All per-run state lives under one Code-owned parent: `exec/<id>` (the workload's writable directory, with `home` and `tmp`), `control/<id>` (profile, spec, journal, grants), `supervisor/` and `service/`.
- Paths must be literal canonical paths and real (no symlinks), except the three system symlinks, which must point where the manifest says.
- Four groups (workload dir, control dir, supervisor dir, collapsed read set) may not overlap or nest.
- The profile is canonical JSON with exactly five keys. Device lists and connect ports are empty. No `/dev` path exists in the view.

## 3. Sealed handoff and identity

- The profile is captured under the run's shared custody lock, size-bounded, hash-checked, then sealed into a memfd with all four seals. The launcher reads it from fd 3 and closes fd 3 at once.
- Full census of the bundle at supervisor startup and at admission for a new bundle hash. Per launch, a lighter re-walk plus a rehash of the four executed files.
- **A2.4:** the supervisor needs no external digest at startup. It censuses the manifest at its own pinned path and reports the computed `bundle_sha256` in `hello`. Code holds the external pin and refuses a supervisor whose hello hash differs. Every start carries the hash and is refused on mismatch.
- Mount inventory is read per admission, never cached, and matched per class (bundle, system, exec, control). The mount policy values come only from the reviewed P1 probe receipt.
- **A2.1:** the mount policy object has exactly `schema` and `rules`; `rules` has exactly four rules sorted by class, each with a closed key set and `allow_submounts:false`.
- **A2.5:** `bundle_invalid` is an internal diagnostic only. At startup it blocks readiness; at start time it surfaces on the wire as `runtime_mismatch` with detail.

## 4. Launcher (fd mode)

- fd 3 sealed profile; fd 4 setup result (single bytes X / E / F); fd 5 exit report written only by the namespace init process after reaping the workload (W plus raw wait status). This is the only source of the workload's exit code.
- The workload holds only fds 0, 1, 2. Non-empty ports or programs are refused.
- Called with a filesystem path, the launcher behaves exactly as before, so hive minds are unaffected.

## 5. Custody lock and GC

- A root-owned lock file, never deleted or recreated. Each run takes its own shared lock and holds it until the run is closed. A busy lock waits on a loop timer for up to 5 s, then refuses.
- Bundle GC runs as root under an exclusive lock and also excludes by state (live cgroups, unclosed records, the pinned bundle).
- **A1.1:** Code's validation lock is one file per execution under the control tree, owned by Code, never the custody lock, never acquired by the supervisor, held through the first start resolution.

## 6. Environment and limits

- Exactly 10 environment keys with fixed values (PATH, HOME, TMPDIR, LC_ALL=C.UTF-8, TZ=UTC, four Python flags, TERM=dumb). Loader and credential variables are excluded by the exact-key rule.
- Start limits: timeout and CPU seconds 1..3600, file size up to 1 GiB, combined output up to 16 MiB, memory 256 MiB to 2 GiB, pids 256.
- **A2.2 Q5:** steady per-run descriptor bound is 16; one transient of 17 is allowed only during a single duplicate-and-close step, checked by a test.
- Settled capacity: 4 runs per supervisor, refused when full, never queued. One long-lived supervisor per Code service instance.

## 7. Unit, cgroup and supervision

- A separate Code unit and account. Delegated memory and pids controllers. Strict filesystem protection, private tmp, no new privileges.
- Restart on failure with a start limit of 3 in 600 s and an alert unit on failure. systemd restarts the daemon; the daemon restarts the supervisor; nothing else restarts anything.
- Runs get their own cgroup leaves. The hive account cannot write them (probe P-K).
- Kill ladder on every terminal path: cgroup kill, then per-pid kill, then a final wait (at most 70 s). Exhaustion is `cleanup_failed`, which stops admission until a reconcile empties the leaf.
- Supervisor-death policy: the daemon journals every start before sending it, marks non-terminal runs `binding_lost` on loss, spawns one replacement and sends `recover` for every lost id. Escalation after 120 s or 3 losses in 300 s.
- **A1.2 item 4:** lifetime state exhaustion (`records_full`) stays refused. No archive or cleanup mechanism is part of the contract; recovery is an operator decision with the supervisor down, under a separately reviewed runbook if ever needed.

## 8. Protocol and recovery

- Newline-delimited canonical JSON. Replies correlate by (op, execution id); a start reply may arrive after later replies for the same id.
- Reservation before any side effect. Every refusal after reservation is retained and final for that id and nonce. Capacity and binding-conflict refusals are not retained.
- One closed status enum and one closed refusal-code set. `setup_failed` is a terminal reason, not a refusal.
- **A1.3:** placement requires the placement byte and an independent cgroup check; anything else is `setup_failed` / `placement_failed`.
- **A2.2 boot id:** null at `reserved`; first recorded at leaf creation with the cgroup id.
- **A2.2 Q3:** a nonce file with no record becomes a retained `refused` / `abandoned` record with a null binding. Nothing is invented.
- **A2.2 Q4:** a closed record with its leaf present gets orphan cleanup without changing the result; a terminal record from an older boot with its leaf gone is closed with a reboot note, never counted as task success.
- **A2.2 Q6:** an unparseable frame is answered with `op:null`, `frame_invalid`, null id and binding. This is the only place `op:null` appears.
- **A2.3:** stdout and stderr stay separate streams with their own identity, never concatenated.
- Code marks descendants terminated only on a terminal with measured-empty or reboot cleanup proof, plus an independent `recover` with identical binding and fresh absence measurements. `cleanup_proof:"none"` never qualifies; unknown is never success.

## 9. Hard host guard (activation prerequisite)

A separate reviewed contract. It requires unit-identity attestation, process-origin checks through a root-run attestor, and bounded loaded-module identity (pinned release and bundle, plus root-owned system libraries). No cloud Code registration, capability mint, relay or live activation happens until the guard is accepted and probed.

## 10. Build order

1. Bundle builder. 2. Launcher fd mode. 3. Supervisor. 4. One host change visible to the project lead (account, directories, unit not enabled). 5. Probe P1, then a provisional scratch bundle. 6. Target probes P2 to P14 and P-K in a scratch instance, receipts labelled live target probes. 7. Rollback procedure. 8. Hard host guard.

Each step needs two independent reviews before deploy.

## Open for the Code owner's next revision

The Code release path (outside the hive's tree), adopting the death policy, comparison rule, reply correlation, pre-leaf cancel resolution and exit-provenance fields, the restart drop-in, the no-pin-before-P1 rule, the validation lock name and the new start fields.

_Curated summary. Full version kept privately (source: PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_20261008.md, with PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_AMENDMENT_A1_20261008.md, PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_AMENDMENT_A2_20261009.md, PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_AMENDMENT_A2_1_20261009.md, PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_AMENDMENT_A2_2_20261009.md, PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_AMENDMENT_A2_FAMILY_STANDIN_VERDICT.md)._
