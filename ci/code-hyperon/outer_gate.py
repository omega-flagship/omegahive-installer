#!/usr/bin/env python3
"""CI-only bounded system-unit wrapper; never a production installer or sandbox."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import time
import uuid


def command(argv, timeout=30, check=True):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"})
    if check and result.returncode:
        raise RuntimeError("outer_command_failed")
    if len(result.stdout) > 16384:
        raise RuntimeError("outer_command_output_limit")
    return result


def census(unit, base=Path("/sys/fs/cgroup/system.slice")):
    root = base / unit
    if not root.exists():
        return []
    found = set()
    for path in [root / "cgroup.procs", *root.rglob("*/cgroup.procs")]:
        try:
            found.update(int(value) for value in path.read_text().split())
        except FileNotFoundError:
            pass
    return sorted(found)


def main():
    parser = argparse.ArgumentParser()
    for name in ("source-archive", "wheel", "worker-python", "worker-root", "receipt"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--architecture", choices=("x86_64", "aarch64"), required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or platform.system() != "Linux" or platform.machine() != args.architecture:
        print('{"ok":false,"reason":"root_native_ci_required"}')
        return 2
    if not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
        print('{"ok":false,"reason":"cgroup_v2_required"}')
        return 2
    helper = Path(__file__).resolve().with_name("qualify_hyperon_worker.py")
    from qualify_hyperon_worker import validate_receipt_path, receipt_write
    unit = "omegacode-hyperon-" + uuid.uuid4().hex[:16] + ".service"
    outer_path = args.receipt.with_name(args.receipt.stem + "-outer.json")
    try:
        validate_receipt_path(args.receipt)
        validate_receipt_path(outer_path)
    except Exception:
        print('{"ok":false,"reason":"outer_receipt_admission_failed"}')
        return 2
    argv = ["/usr/bin/systemd-run", "--quiet", "--wait", "--unit=" + unit,
            "--property=Type=exec", "--property=KillMode=control-group", "--property=Slice=system.slice",
            "--property=RuntimeMaxSec=240", "--property=TimeoutStopSec=15", "--property=UMask=0077",
            "--property=WorkingDirectory=/", "--property=Environment=PYTHONNOUSERSITE=1",
            "--property=UnsetEnvironment=LD_PRELOAD LD_AUDIT PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT",
            "--property=StandardOutput=null", "--property=StandardError=null", "--",
            "/usr/bin/python3", "-B", str(helper)]
    for name in ("source_archive", "wheel", "worker_python", "worker_root", "receipt", "architecture"):
        argv += ["--" + name.replace("_", "-"), str(getattr(args, name))]
    status = None
    failure = None
    try:
        status = command(argv, timeout=280, check=False).returncode
    except Exception as error:
        failure = "outer_supervisor_timeout" if isinstance(error, subprocess.TimeoutExpired) else "outer_launch_or_wait_failed"
    finally:
        try:
            command(["/usr/bin/systemctl", "stop", unit], timeout=40, check=False)
        except Exception:
            failure = failure or "outer_stop_unconfirmed"
    try:
        deadline = time.monotonic() + 5
        while census(unit) and time.monotonic() < deadline:
            time.sleep(0.1)
        left = census(unit)
        facts = command(["/usr/bin/systemctl", "show", unit,
                         "--property=LoadState,ActiveState", "--no-pager"], check=False)
        if facts.returncode not in (0, 1):
            raise RuntimeError("outer_status_unavailable")
        state = dict(line.split("=", 1) for line in facts.stdout.decode().splitlines() if "=" in line)
        inactive = state.get("ActiveState") in ("inactive", "failed") or state.get("LoadState") == "not-found"
        clean = not left and inactive and failure is None
        report = {"schema": "omegacode-hyperon-linux-outer-cgroup-r1", "ok": clean and status == 0,
                  "architecture": args.architecture, "native_driver_exit_status": status, "failure": failure,
                  "remaining_pids": left, "controller_inactive": inactive, "outer_cgroup_clean": clean,
                  "forced_parent_termination_qualified": False, "production_activation": False}
        receipt_write(outer_path, report)
    except Exception:
        print('{"ok":false,"reason":"outer_observation_or_receipt_failed"}')
        return 1
    print(json.dumps({"ok": report["ok"], "outer_cgroup_clean": clean}, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
