#!/usr/bin/env python3
"""R1.4.2-candidate Hyperon worker acceptance controller; native CI execution only.

Standard library only. Imports no OmegaCode/Hyperon code in this controller.
Process-group cleanup is not a substitute for the external forced-stop gate.
"""
from __future__ import annotations

import argparse
import base64
import csv
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import zipfile


SOURCE_SHA = "a6a3f4d0d735134c08a4e8e6d808dca216af5079cacbcfd8858484f95508f5bc"
MODULE_SHA = "c63d17cb8886a119fd35358108b4fd5daeb16074cdf74de0a108f218a070d319"
WHEELS = {
    "x86_64": {"filename": "hyperon-0.2.10-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
               "sha256": "12a0479df6afadda7562ffe10e7d63a6701aaec02f7177b91412bc05a09ed419"},
    "aarch64": {"filename": "hyperon-0.2.10-cp312-cp312-manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
                "sha256": "de1bb08ab3fb13445cc13f0d2f4b103d19cf2ddf2743094d780acfd99bad6f6c"},
}
CHECKS = ("unicode_source_ranges", "source_not_evaluated", "malformed_source_closed", "operator_enablement_exact",
          "closed_input_bounds", "runtime_drift_refused", "metadata_snapshot_currency", "parser_matcher_not_evaluator",
          "all_scratch_clean")
IMPORTS = {"hyperon.base", "hyperon.atoms", "hyperonpy"}
BOUNDARIES = {"evaluated": False, "effect_authority": False, "atom_publication": False,
              "semantic_call_resolution": False, "evaluator_trap_scope": "in-process hyperon.MeTTa.run only"}
MAX_STREAM = 128 * 1024
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_EXPANDED = 300 * 1024 * 1024
DIST = "hyperon-0.2.10.dist-info"


class Refusal(Exception):
    def __init__(self, code, *, relative_path=None, artifact_class=None):
        super().__init__(code)
        self.code = code
        self.details = {}
        if (type(relative_path) is str and 1 <= len(relative_path) <= 512
                and relative_path not in (".", "..")
                and re.fullmatch(r"[A-Za-z0-9._+/-]+", relative_path) is not None
                and not PurePosixPath(relative_path).is_absolute()
                and not {".", ".."}.intersection(PurePosixPath(relative_path).parts)
                and str(PurePosixPath(relative_path)) == relative_path):
            self.details["offending_relative_path"] = relative_path
        if artifact_class in {"cached_bytecode", "installer_metadata", "distribution_metadata", "package_payload", "other"}:
            self.details["offending_artifact_class"] = artifact_class


def need(condition, code):
    if not condition:
        raise Refusal(code)


def closure_need(condition, code, path, root):
    """Retain bounded public worker-relative metadata, never contents/absolute paths.

    This changes diagnostics only: recorded inert installer metadata remains
    allowed under R1's hash rules; every unrecorded site file still refuses.
    """
    if condition:
        return
    path, root = Path(path), Path(root)
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError:
        relative = None
    if "__pycache__" in path.parts or path.suffix == ".pyc":
        kind = "cached_bytecode"
    elif path.parent.name == DIST and path.name in {"INSTALLER", "REQUESTED", "direct_url.json", "uv_cache.json"}:
        kind = "installer_metadata"
    elif any(part.endswith(".dist-info") for part in path.parts):
        kind = "distribution_metadata"
    elif any(part.startswith("hyperon") for part in path.parts):
        kind = "package_payload"
    else:
        kind = "other"
    raise Refusal(code, relative_path=relative, artifact_class=kind)


