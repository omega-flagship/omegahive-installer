"""Purpose: the commons operations log on disk (``spaces.log.jsonl``): JSON Lines records, each appended and fsynced
before the write that made it returns, read back with only a torn last line dropped, and replaced whole by an atomic
rewrite when SpaceService compacts the log.

Reading follows JSON Lines (https://jsonlines.org): one JSON value per line, and the newline after the last value is
recommended but not required. So a last line that parses is a whole record, and a last line that does not is the
remainder of an append that a crash or power loss cut short. That remainder is dropped and truncated off, as Redis
truncates an AOF cut short at its last valid command and etcd truncates an unexpected EOF in its last WAL file, so the
next append starts on a fresh line instead of being glued onto it. A line that does not parse and has a newline after
it is not a torn append: every append is fsynced before the next one starts, so only the last line can be cut short.
Such a line is corruption, and reading stops there with its line and byte instead of skipping it.

Callers serialise writes: SpaceService holds its write lock around append and rewrite.
"""

from __future__ import annotations

import json
import os
import pathlib
import stat
from typing import NamedTuple

_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class LogCorrupt(Exception):
    """A line with a newline after it that is not JSON: the log cannot be read whole."""

    def __init__(self, path, line, offset, reason):
        super().__init__(f"{path} line {line} (byte {offset}): {reason}")
        self.path, self.line, self.offset, self.reason = path, line, offset, reason


class Record(NamedTuple):
    line: int      # 1-based line number in the file
    offset: int    # byte offset of the line's first byte
    value: object  # the parsed JSON value (SpaceService checks that it is a record)


class Scan(NamedTuple):
    records: list
    end: int          # bytes kept: where the next append starts once the scan is repaired
    torn: bytes       # the cut-short last line that repair() drops (b"" if none)
    unterminated: bool  # the last record parsed but has no newline after it, which repair() adds


_NOT_JSON = object()


def _parse(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return _NOT_JSON


def _glued(raw):
    """Where a whole record starts on a line that holds a torn append's remainder before it: the offset of the first
    later {"op": whose rest of the line parses as an object, or None. Releases before this one skipped a torn line but
    left it in the file, so the next record was appended onto it; every record starts {"op":, as json.dumps writes
    the dict with op first."""
    start = raw.find(b'{"op":', 1)
    while start > 0:
        if isinstance(_parse(raw[start:]), dict):
            return start
        start = raw.find(b'{"op":', start + 1)
    return None


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def _fsync_dir(path):
    """Make a file's creation or rename in ``path`` durable (a directory entry is not on disk until its directory is
    fsynced; SQLite does the same for a journal it creates)."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class OpLog:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self._staging = self.path.with_name(self.path.name + ".compacting")
        self._unrepaired = None   # the last scan, while its torn or unterminated last line is still in the file

    def scan(self):
        """Every record in the file, in order, and what its last line needs; the file is not changed (repair() does
        that, once the caller has accepted every record). Raises LogCorrupt at the first terminated line that is not
        JSON. Blank lines, which no version of the hive writes, are skipped.

        Time: one pass over the file's bytes, n = file size. Space: the whole file and its parsed records."""
        try:
            data = self.path.read_bytes()
        except FileNotFoundError:
            data = b""
        records, pos, line = [], 0, 0
        torn, unterminated = b"", False
        while pos < len(data):
            line += 1
            end = data.find(b"\n", pos)
            if end < 0:                                   # the last line, with no newline after it
                value = _parse(data[pos:])
                if value is _NOT_JSON:
                    torn = data[pos:]
                else:
                    records.append(Record(line, pos, value))
                    unterminated = True
                break
            raw = data[pos:end]
            if raw.strip():
                value = _parse(raw)
                if value is _NOT_JSON:
                    cut = _glued(raw)
                    if cut is None:
                        raise LogCorrupt(self.path, line, pos, f"not JSON: {raw[:60]!r}")
                    raise LogCorrupt(self.path, line, pos, (
                        f"the remainder of a torn append, {raw[:min(cut, 40)]!r}, with a whole record glued after it, "
                        f"as a release before this one left a log after a crash; delete only the first {cut} bytes of "
                        f"this line (bytes {pos} to {pos + cut - 1} of the file): what follows them is a whole record "
                        "and is kept"))
                records.append(Record(line, pos, value))
            pos = end + 1
        result = Scan(records, len(data) - len(torn), torn, unterminated)
        self._unrepaired = result if (torn or unterminated) else None
        return result

    def repair(self, scan):
        """Make the file end with a newline after its last record: truncate a torn last line off, or end an
        unterminated last record with its newline, then fsync. Also removes a staging file a crash left mid-compaction
        (the log itself is whole: the rename that would have replaced it never happened). Returns what it changed, as
        sentences for the hive's log."""
        changes = []
        if scan.torn:
            fd = os.open(self.path, os.O_WRONLY | _O_CLOEXEC)
            try:
                os.ftruncate(fd, scan.end)
                os.fsync(fd)
            finally:
                os.close(fd)
            changes.append(f"dropped its last {len(scan.torn)} bytes, at byte {scan.end}: an append a crash or power "
                           f"loss cut short; the {len(scan.records)} complete records before it are kept")
        elif scan.unterminated:
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | _O_CLOEXEC)
            try:
                _write_all(fd, b"\n")
                os.fsync(fd)
            finally:
                os.close(fd)
            changes.append("its last record had no newline after it; added one")
        if self._staging.exists():
            self._staging.unlink()
            changes.append(f"removed {self._staging.name}, left by a compaction that did not finish")
        self._unrepaired = None
        return changes

    def append(self, record):
        """Append one record and fsync it, and the directory too when this append created the file, before returning.
        A write that fails part-way is truncated back off, so nothing is left for the next record to be glued onto.

        fsync, not macOS's F_FULLFSYNC: the same durability hive.db's SQLite gets by default."""
        if self._unrepaired is not None:
            raise RuntimeError(f"{self.path}: repair() the scanned log before appending to it")
        line = (json.dumps(record) + "\n").encode("ascii")   # json.dumps escapes non-ASCII, so a record is ASCII
        created = not os.path.lexists(self.path)
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | _O_CLOEXEC, 0o666)
        try:
            start = os.fstat(fd).st_size
            try:
                _write_all(fd, line)
                os.fsync(fd)
            except BaseException:
                try:
                    os.ftruncate(fd, start)
                except OSError:
                    pass   # the caller stops writing to this log, so a remainder stays the last line: torn, dropped
                raise
        finally:
            os.close(fd)
        if created:
            _fsync_dir(self.path.parent)

    def rewrite(self, records):
        """Replace the whole log with these records: written to a staging file, fsynced, renamed over the log, and the
        directory fsynced. A crash at any point leaves either the old log or the new one, each complete. Returns the
        number of bytes written."""
        data = b"".join((json.dumps(r) + "\n").encode("ascii") for r in records)
        fd = os.open(self._staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | _O_NOFOLLOW | _O_CLOEXEC, 0o666)
        try:
            try:
                if self.path.exists():
                    os.fchmod(fd, stat.S_IMODE(os.stat(self.path).st_mode))   # the log keeps its permissions
                _write_all(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(self._staging, self.path)
        except BaseException:
            self._staging.unlink(missing_ok=True)
            raise
        _fsync_dir(self.path.parent)
        self._unrepaired = None
        return len(data)
