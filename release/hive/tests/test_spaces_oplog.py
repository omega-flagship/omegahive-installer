"""Purpose: verify the commons log file layer (hive/spaces/oplog.py) without PeTTa: a log cut at any byte keeps exactly
its complete records and takes the next append on a fresh line; a corrupt line with a newline after it is refused at
its line and byte wherever it is; an append is fsynced before it returns (and its directory when it made the file), and
a failed one leaves nothing behind; a rewrite replaces the log whole or not at all."""

import json
import os
import stat

import pytest

from hive.spaces import oplog
from hive.spaces.oplog import LogCorrupt, OpLog

RECORDS = [
    {"op": "grant", "agent_id": "a1", "swarm_id": "s1"},
    {"op": "vocab", "swarm_id": "s1", "term": "sky", "agent_id": "a1"},
    {"op": "publish", "swarm_id": "s1", "agent_id": "a1", "statement": "(--> sky \"bleu \u00e9t\u00e9\")", "f": 0.9,
     "c": 0.5, "stamp": ["ev:a1:1"]},
    {"op": "revoke", "agent_id": "a1", "swarm_id": "s1"},
]
NEW = {"op": "grant", "agent_id": "a2", "swarm_id": "s1"}


def _lines(records):
    return [(json.dumps(r) + "\n").encode("ascii") for r in records]


def _expected(data, cut):
    """The records a log cut at byte ``cut`` holds whole: every line whose newline is kept, and the line after them if
    the cut falls exactly at its end (JSON Lines lets the last value go without a newline)."""
    whole, pos = [], 0
    for line in _lines(RECORDS):
        if pos + len(line) <= cut:
            whole.append(json.loads(line))
        elif pos + len(line) - 1 == cut:
            whole.append(json.loads(line))
        pos += len(line)
    return whole


def test_a_log_cut_at_every_byte_keeps_its_complete_records_and_appends_on_a_fresh_line(tmp_path):
    data = b"".join(_lines(RECORDS))
    for cut in range(len(data) + 1):
        path = tmp_path / f"cut-{cut}.jsonl"
        path.write_bytes(data[:cut])
        log = OpLog(path)
        scan = log.scan()
        kept = _expected(data, cut)
        assert [r.value for r in scan.records] == kept, cut
        changes = log.repair(scan)
        assert path.read_bytes() == b"".join(_lines(kept)), cut          # torn bytes gone, a last record ended
        assert bool(changes) == (path.stat().st_size != cut), cut        # repair says what it changed, and only then
        log.append(NEW)
        assert [r.value for r in OpLog(path).scan().records] == kept + [NEW], cut


@pytest.mark.parametrize("garbage", [b"\x00" * 7, b"\xff\xfe{", b"   \t", b'{"op": "gra', b"]"])
def test_a_last_line_that_does_not_parse_is_dropped_whatever_it_holds(tmp_path, garbage):
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(b"".join(_lines(RECORDS[:2])) + garbage)
    log = OpLog(path)
    scan = log.scan()
    assert [r.value for r in scan.records] == RECORDS[:2] and scan.torn == garbage
    assert "dropped its last" in log.repair(scan)[0]
    assert path.read_bytes() == b"".join(_lines(RECORDS[:2]))


def test_an_unterminated_last_record_is_kept_and_ended_with_its_newline(tmp_path):
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(b"".join(_lines(RECORDS))[:-1])
    log = OpLog(path)
    scan = log.scan()
    assert [r.value for r in scan.records] == RECORDS and scan.unterminated and not scan.torn
    assert log.repair(scan) == ["its last record had no newline after it; added one"]
    assert path.read_bytes() == b"".join(_lines(RECORDS))


@pytest.mark.parametrize("bad", [b'{"op": "grant", "agent_id": "a1", "swa', b"\x00\x00\x00", b"\xff", b"not json"])
def test_a_line_with_a_newline_after_it_that_is_not_json_is_refused_at_its_line_and_byte(tmp_path, bad):
    lines = _lines(RECORDS)
    for i in range(len(lines)):                               # every position, the last terminated line included
        broken = lines[:i] + [bad + b"\n"] + lines[i + 1:]
        path = tmp_path / f"bad-{i}.jsonl"
        path.write_bytes(b"".join(broken))
        with pytest.raises(LogCorrupt) as caught:
            OpLog(path).scan()
        assert (caught.value.line, caught.value.offset) == (i + 1, sum(map(len, lines[:i])))
        assert path.read_bytes() == b"".join(broken)          # a refused log is never changed


def test_blank_lines_are_skipped_and_line_numbers_still_count_them(tmp_path):
    path = tmp_path / "spaces.log.jsonl"
    lines = _lines(RECORDS[:2])
    path.write_bytes(lines[0] + b"\n  \n" + lines[1])
    scan = OpLog(path).scan()
    assert [(r.line, r.value) for r in scan.records] == [(1, RECORDS[0]), (4, RECORDS[1])]