def sha_file(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def canonical_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()


def metadata(raw):
    need(len(raw) <= 256 * 1024, "metadata_limit")
    parsed = BytesParser().parsebytes(raw)
    need(parsed.get_all("Name") == ["hyperon"] and parsed.get_all("Version") == ["0.2.10"], "metadata_identity")
    requirements = parsed.get_all("Requires-Dist", [])
    accepted = set()
    for row in requirements:
        name, separator, marker = row.partition(";")
        match = re.fullmatch(r"\s*(build|pytest)\s*==\s*(0\.10\.0|7\.3\.2)\s*", name)
        need(separator and match is not None and re.fullmatch(r"\s*extra\s*==\s*(['\"])dev\1\s*", marker) is not None,
             "unpinned_active_dependency")
        expected = {"build": "0.10.0", "pytest": "7.3.2"}
        need(expected[match[1]] == match[2] and match[1] not in accepted, "dependency_metadata_mismatch")
        accepted.add(match[1])
    need(accepted == {"build", "pytest"}, "dependency_metadata_mismatch")
    return {"name": "hyperon", "version": "0.2.10", "active_requires_dist": [],
            "dev_requires_dist": ["build==0.10.0; extra==dev", "pytest==7.3.2; extra==dev"]}


def safe_member(name):
    path = PurePosixPath(name)
    need(name and len(name) <= 512 and not path.is_absolute() and ".." not in path.parts
         and "\\" not in name and "\x00" not in name and str(path) == name and not any(ord(c) < 32 for c in name),
         "archive_path_invalid")
    return path


def inspect_wheel(path, architecture, pin=None):
    need(architecture in WHEELS, "architecture_invalid")
    pin = WHEELS[architecture] if pin is None else pin
    path = Path(path)
    need(path.name == pin["filename"] and path.is_file() and not path.is_symlink()
         and path.stat().st_size <= MAX_ARCHIVE, "wheel_path_or_size")
    need(sha_file(path) == pin["sha256"], "wheel_sha256_mismatch")
    members, total, raw_metadata = {}, 0, None
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue
            safe_member(item.filename)
            need(item.filename not in members and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG),
                 "wheel_member_invalid")
            total += item.file_size
            need(len(members) < 5000 and total <= MAX_EXPANDED, "wheel_expansion_limit")
            raw = archive.read(item)
            members[item.filename] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
            if item.filename == DIST + "/METADATA":
                raw_metadata = raw
    need(raw_metadata is not None, "wheel_metadata_missing")
    return {"sha256": pin["sha256"], "metadata": metadata(raw_metadata), "metadata_bytes": raw_metadata, "members": members}


def package_digest(package):
    rows = []
    for path in Path(package).rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        need(path.is_file() and not path.is_symlink(), "source_module_not_regular")
        rows.append((path.relative_to(package).as_posix(), sha_file(path)))
    result = hashlib.sha256()
    for name, digest in sorted(rows):
        result.update(name.encode() + b"\0" + digest.encode("ascii") + b"\n")
    return result.hexdigest(), len(rows)


def stage_source(archive_path, stage, expected_sha=SOURCE_SHA, expected_modules=MODULE_SHA, expected_count=91):
    archive_path, stage = Path(archive_path), Path(stage)
    need(archive_path.is_file() and not archive_path.is_symlink() and archive_path.stat().st_size <= MAX_ARCHIVE,
         "source_archive_path")
    need(sha_file(archive_path) == expected_sha, "source_archive_sha256_mismatch")
    need(not stage.exists(), "source_stage_exists")
    package = stage / "omegacode"
    package.mkdir(parents=True, mode=0o755)
    seen, total = set(), 0
    with zipfile.ZipFile(archive_path) as archive:
        for item in archive.infolist():
            if not item.filename.startswith("src/omegacode/") or item.is_dir():
                continue
            relative = item.filename[len("src/omegacode/"):]
            safe_member(relative)
            need(relative not in seen and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG), "source_member_invalid")
            total += item.file_size
            need(len(seen) < 256 and total <= 16 * 1024 * 1024, "source_expansion_limit")
            seen.add(relative)
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(archive.read(item))
            target.chmod(0o444)
    need(package_digest(package) == (expected_modules, expected_count), "source_module_digest_mismatch")
    for path in sorted(stage.rglob("*"), reverse=True):
        if path.is_dir():
            path.chmod(0o555)
    stage.chmod(0o555)
    return stage


def protected(path, allowed_roots=()):
    path = Path(path)
    need(path.is_absolute(), "protected_path_not_absolute")
    for current in (path, *path.parents):
        info = current.lstat()
        need(info.st_uid == 0, "runtime_not_root_owned")
        if stat.S_ISLNK(info.st_mode):
            target = current.resolve(strict=True)
            need(any(target == root or root in target.parents for root in allowed_roots), "runtime_symlink_escape")
            continue
        need(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), "runtime_special_file")
        # Every runtime inode must be frozen. Root-owned ancestors such as /
        # and /opt may retain their owner-write bit; other principals cannot
        # replace their children. Sticky /tmp is the explicit ancestor case.
        if current == path:
            need(not info.st_mode & 0o222, "runtime_writable_mode")
        elif info.st_mode & 0o022:
            need(stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX, "runtime_ancestor_writable")


