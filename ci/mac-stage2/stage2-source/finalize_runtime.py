"""Disabled, bounded finalizer for a separately admitted fresh CI runtime.

This source candidate performs no work until every owner binding is explicit.
It is data-only with respect to the installed runtime: it never imports or
executes programs from the bundle and has no subprocess, network, installer,
or native-tool path.
"""
from pathlib import Path, PurePosixPath
from email.parser import BytesParser
from email.policy import compat32
import argparse
import ast
import base64
import csv
import datetime
import hashlib
import io
import json
import os
import posixpath
import re
import stat
import time


FINALIZER_ENABLED = False
EXPECTED_OWNER_UID = None  # Filled by the CI owner; never guessed from this authoring host.
PREPARATION_RECEIPT_PIN = None  # Dynamic same-job receipt pin is a future admission input.
NATIVE_PHASE_RECEIPT_PIN = None  # Native controller receipt/interface remains owner-pending.
PBS_STOCK_TOOL_PINS = None  # Exact PBS CLI-script pins are unavailable; None means unresolved.
PBS_EXTRA_DISTRIBUTION_PINS = None  # Exact PBS bootstrap distribution pins are unavailable.
OWNED_PYCACHE_RESIDUE_PINS = None  # Exact generated-file preimage map is owner-pending.
PREPARATION_PARENT_PIN = None  # BASE-relative exact completed CI stage parent.
STAGE1_MANIFEST_PIN = None  # Exact raw checksum file copied to the fixed receipt path.
STAGE1_SOURCE_REVIEW_PIN = None  # Genuine raw whole Source review, never generated at runtime.

JOB_PATH = Path("/private/tmp/omegahive-ci-r12/runtime-job")
BASE_PATH = Path("/private/tmp/omegahive-ci-r12")
BUNDLE_NAME = "OmegaHive.bundle"
PRE_FINAL_COMPONENTS = frozenset({
    "PeTTa", "lib", "node", "petta_lib_chromadb", "python", "swipl",
})
FINAL_COMPONENTS = PRE_FINAL_COMPONENTS | {"manifests"}
REQUIRED_NATIVE_PHASES = ["tools", "python", "node", "pcre", "configure", "build", "install", "deps", "janus"]
PREP_R6_MANIFEST_SHA256 = "512fb886e716d2d8bd6f6796e7436dfa0a2bd47d2485919d8ad4346d01f07be7"
PREP_R6_HELPER_SHA256 = "511fa3c9a187f5269444f7900c05ca34b28ff668d0ed1bc9ff89f8605e23c322"
PREP_R6_DELTA_SHA256 = "06e487514bcf6ecfeeb23fbf2ca13b77ff7cd209e50ce4aaafdb5cea3935534f"
PREP_CONTRACT_SHA256 = "68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842"
RUNTIME_VERSIONS_PIN = {"bytes": 945, "sha256": "16a8d3ceed56e12a790f79206a8c4b8a8298ebe50bde3c47e9acaa6c47d213ad"}
RUNTIME_LOCK_PIN = {"bytes": 4895, "sha256": "50b60657ea11e8e106894bb07e730e6b8fee35f8e457986995ee4bc393987f55"}
CORE_PARITY_PIN = {"bytes": 56367, "sha256": "222b1ba2fefb131070b81336b3a4a55ca8f8a72fc708d298aadf6be8a9ec2aa9"}
NATIVE_RECIPE_PIN = {"bytes": 7104, "sha256": "450e6486a468fbdfbcf8b335152cdcb1806b804ead9b87f849b0257fa4c0c709"}
JANUS_HELPER_PIN = {"bytes": 912, "sha256": "241891619b640e9cdb8ff5b2ca36586ebe19c39d7f3c8bc18d60166f720dfb99"}
BUILD_TOOLS_LOCK_PIN = {"bytes": 481, "sha256": "a0eea17451b7d26d4d75373388bb6003567516beb2bd591cc0a0bb1618a74635"}
LINUX_CORE_LOCK_PIN = {"bytes": 89685, "sha256": "c8e7d4fd8488edb700ce875028dbafe847ca542529c24f41feee601e6e79555e"}
DOT_RULING_PIN = {"bytes": 1639, "sha256": "1eef80386cef604f4914e9fd2270c035fa881e0973b771e2ff6f39c648bca3c0"}
SWI_INSTALL_PATCH_PIN = {"bytes": 446, "sha256": "2603a85495725aae44412ffec7ecb722ef5fbeddbb97ce61aa33258525876843"}
SWI_PACKAGE_PATCH_PIN = {"bytes": 601, "sha256": "921207dba64e147bb98e63194733b381d2ab7ea20dc2885a1a5a3251b04ecacc"}
REFERENCE_FINALIZER_SHA256 = "20fbf3744318f4866884366f88809b1931a4fcf6d26fa583b8e7e20d92eea54a"
REFERENCE_JANUS_LOCK_SHA256 = "241891619b640e9cdb8ff5b2ca36586ebe19c39d7f3c8bc18d60166f720dfb99"
PBS_ARCHIVE_PIN = {"bytes": 25180390,
                   "sha256": "ba32036ad8f4c434d97a1ee7feef8b7edc0fac16777639b97e39c74a108e4440"}
PBS_INTERPRETER_PIN = {"bytes": 18652104,
                       "sha256": "aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d"}
MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024
MAX_TREE_ENTRIES = 250000
MAX_METADATA_FILES = 512
MAX_METADATA_FILE_BYTES = 1024 * 1024
MAX_METADATA_TOTAL_BYTES = 16 * 1024 * 1024
MAX_PYCACHE_BYTES = 64 * 1024 * 1024
MAX_WRAPPER_BYTES = 8 * 1024 * 1024
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_RECEIPT_BYTES = 32 * 1024 * 1024
MAX_SECONDS = 900
STARTED = time.monotonic()
SOURCE_PATH = BASE_PATH / "stage2-source/finalize_runtime.py"
STAGE1_MANIFEST_PATH = "receipts/stage1-MANIFEST.sha256"
STAGE1_SOURCE_REVIEW_PATH = "receipts/stage1-source-review-r1.json"
CURRENT_PREPARER_ROLES = {
    "prep_entry": {"bytes": 26212, "sha256": "3f188e98270d9f0914a1734ba9af2b019d87314ffd265486cd1d1939087aaf3a"},
    "prep_worker_enabled": {"bytes": 30566, "sha256": "3d095d31c80974ff33ffa1efa8c72cd2532a495446f151c03413d532a9825727"},
    "prep_prototype": {"bytes": 30505, "sha256": "a350127907f78776fb7352e4e2a794e66891fe851b64ae6fc6cd77280ccef4b2"},
    "public_inputs": {"bytes": 63647, "sha256": PREP_CONTRACT_SHA256},
}
STAGE1_ROLES = frozenset({
    "prep_entry", "prep_parent_library", "prep_worker_enabled", "prep_prototype",
    "public_inputs", "resource_guide", "resource_policy", "native_entry",
    "native_parent", "native_worker_enabled", "input_producer",
})


class Refused(RuntimeError):
    pass


def need(condition, reason):
    if not condition:
        raise Refused(reason)


def tick():
    need(time.monotonic() - STARTED < MAX_SECONDS, "finalizer_deadline")


