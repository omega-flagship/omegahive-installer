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

    def sessions():
        return subprocess.check_output(["loginctl", "show-user", user, "-p", "Sessions", "--value"], text=True).split()

    def open_sessions(ids):
        """The sessions among ids that logind still counts as open; one being torn down reads State=closing."""
        left = []
        for sid in ids:
            done = subprocess.run(["loginctl", "show-session", sid, "-p", "State", "--value"], capture_output=True, text=True)
            if done.returncode == 0 and done.stdout.strip() not in ("closing", ""):
                left.append(sid)
        return left

    def hive_state():
        done = subprocess.run(["sudo", "-iu", user, *env, "systemctl", "--user", "is-active", "omegahive.service"],
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
        check("installed hive reports v0.33", re.search(r"\bv0\.33\b", version) is not None)
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

    try:
        check("linger is enabled", subprocess.check_output(
            ["loginctl", "show-user", user, "-p", "Linger", "--value"], text=True).strip() == "yes")
        check("the user manager answers on its private socket", *private_socket())
        check("service is enabled", command("systemctl", "--user", "is-enabled", "omegahive.service").strip() == "enabled")
        first, call = signin()
        first_light(call)
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
        check("hive survives logout", hive_state() == "active")
        # A reboot, as far as one runner can show it: the manager stopped, then started the way linger starts it at
        # boot, and the hive must come up by itself before anyone runs omegahive open.
        system("systemctl", "stop", manager)
        system("systemctl", "start", manager)
        check("hive starts with the user manager", until(lambda: hive_state() == "active", 60), hive_state())
        check("owner survives user-manager restart", signin()[0] == first)
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