def runtime_roots(worker_python, worker_root):
    python, root = Path(worker_python), Path(worker_root)
    need(root.is_absolute() and root.resolve(strict=True) == root and python.is_absolute()
         and python.parent == root / "bin", "worker_layout")
    cfg = root / "pyvenv.cfg"
    need(cfg.is_file() and not cfg.is_symlink() and cfg.stat().st_size <= 8192, "worker_venv_config")
    values = {}
    for row in cfg.read_text().splitlines():
        key, separator, value = row.partition("=")
        if separator:
            need(key.strip().lower() not in values, "worker_venv_duplicate")
            values[key.strip().lower()] = value.strip()
    need(values.get("include-system-site-packages", "").lower() == "false", "worker_system_site_enabled")
    home = Path(values.get("home", ""))
    need(home.is_absolute() and home.name == "bin", "worker_base_layout")
    base = home.parent.resolve(strict=True)
    roots = (root, base)
    need(python.resolve(strict=True).is_file() and any(python.resolve() == r or r in python.resolve().parents for r in roots),
         "worker_interpreter_escape")
    seen = 0
    for tree in roots:
        protected(tree, roots)
        for directory, dirs, files in os.walk(tree, followlinks=False):
            for name in dirs + files:
                seen += 1
                need(seen <= 100000, "runtime_inventory_limit")
                path = Path(directory) / name
                need(not (name.endswith(".pth") or name.startswith(("sitecustomize", "usercustomize"))), "runtime_startup_hook")
                protected(path, roots)
    protected(python, roots)
    return roots


def installed_closure(worker_root, wheel):
    root = Path(worker_root)
    site = root / "lib/python3.12/site-packages"
    closure_need(site.is_dir() and not site.is_symlink(), "worker_site_missing", site, root)
    dists = [p.name for p in site.iterdir() if p.name.endswith((".dist-info", ".egg-info"))]
    unexpected = next((name for name in dists if name != DIST), None)
    closure_need(dists == [DIST], "worker_distribution_closure", site / unexpected if unexpected else site, root)
    installed_metadata = site / DIST / "METADATA"
    closure_need(installed_metadata.is_file() and not installed_metadata.is_symlink()
                 and installed_metadata.stat().st_size <= 256 * 1024, "installed_metadata_invalid", installed_metadata, root)
    closure_need(installed_metadata.read_bytes() == wheel["metadata_bytes"], "installed_metadata_mismatch", installed_metadata, root)
    metadata(installed_metadata.read_bytes())
    record = site / DIST / "RECORD"
    closure_need(record.is_file() and not record.is_symlink() and record.stat().st_size <= 8 * 1024 * 1024,
                 "installed_record_missing", record, root)
    rows, seen, inventory = csv.reader(io.StringIO(record.read_text())), set(), []
    for row in rows:
        closure_need(len(row) == 3 and row[0] and "\\" not in row[0] and "\x00" not in row[0]
                     and not PurePosixPath(row[0]).is_absolute(), "installed_record_invalid", record, root)
        path = site / row[0]
        try:
            resolved = path.resolve(strict=True)
        except OSError:
            closure_need(False, "installed_record_target_unavailable", path, root)
        closure_need(root in resolved.parents and path.is_file() and not path.is_symlink() and resolved not in seen,
                     "installed_record_escape_or_duplicate", path, root)
        if site in resolved.parents:
            relative_site = resolved.relative_to(site).as_posix()
            # Explicit inert metadata profile for the independently hash-pinned
            # uv 0.13.6 provisioning. Every accepted extra still needs its
            # installed RECORD hash and the earlier frozen/root-owned tree.
            generated_metadata = {DIST + "/INSTALLER", DIST + "/REQUESTED", DIST + "/direct_url.json",
                                  DIST + "/uv_cache.json"}
            closure_need(relative_site in wheel["members"] or relative_site in generated_metadata,
                         "installed_unpinned_payload", path, root)
        else:
            # Installer-generated console wrappers are recorded for identity
            # but never invoked; no ambient metta binary is an execution path.
            closure_need(resolved.parent == root / "bin", "installed_record_escape_or_duplicate", path, root)
        seen.add(resolved)
        closure_need(len(seen) <= 10000, "installed_record_limit", record, root)
        raw_hash, size = row[1], row[2]
        actual = sha_file(path)
        if raw_hash:
            algorithm, separator, encoded = raw_hash.partition("=")
            closure_need(separator and algorithm in ("sha256", "sha384", "sha512"), "installed_record_hash_algorithm", path, root)
            measured = hashlib.new(algorithm, path.read_bytes()).digest()
            closure_need(base64.urlsafe_b64encode(measured).rstrip(b"=").decode() == encoded,
                         "installed_record_hash_mismatch", path, root)
            closure_need(size.isdecimal() and int(size) == path.stat().st_size, "installed_record_size", path, root)
        else:
            closure_need(resolved == record.resolve() or path.suffix == ".pyc", "installed_record_hash_missing", path, root)
            closure_need(not size or (size.isdecimal() and int(size) == path.stat().st_size), "installed_record_size", path, root)
        inventory.append([path.relative_to(root).as_posix(), actual, path.stat().st_size])
    for path in site.rglob("*"):
        closure_need(not path.is_symlink(), "installed_symlink", path, root)
        if path.is_file():
            closure_need(path.resolve() in seen, "installed_unrecorded_file", path, root)
    for name, expected in wheel["members"].items():
        if name == DIST + "/RECORD":
            continue
        # This exact upstream wheel is expected to install into site-packages.
        # Refuse an unqualified scheme rather than omit pinned payload checks.
        closure_need(".data/" not in name, "wheel_install_scheme_unqualified", site / name, root)
        path = site / name
        closure_need(path.is_file() and not path.is_symlink() and sha_file(path) == expected["sha256"]
                     and path.stat().st_size == expected["bytes"], "installed_wheel_payload_mismatch", path, root)
    return {"distribution": "hyperon", "version": "0.2.10", "distribution_count": 1,
            "record_count": len(seen), "record_inventory_sha256": hashlib.sha256(canonical_json(sorted(inventory))).hexdigest(),
            "metadata_sha256": hashlib.sha256(wheel["metadata_bytes"]).hexdigest(), "active_requires_dist": []}


