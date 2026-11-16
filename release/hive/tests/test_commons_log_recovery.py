"""Purpose: verify the commons log end to end on SpaceService and the embedded PeTTa (flagship review #111, item 8). A
log cut short at a record boundary, inside a record or just before its newline starts with every complete record and
takes the next write on a line of its own; a line that cannot be replayed stops the start and names its line; writes
that race are logged in the order they were applied; a write whose append fails stops later writes until a restart;
and compaction rewrites the log as a snapshot that every reader answers from exactly as before, once replaying the
log's tail costs more than its snapshot.

PeTTa runs one interpreter per process and its spaces are global, so a restart here empties this test's spaces (its
swarms' commons and vocabularies and their grants) and starts a new service on the same folder, which replays the log
as a new process would. Each test names its own swarms and agents."""

import json
import os
import pathlib
import random
import re
import secrets
import shutil
import threading

import pytest

from hive.spaces import service as service_module
from hive.spaces.oplog import OpLog
from hive.spaces.service import SNAPSHOT_OPS, SpaceError, SpaceService

PETTA = os.environ.get("PETTA_PATH", str(pathlib.Path.home() / "PeTTa"))
pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

STATEMENTS = ("(--> sky blue)", "(--> grass green)", "(==> (--> a b) (--> b c))", "(--> (x cat dog) friends)",
              '(--> (x "a back\\\\slash word" 3 -1.5) fact)')   # an escaped string and numbers round-trip too (a double
                                                                # quote can't cross into PeTTa, so sexpr refuses one)
TERMS = ("sky", "blue", "grass", "green", "a", "b", "c", "cat", "dog", "friends", "fact")


class Names:
    def __init__(self):
        tag = secrets.token_hex(4)
        self.tag = tag
        self.swarms = [f"cl{tag}x", f"cl{tag}y"]
        self.agents = [f"ca{tag}", f"cb{tag}", f"cc{tag}"]


@pytest.fixture
def names():
    return Names()


@pytest.fixture
def interp():
    return service_module._Interpreter.get(PETTA)


@pytest.fixture
def no_auto_compaction(interp, monkeypatch):
    """Compaction only where a test calls it: the floor it must beat (what starting PeTTa cost) made unreachable."""
    monkeypatch.setattr(interp, "start_seconds", float("inf"))


def _wipe(svc, names):
    for s in names.swarms:
        svc.run(f"!(length (collapse (match &hive_acl (Grant $a &commons_{s} $p $r) "
                f"(remove-atom &hive_acl (Grant $a &commons_{s} $p $r)))))")
        for space in (f"&commons_{s}", f"&vocab_{s}"):
            svc.run(f"!(length (collapse (match {space} $x (remove-atom {space} $x))))")
            assert svc.run(f"!(length (collapse (match {space} $x 1)))") == ["0"]
        assert svc.run(f"!(length (collapse (match &hive_acl (Grant $a &commons_{s} $p $r) 1)))") == ["0"]


def _restart(svc, names, folder=None):
    """What a new process sees: this test's spaces emptied, then a new service replays the log in ``folder``."""
    _wipe(svc, names)
    return SpaceService(folder or svc.data_dir)


def _state(svc, names):
    """Everything a reader can see of this test's spaces, the raw atoms in each space's order included. Quarantine
    notes are left out: a quarantined publish is never logged, so no restart has ever kept one."""
    out = {}
    for s in names.swarms:
        commons = svc.run_one(f"!(collapse (match &commons_{s} $x $x))") or []
        beliefs = svc.beliefs(s)
        out[s] = {
            "commons": [atom for atom in commons if atom[0] != "Quarantined"],
            "vocab": svc.run(f"!(collapse (match &vocab_{s} $x $x))"),
            "grants": svc.run(f"!(collapse (match &hive_acl (Grant $a &commons_{s} $p $r) ($a $r)))"),
            "beliefs": beliefs,
            "belief": {b["statement"]: svc.belief(s, b["statement"]) for b in beliefs},
            "vocab_reader": svc.vocab(s),
            "members": {a: svc.is_member(a, s) for a in names.agents},
            "query": [q for q in svc.query(s, "$x") if not q.startswith("(Quarantined")],
        }
    return out


