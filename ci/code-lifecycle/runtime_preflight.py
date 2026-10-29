"""Read-only admission of the bare, pinned Linux Code runtime.

The caller is root.  This helper never imports OmegaCode, installs anything,
changes ownership, or starts the service.  Diagnostics are fixed codes so a
failed qualification cannot disclose environment or configuration contents.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess


LOCK_SHA256 = "d31b5e35f103c7d7d7d75649ff93ba2786e0113fb49197adf0480fd9a5552db5"
_MAX_FILES = 100_000


def _fail(code: str) -> None:
    raise RuntimeError(code) from None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _protected_chain(path: Path, uid: int) -> None:
    """Reject a service-writable inode or any replaceable ancestor.

    ACL write grants are constrained by the group permission mask.  Rejecting
    all group/other write bits is intentionally stricter than group membership.
    A root/other-owned sticky directory such as /tmp can contain a protected
    child; its sticky semantics prevent the service UID replacing that child.
    """
    for item in (path, *path.parents):
        info = item.lstat()
        if info.st_uid == uid:
            _fail("runtime_service_owned")
        if stat.S_ISLNK(info.st_mode):
            continue
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            _fail("runtime_special_file")
        if info.st_mode & 0o022:
            if not (stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX):
                _fail("runtime_writable")


def _inside(path: Path, roots: tuple[Path, ...]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def _scan_immutable(roots: tuple[Path, ...], uid: int) -> None:
    """Check startup hooks before Python site initialization can execute them."""
    count = 0
    visited: set[Path] = set()
    for root in roots:
        _protected_chain(root, uid)
        for directory, dirs, files in os.walk(root, followlinks=False):
            current = Path(directory)
            for item in (current, *(current / name for name in dirs + files)):
                if item in visited:
                    continue
                visited.add(item)
                count += 1
                if count > _MAX_FILES:
                    _fail("runtime_inventory_limit")
                name = item.name
                if (name.endswith(".pth") or name in {"sitecustomize", "usercustomize"}
                        or name.startswith(("sitecustomize.", "usercustomize."))):
                    _fail("runtime_startup_hook")
                _protected_chain(item, uid)
                if item.is_symlink():
                    target = item.resolve(strict=True)
                    if not _inside(target, roots):
                        _fail("runtime_symlink_escape")
                    _protected_chain(target, uid)


_INSPECTION = r'''
import base64
import csv
import hashlib
import importlib.machinery
import importlib.metadata
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import site
import stat
import sys

def fail(code):
    raise RuntimeError(code)

def file_hash(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h

def immutable(path):
    if os.access(path, os.W_OK, effective_ids=True):
        fail("runtime_service_writable")

try:
    if sys.implementation.name != "cpython" or tuple(sys.version_info[:3]) != (3, 12, 16):
        fail("runtime_python_version")
    if sys.version_info.releaselevel != "final" or sys.flags.no_user_site != 1:
        fail("runtime_python_flags")
    runtime = Path(spec["runtime"])
    base = Path(spec["base"])
    release = Path(spec["release"])
    work = Path(spec["work"])
    executable = Path(spec["python"])
    if (Path(sys.prefix).resolve() != runtime or Path(sys.base_prefix).resolve() != base
            or Path(sys.executable) != executable or executable.resolve() != Path(spec["real_python"])):
        fail("runtime_interpreter_identity")
    if Path.cwd() != work or list(work.iterdir()):
        fail("runtime_work_directory")
    if site.ENABLE_USER_SITE is not False:
        fail("runtime_user_site")
    packages = runtime / "lib" / "python3.12" / "site-packages"
    allowed = {work, release, base / "lib" / "python3.12",
               base / "lib" / "python3.12" / "lib-dynload", packages,
               base / "lib" / "python312.zip"}
    seen = set()
    for entry in sys.path:
        candidate = Path(entry).resolve() if entry else work
        if candidate not in allowed:
            fail("runtime_unpinned_sys_path")
        seen.add(candidate)
        if candidate.exists() and candidate != work:
            immutable(candidate)
    if not {work, release, packages}.issubset(seen):
        fail("runtime_missing_sys_path")
    user_site = site.getusersitepackages()
    if any(Path(p).resolve() in seen for p in ([user_site] if isinstance(user_site, str) else user_site)):
        fail("runtime_user_site")
    if any(Path(p).resolve() != packages for p in site.getsitepackages()):
        fail("runtime_unpinned_site")
    origin = importlib.machinery.PathFinder.find_spec("omegacode", sys.path)
    if (origin is None or origin.origin is None
            or Path(origin.origin) != release / "omegacode" / "__init__.py"
            or origin.loader is None):
        fail("runtime_package_origin")
    immutable(executable.resolve())
    immutable(Path(origin.origin))
    canonical = lambda name: re.sub(r"[-_.]+", "-", name).lower()
    distributions = list(importlib.metadata.distributions())
    installed = {}
    inventory = []
    recorded = set()
    for dist in distributions:
        name = canonical(dist.metadata["Name"])
        if name in installed or spec["packages"].get(name) != dist.version:
            fail("runtime_distribution_closure")
        installed[name] = dist.version
        if Path(dist.locate_file("")).resolve() != packages:
            fail("runtime_distribution_location")
        entries = dist.files
        if not entries:
            fail("runtime_record_missing")
        record_entries = [entry for entry in entries
                          if entry.name == "RECORD" and entry.parent.name.endswith(".dist-info")]
        if len(record_entries) != 1:
            fail("runtime_record_missing")
        record_path = Path(dist.locate_file(record_entries[0])).resolve(strict=True)
        if record_path.stat().st_size > 8 * 1024 * 1024:
            fail("runtime_record_limit")
        rows = csv.reader(io.StringIO(record_path.read_text(encoding="utf-8")))
        per_dist = set()
        for row in rows:
            if len(row) != 3 or not row[0] or "\x00" in row[0] or "\\" in row[0]:
                fail("runtime_record_invalid")
            relative, encoded_hash, size = row
            if PurePosixPath(relative).is_absolute():
                fail("runtime_record_escape")
            target = Path(dist.locate_file(relative)).resolve(strict=True)
            if runtime not in target.parents or not target.is_file():
                fail("runtime_record_escape")
            if target in per_dist:
                fail("runtime_record_duplicate")
            per_dist.add(target)
            recorded.add(target)
            immutable(target)
            actual = file_hash(target)
            if encoded_hash:
                algorithm, separator, expected = encoded_hash.partition("=")
                if not separator or algorithm not in {"sha256", "sha384", "sha512"}:
                    fail("runtime_record_hash_algorithm")
                measured = actual if algorithm == "sha256" else file_hash(target, algorithm)
                if base64.urlsafe_b64encode(measured.digest()).rstrip(b"=").decode("ascii") != expected:
                    fail("runtime_record_hash_mismatch")
                if not size.isdecimal() or int(size) != target.stat().st_size:
                    fail("runtime_record_size")
            elif target != record_path and target.suffix != ".pyc":
                fail("runtime_record_hash_missing")
            elif size and (not size.isdecimal() or int(size) != target.stat().st_size):
                fail("runtime_record_size")
            inventory.append([name, dist.version, relative, actual.hexdigest()])
    if installed != spec["packages"] or len(installed) != 17:
        fail("runtime_distribution_closure")
    for target in packages.rglob("*"):
        if target.is_file() and target.resolve() not in recorded:
            fail("runtime_unrecorded_file")
    closure = hashlib.sha256(json.dumps(sorted(inventory), separators=(",", ":"),
                                       ensure_ascii=True).encode("ascii")).hexdigest()
    print(json.dumps({"version": "3.12.16", "interpreter_sha256": file_hash(executable.resolve()).hexdigest(),
                      "distribution_count": 17, "distribution_inventory_sha256": closure,
                      "lock_sha256": spec["lock_sha256"], "package_origin_verified": True}, sort_keys=True))
except BaseException as error:
    code = str(error) if isinstance(error, RuntimeError) else "runtime_inspection_failed"
    if not re.fullmatch(r"runtime_[a-z_]+", code):
        code = "runtime_inspection_failed"
    print(json.dumps({"error": code}))
    sys.exit(1)
'''


def verify_runtime(python: Path, runtime_lock: Path, home: Path, user: str,
                   release: Path) -> dict:
    """Return metadata only after admitting the exact immutable runtime closure."""
    try:
        if os.geteuid() != 0:
            _fail("runtime_root_required")
        if not isinstance(user, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user):
            _fail("runtime_user_invalid")
        account = pwd.getpwnam(user)
        if account.pw_uid == 0:
            _fail("runtime_nonroot_user_required")
        python, runtime_lock, home, release = map(Path, (python, runtime_lock, home, release))
        if not all(path.is_absolute() for path in (python, runtime_lock, home, release)):
            _fail("runtime_absolute_path_required")
        if home.resolve(strict=True) != Path(account.pw_dir).resolve(strict=True):
            _fail("runtime_home_identity")
        home = home.resolve(strict=True)
        release = release.resolve(strict=True)
        work = home / "work"
        for directory in (home, work):
            info = directory.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid
                    or info.st_mode & 0o077):
                _fail("runtime_work_directory")
        if list(work.iterdir()):
            _fail("runtime_work_directory")
        if not runtime_lock.is_file() or runtime_lock.stat().st_size > 1024 * 1024:
            _fail("runtime_lock_mismatch")
        lock_bytes = runtime_lock.read_bytes()
        if hashlib.sha256(lock_bytes).hexdigest() != LOCK_SHA256:
            _fail("runtime_lock_mismatch")
        packages = {}
        for line in lock_bytes.decode("utf-8").splitlines():
            match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([^\s;]+)\s*\\?", line)
            if match:
                name = re.sub(r"[-_.]+", "-", match[1]).lower()
                if name in packages:
                    _fail("runtime_lock_duplicate")
                packages[name] = match[2]
        if len(packages) != 17:
            _fail("runtime_lock_closure")
        if python.parent.name != "bin":
            _fail("runtime_venv_layout")
        _protected_chain(python, account.pw_uid)
        runtime = python.parent.parent.resolve(strict=True)
        cfg = runtime / "pyvenv.cfg"
        _protected_chain(cfg, account.pw_uid)
        settings = {}
        for line in cfg.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator:
                settings[key.strip().lower()] = value.strip()
        if settings.get("include-system-site-packages", "").lower() != "false":
            _fail("runtime_system_site_enabled")
        base_home = Path(settings.get("home", ""))
        if not base_home.is_absolute() or base_home.name != "bin":
            _fail("runtime_base_layout")
        base = base_home.parent.resolve(strict=True)
        real_python = python.resolve(strict=True)
        if not _inside(real_python, (base, runtime)):
            _fail("runtime_interpreter_escape")
        if not python.is_file() or not os.access(python, os.X_OK):
            _fail("runtime_interpreter_invalid")
        if not release.is_dir() or set(p.name for p in release.iterdir()) != {"omegacode"}:
            _fail("runtime_release_layout")
        _scan_immutable((runtime, base, release), account.pw_uid)
        runuser = Path("/usr/sbin/runuser")
        if not runuser.is_file():
            _fail("runtime_runuser_missing")
        spec = {"runtime": str(runtime), "base": str(base), "release": str(release),
                "work": str(work), "python": str(python), "real_python": str(real_python),
                "packages": packages, "lock_sha256": LOCK_SHA256}
        program = "spec = " + repr(spec) + "\n" + _INSPECTION
        command = [str(runuser), "-u", user, "--", "/usr/bin/env", "-i",
                   "HOME=" + str(home), "PATH=/usr/bin:/bin", "PYTHONPATH=" + str(release),
                   "PYTHONNOUSERSITE=1", str(python), "-B", "-s", "-c", program]
        result = subprocess.run(command, cwd=work, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=120, check=False, env={"PATH": "/usr/bin:/bin"})
        if len(result.stdout) > 4096 or len(result.stderr) > 4096:
            _fail("runtime_inspection_output_limit")
        try:
            report = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            _fail("runtime_inspection_failed")
        if result.returncode or not isinstance(report, dict) or "error" in report:
            code = report.get("error") if isinstance(report, dict) else None
            _fail(code if isinstance(code, str) and re.fullmatch(r"runtime_[a-z_]+", code)
                  else "runtime_inspection_failed")
        expected_keys = {"version", "interpreter_sha256", "distribution_count",
                         "distribution_inventory_sha256", "lock_sha256", "package_origin_verified"}
        if (set(report) != expected_keys or report["version"] != "3.12.16"
                or report["distribution_count"] != 17 or report["lock_sha256"] != LOCK_SHA256
                or report["package_origin_verified"] is not True
                or not all(isinstance(report[key], str) and re.fullmatch(r"[0-9a-f]{64}", report[key])
                           for key in ("interpreter_sha256", "distribution_inventory_sha256"))
                or report["interpreter_sha256"] != _sha256(real_python)):
            _fail("runtime_inspection_report_invalid")
        return report
    except RuntimeError as error:
        code = str(error)
        _fail(code if re.fullmatch(r"runtime_[a-z_]+", code) else "runtime_preflight_failed")
    except subprocess.TimeoutExpired:
        _fail("runtime_inspection_timeout")
    except Exception:
        _fail("runtime_preflight_failed")
