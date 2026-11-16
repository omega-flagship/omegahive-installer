"""Purpose: verify the installed public hive's named local owner without creating apps, minds or model calls."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import types

CONTROL_PIN = (26945, "1d9a6909c72106ac42bba4758b7a1dc9404fb59201f85a928b8b282ac86d8a87")


class Refused(Exception):
    pass


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


def verify_owner(control, config, home):
    """Bind the hello reply to this account's enabled service and its one loopback listener."""
    require(config["app_pins"] == {} and config["plugin_dirs"] == []
            and config["studio_maker_template"] is None,
            "The public release must not configure external app packages or a Studio template.")
    control.loader_agreement(config)
    hello, pid = control.wait_for_hello(config, home)
    require(type(hello) is dict and hello.get("ok") is True and hello.get("local_owner") is True
            and hello.get("pid") == pid and hello.get("port") == config["port"]
            and type(hello.get("instance")) is str and type(hello.get("owner")) is str
            and re.fullmatch(r"user:u_[A-Za-z0-9_-]+", hello["owner"]))
    require(control.exe_matches(config, hello, home, pid) and control.listener_matches(config, hello))


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
    verify_owner(control, config, home)
    print("Your public hive and its local owner are ready.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    bootstrap(parser.parse_args().runtime)


def failure_message(error=None):
    if error is not None and type(error).__name__ == "Refused" and str(error) == "control_reply_timeout":
        return "Final setup failed: Hive readiness timed out. Check omegahive status and journalctl --user -u omegahive.service. Rerun this installer after the service is healthy."
    return "The installed hive could not confirm its local owner. Check omegahive status and the user-service journal."


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(failure_message(error), file=sys.stderr)
        raise SystemExit(1)
