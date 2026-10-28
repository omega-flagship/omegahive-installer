"""Personal minds P2 r4: the stand-in's two High findings on r3 (ccbaeec), each through the real Ask path.

1. A personal mind's turn written before r3 (personal = 0, its words, context, frames, room and hub messages, steers
   and intents kept as any turn's) is found by its mind at startup, marked, and its content erased: nothing survives in
   any file under the data directory, and no read by another admin returns it.
2. A personal turn's stored frames keep an allowlist of content-free metadata only: a marker in every act field a model
   can author (routes, features, targets, regions, entities, prefs, captions, labels, fill text, scripts) and in every
   say is in the person's live frames and nowhere on the host.
"""
import json
import random
import string

from hive.core.ask import Ask
from hive.tests.test_ask_conductor import Script, call, closed, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_personal_mind_r3 import _live, _markers, _on, _personal_turn, _scan


def _letters(n=12):
    return "".join(random.choice(string.ascii_lowercase) for _ in range(n))


def _reads(client, w, turn_id, room):
    quinn = w["quinn"]
    return [client.get("/api/ask/audit", headers=quinn), client.get("/api/ask/audit", headers=quinn, params={"principal": "user:u_ann"}),
            client.get(f"/api/ask/audit/{turn_id}", headers=quinn), client.get(f"/api/rooms/{room}/messages", headers=quinn),
            client.get(f"/api/ask/audit/{turn_id}")]


def test_an_r2_era_personal_turn_is_marked_and_erased_at_startup(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive, m = w["hive"], _markers()
    body, _s = _personal_turn(client, w, m, "op-r4-legacy-01")
    tid, mine = body["turn_id"], w["mine"]
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (body["thread"]["id"],))["room_id"]
    old = {k: "R2" + k.upper() + _letters() for k in ("question", "context", "answer", "route", "room", "hub", "steer", "intent")}
    # the turn as P1+P2 r2 wrote it: personal = 0 and its content kept as any turn's (ask.py r2 _admit / _frame / reply)
    hive.db.execute("UPDATE ask_turns SET personal = 0, text = ?, context_resolved = ? WHERE id = ?",
                    (old["question"], json.dumps({"route": f"notes/{old['context']}", "swarm": {"id": mine["swarm_id"], "name": "x"}}), tid))
    seq = hive.db.one("SELECT MAX(seq) AS n FROM ask_events WHERE turn_id = ?", (tid,))["n"]
    for i, frame in enumerate(({"phase": "answer", "text": old["answer"], "delta": True},
                               {"phase": "act", "act": {"act_id": "ac_r2", "kind": "navigate", "route": f"#/notes/{old['route']}"}})):
        hive.db.execute("INSERT INTO ask_events VALUES (?, ?, ?, ?)",
                        (tid, seq + 1 + i, "user:u_ann", json.dumps({"operation_id": "op-r4-legacy-01", "turn_id": tid,
                                                                     "principal": "user:u_ann", "seq": seq + 1 + i, **frame})))
    hive.rooms._append(room, "user:u_ann", old["room"], [], 0)
    hive.enqueue_message(mine["id"], old["hub"], f"ask:{tid}", "user:u_ann", {})
    hive.db.insert("ask_steers", {"principal": "user:u_ann", "steer_id": "st-r4-legacy", "turn_id": tid, "body_digest": "d",
                                  "text": old["steer"], "via": "typed", "at_seq": 1, "seq": None, "room_message_id": "",
                                  "delivery_message_id": "", "created_at": "2026-10-08T00:00:00.000Z", "outcome": "new_turn",
                                  "new_operation_id": "steer:st-r4-legacy"})
    hive.db.insert("ask_intents", {"id": "ai_r4legacy", "turn_id": tid, "principal": "user:u_ann", "kind": "code.request",
                                   "request_operation_id": "ask.ai_r4legacy", "body": json.dumps({"title": old["intent"]}),
                                   "request_digest": "d", "destination": "{}", "instruction_digest": "d", "state": "pending",
                                   "created_at": "2026-10-08T00:00:00.000Z", "updated_at": "2026-10-08T00:00:00.000Z",
                                   "expires_at": "2026-10-09T00:00:00.000Z"})
    hive.db.truncate_wal()
    assert set(_scan(hive, old.values())) == set(old.values())          # the seed is real: every marker is on disk
    # the startup migration (Ask.__init__ -> retire_legacy_personal), as a restart runs it
    Ask(hive)
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (tid,))
    assert t["personal"] == 1 and t["text"] == "" and t["context_resolved"] == "{}"
    assert hive.db.all("SELECT * FROM room_messages WHERE room_id = ?", (room,)) == []
    assert hive.db.one("SELECT body FROM ask_intents WHERE id = 'ai_r4legacy'")["body"] == "{}"
    assert _scan(hive, [*old.values(), *m.values()]) == {}
    for r in _reads(client, w, tid, room):
        assert r.status_code == 200 and not [n for n in [*old.values(), *m.values()] if n in r.text], r.request.url
    assert Ask(hive).retire_legacy_personal() == 0                        # idempotent: nothing left to retire