def static_descriptor(worker_python, worker_root):
    root = Path(worker_root).resolve()
    files = sorted(p for site in (root / "lib").glob("python*/site-packages")
                   for package in site.glob("hyperon*")
                   for p in ([package] if package.is_file() else package.rglob("*"))
                   if p.is_file() and "__pycache__" not in p.parts and p.suffix in (".py", ".so"))
    need(files and len(files) <= 500 and sum(p.stat().st_size for p in files) <= MAX_ARCHIVE, "descriptor_inventory_limit")
    need(all(not p.is_symlink() and root in p.resolve().parents for p in files), "descriptor_symlink")
    return {"executable": str(Path(worker_python).absolute()), "executable_digest": sha_file(worker_python),
            "root": str(root), "files": {p.relative_to(root).as_posix(): sha_file(p) for p in files}}


def native_report(value, architecture, descriptor):
    keys = {"schema", "ok", "architecture", "python_version", "implementation", "runtime_descriptor",
            "imported_modules", "checks", "evaluation_entrypoints_instrumented", "observed_boundaries"}
    need(type(value) is dict and set(value) == keys, "native_report_fields")
    need(value["schema"] == "omegacode-hyperon-linux-native-cases-r1" and value["ok"] is True
         and value["architecture"] == architecture and value["python_version"] == "3.12.16"
         and value["implementation"] == "CPython", "native_report_identity")
    need(value["runtime_descriptor"] == descriptor, "native_descriptor_mismatch")
    expected = [{"id": name, "passed": True} for name in CHECKS]
    need(value["checks"] == expected and all(type(p["passed"]) is bool for p in value["checks"]), "native_checks_failed")
    need(value["evaluation_entrypoints_instrumented"] == ["hyperon.MeTTa.run"], "native_instrumentation_scope")
    need(value["observed_boundaries"] == BOUNDARIES
         and all(type(value["observed_boundaries"][key]) is bool for key in BOUNDARIES if key != "evaluator_trap_scope"),
         "native_observed_boundary_mismatch")
    imported = value["imported_modules"]
    need(type(imported) is dict and set(imported) == IMPORTS, "native_imported_modules")
    prefix = "lib/python3.12/site-packages/"
    for module, record in imported.items():
        need(type(record) is dict and set(record) == {"relative", "sha256"}, "native_import_record")
        need(type(record["relative"]) is str and record["relative"] in descriptor["files"]
             and record["sha256"] == descriptor["files"][record["relative"]], "native_import_identity")
        if module in ("hyperon.base", "hyperon.atoms"):
            need(record["relative"] == prefix + module.replace(".", "/") + ".py", "native_import_origin_mismatch")
        else:
            path = PurePosixPath(record["relative"])
            need(path.parent == PurePosixPath(prefix)
                 and re.fullmatch(r"hyperonpy(?:\.[A-Za-z0-9_-]+)*\.so", path.name) is not None,
                 "native_import_origin_mismatch")
    need(len({record["relative"] for record in imported.values()}) == 3, "native_import_origins_not_distinct")
    return value


