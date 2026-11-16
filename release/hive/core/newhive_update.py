"""J1f update hooks for a new-hive installation (new hive R1b-2; plan r1.1 §1 and §4, J1 design r4 "the update window").

Host-side pieces the J1f updater calls; the updater itself (stop, tree check, snapshot, switch, judge) is J1f's.

- ``updater_lock(state_dir)``: the J1 ``state/updater.lock``, an exclusive non-blocking flock, held from step 1 to 6.
  Staging refuses without it.
- ``stage_candidate(lock, manifest, source, extractor)``: before the switch, verify the CANDIDATE release's code-only
  source and pinned extractor exactly as the host will (descriptor-confined collector, same runtime) and cache its
  next envelope/receipt under ``state/staged/<manifest sha256>/``. The cache is labelled ``candidate``: it never
  touches the data folder, the database, the installed binding or readiness, and it is never loaded by the host. A
  staging failure aborts the update before anything is stopped. An existing stage with other bytes is never
  overwritten (``stage_conflict``).
- ``load_staged(state_dir, manifest_sha256)``: the launcher helper's bytes for the new release's first setup; every
  digest, the receipt/envelope pairing and the runtime are re-checked, else None (the helper then prepares itself).
- ``check_rollback(data_dir, target_features)``: before J1f starts an OLDER release on this data, the target must
  support every feature the data folder requires. A release that cannot answer ``features`` (any release before this
  one, e.g. 1f5) supports none: rollback to it is refused, never silently switching the done-gate off. When the target
  release's binding already completed here, its map is retained (R1a.1 retention) and readiness replays after the
  restart's source check; otherwise coding is held until its own setup.

CLI (the launcher runs the TARGET release's own copy): ``python -m hive.core.newhive_update features`` prints the
supported features as JSON; ``check-rollback --data-dir D --features JSON [--manifest-sha256 S]``.
"""

from __future__ import annotations

import contextlib
import dataclasses
import fcntl
import json
import os
import pathlib
import secrets
import sqlite3
import sys
import time

from . import newhive

STAGE_SCHEMA = "omegahive-staged-candidate/1"


class UpdaterBusy(Exception):
    """Another updater holds state/updater.lock."""


class StageRefused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


class _Lock:
    def __init__(self, state_dir, fd):
        self.state_dir, self._fd = pathlib.Path(state_dir), fd

    @property
    def held(self):
        return self._fd is not None


@contextlib.contextmanager
def updater_lock(state_dir):
    state_dir = pathlib.Path(newhive.canonical_abs(str(state_dir), "state_dir"))
    dir_fd = newhive._anchored_dir(str(state_dir), "state_dir")
    try:
        fd = os.open("updater.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o600,
                     dir_fd=dir_fd)
    finally:
        os.close(dir_fd)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise UpdaterBusy("another update is in progress (state/updater.lock is held)") from None
    lock = _Lock(state_dir, fd)
    try:
        yield lock
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
        lock._fd = None


@dataclasses.dataclass(frozen=True)
class Staged:
    manifest_sha256: str
    folder: pathlib.Path
    prepared: newhive.Prepared
    record: dict


def _write_file(dir_fd, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o600,
                 dir_fd=dir_fd)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def _stage_record(prepared, runtime):
    return {"schema": STAGE_SCHEMA, "label": "candidate", "manifest_sha256": prepared.manifest_sha256,
            "repo": prepared.repo, "sha": prepared.sha, "runtime": runtime, "map_digest": prepared.map_digest,
            "receipt_sha256": prepared.receipt_sha256, "envelope_sha256": prepared.envelope_sha256,
            "state": prepared.state, "counts": prepared.counts}


