"""Bounded local-owner first-install setup. No Hive imports and no provider calls.

Only the owner's public declarative seed is accepted. Session/code/agent tokens
stay in memory and are never included in output, argv, state or receipts.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import types
import uuid

SEED_PIN = (1627, "917fc8c77357ef076712e867e0f1026e8910fc0683b017f824111b2b5c62f0ee")
CONTROL_PIN = (24048, 'a3bf9aae0c66a0f4c9811a69299f5fdd9116aff512a5779808b4a83f62a19ce1')
APPS = ("omegaassist", "omegadesign")
MAX_BODY = 256 * 1024
STOP = False


class Refused(Exception):
    pass


def require(value, reason="Local setup could not be verified."):
    if not value:
        raise Refused(reason)


def stopped(_number, _frame):
    global STOP
    STOP = True


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value)
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused()))


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_owned(path, maximum=MAX_BODY, private=False, pin=None):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
            and before.st_nlink == 1 and not before.st_mode & 0o022
            and (not private or stat.S_IMODE(before.st_mode) == 0o600)
            and 0 <= before.st_size <= maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require(identity(opened) == identity(before))
        raw = bytearray()
        while True:
            block = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not block: break
            raw.extend(block)
            require(len(raw) <= maximum)
        require(identity(opened) == identity(os.fstat(fd)) == identity(path.lstat()))
    finally:
        os.close(fd)
    if pin is not None:
        require(len(raw) == pin[0] and hashlib.sha256(raw).hexdigest() == pin[1])
    return bytes(raw), identity(opened)


def module_from_file(path):
    raw, _ = read_owned(path, 65536, pin=CONTROL_PIN)
    module = types.ModuleType("linux_frontdoor_control")
    module.__file__ = str(path)
    exec(compile(raw, str(path), "exec"), module.__dict__)  # exact retained pinned L0 bytes, never Hive code
    return module


def number_equal(actual, expected):
    return type(actual) in (int, float) and math.isfinite(actual) and actual == expected


def identifier(value, prefix):
    require(type(value) is str and re.fullmatch(prefix + r"_[A-Za-z0-9_-]{1,96}", value))
    return value


def seed_document(path):
    raw, _ = read_owned(path, 16384, pin=SEED_PIN)
    value = strict_json(raw)
    require(type(value) is dict and set(value) == {"format", "note", "mind", "role"}
            and value["format"] == "omegahive.studio-maker-template/1")
    mind = value["mind"]
    require(type(mind) is dict and set(mind) == {"name", "kind", "model", "budget_usd", "idle_sleep_minutes", "options"}
            and mind["kind"] == "omega" and mind["options"] == {}
            and number_equal(mind["budget_usd"], 3.0) and number_equal(mind["idle_sleep_minutes"], 0.0))
    role = value["role"]
    require(type(role) is dict and set(role) == {"name", "summary", "prompt", "default_model", "default_budget", "rules", "mandate", "media"}
            and role["rules"] == [{"skill": "*", "mode": "deny"}])
    return value


def role_matches(row, seed):
    if type(row) is not dict or not set(seed) <= set(row): return False
    return all(number_equal(row.get(key), expected) if type(expected) in (int, float)
               else type(row.get(key)) is type(expected) and row.get(key) == expected
               for key, expected in seed.items())


def mind_matches(row, seed, role_id, principal, asleep=False):
    if type(row) is not dict or not {"name", "kind", "model", "role_id", "owner", "visibility", "swarm_id",
            "persona", "options", "budget_usd", "idle_sleep_minutes", "spent_usd", "connected", "status"} <= set(row): return False
    return (row.get("name") == seed["name"] and row.get("kind") == seed["kind"]
            and row.get("model") == seed["model"] and row.get("role_id") == role_id
            and row.get("owner") == principal and row.get("visibility") == "private"
            and row.get("swarm_id") is None and row.get("persona") == ""
            and type(row.get("options")) is dict and row["options"] == seed["options"]
            and number_equal(row.get("budget_usd"), seed["budget_usd"])
            and number_equal(row.get("idle_sleep_minutes"), seed["idle_sleep_minutes"])
            and number_equal(row.get("spent_usd"), 0)
            and row.get("connected") is False
            and row.get("status") in ({"asleep"} if asleep else {"created", "stopped", "asleep"}))


def descriptor_write(path, old_raw, old_identity, template):
    current, observed = read_owned(path, private=True)
    require(current == old_raw and observed == old_identity, "The installation changed during setup; no settings were replaced.")
    value = strict_json(current)
    require(value.get("studio_maker_template") in (None, template))
    value["studio_maker_template"] = template
    raw = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    check, seen = read_owned(path, private=True)
    require(check == old_raw and seen == old_identity)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def socket_inode(listener_inode, server_port, client_port, deadline, cleanup=False):
    """Only socket metadata. The service is not dumpable, so its /proc/<pid>/fd is unreadable here: instead its
    hello attests the inode of its own loopback listener, and that must be the one LISTEN socket on the port; the
    accepted end of this connection must belong to this account."""
    local = "0100007F:" + format(server_port, "04X")
    remote = "0100007F:" + format(client_port, "04X")
    # Bounded by the caller (at most 5 s per request), so a slow accept on a busy machine is waited for.
    end = deadline
    while time.monotonic() < end:
        require(cleanup or not STOP)
        fd = os.open("/proc/" + str(os.getpid()) + "/net/tcp", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with os.fdopen(fd, "rb", closefd=False) as stream: raw = stream.read(4 * 1024**2 + 1)
        finally: os.close(fd)
        require(len(raw) <= 4 * 1024**2)
        inodes = set()
        for line in raw.decode("ascii").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 10 and fields[1:4] == [local, remote, "01"]:
                require(fields[9].isdecimal())
                # Until the service accepts the connection the kernel shows inode 0 and uid 0 for its end:
                # that is "not yet", so look again; once accepted it must belong to this account.
                if int(fields[9]) > 0:
                    require(fields[7].isdecimal() and int(fields[7]) == os.getuid())
                    inodes.add(fields[9])
        require(len(inodes) <= 1)
        listeners = set()
        for line in raw.decode("ascii").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 10 and fields[1] == local and fields[3] == "0A":
                require(fields[7].isdecimal() and int(fields[7]) == os.getuid() and fields[9].isdecimal())
                listeners.add(fields[9])
        if inodes and listeners == {listener_inode}: return
        time.sleep(min(0.02, max(0, end - time.monotonic())))
    raise Refused("The local HTTP service identity could not be verified.")


class OwnerAPI:
    def __init__(self, control, config, home, pid, deadline, hello=None):
        self.control, self.config, self.home, self.pid = control, config, home, pid
        self.hello = hello
        self.deadline, self.token, self.principal = deadline, None, None

    def request(self, method, path, payload=None, *, cleanup=False):
        require(type(path) is str and (path in {"/api/auth/local/exchange", "/api/auth/me", "/api/auth/logout", "/api/roles", "/api/agents"}
            or re.fullmatch(r"/api/programs/(?:omegaassist|omegadesign)(?:/install)?", path)
            or re.fullmatch(r"/api/agents/a_[A-Za-z0-9_-]{1,96}(?:/sleep)?", path)))
        require(method in {"GET", "POST"} and (not cleanup or (method, path) == ("POST", "/api/auth/logout")))
        end = time.monotonic() + 5 if cleanup else min(self.deadline, time.monotonic() + 5)
        require((cleanup or not STOP) and end - time.monotonic() > 0.1)
        require(self.control.supervisor_pid(self.home) == self.pid)
        # The service is not dumpable, so /proc/<pid>/exe is unreadable: its hello attests its executable and listener.
        hello = self.hello
        require(type(hello) is dict and hello.get("pid") == self.pid and self.control.exe_matches(self.config, hello)
                and type(hello.get("listener_inode")) is str and hello["listener_inode"].isdecimal())
        require(time.monotonic() < end)
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw = bytearray()
        try:
            connection.settimeout(max(0.01, end - time.monotonic()))
            connection.connect(("127.0.0.1", self.config["port"]))
            require(connection.getpeername() == ("127.0.0.1", self.config["port"]))
            socket_inode(hello["listener_inode"], self.config["port"], connection.getsockname()[1], end, cleanup=cleanup)
            body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
            require(body is None or len(body) <= 16384)
            headers = {"Host": "127.0.0.1:" + str(self.config["port"]), "Origin": "http://127.0.0.1:" + str(self.config["port"]),
                       "Accept": "application/json", "Connection": "close", "Content-Length": str(len(body or b""))}
            if body is not None: headers["Content-Type"] = "application/json"
            if self.token is not None: headers["Authorization"] = "Bearer " + self.token
            require((cleanup or not STOP) and time.monotonic() < end)
            wire = ((method + " " + path + " HTTP/1.1\r\n")
                    + "".join(key + ": " + value + "\r\n" for key, value in headers.items()) + "\r\n").encode("ascii")
            connection.settimeout(max(0.01, end - time.monotonic()))
            connection.sendall(wire + (body or b""))
            while b"\r\n\r\n" not in raw:
                require(time.monotonic() < end and (cleanup or not STOP))
                connection.settimeout(max(0.01, end - time.monotonic()))
                block = connection.recv(4096)
                require(block); raw.extend(block); require(len(raw) <= 65536)
            head, initial = bytes(raw).split(b"\r\n\r\n", 1)
            lines = head.decode("ascii").split("\r\n")
            require(1 <= len(lines) <= 41)
            status = re.fullmatch(r"HTTP/1\.[01] ([0-9]{3}) [^\r\n]{0,128}", lines[0])
            require(status is not None and 200 <= int(status.group(1)) < 300)
            received = {}
            for line in lines[1:]:
                key, separator, value = line.partition(":")
                require(separator and re.fullmatch(r"[A-Za-z0-9-]+", key))
                key = key.lower(); require(key not in received)
                received[key] = value.strip()
            require("transfer-encoding" not in received and received.get("content-length", "").isdecimal())
            size = int(received["content-length"])
            require(size <= MAX_BODY and received.get("content-type", "").split(";", 1)[0].strip().lower() == "application/json")
            raw.clear(); raw.extend(initial); require(len(raw) <= size)
            while len(raw) < size:
                require(time.monotonic() < end and (cleanup or not STOP))
                connection.settimeout(max(0.01, end - time.monotonic()))
                block = connection.recv(min(65536, size - len(raw)))
                require(block); raw.extend(block)
            require(self.control.supervisor_pid(self.home) == self.pid
                    and (cleanup or time.monotonic() < self.deadline))
            return strict_json(raw)
        finally:
            raw.clear(); connection.close()

    def login(self, code, principal):
        require(type(code) is str and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", code))
        answer = self.request("POST", "/api/auth/local/exchange", {"code": code})
        require(type(answer) is dict and type(answer.get("token")) is str
                and re.fullmatch(r"[A-Za-z0-9_-]{32,256}", answer["token"]))
        self.token = answer.pop("token")
        me = self.request("GET", "/api/auth/me")
        require(type(me) is dict and me.get("principal") == principal and me.get("kind") == "sso"
                and me.get("role") == "admin" and me.get("person_kind") == "person"
                and me.get("local_operator") is False, "Setup requires the named local owner, not an operator or bootstrap bearer.")
        self.principal = principal

    def logout(self):
        if self.token is not None:
            try:
                answer = self.request("POST", "/api/auth/logout", {}, cleanup=True)
                require(type(answer) is dict and answer.get("ok") is True)
            finally: self.token = None


def inspect_apps(api, config):
    require(type(config.get("app_pins")) is dict)
    for program in APPS:
        pin = config["app_pins"].get(program)
        require(type(pin) is dict and type(pin.get("digest")) is str)
        entry = api.request("GET", "/api/programs/" + program)
        require(type(entry) is dict and entry.get("id") == program and entry.get("digest") == pin["digest"]
                and entry.get("error") is None and entry.get("ui") is True)
        status = api.request("GET", "/api/programs/" + program + "/install")
        require(type(status) is dict and status.get("program") == program and status.get("release_digest") == pin["digest"]
                and status.get("placement") in {"person", "swarm"})
        # Normal named-admin install review only; no person-swarm consent, Ask grant or activation is copied.
        result = api.request("POST", "/api/programs/" + program + "/install",
            {"release_digest": pin["digest"], "placement": status["placement"], "use_in": []})
        require(type(result) is dict and result.get("installed") is True and result.get("release_digest") == pin["digest"])
        final = api.request("GET", "/api/programs/" + program + "/install")
        require(type(final) is dict)
        review = final.get("review")
        require(final.get("installed") is True and final.get("release_digest") == pin["digest"]
                and type(review) is dict and review.get("revoked") is False
                and review.get("release_digest") == pin["digest"] and review.get("by") == api.principal)


def ensure_template(api, seed, principal):
    roles = api.request("GET", "/api/roles"); require(type(roles) is list and len(roles) <= 256)
    existing = [row for row in roles if type(row) is dict and row.get("name") == seed["role"]["name"]]
    require(len(existing) <= 1 and (not existing or role_matches(existing[0], seed["role"])),
            "An existing role with this name differs from the reviewed seed; nothing was changed.")
    # No retry of a POST whose response is lost; a subsequent explicit invocation reconciles by exact owner/name/content.
    role = existing[0] if existing else api.request("POST", "/api/roles", seed["role"])
    require(role_matches(role, seed["role"])); role_id = identifier(role.get("id"), "role")
    minds = api.request("GET", "/api/agents"); require(type(minds) is list and len(minds) <= 256)
    existing = [row for row in minds if type(row) is dict and row.get("name") == seed["mind"]["name"]]
    require(len(existing) <= 1 and (not existing or mind_matches(existing[0], seed["mind"], role_id, principal)),
            "An existing template differs from the reviewed seed; nothing was changed.")
    payload = dict(seed["mind"], role_id=role_id, persona="", visibility="private")
    made = existing[0] if existing else api.request("POST", "/api/agents", payload)
    require(type(made) is dict); made.pop("token", None)
    require(mind_matches(made, seed["mind"], role_id, principal))
    template = identifier(made.get("id"), "a")
    api.request("POST", "/api/agents/" + template + "/sleep", {})
    final = api.request("GET", "/api/agents/" + template)
    require(mind_matches(final, seed["mind"], role_id, principal, asleep=True))
    return template, role_id


def bootstrap(runtime, seed_path):
    require(sys.platform.startswith("linux") and os.getuid() == os.geteuid() != 0 and not sys.flags.optimize)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    require(home == home.resolve(strict=True) and runtime == home / ".local/share/omegahive/runtime.json")
    raw, original = read_owned(runtime, private=True); preliminary = strict_json(raw)
    release = Path(preliminary.get("release_root", ""))
    require(release.is_absolute() and release == release.resolve(strict=True)
            and release.parent.parent == home / ".local/share/omegahive/releases")
    control = module_from_file(release / "deploy/linux/control.py")
    config, validated_home, _fingerprint = control.runtime(str(runtime))
    require(validated_home == home); control.loader_agreement(config)
    seed = seed_document(seed_path)
    lock = os.open(runtime.parent / "bootstrap.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # The service was only just started; wait (bounded) for its control socket like `open` does.
        hello, pid = control.wait_for_hello(config, home, cancelled=lambda: STOP)
        require(type(hello) is dict and hello.get("ok") is True and hello.get("local_owner") is True
                and hello.get("pid") == pid and hello.get("port") == config["port"]
                and type(hello.get("instance")) is str and type(hello.get("owner")) is str
                and re.fullmatch(r"user:u_[A-Za-z0-9_-]+", hello["owner"]))
        # The attested executable and loopback listener are checked before any sign-in code is requested.
        require(control.exe_matches(config, hello) and control.listener_matches(config, hello))
        signin, observed_pid = control.request(config, home, "signin", expected_pid=pid)
        require(type(signin) is dict and signin.get("ok") is True and observed_pid == pid)
        api = OwnerAPI(control, config, home, pid, time.monotonic() + 50, hello)
        try:
            api.login(signin.pop("code", None), hello["owner"])
            signin.clear()
            inspect_apps(api, config)
            template, _role_id = ensure_template(api, seed, hello["owner"])
        finally:
            signin.clear(); api.logout()
        require(not STOP and time.monotonic() < api.deadline)
        descriptor_write(runtime, raw, original, template)
        require(not STOP)
        # Exactly one fixed user-service restart; no start/wake/model request is issued.
        result = subprocess.run(["/usr/bin/systemctl", "--user", "restart", "omegahive.service"],
            env=control.desktop_environment(home), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45, check=False, close_fds=True)
        require(result.returncode == 0 and not STOP)
        fresh, _pid = control.wait_for_hello(config, home, previous_instance=hello["instance"], cancelled=lambda: STOP)
        require(not STOP and control.listener_matches(config, fresh))
        current, _ = read_owned(runtime, private=True)
        require(strict_json(current).get("studio_maker_template") == template)
        print("OmegaHive apps and the sleeping Studio template are configured.")
        return
    finally:
        os.close(lock)


def failure_message():
    return "Final setup did not finish. Check bootstrap-failure-*.json in ~/.local/share/omegahive/logs and the user-service journal. Rerun the same installer to resume; keep your data."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--seed", required=True, type=Path)
    args = parser.parse_args(); os.umask(0o077)
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM): signal.signal(number, stopped)
    bootstrap(args.runtime, args.seed)


def failure_note(error):
    """Secret-free reason for the logs folder: exception type, a Refused reason, and code locations only."""
    frames = [f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}"
              for frame in __import__("traceback").extract_tb(error.__traceback__)]
    # Refusal reasons (here and in control.py) are fixed reviewed strings; anything else stays out.
    reason = str(error) if type(error).__name__ == "Refused" else ""
    # Only a lowercase code (control.py) or plain words without digits (bootstrap.py) pass:
    # a token, code or path has digits, long runs or other characters and is dropped.
    code = re.fullmatch(r"[a-z][a-z_]{0,63}", reason)
    words = len(reason) <= 300 and all(re.fullmatch(r"[A-Za-z.,;:'()-]{1,24}", w) for w in reason.split())
    if not (code or words):
        reason = ""
    return json.dumps({"step": "bootstrap", "error": type(error).__name__, "reason": reason[:300],
                       "where": frames[-12:]}, indent=1) + "\n"


def record_failure(error, keep=20):
    # Best effort: walks every folder below home without following links, never overwrites,
    # keeps at most `keep` notes, and never masks the original failure.
    opened = []
    try:
        folder = os.open(pwd.getpwuid(os.getuid()).pw_dir, os.O_RDONLY | os.O_DIRECTORY)
        opened.append(folder)
        for part in (".local", "share", "omegahive", "logs"):
            folder = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=folder)
            opened.append(folder)
        info = os.fstat(folder)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            return False
        if sum(name.startswith("bootstrap-failure-") for name in os.listdir(folder)) >= keep:
            return False
        name = "bootstrap-failure-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8] + ".json"
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
        try:
            os.write(fd, failure_note(error).encode())
        finally:
            os.close(fd)
        return True
    except Exception:
        return False
    finally:
        for fd in reversed(opened):
            os.close(fd)


if __name__ == "__main__":
    try: main()
    except Exception as error:
        record_failure(error)
        print(failure_message(), file=sys.stderr)
        raise SystemExit(1)
