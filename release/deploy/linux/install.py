"""Purpose: install a public Hive release and its private runtime for one unprivileged Linux user.

The release catalogue must be complete and ready before any privileged action.
Only the system setup phase may use sudo: packages, linger and, where AppArmor restricts user namespaces,
the mind launcher's profile. All application/runtime work is per-user.
"""
from __future__ import annotations

import argparse
import ast
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import pwd
import re
import secrets
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import shlex
import termios
import time
import urllib.parse
import uuid
import zipfile

P = pathlib.Path
CORE_ROOTS = {"fastapi", "uvicorn", "httpx", "websockets", "pytest", "pillow"}
APT = ("ca-certificates", "curl", "git", "build-essential", "cmake", "ninja-build",
       "pkg-config", "libssl-dev", "libgmp-dev", "libedit-dev", "libpcre2-dev",
       "libyaml-dev", "zlib1g-dev", "libarchive-dev", "sqlite3", "xz-utils", "acl", "util-linux",
       "dbus-user-session", "xdg-utils", "procps", "apparmor", "patch")
SUPPORTED_UBUNTU = ("22.04", "24.04", "26.04")
# A fresh Ubuntu installs its own updates soon after it starts and holds the package lock meanwhile; apt waits this long
# for it (DPkg::Lock::Timeout) instead of failing the setup at once.
APT_LOCK_WAIT = 1800
# Ubuntu 23.10 and later (on by default from 24.04) let a program create a user namespace only when its AppArmor
# profile grants `userns`; 22.04's kernels have no such file. rootlesskit reads the same file (pkg/parent/warn.go).
USERNS_RESTRICTION = P("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
APPARMOR_PROFILES = P("/etc/apparmor.d")
APPARMOR_PARSER = "/usr/sbin/apparmor_parser"
# The kernel's own switch: "Y" where AppArmor confines programs, as on every standard Ubuntu install.
APPARMOR_ENABLED = P("/sys/module/apparmor/parameters/enabled")
PATH_CHARACTERS = "Your installation path can use only letters, numbers, dots, underscores, hyphens and slashes."
HOSTS = {"github.com", "nodejs.org", "files.pythonhosted.org", "www.swi-prolog.org",
         "download.swi-prolog.org", "astral.sh", "releases.astral.sh"}
UNIT = "omegahive.service"
# Create's Code service: the user unit the hive's Code guard reads by this name (hive/core/code.py CODE_UNIT), on the
# hive's port plus install/macos/pins.sh's CODE_PORT_OFFSET (8700 + 24), the published omegacode release's own port.
CODE_UNIT = "omegacode.service"
CODE_PORT = 8724
# install/macos/setup-code.sh's adapters: they bind each hive's port and the fixed-envelope proposal-test contract.
CODE_PATCHES = ("omegacode-port.patch", "omegacode-proposal-tests.patch")
UNITS = (UNIT, CODE_UNIT)
STOP = False
BOOTSTRAP_TIMEOUT = 480  # two 180s readiness waits, 50s API work, restart and overhead
OPEN_TIMEOUT = 210
PROCESS_SNAPSHOT_TIMEOUT = 10
PROCESS_CLEANUP_TIMEOUT = 30


class Refused(Exception):
    pass


def need(ok, message):
    if not ok:
        raise Refused(message)


def strict_json(raw):
    def pairs(rows):
        value = {}
        for key, item in rows:
            need(key not in value, "The installer catalogue has duplicate fields.")
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused("Invalid catalogue number.")))


def relative(name):
    need(type(name) is str and name and "\x00" not in name and "\\" not in name,
         "The package contains an unsafe filename.")
    path = pathlib.PurePosixPath(name)
    need(path.parts and not path.is_absolute() and str(path) == name and ".." not in path.parts,
         "The package contains an unsafe filename.")
    return path


def source_prefix(value):
    path = relative(value)
    need(len(path.parts) == 1 and "/" not in value,
         "The source archive needs its one exact reviewed top-level prefix, without a slash.")
    return value


def pin_file(path, expected, maximum=512 * 1024**2):
    need(type(expected) is dict and set(expected) >= {"bytes", "sha256"}
         and type(expected["bytes"]) is int and 0 <= expected["bytes"] <= maximum
         and type(expected["sha256"]) is str and re.fullmatch("[a-f0-9]{64}", expected["sha256"]),
         "A release checksum is missing.")
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and not path.is_symlink(),
         "A package file has an unsafe type.")
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    size = 0
    try:
        opened = os.fstat(fd)
        need((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), "A package changed while opening it.")
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            size += len(block)
            need(size <= maximum, "A package is larger than its limit.")
            digest.update(block)
        after = os.fstat(fd)
        named = path.lstat()
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        need(identity(opened) == identity(after) == identity(named), "A package changed while reading it.")
    finally:
        os.close(fd)
    need(size == expected["bytes"] and digest.hexdigest() == expected["sha256"],
         "This download is damaged or incomplete. Please download the installer again.")


def validate_catalogue(value):
    required = {"schema", "ready", "release_id", "source_revision", "source_tree", "min_free_bytes",
                "core_roots", "python_version", "uv_version", "swipl_version", "ui_prebuilt",
                "petta_commit", "platforms", "apps", "bootstrap", "module_files",
                "default_model", "embedding_model", "ssh_target", "omega_core", "code_service"}
    need(type(value) is dict and set(value) == required and value["schema"] == "studio-linux-user-release/2",
         "This is not an OmegaHive Linux release catalogue.")
    need(value["ready"] is True, "This installer is a review copy and has not been published yet.")
    need(type(value["default_model"]) is str and re.fullmatch(r"openrouter/[A-Za-z0-9][A-Za-z0-9._:/-]{1,200}", value["default_model"]),
         "The reviewed OpenRouter model selection is missing.")
    need(type(value["embedding_model"]) is str and re.fullmatch(r"(?:mock/hash|(?:openrouter|openai|anthropic)/[A-Za-z0-9][A-Za-z0-9._:/-]{0,200})", value["embedding_model"]),
         "The explicit embedding selection is missing.")
    need(value["ssh_target"] is None or (type(value["ssh_target"]) is str
         and re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}", value["ssh_target"])),
         "The non-secret SSH destination is invalid.")
    need(type(value["release_id"]) is str and re.fullmatch("[a-z0-9][a-z0-9._-]{1,79}", value["release_id"]),
         "The release identity is missing.")
    need(all(type(value[k]) is str and re.fullmatch("[a-f0-9]{40}", value[k])
             for k in ("source_revision", "source_tree", "petta_commit")), "A frozen source identity is missing.")
    need(type(value["core_roots"]) is list and set(value["core_roots"]) == CORE_ROOTS
         and len(value["core_roots"]) == 6, "The six Hive dependency roots must be reviewed together.")
    need(type(value["min_free_bytes"]) is int and value["min_free_bytes"] >= 5 * 1024**3,
         "The release disk requirement is missing.")
    need(type(value["python_version"]) is str and re.fullmatch(r"3\.12\.[0-9]+", value["python_version"]),
         "The reviewed Python 3.12 version is missing.")
    need(all(type(value[k]) is str and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value[k])
              for k in ("uv_version", "swipl_version")), "Reviewed runtime versions are missing.")
    need(type(value["platforms"]) is dict and set(value["platforms"]) == {"x86_64", "aarch64"},
         "Both Ubuntu architectures need a reviewed package set.")
    for selected in value["platforms"].values():
        need(type(selected) is dict and set(selected) == {"uv", "python", "swipl_source", "petta_source",
                                                        "source_payload", "core_lock", "build_lock"},
             "A platform package set is incomplete.")
        for name, item in selected.items():
            need(type(item) is dict and type(item.get("bytes")) is int and 0 < item["bytes"] <= 512 * 1024**2
                 and type(item.get("sha256")) is str and re.fullmatch("[a-f0-9]{64}", item["sha256"]),
                 "A platform download or lock is not checksum-pinned.")
            if name in {"core_lock", "build_lock", "source_payload"}:
                relative(item.get("path"))
            else:
                url = urllib.parse.urlsplit(item.get("url", ""))
                need(url.scheme == "https" and url.hostname in HOSTS and not url.username
                     and not url.password and not url.query and not url.fragment,
                     "A runtime download is not an approved public HTTPS artifact.")
        need(type(selected["source_payload"].get("files")) is list
             and 1 <= len(selected["source_payload"]["files"]) <= 5000, "The source file inventory is missing.")
        checked_members(selected["source_payload"]["files"])
        source_prefix(selected["source_payload"].get("prefix"))
    need(len({selected["source_payload"]["prefix"] for selected in value["platforms"].values()}) == 1,
         "Both platforms must use the same exact source archive prefix.")
    ui = value["ui_prebuilt"]
    need(type(ui) is dict and set(ui) == {"archive", "manifest", "source_revision", "source_tree"}
         and all(type(ui[key]) is str and re.fullmatch("[a-f0-9]{40}", ui[key])
                 for key in ("source_revision", "source_tree")), "The prebuilt UI source identity is missing.")
    for key in ("archive", "manifest"):
        item = ui[key]
        need(type(item) is dict and set(item) == {"path", "bytes", "sha256"}
             and type(item["bytes"]) is int and 0 < item["bytes"] <= (2 * 1024**2 if key == "manifest" else 512 * 1024**2)
             and type(item["sha256"]) is str and re.fullmatch("[a-f0-9]{64}", item["sha256"]),
             "The prebuilt UI archive or manifest is not checksum-pinned.")
        relative(item["path"])
    core = value["omega_core"]
    need(type(core) is dict and set(core) == {"path", "bytes", "sha256"}
         and type(core["path"]) is str and re.fullmatch(r"omega-core-[a-f0-9]{7}\.bundle", core["path"])
         and type(core["bytes"]) is int and 0 < core["bytes"] <= 64 * 1024**2
         and type(core["sha256"]) is str and re.fullmatch("[a-f0-9]{64}", core["sha256"]),
         "The Omega core the minds run on is not checksum-pinned.")
    code = value["code_service"]
    need(type(code) is dict and set(code) == {"path", "bytes", "sha256"}
         and type(code["path"]) is str and re.fullmatch(r"omegacode-[a-f0-9]{5,64}\.tgz", code["path"])
         and type(code["bytes"]) is int and 0 < code["bytes"] <= 64 * 1024**2
         and type(code["sha256"]) is str and re.fullmatch("[a-f0-9]{64}", code["sha256"]),
         "Create's Code service release is not checksum-pinned.")
    # Studio, shown as Create, is the one app package; Assist stays out of public releases (omega-flagship/omegahive#106).
    need(type(value["apps"]) is list and [app.get("id") if type(app) is dict else None for app in value["apps"]] == ["omegadesign"],
         "The public Linux release carries Studio (omegadesign) as its one app package.")
    for app in value["apps"]:
        need(type(app) is dict and type(app.get("digest")) is str
             and re.fullmatch("sha256:[a-f0-9]{64}", app["digest"])
             and type(app.get("files")) is list and app["files"], "An app pin or file inventory is missing.")
        relative(app.get("path")); relative(app.get("prefix", "").rstrip("/"))
        need(type(app.get("bytes")) is int and app["bytes"] > 0
             and type(app.get("sha256")) is str and re.fullmatch("[a-f0-9]{64}", app["sha256"]), "An app archive checksum is missing.")
        checked_members(app["files"])
    need(type(value["bootstrap"]) is dict and set(value["bootstrap"]) == {"helper"},
         "The local-owner verification helper is missing.")
    for item in value["bootstrap"].values():
        need(type(item) is dict and type(item.get("bytes")) is int and item["bytes"] > 0
             and type(item.get("sha256")) is str and re.fullmatch("[a-f0-9]{64}", item["sha256"]),
             "The local-owner verification helper is not checksum-pinned.")
        relative(item.get("path"))
    need(type(value["module_files"]) is list and value["module_files"], "The installer module inventory is missing.")
    modules = checked_members(value["module_files"])
    need({"deploy/linux/install.py", "deploy/linux/control.py", "deploy/linux/serve.py",
          "deploy/linux/omegahive.service.in"} <= set(modules)
         and all(name.startswith("deploy/linux/") for name in modules), "The Linux launcher module is incomplete.")
    for selected in value["platforms"].values():
        files = checked_members(selected["source_payload"]["files"])
        need(all(files.get(name) == row for name, row in modules.items()),
             "The Linux launcher module does not match the source package inventory.")
    return value