def architecture_check(requested, system=None, machine=None):
    need(requested in WHEELS and (system or platform.system()) == "Linux"
         and (machine or platform.machine()) == requested, "native_architecture_required")


def group_members(pgid):
    found = []
    for path in Path("/proc").iterdir():
        if not path.name.isdecimal():
            continue
        try:
            text = (path / "stat").read_text()
            fields = text[text.rfind(")") + 2:].split()
            if int(fields[2]) == pgid:
                need(int(fields[3]) == pgid, "process_group_identity_changed")
                found.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return sorted(found)


def current_cgroup():
    rows = Path("/proc/self/cgroup").read_text().splitlines()
    groups = [row[3:] for row in rows if row.startswith("0::")]
    need(len(groups) == 1 and groups[0].startswith("/") and groups[0] != "/"
         and ".." not in Path(groups[0]).parts, "external_cgroup_required")
    root = Path("/sys/fs/cgroup") / groups[0].lstrip("/")
    need(root.is_dir(), "external_cgroup_unavailable")
    return root


def cgroup_members(root):
    result = set()
    for path in [root / "cgroup.procs", *root.rglob("*/cgroup.procs")]:
        try:
            result.update(int(v) for v in path.read_text().split())
        except FileNotFoundError:
            pass
    return result


def bounded_native(argv, timeout=180):
    group = current_cgroup()
    baseline = cgroup_members(group)
    need(os.getpid() in baseline, "controller_cgroup_identity")
    data = {"stdout": bytearray(), "stderr": bytearray()}
    overflow, failed_read = threading.Event(), threading.Event()
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
    def drain(name, stream):
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                if len(data[name]) + len(chunk) > MAX_STREAM:
                    overflow.set()
                    break
                data[name].extend(chunk)
        except BaseException:
            failed_read.set()
        finally:
            stream.close()
    threads = [threading.Thread(target=drain, args=(name, getattr(process, name)), daemon=True) for name in data]
    reason = None
    try:
        for thread in threads:
            thread.start()
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            if overflow.is_set() or failed_read.is_set():
                raise Refusal("native_output_limit_or_read_failure")
            need(time.monotonic() < deadline, "native_timeout")
            time.sleep(0.05)
        process.wait(timeout=5)
    except BaseException as error:
        reason = error if isinstance(error, Refusal) else Refusal("native_execution_failed")
    finally:
        # Only this newly created session/group can be signalled. Adapter
        # workers may start other sessions; the independent cgroup census below
        # detects survivors and the external outer gate owns forced cleanup.
        for sig, seconds in ((signal.SIGTERM, 2), (signal.SIGKILL, 3)):
            if group_members(process.pid):
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=seconds)
            except subprocess.TimeoutExpired:
                pass
        for thread in threads:
            if thread.ident is not None:
                thread.join(timeout=1)
    need(not group_members(process.pid), "native_process_group_not_clean")
    need(cgroup_members(group) == baseline, "native_cgroup_descendants_remain")
    need(not any(t.is_alive() for t in threads) and not overflow.is_set() and not failed_read.is_set(), "native_stream_not_clean")
    if reason:
        raise reason
    try:
        def unique(pairs):
            obj = {}
            for key, item in pairs:
                need(key not in obj, "native_json_duplicate_key")
                obj[key] = item
            return obj
        value = json.loads(bytes(data["stdout"]).decode("utf-8", "strict"), object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Refusal("native_json_invalid") from None
    if process.returncode != 0:
        need(type(value) is dict and set(value) == {"schema", "ok", "reason", "exception_type"}
             and value["schema"] == "omegacode-hyperon-linux-native-cases-r1" and value["ok"] is False
             and type(value["reason"]) is str and re.fullmatch(r"[a-z0-9_]{1,96}", value["reason"]) is not None
             and type(value["exception_type"]) is str
             and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", value["exception_type"]) is not None,
             "native_failure_report_invalid")
        raise Refusal("native_case_refused_" + value["reason"])
    return value, {"process_group_clean": True, "outer_cgroup_returned_to_baseline": True,
                   "external_outer_gate_required": True, "outer_forced_termination_qualified": False}


def validate_receipt_path(path):
    path = Path(path)
    need(path.is_absolute() and path.parent.resolve(strict=True) == path.parent and not path.exists()
         and not path.is_symlink(), "receipt_path_invalid")
    parent = path.parent.lstat()
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid() and stat.S_IMODE(parent.st_mode) == 0o700,
         "receipt_directory_not_private")
    return path


