"""The Ask conductor's browser-side memory, host piece (the owner, 2026-10-07: "keep the memory local on the browser side and
put cloud hosted memory coming soon"). The host stores nothing about the person: the `remember` tool only emits a live,
asker-only `memory` frame for the browser to keep; recall comes back as the per-turn memory_notes.

Scripted fake model only: no network and no paid calls.
"""
import json
import logging
import pathlib

import pytest

from hive.core import conductor as cmod
from hive.core.visibility import Viewer
from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, call, closed, dump, frames, on, script, tool_results, wait  # noqa: F401
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

CANARY = "QZXMEMCANARY prefers the plum look"


@pytest.fixture()
def mem(on, monkeypatch):  # noqa: F811
    monkeypatch.setenv("HIVE_ASK_MEMORY", "on")
    return on


def live(hive, monkeypatch):
    """Every frame Ask publishes live (what the asker's socket would get), in order."""
    out, publish = [], hive.ask._publish

    def capture(fs):
        out.extend(json.loads(json.dumps(f)) for f in fs if f)
        return publish(fs)
    monkeypatch.setattr(hive.ask, "_publish", capture)
    return out


def memory_frames(fs):
    return [f for f in fs if f["phase"] == "memory"]


def files_text(hive):
    """Every byte under the hive's data dir (database, WAL, spaces log, anything else)."""
    root = pathlib.Path(hive.settings.data_dir)
    return b"\n".join(p.read_bytes() for p in root.rglob("*") if p.is_file())


# ---- off by default -------------------------------------------------------------------------------------------------------

def test_memory_is_off_by_default_no_tool_and_a_call_is_unknown(client, on, monkeypatch):
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    hive = on["hive"]
    pub = live(hive, monkeypatch)
    s = script(client, Script([call("remember", statement=CANARY, kind="preference")], "ok"))
    ask(client, on["ann"], "op-mem-off1", context=on["ctx"])
    fs = wait(hive, "op-mem-off1", closed)
    assert s.bodies[0]["tools"] == cmod.TOOLS and "remember" not in json.dumps(s.bodies[0]["tools"])
    assert "remember" not in s.bodies[0]["messages"][0]["content"][0]["text"]
    assert tool_results(s.bodies[1])[0] == {"ok": False, "reason": "unknown_tool"}
    assert memory_frames(fs) == [] and memory_frames(pub) == []
    for value in ("1", "true", "yes", ""):   # only the literal "on" turns it on
        monkeypatch.setenv("HIVE_ASK_MEMORY", value)
        assert cmod.memory_enabled() is False
    monkeypatch.setenv("HIVE_ASK_MEMORY", "on")
    assert cmod.memory_enabled() is True