def validate_lock(path, core=False):
    raw = path.read_bytes()
    need(len(raw) <= 2 * 1024**2, "A dependency lock exceeds its size limit.")
    logical = []; current = ""
    for line in raw.decode("ascii").splitlines():
        line = line.strip()
        if not line or line.startswith("#"): continue
        current += " " + line.rstrip("\\").strip()
        if not line.endswith("\\"):
            logical.append(current.strip()); current = ""
    need(not current and logical, "A dependency lock is incomplete.")
    names = set()
    for line in logical:
        hashes = re.findall(r"(?:^|\s)--hash=sha256:([a-f0-9]{64})(?=\s|$)", line)
        requirement = re.sub(r"(?:^|\s)--hash=sha256:[a-f0-9]{64}(?=\s|$)", "", line).strip()
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?==[A-Za-z0-9.!+_-]+(?:\s*;[^\r\n]+)?", requirement)
        need(hashes and match and "--" not in requirement and "#" not in requirement,
             "Every dependency and build dependency must have an exact version and SHA256 hash.")
        names.add(match.group(1).lower().replace("_", "-"))
    if core:
        need(CORE_ROOTS | {"janus-swi"} <= names, "The six Hive roots and reviewed Janus bridge are not all locked.")
    return names


def plain(path, owner=None, directory=False):
    info = path.lstat()
    need(not path.is_symlink() and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)),
         "An installation path is not a plain file or folder.")
    permission_hint = ""
    if info.st_uid == os.getuid() and info.st_mode & 0o022:
        permission_hint = " If this path is intended to be private, run: chmod go-w -- " + shlex.quote(str(path))
    need(info.st_uid == (os.getuid() if owner is None else owner) and not info.st_mode & 0o022,
         "An installation path has unsafe ownership or permissions: " + str(path) +
         " (must belong to this user and not be group/world writable)." + permission_hint)
    return info


def swipl_executable(prefix):
    """Resolve only this SWI installation's launcher; keep plain() strict."""
    plain(prefix, directory=True)
    need(prefix.is_absolute() and prefix == prefix.resolve(strict=True),
         "The SWI-Prolog prefix is not a canonical private folder.")
    try:
        executable = (prefix / "bin/swipl").resolve(strict=True)
    except (OSError, RuntimeError):
        raise Refused("SWI-Prolog did not install a usable launcher.") from None
    need(executable.is_relative_to(prefix), "The SWI-Prolog launcher escaped its private prefix.")
    info = plain(executable)
    need(info.st_mode & stat.S_IXUSR, "The SWI-Prolog launcher is not executable by its owner.")
    return executable


def place_swipl(prefix):
    """Make <prefix>/bin/swipl the executable itself, and its installed place a link to it.

    A mind's sandbox may read the folder two above the swipl the hive finds on its PATH
    (hive/supervisor/sandbox.py runtime_roots). SWI's install puts the executable in <home>/bin/<arch>/, whose
    grandparent <home>/bin holds neither libswipl nor SWI's library, so every mind stopped at
    "swipl: error while loading shared libraries: libswipl.so.10". The Mac bundle moves the executable for the same
    reason (install/macos/build-swipl-bundle.sh); here its grandparent becomes the whole private SWI installation.
    swipl still finds its home, since the install compiled the absolute one in."""
    executable = swipl_executable(prefix)
    launcher = prefix / "bin/swipl"
    if executable != launcher:
        need(launcher.is_symlink(), "SWI-Prolog's launcher is not the link its install makes.")
        launcher.unlink()
        os.rename(executable, launcher)
        os.symlink(os.path.relpath(launcher, executable.parent), executable)
    return swipl_executable(prefix)


def strip_inherited_acl(path):
    """Remove POSIX ACLs from a folder this installer owns. A default ACL on a parent (e.g. a home folder an admin
    shared) is inherited by new folders and overrides umask 077, so tools such as uv would create group/other-
    accessible folders inside the private release. Without ACLs, umask 077 decides again. Never follows links."""
    if not hasattr(os, "removexattr"):
        return
    for name in ("system.posix_acl_default", "system.posix_acl_access"):
        try:
            os.removexattr(path, name, follow_symlinks=False)
        except OSError as error:
            need(error.errno in (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP, getattr(errno, "ENOATTR", errno.ENODATA)),
                 "An OmegaHive folder's sharing settings could not be made private.")


def private_dir(path):
    if not path.exists():
        path.mkdir(mode=0o700)
    if not path.is_symlink() and path.is_dir() and path.lstat().st_uid == os.getuid():
        strip_inherited_acl(path)
    plain(path, directory=True)
    need(stat.S_IMODE(path.lstat().st_mode) == 0o700, "An OmegaHive folder must be private (mode 0700).")


def canonical_home():
    need(os.getuid() != 0 and platform.system() == "Linux", "Run this installer as your normal Ubuntu user, without sudo.")
    home = P(pwd.getpwuid(os.getuid()).pw_dir)
    need(home.is_absolute() and home == home.resolve() and os.environ.get("HOME") == str(home),
         "Your home folder must be the normal account home, without a link.")
    need("%" not in str(home), "Your home folder's name has a % sign, which OmegaHive can't use yet.")
    plain(home, directory=True)
    return home


def parent_chain(root, target):
    need(target.is_relative_to(root), "An installer path escaped its private folder.")
    current = root
    for part in target.relative_to(root).parts:
        current /= part
        if not current.exists():
            current.mkdir(mode=0o700)
        plain(current, directory=True)


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    except BaseException:
        raise


