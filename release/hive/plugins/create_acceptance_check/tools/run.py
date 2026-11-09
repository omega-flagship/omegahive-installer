"""Pinned runner for a Create plan's acceptance check. Run only through the sandbox:run boundary (no network, a fresh
job folder, CPU and size limits). Input: snapshot.json {"files": {relpath: text}, "check": relpath}. The files under test
are written under ./build and the check under ./judge (outside build). The check runs in this same process (strict
macOS mode may deny fork) with ./build as its working directory, and NOTHING from build is importable: neither build
nor the working directory is on sys.path, so a piece file named like a stdlib module (re.py, json.py, html/) can never
shadow what the check imports. Its stdout is passed through; the host reads the last CREATE-CHECK line."""
import json
import os
import pathlib
import runpy
import sys

MAX_INPUT = 20 * 1024 * 1024
MAX_FILES = 200


def safe(rel):
    p = pathlib.PurePosixPath(rel)
    if p.is_absolute() or not p.parts or any(part in ("", ".", "..") for part in p.parts) or len(rel) > 300:
        raise ValueError("unsafe path in snapshot")
    return p


def main():
    job = pathlib.Path.cwd()
    fd = os.open(job / "snapshot.json", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        raw = source.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("snapshot too large")
    data = json.loads(raw)
    files, check = data["files"], data["check"]
    if not isinstance(files, dict) or len(files) > MAX_FILES or check not in files:
        raise ValueError("bad snapshot")
    build, judge = job / "build", job / "judge"
    for rel, text in files.items():
        if rel == check:
            continue
        target = build / safe(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(text), encoding="utf-8")
    build.mkdir(exist_ok=True)
    judge.mkdir()
    script = judge / "acceptance_check.py"
    script.write_text(str(files[check]), encoding="utf-8")
    here = os.path.dirname(os.path.abspath(__file__))
    blocked = {os.path.realpath(p) for p in (str(build), str(job), here, "")}
    sys.path[:] = [p for p in sys.path if p and os.path.realpath(p) not in blocked]
    for name in list(sys.modules):               # nothing imported from the runner's own folder stays cached
        f = getattr(sys.modules[name], "__file__", None) or ""
        if f and os.path.realpath(f).startswith(os.path.realpath(str(job)) + os.sep):
            del sys.modules[name]
    os.chdir(build)
    sys.argv = [check]
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