def test_memory_on_without_the_conductor_changes_nothing(client, monkeypatch):  # noqa: F811
    from hive.tests.test_ask import world
    monkeypatch.setenv("HIVE_ASK_MEMORY", "on")
    w = world(client)
    r = ask(client, w["ann"], "op-mem-noc1", context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202 and r.json()["state"] == "accepted" and "conductor" not in r.json()
    assert client.get("/api/me/ask", headers=w["ann"]).json()["capabilities"] == {"conductor": False, "memory": False}


# ---- notes are accepted and ignored while off; the on/off signal ----------------------------------------------------------

NOTES = ["QZXNOTECANARY likes the plum look", {"id": "n_1", "text": "QZXNOTECANARY calls goals the board"}]


def test_notes_are_accepted_and_ignored_with_the_conductor_off(client, monkeypatch, caplog):  # noqa: F811
    from hive.tests.test_ask import world
    caplog.set_level(logging.DEBUG)
    for value in ("on", ""):
        monkeypatch.setenv("HIVE_ASK_MEMORY", value)
        w = world(client) if value == "on" else w
        op = f"op-mem-ign{'1' if value else '2'}"
        r = ask(client, w["ann"], op, context={"swarm_id": w["swarm"]["id"]}, memory_notes=NOTES)
        assert r.status_code == 202 and r.json()["state"] == "accepted", r.json()
        client.post(f"/api/ask/{op}/stop", headers=w["ann"])
        # the coordinator's delivery carries none of it, nothing stores it, nothing logs it
        assert "QZXNOTECANARY" not in dump(w["hive"]) and b"QZXNOTECANARY" not in files_text(w["hive"])
        assert "QZXNOTECANARY" not in caplog.text and "memory notes" not in caplog.text
        # the shape is still checked
        bad = ask(client, w["ann"], op + "b", context={"swarm_id": w["swarm"]["id"]}, memory_notes=[{"id": "a b", "text": "x"}])
        assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid"


def test_notes_are_accepted_and_ignored_with_memory_off(client, on, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    hive = on["hive"]
    s = script(client, Script("ok"))
    r = ask(client, on["ann"], "op-mem-ign3", context=on["ctx"], memory_notes=NOTES)
    assert r.status_code == 202
    wait(hive, "op-mem-ign3", closed)
    assert "QZXNOTECANARY" not in json.dumps(s.bodies) and "n_1" not in json.dumps(s.bodies)
    assert "QZXNOTECANARY" not in dump(hive) and b"QZXNOTECANARY" not in files_text(hive)
    assert "QZXNOTECANARY" not in caplog.text and "memory notes" not in caplog.text
    for bad in (["n"] * 21, [""], "a string", [3], [{"id": "x", "text": "y", "z": 1}]):
        r = ask(client, on["ann"], f"op-mem-ignb{len(str(bad)):03d}", context=on["ctx"], memory_notes=bad)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", bad


def test_the_on_off_signal_on_get_me_ask(client, on, monkeypatch):
    monkeypatch.delenv("HIVE_ASK_MEMORY", raising=False)
    for who in ("ann", "bob", "quinn"):
        caps = client.get("/api/me/ask", headers=on[who]).json()["capabilities"]
        assert caps == {"conductor": True, "memory": False}
    monkeypatch.setenv("HIVE_ASK_MEMORY", "on")
    assert client.get("/api/me/ask", headers=on["ann"]).json()["capabilities"] == {"conductor": True, "memory": True}
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    assert client.get("/api/me/ask", headers=on["ann"]).json()["capabilities"] == {"conductor": False, "memory": False}
    # signed-in people only: the operator password is not a person
    assert client.get("/api/me/ask").status_code == 403


# ---- the memory frame: live with the item, stored without it, nothing about the person on the host -------------------------

def test_remember_emits_a_live_frame_and_stores_nothing_about_the_person(client, mem, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    hive = mem["hive"]
    pub = live(hive, monkeypatch)
    s = script(client, Script([call("remember", statement=CANARY, kind="preference", confidence=0.7)], "Noted."))
    r = ask(client, mem["ann"], "op-mem-rem1", text="make it look nice", context=mem["ctx"])
    assert r.status_code == 202
    fs = wait(hive, "op-mem-rem1", closed)
    assert "remember" in json.dumps(s.bodies[0]["tools"]) and s.bodies[0]["tools"][-1] == cmod.REMEMBER_TOOL
    # live: the item, for the browser to keep
    [m] = memory_frames(pub)
    item = {"statement": CANARY, "kind": "preference", "truth": {"frequency": 1.0, "confidence": 0.7}}
    assert m["op"] == "remember" and m["item"] == item and m["target_id"] is None
    assert m["turn_id"] == r.json()["turn_id"] and m["principal"] == "user:u_ann" and m["digest"] == cmod.memory_digest({**item, "target_id": None})
    # stored (the recovery read and the admins' audit): op and digest only, in the turn's sequence
    [stored] = memory_frames(fs)
    assert stored["seq"] == m["seq"] and stored["op"] == "remember" and stored["digest"] == m["digest"]
    assert "item" not in stored and "target_id" not in stored
    rec = client.get("/api/ask/op-mem-rem1", headers=mem["ann"]).json()
    assert [e for e in rec["events"] if e["phase"] == "memory"][0].get("item") is None
    # the model was told it went to the browser
    assert tool_results(s.bodies[1])[0] == {"ok": True, "op": "remember", "target_id": None, "truth": item["truth"]}
    # nothing about the person anywhere on the host: every table, every file in the data dir, the log
    assert "QZXMEMCANARY" not in dump(hive)
    on_disk = files_text(hive)
    assert b"op-mem-rem1" in on_disk and b"make it look nice" in on_disk   # the scan does reach the stored turn
    assert b"QZXMEMCANARY" not in on_disk
    assert "QZXMEMCANARY" not in caplog.text and "plum" not in caplog.text
    assert "1 memory frames" in caplog.text and cmod.notes_digest([m["digest"]]) in caplog.text   # a count and a digest
    # no memory routes on the host
    for method, path in (("get", "/api/me/ask/memory"), ("patch", "/api/me/ask/memory/mb_1"), ("delete", "/api/me/ask/memory")):
        assert getattr(client, method)(path, headers=mem["ann"]).status_code in (404, 405)


def test_memory_frames_go_to_the_asker_only_admins_included(client, mem, monkeypatch):
    hive = mem["hive"]
    pub = live(hive, monkeypatch)
    script(client, Script([call("remember", statement=CANARY, kind="name")], "ok"))
    ask(client, mem["ann"], "op-mem-who1", context=mem["ctx"])
    wait(hive, "op-mem-who1", closed)
    [m] = memory_frames(pub)
    text = json.dumps(dict(type="ask", at="now", **{k: v for k, v in m.items() if k != "at"}))
    assert hive.visibility.event_visible(Viewer("user:u_ann", False), text) is True
    assert hive.visibility.event_visible(Viewer("user:u_bob", False), text) is False
    assert hive.visibility.event_visible(Viewer("user:u_quinn", True), text) is False


def test_a_correction_kind_without_revises_is_a_remember(client, mem, monkeypatch):
    pub = live(mem["hive"], monkeypatch)
    script(client, Script([call("remember", statement="calls goals the board", kind="correction")], "ok"))
    ask(client, mem["ann"], "op-mem-cor1", context=mem["ctx"])
    wait(mem["hive"], "op-mem-cor1", closed)
    [m] = memory_frames(pub)
    assert m["op"] == "remember" and m["target_id"] is None and m["item"]["kind"] == "correction"


# ---- ids for revise -----------------------------------------------------------------------------------------------------

def test_revises_names_only_this_turns_note_ids(client, mem, monkeypatch):
    hive = mem["hive"]
    pub = live(hive, monkeypatch)
    notes = [{"id": "n_dark", "text": "prefers the dark look"}, "calls goals the board", {"id": "n-2", "text": "works on Lumen"}]
    s = script(client, Script([call("remember", statement="prefers the light look", kind="correction", revises="n_dark"),
                               call("remember", statement="works on Lumen and Tide", kind="project", revises="n_other"),
                               call("remember", statement="lives in Leeds", kind="place", revises=7)], "ok"))
    assert ask(client, mem["ann"], "op-mem-rev1", context=mem["ctx"], memory_notes=notes).status_code == 202
    wait(hive, "op-mem-rev1", closed)
    context = s.bodies[0]["messages"][1]["content"]
    assert "- [n_dark] prefers the dark look" in context and "- calls goals the board" in context and "- [n-2] works on Lumen" in context
    a, b, c = memory_frames(pub)
    assert a["op"] == "revise" and a["target_id"] == "n_dark" and a["item"]["statement"] == "prefers the light look"
    assert b["op"] == "remember" and b["target_id"] is None   # an id that was not among this turn's notes is dropped
    assert c["op"] == "remember" and c["target_id"] is None
    # the next turn has no notes: the same id no longer revises
    pub.clear()
    script(client, Script([call("remember", statement="prefers grey", kind="correction", revises="n_dark")], "ok"))
    ask(client, mem["ann"], "op-mem-rev2", context=mem["ctx"])
    wait(hive, "op-mem-rev2", closed)
    assert memory_frames(pub)[0]["target_id"] is None and memory_frames(pub)[0]["op"] == "remember"
    assert "dark look" not in dump(hive) and "n_dark" not in dump(hive)


def test_note_shapes_and_caps(client, mem):
    ok = [{"id": "a", "text": "one"}, "two", {"id": "B_9-z", "text": "three"}]
    assert cmod.check_notes(ok) and cmod.check_notes(["x"] * 20) and cmod.check_notes([{"id": "i" * 64, "text": "t"}])
    bad = ([{"id": "a", "text": "x"}, {"id": "a", "text": "y"}],      # duplicate ids
           [{"id": "a b", "text": "x"}], [{"id": "", "text": "x"}], [{"id": "i" * 65, "text": "x"}],
           [{"id": "a", "text": ""}], [{"id": "a"}], [{"id": "a", "text": "x", "extra": 1}], [{"id": 3, "text": "x"}],
           [{"id": "a", "text": "x"}] * 1 + ["y"] * 20,                 # 21 entries
           [{"id": "a", "text": "x" * 5000}, {"id": "b", "text": "y" * 3200}])   # over 8 KB with the ids
    for i, b in enumerate(bad):
        assert not cmod.check_notes(b), b
        r = ask(client, mem["ann"], f"op-mem-shape{i:02d}", context=mem["ctx"], memory_notes=b)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", b


# ---- fences and caps -------------------------------------------------------------------------------------------------------

def test_the_private_app_fence_on_statements_and_notes(client, mem, monkeypatch):
    hive = mem["hive"]
    pub = live(hive, monkeypatch)
    notes = [{"id": "n_atlas", "text": "sleep score"}, {"id": "n_ok", "text": "OmegaTruth record"}, {"id": "n_fine", "text": "likes tea"}]
    s = script(client, Script([call("remember", statement="her Atlas sleep score is 7", kind="preference"),
                               call("remember", statement="uses %61tlas daily", kind="place"),
                               call("remember", statement="TRUTH archive", kind="project"),
                               call("remember", statement="likes green tea", kind="preference", revises="n_atlas")], "ok"))
    ask(client, mem["ann"], "op-mem-fence", context=mem["ctx"], memory_notes=notes)
    wait(hive, "op-mem-fence", closed)
    results = tool_results(s.bodies[1])
    assert [r.get("reason") for r in results[:3]] == ["private", "private", "private"]
    [m] = memory_frames(pub)   # only the fourth: and its revises named a fenced note, so it is dropped
    assert m["item"]["statement"] == "likes green tea" and m["target_id"] is None and m["op"] == "remember"
    context = s.bodies[0]["messages"][1]["content"]
    assert "n_atlas" not in context and "OmegaTruth" not in context and "[n_fine] likes tea" in context


def test_at_most_eight_memory_frames_a_turn_and_each_counts_as_an_act(client, mem, monkeypatch):
    hive = mem["hive"]
    pub = live(hive, monkeypatch)
    calls = [call("remember", statement=f"fact number {i}", kind="preference") for i in range(10)]
    for i, c in enumerate(calls):
        c["id"] = f"call_rem_{i}"
    s = script(client, Script(calls, "ok"))
    ask(client, mem["ann"], "op-mem-cap1", context=mem["ctx"])
    fs = wait(hive, "op-mem-cap1", closed)
    assert len(memory_frames(pub)) == len(memory_frames(fs)) == cmod.MAX_REMEMBER == 8
    results = tool_results(s.bodies[1])
    assert [r["ok"] for r in results] == [True] * 8 + [False] * 2 and results[8] == {"ok": False, "reason": "memory_cap"}
    assert results[9]["reason"] == "memory_cap"
    # every call counts against the act cap: 30 more says reach it at 32 in all
    pub.clear()
    many = [call("remember", statement=f"thing {i}", kind="name") for i in range(4)] + [call("say", text=f"s{i}") for i in range(30)]
    for i, c in enumerate(many):
        c["id"] = f"call_mix_{i}"
    script(client, Script(many, "never"))
    ask(client, mem["ann"], "op-mem-cap2", context=mem["ctx"])
    fs = wait(hive, "op-mem-cap2", closed)
    assert fs[-1]["outcome"] == "act_cap" and len(memory_frames(fs)) == 4
    assert len([f for f in fs if f["phase"] == "answer" and f.get("delta")]) == cmod.MAX_ACTS - 4


def test_under_quota_pressure_a_memory_frame_is_not_sent_and_answer_done_still_fit(client, mem, monkeypatch):
    from hive.core import ask as amod
    monkeypatch.setattr(amod, "MAX_EVENTS", 6)
    hive = mem["hive"]
    pub = live(hive, monkeypatch)
    calls = [call("remember", statement=f"fact {i}", kind="preference") for i in range(6)]
    for i, c in enumerate(calls):
        c["id"] = f"call_q_{i}"
    s = script(client, Script(calls, "final"))
    ask(client, mem["ann"], "op-mem-quota", context=mem["ctx"])
    fs = wait(hive, "op-mem-quota", closed)
    assert [f["seq"] for f in fs] == list(range(1, 7))
    assert len(memory_frames(fs)) == 3 == len(memory_frames(pub))   # seq 2..4; 5 and 6 are the reserve
    results = tool_results(s.bodies[1])
    assert [r["ok"] for r in results] == [True] * 3 + [False] * 3 and {r["reason"] for r in results[3:]} == {"not_sent"}
    assert fs[-2]["phase"] == "answer" and "delta" not in fs[-2] and fs[-1]["phase"] == "done" and fs[-1]["outcome"] == "complete"


def test_invalid_remember_calls(client, mem, monkeypatch):
    pub = live(mem["hive"], monkeypatch)
    bad = [dict(statement="", kind="name"), dict(statement="x", kind="mood"), dict(statement="x" * 501, kind="name"),
           dict(statement="x", kind="name", confidence=1.5), dict(statement="x", kind="name", confidence=True),
           dict(statement="x", kind="name", extra=1), dict(kind="name")]
    calls = [call("remember", **b) for b in bad]
    for i, c in enumerate(calls):
        c["id"] = f"call_bad_{i}"
    s = script(client, Script(calls, "ok"))
    ask(client, mem["ann"], "op-mem-inv1", context=mem["ctx"])
    wait(mem["hive"], "op-mem-inv1", closed)
    assert tool_results(s.bodies[1]) == [{"ok": False, "reason": "invalid"}] * len(bad)
    assert memory_frames(pub) == []
    item = cmod.check_remember({"statement": "  a   b ", "kind": "name", "confidence": 0})
    assert item == {"statement": "a b", "kind": "name", "truth": {"frequency": 1.0, "confidence": 0.01}}


# ---- thread deletion -------------------------------------------------------------------------------------------------------

def test_thread_deletion_blanks_memory_frames(client, mem):
    hive = mem["hive"]
    script(client, Script([call("remember", statement=CANARY, kind="preference")], "ok"))
    r = ask(client, mem["ann"], "op-mem-del1", context=mem["ctx"]).json()
    fs = wait(hive, "op-mem-del1", closed)
    digest = memory_frames(fs)[0]["digest"]
    assert digest
    assert client.delete(f"/api/ask/threads/{r['thread']['id']}", headers=mem["ann"]).status_code == 200
    [m] = memory_frames(frames(hive, "op-mem-del1"))
    assert m["op"] == "" and m["digest"] == "" and "item" not in m
    assert digest not in dump(hive)
