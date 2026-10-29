# OmegaCode Linux lifecycle qualification R1.1

R1.1 follows Dot's native run2 (`40860075434`, source `ca708cb`), which passed through step 14 and failed before 15 with an unclassified exception. `systemctl disable` removes manually created links to the unit as well as enablement links; R1's unconditional second unlink could therefore raise FileNotFoundError. R1.1 validates the installed link before disable and treats its removal by systemd as success, removing only an exact matching link if one remains. Unexpected failures now record a safe phase, constant code, exception type and errno, never the exception message. The earlier partial native run is not full qualification; rerun all five cases.

Prepared for Dot's assignment `coordination/inbox/20261029T101733Z-dot-to-omegacode-checkin-next-linux-lifecycle.md`. This text bundle supplies runnable qualification code and receipt expectations for the existing installer-repo `code-c2` CI job. Native execution and review disposition remain pending. Use invented, disposable state only.

## Inputs and authority

The runner requires x86_64 Linux, root access to create a fresh locked test account, systemd as PID 1, a working user manager/bus and linger, cgroup v2 and readable procfs. It refuses an occupied port 8724. Root controls are confined to fresh test accounts and their generated units. Never use an existing person/Hive account or a production host.

Two package files are supplied separately; neither is embedded in this text bundle:

| Input | Archive SHA-256 | Package module digest | ZIP package prefix |
| --- | --- | --- | --- |
| R1.4 `OMEGACODE_R13_SUCCESSOR_R1_4_P3_FOLLOWUP_REVIEW.zip` | `c7478c1e88ed5fd777890196d572cf347c3a38240810b3911836081c8674fea1` | `4a5737b1296bcb49ff44a002684129c18e95a749d8ce3362cd97df18953b449d` (91 modules) | `src/omegacode/` |
| R1.5.2 `OMEGACODE_R13_SUCCESSOR_R1_5_2_TRACE_API_REVIEW.zip` | `c6f0e7c2380fee230ee8081e097a231d7c7d731afec82ff24ae86041637638f1` | `892f333ee430c5f10a9985f97109e1fa511b1fa020a925de9c49ac73ed64387d` (92 modules) | `source/src/omegacode/` |

The reviewed 17-package lock SHA-256 is `d31b5e35f103c7d7d7d75649ff93ba2786e0113fb49197adf0480fd9a5552db5`. The CI lane must first provision the hash-pinned PBS CPython 3.12.16 and install that exact closure using `--require-hashes --no-deps --only-binary=:all:`. Use a bare CPython venv without pip/bootstrap `.pth` hooks. `CI_INTEGRATION.md` gives the exact commands. The script checks the lock, version, installed distribution/RECORD bytes, startup-hook absence and service-UID write permissions; it does not replace the CI download/provisioning gate.

## Invocation

First verify the text bundle with `sha256sum --strict --check MANIFEST.sha256`. Then, inside the admitted existing CI lane, run:

```bash
sudo /usr/bin/python3 -B ci/code-lifecycle/supervise.py run \
  --r14-archive "$R14_ARCHIVE" \
  --r152-archive "$R152_ARCHIVE" \
  --python /tmp/lifecyclevenv/bin/python \
  --runtime-lock "$PWD/ci/code-c2/CODE_R10_X86_RUNTIME_REQUIREMENTS_R1.lock" \
  --output-dir /tmp/code-lifecycle-receipts
```

The input variables name the exact two locally vendored packages above; they are not downloaded by the qualification scripts. Default cases include full lifecycle, refusal, timeout, SIGTERM and SIGKILL. Keep the existing direct-probe containment job unchanged and require its result alongside the added user-manager cleanup gate. Never treat one as evidence for the other.

## What the full case measures

1. Verify both archive hashes, extract their different package prefixes into immutable `releases/<digest>/omegacode/`, and recompute the package-root module digest.
2. Verify the pinned runtime and fresh user manager/linger. Install the real `omegacode.service` user unit. Run `systemd-analyze --user verify` before enabling it.
3. Start R1.4. Require anonymous `/v1/capabilities` to return 401 and owner authentication to return 200 with service identity `omegacode`. Capture UID, MainPID/start-time, executable, argv, cwd, exact PYTHONPATH, immutable module digest, cgroup and sole listener/socket ownership. The listener must be exactly `127.0.0.1:8724`.
4. Stop, prove service cgroup/process/listener absence, then start again and require a new process identity and successful health.
5. Stop again and verify idle, unregistered synthetic state. Create a complete cold state copy, including any SQLite WAL/SHM and CAS files; compare the full inventory and check SQLite integrity while stopped. This is a qualification fixture procedure, not a production backup API.
6. Atomically switch a root-owned activation pointer containing the unit and its pin, start R1.5.2, and prove its measured release digest and health.
7. Stop R1.5.2. Retain its state for diagnostics and restore the matching pre-upgrade R1.4 state before starting R1.4. A deliberately newer-only synthetic marker must disappear from restored state and remain in retained newer state. Check restored inventory and SQLite integrity, switch back, then measure R1.4 identity and health.
8. Quiesce, verify zero registration, grants and owned records, disable/remove the user unit and verify it is not found, verify no Code process/listener, and compare the retained state inventory. Preserve all service/workspace data, the snapshot and the newer diagnostic state. Nothing removes these state directories.

`process_group_clean` is derived after stop/cleanup; it is not supplied by the capabilities API. Loaded-release evidence combines measured process argv/environment/cwd, the runtime's import-origin check and the read-only package digest. It is not a new self-reported service endpoint or a production Hive guard result.

## Failure containment

User services run under `user@<uid>.service`, outside the existing direct-probe transient system unit. The supervisor therefore installs a separate bounded transient system controller whose root-owned `ExecStopPost` stops the fresh user manager and verifies the fresh UID and port. It runs on normal completion, refusal, timeout and forced termination, including SIGKILL of the controller main process. The parent independently verifies that the controller cgroup is empty after cleanup; cleanup itself cannot claim its own cgroup is already empty.

Each control waits for a healthy user service before its failure is injected. If readiness was never reached, the control is a failure, not a containment pass. Missing proc/cgroup/user-manager evidence fails the gate. The fresh account stays locked and its state stays private until the disposable CI runner is destroyed.

## Evidence limits and collection

`EXPECTED_RECEIPTS.json` is a specification, not evidence from a run. Upload only the explicit small JSON receipt output directory after checking the supervisor's terminal status. Do not upload the generated home, config, operator-token file, SQLite/CAS state, runtime, journals or arbitrary command logs. Credentials are generated locally and are absent from unit text, argv, receipts and stdout.

This experiment starts no provider/model worker and calls no Hive endpoint. It deliberately refuses any fixture with enrollment material, local grants or owned records before uninstall. Thus uninstall proves removal and state retention for an unregistered idle synthetic fixture; host registration/grant revocation and work cancellation with active work remain separate untested gates. This bundle also does not qualify the production host release guard, proved relay, Workbench journey, independent Hive restart, Hyperon worker, ARM Linux or macOS. Lifecycle use of R1.5.2 is isolated CI qualification and does not lift Dot's production staging hold.