def stage_candidate(lock, manifest_path, source_root, extractor_dir):
    """Verify and cache the candidate's next envelope, under the updater lock. Returns Staged; raises StageRefused."""
    if not isinstance(lock, _Lock) or not lock.held:
        raise StageRefused("lock_required", "staging runs only under the held updater lock")
    from .newhive_helper import launcher_prepare
    try:
        prepared = launcher_prepare(manifest_path, source_root, extractor_dir)
    except newhive.SourceRefused as exc:
        raise StageRefused(exc.code, f"the candidate release did not verify: {exc.message}") from None
    record = _stage_record(prepared, newhive.runtime_identity())
    existing = load_staged(lock.state_dir, prepared.manifest_sha256)
    if existing is not None:
        if existing.record == dict(record, staged_at=existing.record.get("staged_at")):
            return existing   # the same candidate, staged before: idempotent
        raise StageRefused("stage_conflict", "a different stage exists for this manifest; kept as it is")
    staged_root = lock.state_dir / "staged"
    root_fd = newhive._anchored_dir(str(lock.state_dir), "state_dir")
    try:
        with contextlib.suppress(FileExistsError):
            os.mkdir("staged", 0o700, dir_fd=root_fd)
        staged_fd = os.open("staged", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    finally:
        os.close(root_fd)
    try:
        if os.path.lexists(staged_root / prepared.manifest_sha256):
            raise StageRefused("stage_conflict", "an unreadable stage exists for this manifest; kept as it is")
        tmp = f".tmp-{secrets.token_hex(6)}"
        os.mkdir(tmp, 0o700, dir_fd=staged_fd)
        tmp_fd = os.open(tmp, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=staged_fd)
        try:
            _write_file(tmp_fd, "receipt.json", prepared.receipt_bytes)
            _write_file(tmp_fd, "envelope.json", prepared.envelope_bytes)
            _write_file(tmp_fd, "stage.json", newhive._canon_bytes(dict(record, staged_at=time.time())))
            os.fsync(tmp_fd)
        finally:
            os.close(tmp_fd)
        os.rename(tmp, prepared.manifest_sha256, src_dir_fd=staged_fd, dst_dir_fd=staged_fd)
        os.fsync(staged_fd)
    finally:
        os.close(staged_fd)
    staged = load_staged(lock.state_dir, prepared.manifest_sha256)
    if staged is None:
        raise StageRefused("stage_unreadable", "the stage just written does not read back")
    return staged


def _read_rel(dir_fd, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=dir_fd)
    try:
        chunks, left = [], limit + 1
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        data = b"".join(chunks)
    finally:
        os.close(fd)
    if len(data) > limit:
        raise ValueError("too large")
    return data


def load_staged(state_dir, manifest_sha256):
    """The staged candidate, every byte re-checked (digests, pairing, runtime); None when absent or not exact."""
    from . import repomap
    if not isinstance(manifest_sha256, str) or not newhive.HEX64.fullmatch(manifest_sha256):
        return None
    folder = pathlib.Path(state_dir) / "staged" / manifest_sha256
    try:
        fd = newhive._anchored_dir(str(folder), "state_dir")
    except newhive.SourceRefused:
        return None
    try:
        record = json.loads(_read_rel(fd, "stage.json", 1 << 20))
        receipt_bytes = _read_rel(fd, "receipt.json", repomap.MAX_BODY)
        envelope_bytes = _read_rel(fd, "envelope.json", repomap.MAX_BODY)
    except (OSError, ValueError):
        return None
    finally:
        os.close(fd)
    try:
        if (record.get("schema") != STAGE_SCHEMA or record.get("label") != "candidate"
                or record.get("manifest_sha256") != manifest_sha256 or record.get("runtime") != newhive.runtime_identity()
                or newhive._sha(receipt_bytes) != record.get("receipt_sha256")
                or newhive._sha(envelope_bytes) != record.get("envelope_sha256")
                or "sha256:" + record.get("envelope_sha256", "") != record.get("map_digest")):
            return None
        envelope, receipt = json.loads(envelope_bytes), json.loads(receipt_bytes)
        newhive.verify_pair(envelope, receipt)
        if newhive._canon_bytes(envelope) != envelope_bytes or newhive._canon_bytes(receipt) != receipt_bytes:
            return None
    except (ValueError, newhive.SourceRefused, TypeError):
        return None
    prepared = newhive.Prepared(envelope["repo"], envelope["sha"], manifest_sha256, receipt_bytes,
                                record["receipt_sha256"], envelope_bytes, record["envelope_sha256"], record["map_digest"],
                                envelope["state"], record.get("counts"))
    return Staged(manifest_sha256, folder, prepared, record)


def supported_features():
    return list(newhive.FEATURES)


def check_rollback(data_dir, target_features, target_manifest_sha256=None):
    """May J1f start a release that supports ``target_features`` on this data folder? A dict, never an exception."""
    data_dir = pathlib.Path(data_dir)
    rows = newhive._feature_rows(data_dir / "hive.db")
    has_marker = os.path.lexists(data_dir / newhive.MARKER_NAME)
    if not rows and not has_marker:
        return {"ok": True, "required": [], "note": "this data folder requires no new-hive feature"}
    if not rows or not has_marker:
        return {"ok": False, "reason": "marker_mismatch", "required": sorted(r["feature"] for r in rows)}
    required = sorted(r["feature"] for r in rows)
    supported = set(target_features or [])
    missing = [f for f in required if f not in supported]
    if missing:
        return {"ok": False, "reason": "feature_unsupported", "required": required, "missing": missing,
                "message": f"the target release does not know {', '.join(missing)}; starting it would switch the "
                           "installation's requirements off, so the rollback is refused"}
    out = {"ok": True, "required": required}
    if target_manifest_sha256:
        conn = sqlite3.connect(f"file:{data_dir / 'hive.db'}?mode=ro", uri=True)
        try:
            done = conn.execute("SELECT 1 FROM local_bootstrap_completions WHERE manifest_sha256 = ?",
                                (target_manifest_sha256,)).fetchone() is not None
        except sqlite3.Error:
            done = False
        finally:
            conn.close()
        out["target_completed"] = done
        out["after_restart"] = ("coding replays after the restart's source check (its map is retained)" if done
                                else "coding stays held until the target release's own setup")
    return out


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(prog="python -m hive.core.newhive_update")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("features")
    rb = sub.add_parser("check-rollback")
    rb.add_argument("--data-dir", required=True)
    rb.add_argument("--features", required=True, help="JSON list the TARGET release printed for `features`")
    rb.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    if args.cmd == "features":
        print(json.dumps({"features": supported_features(), "runtime": newhive.runtime_identity()}))
        return 0
    try:
        features = json.loads(args.features)
    except ValueError:
        features = []
    out = check_rollback(args.data_dir, features if isinstance(features, list) else [], args.manifest_sha256)
    print(json.dumps(out))
    return 0 if out["ok"] else 3


if __name__ == "__main__":
    sys.exit(main())