def receipt_write(path, value):
    path = validate_receipt_path(path)
    raw = canonical_json(value) + b"\n"
    need(len(raw) <= MAX_STREAM, "receipt_size_limit")
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())


def installed_closure_at_phase(root, wheel, phase):
    """Identify input contamination versus post-native mutation without widening admission."""
    need(type(phase) is str and phase in {"before_native", "after_native"}, "closure_phase_invalid")
    try:
        return installed_closure(root, wheel)
    except Refusal as error:
        error.details["closure_phase"] = phase
        raise


def qualify(args):
    architecture_check(args.architecture)
    for value in (args.source_archive, args.wheel, args.worker_python, args.worker_root, args.receipt):
        need(value.is_absolute(), "absolute_paths_required")
    validate_receipt_path(args.receipt)
    roots = runtime_roots(args.worker_python, args.worker_root)
    helper = Path(__file__).resolve().with_name("native_cases.py")
    need(helper.is_file() and not helper.is_symlink(), "native_helper_missing")
    protected(helper, roots)
    helper_sha = sha_file(helper)
    wheel = inspect_wheel(args.wheel, args.architecture)
    closure = installed_closure_at_phase(args.worker_root, wheel, "before_native")
    before = static_descriptor(args.worker_python, args.worker_root)
    temporary = Path(tempfile.mkdtemp(prefix="omegacode-hyperon-source-"))
    try:
        source = stage_source(args.source_archive, temporary / "source")
        protected(source, (*roots, temporary))
        argv = [str(args.worker_python), "-I", "-B", str(helper), "--source-root", str(source),
                "--worker-root", str(args.worker_root), "--worker-python", str(args.worker_python),
                "--architecture", args.architecture]
        native, cleanup = bounded_native(argv)
        native_report(native, args.architecture, before)
        need(static_descriptor(args.worker_python, args.worker_root) == before
             and installed_closure_at_phase(args.worker_root, wheel, "after_native") == closure
             and package_digest(source / "omegacode") == (MODULE_SHA, 91) and sha_file(helper) == helper_sha,
             "qualification_identity_drift")
        return {"schema": "omegacode-hyperon-linux-worker-acceptance-r1", "ok": True, "architecture": args.architecture,
                "source_archive_sha256": SOURCE_SHA, "source_module_digest": MODULE_SHA, "source_module_count": 91,
                "wheel_sha256": wheel["sha256"], "wheel_metadata": wheel["metadata"], "installed_closure": closure,
                "runtime_descriptor": before, "imported_modules": native["imported_modules"],
                "checks": native["checks"], "evaluation_entrypoints_instrumented": native["evaluation_entrypoints_instrumented"],
                "observed_boundaries": native["observed_boundaries"],
                "native_helper_sha256": helper_sha, "cleanup": cleanup,
                "qualification_scope": "candidate_r142_worker_and_invented_source_cases",
                "effect_security_proof": False, "service_or_production_activation": False}
    finally:
        # Only this controller-created source scratch is removed; configured
        # runtime, source archive, wheel and existing frozen artifacts persist.
        shutil.rmtree(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-archive", "wheel", "worker-python", "worker-root", "receipt"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--architecture", choices=tuple(WHEELS), required=True)
    args = parser.parse_args(argv)
    try:
        result = qualify(args)
    except Exception as error:
        result = {"schema": "omegacode-hyperon-linux-worker-acceptance-r1", "ok": False,
                  "reason": error.code if isinstance(error, Refusal) else "qualification_failed",
                  "architecture": args.architecture, "native_pass_claimed": False,
                  "service_or_production_activation": False}
        if isinstance(error, Refusal) and error.details:
            result["refusal_details"] = error.details
    written = False
    try:
        receipt_write(args.receipt, result)
        written = True
    except (Refusal, OSError):
        pass
    print(json.dumps({"ok": result["ok"] and written, "receipt_written": written,
                      **({"reason": result["reason"]} if "reason" in result else {})}, sort_keys=True))
    return 0 if result["ok"] and written else 1


if __name__ == "__main__":
    raise SystemExit(main())
