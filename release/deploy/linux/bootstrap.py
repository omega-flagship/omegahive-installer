"""Purpose: verify the installed public hive's named local owner and that its minds can run in their sandbox, enrol
Create's Code service with the hive (anew after an update, whose uninstall removed the service the hive still lists),
then put Studio in as Create: the owner's admin install review of the pinned omegadesign release, turned on in the
Create · Code controller's swarm, checked by Create appearing in the owner's own app list. No mind is created and no
model is called.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys
import time
import types

CONTROL_PIN = (28140, "1b1971c0df6a611e8bc61d06647ae1ee96f49aaafb51b751091df2ae9b4df803")
MAX_BODY = 256 * 1024
STUDIO = "omegadesign"
# Create's Code service, by the name the hive's service registry and Code guard know it (hive/core/code.py).
CODE = "omegacode"
# The foundation's Create · Code team leader (hive/core/foundation.py ensure): Create opens in its swarm.
CONTROLLER = "Create · Code controller"
# The hive makes the controller with no cap of its own and the hive's total holds what Create · Code's builds spend
# (hive/core/foundation.py: _ensure_team(CODE, ..., 0)), so setup leaves its budget alone: one cap for the whole hive,
# set by the person, and no default cap on a controller (Jon, omega-flagship/omegahive#679, 23 Nov).
# The foundation makes its teams at start and again at an owner's sign-in; this bounds the wait for the controller.
SETUP_SECONDS = 120


class Refused(Exception):
    pass


class MindsRefused(Refused):
    """The hive started, but its own start-time sandbox preflight refuses every mind on this computer."""


def require(value, reason="The installed hive could not be verified."):
    if not value:
        raise Refused(reason)


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


def read_owned(path, maximum=65536, private=False, pin=None):
    """Read one stable, regular owner file without following links or accepting shared writable bytes."""
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
            if not block:
                break
            raw.extend(block)
            require(len(raw) <= maximum)
        require(identity(opened) == identity(os.fstat(fd)) == identity(path.lstat()))
    finally:
        os.close(fd)
    if pin is not None:
        require(len(raw) == pin[0] and hashlib.sha256(raw).hexdigest() == pin[1])
    return bytes(raw)


def module_from_file(path):
    raw = read_owned(path, pin=CONTROL_PIN)
    module = types.ModuleType("linux_frontdoor_control")
    module.__file__ = str(path)
    exec(compile(raw, str(path), "exec"), module.__dict__)
    return module


def studio_pin(config):
    """The one app package the public release carries: Studio, unpacked in this release's apps folder."""
    pins, root = config["app_pins"], Path(config["runtime_root"])
    folder = root / "apps" / STUDIO
    require(type(pins) is dict and set(pins) == {STUDIO} and config["plugin_dirs"] == [str(folder)]
            and type(pins[STUDIO]) is dict and pins[STUDIO].get("release") == str(folder)
            and type(pins[STUDIO].get("digest")) is str and re.fullmatch("sha256:[a-f0-9]{64}", pins[STUDIO]["digest"])
            and config["studio_maker_template"] is None,
            "The public release configures Studio alone, from its own apps folder, with Studio's own maker template.")
    return pins[STUDIO]


def verify_owner(control, config, home):
    """Bind the hello reply to this account's enabled service and its one loopback listener."""
    studio_pin(config)
    control.loader_agreement(config)
    hello, pid = control.wait_for_hello(config, home)
    require(type(hello) is dict and hello.get("ok") is True and hello.get("local_owner") is True
            and hello.get("pid") == pid and hello.get("port") == config["port"]
            and type(hello.get("instance")) is str and type(hello.get("owner")) is str
            and re.fullmatch(r"user:u_[A-Za-z0-9_-]+", hello["owner"]))
    require(control.exe_matches(config, hello, home, pid) and control.listener_matches(config, hello))
    # The hive ran its sandbox preflight before it answered (hive/core/app.py lifespan): minds must have passed, or
    # every mind would be refused. Tools are not required: this release has no tool runtime.
    preflight = hello.get("preflight")
    if not (type(preflight) is dict and preflight.get("minds") is True):
        reason = preflight.get("reason") if type(preflight) is dict else None
        raise MindsRefused("Your hive started, but its minds can't run in their sandbox on this computer"
                           + (": " + reason if type(reason) is str and reason else "") + ".")
    return hello, pid


