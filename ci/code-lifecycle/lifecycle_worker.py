#!/usr/bin/env python3
"""Synthetic systemd-user lifecycle worker; invoked by the root CI supervisor only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import secrets
import shutil
import socket
import sqlite3
import stat
import subprocess
import time
import urllib.error
import urllib.request
import zipfile

from runtime_preflight import verify_runtime


PINS = {
    "r14": {
        "archive": "c7478c1e88ed5fd777890196d572cf347c3a38240810b3911836081c8674fea1",
        "modules": "4a5737b1296bcb49ff44a002684129c18e95a749d8ce3362cd97df18953b449d",
        "prefix": "src/omegacode/", "count": 91,
    },
    "r152": {
        "archive": "c6f0e7c2380fee230ee8081e097a231d7c7d731afec82ff24ae86041637638f1",
        "modules": "892f333ee430c5f10a9985f97109e1fa511b1fa020a925de9c49ac73ed64387d",
        "prefix": "source/src/omegacode/", "count": 92,
    },
}
UNIT = "omegacode.service"


class Refusal(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def file_sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, body):
    path = Path(path)
    temp = path.with_name(path.name + ".new")
    with temp.open("x", encoding="utf-8") as stream:
        os.chmod(temp, 0o600)
        json.dump(body, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def module_digest(package):
    h = hashlib.sha256()
    files = sorted(p for p in Path(package).rglob("*.py") if "__pycache__" not in p.parts)
    for path in files:
        require(path.is_file() and not path.is_symlink(), "module_not_regular")
        rel = path.relative_to(package).as_posix()
        h.update(rel.encode() + b"\0" + file_sha(path).encode("ascii") + b"\n")
    return h.hexdigest(), len(files)


def stage_archive(archive, release_root, pin):
    require(file_sha(archive) == pin["archive"], "archive_digest_mismatch")
    release = Path(release_root) / pin["modules"]
    require(not release.exists(), "release_already_exists")
    package = release / "omegacode"
    package.mkdir(parents=True, mode=0o755)
    seen = set()
    size = 0
    with zipfile.ZipFile(archive) as zf:
        for item in zf.infolist():
            if not item.filename.startswith(pin["prefix"]) or item.is_dir():
                continue
            relative = item.filename[len(pin["prefix"]):]
            part = PurePosixPath(relative)
            require(relative and not part.is_absolute() and ".." not in part.parts
                    and "\\" not in relative and str(part) == relative, "unsafe_archive_path")
            require(relative not in seen, "duplicate_archive_member")
            require(stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), "archive_not_regular")
            seen.add(relative)
            size += item.file_size
            require(len(seen) <= 256 and size <= 16 * 1024 * 1024, "archive_limit")
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(zf.read(item))
            os.chmod(target, 0o444)
    digest, count = module_digest(package)
    require((digest, count) == (pin["modules"], pin["count"]), "module_digest_mismatch")
    for path in sorted(release.rglob("*"), reverse=True):
        if path.is_dir():
            os.chmod(path, 0o555)
    os.chmod(release, 0o555)
    return release


def proc_birth(pid):
    try:
        text = (Path("/proc") / str(pid) / "stat").read_text()
        return int(text[text.rfind(")") + 2:].split()[19])
    except FileNotFoundError:
        return None


def listeners():
    found = []
    for table, family in (("tcp", socket.AF_INET), ("tcp6", socket.AF_INET6)):
        for row in (Path("/proc/net") / table).read_text().splitlines()[1:]:
            fields = row.split()
            address, port = fields[1].split(":")
            if int(port, 16) != 8724 or fields[3] != "0A":
                continue
            raw = bytes.fromhex(address)
            raw = raw[::-1] if family == socket.AF_INET else b"".join(raw[i:i+4][::-1] for i in range(0, 16, 4))
            found.append({"address": socket.inet_ntop(family, raw), "family": family,
                          "uid": int(fields[7]), "inode": int(fields[9])})
    return found


def require_port_rebindable():
    require(not listeners(), "port_preoccupied")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            # Match Uvicorn's reuse behavior without ignoring a live listener.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", 8724))
    except OSError:
        raise Refusal("port_not_rebindable") from None


def socket_holders(inode):
    holders = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            for fd in (proc / "fd").iterdir():
                try:
                    if os.readlink(fd) == f"socket:[{inode}]":
                        holders.add(int(proc.name))
                except FileNotFoundError:
                    continue
        except FileNotFoundError:
            continue
    return holders


def cgroup_pids(group):
    require(group.startswith("/") and ".." not in Path(group).parts, "invalid_cgroup")
    base = Path("/sys/fs/cgroup") / group.lstrip("/")
    if not base.exists():
        return set()
    files = [base / "cgroup.procs", *base.rglob("cgroup.procs")]
    result = set()
    for path in files:
        try:
            result.update(int(p) for p in path.read_text().split())
        except FileNotFoundError:
            continue
    return result


def uid_code_pids(uid):
    result = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid == uid:
                argv = (proc / "cmdline").read_bytes().split(b"\0")
                if b"omegacode" in argv and b"-m" in argv:
                    result.add(int(proc.name))
        except FileNotFoundError:
            continue
    return result


def inventory(root):
    """Inventory a stopped synthetic tree, including WAL/SHM and empty directories."""
    root = Path(root)
    rows = []
    require(root.is_dir() and not root.is_symlink(), "state_root_invalid")
    for path in [root, *sorted(root.rglob("*"))]:
        meta = path.lstat()
        require(stat.S_ISDIR(meta.st_mode) or stat.S_ISREG(meta.st_mode), "state_special_file")
        require(not path.is_symlink() and (path.is_dir() or meta.st_nlink == 1), "state_link")
        rows.append((str(path.relative_to(root)), stat.S_IMODE(meta.st_mode),
                     "dir" if path.is_dir() else file_sha(path)))
    return rows


def inventory_sha(rows):
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def integrity(root):
    # Called only after verified stop; URI read-only mode preserves the state snapshot.
    db = Path(root) / "index.sqlite3"
    require(db.is_file() and not db.is_symlink(), "state_database_missing")
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True) as conn:
        require(conn.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "state_integrity_failed")


def zero_authority(root):
    root = Path(root)
    require(not any(root.glob("*registration*")) and not any(root.glob("*enrol*")), "registration_present")
    with sqlite3.connect((root / "index.sqlite3").as_uri() + "?mode=ro", uri=True) as conn:
        require(conn.execute("SELECT COUNT(*) FROM grants").fetchone()[0] == 0, "grants_present")
        # Refuse any owned record, rather than guessing which job kinds might be executable.
        require(conn.execute("SELECT COUNT(*) FROM records").fetchone()[0] == 0, "owned_records_present")
        require(conn.execute("SELECT COUNT(*) FROM operations").fetchone()[0] == 0, "operations_present")
    return {"host_registered": False, "local_grants": 0, "owned_records": 0,
            "host_revocation": "not_exercised_unregistered_fixture"}


class Worker:
    def __init__(self, context):
        self.c = context
        self.home = Path(context["home"])
        self.root = Path(context["work_root"])
        self.receipts = Path(context["receipts"])
        self.uid, self.gid = context["uid"], context["gid"]
        self.user = context["user"]
        self.python = Path(context["python"])
        self.state = self.home / "state"
        self.config = self.home / "config.json"
        self.unit = self.home / ".config/systemd/user" / UNIT
        self.active_link = self.root / "active"
        self.token_path = self.home / "operator-token"
        self.current_identity = None

    def receipt(self, step, **fields):
        write_json(self.receipts / (step + ".json"),
                   {"schema": "omegacode-linux-lifecycle-r1", "case": self.c["case"], "step": step, **fields})

    def command(self, argv, timeout=20, expected=(0,)):
        try:
            result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        except subprocess.TimeoutExpired:
            raise Refusal("command_timeout") from None
        require(result.returncode in expected, "command_failed")
        require(len(result.stdout) < 262144, "command_output_limit")
        return result.stdout.decode("utf-8", errors="strict").strip()

    def user_command(self, argv, **kwargs):
        return self.command(["/usr/sbin/runuser", "-u", self.user, "--", "env", "-i",
                             "HOME=" + str(self.home), "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
                             f"XDG_RUNTIME_DIR=/run/user/{self.uid}",
                             f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{self.uid}/bus", *argv], **kwargs)

    def systemctl(self, *args, **kwargs):
        return self.user_command(["systemctl", "--user", *args], **kwargs)

    def show(self):
        text = self.systemctl("show", UNIT, "--property=MainPID,ControlGroup,ActiveState,LoadState,SubState", expected=(0, 1))
        properties = dict(row.split("=", 1) for row in text.splitlines())
        require("LoadState" in properties, "unit_properties_unavailable")
        return properties

    def private_dir(self, path):
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(path, 0o700)
        os.chown(path, self.uid, self.gid)

    def private_file(self, path, content):
        with path.open("x") as stream:
            os.chmod(path, 0o600)
            stream.write(content)
        os.chown(path, self.uid, self.gid)

    def prepare(self):
        require(os.geteuid() == 0 and pwd.getpwnam(self.user).pw_uid == self.uid, "root_or_uid_required")
        require_port_rebindable()
        self.private_dir(self.home / "work")
        self.private_dir(self.state)
        for path in (self.home / ".config", self.home / ".config/systemd", self.unit.parent):
            self.private_dir(path)
        self.private_file(self.token_path, secrets.token_urlsafe(48))
        self.private_file(self.config, json.dumps({"data_root": str(self.state),
                          "operator_token_file": str(self.token_path), "repositories": {},
                          "proposal_tests_enabled": False}))
        self.private_file(self.state / "synthetic-retained.txt", "invented OmegaCode lifecycle state\n")
        release_root = self.root / "releases"
        release_root.mkdir(mode=0o755)
        os.chmod(release_root, 0o755)
        self.releases = {name: stage_archive(self.c[name + "_archive"], release_root, pin)
                         for name, pin in PINS.items()}
        self.receipt("01-package", ok=True,
                     releases={name: {"archive_sha256": pin["archive"], "module_digest": pin["modules"],
                                       "module_count": pin["count"]} for name, pin in PINS.items()})
        try:
            rt = {name: verify_runtime(self.python, Path(self.c["runtime_lock"]), self.home, self.user, release)
                  for name, release in self.releases.items()}
        except RuntimeError as error:
            code = str(error)
            raise Refusal(code if re.fullmatch(r"runtime_[a-z_]+", code) else "runtime_preflight_failed") from None
        self.receipt("02-runtime", ok=True, evidence=rt,
                     runtime_supply_chain="CI_hash_locked_provisioning_required")
        # Only the root worker inside the bounded outer unit starts the user manager.
        # ExecStopPost is already armed before linger can create any service process.
        self.command(["loginctl", "enable-linger", self.user])
        self.command(["systemctl", "start", f"user@{self.uid}.service"])
        deadline = time.monotonic() + 15
        while not (Path(f"/run/user/{self.uid}") / "bus").exists():
            require(time.monotonic() < deadline, "user_bus_timeout")
            time.sleep(0.2)
        require(self.command(["loginctl", "show-user", self.user, "--property=Linger", "--value"]) == "yes",
                "linger_required")
        self.systemctl("show-environment")  # Response discarded; never copied to a receipt.
        self.receipt("03-user-manager", ok=True, uid=self.uid, linger=True, bus_reachable=True)

    def activate(self, name, step):
        require(not listeners() and not uid_code_pids(self.uid), "activation_not_quiescent")
        release = self.releases[name]
        require(module_digest(release / "omegacode")[0] == PINS[name]["modules"], "release_changed")
        activation = self.root / ("activation-" + name)
        activation.mkdir(mode=0o755, exist_ok=True)
        os.chmod(activation, 0o755)
        for p in (self.python, self.home, release, self.config):
            require(re.fullmatch(r"/[A-Za-z0-9_./+-]+", str(p)) is not None, "systemd_path_unsupported")
        unit_text = f"""[Unit]
