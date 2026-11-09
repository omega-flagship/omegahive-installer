"""Personal minds P2 r3: a personal mind's Ask turn keeps no content on the host (stand-in BLOCKING on P1+P2 r2).

Jon 2026-10-08: personal-mind memory and history live in the person's browser only; the hive keeps identity, routing,
billing and version (and held swarm copies until the browser collects them). These tests drive the real Ask path:
POST /api/ask admits a personal-mind turn and the conductor completes it against a scripted model (no network). Then:
- every file under the hive's data directory (hive.db and its WAL, personal_inbox.db, logs, JSONL archives) and every
  log record is scanned for the question, the page context and the answer: zero hits;
- the admin audit, the audit of one turn, event pages and the thread's room history, read by an admin who is a
  different person, return none of it (and the person's own reads return nothing durable either);
- the live frames to the person still carried the words, and the model still got the question (held in memory).
"""
import json
import logging
import secrets

from hive.core.config import Provider
from hive.core.db import now
from hive.tests.test_ask import ask, world
from hive.tests.test_ask_conductor import Script, call, closed, script, tool_results, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def _on(client, monkeypatch):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    w = world(client)
    hive = w["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    w["mine"] = hive.personal.ensure("user:u_ann")
    return w


def _markers():
    tag = secrets.token_hex(6)
    return {"question": f"QUESTIONMARK{tag}", "context": f"ctxmark{tag}", "said": f"SAIDMARK{tag}",
            "answer": f"ANSWERMARK{tag}", "fill": f"FILLMARK{tag}", "caption": f"CAPMARK{tag}"}


def _scan(hive, needles):
    """{needle: [files that hold it]} over every file under the hive's data directory (databases, WAL, logs, JSONL)."""
    hits = {}
    for path in sorted(p for p in hive.settings.data_dir.rglob("*") if p.is_file()):
        data = path.read_bytes()
        for n in needles:
            if n.encode() in data:
                hits.setdefault(n, []).append(str(path.relative_to(hive.settings.data_dir)))
    return hits


def _live(hive):
    """Every frame published live (what the person's own connection receives), in order."""
    seen, publish = [], hive.ask._publish
    hive.ask._publish = lambda frames: (seen.extend(f for f in frames if f), publish(frames))
    return seen


def _personal_turn(client, w, m, op):
    hive = w["hive"]
    s = script(client, Script([call("say", text=m["said"]),
                               call("highlight", target={"region": "list"}, caption=m["caption"])],
                              m["answer"], cost=0.001))
    hive.ask.conductor.result_timeout = 0.2   # the highlight's result never comes: no_result, and the turn goes on
    r = ask(client, w["ann"], op, text=f"please remember {m['question']}",
            context={"route": f"#/notes/{m['context']}", "experience": "classic"})
    assert r.status_code == 202, r.text
    assert r.json()["acting_as"] == {"mind_id": w["mine"]["id"], "name": w["mine"]["name"]}
    wait(hive, op, closed)
    return r.json(), s


def test_a_personal_turn_leaves_no_question_context_or_answer_in_any_hive_file_or_log(client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    w = _on(client, monkeypatch)
    hive, m = w["hive"], _markers()
    live = _live(hive)
    body, s = _personal_turn(client, w, m, "op-r3-scan-001")
    # the model got the question and the page context (held in memory for the turn) ...
    sent = json.dumps(s.bodies)
    assert m["question"] in sent and m["context"] in sent
    # ... and the person's live frames carried the words as usual
    said = json.dumps(live)
    assert m["said"] in said and m["answer"] in said and m["caption"] in said
    assert [f["phase"] for f in live][-1] == "done" and live[-1]["outcome"] == "complete"
    # nothing durable: no file under the data directory, and no log record, holds any of it
    hive.db.truncate_wal()   # whatever reached the WAL is now in the main file as well; both are scanned regardless
    assert _scan(hive, m.values()) == {}
    assert not [n for n in m.values() if n in caplog.text]
    # the rows that exist are content-free metadata: the turn, its usage, its frames
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (body["turn_id"],))
    assert t["personal"] == 1 and t["text"] == "" and t["context_resolved"] == "{}" and t["room_message_id"] == ""
    assert t["state"] == "done" and t["answer_message_id"] is None and t["body_digest"]
    assert hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (w["mine"]["id"],))
    stored = [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (t["id"],))]
    assert [f["phase"] for f in stored] == [f["phase"] for f in live] and all(f["personal"] for f in stored)
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (t["thread_id"],))["room_id"]
    assert hive.db.all("SELECT * FROM room_messages WHERE room_id = ?", (room,)) == []
    assert hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (w["mine"]["id"],)) == []