def _random_writes(svc, names, rng, n):
    """n random writes: grants, revokes, vocabulary and publishes with fresh, echoed and merged stamps, so the commons
    see adoption, revision, choice, kept, duplicate, denial and quarantine."""
    minted, seen = {a: 0 for a in names.agents}, []
    for _ in range(n):
        agent, swarm = rng.choice(names.agents), rng.choice(names.swarms)
        kind = rng.choices(("grant", "revoke", "vocab", "publish"), (3, 1, 2, 8))[0]
        if kind == "grant":
            svc.grant(agent, swarm)
        elif kind == "revoke":
            svc.revoke(agent, swarm)
        elif kind == "vocab":
            svc.add_vocab(swarm, rng.sample(TERMS, 2), agent)
        else:
            how = rng.random()
            if seen and how < 0.25:
                stamp = rng.choice(seen)                                   # an echo: it overlaps, so a choice
            else:
                minted[agent] += 1
                stamp = [f"ev:{agent}:{minted[agent]}"]
                if seen and how < 0.4:
                    stamp = sorted(set(stamp) | set(rng.choice(seen)))   # new evidence merged with old
            seen.append(stamp)
            svc.publish(swarm, agent, rng.choice(STATEMENTS), rng.choice((0.0, 0.25, 0.9, 1.0)),
                        rng.choice((0.1, 0.45, 0.9, 0.98)), stamp, open_vocab=rng.random() < 0.8)


def _records(svc):
    return [r.value for r in OpLog(svc.log_path).scan().records]


