#!/usr/bin/python3
"""Root-only CI supervisor for fresh-user OmegaCode lifecycle qualification.

Only standard-library dependencies. Never executes on a non-Linux/non-x86_64 host.
The controller's system unit and the distinct user's manager are independent
cgroups; ExecStopPost closes the latter even if the controller is SIGKILLed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid


CASES = ("full", "refusal", "timeout", "sigterm", "sigkill")
MAX_JSON = 64 * 1024
SYSTEMCTL = "/usr/bin/systemctl"
LOGINCTL = "/usr/bin/loginctl"
_interrupted = False


class Refusal(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def need(condition: bool, code: str) -> None:
    if not condition:
        raise Refusal(code)


def command(argv: list[str], *, seconds: float = 10, check: bool = True) -> subprocess.CompletedProcess:
    """Capture bounded command facts only; never print stdout/stderr on failure."""
    try:
        result = subprocess.run(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=seconds, check=False,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
        )
    except subprocess.TimeoutExpired:
        raise Refusal("command_timeout") from None
    except OSError:
        raise Refusal("command_unavailable") from None
    need(len(result.stdout) <= MAX_JSON, "command_output_limit")
    if check:
        need(result.returncode == 0, "command_failed")
    return result


def root_private_directory(path: Path) -> None:
    need(path.is_absolute() and path.resolve() == path, "directory_not_canonical")
    st = path.lstat()
    need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0, "directory_owner_or_kind")
    need(stat.S_IMODE(st.st_mode) == 0o700, "directory_not_private")


def write_json(path: Path, value: dict) -> None:
    """Receipts are root-private and atomically replaced without following links."""
    root_private_directory(path.parent)
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    need(len(data) <= MAX_JSON, "receipt_limit")
    temporary = path.parent / ("." + path.name + "." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(path: Path) -> dict:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0, "json_owner_or_kind")
        need(stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= MAX_JSON, "json_mode_or_size")
        data = handle.read(MAX_JSON + 1)
    need(len(data) <= MAX_JSON, "json_size")
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise Refusal("json_invalid") from None
    need(isinstance(value, dict), "json_not_object")
    return value


def properties(unit: str, *, seconds: float = 10) -> dict[str, str]:
    result = command([SYSTEMCTL, "show", unit, "--no-pager",
                      "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,MainPID,ControlGroup"],
                     seconds=seconds, check=False)
    need(result.returncode in (0, 1), "unit_status_failed")
    parsed = {}
    for line in result.stdout.decode("utf-8", "strict").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            parsed[key] = value
    need("LoadState" in parsed, "unit_status_missing")
    return parsed


def listeners_8724() -> list[dict]:
    found = []
    for filename, family in (("/proc/net/tcp", "ipv4"), ("/proc/net/tcp6", "ipv6")):
        try:
            lines = Path(filename).read_text().splitlines()[1:]
        except OSError:
            raise Refusal("listener_census_unavailable") from None
        for line in lines:
            fields = line.split()
            need(len(fields) >= 10, "listener_census_invalid")
            local, state = fields[1], fields[3]
            if local.rsplit(":", 1)[-1].upper() == "2214" and state == "0A":
                found.append({"family": family, "inode": int(fields[9])})
    return found


def uid_processes(uid: int) -> list[int]:
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            # /proc directory ownership can become root when dumpability
            # changes. Read the kernel's real/effective/saved/fs UID facts.
            lines = (entry / "status").read_text().splitlines()
            row = next((line for line in lines if line.startswith("Uid:")), None)
            need(row is not None, "uid_process_census_invalid")
            values = [int(value) for value in row.split()[1:]]
            need(len(values) == 4, "uid_process_census_invalid")
            if uid in values:
                found.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
        except OSError:
            raise Refusal("uid_process_census_unavailable") from None
    return sorted(found)


def cgroup_processes(unit: str) -> list[int]:
    need(re.fullmatch(r"omegacode-lifecycle-[0-9a-f]{16}\.service", unit) is not None, "outer_unit_invalid")
    # Slice=system.slice is fixed in the launch. Do not mistake an empty
    # ControlGroup property on a dead unit for an empty live cgroup.
    root = Path("/sys/fs/cgroup/system.slice") / unit
    if not root.exists():
        return []
    found = set()
    for entry in [root / "cgroup.procs", *root.rglob("*/cgroup.procs")]:
        try:
            found.update(int(v) for v in entry.read_text().split())
        except FileNotFoundError:
            pass
        except (ValueError, OSError):
            raise Refusal("outer_cgroup_census_unavailable") from None
    return sorted(found)


def validate_context(path: Path) -> dict:
    need(path.is_absolute() and path.resolve() == path, "context_not_canonical")
    context = read_json(path)
    case_id = context.get("case_id")
    need(isinstance(case_id, str) and re.fullmatch(r"[0-9a-f]{32}", case_id) is not None, "case_id_invalid")
    need(context.get("case") in CASES, "case_invalid")
    user = context.get("user")
    need(user == "ocl" + case_id[:12], "user_identity_invalid")
    work_root = Path("/var/tmp") / ("omegacode-lifecycle-" + case_id)
    need(context.get("work_root") == str(work_root), "work_root_invalid")
    need(path == work_root / "context.json", "context_location_invalid")
    info = work_root.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o755,
         "work_root_owner_or_mode")
    need(context.get("home") == str(work_root / "home"), "home_invalid")
    need(context.get("outer_unit") == "omegacode-lifecycle-" + case_id[:16] + ".service", "outer_unit_invalid")
    uid, gid = context.get("uid"), context.get("gid")
    need(type(uid) is int and type(gid) is int and uid >= 1000 and gid >= 1000, "uid_gid_invalid")
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        raise Refusal("fresh_account_missing") from None
    need((account.pw_uid, account.pw_gid, account.pw_dir) == (uid, gid, context["home"]), "account_identity_changed")
    root_private_directory(Path(context["receipts"]))
    return context


def remove_unit_file(context: dict) -> None:
    user_root = Path(context["home"]) / ".config/systemd/user"
    # Only the exact synthetic unit and its enablement link may be removed.
    # Never follow a substituted directory or remove any workspace/state.
    for path in (Path(context["home"]) / ".config", Path(context["home"]) / ".config/systemd", user_root):
        if path.exists() or path.is_symlink():
            info = path.lstat()
            need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, context["uid"]), "unit_directory_invalid")
    unit = user_root / "omegacode.service"
    work_root = Path(context["work_root"])
    active_unit = work_root / "active/omegacode.service"
    if unit.exists() or unit.is_symlink():
        info = unit.lstat()
        need(info.st_uid in (0, context["uid"]), "unit_file_owner_invalid")
        need(stat.S_ISLNK(info.st_mode) and os.readlink(unit) == str(active_unit), "unit_file_target_invalid")
    wants = user_root / "default.target.wants"
    if wants.exists() or wants.is_symlink():
        info = wants.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, context["uid"]), "wants_directory_invalid")
        link = wants / "omegacode.service"
        if link.exists() or link.is_symlink():
            need(link.is_symlink(), "enablement_link_invalid")
            raw = os.readlink(link)
            # systemctl may retain the installed unit path or resolve its
            # activation target. Normalize syntax without following any link.
            target = os.path.normpath(raw if os.path.isabs(raw) else str(link.parent / raw))
            allowed = {str(unit), str(active_unit),
                       str(work_root / "activation-r14/omegacode.service"),
                       str(work_root / "activation-r152/omegacode.service")}
            need(target in allowed, "enablement_link_target_invalid")
            link.unlink()
    if unit.exists() or unit.is_symlink():
        unit.unlink()


def normalize_systemd_terminal(environment: dict) -> dict:
    """Normalize only complete, recognized ExecStopPost exit facts.

    systemd supplies signal names (TERM/KILL) for killed processes, while
    ExecMainStatus uses the signal number. Unknown/missing data stays unknown.
    """
    result = environment.get("SERVICE_RESULT")
    code = environment.get("EXIT_CODE")
    status = environment.get("EXIT_STATUS")
    results = {"success", "exit-code", "signal", "core-dump", "timeout", "watchdog",
               "start-limit-hit", "resources", "protocol", "exec-condition", "oom-kill"}
    codes = {"exited": "1", "killed": "2", "dumped": "3"}
    if result not in results or code not in codes or not isinstance(status, str):
        return {}
    if code == "exited":
        if not status.isdecimal() or not 0 <= int(status) <= 255:
            return {}
        normalized = str(int(status))
    else:
        name = status if status.startswith("SIG") else "SIG" + status
        number = int(status) if status.isdecimal() else getattr(signal, name, None)
        if not isinstance(number, int) or not 1 <= number < signal.NSIG:
            return {}
        normalized = str(int(number))
    return {"Result": result, "ExecMainCode": codes[code], "ExecMainStatus": normalized}


def cleanup(path: Path, *, from_exec_stop_post: bool = False) -> int:
    context = validate_context(path)
    errors = []
    terminal = {}
    terminal_source = "unknown_direct_fallback"
    if from_exec_stop_post:
        # The privileged fallback can inherit unrelated SERVICE_RESULT values.
        # Only the immutable copied helper actually running in this case's
        # outer unit may retain systemd's exit environment as terminal evidence.
        try:
            helper = Path(context["work_root"]) / "bundle/supervise.py"
            in_outer = os.getpid() in cgroup_processes(context["outer_unit"])
            if Path(__file__).resolve() == helper and in_outer:
                terminal = normalize_systemd_terminal(os.environ)
                terminal_source = "systemd_execstoppost_environment" if terminal else "unknown_systemd_exit_facts"
            else:
                terminal_source = "unknown_not_in_case_execstoppost"
        except (Refusal, OSError):
            terminal_source = "unknown_execstoppost_identity"
    # Each privileged operation is restricted to the context's freshly created
    # account. No user deletion, home removal or UID-wide blind signal is used.
    for argv, seconds in (
        ([LOGINCTL, "disable-linger", context["user"]], 2),
        ([SYSTEMCTL, "stop", "user@%d.service" % context["uid"]], 15),
        ([LOGINCTL, "terminate-user", context["user"]], 2),
    ):
        try:
            command(argv, seconds=seconds, check=False)
        except Refusal as exc:
            errors.append(exc.code)
    try:
        remove_unit_file(context)
    except (Refusal, OSError) as exc:
        errors.append(exc.code if isinstance(exc, Refusal) else "unit_removal_failed")
    try:
        # Allow the inner Code unit's reviewed 10-second stop budget to finish
        # before the outer cleanup observation. The outer unit grants 30s to
        # ExecStopPost; this loop is bounded independently.
        deadline = time.monotonic() + 5
        while True:
            left = uid_processes(context["uid"])
            if not left or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        manager = properties("user@%d.service" % context["uid"], seconds=2)
        manager_inactive = manager.get("ActiveState") in ("inactive", "failed") or manager.get("LoadState") == "not-found"
        left = uid_processes(context["uid"])
        listeners = listeners_8724()
        outer_left = cgroup_processes(context["outer_unit"])
        outer_noncleanup = [pid for pid in outer_left if pid != os.getpid()]
        linger = Path("/var/lib/systemd/linger") / context["user"]
        linger_disabled = not linger.exists() and not linger.is_symlink()
        unit_path = Path(context["home"]) / ".config/systemd/user/omegacode.service"
        unit_absent = not unit_path.exists() and not unit_path.is_symlink()
        ok = not errors and manager_inactive and not left and not listeners and not outer_noncleanup and linger_disabled and unit_absent
        receipt = {
            "schema": "omegacode-linux-lifecycle-cleanup-v1", "case": context["case"],
            "case_id": context["case_id"], "ok": ok, "error_codes": errors,
            "user_manager_inactive": manager_inactive, "uid_processes": left,
            "listeners_8724": listeners, "linger_disabled": linger_disabled,
            "unit_file_absent": unit_absent, "home_preserved": Path(context["home"]).is_dir(),
            "outer_noncleanup_pids": outer_noncleanup, "outer_cleanup_pid": os.getpid(),
            "terminal": terminal, "terminal_source": terminal_source,
            "process_group_clean": False,
            "pending_observation": "supervisor checks empty outer cgroup after ExecStopPost exits",
        }
    except (Refusal, OSError, ValueError) as exc:
        receipt = {"schema": "omegacode-linux-lifecycle-cleanup-v1", "case": context["case"],
                   "case_id": context["case_id"], "ok": False, "process_group_clean": False,
                   "terminal": terminal, "terminal_source": terminal_source,
                   "error_codes": errors + [exc.code if isinstance(exc, Refusal) else "cleanup_observation_failed"]}
    write_json(Path(context["receipts"]) / "cleanup.json", receipt)
    return 0 if receipt["ok"] else 1


def new_context(args: argparse.Namespace, case: str, output: Path) -> tuple[Path, dict]:
    case_id = uuid.uuid4().hex
    user = "ocl" + case_id[:12]
    work_root = Path("/var/tmp") / ("omegacode-lifecycle-" + case_id)
    work_root.mkdir(mode=0o755)
    os.chmod(work_root, 0o755)
    home = work_root / "home"
    home.mkdir(mode=0o700)
    receipts = output / case
    receipts.mkdir(mode=0o700)
    command(["/usr/sbin/useradd", "--no-create-home", "--user-group", "--home-dir", str(home),
             "--shell", "/usr/sbin/nologin", "--password", "!", user])
    account = pwd.getpwnam(user)
    need(account.pw_uid >= 1000 and account.pw_gid >= 1000, "fresh_account_uid_invalid")
    os.chown(home, account.pw_uid, account.pw_gid)
    context = {"case": case, "case_id": case_id, "user": user, "uid": account.pw_uid, "gid": account.pw_gid,
               "home": str(home), "receipts": str(receipts), "python": str(args.python),
               "r14_archive": str(args.r14_archive), "r152_archive": str(args.r152_archive),
               "runtime_lock": str(args.runtime_lock), "work_root": str(work_root),
               "outer_unit": "omegacode-lifecycle-" + case_id[:16] + ".service"}
    # Context lives under root-owned 0755 traversal, so writing it needs an
    # explicit 0600 open rather than the receipt directory helper.
    path = work_root / "context.json"
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(context, handle, sort_keys=True)
        handle.write("\n")
    return path, context


def prepare(context: dict) -> Path:
    target = Path(context["work_root"]) / "bundle"
    target.mkdir(mode=0o755)
    source_root = Path(__file__).resolve().parent
    for filename in ("supervise.py", "lifecycle_worker.py", "runtime_preflight.py"):
        source = source_root / filename
        need(source.is_file() and not source.is_symlink(), "bundle_source_missing")
        shutil.copyfile(source, target / filename)
        os.chmod(target / filename, 0o444)
    os.chmod(target, 0o555)
    write_json(Path(context["receipts"]) / "supervisor-setup.json", {
        "schema": "omegacode-linux-lifecycle-setup-v1", "case": context["case"],
        "case_id": context["case_id"], "ok": True, "uid": context["uid"],
        "user": context["user"], "user_manager_started": False,
        "manager_activation_owner": "worker inside outer unit after ExecStopPost registration",
        "home_private": stat.S_IMODE(Path(context["home"]).stat().st_mode) == 0o700,
    })
    return target


def start_outer(context: dict, path: Path, bundle: Path) -> None:
    maximum = 300 if context["case"] == "full" else (90 if context["case"] == "timeout" else 180)
    stop_command = "/usr/bin/python3 -B %s cleanup --context %s" % (bundle / "supervise.py", path)
    command(["/usr/bin/systemd-run", "--quiet", "--unit=" + context["outer_unit"],
             "--property=Type=exec", "--property=Slice=system.slice",
             "--property=RuntimeMaxSec=%d" % maximum, "--property=KillMode=control-group",
             "--property=TimeoutStopSec=30", "--property=UMask=0077", "--property=WorkingDirectory=/",
             "--property=Environment=PYTHONNOUSERSITE=1 PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C",
             "--property=UnsetEnvironment=LD_PRELOAD LD_AUDIT PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT",
             "--property=StandardOutput=null", "--property=StandardError=null",
             "--property=ExecStopPost=" + stop_command, "--",
             "/usr/bin/python3", "-B", str(bundle / "lifecycle_worker.py"), "--context", str(path)])


def stop_outer(unit: str) -> None:
    command([SYSTEMCTL, "stop", unit], seconds=40, check=False)


def watch(context: dict) -> dict:
    global _interrupted
    start = time.monotonic()
    ready = False
    signalled = False
    terminal = {}
    receipts = Path(context["receipts"])
    observation_limit = 360 if context["case"] == "full" else 240
    while time.monotonic() - start < observation_limit:
        if _interrupted:
            stop_outer(context["outer_unit"])
            raise Refusal("supervisor_interrupted")
        facts = properties(context["outer_unit"])
        marker = receipts / "control-ready.json"
        if marker.exists():
            read_json(marker)
            ready = True
        if context["case"] != "full" and not ready and time.monotonic() - start >= 60:
            stop_outer(context["outer_unit"])
            raise Refusal("control_readiness_deadline")
        if context["case"] in ("sigterm", "sigkill") and ready and not signalled:
            need(facts.get("ActiveState") == "active" and facts.get("SubState") == "running"
                 and int(facts.get("MainPID", "0")) > 0, "control_target_not_live")
            signal_name = "TERM" if context["case"] == "sigterm" else "KILL"
            command([SYSTEMCTL, "kill", "--kill-who=main", "--signal=" + signal_name, context["outer_unit"]])
            signalled = True
        if facts.get("ActiveState") in ("inactive", "failed") or facts.get("LoadState") == "not-found":
            cleanup_path = receipts / "cleanup.json"
            if cleanup_path.exists():
                post = read_json(cleanup_path)
                need(post.get("schema") == "omegacode-linux-lifecycle-cleanup-v1"
                     and post.get("case_id") == context["case_id"] and post.get("case") == context["case"],
                     "cleanup_identity_mismatch")
                if post.get("terminal_source") == "systemd_execstoppost_environment":
                    value = post.get("terminal")
                    need(isinstance(value, dict), "cleanup_terminal_invalid")
                    terminal = value
            break
        time.sleep(0.1)
    else:
        stop_outer(context["outer_unit"])
        raise Refusal("supervisor_observation_deadline")
    return {"control_ready_observed": ready, "signal_sent": signalled, "terminal": terminal}


def final_containment(context: dict) -> dict:
    errors = []
    try:
        cleanup_receipt = read_json(Path(context["receipts"]) / "cleanup.json")
        need(cleanup_receipt.get("schema") == "omegacode-linux-lifecycle-cleanup-v1"
             and cleanup_receipt.get("case_id") == context["case_id"]
             and cleanup_receipt.get("case") == context["case"], "cleanup_identity_mismatch")
        cleanup_ok = cleanup_receipt.get("ok") is True
    except (Refusal, OSError):
        cleanup_ok = False
        errors.append("cleanup_receipt_missing_or_invalid")
    try:
        outer = cgroup_processes(context["outer_unit"])
        left = uid_processes(context["uid"])
        listeners = listeners_8724()
        manager = properties("user@%d.service" % context["uid"])
        outer_status = properties(context["outer_unit"])
        manager_inactive = manager.get("ActiveState") in ("inactive", "failed") or manager.get("LoadState") == "not-found"
        controller_inactive = outer_status.get("ActiveState") in ("inactive", "failed") or outer_status.get("LoadState") == "not-found"
        clean = cleanup_ok and not outer and not left and not listeners and manager_inactive and controller_inactive
        result = {"schema": "omegacode-linux-lifecycle-containment-v1", "case": context["case"],
                  "case_id": context["case_id"], "ok": clean, "process_group_clean": clean,
                  "cleanup_ok": cleanup_ok, "outer_cgroup_pids": outer, "uid_processes": left,
                  "listeners_8724": listeners, "user_manager_inactive": manager_inactive,
                  "controller_inactive": controller_inactive, "error_codes": errors}
    except (Refusal, OSError, ValueError) as exc:
        result = {"schema": "omegacode-linux-lifecycle-containment-v1", "case": context["case"],
                  "case_id": context["case_id"], "ok": False, "process_group_clean": False,
                  "error_codes": errors + [exc.code if isinstance(exc, Refusal) else "containment_observation_failed"]}
    write_json(Path(context["receipts"]) / "containment.json", result)
    return result


def expected_result(context: dict, observation: dict) -> bool:
    case = context["case"]
    terminal = observation.get("terminal", {})
    if case == "full":
        try:
            result = read_json(Path(context["receipts"]) / "result.json")
        except (Refusal, OSError):
            return False
        return (result.get("ok") is True and terminal.get("ExecMainCode") == "1"
                and terminal.get("ExecMainStatus") == "0" and terminal.get("Result") == "success")
    if not observation.get("control_ready_observed"):
        return False
    if case == "refusal":
        try:
            result = read_json(Path(context["receipts"]) / "result.json")
        except (Refusal, OSError):
            return False
        return (result.get("reason") == "injected_refusal" and result.get("ok") is False
                and terminal.get("Result") == "exit-code" and terminal.get("ExecMainCode") == "1"
                and terminal.get("ExecMainStatus") == "2")
    if case == "timeout":
        return terminal.get("Result") == "timeout"
    if case == "sigkill":
        return (observation.get("signal_sent") is True and terminal.get("Result") == "signal"
                and terminal.get("ExecMainCode") == "2" and terminal.get("ExecMainStatus") == "9")
    # systemd considers SIGTERM clean for Type=exec, despite CLD_KILLED.
    return (observation.get("signal_sent") is True and terminal.get("Result") in ("signal", "success")
            and terminal.get("ExecMainCode") == "2" and terminal.get("ExecMainStatus") == "15")


def run_case(args: argparse.Namespace, case: str, output: Path) -> dict:
    context_path, context = new_context(args, case, output)
    error = None
    observation = {}
    try:
        bundle = prepare(context)
        start_outer(context, context_path, bundle)
        observation = watch(context)
    except (Refusal, OSError, ValueError) as exc:
        error = exc.code if isinstance(exc, Refusal) else "case_execution_failed"
    finally:
        # A failed launch or interrupted supervisor still gets the same bounded,
        # account-bound cleanup. ExecStopPost normally owns this action.
        try:
            stop_outer(context["outer_unit"])
        except Refusal:
            error = error or "outer_stop_failed"
        if not (Path(context["receipts"]) / "cleanup.json").exists():
            try:
                cleanup(context_path, from_exec_stop_post=False)
            except (Refusal, OSError):
                error = error or "fallback_cleanup_failed"
    containment = final_containment(context)
    expected = expected_result(context, observation)
    result = {"schema": "omegacode-linux-lifecycle-case-v1", "case": case, "case_id": context["case_id"],
              "ok": error is None and expected and containment["ok"], "error_code": error,
              "expected_terminal_observed": expected, "process_group_clean": containment["process_group_clean"],
              "control_ready_observed": observation.get("control_ready_observed", False),
              "signal_sent": observation.get("signal_sent", False),
              "terminal": observation.get("terminal", {}),
              "fresh_user": context["user"], "uid": context["uid"], "home_preserved": Path(context["home"]).is_dir()}
    write_json(Path(context["receipts"]) / "summary.json", result)
    # Reset only this case's failed transient controller after its evidence has
    # been captured. Fresh locked account and all state remain for VM disposal.
    command([SYSTEMCTL, "reset-failed", context["outer_unit"]], check=False)
    return result


def interrupt(_signum: int, _frame: object) -> None:
    global _interrupted
    _interrupted = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    for name in ("r14-archive", "r152-archive", "python", "runtime-lock", "output-dir"):
        run.add_argument("--" + name, required=True, type=Path)
    run.add_argument("--cases", default=",".join(CASES))
    clean = sub.add_parser("cleanup")
    clean.add_argument("--context", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        need(platform.system() == "Linux" and platform.machine() == "x86_64", "native_linux_x86_64_required")
        need(os.geteuid() == 0, "root_ci_supervisor_required")
        need(Path("/sys/fs/cgroup/cgroup.controllers").is_file(), "cgroup_v2_required")
        if args.command == "cleanup":
            return cleanup(args.context, from_exec_stop_post=True)
        cases = args.cases.split(",")
        need(bool(cases) and len(cases) == len(set(cases)) and all(c in CASES for c in cases), "cases_invalid")
        for key in ("r14_archive", "r152_archive", "python", "runtime_lock"):
            path = getattr(args, key)
            need(path.is_absolute() and path.is_file(), "input_path_invalid")
            setattr(args, key, path.absolute())
        output = args.output_dir.absolute()
        need(not output.exists() and not output.is_symlink(), "output_directory_must_be_fresh")
        need(output.parent.resolve() == output.parent, "output_parent_not_canonical")
        output.mkdir(mode=0o700)
        root_private_directory(output)
        need(not listeners_8724(), "preexisting_listener_8724")
        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        results = []
        for case in cases:
            if _interrupted:
                break
            result = run_case(args, case, output)
            results.append({"case": case, "ok": result["ok"], "case_id": result["case_id"]})
            # Stop on the first failed qualification; do not multiply partial
            # fresh users or exercise controls after a broken full run.
            if not result["ok"]:
                break
        ok = len(results) == len(cases) and all(r["ok"] for r in results) and not _interrupted
        receipt = {"schema": "omegacode-linux-lifecycle-supervisor-v1", "ok": ok, "cases": results,
                   "requested_cases": cases, "qualification_scope": "fresh_user_lifecycle_cases_only",
                   "all_default_cases_passed": ok and set(cases) == set(CASES),
                   "production_deployment": False,
                   "private_state_preserved": True}
        write_json(output / "supervisor.json", receipt)
        print(json.dumps({"ok": ok, "completed_cases": len(results), "requested_cases": len(cases)}, sort_keys=True))
        return 0 if ok else 1
    except (Refusal, OSError, ValueError) as exc:
        code = exc.code if isinstance(exc, Refusal) else "supervisor_failed"
        print(json.dumps({"ok": False, "error_code": code}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
