# Extracted from helper.py to keep OmegaClaw membranes reviewable.
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = CORE_ROOT.parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", CORE_ROOT / "memory"))

def current_swipl_pid():
    import os
    current = os.getpid()
    ppid = os.getppid()
    candidates = []
    proc = pathlib.Path("/proc")
    if proc.exists():
        for child in proc.iterdir():
            if not child.name.isdigit():
                continue
            try:
                cmdline = (child / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="ignore")
                stat = (child / "stat").read_text(errors="ignore")
                parent = int(stat.split()[3])
            except Exception:
                continue
            if "swipl" not in cmdline or "run.metta" not in cmdline:
                continue
            pid = int(child.name)
            score = 0
            if pid == current:
                score += 100
            if pid == ppid:
                score += 50
            if str(OMEGACLAW_ROOT / "src" / "main.pl") in cmdline:
                score += 10
            candidates.append((score, pid))
    if candidates:
        return str(sorted(candidates, reverse=True)[0][1])
    return str(ppid)

def _reboot_note_path(path=None):
    return pathlib.Path(path) if path else MEMORY_DIR / "reboot_note.txt"

def _latest_reboot_line(path=None):
    note = _reboot_note_path(path)
    if not note.exists():
        return ""
    lines = [line.strip() for line in note.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("REBOOT-CHECK"):
            return line
    return ""

def prepare_reboot(reason=""):
    pid = current_swipl_pid()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    safe_reason = str(reason or "unspecified").replace("\n", " ").strip()
    trace = (
        f"REBOOT-CHECK | time {ts} | previous-swipl-pid {pid} | reason {safe_reason} | "
        "after restart run current-swipl-pid | if pid differs reboot succeeded | "
        "then run complete-reboot-check and resume stored goal"
    )
    note = _reboot_note_path()
    note.parent.mkdir(parents=True, exist_ok=True)
    with note.open("a", encoding="utf-8") as f:
        f.write(trace + "\n")
    return trace

def complete_reboot_check():
    line = _latest_reboot_line()
    if not line:
        return "NO-PENDING-REBOOT"
    match = re.search(r"previous-swipl-pid (\d+)", line)
    if not match:
        return "REBOOT-CHECK-MALFORMED"
    previous = match.group(1)
    current = current_swipl_pid()
    status = "REBOOT-SUCCESS" if current != previous else "REBOOT-NOT-DETECTED"
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    result = f"{status} | previous {previous} | current {current} | time {ts}"
    note = _reboot_note_path()
    with note.open("a", encoding="utf-8") as f:
        f.write(result + "\n")
    return result

def restart_omega(reason=""):
    previous = current_swipl_pid()
    trace = prepare_reboot(reason)

    def terminate_later(pid):
        time.sleep(1.0)
        try:
            os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError:
            return
        except Exception:
            try:
                subprocess.Popen(
                    [sys.executable, "-c", "import os,signal,sys,time; time.sleep(0.5); os.kill(int(sys.argv[1]), signal.SIGTERM)", str(pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except Exception:
                return

    threading.Thread(target=terminate_later, args=(previous,), daemon=True).start()
    return f"RESTART-SCHEDULED | previous-swipl-pid {previous} | {trace}"

def restart_self(reason=""):
    return restart_omega(reason)

def reboot_self(reason=""):
    previous = current_swipl_pid()
    trace = prepare_reboot(reason)
    if os.environ.get("OMEGACLAW_REBOOT_SELF_DRY_RUN") == "1":
        return f"REBOOT-SELF-DRY-RUN | previous-swipl-pid {previous} | command sudo -n /usr/sbin/reboot | {trace}"
    if subprocess.run(
        ["sudo", "-n", "true"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode != 0:
        restart_result = restart_omega(f"fallback process restart because sudo reboot unavailable: {reason}")
        return (
            f"REBOOT-SELF-SUDO-UNAVAILABLE | previous-swipl-pid {previous} | "
            f"fallback=restart-self | {restart_result}"
        )
    try:
        subprocess.Popen(
            ["sudo", "-n", "/usr/sbin/reboot"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        safe_error = str(exc).replace("\n", " ")
        return f"REBOOT-SELF-FAILED | previous-swipl-pid {previous} | error {safe_error} | {trace}"
    return f"REBOOT-SELF-SCHEDULED | previous-swipl-pid {previous} | command sudo -n /usr/sbin/reboot | {trace}"