def test_an_admin_who_is_another_person_reads_no_personal_turn_content_on_any_route(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive, m = w["hive"], _markers()
    body, _s = _personal_turn(client, w, m, "op-r3-admin-01")
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (body["thread"]["id"],))["room_id"]
    jon = w["jon"]
    reads = {
        "audit": client.get("/api/ask/audit", headers=jon),
        "audit_person": client.get("/api/ask/audit", headers=jon, params={"principal": "user:u_ann"}),
        "audit_turn": client.get(f"/api/ask/audit/{body['turn_id']}", headers=jon),
        "room": client.get(f"/api/rooms/{room}/messages", headers=jon),
        "operator_audit": client.get(f"/api/ask/audit/{body['turn_id']}"),   # the loopback operator (admin) too
    }
    for name, r in reads.items():
        assert r.status_code == 200, (name, r.text)
        assert not [n for n in m.values() if n in r.text], name
    turn = reads["audit_turn"].json()
    # the audit still shows that the turn happened, who asked, who answered and what it cost
    assert turn["principal"] == "user:u_ann" and turn["mind_id"] == w["mine"]["id"] and turn["state"] == "done"
    assert turn["text"] == "" and turn["context"] == {} and turn["acting_as"]["mind_id"] == w["mine"]["id"]
    assert [f["phase"] for f in turn["events"]][-1] == "done" and all(f.get("personal") for f in turn["events"])
    assert reads["room"].json() == []
    # the person's own reads: nothing durable to return, by design
    for r in (client.get("/api/ask/op-r3-admin-01", headers=w["ann"]), client.get("/api/ask", headers=w["ann"]),
              client.get(f"/api/rooms/{room}/messages", headers=w["ann"])):
        assert r.status_code == 200 and not [n for n in m.values() if n in r.text]


def test_content_written_by_an_older_build_is_still_refused_on_every_read(client, monkeypatch):
    """Defence on read: a personal turn row or frame that holds words (as P2 r2 wrote them) returns none of them."""
    w = _on(client, monkeypatch)
    hive, m = w["hive"], _markers()
    body, _s = _personal_turn(client, w, m, "op-r3-legacy-1")
    legacy = "LEGACYMARK" + secrets.token_hex(6)
    hive.db.execute("UPDATE ask_turns SET text = ?, context_resolved = ? WHERE id = ?",
                    (legacy, json.dumps({"route": legacy}), body["turn_id"]))
    hive.db.execute("UPDATE ask_events SET frame = json_set(frame, '$.text', ?) WHERE turn_id = ? AND json_extract(frame, '$.phase') = 'answer'",
                    (legacy, body["turn_id"]))
    for r in (client.get("/api/ask/audit", headers=w["jon"]), client.get(f"/api/ask/audit/{body['turn_id']}", headers=w["jon"]),
              client.get("/api/ask/op-r3-legacy-1", headers=w["ann"])):
        assert r.status_code == 200 and legacy not in r.text