def test_an_unmarked_personal_turn_is_fenced_on_read_before_any_migration(client, monkeypatch):
    """Belt and braces: a row the mark has not reached reads as personal by its mind, for every reader."""
    w = _on(client, monkeypatch)
    hive, m = w["hive"], _markers()
    body, _s = _personal_turn(client, w, m, "op-r4-fence-001")
    leak = "UNMARKED" + _letters()
    hive.db.execute("UPDATE ask_turns SET personal = 0, text = ? WHERE id = ?", (leak, body["turn_id"]))
    hive.db.execute("UPDATE ask_events SET frame = json_set(frame, '$.text', ?) WHERE turn_id = ?", (leak, body["turn_id"]))
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (body["thread"]["id"],))["room_id"]
    for r in [*_reads(client, w, body["turn_id"], room), client.get("/api/ask/op-r4-fence-001", headers=w["ann"])]:
        assert r.status_code == 200 and leak not in r.text, r.request.url


def test_every_act_field_a_model_can_author_stays_out_of_the_host(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    k = "pmk" + _letters()   # letters only: it passes every act field's own shape (features are [a-z]+.[a-z]+)
    acts = [call("say", text=f"say {k}"),
            call("navigate", route=f"#/notes/{k}?q={k}", label=f"label {k}"),
            call("open", feature=f"notes/{k}", entity={"kind": "item", "ref": k}, label=f"open {k}"),
            call("look", prefs={"variant": k, "layout": k, "experience": k, "density": k}),
            call("point", target={"feature": f"notes.{k}", "region": k, "entity": {"kind": "goal", "ref": k}}, caption=f"cap {k}"),
            call("highlight", target={"region": k}, caption=f"hl {k}", label=f"hl {k}"),
            call("fill", field=k, text=f"fill {k}"),
            call("scroll", target={"region": k}, to="bottom"),
            call("tour_step", script=k, step=1)]
    s = script(client, Script(acts, f"final {k}", cost=0.001))
    hive.ask.conductor.result_timeout = 0.05
    live = _live(hive)
    r = client.post("/api/ask", headers=w["ann"], json={"operation_id": "op-r4-acts-001", "text": "show me"})
    assert r.status_code == 202 and r.json()["acting_as"]["mind_id"] == w["mine"]["id"], r.text
    wait(hive, "op-r4-acts-001", closed)
    results = [json.loads(x["content"]) for x in s.bodies[1]["messages"] if x.get("role") == "tool"]
    assert len(results) == len(acts) and all(x.get("reason") not in ("invalid", "unknown_tool") for x in results), \
        [(a["function"]["name"], x) for a, x in zip(acts, results) if x.get("reason") in ("invalid", "unknown_tool")]
    published = [f for f in live if f["phase"] == "act"]
    assert len(published) == len(acts) - 1 and all(k in json.dumps(f) for f in published)   # the person saw every act
    hive.db.truncate_wal()
    assert _scan(hive, [k]) == {}
    stored = [json.loads(x["frame"]) for x in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (r.json()["turn_id"],))]
    assert {tuple(sorted(f["act"])) for f in stored if f["phase"] == "act"} == {("act_id", "kind")}
    room = hive.db.one("SELECT room_id FROM work_sessions WHERE id = ?", (r.json()["thread"]["id"],))["room_id"]
    for resp in [*_reads(client, w, r.json()["turn_id"], room), client.get("/api/ask/op-r4-acts-001", headers=w["ann"])]:
        assert resp.status_code == 200 and k not in resp.text, resp.request.url


def test_content_free_is_an_allowlist():
    frame = {"operation_id": "op", "turn_id": "at_1", "principal": "user:u_ann", "seq": 3, "phase": "act", "at": "t",
             "act": {"act_id": "ac_1", "kind": "navigate", "route": "#/x", "nested": {"a": 1}},
             "thread": {"id": "se_1", "mind": {"id": "a_1", "name": "Ann"}, "budget_usd": 1, "spent_usd": 0, "addressed": {"name": "x"}},
             "acting_as": {"mind_id": "a_1", "name": "Ann"}, "say": "host words", "text": "t", "label": "l", "anything": "x",
             "outcome": "complete", "refs": [{"id": "x"}], "digest": "abc"}
    assert Ask.content_free(frame) == {
        "operation_id": "op", "turn_id": "at_1", "principal": "user:u_ann", "seq": 3, "phase": "act", "at": "t",
        "act": {"act_id": "ac_1", "kind": "navigate"},
        "thread": {"id": "se_1", "mind": {"id": "a_1"}, "budget_usd": 1, "spent_usd": 0},
        "acting_as": {"mind_id": "a_1"}, "outcome": "complete", "digest": "abc", "personal": True}
