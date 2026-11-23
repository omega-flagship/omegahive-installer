"""Purpose: run one command in the sandbox an Iter mind thinks in code with. The MeTTa it runs, and any Prolog, Python
or program that MeTTa reaches, may read what the worker reads but write only one scratch folder, open no TCP connection
and create no unix socket, so nothing it starts can change a file the worker's loop loads.

Run as: python3 -I -B _think_sandbox.py <scratch folder> -- <command...>
It restricts itself with the hive's own Landlock and seccomp helpers (hive/supervisor/landlock.py, restrict_writes and
deny_unix_sockets, at the path HIVE_THINK_SANDBOX_LIB names), then execs the command, and every process the command
starts keeps those restrictions. Where that sandbox can't be built it runs nothing: it prints THINK-SANDBOX-UNAVAILABLE
and exits 75, and the caller asks the hive's gate instead. That is the case on Linux without Landlock. macOS refuses a
second sandbox inside the one a mind already runs in (sandbox_init: Operation not permitted), so there the caller
skips this helper and runs PeTTa as a swipl of its own, which the mind's profile limits the same way, except that it
starts no program at all, since a program it started would not carry those limits (hive/supervisor/sandbox.py,
think_swipl and profile).
"""

import importlib.util
import os
import platform
import sys

UNAVAILABLE = 75   # EX_TEMPFAIL: nothing ran, the caller asks the gate instead
MARK = "THINK-SANDBOX-UNAVAILABLE"


def restrict(scratch):
    """Restrict this process, for good, to writing beneath scratch with no TCP and no unix sockets, or raise."""
    if platform.system() != "Linux":
        raise OSError(f"{platform.system()} can't sandbox thinking in code inside a mind's own sandbox")
    path = os.environ.get("HIVE_THINK_SANDBOX_LIB", "")
    if not path:
        raise OSError("the hive named no sandbox library (HIVE_THINK_SANDBOX_LIB)")
    spec = importlib.util.spec_from_file_location("hive_landlock", path)
    landlock = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(landlock)
    landlock.restrict_writes([scratch])
    landlock.deny_unix_sockets()


def main(argv):
    if len(argv) < 4 or argv[2] != "--":
        print("usage: _think_sandbox.py <scratch folder> -- <command...>", file=sys.stderr)
        return 2
    try:
        restrict(argv[1])
    except Exception as exc:   # noqa: BLE001  any failure to build the sandbox runs nothing
        print(f"{MARK} {type(exc).__name__}: {exc}", file=sys.stderr)
        return UNAVAILABLE
    os.environ.pop("HIVE_THINK_SANDBOX_LIB", None)
    os.execvp(argv[3], argv[3:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
