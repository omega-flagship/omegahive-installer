#!/usr/bin/env python3
"""Purpose: verify a fresh Linux installation's real sign-in and persistence without logging credentials."""
import argparse
import http.cookiejar
import json
import pathlib
import pwd
import re
import subprocess
import time
import urllib.error
import urllib.request


def redacted(text):
    """Text with every one-use sign-in fragment removed."""
    return re.sub(r"local-signin#[A-Za-z0-9_-]+", "local-signin#<redacted>", text)


def redact(path):
    """Print installer diagnostics with all one-use sign-in fragments removed."""
    print(redacted(pathlib.Path(path).read_text(errors="replace")), end="")


def until(predicate, seconds):
    """Poll a fast local state change (a session appearing, a unit becoming active) for at most `seconds`."""
    end = time.monotonic() + seconds
    while True:
        value = predicate()
        if value or time.monotonic() >= end:
            return value
        time.sleep(0.5)


def verify(user, output):
    """Use the installer's public commands and browser exchange through hive and user-manager restarts and a logout."""
    account = pwd.getpwnam(user)
    home = pathlib.Path(account.pw_dir)
    manager = f"user@{account.pw_uid}.service"
    env = ["env", f"XDG_RUNTIME_DIR=/run/user/{account.pw_uid}"]
    cli = str(home / ".local/bin/omegahive")
    facts = {"user": user, "checks": []}

    def command(*argv):
        return subprocess.run(["sudo", "-iu", user, *env, *argv], check=True,
                              capture_output=True, text=True).stdout

    def check(name, value, detail=None):
        if not value:
            raise RuntimeError(f"Linux smoke check failed: {name}" + (f": {detail}" if detail else ""))
        facts["checks"].append(name)
        print(name + ": passed", flush=True)

    def diagnose(title, *argv):
        done = subprocess.run(list(argv), capture_output=True, text=True)
        print(f"--- {title} (exit {done.returncode}) ---\n" + redacted(done.stdout + done.stderr), flush=True)

    def system(*argv):
        """A root systemctl or loginctl step; on failure the user manager's own account of why is printed first."""
        done = subprocess.run(list(argv), capture_output=True, text=True)
        if done.returncode != 0:
            print(redacted(done.stdout + done.stderr), flush=True)
            diagnose("manager status", "systemctl", "status", manager, "--no-pager", "-l", "-n", "40")
            diagnose("manager journal", "journalctl", "-b", "-u", manager, "--no-pager", "-n", "120", "-o", "short-precise")
            diagnose("account journal", "journalctl", "-b", f"_UID={account.pw_uid}", "--no-pager", "-n", "80", "-o", "short-precise")
            diagnose("login state", "loginctl", "user-status", user, "--no-pager")
            raise RuntimeError(f"Linux smoke step failed: {' '.join(argv)} exited {done.returncode}")

    def private_socket():
        """systemctl --user tries this socket first, and where no user D-Bus socket exists it is the only way in."""
        probe = "import socket, sys; socket.socket(socket.AF_UNIX).connect(sys.argv[1])"
        done = subprocess.run(["sudo", "-iu", user, "python3", "-c", probe, f"/run/user/{account.pw_uid}/systemd/private"],
                              capture_output=True, text=True)
        return done.returncode == 0, (done.stderr.strip().splitlines() or [""])[-1]

    def session_class(sid):
        """The session's logind class, or None once logind no longer has it."""
        done = subprocess.run(["loginctl", "show-session", sid, "-p", "Class", "--value"], capture_output=True, text=True)
        return done.stdout.strip() if done.returncode == 0 else None

    def sessions():
        """The account's login sessions. From systemd 256 (Ubuntu 26.04 has 259) the user manager holds a session of
        its own, class manager or manager-early, which no login opens and logging out leaves alone. Counted as a login,
        it let "a login session is open" pass before su's session existed and left su's session out of the ones
        logging out ends, so the smoke then waited for su's sleep to run out."""
        listed = subprocess.check_output(["loginctl", "show-user", user, "-p", "Sessions", "--value"], text=True).split()
        return [sid for sid in listed if (kind := session_class(sid)) is not None and not kind.startswith("manager")]

    def open_sessions(ids):
        """The sessions among ids that logind still counts as open; one being torn down reads State=closing."""
        left = []
        for sid in ids:
            done = subprocess.run(["loginctl", "show-session", sid, "-p", "State", "--value"], capture_output=True, text=True)
            if done.returncode == 0 and done.stdout.strip() not in ("closing", ""):
                left.append(sid)
        return left

    def active_state(unit):
        done = subprocess.run(["sudo", "-iu", user, *env, "systemctl", "--user", "is-active", unit],
                              capture_output=True, text=True)
        return done.stdout.strip()

    def signin():
        opened = command(cli, "open")
        match = re.search(r"http://127\.0\.0\.1:(\d+)/local-signin#([A-Za-z0-9_-]{43})", opened)
        check("open emits a one-use loopback sign-in link", match is not None)
        port, code = match.groups()
        origin = f"http://127.0.0.1:{port}"
        headers = {"Host": f"127.0.0.1:{port}", "Origin": origin, "Content-Type": "application/json"}
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        body = json.dumps({"code": code}).encode()
        request = urllib.request.Request("http://127.0.0.1:8700/api/auth/local/exchange", body, headers)
        with opener.open(request) as response:
            check("first link exchange succeeds", response.status == 200)
            session = json.load(response)
        token = session.get("token") or session.get("session")
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            with urllib.request.urlopen(request) as response:
                reused = response.status
        except urllib.error.HTTPError as error:
            reused = error.code
        check("used link cannot sign in again", reused in (400, 401, 403, 410))
        me = urllib.request.Request("http://127.0.0.1:8700/api/auth/me", headers=headers)
        with opener.open(me) as response:
            check("signed-in owner endpoint succeeds", response.status == 200)
            identity = json.load(response)
        feedback = urllib.request.Request("http://127.0.0.1:8700/api/feedback", headers=headers)
        with opener.open(feedback) as response:
            version = json.load(response)["version"]
        # The release's own RELEASE_VERSION names the version the hive must report (0.34 says "Linux v0.34 (build …)").
        expected = next((home / ".local/share/omegahive/releases").glob("*/app/RELEASE_VERSION")).read_text().strip()
        check("installed hive reports v" + expected, re.search(r"\bv" + re.escape(expected) + r"\b", version) is not None, version)
        facts["version"] = version
        # The hive's start-time preflight decides whether minds may start (hive/supervisor/sandbox.py report()).
        settings = urllib.request.Request("http://127.0.0.1:8700/api/settings", headers=headers)
        with opener.open(settings) as response:
            sandbox = json.load(response)["mind_sandbox"]
        check("minds can start in their sandbox", sandbox.get("state") == "on", sandbox.get("summary"))
        facts["mind_sandbox"] = sandbox.get("summary")
        with opener.open(urllib.request.Request("http://127.0.0.1:8700/", headers=headers)) as response:
            check("web UI opens", response.status == 200 and b"<html" in response.read().lower())

        def call(method, path, payload=None):
            data = None if payload is None else json.dumps(payload).encode()
            with opener.open(urllib.request.Request("http://127.0.0.1:8700" + path, data, headers, method=method)) as reply:
                raw = reply.read()
            return json.loads(raw) if raw else None

        def status_of(method, path):
            """A route's status and body, an error status included (call() raises on one)."""
            try:
                with opener.open(urllib.request.Request("http://127.0.0.1:8700" + path, None, headers, method=method)) as reply:
                    return reply.status, reply.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()
        call.status_of = status_of
        return {key: identity[key] for key in ("principal", "kind", "role", "person_kind", "local_operator")}, call

    def first_light(call):
        """A real mind starts in its sandbox and answers First Light. A fresh hive's personal mind is on the
        demonstration model, which needs no key, so this runs every part of a mind but the model provider."""
        mind = call("GET", "/api/me/mind")["mind"]
        check("the personal mind starts on the demonstration model", mind["model"].startswith("mock/"), mind["model"])
        call("POST", "/api/me/personal-mind/hello", {})

        def greeted():
            hello = (call("GET", "/api/me/personal-mind/hello") or {}).get("hello") or {}
            if hello.get("state") == "greeted":
                return (hello.get("greeting") or {}).get("text") or None
            if call("GET", "/api/agents/" + mind["id"])["status"] in ("error", "failed", "stopped"):
                return False
            return None
        text = None
        end = time.monotonic() + 600   # a mind's first start (PeTTa loading the core) and its one turn
        while text is None and time.monotonic() < end:
            text = greeted()
            if text is None:
                time.sleep(3)
        if not text:
            diagnose("mind log", "tail", "-n", "60", str(home / ".local/share/omegahive/data/agents" / mind["id"] / "agent.log"))
        check("a mind starts in its sandbox and answers First Light", bool(text), "no greeting")
        facts["first_light"] = redacted(text)[:200]
        call("POST", "/api/agents/" + mind["id"] + "/sleep", {})

    def create_listed(call):
        """Setup put Studio in as Create (deploy/linux/bootstrap.py): the owner's app list shows it, opening in a swarm."""
        apps = call("GET", "/api/me/apps")["apps"]
        create = [app for app in apps if app.get("id") == "omegadesign" and app.get("name") == "Create"]
        check("Create is on the owner's home screen", len(create) == 1, json.dumps(apps)[:400])
        facts["create"] = create[0]["open"]

    def code_service(call):
        """Create's Code service (deploy/linux/install.py code_service and bootstrap.py enrol_code): its unit runs, its
        AppArmor profile confines it, the hive lists it at its port, and the hive's Code guard accepts it, so a request
        through the hive's relay passes the release check (503 service_release_mismatch) and reaches the route list,
        which answers not_relayed for a route it doesn't carry."""
        unit = ["systemctl", "--user", "show", "-p", "ActiveState", "-p", "MainPID", "omegacode.service"]
        state = dict(line.split("=", 1) for line in command(*unit).splitlines() if "=" in line)
        check("Create's Code service is running", state.get("ActiveState") == "active", json.dumps(state))
        label = pathlib.Path(f"/proc/{state['MainPID']}/attr/current").read_text().strip()
        check("Create's Code service runs in its AppArmor profile", f"omegahive-code-{account.pw_uid}" in label, label)
        facts["code_confinement"] = label
        listed = [row for row in call("GET", "/api/services") if row.get("name") == "omegacode"]
        check("the hive lists its Code service", len(listed) == 1 and listed[0].get("address") == "http://127.0.0.1:8724",
              json.dumps(listed)[:300])
        status, body = call.status_of("GET", "/api/code/proxy/v1/smoke-unlisted-route")
        check("the hive's Code guard accepts its Code service", status == 404 and b"not_relayed" in body,
              f"{status} {body[:300]!r}")

    def code_tests(call):
        """Create's Code tab tests a proposal on Linux's own sandbox (deploy/linux/install.py code_service, serve.py and
        bootstrap.py enable_proposal_tests): the small app is proposal-only with its tests on once Code has joined, the
        hive runs with the project test pinned, allowed and claimable, the release's pinned Node beside the sandbox's
        Python answers with the version x86_64-pins.json pins, and the hive itself says its Code resource owner is ready,
        the condition under which it offers a test at all (hive/core/code_project_tests.py execution_available): the
        settings alone passed on 19 Nov on hives whose owner never started."""
        config = json.loads((home / ".local/share/omegahive/code/config.json").read_text())
        small = config["repositories"]["small-app"]
        check("Create's Code service tests proposals in the hive's sandbox",
              config.get("proposal_tests_enabled") is True and config.get("sandbox_project_tests_enabled") is True
              and small.get("execution_policy") == "proposal-only",
              json.dumps({key: config.get(key) for key in ("proposal_tests_enabled", "sandbox_project_tests_enabled")}) + json.dumps(small))
        shown = command("systemctl", "--user", "show", "-p", "MainPID", "omegahive.service")
        pid = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)["MainPID"]
        raw = pathlib.Path(f"/proc/{pid}/environ").read_bytes().decode("utf-8", "replace")
        hive = dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)
        prefixes = json.loads(hive.get("HIVE_PROPOSAL_TEST_ARGV_PREFIXES") or "[]")
        check("the hive runs proposal tests through its pinned project test",
              hive.get("HIVE_PROPOSAL_TEST_CLAIMS") == "on" and hive.get("HIVE_CODE_SANDBOX_PROJECT_TESTS") == "on"
              and "code-project-test" in hive.get("HIVE_SANDBOX_RUN_APPS", "").split(",")
              and "code-project-test" in json.loads(hive.get("HIVE_APP_PINS") or "{}")
              and len(prefixes) == 1 and prefixes[0][1:] == ["check_app.py"],
              json.dumps({"prefixes": prefixes, "apps": hive.get("HIVE_SANDBOX_RUN_APPS")}))
        pinned = json.loads(pathlib.Path(__file__).with_name("x86_64-pins.json").read_text())["node"]["version"]
        version = command(str(pathlib.Path(prefixes[0][0]).with_name("node")), "--version").strip()
        check("the Node beside the sandbox's Python is the pinned one", version == "v" + pinned, version)
        resources = call("GET", "/api/hive").get("code_resources") or {}
        check("the hive's Code resource owner is ready for a proposal test",
              resources.get("linux_execution_enabled") is True and (resources.get("bootstrap") or {}).get("phase") == "ready",
              json.dumps({key: resources.get(key) for key in ("phase", "linux_execution_enabled", "bootstrap")})[:300])
        facts["code_tests"] = {"node": version, "test_command": prefixes[0], "resource_phase": resources.get("phase")}

    def code_stops_cleanly():
        """A stop of Create's Code service ends the way systemd counts as clean. After its graceful shutdown uvicorn
        raises SIGTERM at itself, and on Ubuntu 26.04 the unit runs under its profile stacked on unconfined, so unless the
        profile lets that label signal itself (deploy/linux/install.py code_profile) Python exits 1 and the unit reads
        failed. It is started again before the verdict, so a failure still leaves the service as the hive had it."""
        unit = "omegacode.service"
        command("systemctl", "--user", "stop", unit)
        shown = command("systemctl", "--user", "show", "-p", "Result", "-p", "ExecMainCode", "-p", "ExecMainStatus", unit)
        state = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
        command("systemctl", "--user", "start", unit)
        check("Create's Code service stops cleanly", state.get("Result") == "success", json.dumps(state))
        check("Create's Code service starts again", until(lambda: active_state(unit) == "active", 30), active_state(unit))

    def make_on(call):
        """Create's Make, on in every install (hive/core/config.py): its plan list answers, as it does only while the
        plan engine runs, which needs no model, so the demonstration model's install shows it too."""
        status, body = call.status_of("GET", "/api/create/plans")
        check("Create's Make is on", status == 200, f"{status} {body[:300]!r}")

    try:
        check("linger is enabled", subprocess.check_output(
            ["loginctl", "show-user", user, "-p", "Linger", "--value"], text=True).strip() == "yes")
        check("the user manager answers on its private socket", *private_socket())
        check("service is enabled", command("systemctl", "--user", "is-enabled", "omegahive.service").strip() == "enabled")
        first, call = signin()
        first_light(call)
        create_listed(call)
        code_service(call)
        code_tests(call)
        code_stops_cleanly()
        make_on(call)
        check("status is available", bool(json.loads(command(cli, "status", "--json"))))
        command("systemctl", "--user", "restart", "omegahive.service")
        check("owner survives hive restart", signin()[0] == first)
        # A real login session (su's PAM stack registers one with logind), then every session ended, as at logout.
        login = subprocess.Popen(["su", "-l", user, "-c", "exec sleep 600"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        check("a login session is open", until(sessions, 30), "logind registered no session for su -l")
        ended = sessions()
        for session in ended:
            system("loginctl", "terminate-session", session)
        login.wait()
        facts["sessions_ended"] = len(ended)
        if not until(lambda: not open_sessions(ended), 30):
            for sid in open_sessions(ended):
                diagnose("session " + sid, "loginctl", "session-status", sid, "--no-pager")
        check("every login session ended", not open_sessions(ended), " ".join(open_sessions(ended)))
        check("hive survives logout", active_state("omegahive.service") == "active")
        # A reboot, as far as one runner can show it: the manager stopped, then started the way linger starts it at
        # boot, and the hive must come up by itself before anyone runs omegahive open.
        system("systemctl", "stop", manager)
        system("systemctl", "start", manager)
        check("hive starts with the user manager", until(lambda: active_state("omegahive.service") == "active", 60),
              active_state("omegahive.service"))
        again, call = signin()
        check("owner survives user-manager restart", again == first)
        create_listed(call)
        code_service(call)
        code_tests(call)
        make_on(call)
        facts["passed"] = True
    finally:
        pathlib.Path(output).write_text(json.dumps(facts, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("redact").add_argument("path")
    check_parser = sub.add_parser("verify")
    check_parser.add_argument("user")
    check_parser.add_argument("output")
    args = parser.parse_args()
    if args.operation == "redact":
        redact(args.path)
    else:
        verify(args.user, args.output)