def test_a_log_cut_short_anywhere_starts_with_every_complete_record_and_writes_on(tmp_path, names, no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    _random_writes(svc, names, random.Random(8), 25)
    data = svc.log_path.read_bytes()
    lines = data.splitlines(keepends=True)
    assert len(lines) > 10
    expected = []
    for k in range(len(lines) + 1):                            # what each count of complete records replays to
        svc.log_path.write_bytes(b"".join(lines[:k]))
        svc = _restart(svc, names)
        expected.append(_state(svc, names))
    pos = 0
    for k, line in enumerate(lines):
        # at the boundary, inside the record, and just before its newline (a whole record, kept: JSON Lines)
        for cut, whole in ((pos, k), (pos + len(line) // 2, k), (pos + len(line) - 1, k + 1)):
            svc.log_path.write_bytes(data[:cut])
            svc = _restart(svc, names)
            assert _state(svc, names) == expected[whole], (cut, whole)
            svc.revoke(names.agents[0], names.swarms[0])            # always logged: it must get a line of its own
            records = _records(svc)
            assert len(records) == whole + 1 and records[-1]["op"] == "revoke", (cut, whole)
        pos += len(line)


@pytest.mark.parametrize("bad", [
    '{"op": "grant", "agent_id": "x", "swa',                                # cut short, with a newline after it
    "\x00\x00\x00\x00",
    "[1, 2]",
    '{"op": "evolve", "agent_id": "x", "swarm_id": "y"}',                    # no such record
    '{"op": "grant", "agent_id": "x"}',                                      # a field missing
    '{"op": "grant", "agent_id": "x", "swarm_id": "y", "extra": 1}',
    '{"op": "publish", "swarm_id": "y", "agent_id": "x", "statement": "(--> a b)", "f": "high", "c": 0.5, '
    '"stamp": ["ev:x:1"]}',
    '{"op": "member", "agent_id": "x", "swarm_id": "y"}',                    # a snapshot record after writes
])
def test_a_line_that_cannot_be_replayed_stops_the_start_naming_its_line(tmp_path, names, bad, no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    for agent in names.agents:
        svc.grant(agent, names.swarms[0])
    lines = svc.log_path.read_bytes().splitlines(keepends=True)
    for i in (1, len(lines) - 1):                              # mid-log, and the last line with its newline
        broken = b"".join(lines[:i]) + bad.encode() + b"\n" + b"".join(lines[i + 1:])
        svc.log_path.write_bytes(broken)
        with pytest.raises(SpaceError) as caught:
            _restart(svc, names)
        assert f"line {i + 1} (byte {sum(map(len, lines[:i]))})" in str(caught.value)
        assert "does not start on part of its commons" in str(caught.value)
        assert svc.log_path.read_bytes() == broken             # refused, never changed


def test_a_record_the_commons_grammar_now_refuses_is_skipped_with_a_warning_and_the_rest_applied(
        tmp_path, names, caplog, no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    s, (a, b, _) = names.swarms[0], names.agents
    svc.grant(a, s)
    code = {"op": "publish", "swarm_id": s, "agent_id": a, "statement": "(--> sky (py-call (os.getpid)))", "f": 0.9,
            "c": 0.8, "stamp": [f"ev:{a}:1"]}
    with open(svc.log_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(code) + "\n" + json.dumps({"op": "grant", "agent_id": b, "swarm_id": s}) + "\n")
    svc = _restart(svc, names)
    assert svc.is_member(a, s) and svc.is_member(b, s) and svc.beliefs(s) == []
    assert "spaces log line 2 (publish) refused" in caplog.text


def test_writes_that_race_are_logged_in_the_order_they_were_applied(tmp_path, names, monkeypatch, no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    s, (a, b, _) = names.swarms[0], names.agents
    svc.grant(a, s)
    svc.grant(b, s)
    svc.add_vocab(s, ["sky", "blue"])
    real_append, a_logging, b_done = OpLog.append, threading.Event(), threading.Event()

    def slow_append(self, record):
        if record["op"] == "publish" and record["agent_id"] == a:
            a_logging.set()
            b_done.wait(0.5)            # b's publish would apply and log in this window, were nothing holding it
        return real_append(self, record)
    monkeypatch.setattr(OpLog, "append", slow_append)
    first = threading.Thread(target=svc.publish, args=(s, a, "(--> sky blue)", 0.9, 0.5, [f"ev:{a}:1"]))
    first.start()
    assert a_logging.wait(10)
    svc.publish(s, b, "(--> sky blue)", 0.2, 0.6, [f"ev:{b}:1"])
    b_done.set()
    first.join(10)
    assert [r["agent_id"] for r in _records(svc) if r["op"] == "publish"] == [a, b]
    seen = _state(svc, names)
    assert _state(_restart(svc, names), names) == seen


def test_a_write_whose_append_fails_stops_writes_until_a_restart(tmp_path, names, monkeypatch, no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    s, (a, b, c) = names.swarms[0], names.agents
    svc.grant(a, s)
    real_append, full = OpLog.append, [True]

    def append(self, record):
        if full[0]:
            raise OSError(28, "No space left on device")
        return real_append(self, record)
    monkeypatch.setattr(OpLog, "append", append)
    with pytest.raises(OSError):
        svc.grant(b, s)
    full[0] = False                                            # room again: the log still cannot say what b's did
    for write in (lambda: svc.grant(c, s), lambda: svc.revoke(a, s), lambda: svc.add_vocab(s, ["sky"]),
                  lambda: svc.publish(s, a, "(--> sky blue)", 0.9, 0.5, [f"ev:{a}:1"]), svc.compact):
        with pytest.raises(SpaceError, match="commons writes stopped"):
            write()
    assert svc.is_member(a, s) and svc.vocab(s) == []          # reads go on
    svc = _restart(svc, names)
    assert svc.is_member(a, s) and not svc.is_member(b, s)    # the log decides, and b's grant never reached it
    svc.grant(c, s)
    assert svc.is_member(c, s)


@pytest.mark.parametrize("seed", range(12))
def test_compaction_keeps_what_every_reader_sees(tmp_path, names, seed, no_auto_compaction):
    rng = random.Random(seed)
    live = SpaceService(tmp_path / "live")
    _random_writes(live, names, rng, 30)
    seen = _state(live, names)
    (tmp_path / "copy").mkdir()
    shutil.copy(live.log_path, tmp_path / "copy" / "spaces.log.jsonl")
    live.compact()                                             # from the live spaces, quarantine notes and all
    assert all(r["op"] in SNAPSHOT_OPS for r in _records(live))
    svc = _restart(live, names)
    assert _state(svc, names) == seen
    svc = _restart(svc, names, tmp_path / "copy")              # the log as written replays to the same
    assert _state(svc, names) == seen
    svc.compact()                                              # a compaction of a replayed commons
    svc = _restart(svc, names)
    assert _state(svc, names) == seen
    _random_writes(svc, names, rng, 15)                        # a snapshot, then a tail of writes
    seen = _state(svc, names)
    svc = _restart(svc, names)
    assert _state(svc, names) == seen
    svc.compact()
    svc = _restart(svc, names)
    assert _state(svc, names) == seen


def test_a_much_revised_belief_loads_from_the_snapshot_without_being_revised_again(tmp_path, names, monkeypatch,
                                                                                    no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    s, a = names.swarms[0], names.agents[0]
    svc.grant(a, s)
    for i in range(1, 151):                                    # the governance commons' shape: one statement, revised
        svc.publish(s, a, "(--> sky blue)", 0.9, 0.3, [f"ev:{a}:{i}"])
    seen = _state(svc, names)
    assert len(seen[s]["beliefs"]) == 1 and len(seen[s]["beliefs"][0]["stamp"]) == 150
    svc.compact()
    _wipe(svc, names)
    real_run, jobs = service_module._Interpreter.run, []
    monkeypatch.setattr(service_module._Interpreter, "run",
                        lambda self, code, timeout=30: (jobs.append(code), real_run(self, code, timeout))[1])
    svc = SpaceService(svc.data_dir)
    started = list(jobs)
    assert _state(svc, names) == seen
    assert len(started) == len(_records(svc)) == 1 + 2 + 150 + 1   # member, terms, assertions, the current belief
    assert not any("hive-publish!" in code for code in started)  # each atom put back as it was, nothing revised again


def test_grant_and_revoke_churn_compacts_to_the_members_left(tmp_path, names, no_auto_compaction):
    svc = SpaceService(tmp_path / "spaces")
    s, a = names.swarms[0], names.agents[0]
    for i in range(150):                                       # minds made and removed, as tests and moves do
        svc.grant(f"m{names.tag}n{i}", s)
        svc.revoke(f"m{names.tag}n{i}", s)
    svc.grant(a, s)
    assert len(_records(svc)) == 301
    svc.compact()
    assert _records(svc) == [{"op": "member", "agent_id": a, "swarm_id": s}]
    svc = _restart(svc, names)
    assert svc.is_member(a, s) and not svc.is_member(f"m{names.tag}n0", s)


def test_the_log_compacts_itself_once_replaying_its_tail_costs_more_than_its_snapshot(tmp_path, names, interp,
                                                                                     monkeypatch):
    s, (a, b, _) = names.swarms[0], names.agents
    monkeypatch.setattr(interp, "start_seconds", float("inf"))
    svc = SpaceService(tmp_path / "spaces")
    svc.grant(a, s)
    for _ in range(5):
        svc.revoke(b, s)
    assert [r["op"] for r in _records(svc)] == ["grant"] + ["revoke"] * 5     # under an unreachable floor: no compaction
    monkeypatch.setattr(interp, "start_seconds", 0.0)
    svc.revoke(b, s)            # the tail now costs more than the snapshot (none) and the floor: the log compacts
    assert _records(svc) == [{"op": "member", "agent_id": a, "swarm_id": s}] and svc._compact_after > 0
    assert svc._tail_seconds == 0.0

    # On start: a long log replayed in more time than the floor is compacted before the service is used.
    folder = tmp_path / "old"
    folder.mkdir()
    old = [{"op": "grant", "agent_id": f"m{names.tag}n{i}", "swarm_id": s} for i in range(40)]
    old += [{"op": "revoke", "agent_id": f"m{names.tag}n{i}", "swarm_id": s} for i in range(39)]
    (folder / "spaces.log.jsonl").write_text("".join(json.dumps(r) + "\n" for r in old))
    svc = _restart(svc, names, folder)
    assert _records(svc) == [{"op": "member", "agent_id": f"m{names.tag}n39", "swarm_id": s}]
    assert svc.is_member(f"m{names.tag}n39", s) and not svc.is_member(f"m{names.tag}n0", s)


class _Clock:
    """service.py's time, every reading one second after the last, so each write's apply costs exactly 1 s."""

    def __init__(self):
        self.now = 0.0

    def perf_counter(self):
        self.now += 1.0
        return self.now


def test_a_compaction_that_keeps_failing_is_tried_again_only_once_the_tail_has_doubled(tmp_path, names, interp,
                                                                                         monkeypatch, caplog):
    s, a = names.swarms[0], names.agents[0]
    monkeypatch.setattr(interp, "start_seconds", 0.0)
    svc = SpaceService(tmp_path / "spaces")
    tails = []

    def no_record(self):                     # as for an atom kind the snapshot has no record for
        tails.append(self._tail_seconds)
        raise SpaceError("the access list holds an atom compaction has no record for: (Odd x)")
    monkeypatch.setattr(SpaceService, "_snapshot", no_record)
    monkeypatch.setattr(service_module, "time", _Clock())
    for _ in range(31):
        svc.revoke(a, s)
    assert tails == [1.0, 3.0, 7.0, 15.0, 31.0]                # 5 attempts in 31 writes, each after the tail doubled
    assert [r["op"] for r in _records(svc)] == ["revoke"] * 31 # the log stays whole and writes go on
    assert "compaction did not finish" in caplog.text


def test_a_log_an_older_release_glued_after_a_crash_is_refused_and_starts_whole_once_repaired_as_told(
        tmp_path, names, no_auto_compaction):
    # #82's head skipped a torn last line but left it in the file, so the next record was appended onto it.
    s, (a, b, c) = names.swarms[0], names.agents
    grant = lambda agent: (json.dumps({"op": "grant", "agent_id": agent, "swarm_id": s}) + "\n").encode()
    folder = tmp_path / "spaces"
    folder.mkdir()
    log_path = folder / "spaces.log.jsonl"
    log_path.write_bytes(grant(a) + b'{"op": "grant", "agent_id": "' + grant(b) + grant(c))
    probe = SpaceService(tmp_path / "probe")
    with pytest.raises(SpaceError) as caught:
        _restart(probe, names, folder)
    message = str(caught.value)
    assert "line 2" in message and "whole record glued after it" in message
    start, end = map(int, re.search(r"\(bytes (\d+) to (\d+) of the file\)", message).groups())
    data = log_path.read_bytes()
    log_path.write_bytes(data[:start] + data[end + 1:])        # delete what it names, and nothing else
    svc = _restart(probe, names, folder)
    assert all(svc.is_member(agent, s) for agent in (a, b, c))