def directory_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode))


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def relative(value):
    need(type(value) is str and 0 < len(value) < 4096 and "\x00" not in value,
         "relative_path_type")
    path = PurePosixPath(value)
    need(not path.is_absolute() and ".." not in path.parts and str(path) == value
         and value != "." and "\\" not in value, "relative_path_required")
    return path


def open_directory_chain(path):
    path = Path(path)
    need(path.is_absolute() and ".." not in path.parts, "absolute_directory_anchor")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            tick()
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_child_directory(parent_fd, name):
    need("/" not in name and name not in ("", ".", ".."), "directory_basename_required")
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    info = os.fstat(fd)
    need(stat.S_ISDIR(info.st_mode), "plain_directory_required")
    return fd


def bounded_names(fd, maximum, reason):
    names = []
    duplicate = os.dup(fd)
    try:
        with os.scandir(duplicate) as entries:
            for entry in entries:
                tick()
                need(len(names) < maximum, reason)
                names.append(entry.name)
    finally:
        # scandir manages its own iterator; close our caller-owned duplicate.
        os.close(duplicate)
    return sorted(names)


def open_parent(root_fd, name):
    path = relative(name)
    fd = os.dup(root_fd)
    try:
        for part in path.parts[:-1]:
            next_fd = open_child_directory(fd, part)
            os.close(fd)
            fd = next_fd
        return fd, path.name
    except BaseException:
        os.close(fd)
        raise


def read_at(root_fd, name, maximum, expected=None, owner_uid=None):
    parent, base = open_parent(root_fd, name)
    try:
        fd = os.open(base, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                 and before.st_size <= maximum, "bounded_owned_regular_input")
            if owner_uid is not None:
                need(before.st_uid == owner_uid, "input_owner_mismatch")
            chunks, digest, size = [], hashlib.sha256(), 0
            while True:
                tick()
                block = os.read(fd, 65536)
                if not block:
                    break
                size += len(block)
                need(size <= maximum, "input_byte_bound")
                chunks.append(block)
                digest.update(block)
            after = os.fstat(fd)
            need(size == before.st_size and file_key(before) == file_key(after)
                 and file_key(after) == file_key(os.stat(base, dir_fd=parent, follow_symlinks=False)),
                 "input_changed_during_read")
            pin = {"bytes": size, "sha256": digest.hexdigest()}
            if expected is not None:
                need(pin == expected, "input_pin_mismatch")
            return b"".join(chunks), pin, before
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def pin_at(root_fd, name, maximum, expected=None, owner_uid=None):
    parent, base = open_parent(root_fd, name)
    try:
        fd = os.open(base, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            pin, before = pin_fd(fd, maximum, owner_uid)
            need(file_key(before) == file_key(os.stat(base, dir_fd=parent, follow_symlinks=False)),
                 "input_path_changed_during_hash")
            if expected is not None:
                need(pin == expected, "input_pin_mismatch")
            return pin, before
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def write_new_at(root_fd, name, data, mode=0o600, owner_uid=None):
    parent, base = open_parent(root_fd, name)
    try:
        fd = os.open(base, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            view = memoryview(data)
            while view:
                tick()
                count = os.write(fd, view)
                need(count > 0, "short_output_write")
                view = view[count:]
            os.fsync(fd)
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                 and file_key(info) == file_key(os.stat(base, dir_fd=parent, follow_symlinks=False)),
                 "output_identity_changed")
            if owner_uid is not None:
                need(info.st_uid == owner_uid, "output_owner_mismatch")
            return {"bytes": info.st_size, "sha256": hashlib.sha256(data).hexdigest()}
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def replace_at(root_fd, name, before_bytes, after_bytes, owner_uid, maximum):
    parent, base = open_parent(root_fd, name)
    try:
        fd = os.open(base, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            old, old_pin, info = read_fd(fd, maximum, owner_uid)
            need(old == before_bytes, "replacement_preimage_changed")
            os.lseek(fd, 0, os.SEEK_SET)
            view = memoryview(after_bytes)
            while view:
                tick()
                count = os.write(fd, view)
                need(count > 0, "replacement_short_write")
                view = view[count:]
            os.ftruncate(fd, len(after_bytes))
            os.fsync(fd)
            post = os.fstat(fd)
            need(post.st_uid == owner_uid
                 and file_key(post) == file_key(os.stat(base, dir_fd=parent, follow_symlinks=False)),
                 "replacement_identity_changed")
            return old_pin, {"bytes": len(after_bytes), "sha256": hashlib.sha256(after_bytes).hexdigest()}
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def read_fd(fd, maximum, owner_uid):
    before = os.fstat(fd)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
         "bounded_owned_regular_input")
    need(before.st_uid == owner_uid, "input_owner_mismatch")
    os.lseek(fd, 0, os.SEEK_SET)
    chunks, digest, size = [], hashlib.sha256(), 0
    while True:
        tick()
        block = os.read(fd, 65536)
        if not block:
            break
        size += len(block)
        need(size <= maximum, "input_byte_bound")
        chunks.append(block)
        digest.update(block)
    after = os.fstat(fd)
    need(size == before.st_size and file_key(before) == file_key(after), "input_changed_during_read")
    return b"".join(chunks), {"bytes": size, "sha256": digest.hexdigest()}, before


def pin_fd(fd, maximum, owner_uid):
    before = os.fstat(fd)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
         "bounded_owned_regular_input")
    need(before.st_uid == owner_uid, "input_owner_mismatch")
    os.lseek(fd, 0, os.SEEK_SET)
    digest, size = hashlib.sha256(), 0
    while True:
        tick()
        block = os.read(fd, 65536)
        if not block:
            break
        size += len(block)
        need(size <= maximum, "input_byte_bound")
        digest.update(block)
    after = os.fstat(fd)
    need(size == before.st_size and file_key(before) == file_key(after), "input_changed_during_read")
    return {"bytes": size, "sha256": digest.hexdigest()}, before


def normalize_distribution_name(name):
    need(type(name) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name),
         "distribution_name_syntax")
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_versions(raw):
    result = {}
    for line in raw.decode("utf-8").splitlines():
        need("==" in line and line.count("==") == 1, "runtime_version_line")
        name, version = line.split("==", 1)
        name = normalize_distribution_name(name)
        need(version and name not in result and "\n" not in version, "runtime_version_duplicate")
        result[name] = version
    need(len(result) == 50, "exact_core50_required")
    return result


def parse_janus_lock(raw):
    lines = raw.decode("utf-8").splitlines()
    need(len(lines) == 1, "janus_lock_single_line")
    match = re.fullmatch(r"janus[-_]swi==1\.5\.3 --hash=sha256:([a-f0-9]{64})", lines[0])
    need(match is not None, "janus_153_exact_lock_required")
    return match.group(1)


def parse_metadata_files(bundle, inventory, owner_uid):
    prefix = "python/lib/python3.12/site-packages/"
    names = sorted(name for name, row in inventory.items()
                   if name.startswith(prefix) and name.endswith(".dist-info/METADATA")
                   and row["kind"] == "file")
    need(0 < len(names) <= MAX_METADATA_FILES, "bounded_metadata_inventory")
    total, distributions = 0, {}
    for name in names:
        row = inventory[name]
        expected_pin = {"bytes": row["bytes"], "sha256": row["sha256"]}
        raw, pin, _info = read_at(bundle, name, MAX_METADATA_FILE_BYTES,
                                  expected=expected_pin, owner_uid=owner_uid)
        total += len(raw)
        need(total <= MAX_METADATA_TOTAL_BYTES, "metadata_total_byte_bound")
        message = BytesParser(policy=compat32).parsebytes(raw, headersonly=True)
        package_names, versions = message.get_all("Name", []), message.get_all("Version", [])
        need(len(package_names) == 1 and len(versions) == 1, "metadata_name_version_cardinality")
        normalized = normalize_distribution_name(package_names[0])
        need(normalized not in distributions, "duplicate_installed_distribution")
        distributions[normalized] = {"version": versions[0], "metadata": name, **pin}
    return distributions


