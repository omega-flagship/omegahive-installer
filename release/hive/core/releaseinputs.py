"""Write the existing release-input tuple inside an explicitly selected Git release.

Platform invokes this during deploy; no source/extractor code is executed, no map
is built and no network command is used. Existing NewHive owns manifest grammar
and descriptor-confined Source validation. An interrupted tuple is retained and
refused on replay; this tool never repairs, overwrites or deletes it.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import time

from . import newhive as nh

EXTRACTOR = {
    "__init__.py": (99, "df053e7cfd7959e9667856205f801ac160a7c88a272dce9b0912ac94215933bc"),
    "repository_facts.py": (8088, "abb4127d0281a3bf587cc0fd51b0dc0e0e05be06f93af2feceac50098905ca5d"),
    "repository_map.py": (9903, "60a9293045a48750be67220e873a53a6e18995cec6f10b1c784601f484cfd38a"),
}
# Existing public-five collector exclusions; check_path remains the host grammar.
BLOCKED_DIRS = {".git", ".runtime", ".codex", ".claude", ".aws", ".ssh", ".venv", "venv",
    "__pycache__", "node_modules", "vendor", "dist", "build", "out", ".next", ".vite", ".turbo",
    "cache", ".cache", "logs", "log", "sessions", "session", "histories", "history", "transcripts",
    "transcript", "material", "materials", "secrets", "private", ".private", "data", "stores"}
BLOCKED_NAMES = {"credentials", "credentials.json", "token.json", "tokens.json", "registration.json",
    "config.json", "id_rsa", "id_ed25519", ".netrc", ".npmrc", ".ds_store"}
BLOCKED_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".log", ".jsonl", ".ndjson", ".zip", ".tar",
    ".gz", ".tgz", ".xz", ".bz2", ".7z", ".dmg", ".iso", ".bundle", ".pyc", ".pem", ".key", ".p12", ".pfx"}


def _need(value, code):
    if value is not True:
        raise nh.SourceRefused(code, "release-input generation refused")


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


@contextlib.contextmanager
def _owned(fd):
    primary = None
    try:
        yield fd
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            os.close(fd)
        except BaseException:
            if primary is None:
                raise
            try:
                BaseException.add_note(primary, "Secondary owned descriptor close is UNKNOWN; tuple is not accepted.")
            except BaseException:
                pass


def _git(root, args, until, *, data=b"", limit=nh.MANIFEST_MAX):
    """Existing collector's fixed local Git/read-only environment and streaming cap.

    This is a bounded Git transport, not an executor for release/test/model code.
    Its caller supplies only the fixed commands below and a validated hex SHA.
    """
    command = ["/usr/bin/git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false", "-C", str(root), *args]
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_ALLOW_PROTOCOL": "", "GIT_PROTOCOL_FROM_USER": "0"}
    _need(time.monotonic() < until, "git_source_timeout")
    # Allocate the bounded diagnostic slots before acquiring any owned resource.
    # The actual primary traceback also retains this frame/state if attaching an
    # optional diagnostic attribute fails. No close-UNKNOWN handle is retried.
    state = {"incoming": None, "process": None, "stdout": None, "selector": None,
        "incoming_open_attempted": False, "process_init_attempted": False, "selector_init_attempted": False,
        "incoming_close_attempted": False, "incoming_closed": False,
        "stdout_close_attempted": False, "stdout_closed": False,
        "selector_close_attempted": False, "selector_closed": False,
        "kill_attempted": False, "kill_returned": False,
        "cleanup_wait_attempted": False, "known_reaped": False, "returncode": None,
        "selector_close_error": None, "poll_error": None, "kill_error": None,
        "cleanup_wait_error": None, "stdout_close_error": None, "incoming_close_error": None,
        "diagnostic_attach_error": None}
    primary, primary_tb, result = None, None, None

    def remember(slot, error):
        nonlocal primary, primary_tb
        state[slot] = error  # retain each actual observation before optional formatting/packaging
        if primary is None:
            primary = error
            try:
                primary_tb = BaseException.__getattribute__(error, "__traceback__")
            except BaseException:
                pass

    try:
        state["incoming_open_attempted"] = True
        incoming = tempfile.TemporaryFile()
        state["incoming"] = incoming
        incoming.write(data)
        incoming.seek(0)
        state["process_init_attempted"] = True
        process = subprocess.Popen(command, stdin=incoming, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env)
        state["process"] = process
        stdout = process.stdout
        state["stdout"] = stdout
        deadline, chunks, count = min(until, time.monotonic() + 30), [], 0
        os.set_blocking(stdout.fileno(), False)
        state["selector_init_attempted"] = True
        selected = selectors.DefaultSelector()
        state["selector"] = selected
        selected.register(stdout, selectors.EVENT_READ)
        while selected.get_map():
            left = deadline - time.monotonic()
            _need(left > 0, "git_source_timeout")
            for key, _ in selected.select(left):
                part = os.read(key.fd, min(65536, limit + 1 - count))
                if not part:
                    selected.unregister(key.fileobj)
                    continue
                chunks.append(part)
                count += len(part)
                _need(count <= limit, "git_source_output_limit")
        state["selector_close_attempted"] = True
        try:
            selected.close()
        except BaseException as error:
            remember("selector_close_error", error)
            raise
        state["selector_closed"] = True
        left = deadline - time.monotonic()
        _need(left > 0, "git_source_timeout")
        returncode = process.wait(timeout=left)
        state["returncode"], state["known_reaped"] = returncode, True
        _need(returncode == 0, "git_source_refused")
        result = b"".join(chunks)
    except BaseException as error:
        if primary is None:
            primary = error
            try:
                primary_tb = BaseException.__getattribute__(error, "__traceback__")
            except BaseException:
                pass
    finally:
        selected = state["selector"]
        if selected is not None and not state["selector_close_attempted"]:
            state["selector_close_attempted"] = True
            try:
                selected.close()
                state["selector_closed"] = True
            except BaseException as error:
                remember("selector_close_error", error)
        process = state["process"]
        if process is not None and not state["known_reaped"]:
            try:
                returncode = process.poll()
                if returncode is not None:
                    state["returncode"], state["known_reaped"] = returncode, True
            except BaseException as error:
                remember("poll_error", error)
            if not state["known_reaped"]:
                state["kill_attempted"] = True
                try:
                    process.kill()
                    state["kill_returned"] = True
                except BaseException as error:
                    remember("kill_error", error)
                state["cleanup_wait_attempted"] = True
                try:
                    returncode = process.wait(timeout=2)
                    state["returncode"], state["known_reaped"] = returncode, True
                except BaseException as error:
                    remember("cleanup_wait_error", error)
        stdout = state["stdout"]
        if stdout is not None:
            state["stdout_close_attempted"] = True
            try:
                stdout.close()
                state["stdout_closed"] = True
            except BaseException as error:
                remember("stdout_close_error", error)
        incoming = state["incoming"]
        if incoming is not None:
            state["incoming_close_attempted"] = True
            try:
                incoming.close()
                state["incoming_closed"] = True
            except BaseException as error:
                remember("incoming_close_error", error)
    if primary is not None:
        try:
            BaseException.__setattr__(primary, "release_input_cleanup", state)
        except BaseException as error:
            state["diagnostic_attach_error"] = error
        if primary_tb is not None:
            raise BaseException.with_traceback(primary, primary_tb)
        raise primary  # do not erase the original traceback if optional capture failed
    return result


def _allowed(name):
    """Only selected public code paths; excluded names never reach a blob read."""
    parts = name.lower().split("/")
    if (re.search(r"atlas|truth", name, re.I) or any(p in BLOCKED_DIRS for p in parts)
            or any(p.startswith(".env") or p in BLOCKED_NAMES for p in parts)
            or Path(name).suffix.lower() in BLOCKED_SUFFIXES
            or any(re.search(r"(^|[._-])bundles?([._-]|$)", p, re.I) for p in parts)):
        return False
    try:
        nh.check_path(name)
    except nh.SourceRefused:
        return False
    return True


def _manifest(root, revision, until):
    _need(_git(root, ["rev-parse", "--show-toplevel"], until).decode("utf-8").strip() == str(root),
        "source_root")
    _need(_git(root, ["rev-parse", "--verify", revision + "^{commit}"], until).decode("ascii").strip()
        == revision, "release_revision")
    stamp = _git(root, ["show", "--no-patch", "--format=%cI", revision, "--"], until,
        limit=128).decode("ascii").strip()
    listing = _git(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", revision], until)
    entries, total = [], 0
    for record in listing.split(b"\0"):
        if not record:
            continue
        meta, raw_path = record.split(b"\t", 1)
        try:
            name = raw_path.decode("utf-8", "strict")
        except UnicodeError:
            continue
        if not _allowed(name):
            continue
        mode, kind, oid, size = meta.decode("ascii").split()
        _need(mode in {"100644", "100755"} and kind == "blob"
            and re.fullmatch("[0-9a-f]{40}", oid) is not None and size.isdigit(), "unsupported_file")
        length = int(size)
        total += length
        entries.append((name, oid, length))
        _need(len(entries) <= nh.MAX_FILES and total <= nh.MAX_TOTAL, "oversize")
    _need(bool(entries), "manifest_invalid")
    request = b"".join(oid.encode("ascii") + b"\n" for _, oid, _ in entries)
    overhead = sum(len(oid) + len(str(size)) + 8 for _, oid, size in entries)
    stream = _git(root, ["cat-file", "--batch"], until, data=request, limit=total + overhead)
    files, contents, offset = [], {}, 0
    for name, oid, size in entries:
        end = stream.find(b"\n", offset)
        _need(end >= offset and stream[offset:end].decode("ascii").split() == [oid, "blob", str(size)],
            "git_source_refused")
        start = end + 1
        body = stream[start:start + size]
        offset = start + size + 1
        _need(len(body) == size and stream[start + size:offset] == b"\n"
            and hashlib.sha1(b"blob " + str(size).encode("ascii") + b"\0" + body,
                usedforsecurity=False).hexdigest() == oid, "git_source_refused")
        files.append({"path": name, "size": size, "sha256": _sha(body)})
        contents[name] = body
    _need(offset == len(stream), "git_source_refused")
    raw = nh._canon_bytes({"schema": nh.MANIFEST_SCHEMA, "repo": nh.REPO_ID, "sha": revision,
        "generated_at": stamp, "files": sorted(files, key=lambda x: x["path"]),
        "extractor": {"files": {n: pin[1] for n, pin in EXTRACTOR.items()}}})
    return raw, nh.parse_manifest(raw), contents


def _extractor(path):
    with _owned(nh._open_root(path)) as fd:
        _need(set(os.listdir(fd)) == set(EXTRACTOR), "extractor_unavailable")
        return {name: nh._read_listed(fd, name, size, digest)
            for name, (size, digest) in EXTRACTOR.items()}


def _write_file(directory, name, data):
    with _owned(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            | getattr(os, "O_CLOEXEC", 0), 0o444, dir_fd=directory)) as fd:
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            _need(type(count) is int and 0 < count <= len(data) - offset, "release_write_refused")
            offset += count
        os.fsync(fd)


def _verify_checkout(root, manifest):
    """Verify only selected deployed files; never walk ignored runtime/private trees."""
    with _owned(nh._open_root(str(root))) as fd:
        for name, size, digest in manifest.files:
            nh._read_listed(fd, name, size, digest)


def _publish_source(fd, contents):
    """Package original Git blobs into the new owned export; never execute them."""
    for name, body in sorted(contents.items()):
        with contextlib.ExitStack() as opened:
            current, parents = fd, [fd]
            for part in name.split("/")[:-1]:
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
                current = opened.enter_context(_owned(os.open(part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)))
                parents.append(current)
            _write_file(current, name.split("/")[-1], body)
            for parent in reversed(parents):
                os.fsync(parent)


def _verify_tuple(fd, raw, extractor, manifest, source_root):
    _need(set(os.listdir(fd)) == {"manifest.json", "extractor", "source"}, "release_tuple_conflict")
    _need(nh._read_listed(fd, "manifest.json", len(raw), _sha(raw)) == raw, "release_tuple_conflict")
    with _owned(os.open("extractor", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=fd)) as child:
        _need(set(os.listdir(child)) == set(EXTRACTOR), "release_tuple_conflict")
        for name, data in extractor.items():
            _need(nh._read_listed(child, name, len(data), _sha(data)) == data, "release_tuple_conflict")
    collected = nh.collect_sources(str(source_root), manifest)
    _need(not any(collected.diagnostics.values()), "release_tuple_conflict")


def write_release_inputs(release_dir, revision, extractor_dir):
    """Return the three path bindings only after exact Source and tuple verification.

    The Platform-owned release is a trusted deploy input. This is
    ordinary descriptor-confined integrity, not native birth/custody authority.
    Selected checkout files must match; ignored runtime extras are not exported.
    This does not authenticate the running interpreter's module/code provenance.
    """
    _need(type(revision) is str and re.fullmatch("[0-9a-f]{40}", revision) is not None,
        "release_revision")
    root = Path(nh.canonical_abs(release_dir))
    extractor_dir = nh.canonical_abs(extractor_dir, "extractor_unavailable")
    with _owned(nh._open_root(str(root))):
        pass
    until = time.monotonic() + 50
    raw, manifest, contents = _manifest(root, revision, until)
    _verify_checkout(root, manifest)        # actual selected files match exact supplied Git tree
    extractor = _extractor(extractor_dir)    # read/hash only; never load_pinned_extractor
    name = "repo-inputs-" + revision
    destination = root / ".runtime" / name
    # .runtime is already excluded from the selected Git census. Only open this
    # fixed parent and tuple; never walk unrelated private/runtime contents.
    with _owned(nh._anchored_dir(str(root))) as checkout:
        try:
            os.mkdir(".runtime", 0o700, dir_fd=checkout)
            os.fsync(checkout)
        except FileExistsError:
            pass
        with _owned(os.open(".runtime", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=checkout)) as parent:
            owner = os.fstat(parent)
            _need(owner.st_uid == os.getuid() and not owner.st_mode & 0o022, "release_tuple_conflict")
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
                created = True
            except FileExistsError:
                created = False
            with _owned(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)) as fd:
                owner = os.fstat(fd)
                _need(owner.st_uid == os.getuid() and not owner.st_mode & 0o077, "release_tuple_conflict")
                if created:
                    os.mkdir("extractor", 0o700, dir_fd=fd)
                    with _owned(os.open("extractor", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)) as child:
                        for filename, data in extractor.items():
                            _write_file(child, filename, data)
                        os.fsync(child)
                    os.mkdir("source", 0o700, dir_fd=fd)
                    with _owned(os.open("source", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)) as child:
                        _publish_source(child, contents)
                        os.fsync(child)
                    _write_file(fd, "manifest.json", raw)  # manifest last; partial directories remain refused
                    os.fsync(fd)
                    os.fsync(parent)
                _verify_tuple(fd, raw, extractor, manifest, destination / "source")
    _verify_checkout(root, manifest)                 # no success if selected Source drifted during publication
    _need(time.monotonic() < until, "git_source_timeout")
    return {nh.ENV_RELEASE_MANIFEST: str(destination / "manifest.json"),
        nh.ENV_RELEASE_SOURCE: str(destination / "source"), nh.ENV_EXTRACTOR: str(destination / "extractor")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_dir", help="absolute canonical Git release root")
    parser.add_argument("revision", help="exact full40 lowercase deployed commit")
    parser.add_argument("--extractor", required=True, help="absolute canonical selected three-file directory")
    args = parser.parse_args(argv)
    try:
        paths = write_release_inputs(args.release_dir, args.revision, args.extractor)
    except (nh.SourceRefused, OSError, ValueError, subprocess.SubprocessError):
        print('{"error":"release_inputs_refused"}', file=sys.stderr)
        return 1
    print(json.dumps(paths, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
