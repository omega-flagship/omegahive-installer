# Linux lifecycle qualification: code-c2 integration

This bundle supplies an additional synthetic lifecycle experiment for Dot's existing installer-repo `code-c2` job on Ubuntu 22.04 x86_64. It does not alter the existing startup-probe containment script, host release guard, service pin, or selected production package. R1.5.2 is a second immutable package directory used only inside this experiment; its production staging hold remains in effect.

## Inputs and prerequisites

Vendor the sealed text files together under `ci/code-lifecycle/`. Verify the delivered external `MANIFEST.sha256` seal, then `sha256sum -c MANIFEST.sha256`, before executing any file. The supervisor requires its sibling `lifecycle_worker.py` and `runtime_preflight.py`; it copies those and itself into each case's root-owned immutable controller directory before launch.

Supply these two exact package archives as separate CI inputs; they contain public synthetic source, not runtime state:

| File | SHA-256 | Product module digest |
| --- | --- | --- |
| `OMEGACODE_R13_SUCCESSOR_R1_4_P3_FOLLOWUP_REVIEW.zip` | `c7478c1e88ed5fd777890196d572cf347c3a38240810b3911836081c8674fea1` | `4a5737b1296bcb49ff44a002684129c18e95a749d8ce3362cd97df18953b449d` |
| `OMEGACODE_R13_SUCCESSOR_R1_5_2_TRACE_API_REVIEW.zip` | `c6f0e7c2380fee230ee8081e097a231d7c7d731afec82ff24ae86041637638f1` | `892f333ee430c5f10a9985f97109e1fa511b1fa020a925de9c49ac73ed64387d` |

The worker verifies each archive hash before extraction and each extracted product digest. Do not use the job's mutable `/tmp/c2/source_r10` as R1.4: the current reviewed patch chain transforms that tree through R1.5.1 before the startup-probe stage.

Other inputs:

- The existing publisher-verified PBS CPython 3.12.16 under `/tmp/py/python/`, provisioned from `ci/linux-x86/x86_64-pins.json`.
- Existing pinned uv 0.13.6 in `$UV`.
- `ci/code-c2/CODE_R10_X86_RUNTIME_REQUIREMENTS_R1.lock`, SHA-256 `d31b5e35f103c7d7d7d75649ff93ba2786e0113fb49197adf0480fd9a5552db5`, 17 runtime distributions.
- Root CI authority for a locked disposable account per case, linger, transient system services, and cleanup of that account's user manager. This authority belongs to the dedicated CI runner; the Code service itself runs under the fresh nonroot account.
- Native systemd as PID 1, a usable login manager/user bus, cgroup v2, `/proc`, and a free port 8724. Missing facts or occupied port refuse the experiment. No service or unrelated process is stopped to make room.

## Runtime provisioning

Keep the existing code-c2 test/runtime environments and outer gate unchanged. Create a **separate bare venv with PBS**, then install the same exact lock with uv. A normal uv-created venv installs an executable `_virtualenv.pth`; the contract rejects executable `.pth` hooks. Do not delete that hook from an existing environment or weaken the runtime inspection.

After the existing PBS/uv download and checksum-verification step:

```bash
set -euo pipefail
test ! -e /tmp/lifecyclevenv
/tmp/py/python/bin/python3.12 -m venv --without-pip /tmp/lifecyclevenv
printf '%s  %s\n' \
  d31b5e35f103c7d7d7d75649ff93ba2786e0113fb49197adf0480fd9a5552db5 \
  ci/code-c2/CODE_R10_X86_RUNTIME_REQUIREMENTS_R1.lock | sha256sum -c -
env -i HOME="$HOME" PATH=/usr/bin:/bin "$UV" --no-config pip install \
  --python /tmp/lifecyclevenv/bin/python \
  --require-hashes --no-deps --only-binary=:all: \
  -r ci/code-c2/CODE_R10_X86_RUNTIME_REQUIREMENTS_R1.lock
env -i HOME="$HOME" PATH=/usr/bin:/bin "$UV" --no-config pip check \
  --python /tmp/lifecyclevenv/bin/python
```

The runtime, its interpreter targets, installed packages, and parent directories must be readable/executable but not writable by the later fresh service account. The worker's runtime preflight enforces this and the exact distribution closure; no runtime dependency installation occurs during service startup.

## Native qualification command

The example assumes the two archive files are vendored to `ci/code-lifecycle/inputs/`. The output directory must not exist; its parent must exist and be canonical. The supervisor creates private root-owned receipt directories. Paths are passed as argv, and no token is placed in argv or the environment.

```bash
set -euo pipefail
sudo /usr/bin/python3 -B "$GITHUB_WORKSPACE/ci/code-lifecycle/supervise.py" run \
  --r14-archive "$GITHUB_WORKSPACE/ci/code-lifecycle/inputs/OMEGACODE_R13_SUCCESSOR_R1_4_P3_FOLLOWUP_REVIEW.zip" \
  --r152-archive "$GITHUB_WORKSPACE/ci/code-lifecycle/inputs/OMEGACODE_R13_SUCCESSOR_R1_5_2_TRACE_API_REVIEW.zip" \
  --python /tmp/lifecyclevenv/bin/python \
  --runtime-lock "$GITHUB_WORKSPACE/ci/code-c2/CODE_R10_X86_RUNTIME_REQUIREMENTS_R1.lock" \
  --output-dir /var/tmp/omegacode-lifecycle-receipts
```

Default cases are `full,refusal,timeout,sigterm,sigkill`, each using a distinct fresh locked `ocl<random>` account. `--cases full` is available for a first diagnostic pass, but does not qualify the omitted cancellation controls. A case failure stops the sequence and makes the command fail; absence of later receipts means those cases did not execute.