def verify_core_metadata(distributions, expected_core, janus_version="1.5.3"):
    need(len(expected_core) == 50, "core50_contract_required")
    for name, version in expected_core.items():
        need(name in distributions and distributions[name]["version"] == version,
             "installed_core_distribution_mismatch")
    need("janus-swi" in distributions and distributions["janus-swi"]["version"] == janus_version,
         "installed_janus_153_required")
    extras = {name: {"version": data["version"], "metadata": data["metadata"],
                     "bytes": data["bytes"], "sha256": data["sha256"]}
              for name, data in distributions.items()
              if name not in expected_core and name != "janus-swi"}
    need(PBS_EXTRA_DISTRIBUTION_PINS is not None, "PBS_extra_distribution_pins_unresolved")
    need(extras == PBS_EXTRA_DISTRIBUTION_PINS, "PBS_extra_distribution_inventory_mismatch")
    return {"core50": dict(sorted(expected_core.items())), "native_janus": {"janus-swi": janus_version},
            "separate_pbs_distributions": dict(sorted(extras.items()))}


def inventory_component(bundle_fd, component, owner_uid):
    root = open_child_directory(bundle_fd, component)
    try:
        root_info = os.fstat(root)
        need(root_info.st_uid == owner_uid, "component_owner_mismatch")
        records, total = {component: {"kind": "directory", "mode": stat.S_IMODE(root_info.st_mode),
                                      "identity": list(directory_key(root_info))}}, 0

        def visit(fd, prefix):
            nonlocal total
            for name in bounded_names(fd, MAX_TREE_ENTRIES - len(records), "directory_entry_bound"):
                tick()
                need(name not in ("", ".", "..") and "/" not in name and "\\" not in name,
                     "unsafe_directory_entry")
                relative_name = prefix + "/" + name
                relative(relative_name)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                need(info.st_uid == owner_uid, "entry_owner_mismatch")
                if stat.S_ISDIR(info.st_mode):
                    records[relative_name] = {"kind": "directory", "mode": stat.S_IMODE(info.st_mode),
                                              "identity": list(directory_key(info))}
                    need(len(records) <= MAX_TREE_ENTRIES, "tree_entry_bound")
                    child = open_child_directory(fd, name)
                    try:
                        need(directory_key(os.fstat(child)) == directory_key(info), "directory_changed_during_inventory")
                        visit(child, relative_name)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    need(info.st_nlink == 1 and 0 <= info.st_size <= MAX_FILE_BYTES,
                         "regular_file_link_or_size_bound")
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        pin, opened = pin_fd(child, MAX_FILE_BYTES, owner_uid)
                        need(file_key(opened) == file_key(os.stat(name, dir_fd=fd, follow_symlinks=False)),
                             "file_changed_during_inventory")
                    finally:
                        os.close(child)
                    total += pin["bytes"]
                    need(total <= MAX_TREE_BYTES, "component_total_byte_bound")
                    records[relative_name] = {"kind": "file", "mode": stat.S_IMODE(info.st_mode),
                                              "identity": list(file_key(info)), **pin}
                    need(len(records) <= MAX_TREE_ENTRIES, "tree_entry_bound")
                elif stat.S_ISLNK(info.st_mode):
                    target = os.readlink(name, dir_fd=fd)
                    need(type(target) is str and 0 < len(target) < 4096 and not target.startswith("/"),
                         "internal_relative_symlink_required")
                    records[relative_name] = {"kind": "symlink", "target": target}
                    need(len(records) <= MAX_TREE_ENTRIES, "tree_entry_bound")
                else:
                    raise Refused("special_file_refused")

        visit(root, component)
        return records
    finally:
        os.close(root)


def validate_symlink_closure(inventory):
    for name, row in inventory.items():
        if row["kind"] != "symlink":
            continue
        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), row["target"]))
        relative(target)
        visited = {name}
        for _ in range(64):
            need(target in inventory and target not in visited, "symlink_target_missing_or_cycle")
            visited.add(target)
            link = inventory[target]
            if link["kind"] != "symlink":
                break
            target = posixpath.normpath(posixpath.join(posixpath.dirname(target), link["target"]))
            relative(target)
        else:
            raise Refused("symlink_chain_too_deep")


def parse_record_path(record_path):
    need(type(record_path) is str and record_path and "\\" not in record_path,
         "record_relative_path_required")
    need(not record_path.startswith("/"), "record_absolute_path_refused")
    path = posixpath.normpath(posixpath.join("python/lib/python3.12/site-packages", record_path))
    relative(path)
    return path


def wrapper_body(data, relative_name):
    lines = data.splitlines(keepends=True)
    if not lines:
        return None
    first = lines[0].rstrip(b"\r\n")
    distlib = (first == b"#!/bin/sh" and len(lines) >= 3
               and lines[1].startswith(b"'''exec'") and lines[2].startswith(b"' '''"))
    python_shebang = first.startswith(b"#!") and b"python" in first.lower()
    if not distlib and not python_shebang:
        return None
    body = b"".join(lines[3:] if distlib else lines[1:])
    text = body.decode("utf-8")
    header = ("#!/bin/sh\n"
              "'''exec' \"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)/python3.12\" -s \"$0\" \"$@\"\n"
              "' '''\n")
    rewritten = (header + text).encode("utf-8")
    ast.parse(rewritten.decode("utf-8"), filename=relative_name)
    return rewritten


def read_prefix_at(root_fd, name, entry, owner_uid, prefix_bytes=256):
    parent, base = open_parent(root_fd, name)
    try:
        fd = os.open(base, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                 and before.st_uid == owner_uid and file_key(before) == tuple(entry["identity"]),
                 "wrapper_prefix_identity")
            prefix = os.read(fd, prefix_bytes)
            after = os.fstat(fd)
            need(file_key(before) == file_key(after)
                 and file_key(after) == file_key(os.stat(base, dir_fd=parent, follow_symlinks=False)),
                 "wrapper_prefix_changed")
            return prefix
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def wrapper_prefix_kind(prefix):
    lines = prefix.splitlines(keepends=True)
    if not lines:
        return False
    first = lines[0].rstrip(b"\r\n")
    return (first.startswith(b"#!") and b"python" in first.lower()) or (
        first == b"#!/bin/sh" and len(lines) >= 3
        and lines[1].startswith(b"'''exec'") and lines[2].startswith(b"' '''"))


def decode_record_hash(value):
    match = re.fullmatch(r"sha256=([A-Za-z0-9_-]+)", value or "")
    need(match is not None, "record_sha256_required")
    encoded = match.group(1)
    decoded = base64.urlsafe_b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4))
    need(len(decoded) == 32, "record_sha256_length")
    return decoded


