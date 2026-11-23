#!/usr/bin/env python3
"""Purpose: restart one installed Mac hive only while its minds sleep or its owner approves that exact release."""
import argparse
import contextlib
import fcntl
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import sys


class RestartRefused(Exception):
    """A safety precondition was not established; no launcher action has run."""


# Time: m mind rows plus p bytes of job metadata and one launchd call. Space: p bytes plus b blocker ids, b <= m.
def restart(home: Path, allow_awake: str = "") -> None:
    home = home.resolve(strict=True)
    launcher = home / "app/install/macos/omegahive.sh"
    if not (home / "installed").is_file() or not launcher.is_file():
        raise RestartRefused("this folder has no finished installer hive")
    # Share the updater's lock, without replacing its inode or removing another run's lock.
    lock_path = home / "run/update.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RestartRefused("an update check or refresh holds this hive's update lock") from exc
        # Read mutable approval inputs only after excluding an intervening refresh.
        commit = (home / "app/RELEASE_COMMIT").read_text().strip()
        if re.fullmatch(r"[0-9a-f]{40}", commit) is None:
            raise RestartRefused("the installed release has no full commit to approve")
        if allow_awake and allow_awake != commit:
            raise RestartRefused("ALLOW_AWAKE must name this installed release's exact full commit")
        # Validate the registered target before taking the short lifecycle write fence.
        labels = []
        for path in (home / "run").glob("*.plist"):
            job = plistlib.loads(path.read_bytes())
            if not isinstance(job, dict):
                raise RestartRefused("launchd job metadata is not a dictionary")
            args = job.get("ProgramArguments")
            env = job.get("EnvironmentVariables", {})
            if not (isinstance(args, list) and len(args) == 3 and args[0] == "/bin/bash" and args[2] == "run"):
                continue
            if (not isinstance(args[1], str) or not isinstance(env, dict)
                    or not isinstance(env.get("OMEGAHIVE_HOME"), str)):
                raise RestartRefused("the hive's launchd job does not name its folder")
            if Path(args[1]).resolve() == launcher and Path(env["OMEGAHIVE_HOME"]).resolve() == home:
                label = job.get("Label")
                if not isinstance(label, str) or not re.fullmatch(r"org\.omegahive\.hive\.[0-9]+", label):
                    raise RestartRefused("the hive's launchd job has no installer label")
                labels.append(label)
        if len(labels) != 1:
            raise RestartRefused("exactly one launchd job must name this installed hive")
        target = f"gui/{os.getuid()}/{labels[0]}"
        # Current lifecycle/Studio starts write 'starting' before their driver effect. Fence that write until launchd
        # has started the replacement (-p); closing rolls this unchanged transaction back, including on an error.
        uri = (home / "data/hive.db").as_uri() + "?mode=rw"
        with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=0)) as db:
            db.execute("BEGIN IMMEDIATE")
            blockers = [row[0] for row in db.execute(
                "SELECT id FROM agents WHERE deleted = 0 AND COALESCE(kind, 'omega') != 'module' "
                "AND (status IS NOT 'asleep' OR desired IS NOT 'asleep')")]
            if blockers and not allow_awake:
                raise RestartRefused("minds are not asleep: " + ", ".join(blockers))
            reason = "owner approved exact commit" if allow_awake else "all managed minds are asleep"
            print(f"Safe restart allowed: {reason}; release {commit}; job {labels[0]}.", flush=True)
            # One launchd-owned effect survives termination of a requester running beneath the old job.
            subprocess.run(["/bin/launchctl", "kickstart", "-k", "-p", target], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("home", type=Path, help="the installed hive's folder")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("Safe restart refused: this entry point is for an installed Mac hive.", file=sys.stderr)
        return 3
    os.umask(0o077)
    try:
        restart(args.home, os.environ.get("ALLOW_AWAKE", ""))
    except RestartRefused as exc:
        print(f"Safe restart refused: {exc}; no restart performed.", file=sys.stderr)
        return 3
    except (OSError, sqlite3.Error, UnicodeError, plistlib.InvalidFileException) as exc:
        print(f"Safe restart could not establish its inputs: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"Safe restart's {Path(exc.cmd[0]).name} failed with exit {exc.returncode}.", file=sys.stderr)
        return exc.returncode if exc.returncode > 0 else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