def socket_inode(listener_inode, server_port, client_port, deadline):
    """Only socket metadata. The service is not dumpable, so its /proc/<pid>/fd is unreadable here: instead its
    hello attests the inode of its own loopback listener, and that must be the one LISTEN socket on the port; the
    accepted end of this connection must belong to this account."""
    local = "0100007F:" + format(server_port, "04X")
    remote = "0100007F:" + format(client_port, "04X")
    while time.monotonic() < deadline:
        fd = os.open("/proc/" + str(os.getpid()) + "/net/tcp", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with os.fdopen(fd, "rb", closefd=False) as stream:
                raw = stream.read(4 * 1024**2 + 1)
        finally:
            os.close(fd)
        require(len(raw) <= 4 * 1024**2)
        rows = [line.split() for line in raw.decode("ascii").splitlines()[1:]]
        inodes, listeners = set(), set()
        for fields in rows:
            if len(fields) >= 10 and fields[1:4] == [local, remote, "01"]:
                require(fields[9].isdecimal())
                # Until the service accepts the connection the kernel shows inode 0 and uid 0 for its end:
                # that is "not yet", so look again; once accepted it must belong to this account.
                if int(fields[9]) > 0:
                    require(fields[7].isdecimal() and int(fields[7]) == os.getuid())
                    inodes.add(fields[9])
            if len(fields) >= 10 and fields[1] == local and fields[3] == "0A":
                require(fields[7].isdecimal() and int(fields[7]) == os.getuid() and fields[9].isdecimal())
                listeners.add(fields[9])
        require(len(inodes) <= 1)
        if inodes and listeners == {listener_inode}:
            return
        time.sleep(min(0.02, max(0, deadline - time.monotonic())))
    raise Refused("The local HTTP service identity could not be verified.")


class OwnerAPI:
    """The named local owner's own session on its hive, for the few fixed routes setup needs (the 9 Nov kit's client)."""

    PATHS = re.compile(r"/api/auth/(?:local/exchange|me|logout)|/api/agents(?:/a_[A-Za-z0-9_-]{1,96})?|/api/me/apps"
                       r"|/api/programs/" + STUDIO + r"(?:/install|/activations)?|/api/services(?:/enrol)?")
    # The one removal setup makes: the hive's record of a Code service that is gone (enrol_code).
    REMOVABLE = re.compile(r"/api/services/svc_[0-9a-f]{32}")
    # A route Create's Code service doesn't carry: through the hive's relay it answers 404 not_relayed once the hive's
    # Code guard accepts the service, and the guard's refusal answers 503 (code_accepted).
    RELAY_PROBE = "/api/code/proxy/v1/setup-ready"

    def __init__(self, control, config, home, pid, hello, deadline):
        self.control, self.config, self.home, self.pid, self.hello = control, config, home, pid, hello
        self.deadline, self.token, self.principal = deadline, None, None

    def request(self, method, path, payload=None, *, cleanup=False):
        require(type(path) is str and ((method in {"GET", "POST", "PATCH"} and self.PATHS.fullmatch(path) is not None)
                                       or (method == "DELETE" and payload is None
                                           and self.REMOVABLE.fullmatch(path) is not None))
                and (not cleanup or (method, path) == ("POST", "/api/auth/logout")))
        return self._exchange(method, path, payload, cleanup=cleanup)[1]

    def relay_accepts(self):
        """Whether the hive's Code guard accepts Create's Code service right now (relay_verdict)."""
        return relay_verdict(*self._exchange("GET", self.RELAY_PROBE, None, accept={404, 503}))

    def _exchange(self, method, path, payload, *, cleanup=False, accept=range(200, 300)):
        """One request on the owner's session; returns (status, JSON body) for a status in `accept`, refusing any other."""
        end = time.monotonic() + 5 if cleanup else min(self.deadline, time.monotonic() + 5)
        require(end - time.monotonic() > 0.1, "Setup ran out of time talking to your hive.")
        require(self.control.supervisor_pid(self.home) == self.pid)
        # The service is not dumpable, so /proc/<pid>/exe is unreadable: systemd's record binds its executable, and the
        # one loopback listener must be owned by this account (control.exe_matches / control.listener_matches).
        hello = self.hello
        require(hello.get("pid") == self.pid and self.control.exe_matches(self.config, hello, self.home, self.pid)
                and self.control.listener_matches(self.config, hello))
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw = bytearray()
        try:
            connection.settimeout(max(0.01, end - time.monotonic()))
            connection.connect(("127.0.0.1", self.config["port"]))
            require(connection.getpeername() == ("127.0.0.1", self.config["port"]))
            socket_inode(hello["listener_inode"], self.config["port"], connection.getsockname()[1], end)
            body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
            require(body is None or len(body) <= 16384)
            origin = "http://127.0.0.1:" + str(self.config["port"])
            headers = {"Host": "127.0.0.1:" + str(self.config["port"]), "Origin": origin, "Accept": "application/json",
                       "Connection": "close", "Content-Length": str(len(body or b""))}
            if body is not None:
                headers["Content-Type"] = "application/json"
            if self.token is not None:
                headers["Authorization"] = "Bearer " + self.token
            wire = ((method + " " + path + " HTTP/1.1\r\n")
                    + "".join(key + ": " + value + "\r\n" for key, value in headers.items()) + "\r\n").encode("ascii")
            connection.settimeout(max(0.01, end - time.monotonic()))
            connection.sendall(wire + (body or b""))
            while b"\r\n\r\n" not in raw:
                require(time.monotonic() < end)
                connection.settimeout(max(0.01, end - time.monotonic()))
                block = connection.recv(4096)
                require(block); raw.extend(block); require(len(raw) <= 65536)
            head, initial = bytes(raw).split(b"\r\n\r\n", 1)
            lines = head.decode("ascii").split("\r\n")
            require(1 <= len(lines) <= 41)
            status = re.fullmatch(r"HTTP/1\.[01] ([0-9]{3}) [^\r\n]{0,128}", lines[0])
            require(status is not None and int(status.group(1)) in accept,
                    "Your hive refused a setup step (" + method + " " + path.split("/a_")[0]
                    + (" answered " + status.group(1) if status is not None else "") + ").")
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
                require(time.monotonic() < end)
                connection.settimeout(max(0.01, end - time.monotonic()))
                block = connection.recv(min(65536, size - len(raw)))
                require(block); raw.extend(block)
            require(self.control.supervisor_pid(self.home) == self.pid)
            return int(status.group(1)), strict_json(raw)
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
            finally:
                self.token = None


def relay_verdict(status, value):
    """A relay probe's answer: 404 naming not_relayed means the hive's Code guard let the request through to Code, whose
    route list doesn't carry it (the release smoke reads the same answer), and 503 means the guard refused it."""
    require(status == 503 or (status == 404 and "not_relayed" in json.dumps(value)),
            "Your hive answered the Code check in a way setup doesn't know.")
    return status == 404


def code_accepted(api):
    """Setup ends only once the hive's own Code guard accepts the Code service. enable_proposal_tests has just restarted
    the service, and the guard keeps a refusal for 5 s (hive/core/code.py), so a check made while the service came back
    left a refusal for whatever asked next: on 19 Nov the update check's first request through the relay, a second after
    setup, read one. Asking here until the guard accepts means the install ends with Code ready."""
    while not api.relay_accepts():
        require(time.monotonic() + 1 < api.deadline,
                "Your hive didn't accept Create's Code service after turning on its tests.")
        time.sleep(0.5)


def loopback_listener_owned(port):
    """Whether the one LISTEN socket on 127.0.0.1:<port> belongs to this account, so a token sent there stays ours."""
    fd = os.open("/proc/" + str(os.getpid()) + "/net/tcp", os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(4 * 1024**2 + 1)
    finally:
        os.close(fd)
    require(len(raw) <= 4 * 1024**2)
    local = "0100007F:" + format(port, "04X")
    owners = {fields[7] for fields in (line.split() for line in raw.decode("ascii").splitlines()[1:])
              if len(fields) >= 10 and fields[1] == local and fields[3] == "0A"}
    return owners == {str(os.getuid())}


def code_register(port, token, enrol_token, deadline):
    """POST /v1/operator/register on the Code service, with its operator token, once its listener is up and ours."""
    while not loopback_listener_owned(port):
        require(time.monotonic() + 1 < deadline, "Create's Code service did not start listening in time.")
        time.sleep(0.5)
    body = json.dumps({"enrol_token": enrol_token}, separators=(",", ":")).encode()
    head = ("POST /v1/operator/register HTTP/1.1\r\nHost: 127.0.0.1:" + str(port) + "\r\nAuthorization: Bearer " + token
            + "\r\nContent-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: "
            + str(len(body)) + "\r\n\r\n").encode("ascii")
    connection = socket.create_connection(("127.0.0.1", port), timeout=max(0.1, min(10, deadline - time.monotonic())))
    try:
        connection.sendall(head + body)
        raw = bytearray()
        while b"\r\n" not in raw:
            block = connection.recv(4096)
            require(block and len(raw) + len(block) <= 65536, "Create's Code service gave no answer.")
            raw.extend(block)
    finally:
        connection.close()
    status = re.match(rb"HTTP/1\.[01] ([0-9]{3}) ", bytes(raw))
    require(status is not None and 200 <= int(status.group(1)) < 300,
            "Create's Code service refused its registration with your hive"
            + (" (" + status.group(1).decode() + ")" if status is not None else "") + ".")


def code_registration(root):
    """The service id Create's Code service registered under, from its own state/registration.json (omegacode
    registration.py), or None while it has none: a new Code folder, as every install after an uninstall has, since
    install.py's uninstall removes the folder whole. A pending registration is none yet; omegacode acts on none."""
    try:
        raw = read_owned(Path(root) / "state" / "registration.json", 65536, private=True)
    except FileNotFoundError:
        return None
    saved = strict_json(raw)
    require(type(saved) is dict and type(saved.get("receipt")) is dict)
    if saved["receipt"].get("status") != "active":
        return None
    require(type(saved.get("service_id")) is str and re.fullmatch(r"svc_[0-9a-f]{32}", saved["service_id"]) is not None)
    return saved["service_id"]


def enrol_code(api, config):
    """Create's Code service joins this hive as install/macos/omegahive.sh create() enrols it: the owner asks the hive
    for an enrolment token, and the service, asked with its own operator token, registers with it.

    It has joined only while the hive lists, enabled, the very id the service registered under: the hive proves every
    relay to the service with that id, and the service answers 404 to any other ("relay challenge refused (404)",
    and Create's Code tab and Make fail). An update by uninstall and install removes the Code folder with its
    registration while the hive, its data kept, still lists the old service. So a service without that match enrols
    anew, and the hive's records of any other Code service, one that is gone, are removed once the new one is listed."""
    code = config["code_service"]
    def listed():
        services = api.request("GET", "/api/services")
        require(type(services) is list)
        return [row for row in services if type(row) is dict and row.get("name") == CODE]
    def joined(own, rows):
        return own is not None and any(row.get("id") == own and row.get("enabled", True) for row in rows)
    if joined(code_registration(code["root"]), listed()):
        return
    answer = api.request("POST", "/api/services/enrol", {"name": CODE})
    require(type(answer) is dict and type(answer.get("enrol_token")) is str and answer["enrol_token"])
    enrol_token = answer.pop("enrol_token")
    token = read_owned(Path(code["root"]) / "operator-token", 4096, private=True).decode("ascii").strip()
    require(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token) is not None)
    code_register(code["port"], token, enrol_token, api.deadline)
    own, rows = code_registration(code["root"]), listed()
    require(joined(own, rows), "Create's Code service registered, but your hive doesn't list it.")
    for row in rows:
        if row.get("id") != own:
            api.request("DELETE", "/api/services/" + str(row.get("id")))


def enable_proposal_tests(config, deadline):
    """Create's Code tab tests a proposal once the Code service has joined this hive, as install/macos/code-runtime.py
    enable and omegahive.sh create do on a Mac: the service's purpose listener, which the hive's test runs answer to,
    starts only with proposal_tests_enabled, and install.py writes that off until the service is enrolled. So once
    enrol_code has made the registration this turns it on and restarts the service, which keeps its registration."""
    code = config["code_service"]
    require(code_registration(code["root"]) is not None, "Create's Code service has not joined your hive.")
    path = Path(code["config"])
    value = strict_json(read_owned(path, private=True))
    require(type(value) is dict and value.get("sandbox_project_tests_enabled") is True
            and value.get("repositories", {}).get("small-app", {}).get("execution_policy") == "proposal-only",
            "Create's Code service isn't set up to test proposals in the hive's sandbox.")
    if value.get("proposal_tests_enabled") is True:
        return
    value["proposal_tests_enabled"] = True
    temporary = path.with_name(path.name + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)
    subprocess.run(["/usr/bin/systemctl", "--user", "restart", CODE + ".service"], check=True, timeout=90,
                   stdin=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                                                  "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid())})
    while not loopback_listener_owned(code["port"]):
        require(time.monotonic() + 1 < deadline, "Create's Code service did not come back after turning on its tests.")
        time.sleep(0.5)


def create_controller(api):
    """The Create · Code controller's row, once the foundation has made it (at start, or at this sign-in)."""
    while True:
        minds = api.request("GET", "/api/agents")
        require(type(minds) is list and len(minds) <= 1024)
        found = [row for row in minds if type(row) is dict and row.get("name") == CONTROLLER]
        require(len(found) <= 1, "Your hive has more than one Create · Code controller.")
        if found and type(found[0].get("swarm_id")) is str and found[0]["swarm_id"]:
            return found[0]
        require(time.monotonic() + 2 < api.deadline, "Your hive did not make its Create · Code controller in time.")
        time.sleep(1)


def put_in_create(api, pin):
    """Studio's admin install review by the named owner (P14), turned on in the controller's swarm, so the owner's
    app list shows Create, as install/macos/omegahive.sh create() does on a Mac (use_in empty lists no Create)."""
    entry = api.request("GET", "/api/programs/" + STUDIO)
    require(type(entry) is dict and entry.get("id") == STUDIO and entry.get("digest") == pin["digest"]
            and entry.get("error") is None and entry.get("ui") is True, "Studio did not load in your hive as reviewed.")
    controller = create_controller(api)
    swarm = controller["swarm_id"]
    status = api.request("GET", "/api/programs/" + STUDIO + "/install")
    require(type(status) is dict and status.get("program") == STUDIO and status.get("release_digest") == pin["digest"]
            and status.get("placement") in {"person", "swarm"})
    in_swarm = status["placement"] == "swarm"
    if not (status.get("installed") is True and status.get("release_digest") == pin["digest"]):
        result = api.request("POST", "/api/programs/" + STUDIO + "/install",
                             {"release_digest": pin["digest"], "placement": status["placement"],
                              "use_in": [swarm] if in_swarm else []})
        require(type(result) is dict and result.get("installed") is True and result.get("release_digest") == pin["digest"])
    final = api.request("GET", "/api/programs/" + STUDIO + "/install")
    review = final.get("review") if type(final) is dict else None
    require(final.get("installed") is True and final.get("release_digest") == pin["digest"]
            and type(review) is dict and review.get("revoked") is False
            and review.get("release_digest") == pin["digest"] and review.get("by") == api.principal,
            "Studio's install review did not record as this owner's.")
    if in_swarm:
        active = api.request("GET", "/api/programs/" + STUDIO + "/activations")
        require(type(active) is list)
        if not any(type(row) is dict and row.get("swarm_id") == swarm and row.get("active") is True for row in active):
            api.request("POST", "/api/programs/" + STUDIO + "/activations", {"swarm_id": swarm})
    apps = api.request("GET", "/api/me/apps")
    require(type(apps) is dict and type(apps.get("apps")) is list
            and any(type(row) is dict and row.get("id") == STUDIO and row.get("name") == "Create" for row in apps["apps"]),
            "Studio is installed, but your app list doesn't show Create.")


def bootstrap(runtime):
    require(sys.platform.startswith("linux") and os.getuid() == os.geteuid() != 0 and not sys.flags.optimize)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    require(home == home.resolve(strict=True) and runtime == home / ".local/share/omegahive/runtime.json")
    preliminary = strict_json(read_owned(runtime, private=True))
    release = Path(preliminary.get("release_root", ""))
    require(release.is_absolute() and release == release.resolve(strict=True)
            and release.parent.parent == home / ".local/share/omegahive/releases")
    control = module_from_file(release / "deploy/linux/control.py")
    config, validated_home, _fingerprint = control.runtime(str(runtime))
    require(validated_home == home)
    hello, pid = verify_owner(control, config, home)
    # The executable and loopback listener were checked before any sign-in code is requested.
    signin, observed_pid = control.request(config, home, "signin", expected_pid=pid)
    require(type(signin) is dict and signin.get("ok") is True and observed_pid == pid)
    api = OwnerAPI(control, config, home, pid, hello, time.monotonic() + SETUP_SECONDS)
    try:
        api.login(signin.pop("code", None), hello["owner"])
        signin.clear()
        enrol_code(api, config)
        enable_proposal_tests(config, api.deadline)
        code_accepted(api)
        put_in_create(api, studio_pin(config))
    finally:
        signin.clear(); api.logout()
    print("Your public hive and its local owner are ready, and Create, with its Code service, is on your home screen.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    bootstrap(parser.parse_args().runtime)


def failure_message(error=None):
    if error is not None and type(error).__name__ == "Refused" and str(error) == "control_reply_timeout":
        return "Final setup failed: Hive readiness timed out. Check omegahive status and journalctl --user -u omegahive.service. Rerun this installer after the service is healthy."
    if error is not None and type(error).__name__ in {"MindsRefused", "Refused"} and str(error) not in {"", "The installed hive could not be verified."}:
        return str(error) + " Check journalctl --user -u omegahive.service, then rerun this installer."
    return "The installed hive could not confirm its local owner. Check omegahive status and the user-service journal."


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(failure_message(error), file=sys.stderr)
        raise SystemExit(1)