def atomic_json(path, value):
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    write_new(tmp, (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode())
    if path.exists():
        plain(path)
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def checked_members(rows):
    expected = {}
    for row in rows:
        need(type(row) is dict and set(row) == {"path", "bytes", "sha256", "mode"}, "Invalid package file inventory.")
        rel = str(relative(row["path"]))
        need(rel not in expected and type(row["bytes"]) is int and 0 <= row["bytes"] <= 256 * 1024**2
             and row["mode"] in {"100644", "100755"}
             and type(row["sha256"]) is str and re.fullmatch("[a-f0-9]{64}", row["sha256"]), "Invalid package file pin.")
        expected[rel] = row
    for name in expected:
        need(not any(str(parent) in expected for parent in pathlib.PurePosixPath(name).parents if str(parent) != "."),
             "The package inventory has a file/ancestor collision.")
    need(len(expected) <= 20000 and sum(x["bytes"] for x in expected.values()) <= 512 * 1024**2,
         "The package inventory is too large.")
    return expected


def archive_directories(prefix, expected):
    """Only the prefix root and ancestors of positively declared regular files."""
    directories = {prefix}
    for name in expected:
        for parent in pathlib.PurePosixPath(name).parents:
            if str(parent) != ".": directories.add(prefix + "/" + str(parent))
    return directories


def copy_member(destination, rel, source, size, executable=False):
    target = destination / str(relative(rel))
    parent_chain(destination, target.parent)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    digest = hashlib.sha256(); count = 0
    with os.fdopen(fd, "wb") as out:
        while True:
            block = source.read(65536)
            if not block:
                break
            count += len(block); need(count <= size, "An archive file exceeds its declared size.")
            digest.update(block); out.write(block)
        need(count == size, "An archive file was truncated.")
        out.flush(); os.fchmod(out.fileno(), 0o555 if executable else 0o444); os.fsync(out.fileno())
    return digest.hexdigest()


def extract_source(archive, destination, rows, prefix):
    prefix = source_prefix(prefix)
    expected = checked_members(rows); seen = set(); directories = archive_directories(prefix, expected)
    seen_names = set(); private_dir(destination)
    with tarfile.open(archive, "r:gz") as stream:
        for index, member in enumerate(stream):
            need(index < 25000, "The source archive has too many entries.")
            name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
            name = str(relative(name))
            need(name not in seen_names, "The source archive repeats a member path.")
            seen_names.add(name)
            if member.isdir():
                need(name in directories and member.size == 0,
                     "The source archive has an extra or nonempty directory.")
                continue
            need(name.startswith(prefix + "/"), "A source member is outside its reviewed prefix.")
            rel = str(relative(name[len(prefix) + 1:])); need(member.isfile() and rel in expected and rel not in seen,
                                                   "The source archive differs from its reviewed inventory.")
            row = expected[rel]; need(member.size == row["bytes"], "A source archive size differs from its pin.")
            handle = stream.extractfile(member); need(handle is not None, "A source file is missing.")
            with handle:
                digest = copy_member(destination, rel, handle, member.size, row["mode"] == "100755")
            need(digest == row["sha256"], "A source file checksum differs from its pin."); seen.add(rel)
    need(seen == set(expected), "The source archive is missing reviewed files.")


def extract_tool(archive, destination):
    """Pinned vendor tar only; regular files plus bounded in-tree relative links."""
    private_dir(destination); links = []; seen = {}; total = 0; top = None
    with tarfile.open(archive, "r:*") as stream:
        for index, member in enumerate(stream):
            need(index < 25000, "A runtime archive has too many entries.")
            path = relative(member.name.rstrip("/")); parts = path.parts[1:]
            if top is None: top = path.parts[0]
            need(path.parts[0] == top, "A runtime archive has more than one root folder.")
            if not parts:
                continue
            rel = str(pathlib.PurePosixPath(*parts))
            if rel in seen:
                need(seen[rel] == "dir" and member.isdir() and member.size == 0,
                     "A runtime archive repeats a filename.")
                # Vendor directory headers can differ in mtime/mode/PAX metadata.
                # Recheck the existing path without replacing or restoring it.
                parent_chain(destination, destination / rel)
                continue
            if member.isdir():
                need(member.size == 0, "A runtime archive contains an unsupported file.")
                seen[rel] = "dir"
                parent_chain(destination, destination / rel); continue
            if member.issym():
                seen[rel] = "link"
                target = pathlib.PurePosixPath(member.linkname)
                need(not target.is_absolute() and "\x00" not in member.linkname,
                     "A runtime link leaves its installation folder.")
                resolved = P(os.path.normpath(str(destination / rel / ".." / member.linkname)))
                need(resolved.is_relative_to(destination), "A runtime link leaves its installation folder.")
                links.append((rel, member.linkname)); continue
            need(member.isfile() and 0 <= member.size <= 256 * 1024**2, "A runtime archive contains an unsupported file.")
            seen[rel] = "file"
            total += member.size; need(total <= 512 * 1024**2, "A runtime archive expands beyond its limit.")
            handle = stream.extractfile(member); need(handle is not None, "A runtime archive file is missing.")
            with handle:
                copy_member(destination, rel, handle, member.size, bool(member.mode & 0o111))
        for rel, target in links:
            path = destination / rel; parent_chain(destination, path.parent); os.symlink(target, path)
        for rel, _ in links:
            need((destination / rel).resolve(strict=True).is_relative_to(destination), "A runtime link leaves its installation folder.")


def extract_app(archive, destination, spec):
    expected = checked_members(spec["files"]); prefix = spec["prefix"].rstrip("/") + "/"
    directories = archive_directories(prefix.rstrip("/"), expected)
    private_dir(destination); seen = set(); seen_directories = set()
    with zipfile.ZipFile(archive) as stream:
        need(len(stream.infolist()) <= 20000, "An app archive has too many entries.")
        for member in stream.infolist():
            kind = stat.S_IFMT(member.external_attr >> 16)
            if member.is_dir():
                name = str(relative(member.filename[:-1]))
                need(kind in {0, stat.S_IFDIR} and member.file_size == 0 and member.CRC == 0
                     and name in directories and name not in seen_directories,
                     "An app archive has an extra, linked, repeated or nonempty directory.")
                with stream.open(member) as directory_data:
                    need(directory_data.read(1) == b"", "An app directory contains data.")
                seen_directories.add(name)
                continue
            need(member.filename.startswith(prefix), "An app file is outside its reviewed release.")
            rel = str(relative(member.filename[len(prefix):])); row = expected.get(rel)
            need(kind in {0, stat.S_IFREG} and row is not None and rel not in seen
                 and member.file_size == row["bytes"], "An app archive differs from its reviewed inventory.")
            with stream.open(member) as source:
                digest = copy_member(destination, rel, source, row["bytes"], row["mode"] == "100755")
            need(digest == row["sha256"], "An app file checksum differs from its pin."); seen.add(rel)
    need(seen == set(expected), "An app archive is missing reviewed files.")


def prebuilt_ui_members(document, spec):
    need(type(document) is dict and set(document) == {"built_with", "file_count", "files", "format", "source_commit", "source_tree"}
         and document["format"] == "omegahive.ui-prebuilt/1"
         and document["source_commit"] == spec["source_revision"] and document["source_tree"] == spec["source_tree"]
         and type(document["built_with"]) is str and 0 < len(document["built_with"]) <= 2000,
         "The prebuilt UI manifest or its own source identity differs from the reviewed release.")
    files = document["files"]
    need(type(files) is dict and type(document["file_count"]) is int
         and document["file_count"] == len(files) and 1 <= len(files) <= 5000 and "index.html" in files,
         "The prebuilt UI file inventory is incomplete.")
    rows = []
    for name, item in files.items():
        relative(name)
        need(not any(ord(c) < 32 or ord(c) == 127 for c in name)
             and type(item) is dict and set(item) == {"bytes", "sha256"}, "Invalid prebuilt UI file inventory.")
        rows.append({"path": name, "bytes": item["bytes"], "sha256": item["sha256"], "mode": "100644"})
    return checked_members(rows)


def extract_prebuilt_ui(archive, manifest_path, destination, spec):
    """Verify the exact local artifact and every static file; never run build metadata."""
    pin_file(archive, spec["archive"])
    pin_file(manifest_path, spec["manifest"], 2 * 1024**2)
    raw = manifest_path.read_bytes()
    need(len(raw) == spec["manifest"]["bytes"] and hashlib.sha256(raw).hexdigest() == spec["manifest"]["sha256"],
         "The prebuilt UI manifest changed while reading it.")
    expected = prebuilt_ui_members(strict_json(raw), spec)
    need(not os.path.lexists(destination), "The UI destination already exists; setup will not mix UI releases.")
    private_dir(destination); seen = set(); seen_names = set()
    directories = archive_directories("dist", expected)
    with tarfile.open(archive, "r:gz") as stream:
        for index, member in enumerate(stream):
            need(index < 25000, "The prebuilt UI archive has too many entries.")
            name = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
            name = str(relative(name))
            need(not any(ord(c) < 32 or ord(c) == 127 for c in name)
                 and name not in seen_names, "The prebuilt UI archive repeats or misnames a member.")
            seen_names.add(name)
            if member.type == tarfile.DIRTYPE:
                need(name in directories and member.size == 0 and not member.linkname,
                     "The prebuilt UI archive contains an extra or nonempty directory.")
                continue
            need(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and name.startswith("dist/") and not member.linkname,
                 "The prebuilt UI archive contains a link, unsupported file or wrong prefix.")
            rel = str(relative(name[len("dist/"):]))
            need(rel in expected and rel not in seen and member.size == expected[rel]["bytes"],
                 "The prebuilt UI archive differs from its file inventory.")
            handle = stream.extractfile(member); need(handle is not None, "A prebuilt UI file is missing.")
            with handle:
                digest = copy_member(destination, rel, handle, member.size)
            need(digest == expected[rel]["sha256"], "A prebuilt UI file failed its checksum.")
            seen.add(rel)
    need(seen == set(expected), "The prebuilt UI archive is missing reviewed files.")
    for name, row in expected.items():
        pin_file(destination / name, row)
    return raw


def program_digest(folder, rows):
    """Independent finite implementation of the reviewed program-source digest; no Hive import."""
    skip = {"__pycache__", ".git", "node_modules", ".venv", "venv", "data", "store", "var"}
    inventory = checked_members(rows)
    need("plugin.json" in inventory, "An app manifest is missing.")
    files = [folder / "plugin.json"] + [folder / name for name in sorted(inventory)
        if pathlib.PurePosixPath(name).suffix in {".py", ".metta"}
        and not set(pathlib.PurePosixPath(name).parts[:-1]) & skip]
    lock = folder / "ui/bundle.lock.json"
    if "ui/bundle.lock.json" in inventory:
        files.append(lock)
    digest = hashlib.sha256()
    for path in files:
        need(not path.is_symlink(), "An app digest encountered a link.")
        digest.update(str(path.relative_to(folder)).encode() + b"\0" + path.read_bytes() + b"\0")
    return "sha256:" + digest.hexdigest()


def code_releases(app):
    """The omegacode releases this hive accepts, read from its own hive/core/code.py without importing it: the
    published release the kit's tarball holds, and the portable release its two adapters make of it."""
    names = {"PUBLISHED_SERVICE_RELEASE", "PORTABLE_SERVICE_RELEASE"}
    found = {}
    for node in ast.parse((app / "hive/core/code.py").read_text(encoding="utf-8")).body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id in names and isinstance(node.value, ast.Constant)):
            found[node.targets[0].id] = node.value.value
    need(set(found) == names and all(type(v) is str and re.fullmatch("[a-f0-9]{64}", v) for v in found.values()),
         "This release does not name the Code service release it accepts.")
    return found["PUBLISHED_SERVICE_RELEASE"], found["PORTABLE_SERVICE_RELEASE"]


def module_digest(package):
    """hive/core/code.py's Code._module_digest, implemented independently as program_digest is: sha256 over sorted
    (path relative to the package, NUL, file sha256, LF) for every .py module outside __pycache__, links refused.
    Time: b bytes hashed, b = the package's .py bytes; one sort of its m modules."""
    rows = []
    for path in package.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        need(not path.is_symlink() and path.is_file(), "The Code service release contains a link.")
        rows.append((str(path.relative_to(package)), hashlib.sha256(path.read_bytes()).hexdigest()))
    digest = hashlib.sha256()
    for rel, value in sorted(rows):
        digest.update(rel.encode() + b"\0" + value.encode() + b"\n")
    return digest.hexdigest()


def materialize_venv_python(venv, source):
    """Keep pyvenv.cfg discovery while meeting the sandbox's plain-file rule."""
    need(source == source.resolve(strict=True), "The base Python is not canonical.")
    plain(source); plain(venv.parent, directory=True)
    need(source.stat().st_size <= 64 * 1024**2, "The Python executable exceeds its limit.")
    digest = hashlib.sha256(); size = 0
    with source.open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            size += len(block); need(size <= 64 * 1024**2, "The Python executable exceeds its limit.")
            digest.update(block)
    expected = {"bytes": size, "sha256": digest.hexdigest()}
    pin_file(source, expected, 64 * 1024**2)
    if venv.is_symlink():
        need(venv.resolve(strict=True) == source, "The environment points to a different Python.")
        temporary = venv.with_name("python.copy-" + uuid.uuid4().hex)
        with source.open("rb") as handle:
            copy_member(venv.parent, temporary.name, handle, source.stat().st_size, True)
        need(venv.is_symlink() and venv.resolve(strict=True) == source,
             "The environment Python changed during setup.")
        os.replace(temporary, venv)
    plain(venv)
    pin_file(venv, expected, 64 * 1024**2)
    need(venv == venv.resolve(strict=True) and bool(venv.stat().st_mode & 0o111),
         "The environment Python must be a plain executable.")
    return venv


