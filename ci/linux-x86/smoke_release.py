#!/usr/bin/env python3
"""Purpose: verify a fresh Linux installation's real sign-in and persistence without logging credentials."""
import argparse
import http.cookiejar
import json
import pathlib
import pwd
import re
import subprocess
import urllib.error
import urllib.request


def redact(path):
    """Print installer diagnostics with all one-use sign-in fragments removed."""
    text = pathlib.Path(path).read_text(errors="replace")
    print(re.sub(r"local-signin#[A-Za-z0-9_-]+", "local-signin#<redacted>", text), end="")


def verify(user, output):
    """Use the installer's public commands and browser exchange before and after a service-manager restart."""
    account = pwd.getpwnam(user)
    home = pathlib.Path(account.pw_dir)
    env = ["env", f"XDG_RUNTIME_DIR=/run/user/{account.pw_uid}"]
    cli = str(home / ".local/bin/omegahive")
    facts = {"user": user, "checks": []}

    def command(*argv):
        return subprocess.run(["sudo", "-iu", user, *env, *argv], check=True,
                              capture_output=True, text=True).stdout

    def check(name, value):
        if not value:
            raise RuntimeError(f"Linux smoke check failed: {name}")
        facts["checks"].append(name)
        print(name + ": passed", flush=True)

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
        with opener.open(urllib.request.Request("http://127.0.0.1:8700/", headers=headers)) as response:
            check("web UI opens", response.status == 200 and b"<html" in response.read().lower())
        return {key: identity[key] for key in ("principal", "kind", "role", "person_kind", "local_operator")}

    try:
        check("linger is enabled", subprocess.check_output(
            ["loginctl", "show-user", user, "-p", "Linger", "--value"], text=True).strip() == "yes")
        check("service is enabled", command("systemctl", "--user", "is-enabled", "omegahive.service").strip() == "enabled")
        first = signin()
        check("status is available", bool(json.loads(command(cli, "status", "--json"))))
        command("systemctl", "--user", "restart", "omegahive.service")
        check("owner survives hive restart", signin() == first)
        sessions = subprocess.check_output(["loginctl", "show-user", user, "-p", "Sessions", "--value"], text=True).split()
        for session in sessions:
            subprocess.run(["loginctl", "terminate-session", session], check=True)
        check("hive survives logout", command("systemctl", "--user", "is-active", "omegahive.service").strip() == "active")
        subprocess.run(["systemctl", "restart", f"user@{account.pw_uid}.service"], check=True)
        check("owner survives user-manager restart", signin() == first)
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