def plan_wrappers(bundle, inventory, owner_uid):
    bin_prefix = "python/bin/"
    site_prefix = "python/lib/python3.12/site-packages/"
    record_rows = {}
    records_raw = {}
    for name, entry in inventory.items():
        if not name.startswith(site_prefix) or not name.endswith(".dist-info/RECORD") or entry["kind"] != "file":
            continue
        raw, _pin, _info = read_at(bundle, name, MAX_RECORD_BYTES, owner_uid=owner_uid)
        records_raw[name] = raw
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8"), newline="")))
        for index, row in enumerate(rows):
            need(1 <= len(row) <= 3, "record_row_shape")
            target = parse_record_path(row[0])
            record_rows.setdefault(target, []).append((name, index, row))

    planned, updates = [], {}
    for name, entry in sorted(inventory.items()):
        if not name.startswith(bin_prefix) or "/" in name[len(bin_prefix):] or entry["kind"] != "file":
            continue
        if name == "python/bin/python3.12":
            need({"bytes": entry["bytes"], "sha256": entry["sha256"]} == PBS_INTERPRETER_PIN,
                 "pinned_PBS_interpreter_role_mismatch")
            continue
        prefix = read_prefix_at(bundle, name, entry, owner_uid)
        if entry["bytes"] > MAX_WRAPPER_BYTES:
            need(not prefix.startswith(b"#!") and not wrapper_prefix_kind(prefix),
                 "oversized_or_unclassified_shebang_file")
            continue
        raw, original_pin, _info = read_at(bundle, name, MAX_WRAPPER_BYTES, owner_uid=owner_uid)
        need({"bytes": original_pin["bytes"], "sha256": original_pin["sha256"]}
             == {"bytes": entry["bytes"], "sha256": entry["sha256"]}, "wrapper_inventory_pin_changed")
        after = wrapper_body(raw, name)
        if after is None:
            continue
        records = record_rows.get(name, [])
        if records:
            need(len(records) == 1, "wrapper_record_ownership_ambiguous")
            record_name, row_index, row = records[0]
            need(len(row) == 3 and row[1] and row[2].isdigit(), "wheel_wrapper_record_incomplete")
            need(decode_record_hash(row[1]) == hashlib.sha256(raw).digest()
                 and int(row[2]) == len(raw), "wheel_wrapper_record_preimage_mismatch")
            role = "wheel_console_script"
            updates.setdefault(record_name, {"raw": records_raw[record_name], "rows": None})
            if updates[record_name]["rows"] is None:
                updates[record_name]["rows"] = list(csv.reader(io.StringIO(records_raw[record_name].decode("utf-8"), newline="")))
            changed = updates[record_name]["rows"][row_index]
            changed[1] = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(after).digest()).decode().rstrip("=")
            changed[2] = str(len(after))
        elif PBS_STOCK_TOOL_PINS is not None and name in PBS_STOCK_TOOL_PINS:
            pin = PBS_STOCK_TOOL_PINS[name]
            need(original_pin == pin, "PBS_stock_tool_pin_mismatch")
            role = "stock_PBS_bootstrap_tool"
        else:
            raise Refused("unattributed_python_cli_wrapper")
        planned.append({"path": name, "role": role, "before": original_pin,
                        "after": {"bytes": len(after), "sha256": hashlib.sha256(after).hexdigest()},
                        "before_bytes": raw, "after_bytes": after})

    record_plans = []
    for name, item in sorted(updates.items()):
        stream = io.StringIO(newline="")
        csv.writer(stream, lineterminator="\n").writerows(item["rows"])
        after = stream.getvalue().encode("utf-8")
        record_plans.append({"path": name, "before_bytes": item["raw"], "after_bytes": after,
                             "before": {"bytes": len(item["raw"]), "sha256": hashlib.sha256(item["raw"]).hexdigest()},
                             "after": {"bytes": len(after), "sha256": hashlib.sha256(after).hexdigest()}})
    if PBS_STOCK_TOOL_PINS is not None:
        planned_stock = {row["path"] for row in planned if row["role"] == "stock_PBS_bootstrap_tool"}
        need(planned_stock == set(PBS_STOCK_TOOL_PINS), "PBS_stock_tool_pin_set_mismatch")
    return planned, record_plans


def plan_owned_pycache(inventory):
    need(type(OWNED_PYCACHE_RESIDUE_PINS) is dict, "owned_generated_pycache_pins_required")
    prefix = "python/lib/python3.12/site-packages/"
    children = {}
    dirs = []
    for name, row in inventory.items():
        tick()
        children.setdefault(posixpath.dirname(name), []).append(name)
        if name.startswith(prefix) and name.endswith("/__pycache__") and row["kind"] == "directory":
            dirs.append(name)
    candidate_files, removals = set(), []
    for directory in dirs:
        tick()
        entries = children.get(directory, [])
        if not entries:
            continue
        for name in entries:
            tick()
            need(inventory[name]["kind"] == "file" and name.endswith(".pyc"),
                 "pycache_not_exact_generated_residue")
            candidate_files.add(name)
    need(set(OWNED_PYCACHE_RESIDUE_PINS) == candidate_files, "pycache_preimage_pin_set_mismatch")
    for name, pin in OWNED_PYCACHE_RESIDUE_PINS.items():
        tick()
        relative(name)
        need(type(pin) is dict and set(pin) == {"bytes", "sha256"}
             and type(pin["bytes"]) is int and 0 <= pin["bytes"] <= MAX_PYCACHE_BYTES
             and pin == {"bytes": inventory[name]["bytes"], "sha256": inventory[name]["sha256"]},
             "pycache_preimage_pin_mismatch")
        removals.append({"path": name, "kind": "file", "pin": pin,
                         "identity": inventory[name]["identity"]})
    for directory in sorted(dirs, key=lambda item: len(PurePosixPath(item).parts), reverse=True):
        tick()
        if children.get(directory):
            removals.append({"path": directory, "kind": "directory",
                             "identity": inventory[directory]["identity"]})
    return removals


def remove_owned_pycache(bundle, removals, owner_uid):
    removed = []
    for item in removals:
        tick()
        name = item["path"]
        path = relative(name)
        parent, base = open_parent(bundle, name)
        try:
            if item["kind"] == "file":
                fd = os.open(base, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    pin, before = pin_fd(fd, MAX_PYCACHE_BYTES, owner_uid)
                    need(pin == item["pin"] and file_key(before) == tuple(item["identity"])
                         and file_key(before) == file_key(os.stat(base, dir_fd=parent, follow_symlinks=False)),
                         "pycache_file_preimage_changed")
                    os.unlink(base, dir_fd=parent)
                finally:
                    os.close(fd)
            else:
                need(item["kind"] == "directory" and path.name == "__pycache__",
                     "pycache_directory_type")
                fd = open_child_directory(parent, base)
                try:
                    need(list(directory_key(os.fstat(fd))) == item["identity"]
                         and not bounded_names(fd, 1, "pycache_directory_not_empty"),
                         "pycache_directory_preimage_changed")
                    os.rmdir(base, dir_fd=parent)
                finally:
                    os.close(fd)
            removed.append(name)
        finally:
            os.close(parent)
    return removed


def json_bytes(value):
    result = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    need(len(result) <= MAX_RECEIPT_BYTES, "finalization_receipt_byte_bound")
    return result


def strict_object(raw):
    def pairs(rows):
        value = {}
        for key, item in rows:
            need(key not in value, "duplicate_provenance_JSON_key")
            value[key] = item
        return value
    def invalid(_value):
        raise Refused("nonfinite_provenance_JSON")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    need(type(value) is dict, "provenance_JSON_object_required")
    return value


def evidence_pin(value, maximum, *, path=None):
    fields = {"bytes", "sha256"} if path is None else {"path", "bytes", "sha256"}
    need(type(value) is dict and set(value) == fields
         and type(value["bytes"]) is int and 0 < value["bytes"] <= maximum
         and type(value["sha256"]) is str
         and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]) is not None,
         "closed_exact_provenance_pin_required")
    if path is not None:
        need(type(value["path"]) is str and value["path"] == path,
             "fixed_provenance_pin_path_required")
    return {key: value[key] for key in ("bytes", "sha256")}