def preflight(home, minimum):
    release = {}
    for line in P("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1); release[key] = value.strip('"')
    need(release.get("ID") == "ubuntu" and release.get("VERSION_ID") in SUPPORTED_UBUNTU,
         "This installer supports Ubuntu 22.04, 24.04 and 26.04. Please use one of those releases for this preview.")
    arch = platform.machine(); need(arch in {"x86_64", "aarch64"}, "This preview supports x86_64 and arm64 Ubuntu.")
    need(shutil.disk_usage(home).free >= minimum,
         "OmegaHive needs about " + str((minimum + 1024**3 - 1) // 1024**3)
         + " GB free in your home folder. Please free some space, then run the installer again.")
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(ctypes.c_long(444), None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    need(abi >= 1, "This computer's Linux can't keep your hive's helpers safely apart (it needs a feature called Landlock). Please use Ubuntu's standard kernel.")
    return arch


def userns_restricted():
    """Whether AppArmor lets only programs whose profile grants `userns` create user namespaces here."""
    try:
        return USERNS_RESTRICTION.read_text().strip() == "1"
    except FileNotFoundError:
        return False


def apparmor_enabled():
    try:
        return APPARMOR_ENABLED.read_text().strip() == "Y"
    except FileNotFoundError:
        return False


def apt_get(*argv):
    return ["/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=" + str(APT_LOCK_WAIT), *argv]


def package_install():
    """The one command the package environment may run: the fixed package set, without recommends."""
    return apt_get("install", "-y", "--no-install-recommends", *APT)


def plain_path_text(path):
    """The path as text, refused unless it is plain enough to stand unquoted in a systemd unit and an AppArmor rule."""
    text = str(path)
    need(re.fullmatch(r"/[A-Za-z0-9._/-]+", text) is not None, PATH_CHARACTERS)
    return text


def launcher_profile_name(uid):
    return "omegahive-mind-launcher-" + str(int(uid))


def code_profile_name(uid):
    return "omegahive-code-" + str(int(uid))


def apparmor_file_name(uid):
    """The one /etc/apparmor.d file holding this account's OmegaHive profiles."""
    return "omegahive-" + str(int(uid))


def launcher_profile(uid, launcher):
    """The AppArmor profile that lets this account's mind launcher set up the namespaces each mind runs in.

    The hive starts the launcher by its own path (hive/supervisor/sandbox.py, launcher()), so the profile attaches
    to that one file, as deploy/apparmor/omegahive-mind-launcher does for a server release and as rootlesskit's hint
    does for a binary in a home folder. It grants only `userns` and stays unconfined otherwise: the mind's boundary is
    still Landlock, seccomp and the namespaces, and the account gets back what every Ubuntu 22.04 account has."""
    name = launcher_profile_name(uid)
    return ("# OmegaHive's mind launcher for uid " + str(int(uid)) + ": the user namespace each mind runs in.\n"
            "profile " + name + " " + plain_path_text(launcher) + " flags=(unconfined) {\n"
            "  userns,\n\n  include if exists <local/" + name + ">\n}\n")


def code_profile(uid, runtime, code, repo):
    """The AppArmor profile Create's Code service runs in, named by its user unit's AppArmorProfile=.

    A user unit's ProtectSystem, ProtectHome, ReadWritePaths and PrivateTmp need an unprivileged user namespace, and
    where Ubuntu restricts those (24.04 and later) systemd runs the unit without them and says nothing (systemd 255;
    block/buzz#5670, LHelge/hoster#6), so the WSL unit form of install/macos/omegahive.sh would leave the service
    unconfined here. This profile confines it the way setup-code.sh's seatbelt profile does on a Mac, with no user
    namespace: the system read-only, the account's home closed but for the service's own folders, writable only its
    state, temp, working folder, home, logs and the repository it builds in. It runs git and its own interpreter in
    this profile, and lets the hive's Code guard read its /proc facts and systemd signal it.

    The service may also signal itself under either label it runs as. On Ubuntu 26.04 (systemd 259) a user unit's
    AppArmorProfile= stacks the profile on unconfined, so the process reads "<name>//&unconfined", and a peer=<name> rule
    alone refused the SIGTERM uvicorn raises at itself after a graceful stop: Python exited 1 and every stop left the
    unit failed. 22.04's and 24.04's parsers take the stacked peer too."""
    name = code_profile_name(uid)
    runtime, code, repo = plain_path_text(runtime), plain_path_text(code), plain_path_text(repo)
    lines = [
        "# Create's Code service for uid " + str(int(uid)) + ", as install/macos/code-runtime.py's seatbelt profile confines it on a Mac.",
        "profile " + name + " flags=(attach_disconnected) {",
        "  include <abstractions/base>",
        "  include <abstractions/python>",
        "  / r,",
        "  /{etc,usr,opt}/** r,",
        "  /{,usr/}{bin,sbin}/** mrix,",
        "  /{,usr/}lib{,32,64,exec}/** mrix,",
        "  @{PROC}/ r,",
        "  @{PROC}/@{pid}/** r,",
        "  @{PROC}/{cpuinfo,meminfo,stat,loadavg,uptime,version,filesystems,mounts} r,",
        "  @{PROC}/sys/** r,",
        "  /sys/devices/system/** r,",
        "  /sys/fs/cgroup/** r,",
        "  /dev/{null,zero,full,random,urandom} rw,",
        "  /dev/pts/* rw,",
        "  " + runtime + "/runtime/python/** mrix,",
        "  " + runtime + "/venv/** mrix,",
        "  " + code + "/ r,",
        "  " + code + "/releases/** r,",
        "  " + code + "/{config.json,operator-token} r,",
        "  " + code + "/{state,tmp,wd,home}/ rw,",
        "  " + code + "/{state,tmp,wd,home}/** rwlk,",
        "  " + code + "/logs/ r,",
        "  " + code + "/logs/** rw,",
        "  " + repo + "/ rw,",
        "  " + repo + "/** rwlk,",
        "  network inet stream,",
        "  network inet6 stream,",
        "  unix,",
        "  signal (send, receive) peer=" + name + ",",
        "  signal (send, receive) peer=" + name + "//&unconfined,",
        "  signal (receive) peer=unconfined,",
        "  ptrace (readby) peer=unconfined,",
        "",
        "  include if exists <local/" + name + ">",
        "}",
    ]
    return "\n".join(lines) + "\n"


def apparmor_profiles(uid, runtime, code, repo, restricted):
    """This account's one profile file: the Code service's profile always, and the mind launcher's where AppArmor
    restricts user namespaces. `userns` needs AppArmor 4 (24.04 and later); 22.04's parser knows abi 3.0 only."""
    text = ("# Purpose: OmegaHive's AppArmor profiles for uid " + str(int(uid)) + ".\n"
            "abi <abi/" + ("4.0" if restricted else "3.0") + ">,\ninclude <tunables/global>\n\n"
            + code_profile(uid, runtime, code, repo))
    if restricted:
        text += "\n" + launcher_profile(uid, runtime / "app/hive/supervisor/landlock.py")
    return apparmor_file_name(uid), text


def clean_env(home, path):
    return {"HOME": str(home), "PATH": path, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "UV_NO_CONFIG": "1"}


def control_env(home, libpython_dir=None, browser=False):
    env = clean_env(home, "/usr/bin:/bin")
    run = P("/run/user") / str(os.getuid())
    plain(run, directory=True)
    need(stat.S_IMODE(run.stat().st_mode) == 0o700, "Please sign out of Ubuntu and sign back in, then run the installer again.")
    env.update(XDG_RUNTIME_DIR=str(run), DBUS_SESSION_BUS_ADDRESS="unix:path=" + str(run / "bus"))
    if libpython_dir is not None:
        selected = P(libpython_dir); plain(selected, directory=True)
        need(selected == selected.resolve(strict=True) and selected.is_relative_to(home / ".local/share/omegahive/releases"),
             "The Python loader path is outside the installed release.")
        env["LD_LIBRARY_PATH"] = str(selected)
    if browser:
        # These values reach only the separate control client's own strict validation.
        for key in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"):
            if key in os.environ:
                env[key] = os.environ[key]
    return env


def stdout_is_terminal():
    """Only stdout decides automatic sign-in output; curl|sh may have piped stdin."""
    try:
        return os.isatty(sys.stdout.fileno())
    except (AttributeError, OSError, ValueError):
        return False


def stop_requested(_number, _frame):
    global STOP
    STOP = True


def present(path):
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def owned_json(path):
    """Small no-follow records only; never use record-provided deletion paths."""
    before = plain(path)
    need(before.st_nlink == 1 and before.st_size <= 65536, "An installation record is unsafe.")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        need(identity(before) == identity(opened), "An installation record changed.")
        raw = bytearray()
        while len(raw) <= 65536:
            block = os.read(fd, min(65536, 65537 - len(raw)))
            if not block: break
            raw.extend(block)
        need(len(raw) <= 65536 and identity(opened) == identity(os.fstat(fd)) == identity(path.lstat()),
             "An installation record changed.")
        return strict_json(raw)
    finally:
        os.close(fd)


def progress_paths(home):
    root = home / ".local/share/omegahive"
    return {"unit": home / ".config/systemd/user" / UNIT,
            "code_unit": home / ".config/systemd/user" / CODE_UNIT,
            "manager": root / "bin/install.py", "shim": home / ".local/bin/omegahive",
            "state": root / "installation-state.json"}


def progress_record(home, expected_release=None):
    root = home / ".local/share/omegahive"; plain(root, directory=True)
    value = owned_json(root / "install-progress.json")
    need(type(value) is dict and set(value) == {"schema", "attempt", "release_id", "source_revision",
         "source_tree", "runtime_identity", "owned_files"}
         and value["schema"] == "studio-linux-user-install-progress/1"
         and type(value["attempt"]) is str and re.fullmatch("[a-f0-9]{32}", value["attempt"])
         and type(value["release_id"]) is str and re.fullmatch("[a-z0-9][a-z0-9._-]{1,79}", value["release_id"])
         and all(type(value[k]) is str and re.fullmatch("[a-f0-9]{40}", value[k])
                 for k in ("source_revision", "source_tree")), "The incomplete installation record is unsupported.")
    need(expected_release is None or value["release_id"] == expected_release,
         "This incomplete installation belongs to a different release. Use ~/.local/bin/omegahive uninstall first.")
    need(type(value["owned_files"]) is dict and set(value["owned_files"]) <= set(progress_paths(home)),
         "The incomplete installation lists an unknown file.")
    for kind, pins in value["owned_files"].items():
        need(type(pins) is list and 1 <= len(pins) <= (2 if kind == "shim" else 1), "An ownership pin is invalid.")
        for pin in pins:
            need(type(pin) is dict and set(pin) == {"bytes", "sha256"}
                 and type(pin["bytes"]) is int and 0 <= pin["bytes"] <= 2 * 1024**2
                 and type(pin["sha256"]) is str and re.fullmatch("[a-f0-9]{64}", pin["sha256"]),
                 "An ownership pin is invalid.")
    identity = value["runtime_identity"]
    need(identity is None or (type(identity) is dict and set(identity) == {"device", "inode"}
         and type(identity["device"]) is int and identity["device"] >= 0
         and type(identity["inode"]) is int and identity["inode"] > 0), "The release ownership record is invalid.")
    return value


def matches_owned_pin(path, pins):
    plain(path)
    for pin in pins:
        try:
            pin_file(path, pin, 2 * 1024**2)
            return True
        except Refused:
            pass
    return False


def owned_file(home, kind, raw, mode=0o600):
    path = progress_paths(home)[kind]
    marker = home / ".local/share/omegahive/install-progress.json"
    if not present(marker):
        write_new(path, raw, mode)
        return
    value = progress_record(home)
    old = value["owned_files"].get(kind, [])
    if present(path):
        need(matches_owned_pin(path, old), "A file was changed outside this setup; it was left in place.")
    pin = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    if pin not in old: value["owned_files"][kind] = old + [pin]
    # Save the exact permitted body before creation/replacement, including the crash window.
    atomic_json(marker, value)
    progress_record(home)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    write_new(temporary, raw, mode)
    os.replace(temporary, path)


def recover_partial(home, expected_release=None):
    root = home / ".local/share/omegahive"; value = progress_record(home, expected_release)
    releases = root / "releases"; releases_info = plain(releases, directory=True)
    runtime = releases / value["release_id"]
    need(runtime.parent == releases and runtime == runtime.resolve(), "The partial release path is unsafe.")
    paths = progress_paths(home); existing = []
    # Validate every target before the first command or deletion.
    for kind, path in paths.items():
        for ancestor in path.parents:
            if ancestor == home: break
            if present(ancestor): plain(ancestor, directory=True)
        if present(path):
            pins = value["owned_files"].get(kind, [])
            need(matches_owned_pin(path, pins), "An incomplete setup file changed; it was left in place for review.")
            existing.append(kind)
    initial_runtime_identity = None
    if present(runtime):
        info = plain(runtime, directory=True); recorded = value["runtime_identity"]
        initial_runtime_identity = (info.st_dev, info.st_ino)
        need(recorded is None or (info.st_dev, info.st_ino) == (recorded["device"], recorded["inode"]),
             "The incomplete release was replaced; it was left in place.")
        need(recorded is not None or not any(runtime.iterdir()), "An unrecorded release is not empty; it was left in place.")
    descriptor = root / "runtime.json"
    if present(descriptor):
        data = owned_json(descriptor)
        need(type(data) is dict and data.get("runtime_root") == str(runtime)
             and data.get("data_dir") == str(root / "data"), "The runtime record is not this incomplete setup.")
    if {"unit", "code_unit"} & set(existing):
        env = control_env(home)
        units = [unit for kind, unit in (("unit", UNIT), ("code_unit", CODE_UNIT)) if kind in existing]
        subprocess.run(["/usr/bin/systemctl", "--user", "stop", *units], env=env, check=True, timeout=35)
        subprocess.run(["/usr/bin/systemctl", "--user", "disable", *units], env=env, check=True, timeout=15)
    # Service-manager waits do not preserve custody of a named directory.
    # Refuse replacements before retiring any recovery command, then rejoin again at deletion.
    def rejoin_runtime():
        parent = plain(releases, directory=True)
        need((parent.st_dev, parent.st_ino) == (releases_info.st_dev, releases_info.st_ino)
             and runtime.parent == releases and runtime == runtime.resolve(),
             "The incomplete release path changed; it was left in place.")
        if present(runtime):
            current = plain(runtime, directory=True)
            need(initial_runtime_identity is not None
                 and (current.st_dev, current.st_ino) == initial_runtime_identity,
                 "The incomplete release was replaced; it was left in place.")
            if value["runtime_identity"] is None:
                need(not any(runtime.iterdir()), "An unrecorded release is not empty; it was left in place.")
    rejoin_runtime()
    # Retain the original attempt record before changing its owned artifacts.
    private_dir(root / "logs")
    write_new(root / "logs" / ("incomplete-" + value["attempt"] + "-" + uuid.uuid4().hex + ".json"),
              (json.dumps(value, sort_keys=True) + "\n").encode())
    for kind in ("shim", "unit", "code_unit", "manager", "state"):
        if kind in existing: paths[kind].unlink()
    if {"unit", "code_unit"} & set(existing):
        subprocess.run(["/usr/bin/systemctl", "--user", "daemon-reload"], env=env, check=True, timeout=15)
    if present(runtime):
        if value["runtime_identity"] is None:
            rejoin_runtime()
            runtime.rmdir()
        else:
            need(shutil.rmtree.avoids_symlink_attacks, "This Python cannot safely remove the incomplete setup.")
            rejoin_runtime()
            shutil.rmtree(runtime)
    if present(descriptor): descriptor.unlink()
    (root / "install-progress.json").unlink()
    # Data, caches, logs, install lock and every other release are deliberately retained.


class Installer:
    def __init__(self, bundle, catalogue, home):
        need("%" not in str(home), "Your home folder's name has a % sign, which OmegaHive can't use yet.")
        self.bundle, self.catalogue, self.home = bundle, catalogue, home
        self.root = home / ".local/share/omegahive"
        self.log = None
        self.env = clean_env(home, "/usr/bin:/bin")

    def begin_progress(self, runtime):
        need(type(self.catalogue["release_id"]) is str
             and re.fullmatch("[a-z0-9][a-z0-9._-]{1,79}", self.catalogue["release_id"])
             and runtime == self.root / "releases" / self.catalogue["release_id"]
             and runtime == runtime.resolve(), "The incomplete release path is unsafe.")
        need(not present(self.root / "install-progress.json") and not present(runtime),
             "This release already has setup files that need review before they can be removed.")
        value = {"schema": "studio-linux-user-install-progress/1", "attempt": uuid.uuid4().hex,
                 "release_id": self.catalogue["release_id"], "source_revision": self.catalogue["source_revision"],
                 "source_tree": self.catalogue["source_tree"], "runtime_identity": None, "owned_files": {}}
        # Every pre-existing fixed command/service path is refused, never adopted by guesswork.
        need(not any(present(path) for path in progress_paths(self.home).values()),
             "An existing OmegaHive command or service needs review before setup can continue.")
        atomic_json(self.root / "install-progress.json", value)
        private_dir(runtime)
        info = runtime.lstat(); value["runtime_identity"] = {"device": info.st_dev, "inode": info.st_ino}
        atomic_json(self.root / "install-progress.json", value)
        private_dir(self.root / "bin")
        binroot = self.home / ".local/bin"
        if not binroot.exists(): binroot.mkdir(mode=0o700)
        plain(binroot, directory=True)
        owned_file(self.home, "manager", P(__file__).read_bytes(), 0o444)
        shim = "#!/bin/sh\nunset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME\nexec /usr/bin/python3 -I -B " \
            + shlex.quote(str(self.root / "bin/install.py")) + " \"$@\"\n"
        owned_file(self.home, "shim", shim.encode(), 0o700)

    def finish_progress(self):
        value = progress_record(self.home, self.catalogue["release_id"])
        write_new(self.root / "logs" / ("completed-" + value["attempt"] + ".json"),
                  (json.dumps(value, sort_keys=True) + "\n").encode())
        (self.root / "install-progress.json").unlink()

    def group_rows(self, process, deadline, privileged=False):
        """Numeric Linux snapshot only, filtered in memory to the held session."""
        need(process.returncode is None and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL,
             "The setup process ownership anchor was lost.")
        end = min(deadline, time.monotonic() + PROCESS_SNAPSHOT_TIMEOUT)
        need(end > time.monotonic(), "The setup cleanup deadline expired.")
        monitor = subprocess.Popen(["/usr/bin/ps", "-e", "-o", "pid=,ppid=,pgid=,sid=,ruid=,stat="],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.log,
            env=clean_env(self.home, "/usr/bin:/bin"), close_fds=True)
        selector = selectors.DefaultSelector(); raw = bytearray()
        try:
            os.set_blocking(monitor.stdout.fileno(), False)
            selector.register(monitor.stdout, selectors.EVENT_READ)
            while selector.get_map():
                need(time.monotonic() < end, "The numeric setup monitor timed out.")
                for key, _ in selector.select(min(0.05, max(0, end - time.monotonic()))):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if block: raw.extend(block)
                    else: selector.unregister(key.fileobj)
                    need(len(raw) <= 4 * 1024**2, "The numeric setup monitor exceeded its bound.")
            need(monitor.wait(timeout=max(0.01, end - time.monotonic())) == 0, "The numeric setup monitor failed.")
        finally:
            selector.close(); monitor.stdout.close()
            if monitor.returncode is None:
                monitor.kill(); monitor.wait(timeout=1)
        rows = []
        for line in raw.decode("ascii").splitlines():
            fields = line.split()
            need(len(fields) == 6 and all(re.fullmatch(r"[0-9]+", value) for value in fields[:5])
                 and re.fullmatch(r"[A-Za-z+<NLsl]*", fields[5]), "The numeric setup monitor returned invalid data.")
            row = tuple(int(value) for value in fields[:5]) + (fields[5],)
            if row[0] == process.pid or row[2] == process.pid or row[3] == process.pid: rows.append(row)
        anchors = [row for row in rows if row[0] == process.pid]
        allowed = {os.getuid(), 0} if privileged else {os.getuid()}
        need(process.returncode is None and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
             and len(anchors) == 1 and anchors[0][1] == os.getpid()
             and anchors[0][2] == anchors[0][3] == process.pid
             and all(row[3] == process.pid and row[4] in allowed for row in rows),
             "The held setup session identity could not be verified.")
        return rows

    @staticmethod
    def sole_zombie(process, rows):
        return len(rows) == 1 and rows[0][0] == process.pid and rows[0][5].startswith("Z")

    def cleanup_group(self, process, privileged=False):
        # Cancellation is deferred during cleanup. Repeated catchable signals only set STOP.
        deadline = time.monotonic() + PROCESS_CLEANUP_TIMEOUT
        for number, grace in ((signal.SIGTERM, 3), (signal.SIGKILL, 2)):
            if process.returncode is not None: return
            rows = self.group_rows(process, deadline, privileged)
            if self.sole_zombie(process, rows):
                process.wait(timeout=1); return
            # The original leader remains unreaped. No post-reap numeric signal is allowed.
            need(process.returncode is None, "The setup process was already reaped.")
            try:
                os.killpg(process.pid, number)
            except PermissionError:
                raise Refused("A privileged setup process could not be stopped. Do not retry or remove package locks; "
                              "ask the operator to inspect the held setup session " + str(process.pid) + ".") from None
            until = min(deadline, time.monotonic() + grace)
            while time.monotonic() < until:
                rows = self.group_rows(process, deadline, privileged)
                if self.sole_zombie(process, rows):
                    process.wait(timeout=1); return
                time.sleep(min(0.1, max(0, until - time.monotonic())))
        raise Refused("A setup process could not be fully stopped. Keep the private log; do not retry yet.")

    def run(self, argv, *, cwd=None, timeout=300, console=False, env=None, terminal=None):
        need(type(argv) is list and argv and all(type(v) is str for v in argv), "Invalid installer command.")
        need(not STOP, "Installation was cancelled.")
        need(hasattr(os, "waitid") and hasattr(os, "WNOWAIT")
             and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL,
             "This Ubuntu Python lacks the required held-child cleanup protocol.")
        privileged = argv[0] == "/usr/bin/sudo"
        process = subprocess.Popen(argv, cwd=cwd, env=env or self.env, stdin=terminal if terminal is not None else (None if console else subprocess.DEVNULL),
                                   stdout=None if console else self.log,
                                   stderr=subprocess.PIPE if terminal is not None else (None if console else self.log),
                                   start_new_session=True, close_fds=True)
        deadline = time.monotonic() + timeout
        command_failure = None
        if terminal is not None:
            os.set_blocking(process.stderr.fileno(), False)
        def drain_stderr():
            if terminal is None: return
            try: block = os.read(process.stderr.fileno(), 65536)
            except BlockingIOError: return
            if block:
                # Only child stderr is copied. Password stdin is never read here.
                if self.log is not None: self.log.write(block)
                terminal.write(block)
        try:
            while True:
                drain_stderr()
                if STOP or time.monotonic() >= deadline:
                    raise Refused("Setup stopped: it was cancelled, or one step took too long.")
                exited = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if exited is not None:
                    if getattr(exited, "si_status", 0):
                        command_failure = "Setup command failed (status " + str(exited.si_status) + "). See the setup log for its diagnostic."
                        if self.log is not None: self.log.write((command_failure + "\n").encode())
                    rows = self.group_rows(process, time.monotonic() + PROCESS_SNAPSHOT_TIMEOUT, privileged)
                    need(self.sole_zombie(process, rows), "A setup step left running descendants; cleanup is required.")
                    code = process.wait(timeout=1)
                    drain_stderr()
                    need(code == 0 and not STOP, command_failure or "A setup step could not finish or was cancelled.")
                    break
                time.sleep(0.1)
        except BaseException as error:
            primary = str(error)
            if command_failure and command_failure not in primary:
                primary = command_failure + " Process verification: " + primary
            try:
                if process.returncode is None: self.cleanup_group(process, privileged)
            except Exception as cleanup_error:
                raise Refused(primary + " Cleanup incomplete: " + str(cleanup_error) +
                              " Do not retry until the held setup session is checked.") from error
            if primary != str(error): raise Refused(primary) from error
            raise
        finally:
            if terminal is not None:
                try: drain_stderr()
                finally: process.stderr.close()

    def local(self, spec):
        path = self.bundle / str(relative(spec["path"])); pin_file(path, spec); return path

    def fetch(self, spec):
        cache = self.root / "cache"; private_dir(cache)
        path = cache / spec["sha256"]
        if path.exists():
            pin_file(path, spec); return path
        partial = cache / (spec["sha256"] + "." + uuid.uuid4().hex + ".partial")
        self.run(["/usr/bin/curl", "--disable", "--fail", "--silent", "--show-error", "--location", "--max-redirs", "3",
                  "--proto", "=https", "--proto-redir", "=https", "--proxy", "", "--noproxy", "*",
                  "--tlsv1.2", "--retry", "0", "--max-time", "300", "--max-filesize", str(spec["bytes"]),
                  "--output", str(partial), spec["url"]], timeout=310)
        pin_file(partial, spec); os.chmod(partial, 0o600); os.rename(partial, path); return path

    def sudo(self, argv, *, timeout, package_environment=False):
        assignments = (["DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l"]
                       if package_environment else [])
        need(not package_environment or argv == package_install(),
             "Package environment is only allowed for the fixed package installation.")
        # The shell wrapper consumes stdin, and run() deliberately detaches each
        # child session. Give sudo its own terminal fd; never read the password.
        try:
            terminal = open("/dev/tty", "r+b", buffering=0)
        except OSError:
            # No authentication probe or retry: a failing command may have side effects.
            # NOPASSWD works without a tty, including mixed sudo-group/cloud rules.
            print("No terminal: using noninteractive sudo. If authentication is required, reconnect with ssh -t. "
                  "Restricted apt rules must allow the documented package environment.", file=sys.stderr)
            self.run(["/usr/bin/sudo", "-n", *assignments, *argv], timeout=timeout)
            return
        with terminal:
            need(os.isatty(terminal.fileno()) and os.tcgetpgrp(terminal.fileno()) == os.getpgrp(),
                 "Run system setup in the foreground of your terminal.")
            saved = termios.tcgetattr(terminal)
            hidden = saved[:]
            hidden[3] &= ~(termios.ECHO | termios.ECHONL)
            try:
                # Suppress echo before sudo starts, and restore it even on timeout
                # or cancellation. No password enters Python, a pipe, or a log.
                termios.tcsetattr(terminal, termios.TCSAFLUSH, hidden)
                self.run(["/usr/bin/sudo", "-S", *assignments, *argv], timeout=timeout, terminal=terminal)
            finally:
                termios.tcsetattr(terminal, termios.TCSAFLUSH, saved)

    def apt(self, runtime):
        """Every privileged step, each one fixed command: packages, linger and this account's AppArmor profiles,
        installed and loaded: the Code service's always, and where AppArmor restricts user namespaces the mind
        launcher's too. Returns whether user namespaces are restricted here."""
        restricted = userns_restricted()
        need(apparmor_enabled(), "Create's Code service runs confined by AppArmor, which is turned off on this computer. "
             "Ubuntu has it on unless it was switched off; turn it back on, restart, and run the installer again.")
        # Written and checked before the first password prompt, so an unusable path stops before any system change.
        name, text = apparmor_profiles(os.getuid(), runtime, self.root / "code", self.root / "repos/small-app", restricted)
        source = runtime / "omegahive.apparmor"; write_new(source, text.encode())
        # Detached sudo sessions cannot reliably share cached authentication.
        # Each fixed command may prompt; do not weaken sudo policy to avoid it.
        print("OmegaHive needs permission to add standard Ubuntu packages, keep running when you log out, keep Create's "
              "Code service in its own sandbox" + (" and let its minds start in theirs" if restricted else "")
              + ". You may be asked for your password for each of the five system setup steps. If Ubuntu is installing "
              "its own updates, setup waits for them to finish.", flush=True)
        self.sudo(apt_get("update"), timeout=APT_LOCK_WAIT + 600)
        # Package hooks must not ask hidden questions through logged stdout.
        # Report pending restarts; leave host service restarts to its operator.
        self.sudo(package_install(), timeout=APT_LOCK_WAIT + 900, package_environment=True)
        # Linger keeps this user's own service manager running after logout and at boot.
        self.sudo(["/usr/bin/loginctl", "enable-linger", linger_user()], timeout=60)
        # /etc/apparmor.d is what apparmor.service loads at boot, before linger starts this account's services.
        target = str(APPARMOR_PROFILES / name)
        self.sudo(["/usr/bin/install", "-o", "root", "-g", "root", "-m", "0644", str(source), target], timeout=60)
        self.sudo([APPARMOR_PARSER, "-r", target], timeout=120)
        return restricted

    def install(self):
        # Check existing launch/service ancestors before creating progress or using sudo.
        for name in (".local", ".local/bin", ".local/share", ".config", ".config/systemd", ".config/systemd/user"):
            path = self.home / name
            if present(path): plain(path, directory=True)
        arch = preflight(self.home, self.catalogue["min_free_bytes"])
        print("Checking your computer… ✓", flush=True)
        for path in [self.home / ".local", self.home / ".local/share"]:
            if not path.exists(): path.mkdir(mode=0o700); strip_inherited_acl(path)
            plain(path, directory=True)
        private_dir(self.root); private_dir(self.root / "logs")
        private_dir(self.root / "releases")
        selected = self.catalogue["platforms"][arch]
        # Validate every bundled postimage before the password prompt or any apt change.
        for key in ("source_payload", "core_lock", "build_lock"): self.local(selected[key])
        validate_lock(self.local(selected["core_lock"]), core=True)
        validate_lock(self.local(selected["build_lock"]))
        for spec in self.catalogue["apps"]: self.local(spec)
        for spec in self.catalogue["bootstrap"].values(): self.local(spec)
        for key in ("archive", "manifest"): self.local(self.catalogue["ui_prebuilt"][key])
        self.local(self.catalogue["omega_core"])
        self.local(self.catalogue["code_service"])
        logpath = self.root / "logs" / ("install-" + uuid.uuid4().hex + ".log")
        lockfd = lock_installation(self.home)
        try:
            self.log = open(logpath, "xb", buffering=0); os.chmod(logpath, 0o600)
            if present(self.root / "install-progress.json"):
                if present(self.root / "installation-state.json"):
                    self.resume_setup()
                    return
                recover_partial(self.home, self.catalogue["release_id"])
            need(not present(self.root / "installation-state.json"),
                 "OmegaHive is already installed. To open it: omegahive open")
            need(not present(self.root / "runtime.json"),
                 "An older incomplete setup has no ownership record. Its files were kept; please keep the logs for review.")
            print("Getting OmegaHive ready. This takes about 15 minutes; you can leave it running…", flush=True)
            runtime = self.root / "releases" / self.catalogue["release_id"]
            self.begin_progress(runtime)
            private_dir(runtime / "runtime")
            app = runtime / "app"; extract_source(self.local(selected["source_payload"]), app,
                selected["source_payload"]["files"], selected["source_payload"]["prefix"])
            for row in self.catalogue["module_files"]:
                pin_file(app / str(relative(row["path"])), row)
            ui = self.catalogue["ui_prebuilt"]
            ui_manifest_raw = extract_prebuilt_ui(self.local(ui["archive"]), self.local(ui["manifest"]),
                                                app / "hive/ui/dist", ui)
            write_new(runtime / "ui-prebuilt.manifest.json", ui_manifest_raw, 0o444)
            atomic_json(runtime / "ui-prebuilt-provenance.json", {"schema": "studio-linux-installed-ui-provenance/1",
                "source_revision": ui["source_revision"], "source_tree": ui["source_tree"],
                "archive": {key: ui["archive"][key] for key in ("bytes", "sha256")},
                "manifest": {key: ui["manifest"][key] for key in ("bytes", "sha256")},
                "host_source_revision": self.catalogue["source_revision"], "host_source_tree": self.catalogue["source_tree"]})
            pins = {}; plugins = []; private_dir(runtime / "apps")
            for spec in self.catalogue["apps"]:
                folder = runtime / "apps" / spec["id"]
                extract_app(self.local(spec), folder, spec)
                need(program_digest(folder, spec["files"]) == spec["digest"], "A bundled app does not match its reviewed source digest.")
                pins[spec["id"]] = {"release": str(folder), "digest": spec["digest"],
                    "files": {row["path"]: row["sha256"] for row in spec["files"]}}
                plugins.append(str(folder))
            # No sudo occurs until the complete source/module/app inventories have matched.
            if not self.apt(runtime):
                # Where AppArmor restricts user namespaces only the launcher's profile grants one, so this plain probe
                # can't pass there; the hive's own start-time preflight, which bootstrap.py requires, proves the launcher.
                self.run(["/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "/usr/bin/true"], timeout=10)
            uvroot = runtime / "runtime/uv"
            extract_tool(self.fetch(selected["uv"]), uvroot)
            uv = uvroot / "uv"
            self.env = clean_env(self.home, "/usr/bin:/bin")
            # uv's cache lives inside the release. A wheel uv builds here can link this release's own SWI-Prolog by
            # absolute path (janus-swi's _swipl), and uv keys a built wheel by its source, not by what it linked, so
            # a cache shared across releases handed a v0.33 build to a v0.34 install after uninstall had removed
            # v0.33, and the install stopped on "libswipl.so.10: cannot open shared object file".
            self.env.update(UV_PYTHON_DOWNLOADS="never", UV_CACHE_DIR=str(runtime / "runtime/uv-cache"))
            # Earlier releases kept that shared cache beside the releases; only builds against their paths can be in
            # it, so it goes instead of growing in the person's home.
            legacy = self.root / "cache/uv"
            if legacy.exists() or legacy.is_symlink():
                plain(legacy, directory=True); shutil.rmtree(legacy)
            # Exact python-build-standalone publisher archive, checksum-pinned independently of uv.
            pyroot = runtime / "runtime/python"
            extract_tool(self.fetch(selected["python"]), pyroot)
            python = (pyroot / "bin/python3.12").resolve(strict=True)
            need(python.is_relative_to(runtime), "Python was not installed inside this release."); plain(python)
            pybase = python.parent.parent; libpython = pybase / "lib"
            need(libpython == runtime / "runtime/python/lib" and libpython == libpython.resolve(strict=True),
                 "The reviewed Python layout does not match this release contract.")
            self.env["LD_LIBRARY_PATH"] = str(libpython)
            self.run([str(python), "-I", "-B", "-S", "-c",
                      "import sys; raise SystemExit(0 if '.'.join(map(str, sys.version_info[:3])) == "
                      + repr(self.catalogue["python_version"]) + " else 1)"], timeout=10)
            self.run([str(uv), "--no-config", "venv", "--python", str(python), str(runtime / "venv")], timeout=120)
            venv = materialize_venv_python(runtime / "venv/bin/python", python)
            swisrc, pettasrc = runtime / "runtime/swipl-source", runtime / "runtime/PeTTa"
            extract_tool(self.fetch(selected["swipl_source"]), swisrc)
            extract_tool(self.fetch(selected["petta_source"]), pettasrc)
            swi = runtime / "runtime/swipl"; build = runtime / "runtime/swipl-build"
            self.run(["/usr/bin/cmake", "-S", str(swisrc), "-B", str(build), "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
                      "-DSWIPL_PACKAGES_X=OFF", "-DSWIPL_PACKAGES_JAVA=OFF", "-DSWIPL_PACKAGES_ODBC=OFF", "-DSWIPL_PACKAGES_QT=OFF",
                      "-DINSTALL_DOCUMENTATION=OFF", "-DBUILD_TESTING=OFF", "-DCMAKE_INSTALL_PREFIX=" + str(swi),
                      "-DPython_EXECUTABLE=" + str(python), "-DPython_ROOT_DIR=" + str(pybase),
                      "-DPython3_EXECUTABLE=" + str(python), "-DPython3_ROOT_DIR=" + str(pybase),
                      "-DCMAKE_INSTALL_RPATH=" + str(libpython)], timeout=300)
            self.run(["/usr/bin/cmake", "--build", str(build), "--parallel", "2"], timeout=1800)
            self.run(["/usr/bin/cmake", "--install", str(build)], timeout=300)
            swipl = place_swipl(swi)
            self.env.update(PATH=str(swi / "bin") + ":" + str(runtime / "venv/bin") + ":" + self.env["PATH"], LD_LIBRARY_PATH=str(libpython))
            # Locks cover current Hive requirements/constraints, the explicit Janus bridge, and reviewed runtime/build dependencies.
            self.run([str(uv), "--no-config", "pip", "sync", "--python", str(venv), "--require-hashes", "--require-build-hashes",
                      "--build-constraint", str(self.local(selected["build_lock"])), str(self.local(selected["core_lock"]))], timeout=1800,
                      env=dict(self.env, CC="/usr/bin/gcc", CXX="/usr/bin/g++"))
            self.run([str(venv), "-I", "-B", "-c", "import janus_swi as j; assert j.query_once('X is 1+1')['X'] == 2"], timeout=30)
            self.run([str(swipl), "-g", "use_module(library(janus)),py_call(operator:add(20,22),V),(V=:=42->halt(0);halt(1))"], timeout=30)
            self.omega_core(app, venv)
            code = self.code_service(app, venv)
            data = self.root / "data"
            if not data.exists(): private_dir(data)
            plain(data, directory=True); need(stat.S_IMODE(data.stat().st_mode) == 0o700, "Your hive data folder must be private.")
            need(len(str(data / "run/control.sock").encode()) < 100, "Your home path is too long for the private control socket.")
            descriptor = {"schema": "studio-linux-user-runtime/3", "runtime_root": str(runtime), "release_root": str(app),
                "python": str(venv), "petta_path": str(pettasrc), "data_dir": str(data), "port": 8700, "browser_port": 8701,
                "sandbox_python": str(venv), "source_revision": self.catalogue["source_revision"],
                "plugin_dirs": plugins, "app_pins": pins, "swipl_bin": str(swipl), "libpython_dir": str(libpython),
                "studio_maker_template": None, "default_model": self.catalogue["default_model"],
                "embedding_model": self.catalogue["embedding_model"], "ssh_target": self.catalogue["ssh_target"],
                "code_service": code}
            atomic_json(self.root / "runtime.json", descriptor)
            for row in self.catalogue["module_files"]:
                pin_file(app / str(relative(row["path"])), row)
            self.activate(app, venv, descriptor)
            self.complete_setup(app, venv, libpython)
        except BaseException:
            if present(self.root / "installation-state.json") and not present(self.root / "install-progress.json"):
                print("OmegaHive is installed. To retry browser sign-in, run ~/.local/bin/omegahive open. Details: " + str(logpath), file=sys.stderr)
            else:
                print("OmegaHive couldn't finish setting up. The details are in: " + str(logpath), file=sys.stderr)
            if present(self.home / ".local/bin/omegahive"):
                if present(self.root / "installation-state.json") and present(self.root / "install-progress.json"):
                    print("The runtime is installed, but final setup or sign-in did not finish. Check ~/.local/bin/omegahive status "
                          "and journalctl --user -u omegahive.service. Rerun this same installer to resume without rebuilding.", file=sys.stderr)
                elif present(self.root / "install-progress.json"):
                    print("To remove the incomplete setup and keep your data: ~/.local/bin/omegahive uninstall", file=sys.stderr)
            raise
        finally:
            if self.log is not None: self.log.close()
            os.close(lockfd)

    def omega_core(self, app, python):
        """Minds run on singnet/Omega at the revision core-dependency.json pins (hive/runtime/core.py), and a release
        tree carries none of it. The kit carries it as the git bundle the Mac zip ships, so this needs no network: the
        release's own scripts/setup_core.py clones it into third_party/Omega, checks the revision and stamps it where
        the hive and its minds look (native_core.runtime_directory), as omegahive.sh's core step does on the Mac.
        Iter, pinned beside it, is cloned by the hive when a mind first needs it."""
        bundle = self.local(self.catalogue["omega_core"])
        revision = strict_json((app / "core-dependency.json").read_bytes()).get("revision")
        need(type(revision) is str and re.fullmatch("[a-f0-9]{40}", revision) is not None
             and bundle.name == "omega-core-" + revision[:7] + ".bundle",
             "The bundled Omega core is not the revision this release pins.")
        self.run([str(python), "-I", "-B", str(app / "scripts/setup_core.py"), "--source", str(bundle)], timeout=300)

    def code_service(self, app, python):
        """Create · Code's service, set up as install/macos/setup-code.sh sets it up, all inside this hive's folder:
        the published omegacode release unpacked from the kit's pinned tarball and checked, made the portable release
        the hive accepts by the release's two adapters, checked again and left read-only; one disposable small-app
        repository the minds build in, with the installer's project check; a private config and operator token; and
        empty private working, home and temp folders. Rerunning keeps the release, repository, token and state."""
        published, portable = code_releases(app)
        code = self.root / "code"
        private_dir(code)
        for name in ("releases", "state", "wd", "tmp", "home", "logs"):
            private_dir(code / name)
        release = code / "releases" / portable
        if not present(release / "omegacode/__init__.py"):
            staging = code / "releases" / (portable + ".new")
            if present(staging):
                plain(staging, directory=True); shutil.rmtree(staging)
            private_dir(staging)
            extract_tool(self.local(self.catalogue["code_service"]), staging / "omegacode")
            need(module_digest(staging / "omegacode") == published,
                 "The bundled Code service is not the published release this hive accepts.")
            for adapter in CODE_PATCHES:
                self.run(["/usr/bin/patch", "-p1", "-s", "-d", str(staging), "-i", str(app / "install/macos" / adapter)], timeout=60)
            for path in (staging / "omegacode").rglob("*"):
                if path.is_file() and not path.is_symlink():
                    path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
            os.rename(staging, release)
        need(module_digest(release / "omegacode") == portable,
             "The Code service's files are not the portable release this hive accepts.")
        # Only the selected release runs; one an older setup unpacked goes.
        for old in (code / "releases").iterdir():
            if old != release:
                plain(old, directory=True); shutil.rmtree(old)
        repo = self.root / "repos/small-app"
        private_dir(self.root / "repos")
        if not present(repo / ".git"):
            private_dir(repo)
            files = {
                "README.md": "# Small app\n\nA repository your hive's minds build small web apps in: index.html loads "
                             "style.css and app.js,\nand app.js draws into <main id=\"app\">. Nothing here is kept.\n",
                "index.html": "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n"
                              "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
                              "  <title>Small app</title>\n  <link rel=\"stylesheet\" href=\"./style.css\">\n</head>\n<body>\n"
                              "  <main id=\"app\"></main>\n  <script type=\"module\" src=\"./app.js\"></script>\n</body>\n</html>\n",
                "app.js": "// The app the hive builds lives here. It draws into <main id=\"app\"> in index.html.\n"
                          "const app = document.getElementById(\"app\");\n"
                          "app.textContent = \"Nothing here yet: ask the hive to build something.\";\n",
                "style.css": "body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n",
            }
            for name, text in files.items():
                write_new(repo / name, text.encode())
            write_new(repo / "check_app.py", (app / "install/macos/check-app.py").read_bytes())
            git = ["/usr/bin/git", "-C", str(repo)]
            self.run(git + ["init", "-q", "-b", "main"], timeout=30, env=self.git_env())
            self.run(git + ["add", "README.md", "index.html", "app.js", "style.css", "check_app.py"], timeout=30, env=self.git_env())
            self.run(git + ["-c", "user.name=Your hive", "-c", "user.email=hive@localhost", "commit", "-qm", "Start the small app"],
                     timeout=30, env=self.git_env())
        token = code / "operator-token"
        if not present(token):
            write_new(token, secrets.token_urlsafe(48).encode())
        # install/macos/code-runtime.py prepare's config, as it writes it off a Mac: no proposal or project tests.
        config = {"data_root": str(code / "state"), "operator_token_file": str(token), "port": CODE_PORT,
                  "hive_url": "http://127.0.0.1:8700", "repositories": {"small-app": {"path": str(repo)}},
                  "proposal_tests_enabled": False, "sandbox_project_tests_enabled": False,
                  "copy_effect_policy": {"kind": "disposable-app-files-v1", "repository_id": "small-app",
                                         "paths": ["index.html", "app.js", "style.css", "README.md"]}}
        atomic_json(code / "config.json", config)
        return {"release": portable, "root": str(code), "config": str(code / "config.json"),
                "repository": str(repo), "port": CODE_PORT}

    def git_env(self):
        """git for the small-app repository only: no system or account configuration, no prompts."""
        return dict(clean_env(self.home, "/usr/bin:/bin"), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                    GIT_TERMINAL_PROMPT="0")

    def resume_setup(self):
        progress = progress_record(self.home, self.catalogue["release_id"])
        need(all(progress[k] == self.catalogue[k] for k in ("source_revision", "source_tree")),
             "The interrupted setup belongs to different source bytes; its files were kept.")
        for kind, path in progress_paths(self.home).items():
            need(matches_owned_pin(path, progress["owned_files"].get(kind, [])),
                 "An interrupted setup file changed; its files were kept for review.")
        runtime = self.root / "releases" / self.catalogue["release_id"]
        info = plain(runtime, directory=True)
        need(progress["runtime_identity"] == {"device": info.st_dev, "inode": info.st_ino},
             "The interrupted release directory was replaced; its files were kept.")
        config = owned_json(self.root / "runtime.json")
        state = owned_json(self.root / "installation-state.json")
        app = runtime / "app"; python = runtime / "venv/bin/python"
        need(runtime == runtime.resolve() and app == app.resolve() and python == python.resolve(),
             "The interrupted runtime contains a redirected path; its files were kept.")
        need(config.get("runtime_root") == str(runtime) and config.get("release_root") == str(app)
             and config.get("python") == str(python) and state.get("python") == str(python)
             and config.get("data_dir") == str(self.root / "data")
             and config.get("source_revision") == self.catalogue["source_revision"],
             "The interrupted runtime does not match this installer; its files were kept.")
        plain(python)
        # A retry may reuse only the same reviewed source, never a new runtime in place.
        selected = self.catalogue["platforms"][platform.machine()]
        for row in selected["source_payload"]["files"]:
            pin_file(app / str(relative(row["path"])), row)
        libpython = runtime / "runtime/python/lib"
        need(config.get("libpython_dir") == str(libpython), "The interrupted loader path changed.")
        plain(libpython, directory=True)
        self.env = dict(clean_env(self.home, "/usr/bin:/bin"), LD_LIBRARY_PATH=str(libpython))
        print("Keeping the installed runtime and data; resuming final setup…", flush=True)
        self.run(["/usr/bin/systemctl", "--user", "daemon-reload"], timeout=90, env=control_env(self.home))
        self.run(["/usr/bin/systemctl", "--user", "enable", *UNITS], timeout=90, env=control_env(self.home))
        for name in UNITS:
            self.run(["/usr/bin/systemctl", "--user", "start", name], timeout=90, env=control_env(self.home))
        self.complete_setup(app, python, libpython)

    def complete_setup(self, app, python, libpython):
        helper = self.local(self.catalogue["bootstrap"]["helper"])
        self.run([str(python), "-I", "-B", str(helper), "--runtime", str(self.root / "runtime.json")],
                 timeout=BOOTSTRAP_TIMEOUT)
        self.run([str(python), "-I", "-B", str(app / "deploy/linux/control.py"), "--runtime", str(self.root / "runtime.json"),
                  "status", "--json"], timeout=15)
        # Browser/link failure does not make a successfully configured runtime incomplete.
        self.finish_progress()
        print("Getting OmegaHive ready… ✓", flush=True)
        print("Preparing your sign-in…", flush=True)
        self.open_after_install(app, python, libpython)
        print("Next time, open it with:  ~/.local/bin/omegahive open")
        print("(Or open a new terminal after signing out and in, then use: omegahive open)")

    def open_after_install(self, app, python, libpython):
        env = control_env(self.home, str(libpython), browser=True)
        argv = [str(python), "-I", "-B", str(app / "deploy/linux/control.py"),
                "--runtime", str(self.root / "runtime.json"), "open"]
        if not env.get("DISPLAY") and not env.get("WAYLAND_DISPLAY"):
            # console=True bypasses our private log but can still inherit a harness PIPE.
            argv.append("--defer-headless-signin")
        self.run(argv, timeout=OPEN_TIMEOUT, console=True, env=env)

    def activate(self, app, python, descriptor):
        config = self.home / ".config"
        if not config.exists(): config.mkdir(mode=0o700)
        plain(config, directory=True); parent_chain(config, config / "systemd/user")
        unit = config / "systemd/user" / UNIT
        code_unit = config / "systemd/user" / CODE_UNIT
        need(not unit.exists() and not code_unit.exists(),
             "An OmegaHive user service already exists. Stop or uninstall that installation first.")
        def quote(value):
            need(not any(c in value for c in "\x00\n\r%"), "A service path contains an unsupported character.")
            return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
        body = (app / "deploy/linux/omegahive.service.in").read_text()
        values = {"PYTHON": str(python), "SERVE": str(app / "deploy/linux/serve.py"),
                  "RUNTIME": str(self.root / "runtime.json"), "WORKDIR": str(app),
                  "SANDBOX_ENV": "HIVE_SANDBOX_PYTHON=" + descriptor["sandbox_python"],
                  "LIBPYTHON_ENV": "LD_LIBRARY_PATH=" + (descriptor["libpython_dir"] or "")}
        for key, value in values.items():
            if key in {"PYTHON", "SERVE", "RUNTIME"}: value = value.replace("$", "$$")
            quoted = quote(value)
            if key == "WORKDIR":
                plain_path_text(value)
            body = body.replace("@" + key + "@", value if key == "WORKDIR" else quoted)
        need(not re.search("@[A-Z_]+@", body), "The service template is incomplete.")
        owned_file(self.home, "unit", body.encode())
        code = descriptor["code_service"]
        code_root = P(code["root"])
        code_values = {"WORKDIR": code_root / "wd", "RELEASE": code_root / "releases" / code["release"],
                       "HOME": code_root / "home", "TMPDIR": str(code_root / "tmp") + "/",
                       "LIBPYTHON": descriptor["libpython_dir"] or "", "PYTHON": python, "CONFIG": code["config"],
                       "PROFILE": code_profile_name(os.getuid()), "LOG": code_root / "logs/service.log"}
        code_body = (app / "deploy/linux/omegacode.service.in").read_text()
        for key, value in code_values.items():
            text = str(value)
            if key != "PROFILE" and text:
                # Every path stands unquoted: the guard reads ExecStart and Environment word by word.
                plain_path_text(text.rstrip("/"))
            code_body = code_body.replace("@" + key + "@", text)
        need(not re.search("@[A-Z_]+@", code_body), "The Code service template is incomplete.")
        owned_file(self.home, "code_unit", code_body.encode())
        manager_env = control_env(self.home)
        try:
            # systemd before 258 binds a verify run's private bus socket at $XDG_RUNTIME_DIR/systemd/private, replacing
            # the running user manager's (systemd issue 36540, fixed by pull request 36719): Ubuntu 22.04 ships 249 and
            # 24.04 ships 255, where every later `systemctl --user` then fails unless a user D-Bus socket exists. So the
            # check gets a runtime directory of its own, which goes when it ends.
            with tempfile.TemporaryDirectory(prefix="verify-", dir=manager_env["XDG_RUNTIME_DIR"]) as scratch:
                self.run(["/usr/bin/systemd-analyze", "--user", "verify", str(unit), str(code_unit)], timeout=30,
                         env=dict(manager_env, XDG_RUNTIME_DIR=scratch))
        except (Refused, OSError, subprocess.SubprocessError):
            raise Refused("Your Ubuntu user service could not be validated. Setup stopped before starting it; keep the private log for review.") from None
        private_dir(self.root / "bin"); manager = self.root / "bin/install.py"
        manager_raw = P(__file__).read_bytes()
        owned_file(self.home, "manager", manager_raw, 0o444)
        state = {"schema": "studio-linux-user-installation/3", "runtime_root": descriptor["runtime_root"], "unit": str(unit), "unit_sha256": hashlib.sha256(body.encode()).hexdigest(),
                 "code_unit": str(code_unit), "code_unit_sha256": hashlib.sha256(code_body.encode()).hexdigest(),
                 "code_root": code["root"],
                 "python": str(python), "control": str(app / "deploy/linux/control.py"), "data_dir": descriptor["data_dir"],
                  "libpython_dir": descriptor["libpython_dir"],
                  "manager_pin": {"bytes": len(manager_raw), "sha256": hashlib.sha256(manager_raw).hexdigest()}}
        owned_file(self.home, "state", (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode())
        binroot = self.home / ".local/bin"
        if not binroot.exists(): binroot.mkdir(mode=0o700)
        plain(binroot, directory=True)
        shim = "#!/bin/sh\nunset LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME\nLD_LIBRARY_PATH=" + shlex.quote(descriptor["libpython_dir"] or "") + " exec " \
            + shlex.quote(str(python)) + " -I -B " + shlex.quote(str(manager)) + " \"$@\"\n"
        owned_file(self.home, "shim", shim.encode(), 0o700)
        self.run(["/usr/bin/systemctl", "--user", "daemon-reload"], timeout=15, env=manager_env)
        self.run(["/usr/bin/systemctl", "--user", "enable", *UNITS], timeout=30, env=manager_env)
        # The hive first, then its Code service, which registers with it once bootstrap.py enrols it.
        for name in UNITS:
            self.run(["/usr/bin/systemctl", "--user", "start", name], timeout=90, env=manager_env)


def manage_locked(command, home, json_output=False):
    root = home / ".local/share/omegahive"; plain(root, directory=True)
    incomplete = present(root / "install-progress.json")
    if incomplete and command == "uninstall":
        recover_partial(home)
        print("OmegaHive is removed. Your conversations were kept in ~/.local/share/omegahive/data")
        print_removal_notes()
        return 0
    if incomplete:
        need(command in {"status", "stop", "tunnel"} and present(root / "installation-state.json"),
             "Setup is incomplete. Rerun the same installer to finish; an activated runtime will be kept.")
        print("Setup is incomplete; rerun the same installer to finish configuration.", file=sys.stderr)
    statepath = root / "installation-state.json"
    need(present(statepath), "There is no complete installation record. Unrecorded files were kept; please keep the logs for review.")
    state = owned_json(statepath)
    fields = {"schema", "runtime_root", "unit", "unit_sha256", "python", "control", "data_dir", "libpython_dir"}
    code_fields = {"code_unit", "code_unit_sha256", "code_root"}
    need(type(state) is dict and ((state.get("schema") == "studio-linux-user-installation/1" and set(state) == fields)
         or (state.get("schema") == "studio-linux-user-installation/2" and set(state) == fields | {"manager_pin"})
         or (state.get("schema") == "studio-linux-user-installation/3" and set(state) == fields | {"manager_pin"} | code_fields)),
         "The installation record has an unsupported shape.")
    runtime = P(state["runtime_root"])
    releases = root / "releases"; plain(releases, directory=True)
    need(runtime.parent == releases and re.fullmatch("[a-z0-9][a-z0-9._-]{1,79}", runtime.name)
         and runtime == runtime.resolve(), "The installation record is not one exact release.")
    need(P(state["python"]).resolve(strict=True).is_relative_to(runtime)
         and P(state["control"]) == runtime / "app/deploy/linux/control.py"
         and P(state["data_dir"]) == root / "data", "The installation record points outside this release.")
    need(state["libpython_dir"] is None or P(state["libpython_dir"]) == runtime / "runtime/python/lib"
         == P(state["libpython_dir"]).resolve(strict=True),
         "The installation loader path is outside this release.")
    unit = home / ".config/systemd/user" / UNIT; plain(unit)
    for path in (home / ".config", home / ".config/systemd", unit.parent, home / ".local", home / ".local/bin"):
        plain(path, directory=True)
    plain(home / ".local/bin/omegahive")
    need(str(unit) == state["unit"] and hashlib.sha256(unit.read_bytes()).hexdigest() == state["unit_sha256"],
         "Your service was changed. Please review it before using stop or uninstall.")
    units = [UNIT]
    code_root = None
    if state["schema"] == "studio-linux-user-installation/3":
        code_unit = unit.parent / CODE_UNIT; plain(code_unit)
        need(str(code_unit) == state["code_unit"]
             and hashlib.sha256(code_unit.read_bytes()).hexdigest() == state["code_unit_sha256"],
             "Your Code service was changed. Please review it before using stop or uninstall.")
        code_root = root / "code"
        need(state["code_root"] == str(code_root), "The installation record points outside this hive.")
        units.append(CODE_UNIT)
    manager = root / "bin/install.py"
    if state["schema"] in {"studio-linux-user-installation/2", "studio-linux-user-installation/3"}:
        need(type(state["manager_pin"]) is dict and set(state["manager_pin"]) == {"bytes", "sha256"},
             "The installed command pin is invalid.")
        if present(manager):
            plain(manager.parent, directory=True)
            need(matches_owned_pin(manager, [state["manager_pin"]]), "The installed command changed; it was kept for review.")
    env = control_env(home)
    if command in {"open", "status", "tunnel"}:
        if command == "open":
            for name in units:
                subprocess.run(["/usr/bin/systemctl", "--user", "start", name], env=env, check=True, timeout=90)
        argv = [state["python"], "-I", "-B", state["control"], "--runtime", str(root / "runtime.json"), command]
        if json_output: argv.append("--json")
        return subprocess.run(argv, timeout=OPEN_TIMEOUT if command == "open" else 15,
                              env=control_env(home, state["libpython_dir"], browser=command == "open")).returncode
    subprocess.run(["/usr/bin/systemctl", "--user", "stop", *reversed(units)], env=env, check=True, timeout=35)
    if command == "stop":
        print("OmegaHive is stopped. Open it again with: omegahive open"); return 0
    answer = input("Also delete your conversations and everything your hive remembers? This can't be undone. Type DELETE to delete, or press Enter to keep them: ")
    subprocess.run(["/usr/bin/systemctl", "--user", "disable", *units], env=env, check=True, timeout=15)
    # Remove the entry point before any destructive step can retire its interpreter.
    (home / ".local/bin/omegahive").unlink()
    if state["schema"] != "studio-linux-user-installation/1" and present(manager): manager.unlink()
    unit.unlink()
    if code_root is not None: (unit.parent / CODE_UNIT).unlink()
    subprocess.run(["/usr/bin/systemctl", "--user", "daemon-reload"], env=env, check=True, timeout=15)
    # No arbitrary manifest path can become a deletion target. Shared caches, account files and unrelated releases are not removed.
    plain(runtime, directory=True); shutil.rmtree(runtime)
    # The Code service's release, state and token are the runtime's; the repository the minds built in is data.
    if code_root is not None and present(code_root):
        plain(code_root, directory=True); shutil.rmtree(code_root)
    (root / "runtime.json").unlink(); statepath.unlink()
    if answer == "DELETE":
        data = root / "data"; need(str(data) == state["data_dir"], "The data record changed.")
        plain(data, directory=True); shutil.rmtree(data)
        if present(root / "repos"):
            plain(root / "repos", directory=True); shutil.rmtree(root / "repos")
    print("OmegaHive is removed, with all its data." if answer == "DELETE"
          else "OmegaHive is removed. Your conversations were kept in ~/.local/share/omegahive/data")
    print_removal_notes()
    return 0


def linger_user():
    name = pwd.getpwuid(os.getuid()).pw_name
    need(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", name) is not None, "Your Ubuntu user name is not a standard one.")
    return name


LINGER_NOTE = ("Your account still keeps background services running after you log out. "
               "To turn that off: sudo loginctl disable-linger ")
APPARMOR_NOTE = ("Your account's OmegaHive AppArmor profiles stay loaded on this computer. "
                 "To remove them: sudo " + APPARMOR_PARSER + " -R {profile} && sudo rm {profile}")


def print_removal_notes():
    """What uninstall leaves for the account's administrator, since only sudo can undo it."""
    print(LINGER_NOTE + pwd.getpwuid(os.getuid()).pw_name)
    for name in (apparmor_file_name(os.getuid()), launcher_profile_name(os.getuid())):
        profile = APPARMOR_PROFILES / name
        if profile.exists():
            print(APPARMOR_NOTE.format(profile=profile))


def lock_installation(home):
    root = home / ".local/share/omegahive"; plain(root, directory=True)
    fd = os.open(root / "install.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
             and not info.st_mode & 0o022, "The installation lock is unsafe.")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def manage(command, home, json_output=False):
    need(not json_output or command == "status", "--json is available only with status.")
    fd = lock_installation(home)
    try:
        return manage_locked(command, home, json_output)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=("install", "open", "status", "stop", "uninstall", "tunnel"), default="install")
    parser.add_argument("--bundle", type=P)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    need(not args.json or args.command == "status", "--json is available only with status.")
    home = canonical_home(); os.umask(0o077)
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(number, stop_requested)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    if args.command != "install": return manage(args.command, home, args.json)
    need(args.bundle is not None and args.bundle.is_absolute(), "Please run the complete one-download installer.")
    catalogue = validate_catalogue(strict_json((args.bundle / "release-manifest.json").read_bytes()))
    pin_file(P(__file__), checked_members(catalogue["module_files"])["deploy/linux/install.py"])
    return Installer(args.bundle, catalogue, home).install()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refused as error:
        print(str(error), file=sys.stderr); raise SystemExit(64)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        print("OmegaHive setup stopped. The details are in the log folder: ~/.local/share/omegahive/logs", file=sys.stderr)
        raise SystemExit(1)