def test_append_refuses_until_a_torn_last_line_is_repaired(tmp_path):
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(_lines(RECORDS[:1])[0] + b'{"op"')
    log = OpLog(path)
    scan = log.scan()
    with pytest.raises(RuntimeError, match="repair"):
        log.append(NEW)                                       # it would be glued onto the torn line
    log.repair(scan)
    log.append(NEW)
    assert [r.value for r in OpLog(path).scan().records] == [RECORDS[0], NEW]


def _fsyncs(monkeypatch):
    """Record each fsync as ("dir" or "file", inode) at the moment it runs."""
    calls, real = [], os.fsync

    def spy(fd):
        st = os.fstat(fd)
        calls.append(("dir" if stat.S_ISDIR(st.st_mode) else "file", st.st_ino))
        return real(fd)
    monkeypatch.setattr(oplog.os, "fsync", spy)
    return calls


def test_append_fsyncs_the_record_and_the_directory_entry_it_creates_before_returning(tmp_path, monkeypatch):
    calls = _fsyncs(monkeypatch)
    path = tmp_path / "spaces.log.jsonl"
    log = OpLog(path)
    log.repair(log.scan())
    log.append(RECORDS[0])                                    # creates the file: the record, then the directory entry
    assert calls == [("file", path.stat().st_ino), ("dir", tmp_path.stat().st_ino)]
    calls.clear()
    log.append(RECORDS[1])                                    # the file exists: the record only
    assert calls == [("file", path.stat().st_ino)]


def test_a_write_that_fails_part_way_is_truncated_back_off(tmp_path, monkeypatch):
    path = tmp_path / "spaces.log.jsonl"
    log = OpLog(path)
    log.repair(log.scan())
    log.append(RECORDS[0])
    before = path.read_bytes()
    real_write_all = oplog._write_all

    def half_then_full(fd, data):
        real_write_all(fd, data[: len(data) // 2])
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(oplog, "_write_all", half_then_full)
    with pytest.raises(OSError):
        log.append(RECORDS[1])
    assert path.read_bytes() == before


def test_a_rewrite_replaces_the_log_whole_and_keeps_its_permissions(tmp_path, monkeypatch):
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(b"".join(_lines(RECORDS)))
    path.chmod(0o640)
    calls = _fsyncs(monkeypatch)
    log = OpLog(path)
    log.repair(log.scan())
    log.rewrite(RECORDS[:1])
    assert path.read_bytes() == _lines(RECORDS[:1])[0] and stat.S_IMODE(path.stat().st_mode) == 0o640
    assert calls == [("file", path.stat().st_ino), ("dir", tmp_path.stat().st_ino)]   # the new file, then the rename
    assert not any(p.name.endswith(".compacting") for p in tmp_path.iterdir())


def test_a_rewrite_that_fails_before_the_rename_leaves_the_old_log_and_no_staging_file(tmp_path, monkeypatch):
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(b"".join(_lines(RECORDS)))
    log = OpLog(path)
    log.repair(log.scan())

    def crash(src, dst):
        raise OSError(5, "Input/output error")
    monkeypatch.setattr(oplog.os, "replace", crash)
    with pytest.raises(OSError):
        log.rewrite(RECORDS[:1])
    assert path.read_bytes() == b"".join(_lines(RECORDS))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["spaces.log.jsonl"]


def test_a_staging_file_a_crash_left_is_removed_and_the_log_read_as_it_is(tmp_path):
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(b"".join(_lines(RECORDS)))
    (tmp_path / "spaces.log.jsonl.compacting").write_bytes(_lines(RECORDS[:1])[0][:9])   # killed mid-compaction
    log = OpLog(path)
    scan = log.scan()
    assert [r.value for r in scan.records] == RECORDS
    assert log.repair(scan) == ["removed spaces.log.jsonl.compacting, left by a compaction that did not finish"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["spaces.log.jsonl"]


@pytest.mark.parametrize("remainders", [[b'{"op": "gra'], [b'{"op": "pub', b'{"op": "vocab", "swa']])
def test_a_line_an_older_release_glued_is_refused_with_the_bytes_whose_deletion_keeps_its_record(tmp_path, remainders):
    # Releases before this one skipped a torn line but left it in the file, so the next record was appended onto
    # it, once or after each of several crashes.
    lines = _lines(RECORDS)
    glued = b"".join(remainders) + lines[1]
    path = tmp_path / "spaces.log.jsonl"
    path.write_bytes(lines[0] + glued + b"".join(lines[2:]))
    with pytest.raises(LogCorrupt) as caught:
        OpLog(path).scan()
    cut = sum(map(len, remainders))
    start = len(lines[0])
    assert (caught.value.line, caught.value.offset) == (2, start)
    assert f"delete only the first {cut} bytes of this line (bytes {start} to {start + cut - 1} of the file)" in str(
        caught.value)
    data = path.read_bytes()                                  # do as it says
    path.write_bytes(data[:start] + data[start + cut:])
    assert [r.value for r in OpLog(path).scan().records] == RECORDS