def same_private_job_identity(actual, expected):
    need(type(actual) is list and len(actual) == 4
         and all(type(item) is int for item in actual)
         and actual[0] > 0 and actual[1] > 0
         and actual[2] == EXPECTED_OWNER_UID and actual[3] == 0o700
         and actual == list(expected), "provenance_same_private_job_required")


def provenance_bindings():
    need(type(PREPARATION_PARENT_PIN) is dict
         and type(PREPARATION_PARENT_PIN.get("path")) is str
         and re.fullmatch(r"preparation-parent/stage/attempt-[a-f0-9]{32}/PARENT_RESULT\.json",
                          PREPARATION_PARENT_PIN["path"]) is not None,
         "canonical_completed_preparation_parent_pin_required")
    evidence_pin(PREPARATION_PARENT_PIN, 2 * 1024**2, path=PREPARATION_PARENT_PIN["path"])
    evidence_pin(STAGE1_MANIFEST_PIN, 65536)
    evidence_pin(STAGE1_SOURCE_REVIEW_PIN, 128 * 1024)
    return {"preparation_parent": PREPARATION_PARENT_PIN,
            "stage1_manifest": STAGE1_MANIFEST_PIN,
            "stage1_source_review": STAGE1_SOURCE_REVIEW_PIN}


def verify_preparation_execution(job_fd, owner_uid, job_identity, preparation_pin):
    """Verify actual same-job execution separately from historical design pins."""
    provenance_bindings()
    manifest_raw, manifest_pin, _info = read_at(
        job_fd, STAGE1_MANIFEST_PATH, 65536, STAGE1_MANIFEST_PIN, owner_uid)
    review_raw, review_pin, _info = read_at(
        job_fd, STAGE1_SOURCE_REVIEW_PATH, 128 * 1024, STAGE1_SOURCE_REVIEW_PIN, owner_uid)
    need(manifest_raw.endswith(b"\n") and b"\r" not in manifest_raw and b"\0" not in manifest_raw,
         "stage1_checksum_LF_text_required")
    checksums = {}
    for line in manifest_raw.decode("ascii").splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9_./-]+)", line)
        need(match is not None, "stage1_checksum_row_required")
        digest, name = match.groups()
        relative(name)
        need(name != "MANIFEST.sha256" and name not in checksums
             and len(checksums) < 128, "stage1_checksum_duplicate_self_or_bound")
        checksums[name] = digest
    need(checksums.get("STATIC_SOURCE_REVIEW.json") == review_pin["sha256"],
         "stage1_manifest_must_bind_actual_raw_review")
    review = strict_object(review_raw)
    need(set(review) == {"schema", "verdict", "blocking_findings", "reviewer", "source_owner",
                         "origin_machine", "subjects", "native_component_review", "scope"}
         and review["schema"] == "studio-Mac-CI-stage1-static-source-review/1"
         and review["verdict"] == "PASS_SOURCE_ONLY" and review["blocking_findings"] == []
         and type(review["subjects"]) is dict and set(review["subjects"]) == STAGE1_ROLES,
         "genuine_closed_stage1_whole_review_required")
    for field in ("reviewer", "source_owner", "origin_machine"):
        need(type(review[field]) is str and 0 < len(review[field]) <= 128,
             "stage1_review_provenance_required")
    need(type(review["scope"]) is str and 0 < len(review["scope"]) <= 4096,
         "stage1_review_scope_required")
    for row in list(review["subjects"].values()) + [review["native_component_review"]]:
        need(type(row) is dict and type(row.get("path")) is str, "stage1_role_pin_required")
        relative(row["path"])
        evidence_pin(row, 256 * 1024, path=row["path"])
        need(checksums.get(row["path"]) == row["sha256"], "stage1_review_role_checksum_mismatch")
    need(review["native_component_review"]["path"] == "STATIC_NATIVE_SOURCE_REVIEW.json",
         "stage1_native_review_filename_required")
    for role, expected in CURRENT_PREPARER_ROLES.items():
        row = review["subjects"][role]
        need({key: row[key] for key in ("bytes", "sha256")} == expected,
             "actual_reviewed_preparer_revision_required")
    base_fd = open_directory_chain(BASE_PATH)
    try:
        base_info = os.fstat(base_fd)
        need(base_info.st_uid == owner_uid and stat.S_IMODE(base_info.st_mode) == 0o700,
             "provenance_private_base_owner_required")
        parent_raw, parent_pin, _info = read_at(base_fd, PREPARATION_PARENT_PIN["path"],
            2 * 1024**2, evidence_pin(PREPARATION_PARENT_PIN, 2 * 1024**2,
                                    path=PREPARATION_PARENT_PIN["path"]), owner_uid)
        worker_pin, _info = pin_at(base_fd, "runtime-source/prepare_ci_runtime.py", 128 * 1024,
                                   CURRENT_PREPARER_ROLES["prep_worker_enabled"], owner_uid)
        prototype_pin, _info = pin_at(base_fd, "runtime-source/prepare_ci_runtime_prototype.py", 128 * 1024,
                                      CURRENT_PREPARER_ROLES["prep_prototype"], owner_uid)
    finally:
        os.close(base_fd)
    parent = strict_object(parent_raw)
    cleanup = parent.get("cleanup", {})
    need(parent.get("schema") == "studio-owned-public-preparation-parent/1"
         and parent.get("phase") == "stage" and parent.get("status") == "worker_exit0"
         and type(parent.get("worker_exit")) is int and parent["worker_exit"] == 0
         and type(parent.get("worker_pid")) is int and parent["worker_pid"] > 0
         and type(parent.get("worker_pgid")) is int and parent["worker_pgid"] == parent["worker_pid"]
         and parent.get("native_action") is False and type(cleanup) is dict
         and cleanup.get("worker_reaped") is True and cleanup.get("group_absent") is True
         and cleanup.get("signals") == [] and cleanup.get("observation_errors") == []
         and parent.get("finalization_errors") == [], "clean_actual_preparation_stage_parent_required")
    same_private_job_identity(parent.get("job_identity"), job_identity)
    same_private_job_identity(parent.get("ci_root_identity"), directory_key(base_info))
    for field in ("source_owner", "origin_machine"):
        need(type(parent.get(field)) is str and 0 < len(parent[field]) <= 128,
             "actual_preparation_owner_origin_required")
    worker = parent.get("worker")
    expected_worker = {"path": str(BASE_PATH / "runtime-source/prepare_ci_runtime.py"),
                       **CURRENT_PREPARER_ROLES["prep_worker_enabled"]}
    evidence_pin(worker, 128 * 1024, path=expected_worker["path"])
    need(worker == expected_worker, "executed_preparer_worker_pin_mismatch")
    evidence_pin(parent.get("worker_receipt"), 2 * 1024**2,
                 path=str(JOB_PATH / "CI_PREPARATION_RECEIPT_R1.json"))
    need(parent.get("worker_receipt") == {"path": str(JOB_PATH / "CI_PREPARATION_RECEIPT_R1.json"),
                                          **preparation_pin}, "preparation_parent_receipt_link_required")
    inventory = parent.get("prepared_inventory")
    evidence_pin(inventory, 8 * 1024**2, path=str(JOB_PATH / "PREPARED_SOURCE_INVENTORIES_R1.json"))
    _inventory_raw, inventory_pin, _info = read_at(job_fd, "PREPARED_SOURCE_INVENTORIES_R1.json",
        8 * 1024**2, {key: inventory[key] for key in ("bytes", "sha256")}, owner_uid)
    inventory_data = strict_object(_inventory_raw)
    need(set(inventory_data) == {"python", "swipl", "petta", "chroma", "pcre2"},
         "actual_preparation_five_inventory_roles_required")
    context = parent.get("static_source_context")
    need(type(context) is dict and set(context) == {"manifest_sha256", "review", "owner_admission", "dedicated_ci_job"}
         and context.get("manifest_sha256") == manifest_pin["sha256"]
         and context.get("review") == {key: review_pin[key] for key in ("bytes", "sha256")}
         and context.get("dedicated_ci_job") is True
         and type(context.get("owner_admission")) is str
         and 0 < len(context["owner_admission"]) <= 128,
         "actual_preparation_stage1_source_context_required")
    evidence_pin(context["review"], 128 * 1024)
    need(directory_key(os.fstat(job_fd)) == tuple(job_identity), "job_changed_during_preparation_provenance")
    return {"schema": "studio-verified-preparation-execution-lineage/1",
            "source_owner": parent["source_owner"], "origin_machine": parent["origin_machine"],
            "parent": {"path": PREPARATION_PARENT_PIN["path"], **parent_pin},
            "stage1_manifest": {"path": STAGE1_MANIFEST_PATH, **manifest_pin},
            "stage1_source_review": {"path": STAGE1_SOURCE_REVIEW_PATH, **review_pin},
            "actual_worker": {"path": "runtime-source/prepare_ci_runtime.py", **worker_pin},
            "actual_prototype": {"path": "runtime-source/prepare_ci_runtime_prototype.py", **prototype_pin},
            "reviewed_prep_entry": review["subjects"]["prep_entry"],
            "preparation_receipt": {"path": "CI_PREPARATION_RECEIPT_R1.json", **preparation_pin},
            "prepared_inventory": {"path": "PREPARED_SOURCE_INVENTORIES_R1.json", **inventory_pin},
            "job_identity": list(job_identity), "qualification": "Preparation data lineage only; no native/product qualification"}