Description=OmegaCode synthetic lifecycle qualification
StartLimitIntervalSec=30
StartLimitBurst=3
[Service]
Type=simple
WorkingDirectory={self.home}/work
ExecStart={self.python} -B -s -m omegacode --config {self.config}
Environment=PYTHONPATH={release}
Environment=PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 PATH=/usr/bin:/bin LANG=C.UTF-8
UnsetEnvironment=LD_PRELOAD LD_AUDIT PYTHONHOME PYTHONSTARTUP PYTHONINSPECT PYTHONPYCACHEPREFIX
UMask=0077
KillMode=control-group
TimeoutStopSec=10
Restart=on-failure
RestartSec=1
LimitCORE=0
StandardOutput=null
StandardError=null
[Install]
WantedBy=default.target
"""
        unit_path = activation / UNIT
        if not unit_path.exists():
            unit_path.write_text(unit_text)
            os.chmod(unit_path, 0o444)
            write_json(activation / "pin.json", {"module_digest": PINS[name]["modules"]})
            os.chmod(activation / "pin.json", 0o444)
        else:
            require(unit_path.read_text() == unit_text, "activation_mutated")
        temporary = self.root / "active.new"
        temporary.symlink_to(activation, target_is_directory=True)
        os.replace(temporary, self.active_link)  # One pointer binds the unit and the pin.
        if not self.unit.exists():
            self.unit.symlink_to(self.active_link / UNIT)
            os.lchown(self.unit, self.uid, self.gid)
        self.systemctl("daemon-reload")
        self.user_command(["systemd-analyze", "--user", "verify", str(self.unit)])
        self.systemctl("enable", UNIT)
        require(self.systemctl("is-enabled", UNIT) == "enabled", "unit_not_enabled")
        self.receipt(step, ok=True, unit=UNIT, module_digest=PINS[name]["modules"],
                     unit_file_sha256=hashlib.sha256(unit_text.encode()).hexdigest(),
                     systemd_analyze_verified=True, unit_enabled=True, atomic_unit_pin_pointer=True)

    def http(self, owner=False):
        headers = {"Authorization": "Bearer " + self.token_path.read_text()} if owner else {}
        request = urllib.request.Request("http://127.0.0.1:8724/v1/capabilities", headers=headers)
        # Deliberately ignore all proxy environment state; no redirects or credential forwarding.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=2) as response:
                return response.status, response.read(65537)
        except urllib.error.HTTPError as error:
            return error.code, error.read(65537)

    def identity(self, name):
        props = self.show()
        pid = int(props.get("MainPID", "0"))
        birth = proc_birth(pid) if pid > 0 else None
        require(props.get("ActiveState") == "active" and birth is not None, "service_not_active")
        proc = Path("/proc") / str(pid)
        require(proc.stat().st_uid == self.uid, "listener_uid_mismatch")
        uidrow = next(row for row in (proc / "status").read_text().splitlines() if row.startswith("Uid:"))
        require({int(v) for v in uidrow.split()[1:]} == {self.uid}, "service_uid_mismatch")
        argv = (proc / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
        expected = [str(self.python), "-B", "-s", "-m", "omegacode", "--config", str(self.config)]
        require(argv == [v.encode() for v in expected], "service_argv_mismatch")
        require((proc / "exe").resolve() == self.python.resolve(), "interpreter_mismatch")
        require((proc / "cwd").resolve() == (self.home / "work").resolve()
                and not any((self.home / "work").iterdir()), "working_directory_mismatch")
        env = dict(part.split(b"=", 1) for part in (proc / "environ").read_bytes().split(b"\0") if b"=" in part)
        require(env.get(b"PYTHONPATH") == str(self.releases[name]).encode()
                and env.get(b"PYTHONNOUSERSITE") == b"1"
                and not any(k in env for k in (b"LD_PRELOAD", b"LD_AUDIT", b"PYTHONHOME")), "service_environment_mismatch")
        observed = listeners()
        require(len(observed) == 1 and observed[0]["address"] == "127.0.0.1"
                and observed[0]["family"] == socket.AF_INET and observed[0]["uid"] == self.uid,
                "loopback_listener_mismatch")
        require(socket_holders(observed[0]["inode"]) == {pid}, "socket_holder_mismatch")
        group = props["ControlGroup"]
        require(group and cgroup_pids(group) == {pid}, "service_cgroup_mismatch")
        actual_digest, _ = module_digest(self.releases[name] / "omegacode")
        require(actual_digest == PINS[name]["modules"], "live_package_mutated")
        require(self.show().get("MainPID") == str(pid) and proc_birth(pid) == birth, "service_identity_drift")
        self.current_identity = {"pid": pid, "birth": birth, "group": group}
        return {"module_digest": actual_digest, "pid": pid, "process_start_ticks": birth,
                "uid": self.uid, "listener": "127.0.0.1:8724", "sole_socket_holder": True,
                "argv_cwd_environment_match": True, "module_origin_preflight": True,
                "release_proof": "immutable_package_plus_process_import_path"}

    def start_health(self, name, step, prior_identity=None):
        self.systemctl("start", UNIT)
        deadline = time.monotonic() + 25
        while True:
            try:
                status, body = self.http(owner=False)
                require(status == 401, "anonymous_status_mismatch")
                status, body = self.http(owner=True)
                require(status == 200 and len(body) <= 65536
                        and json.loads(body).get("service") == "omegacode", "owner_health_mismatch")
                evidence = self.identity(name)
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise Refusal("service_health_timeout") from None
                time.sleep(0.2)
        if prior_identity is not None:
            require((prior_identity["pid"], prior_identity["process_start_ticks"]) !=
                    (evidence["pid"], evidence["process_start_ticks"]), "restart_identity_unchanged")
            evidence["new_process_identity"] = True
        self.receipt(step, ok=True, anonymous_status=401, owner_status=200, **evidence)
        return evidence

    def stop(self, step):
        saved = self.current_identity
        self.systemctl("stop", UNIT)
        deadline = time.monotonic() + 12
        while True:
            empty = (not listeners() and not uid_code_pids(self.uid)
                     and (saved is None or (not cgroup_pids(saved["group"])
                          and proc_birth(saved["pid"]) != saved["birth"])))
            if empty:
                break
            require(time.monotonic() < deadline, "service_cleanup_failed")
            time.sleep(0.2)
        require(self.show().get("MainPID") == "0", "stopped_mainpid_not_zero")
        require_port_rebindable()
        self.current_identity = None
        self.receipt(step, ok=True, process_group_clean=True, code_processes=0, listener_count=0, port_rebindable=True)

    def copy_state(self, target):
        require(not uid_code_pids(self.uid) and not listeners(), "state_copy_not_quiescent")
        before = inventory(self.state)
        integrity(self.state)
        require(inventory(self.state) == before, "integrity_check_mutated_state")
        shutil.copytree(self.state, target, copy_function=shutil.copy2)
        require(inventory(target) == before, "snapshot_inventory_mismatch")
        return inventory_sha(before)

    def restore_state(self, snapshot):
        require(not uid_code_pids(self.uid) and not listeners(), "restore_not_quiescent")
        before = inventory(snapshot)
        # Retain the newer state for diagnostics; never run the old binary against it.
        retained = self.home / "retained-newer-state"
        require(not retained.exists(), "newer_state_already_retained")
        os.replace(self.state, retained)
        shutil.copytree(snapshot, self.state, copy_function=shutil.copy2)
        require(inventory(self.state) == before, "restored_inventory_mismatch")
        for path in [self.state, *self.state.rglob("*")]:
            os.chown(path, self.uid, self.gid)
        integrity(self.state)
        require(inventory(self.state) == before, "restored_integrity_mutated_state")
        return inventory_sha(before)

    def run(self):
        self.prepare()
        self.activate("r14", "03a-install")
        initial = self.start_health("r14", "04-first-start")
        if self.c["case"] != "full":
            self.receipt("control-ready", ok=True, service_active=True)
            if self.c["case"] == "refusal":
                raise Refusal("injected_refusal")
            while True:
                time.sleep(1)  # Root supervisor/systemd terminate this control, never a provider.
        self.stop("05-stop")
        self.start_health("r14", "06-restart", prior_identity=initial)
        self.stop("07-quiesce-for-upgrade")
        authority = zero_authority(self.state)
        snapshot = self.root / "r14-cold-snapshot"
        snapshot_digest = self.copy_state(snapshot)
        self.receipt("08-pre-upgrade-snapshot", ok=True, snapshot_inventory_sha256=snapshot_digest,
                     cold_copy=True, sqlite_integrity=True, **authority)
        self.activate("r152", "08a-upgrade-install")
        self.start_health("r152", "09-upgrade")
        self.stop("10-quiesce-for-rollback")
        # Deliberate newer-only marker proves the matching old snapshot is restored.
        self.private_file(self.state / "newer-only-synthetic.txt", "invented newer-release state\n")
        restored_digest = self.restore_state(snapshot)
        require(restored_digest == snapshot_digest and not (self.state / "newer-only-synthetic.txt").exists(),
                "old_state_not_restored")
        self.receipt("11-restore-before-old-start", ok=True, snapshot_inventory_sha256=restored_digest,
                     newer_state_retained=True, sqlite_integrity=True)
        self.activate("r14", "11a-rollback-install")
        self.start_health("r14", "12-rollback-health")
        self.stop("13-uninstall-quiesce")
        authority = zero_authority(self.state)
        state_before = inventory(self.state)
        self.receipt("14-uninstall-authority", ok=True, **authority,
                     scope="unregistered_idle_synthetic_state_only")
        self.systemctl("disable", UNIT)
        self.unit.unlink()
        self.systemctl("daemon-reload")
        props = self.show()
        require(props.get("LoadState") == "not-found" and props.get("MainPID") == "0", "unit_not_removed")
        require(not listeners() and not uid_code_pids(self.uid), "uninstall_not_quiescent")
        require_port_rebindable()
        require(inventory(self.state) == state_before, "uninstall_state_changed")
        integrity(self.state)
        require(inventory(self.state) == state_before, "uninstall_integrity_changed_state")
        self.receipt("15-uninstall", ok=True, unit_gone=True, code_processes=0, listener_count=0,
                     process_group_clean=True, port_rebindable=True, state_retained=True,
                     state_inventory_sha256=inventory_sha(state_before), sqlite_integrity=True)
        self.receipt("result", ok=True, lifecycle="passed",
                     rollback_digest=PINS["r14"]["modules"],
                     pending=["actual_host_guard_relay_and_enrollment", "host_revoke_cancel_with_active_work",
                              "workbench_journey", "hive_restart", "hyperon_worker"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", type=Path, required=True)
    args = parser.parse_args()
    context = None
    try:
        meta = args.context.lstat()
        require(stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and stat.S_IMODE(meta.st_mode) == 0o600,
                "context_not_private_root_owned")
        context = json.loads(args.context.read_text())
        Worker(context).run()
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, Refusal) else "worker_failed"
        if context is not None:
            write_json(Path(context["receipts"]) / "result.json",
                       {"ok": False, "reason": reason, "case": context["case"]})
        print(json.dumps({"ok": False, "reason": reason}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
