"""auth_session_ref: an opaque, per-session attribution reference for GET /api/auth/me.

The reference is HMAC-SHA256, under this deployment's own key, of a domain string, a NUL byte and the verified session
row's token_hash. Without the key, holding a bearer (or reading the sessions table or a backup) is not enough to
compute it. It is attribution only: no route accepts it as authentication or authority.

The key lives in HIVE_DATA_DIR/auth-session-ref.key (64 hex chars, mode 0600). It is created on first use, atomically
(0600 temp file, fsync, rename) under an exclusive lock on auth-session-ref.key.lock, so a concurrent first use in
another thread or process reads the winner's key. A missing or unreadable-as-a-key file is replaced by a new key, never
by an unkeyed hash. Replacing the key changes every reference; restarting with the same key keeps them.
"""

from __future__ import annotations

import fcntl
import hashlib
import hmac
import os
import pathlib
import re
import secrets
import threading

KEY_FILE = "auth-session-ref.key"
DOMAIN = b"hive-auth-session-reference/2\0"
PREFIX = "as1_"  # wire shape (as1_ + 64 lowercase hex) is unchanged; the derivation is versioned by DOMAIN
_KEY_TEXT = re.compile(r"[0-9a-f]{64}")


def _read_key(path: pathlib.Path) -> bytes | None:
    try:
        text = path.read_text(encoding="ascii").strip()
    except (FileNotFoundError, UnicodeDecodeError):
        return None
    return bytes.fromhex(text) if _KEY_TEXT.fullmatch(text) else None


def _write_temp(directory: pathlib.Path) -> pathlib.Path:
    """A new random key in an exclusive 0600 temp file, flushed to disk."""
    tmp = directory / f".{KEY_FILE}.{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, secrets.token_hex(32).encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return tmp


def load_or_create_key(data_dir: pathlib.Path) -> bytes:
    data_dir = pathlib.Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / KEY_FILE
    key = _read_key(path)
    if key is None:
        # creation and replacement are serialized across threads and processes; the loser re-reads the winner's key
        lock_fd = os.open(data_dir / (KEY_FILE + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            key = _read_key(path)
            if key is None:
                tmp = _write_temp(data_dir)
                try:
                    os.replace(tmp, path)  # missing or malformed: a new key, never an unkeyed hash
                finally:
                    tmp.unlink(missing_ok=True)
                key = _read_key(path)
                if key is None:
                    raise RuntimeError(f"{path} is not a usable auth-session-ref key")
        finally:
            os.close(lock_fd)  # releases the lock
    if path.stat().st_mode & 0o077:
        path.chmod(0o600)
    return key


class SessionRefs:
    """Derives references for one deployment; the key is read (or created) on first use and kept in memory."""

    def __init__(self, data_dir: pathlib.Path):
        self.data_dir = pathlib.Path(data_dir)
        self._key: bytes | None = None
        self._lock = threading.Lock()

    def key(self) -> bytes:
        with self._lock:
            if self._key is None:
                self._key = load_or_create_key(self.data_dir)
            return self._key

    def ref(self, token_hash: str) -> str:
        return PREFIX + hmac.new(self.key(), DOMAIN + token_hash.encode("utf-8"), hashlib.sha256).hexdigest()