def verify_contract_and_receipts(job_fd, owner_uid):
    preparation, preparation_pin, _info = read_at(job_fd, "CI_PREPARATION_RECEIPT_R1.json",
                                                   2 * 1024 * 1024, PREPARATION_RECEIPT_PIN,
                                                   owner_uid=owner_uid)
    data = json.loads(preparation)
    need(data.get("schema") == "studio-Mac-CI-public-runtime-preparation/2"
         and data.get("contract_sha256") == PREP_CONTRACT_SHA256
         and data.get("status") == "DATA_PREPARATION_ONLY_NO_NATIVE_ACTION",
         "pinned_preparation_receipt_required")
    need(NATIVE_PHASE_RECEIPT_PIN is not None, "native_phase_receipt_pin_unresolved")
    native, native_pin, _info = read_at(job_fd, NATIVE_PHASE_RECEIPT_PIN["path"],
                                       2 * 1024 * 1024,
                                       {"bytes": NATIVE_PHASE_RECEIPT_PIN["bytes"],
                                        "sha256": NATIVE_PHASE_RECEIPT_PIN["sha256"]},
                                       owner_uid=owner_uid)
    native_data = json.loads(native)
    need(native_data.get("status") == "ALL_REQUIRED_NATIVE_PHASES_COMPLETE"
         and native_data.get("native_action") is True
         and native_data.get("completed_phases") == REQUIRED_NATIVE_PHASES,
         "native_phase_receipt_content")
    return {"preparation": preparation_pin, "native_phases": native_pin}


def verify_owner_admission(job_fd, owner_uid, job_identity, source_pin, admission_pin):
    raw, pin, _info = read_at(job_fd, "receipts/finalizer-admission-r1.json",
                              admission_pin["bytes"], admission_pin, owner_uid)
    admission = strict_object(raw)
    need(type(admission) is dict and admission.get("status") == "OWNER_ADMITTED_FINALIZATION"
         and admission.get("job_path") == str(JOB_PATH)
         and admission.get("job_identity") == list(job_identity)
         and admission.get("candidate_source_sha256") == source_pin["sha256"]
         and type(admission.get("execution_owner")) is str
         and 1 <= len(admission["execution_owner"]) <= 128
         and type(admission.get("origin_machine")) is str
         and 1 <= len(admission["origin_machine"]) <= 128,
         "owner_admission_content_or_identity")
    same_private_job_identity(admission.get("job_identity"), job_identity)
    for name, expected in provenance_bindings().items():
        need(admission.get(name) == expected, "owner_admission_preparation_lineage_pin_mismatch")
    return {"admission": pin, "candidate_source": source_pin,
            "execution_owner": admission["execution_owner"],
            "origin_machine": admission["origin_machine"],
            "attribution": "owner-supplied admission"}


def verify_bootstrap_identity(job_fd, bundle_fd, owner_uid):
    archive_pin, _info = pin_at(job_fd,
        "artifacts/cpython-3.12.15+20261013-aarch64-apple-darwin-install_only.tar.gz",
        PBS_ARCHIVE_PIN["bytes"], PBS_ARCHIVE_PIN, owner_uid=owner_uid)
    _runtime, runtime_pin, _info = read_at(bundle_fd, "python/bin/python3.12",
        PBS_INTERPRETER_PIN["bytes"], PBS_INTERPRETER_PIN, owner_uid=owner_uid)
    need(PBS_STOCK_TOOL_PINS is not None, "PBS_stock_tool_pins_unresolved")
    need(PBS_EXTRA_DISTRIBUTION_PINS is not None, "PBS_extra_distribution_pins_unresolved")
    return {"PBS_archive": archive_pin, "PBS_interpreter": runtime_pin,
            "stock_tool_pins": PBS_STOCK_TOOL_PINS,
            "extra_distribution_pins": PBS_EXTRA_DISTRIBUTION_PINS}


