# Hyperon worker native CI admission

Prepared controller/native-case code is a separate candidate. Verify the delivered external ZIP/manifest seals and all members before executing it. Do not invoke `native_cases.py` alone as acceptance: the parent performs the wheel/install/source admission checks.

Dot selects the actual architecture lane. The first server target is x86_64 Ubuntu22.04; the aarch64 lock is a separate future/native lane and has no inherited x86 qualification. Existing Mac resident-session cancellation stays unchanged.

## Provision the worker in the disposable lane

1. Provision the exact reviewed architecture-specific PBS CPython3.12.16 and uv artifacts using the installer's publisher-hash pins. This packet does not substitute a system interpreter or download a runtime on the service's behalf.
2. Choose the wheel filename, URL and SHA from `INPUT_PINS.json` for the actual architecture; download only that wheel into `/tmp/hyperon-wheels/` inside admitted CI and verify SHA256 before installation.
3. Create a separate bare venv with the pinned base, and install only the matching lock from the local verified wheel directory. For x86_64, after the publisher pins are verified:

```bash
umask 022
/tmp/py/python/bin/python3.12 -m venv --without-pip /tmp/hyperon-worker
env -i HOME="$HOME" PATH=/usr/bin:/bin "$UV" --no-config pip install \
  --python /tmp/hyperon-worker/bin/python --no-index --find-links /tmp/hyperon-wheels \
  --require-hashes --no-deps --only-binary=:all: -r ci/code-hyperon/worker-x86_64.lock
env -i HOME="$HOME" PATH=/usr/bin:/bin "$UV" --no-config pip check \
  --python /tmp/hyperon-worker/bin/python
sudo chown -R root:root /tmp/py /tmp/hyperon-worker
sudo chmod -R a+rX,a-w /tmp/py /tmp/hyperon-worker
```

Use an empty wheel directory with only the verified architecture wheel. The driver rechecks actual wheel and installed METADATA/RECORD; no dev extras or HTTP service packages belong in this venv. If metadata introduces an active unpinned dependency, stop and prepare a new reviewed lock rather than adding an ambient package.

Copy the sealed controller packet to its own root-owned read-only location such as `/opt/code-hyperon-acceptance/`. Keep it separate from the writable checkout and from receipts. Supply the exact R1.4 ZIP as a read-only input. No config, key, token, host enrollment or provider credential is used.

## Execute inside the existing outer containment authority

Use a dedicated transient system unit/cgroup, `Type=exec`, `KillMode=control-group`, a finite `RuntimeMaxSec`/stop budget, no `RemainAfterExit`, and an independent post-stop descendant census. Invoke the parent with the exact flags documented by its CLI, including the source archive, local wheel, worker root/Python, architecture and receipt destination. The selected source adapter starts a new process session for each helper, so killing only the controller's process group cannot establish total cleanup.

The driver must refuse a missing/root/ambiguous cgroup instead of assuming ordinary process-group cleanup is the outer gate. A positive receipt can establish its completed checks and observed ordinary cleanup; qualify refusal, timeout and forced termination under the lane's external cgroup controls before relying on interrupted-run cleanup. Preserve those results separately from the parser/query receipt.

`outer_gate.py` supplies a bounded positive-run wrapper: it runs the parent inside a dedicated transient system unit, waits for termination, stops that exact unit and independently checks its cgroup is empty. Its companion outer receipt explicitly leaves forced-termination qualification false. Example for the admitted x86 lane after copying this reviewed packet to `/opt/code-hyperon-acceptance/` as root-owned read-only text:

```bash
sudo install -d -m 0700 /var/tmp/code-hyperon-receipts
sudo /usr/bin/python3 -B /opt/code-hyperon-acceptance/outer_gate.py \
  --source-archive "$GITHUB_WORKSPACE/ci/code-hyperon/inputs/OMEGACODE_R13_SUCCESSOR_R1_4_P3_FOLLOWUP_REVIEW.zip" \
  --wheel /tmp/hyperon-wheels/hyperon-0.2.10-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl \
  --worker-python /tmp/hyperon-worker/bin/python \
  --worker-root /tmp/hyperon-worker \
  --architecture x86_64 \
  --receipt /var/tmp/code-hyperon-receipts/native-x86_64.json
```

Both destination receipts must be absent before the command; do not overwrite a previous result. The wrapper has a 240-second systemd runtime bound, 15-second stop budget and no `RemainAfterExit`. Its parent wait is bounded too. It is a qualification controller in disposable CI, not a root Code API or a production worker profile.

The exact default command and admitted cgroup/controller source must be recorded alongside the CI run/job/commit. Dot owns wiring it into the selected lane; this source delivery does not start a CI run or alter the installer/mac-native lane.

## Collect

Collect only the explicit bounded JSON receipt, the selected source/worker pins, and sanitized outer cleanup evidence. Preserve failure codes/stages; do not upload ephemeral source maps, marker fixture paths, runtime trees, stderr dumps, wheel payloads, home directories or private stores. No production action is enabled solely because this component passes.