The `full` case installs R1.4 as the real `omegacode.service` user unit, checks anonymous 401/owner 200 and process/listener identity, stops and starts the unit, upgrades only after a cold matching-state snapshot, then restores that snapshot before starting R1.4 again. The final uninstall removes the unit while preserving state. All data and generated authority are synthetic and private; no provider or model is contacted.

The negative controls wait for `control-ready.json`, which the worker writes only after the real user service passes health. Refusal then fails deliberately; timeout waits for systemd's runtime bound; TERM/KILL target only the outer controller's main PID. A control that never reaches readiness cannot pass.

## Outer containment and budgets

The existing `ci/code-c2/containment.sh` remains a separate required gate. It proves startup-probe descendant containment in transient **system** units; a service started by `systemd --user` lives in another cgroup. This new supervisor therefore registers root-owned `ExecStopPost` cleanup before the worker enables linger or starts the fresh user manager. Account creation and immutable script preparation happen first but start no manager or service.

Each controller runs in a transient system unit under `system.slice`, with `KillMode=control-group` and `UMask=0077`. Runtime limits are 300 seconds for the full lifecycle, 90 seconds for the timeout control, and 180 seconds for the other controls. Controls must reach real service readiness within 60 seconds; missing readiness fails rather than qualifying a timeout that never exercised the service. The outer stop/cleanup budget is 30 seconds. The actual Code user unit retains its 10-second shutdown budget. Cleanup allows 15 seconds for the user manager stop, bounded login-manager calls, and up to five seconds for final UID-process disappearance. These are qualification-supervisor observation budgets, not changes to production policy.

Cleanup disables linger, stops the exact fresh `user@UID.service`, asks logind to terminate that exact user, and removes only the known synthetic unit link and its validated enablement link. It preserves the home, immutable packages, workspace/state, snapshots, and diagnostic receipts. It never deletes the user or state, signals an unrelated UID, or prints command stderr/configuration/credentials.

`ExecStopPost` is itself still in the outer cgroup, so `cleanup.json` records user/manager/listener cleanup and explicitly leaves `process_group_clean` false with a pending final observation. Once the cleanup process has exited, the supervisor writes `containment.json`; it sets `process_group_clean: true` only after independently observing the outer cgroup gone/empty, no fresh-UID processes, no 8724 listeners, an inactive user manager, and a valid successful cleanup receipt. `summary.json` requires both this result and the expected case terminal state. Missing or failed cleanup is a failed qualification.

The outer unit has no `RemainAfterExit`: every worker exit immediately invokes `ExecStopPost`, including success and a clean SIGTERM. Remaining active/exited would disable the runtime timer in Ubuntu 22.04's systemd and could leave the separate user service running if the supervisor died before issuing stop. Cleanup instead retains systemd's `SERVICE_RESULT`, `EXIT_CODE` and `EXIT_STATUS` as normalized terminal facts in its root-private, same-case receipt. It accepts those facts only while the immutable copied cleanup helper runs in this case's outer cgroup. This survives transient-unit garbage collection without keeping a successful unit active.

The supervisor reads those authenticated cleanup terminal facts after the outer unit becomes inactive, failed, or absent. A direct fallback cleanup explicitly has unknown terminal status even if its parent inherited similarly named environment variables; it cannot qualify a case. Full success requires worker success and exited/0; deliberate refusal requires the exact injected-refusal result and exited/2. SIGTERM requires the observed main-PID signal and killed/15, accepting systemd `Result=success` or `signal`. SIGKILL requires killed/9 and `Result=signal`. Timeout requires `Result=timeout` and observed service readiness.

Root supervisor SIGTERM/SIGINT stops the outer unit and awaits cleanup. If the supervisor itself is SIGKILLed, an already launched outer unit remains bounded by its runtime limit and owns its `ExecStopPost`. Before outer launch, no user manager has been started. A runner VM being discarded is not an observed successful cleanup receipt.

## Receipt collection

Upload only the small reviewed JSON receipt tree, not the per-case homes, context, runtime, logs, state, tokens, or archive payloads. The receipt output is root-private. Copy it to the runner's artifact directory only after the native command has terminated, using a separate CI step with `if: always()`:

```bash
set -euo pipefail
mkdir -p lifecycle-receipts
if sudo test -d /var/tmp/omegacode-lifecycle-receipts; then
  sudo cp -a /var/tmp/omegacode-lifecycle-receipts/. lifecycle-receipts/
  sudo chown -R "$(id -u):$(id -g)" lifecycle-receipts
  find lifecycle-receipts -type d -exec chmod 0700 {} +
  find lifecycle-receipts -type f -exec chmod 0600 {} +
fi
```

Use `actions/upload-artifact` with `path: lifecycle-receipts/` and `if: always()`. Keep the step failure status; artifact collection must not convert a failed/missing qualification into a pass.

Expected per-case outer records are `supervisor-setup.json`, `cleanup.json`, `containment.json`, and `summary.json`, alongside the worker's numbered step receipts and `result.json`. Control cases additionally need `control-ready.json`. The top-level `supervisor.json` names requested/completed cases and distinguishes all-default-case success from a diagnostic subset. No raw secrets or environment dumps belong in these records.

## Scope still requiring separate evidence

This is fresh-user Code service lifecycle qualification, including a rollback exercise between the exact source packages. It does not establish the actual Hive host release guard, real relay/enrollment, first-app Workbench journey, Hive restart, host revocation/cancellation with active work, Hyperon worker qualification, R1.5.2 production selection, or production deployment. The unregistered idle synthetic state can establish zero active authority/work before uninstall, not demonstrate revocation against a running Hive host. Preserve those gates separately.