def inventory_bundle(bundle_fd, owner_uid):
    names = bounded_names(bundle_fd, 16, "bundle_component_count_bound")
    need(set(names) in (PRE_FINAL_COMPONENTS, FINAL_COMPONENTS),
         "closed_seven_component_bundle_required")
    inventory = {}
    total = 0
    for component in sorted(names):
        current = inventory_component(bundle_fd, component, owner_uid)
        need(len(inventory) + len(current) <= MAX_TREE_ENTRIES, "bundle_global_tree_entry_bound")
        total += sum(row.get("bytes", 0) for row in current.values() if row["kind"] == "file")
        need(total <= MAX_TREE_BYTES, "bundle_total_byte_bound")
        inventory.update(current)
    validate_symlink_closure(inventory)
    return inventory


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--admission-bytes", required=True, type=int)
    parser.add_argument("--admission-sha256", required=True)
    args = parser.parse_args()
    need(FINALIZER_ENABLED is True and EXPECTED_OWNER_UID is not None,
         "DISABLED_source_review_and_owner_admission_required")
    need(type(EXPECTED_OWNER_UID) is int and EXPECTED_OWNER_UID > 0
         and EXPECTED_OWNER_UID == os.getuid() == os.geteuid(), "finalizer_must_run_as_pinned_CI_owner")
    need(re.fullmatch(r"[a-f0-9]{64}", args.source_sha256) is not None
         and 0 < args.admission_bytes <= 64 * 1024
         and re.fullmatch(r"[a-f0-9]{64}", args.admission_sha256) is not None,
         "owner_source_and_admission_pins_required")
    source_path = Path(__file__).absolute()
    need(source_path == SOURCE_PATH, "canonical_portable_stage2_finalizer_source_required")
    provenance_bindings()
    source_parent = open_directory_chain(source_path.parent)
    try:
        source_pin, _source_info = pin_at(source_parent, source_path.name, 1024 * 1024,
                                          owner_uid=EXPECTED_OWNER_UID)
    finally:
        os.close(source_parent)
    need(source_pin["sha256"] == args.source_sha256, "candidate_source_sha256_mismatch")
    admission_pin = {"bytes": args.admission_bytes, "sha256": args.admission_sha256}
    need(PREPARATION_RECEIPT_PIN is not None and NATIVE_PHASE_RECEIPT_PIN is not None,
         "runtime_receipt_bindings_unresolved")
    need(PBS_STOCK_TOOL_PINS is not None and PBS_EXTRA_DISTRIBUTION_PINS is not None,
         "PBS_tooling_pins_unresolved")
    need(OWNED_PYCACHE_RESIDUE_PINS is not None, "owned_generated_pycache_pins_unresolved")
    need(str(JOB_PATH) == "/private/tmp/omegahive-ci-r12/runtime-job", "fixed_CI_job_required")
    job_fd = open_directory_chain(JOB_PATH)
    bundle_fd = None
    failure_reason = None
    try:
        base_fd = open_directory_chain(BASE_PATH)
        try:
            base_info = os.fstat(base_fd)
            need(base_info.st_uid == EXPECTED_OWNER_UID and stat.S_IMODE(base_info.st_mode) == 0o700,
                 "private_CI_root_owner_mode")
        finally:
            os.close(base_fd)
        job_info = os.fstat(job_fd)
        need(job_info.st_uid == EXPECTED_OWNER_UID and stat.S_IMODE(job_info.st_mode) == 0o700,
             "private_CI_job_owner_mode")
        receipts_fd = open_child_directory(job_fd, "receipts")
        try:
            receipts_info = os.fstat(receipts_fd)
            need(receipts_info.st_uid == EXPECTED_OWNER_UID
                 and stat.S_IMODE(receipts_info.st_mode) == 0o700, "receipts_owner_mode_mismatch")
        finally:
            os.close(receipts_fd)
        evidence_pins = verify_contract_and_receipts(job_fd, EXPECTED_OWNER_UID)
        admission = verify_owner_admission(job_fd, EXPECTED_OWNER_UID, directory_key(job_info),
                                           source_pin, admission_pin)
        preparation_execution = verify_preparation_execution(
            job_fd, EXPECTED_OWNER_UID, directory_key(job_info), evidence_pins["preparation"])
        bundle_fd = open_child_directory(job_fd, BUNDLE_NAME)
        bundle_info = os.fstat(bundle_fd)
        need(bundle_info.st_uid == EXPECTED_OWNER_UID, "bundle_owner_mismatch")
        before = inventory_bundle(bundle_fd, EXPECTED_OWNER_UID)
        need({name.split("/", 1)[0] for name in before} == PRE_FINAL_COMPONENTS,
             "six_pre_final_components_required")
        bootstrap = verify_bootstrap_identity(job_fd, bundle_fd, EXPECTED_OWNER_UID)
        versions_raw, versions_pin, _info = read_at(job_fd, "runtime-versions.txt",
                                                    RUNTIME_VERSIONS_PIN["bytes"],
                                                    RUNTIME_VERSIONS_PIN, EXPECTED_OWNER_UID)
        core_versions = parse_versions(versions_raw)
        parity_raw, parity_pin, _info = read_at(job_fd, "CORE_PARITY_METADATA_R1.json",
                                                CORE_PARITY_PIN["bytes"], CORE_PARITY_PIN,
                                                EXPECTED_OWNER_UID)
        parity = json.loads(parity_raw)
        selected = parity.get("selected")
        need(type(selected) is dict and len(selected) == 50
             and parity.get("status") == "METADATA_CLOSURE_PASS"
             and parity.get("parity", {}).get("names_added") == []
             and parity.get("parity", {}).get("names_removed") == []
             and parity.get("parity", {}).get("version_differences") == {}
             and parity.get("linux_core_versions", {}).get("janus-swi") == "1.5.3",
             "pinned_core_parity_metadata_required")
        selected_versions = {normalize_distribution_name(row["name"]): row["version"]
                             for row in selected.values()}
        need(selected_versions == core_versions, "runtime_versions_core_parity_mismatch")
        helper, helper_pin, _info = read_at(job_fd, "lock_janus.py", JANUS_HELPER_PIN["bytes"],
                                            JANUS_HELPER_PIN, EXPECTED_OWNER_UID)
        janus_lock, janus_lock_pin, _info = read_at(job_fd, "janus-requirements.lock", 4096,
                                                    owner_uid=EXPECTED_OWNER_UID)
        janus_digest = parse_janus_lock(janus_lock)
        runtime_lock, runtime_lock_pin, _info = read_at(job_fd, "runtime-requirements.lock",
                                                        RUNTIME_LOCK_PIN["bytes"], RUNTIME_LOCK_PIN,
                                                        EXPECTED_OWNER_UID)
        final_lock, final_lock_pin, _info = read_at(job_fd, "final-runtime-requirements.lock",
                                                   1024 * 1024, owner_uid=EXPECTED_OWNER_UID)
        need(final_lock == runtime_lock + janus_lock, "final_runtime_lock_derivative_mismatch")
        janus_receipt_raw, janus_receipt_pin, _info = read_at(job_fd,
            "receipts/janus-built-wheel.json", 64 * 1024, owner_uid=EXPECTED_OWNER_UID)
        janus_receipt = json.loads(janus_receipt_raw)
        need(type(janus_receipt) is dict
             and set(janus_receipt) == {"file", "sha256", "bytes", "source", "install"}
             and janus_receipt["source"] == "stock Janus 1.5.3, build-only loader-relative rpath derivative; PBS Python 3.12.15/SWI 10.1.14"
             and janus_receipt["install"] == "offline --require-hashes --no-deps --no-compile before runtime qualification",
             "exact_janus_build_receipt_required")
        wheel_name = janus_receipt.get("file")
        need(type(wheel_name) is str and re.fullmatch(r"janus_swi-1\.5\.3-[A-Za-z0-9_.-]+\.whl", wheel_name),
             "janus_wheel_basename")
        wheel_pin, _info = pin_at(job_fd, "wheelhouse/" + wheel_name, MAX_FILE_BYTES,
                                  {"bytes": janus_receipt.get("bytes"),
                                   "sha256": janus_receipt.get("sha256")}, EXPECTED_OWNER_UID)
        need(wheel_pin["sha256"] == janus_digest, "janus_wheel_lock_receipt_disagreement")
        distributions = parse_metadata_files(bundle_fd, before, EXPECTED_OWNER_UID)
        installed = verify_core_metadata(distributions, core_versions)
        wrapper_plans, record_plans = plan_wrappers(bundle_fd, before, EXPECTED_OWNER_UID)
        pycache_removals = plan_owned_pycache(before)

        # Hold every manifest copy input and the installed freeze before the
        # first mutation. Later writes use these exact validated byte strings.
        manifest_inputs = {
            "runtime-requirements.lock": runtime_lock,
            "janus-requirements.lock": janus_lock,
            "janus-built-wheel.json": janus_receipt_raw,
            "final-runtime-requirements.lock": final_lock,
        }
        for source_name, expected in (("build-tools-requirements.lock", BUILD_TOOLS_LOCK_PIN),
                                      ("runtime-versions.txt", RUNTIME_VERSIONS_PIN),
                                      ("CORE_PARITY_METADATA_R1.json", CORE_PARITY_PIN),
                                      ("native-runtime-phases.sh", NATIVE_RECIPE_PIN),
                                      ("lock_janus.py", JANUS_HELPER_PIN)):
            manifest_inputs[source_name], _pin, _info = read_at(
                job_fd, source_name, expected["bytes"], expected, EXPECTED_OWNER_UID)
        manifest_inputs["final-installed-freeze.txt"], freeze_pin, _info = read_at(
            job_fd, "final-installed-freeze.txt", 1024 * 1024, owner_uid=EXPECTED_OWNER_UID)

        # All inputs are validated before this first mutation. Source trees,
        # archive evidence, native build directories, and preexisting receipts
        # are outside the deletion plan.
        need(set(bounded_names(bundle_fd, 16, "bundle_component_count_bound")) == PRE_FINAL_COMPONENTS,
             "fresh_six_component_bundle_required")
        os.mkdir("manifests", 0o755, dir_fd=bundle_fd)
        manifests_fd = open_child_directory(bundle_fd, "manifests")
        try:
            need(os.fstat(manifests_fd).st_uid == EXPECTED_OWNER_UID, "manifests_owner_mismatch")
        finally:
            os.close(manifests_fd)
        removed = remove_owned_pycache(bundle_fd, pycache_removals, EXPECTED_OWNER_UID)
        rewritten = []
        for row in wrapper_plans:
            before_pin, after_pin = replace_at(bundle_fd, row["path"], row["before_bytes"],
                                               row["after_bytes"], EXPECTED_OWNER_UID, MAX_WRAPPER_BYTES)
            rewritten.append({"path": row["path"], "role": row["role"],
                              "before": before_pin, "after": after_pin})
        record_updates = []
        for row in record_plans:
            before_pin, after_pin = replace_at(bundle_fd, row["path"], row["before_bytes"],
                                               row["after_bytes"], EXPECTED_OWNER_UID, MAX_RECORD_BYTES)
            record_updates.append({"path": row["path"], "before": before_pin, "after": after_pin})

        final = inventory_bundle(bundle_fd, EXPECTED_OWNER_UID)
        need(set(bounded_names(bundle_fd, 16, "bundle_component_count_bound")) == FINAL_COMPONENTS,
             "exact_seven_final_components_required")
        for source_name, raw in manifest_inputs.items():
            write_new_at(bundle_fd, "manifests/" + source_name, raw,
                         owner_uid=EXPECTED_OWNER_UID)
        final = inventory_bundle(bundle_fd, EXPECTED_OWNER_UID)
        for distribution in distributions.values():
            metadata_name = distribution["metadata"]
            final_row = final.get(metadata_name)
            need(final_row is not None
                 and {"bytes": final_row["bytes"], "sha256": final_row["sha256"]}
                    == {"bytes": distribution["bytes"], "sha256": distribution["sha256"]},
                 "installed_metadata_snapshot_changed")
        receipt = {"schema": "omegahive-ci-runtime-finalization/1",
                   "status": "FINALIZED_BUNDLE_DERIVATIVE_ONLY",
                   "source_owner": "Codex-authored disabled candidate; owner admission required",
                   "execution_owner": admission["execution_owner"],
                   "origin_machine": admission["origin_machine"],
                   "attribution": "owner-supplied admission",
                   "job_path": str(JOB_PATH), "job_identity": list(directory_key(job_info)),
                   "bundle_components": sorted(FINAL_COMPONENTS),
                   "component_inventory": final, "evidence_pins": evidence_pins,
                   "owner_admission": admission_pin,
                   "source_pins": {"prep_R6_manifest": PREP_R6_MANIFEST_SHA256,
                                   "prep_R6_helper": PREP_R6_HELPER_SHA256,
                                   "prep_R6_source_delta": PREP_R6_DELTA_SHA256,
                                   "preparation_contract": PREP_CONTRACT_SHA256,
                                   "reference_finalizer": REFERENCE_FINALIZER_SHA256,
                                   "reference_lock_janus": REFERENCE_JANUS_LOCK_SHA256},
                   "source_pin_scope": "prep_R6_* and reference_* are historical design/reference bytes, never actual executed-source evidence",
                   "preparation_execution": preparation_execution,
                   "PBS_bootstrap_identity": bootstrap, "installed_core": installed,
                   "janus_lock": janus_lock_pin, "janus_receipt": janus_receipt_pin,
                   "janus_wheel": wheel_pin, "runtime_versions": versions_pin,
                   "core_parity_metadata": parity_pin, "janus_helper": helper_pin,
                   "final_runtime_lock": final_lock_pin, "installed_freeze": freeze_pin,
                   "removed_generated_pycache": removed, "rewritten_python_cli_wrappers": rewritten,
                   "updated_record_files": record_updates,
                   "qualification": "NONE; runtime seal/native audit/smoke/UI remain separate",
                   "elapsed_seconds": time.monotonic() - STARTED}
        write_new_at(job_fd, "receipts/finalization_r1.json", json_bytes(receipt),
                     owner_uid=EXPECTED_OWNER_UID)
        print(json.dumps({"status": receipt["status"], "receipt": "receipts/finalization_r1.json"}))
    except BaseException as error:
        failure_reason = str(error) if isinstance(error, Refused) else type(error).__name__
        failed = {"schema": "omegahive-ci-runtime-finalization/1",
                  "status": "FAILED_RETAINED_NO_AUTOMATIC_RETRY", "native_action": False,
                  "reason": failure_reason, "qualification": "NONE"}
        try:
            write_new_at(job_fd, "receipts/finalization_failed_r1.json", json_bytes(failed),
                         owner_uid=EXPECTED_OWNER_UID)
            print(json.dumps({"status": failed["status"], "terminal_receipt_written": True,
                              "reason": failure_reason}), flush=True)
        except BaseException:
            print(json.dumps({"status": failed["status"], "terminal_receipt_written": False,
                              "reason": failure_reason}), flush=True)
        raise
    finally:
        if bundle_fd is not None:
            os.close(bundle_fd)
        os.close(job_fd)


if __name__ == "__main__":
    main()
