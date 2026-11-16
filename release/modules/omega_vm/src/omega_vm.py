"""QEMU membrane for the agent's tiny Linux workspace-device."""

from __future__ import annotations

import base64
import json
import os
import sys
import pathlib
import shutil
import subprocess
import tempfile
import time


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
STATE_DIR = CORE_ROOT / "memory" / "runtime" / "omega_vm"
INITRAMFS = STATE_DIR / "initramfs.cpio.gz"
TRACE_FILE = STATE_DIR / "trace.jsonl"
KERNEL_IMAGE = STATE_DIR / "Image"
DEFAULT_TIMEOUT = 25
MAX_COMMAND_CHARS = 500
MAX_OUTPUT_CHARS = 5000

# MeTTa import! may load this file by path; py-call addresses the stable name.
sys.modules.setdefault("omega_vm", sys.modules[__name__])


INIT_SCRIPT = """#!/bin/busybox sh
/bin/busybox --install -s /bin
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /tmp
printf 'OMEGA_VM_BOOTED\\n'
cmd_b64=""
for part in $(cat /proc/cmdline); do
  case "$part" in
    omega_cmd_b64=*) cmd_b64="${part#omega_cmd_b64=}" ;;
  esac
done
cmd="$(printf '%s' "$cmd_b64" | base64 -d 2>/dev/null)"
if [ -z "$cmd" ]; then
  cmd="uname -a"
fi
printf 'OMEGA_VM_COMMAND:%s\\n' "$cmd"
/bin/sh -c "$cmd"
rc=$?
printf 'OMEGA_VM_DONE:%s\\n' "$rc"
sync 2>/dev/null || true
poweroff -f 2>/dev/null || reboot -f 2>/dev/null || halt -f 2>/dev/null
"""


def _which(name: str) -> str | None:
    return shutil.which(name)


def _kernel_path() -> pathlib.Path | None:
    if KERNEL_IMAGE.exists():
        return KERNEL_IMAGE
    kernels = [path for path in sorted(pathlib.Path("/boot").glob("vmlinuz-*")) if os.access(path, os.R_OK)]
    return kernels[-1] if kernels else None


def _ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def _append_trace(event: str, **data) -> None:
    _ensure_state_dir()
    record = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **data}
    with TRACE_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def _read_trace_tail() -> str:
    try:
        lines = TRACE_FILE.read_text(encoding="utf-8").splitlines()[-5:]
    except FileNotFoundError:
        return "OMEGA-VM-TRACE empty"
    return "\n".join(lines) if lines else "OMEGA-VM-TRACE empty"


def _build_initramfs() -> pathlib.Path:
    _ensure_state_dir()
    busybox = _which("busybox")
    if not busybox:
        raise RuntimeError("busybox is not installed")
    if INITRAMFS.exists():
        return INITRAMFS
    with tempfile.TemporaryDirectory(prefix="omega-vm-initramfs-", dir=str(STATE_DIR)) as tmp:
        root = pathlib.Path(tmp) / "root"
        (root / "bin").mkdir(parents=True)
        for dirname in ("proc", "sys", "dev", "tmp"):
            (root / dirname).mkdir(parents=True, exist_ok=True)
        shutil.copy2(busybox, root / "bin" / "busybox")
        os.chmod(root / "bin" / "busybox", 0o755)
        (root / "init").write_text(INIT_SCRIPT, encoding="utf-8")
        os.chmod(root / "init", 0o755)
        command = "find . | cpio -o -H newc | gzip -9"
        with INITRAMFS.open("wb") as out:
            subprocess.run(command, cwd=str(root), shell=True, stdout=out, stderr=subprocess.PIPE, check=True)
    return INITRAMFS


def _backend_status() -> tuple[bool, str]:
    qemu = _which("qemu-system-aarch64")
    busybox = _which("busybox")
    cpio = _which("cpio")
    gzip = _which("gzip")
    kernel = _kernel_path()
    missing = []
    if not qemu:
        missing.append("qemu-system-aarch64")
    if not busybox:
        missing.append("busybox")
    if not cpio:
        missing.append("cpio")
    if not gzip:
        missing.append("gzip")
    if not kernel:
        missing.append("/boot/vmlinuz-*")
    if missing:
        return False, "missing " + ",".join(missing)
    return True, f"qemu={qemu} kernel={kernel} initramfs={INITRAMFS}"


def vm_status():
    ok, detail = _backend_status()
    state = "ready" if ok else "unavailable"
    return f"OMEGA-VM-STATUS {state} backend=qemu-aarch64 network=disabled disk=none {detail}"


def _qemu_command(command: str) -> list[str]:
    qemu = _which("qemu-system-aarch64")
    kernel = _kernel_path()
    initramfs = _build_initramfs()
    if not qemu or not kernel:
        raise RuntimeError(vm_status())
    encoded = base64.b64encode(command.encode("utf-8")).decode("ascii")
    append = f"console=ttyAMA0 rdinit=/init panic=-1 quiet loglevel=0 omega_cmd_b64={encoded}"
    return [
        qemu,
        "-machine", "virt",
        "-cpu", "max",
        "-m", "128M",
        "-nographic",
        "-no-reboot",
        "-nic", "none",
        "-kernel", str(kernel),
        "-initrd", str(initramfs),
        "-append", append,
    ]


def vm_shell(command, timeout=DEFAULT_TIMEOUT):
    command = str(command or "").strip() or "uname -a"
    if len(command) > MAX_COMMAND_CHARS:
        return f"OMEGA-VM-ERROR command-too-long max={MAX_COMMAND_CHARS}"
    ok, detail = _backend_status()
    if not ok:
        return f"OMEGA-VM-UNAVAILABLE {detail}"
    started = time.time()
    try:
        result = subprocess.run(
            _qemu_command(command),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=int(timeout),
        )
        output = result.stdout or ""
        rc = _extract_guest_rc(output)
        elapsed = round(time.time() - started, 3)
        _append_trace("OmegaVMCommandRan", command=command, qemu_rc=result.returncode, guest_rc=rc, elapsed_seconds=elapsed)
        tail = output[-MAX_OUTPUT_CHARS:]
        return f"OMEGA-VM-RAN guest_rc={rc} qemu_rc={result.returncode} seconds={elapsed}\n{tail}"
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        _append_trace("OmegaVMCommandTimedOut", command=command, timeout_seconds=int(timeout))
        return f"OMEGA-VM-TIMEOUT seconds={int(timeout)}\n{output[-MAX_OUTPUT_CHARS:]}"
    except Exception as exc:
        _append_trace("OmegaVMCommandFailed", command=command, error=str(exc))
        return f"OMEGA-VM-ERROR {type(exc).__name__}: {exc}"


def _extract_guest_rc(output: str) -> str:
    marker = "OMEGA_VM_DONE:"
    for line in reversed(str(output or "").splitlines()):
        if marker in line:
            return line.split(marker, 1)[1].strip()
    return "unknown"


def vm_boot():
    result = vm_shell("uname -a")
    if result.startswith("OMEGA-VM-RAN"):
        _append_trace("OmegaVMBooted", command="uname -a")
    return result


def vm_last_trace():
    return _read_trace_tail()