def test_a_steer_on_a_closed_personal_turn_keeps_no_words(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive, m = w["hive"], _markers()
    _personal_turn(client, w, m, "op-r3-steer-01")
    steer = "STEERMARK" + secrets.token_hex(6)
    script(client, Script(f"fine {m['answer']}"))
    r = client.post("/api/ask/op-r3-steer-01/steer", headers=w["ann"], json={"steer_id": "st-r3-0001", "text": steer, "at_seq": 1})
    assert r.status_code in (200, 202), r.text
    assert r.json()["new_turn"] is True
    wait(hive, r.json()["operation_id"], closed)
    fresh = hive.db.one("SELECT * FROM ask_turns WHERE operation_id = ?", (r.json()["operation_id"],))
    assert fresh["personal"] == 1 and fresh["text"] == ""
    assert hive.db.one("SELECT text FROM ask_steers WHERE steer_id = 'st-r3-0001'")["text"] == ""
    hive.db.truncate_wal()
    assert _scan(hive, [steer, *m.values()]) == {}


# a personal turn's dispatch and intents work as any turn's (Jon 2026-10-09): test_personal_ask_control.py


def test_with_the_conductor_off_an_awake_personal_mind_is_never_asked_through_the_hub(client, monkeypatch):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "")
    w = world(client)
    hive = w["hive"]
    mine = hive.personal.ensure("user:u_ann")
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (mine["id"],))
    marker = "HUBMARK" + secrets.token_hex(6)
    before = {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in ("ask_turns", "messages", "room_messages", "ask_events")}
    r = ask(client, w["ann"], "op-r3-hub-0001", text=marker)
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_available", r.text
    assert {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in before} == before
    hive.db.truncate_wal()
    assert _scan(hive, [marker]) == {}


def test_a_swarm_turn_is_unchanged(client, monkeypatch):
    """Only a personal mind's turn is content-free: a swarm coordinator's conductor turn keeps its record as before."""
    w = _on(client, monkeypatch)
    hive = w["hive"]
    hive.db.execute("UPDATE agents SET budget_usd = 5 WHERE id = ?", (w["coord"]["id"],))   # a coordinator with a cap
    script(client, Script("the swarm's answer"))
    r = ask(client, w["ann"], "op-r3-swarm-01", text="for the swarm", context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202 and r.json()["acting_as"] is None
    wait(hive, "op-r3-swarm-01", closed)
    t = hive.db.one("SELECT * FROM ask_turns WHERE operation_id = 'op-r3-swarm-01'")
    assert t["personal"] == 0 and t["text"] == "for the swarm" and t["answer_message_id"]
    audit = client.get(f"/api/ask/audit/{t['id']}", headers=w["jon"]).json()
    assert audit["text"] == "for the swarm" and any(f.get("text") == "the swarm's answer" for f in audit["events"]), [(f["phase"], f.get("text")) for f in audit["events"]]


def test_a_held_swarm_copy_made_by_the_real_ask_path_leaves_its_own_file_clean_once_collected(client):
    """The r2 erasure test, through the real path (Ask admission, the coordinator's reply, the browser's ack) rather than
    hold() directly. Its scope: the held copy's own file. The swarm's Ask thread keeps its record by the Ask's own rules
    (a swarm turn is not a personal mind's), so hive.db still holds the words; a personal turn's are scanned above."""
    from hive.core import personal_inbox as inboxmod
    from hive.tests.test_ask import reply
    w = world(client)
    hive = w["hive"]
    hive.personal.ensure("user:u_ann")
    words, answer = "HELDWORDS" + secrets.token_hex(6), "HELDANSWER" + secrets.token_hex(6)
    r = ask(client, w["ann"], "op-r3-held-001", text=words, context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202, r.text
    reply(hive, w["coord"], r.json()["turn_id"], answer)
    items = client.get("/api/me/mind/inbox", headers=w["ann"]).json()["items"]
    assert [(i["words"], i["answer"]) for i in items] == [(words, answer)]

    def inbox_files():
        d = hive.settings.data_dir
        return b"".join((d / (inboxmod.DB_NAME + s)).read_bytes() for s in ("", "-wal", "-shm", "-journal")
                        if (d / (inboxmod.DB_NAME + s)).exists())
    assert answer.encode() in inbox_files()
    assert client.post("/api/me/mind/inbox/ack", headers=w["ann"], json={"ids": [items[0]["id"]]}).json() == {"deleted": 1}
    assert words.encode() not in inbox_files() and answer.encode() not in inbox_files()
