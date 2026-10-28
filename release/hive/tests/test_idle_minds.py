"""Idle minds (owner 2026-10-10): spend is not input, Health notices and asks ONE question, the answer is recorded,
nothing sleeps a mind on its own, and only an admin or the mind's owner reads the record.

"The hive is supposed to monitor itself right - rather than strict rules for free minds": no threshold here sleeps or
blocks a mind; the only enforcement is idle_sleep_minutes, and only where an owner set it.
"""

import asyncio
import datetime
import json

import pytest

from hive.tests.test_core_api import PETTA, agent_headers, client, make_swarm_and_agents  # noqa: F401 (fixture)
from hive.tests.test_personal_mind import _client, _env, _person

pytestmark = pytest.mark.skipif(not __import__("pathlib").Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


def ago(**delta):
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(**delta)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def awake(hive, agent_id, input_ago=None, **fields):
    """An awake mind whose last input and own action were `input_ago` (a timedelta dict) ago."""
    values = {"status": "awake", **fields}
    if input_ago is not None:
        values.update(last_input_at=ago(**input_ago), last_active_at=ago(**input_ago), created_at=ago(days=3))
    hive.db.update("agents", agent_id, values)


def spend(hive, agent_id, n=3, usd=0.04, minutes_ago=30):
    for i in range(n):
        hive.db.insert("usage", {"agent_id": agent_id, "model": "x", "prompt_tokens": 1, "completion_tokens": 1,
                                 "cost_usd": usd, "created_at": ago(minutes=minutes_ago - i)})


def run(hive):
    return asyncio.run(hive.health.idle.run(force=True))


def health_messages(hive, agent_id):
    return hive.db.all("SELECT * FROM messages WHERE agent_id = ? AND sender = 'hive:health' ORDER BY created_at", (agent_id,))


def test_model_spend_does_not_move_the_input_signal_but_real_input_does(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    awake(hive, a["id"], input_ago={"hours": 5})
    before = hive.db.one("SELECT last_input_at, last_active_at, spent_usd FROM agents WHERE id = ?", (a["id"],))
    for _ in range(3):
        r = client.post("/llm/v1/chat/completions", headers=agent_headers(a),
                        json={"messages": [{"role": "user", "content": "no news"}]})
        assert r.status_code == 200
    assert len(hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (a["id"],))) == 3
    after = hive.db.one("SELECT last_input_at, last_active_at FROM agents WHERE id = ?", (a["id"],))
    assert (after["last_input_at"], after["last_active_at"]) == (before["last_input_at"], before["last_active_at"])
    # an inbound message is real input; it shows on the mind's view
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "hello"})
    view = client.get(f"/api/agents/{a['id']}").json()
    assert view["last_input_at"] > before["last_input_at"]
    # so are a claim and a heartbeat on owed work
    hive.db.update("agents", a["id"], {"last_input_at": ago(hours=5)})
    goal = client.post(f"/api/swarms/{a['swarm_id']}/goals", json={"title": "write it"}).json()
    client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a))
    assert hive.db.one("SELECT last_input_at FROM agents WHERE id = ?", (a["id"],))["last_input_at"] > ago(minutes=1)


def test_health_notices_spend_with_no_input_asks_once_and_is_rate_limited(client):
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    awake(hive, a["id"], input_ago={"hours": 3})
    awake(hive, b["id"], input_ago={"minutes": 5})          # fresh input: not idle
    spend(hive, a["id"], n=4, usd=0.05)
    spend(hive, b["id"], n=4, usd=0.05, minutes_ago=4)
    asked = run(hive)
    assert len(asked) == 1
    msgs = health_messages(hive, a["id"])
    assert len(msgs) == 1 and health_messages(hive, b["id"]) == []
    assert "You've spent $0.20 over 3.0 hours with no input: sleep, or tell me what you're waiting for?" in msgs[0]["text"]
    assert msgs[0]["conversation_id"] == f"c_{a['id']}" and msgs[0]["direction"] == "in"
    # Health's own question is not input: the mind still looks as idle as it was
    assert hive.db.one("SELECT last_input_at FROM agents WHERE id = ?", (a["id"],))["last_input_at"] < ago(hours=2)
    # asked once: further passes while it is open, or later in the same idle stretch, send nothing
    for _ in range(3):
        assert run(hive) == []
    assert len(health_messages(hive, a["id"])) == 1
    q = hive.db.one("SELECT * FROM health_idle WHERE agent_id = ?", (a["id"],))
    hive.db.execute("UPDATE health_idle SET status = 'replied', asked_at = ? WHERE id = ?", (ago(hours=2), q["id"]))
    assert run(hive) == []                                   # still the same stretch (no input since it was asked)
    # input arrives after the question (a new stretch), but Health asked on its own under ASK_QUIET_S ago: quiet
    hive.db.execute("UPDATE agents SET last_input_at = ? WHERE id = ?", (ago(minutes=90), a["id"]))
    spend(hive, a["id"], n=2, minutes_ago=10)
    assert run(hive) == []
    # after ASK_QUIET_S it may ask again, once
    hive.db.execute("UPDATE health_idle SET asked_at = ? WHERE id = ?", (ago(hours=7), q["id"]))
    assert len(run(hive)) == 1 and run(hive) == []
    assert len(health_messages(hive, a["id"])) == 2


def test_owed_goal_and_unanswered_message_come_first(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    goal = client.post(f"/api/swarms/{a['swarm_id']}/goals", json={"title": "Draft the plan"}).json()
    client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(a))
    hive.db.execute("UPDATE goals SET updated_at = ? WHERE id = ?", ("2026-10-10T08:00:00.000Z", goal["id"]))
    client.post(f"/api/agents/{a['id']}/messages", json={"text": "status?"})
    hive.db.execute("UPDATE messages SET created_at = ? WHERE agent_id = ? AND direction = 'in'", (ago(hours=2), a["id"]))
    awake(hive, a["id"], input_ago={"hours": 2})
    view = hive.health.idle.view(hive._agent_row(a["id"]))
    assert view["kind"] == "owed" and [o["type"] for o in view["owed"]] == ["goal", "message"]
    run(hive)
    text = health_messages(hive, a["id"])[0]["text"]
    assert f'You hold task "Draft the plan" ({goal["id"]}) since 2026-10-10 08:00 UTC: finish, hand off or release it?' in text
    assert "(1 more owed.)" in text
    # a fresh heartbeat clears the goal; an answer in the conversation clears the message
    client.post(f"/api/agent/goals/{goal['id']}/heartbeat", headers=agent_headers(a))
    hive.record_agent_message(a["id"], {"text": "on it", "conversation_id": f"c_{a['id']}"})
    assert hive.health.idle.view(hive._agent_row(a["id"]))["owed"] == []


def test_the_minds_reply_is_recorded_and_the_owner_reads_it(client):
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    awake(hive, a["id"], input_ago={"hours": 4})
    spend(hive, a["id"])
    run(hive)
    view = client.get(f"/api/agents/{a['id']}/health/idle").json()
    assert view["status"] == "asked" and view["question"].startswith("You've spent") and view["reply"] is None
    assert view["idle_calls_24h"] == 3 and view["idle_spend_24h"] == pytest.approx(0.12)
    hive.record_agent_message(a["id"], {"text": "waiting for the owner's review of g_1", "conversation_id": f"c_{a['id']}"})
    view = client.get(f"/api/agents/{a['id']}/health/idle").json()
    assert view["status"] == "replied" and view["reply"] == "waiting for the owner's review of g_1" and view["reply_at"]
    assert view["history"][0]["status"] == "replied" and view["history"][0]["question_by"] == "hive:health"
    listed = client.get("/api/health/idle").json()
    item = next(m for m in listed["minds"] if m["id"] == a["id"])
    assert item["reply"] == view["reply"] and item["question_at"] == view["question_at"]
    assert listed["window"] == {"notice_after_s": 3600, "ask_quiet_s": 21600, "counts_over_s": 86400}


def test_nothing_sleeps_a_mind_unless_its_owner_set_idle_sleep(client):
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    awake(hive, a["id"], input_ago={"hours": 30})
    spend(hive, a["id"], n=50, usd=0.5)
    run(hive)
    assert hive.sleep_idle_minds() == {"slept": [], "failed": []}
    assert hive._agent_row(a["id"])["status"] == "awake"
    assert ("stop", a["id"]) not in client.supervisor.calls
    # with the owner's idle_sleep_minutes: recent spend no longer keeps it awake; recent input does
    awake(hive, b["id"], input_ago={"minutes": 30}, idle_sleep_minutes=10)
    spend(hive, b["id"], n=3, minutes_ago=2)
    assert hive.idle_candidates() == [b["id"]]
    client.post(f"/api/agents/{b['id']}/messages", json={"text": "still there?"})
    assert hive.idle_candidates() == []


def test_remind_asks_now_once_per_click(client):
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    awake(hive, a["id"], input_ago={"minutes": 5})           # not noticed: Remind still asks (nothing owed)
    r = client.post(f"/api/agents/{a['id']}/health/remind")
    assert r.status_code == 200 and r.json()["status"] == "asked" and r.json()["question_by"] == "user:operator"
    client.post(f"/api/agents/{a['id']}/health/remind")      # a double click is one question
    assert len(health_messages(hive, a["id"])) == 1
    assert client.post(f"/api/agents/{b['id']}/health/remind").status_code == 409   # never started
    hive.db.update("agents", b["id"], {"status": "asleep"})
    r = client.post(f"/api/agents/{b['id']}/health/remind")
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_awake"         # Health never wakes a mind
    assert health_messages(hive, b["id"]) == [] and hive._agent_row(b["id"])["status"] == "asleep"


def test_only_admins_and_owners_read_idle_records_and_personal_minds_stay_private(monkeypatch):
    app, google, sup, _ = _env(monkeypatch)
    c, admin = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, admin, google, "ana@example.com", "Ana")
        bo, _ = _person(c, admin, google, "bo@example.com", "Bo")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        awake(hive, mind["id"], input_ago={"hours": 3})
        spend(hive, mind["id"])
        asyncio.run(hive.health.idle.run(force=True))
        mine = c.get(f"/omegahive/api/agents/{mind['id']}/health/idle", headers=ana)
        assert mine.status_code == 200 and mine.json()["status"] == "asked" and mine.json()["personal"] is True
        listed = c.get("/omegahive/api/health/idle", headers=ana)
        assert listed.status_code == 200, listed.text
        assert [m["id"] for m in listed.json()["minds"]] == [mind["id"]]
        # Bo: not found, not listed, cannot remind
        assert c.get(f"/omegahive/api/agents/{mind['id']}/health/idle", headers=bo).status_code == 404
        assert c.post(f"/omegahive/api/agents/{mind['id']}/health/remind", headers=bo).status_code == 404
        assert c.get("/omegahive/api/health/idle", headers=bo).json()["minds"] == []
        # an admin (the hive password, on this machine): another person's personal mind is hidden on the list and by
        # id (r2: its record holds the question and answer from its person's own chat); audit (?include=personal) sees it
        assert mind["id"] not in [m["id"] for m in c.get("/api/health/idle", headers=admin).json()["minds"]]
        audit = c.get("/api/health/idle?include=personal", headers=admin).json()["minds"]
        assert mind["id"] in [m["id"] for m in audit]
        assert c.get(f"/api/agents/{mind['id']}/health/idle", headers=admin).status_code == 404
        assert c.get(f"/api/agents/{mind['id']}/health/idle?include=personal", headers=admin).status_code == 200
        # a public mind Bo can see but does not own: its idle record is still owner/admin only
        swarm = c.post("/api/swarms", json={"name": "Open", "visibility": "public"}, headers=admin).json()
        other = c.post("/api/agents", json={"name": "Pub", "swarm_id": swarm["id"], "visibility": "public"},
                       headers=admin).json()
        assert c.get(f"/omegahive/api/agents/{other['id']}", headers=bo).status_code == 200
        assert c.get(f"/omegahive/api/agents/{other['id']}/health/idle", headers=bo).status_code == 404
    finally:
        c.__exit__(None, None, None)


# ---- r2 (stand-in P1; Kimi K1-K8) ---------------------------------------------------------------------------------

def _admin_person(c, admin, google, email, name):
    headers, pid = _person(c, admin, google, email, name)
    c.app.state.hive.db.execute("UPDATE people SET role = 'admin' WHERE id = ?", (pid,))
    return headers, pid


def test_a_personal_minds_health_question_stays_in_its_persons_own_chat(monkeypatch):
    """Stand-in r1 P1: the question to a personal mind, and its answer, go through c_<mind>~<person>, never the
    operator's c_<mind> DM; the room list, the transcript, live events and the idle API keep them from the loopback
    operator and other admins unless they audit; the person sees them."""
    from hive.core.visibility import Viewer
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, cy_id = _admin_person(c, op, google, "cy@example.com", "Cy")      # another admin
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        own = f"c_{mind['id']}~user:{ana_id}"
        awake(hive, mind["id"], input_ago={"hours": 3})
        spend(hive, mind["id"])
        rooms_before = hive.db.all("SELECT id, alias, kind FROM rooms ORDER BY id")
        members_before = hive.db.all("SELECT room_id, member FROM room_members ORDER BY room_id, member")
        posts_before = hive.db.one("SELECT COUNT(*) AS n FROM room_messages")["n"]
        frames, real = [], hive.events.publish

        def capture(kind, /, **payload):
            frames.append(json.dumps(dict(type=kind, at="t", **payload)))
            return real(kind, **payload)

        monkeypatch.setattr(hive.events, "publish", capture)
        assert len(run(hive)) == 1
        q = health_messages(hive, mind["id"])
        assert len(q) == 1 and q[0]["conversation_id"] == own
        hive.record_agent_message(mind["id"], {"text": "synthetic: resting until Ana writes", "conversation_id": own})
        view = hive.health.idle.view(hive._agent_row(mind["id"]))
        assert view["status"] == "replied" and view["reply"] == "synthetic: resting until Ana writes"
        # no room was made or extended: no operator DM, no new seat, no new room post
        assert hive.db.all("SELECT id, alias, kind FROM rooms ORDER BY id") == rooms_before
        assert hive.db.one("SELECT 1 FROM rooms WHERE alias = ?", (f"c_{mind['id']}",)) is None
        assert hive.db.all("SELECT room_id, member FROM room_members ORDER BY room_id, member") == members_before
        assert hive.db.one("SELECT COUNT(*) AS n FROM room_messages")["n"] == posts_before
        for who in (op, cy):
            for path in ("/api/rooms", "/api/rooms?include=personal"):
                listed = json.dumps(c.get(path, headers=who).json())
                assert "HEALTH-QUESTION" not in listed and "resting until Ana writes" not in listed
        # the transcript: the person reads both; the operator and another admin read neither unless they audit
        url = f"/api/agents/{mind['id']}/messages"
        texts = lambda r: [m["text"] for m in r.json()]
        assert any(t.startswith("[HEALTH-QUESTION") for t in texts(c.get(url, headers=ana)))
        assert "synthetic: resting until Ana writes" in texts(c.get(url, headers=ana))
        for who in (op, cy):
            seen = texts(c.get(url, headers=who))
            assert not any("HEALTH-QUESTION" in t for t in seen) and "synthetic: resting until Ana writes" not in seen
            seen = texts(c.get(url + f"?conversation_id={own}", headers=who))
            assert seen == []
            audit = texts(c.get(url + "?include=all", headers=who))
            assert any(t.startswith("[HEALTH-QUESTION") for t in audit) and "synthetic: resting until Ana writes" in audit
        assert c.get(url + "?include=all", headers=ana).status_code == 403
        # live events: the person's frames reach her; not the operator, not another admin
        chat = [f for f in frames if f.startswith('{"type": "message"') and mind["id"] in f]
        assert chat
        for text in chat:
            assert hive.visibility.event_visible(Viewer(f"user:{ana_id}", False), text) is True
            assert hive.visibility.event_visible(Viewer("user:operator", True), text) is False
            assert hive.visibility.event_visible(Viewer(f"user:{cy_id}", True), text) is False
        # the idle API: hidden from both admins without ?include=personal, on the list and by id
        idle = f"/api/agents/{mind['id']}/health/idle"
        for who in (op, cy):
            assert mind["id"] not in [m["id"] for m in c.get("/api/health/idle", headers=who).json()["minds"]]
            assert c.get(idle, headers=who).status_code == 404
            assert c.post(f"/api/agents/{mind['id']}/health/remind", headers=who).status_code == 404
            assert c.get(idle + "?include=personal", headers=who).json()["reply"] == "synthetic: resting until Ana writes"
            r = c.post(f"/api/agents/{mind['id']}/health/remind?include=personal", headers=who)
            assert r.status_code == 403 and r.json()["error"]["code"] == "personal_mind"   # audit is read-only
        assert c.get(idle, headers=ana).json()["reply"] == "synthetic: resting until Ana writes"
        # the person's own Remind goes to her own chat too
        r = c.post(f"/omegahive/api/agents/{mind['id']}/health/remind", headers=ana)
        assert r.status_code == 200 and r.json()["question_by"] == f"user:{ana_id}"
        assert [m["conversation_id"] for m in health_messages(hive, mind["id"])] == [own, own]
        assert hive.db.one("SELECT 1 FROM rooms WHERE alias = ?", (f"c_{mind['id']}",)) is None
    finally:
        c.__exit__(None, None, None)


def test_a_shared_minds_health_question_naming_someone_stays_out_of_other_peoples_transcripts(monkeypatch):
    """Non-personal minds: the question goes to c_<mind> like every hive note (the operator's DM, as today), but its
    text names what is owed (who wrote), so people reading their own chats with the mind never see it there."""
    from hive.core.visibility import Viewer
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        bo, bo_id = _person(c, op, google, "bo@example.com", "Bo")
        swarm = c.post("/api/swarms", json={"name": "Shared", "visibility": "public"}, headers=op).json()
        mind = c.post("/api/agents", json={"name": "Team", "swarm_id": swarm["id"], "visibility": "public"}, headers=op).json()
        sent = c.post(f"/omegahive/api/agents/{mind['id']}/messages", headers=ana, json={"text": "synthetic ana asks"}).json()
        hive.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (ago(hours=2), sent["id"]))
        awake(hive, mind["id"], input_ago={"hours": 2})
        assert len(run(hive)) == 1
        q = health_messages(hive, mind["id"])[0]
        assert q["conversation_id"] == f"c_{mind['id']}" and "Ana wrote to you" in q["text"]
        url = f"/omegahive/api/agents/{mind['id']}/messages"
        for who in (ana, bo):
            assert not any("HEALTH-QUESTION" in m["text"] for m in c.get(url, headers=who).json())
        frame = json.dumps({"type": "message", "message": hive.message_view(q)})
        assert hive.visibility.event_visible(Viewer(f"user:{bo_id}", False), frame) is False
        assert hive.visibility.event_visible(Viewer("user:operator", True), frame) is True    # the operator's own chat
        assert any("HEALTH-QUESTION" in m["text"] for m in c.get(f"/api/agents/{mind['id']}/messages", headers=op).json())
        # other hive notes keep their old rule (test_mind_chat_identity)
        hive.enqueue_message(mind["id"], "[GOAL-NOTE] synthetic system note", None, "hive:goals")
        assert "[GOAL-NOTE] synthetic system note" in [m["text"] for m in c.get(url, headers=bo).json()]
    finally:
        c.__exit__(None, None, None)


def test_hive_housekeeping_is_not_input_but_a_direct_goal_assignment_is(client):
    """Kimi K3: hive:* notes (Health alerts and questions, goal and review notes, schedule wakes, approvals) do not
    move the idle signal; a goal assigned to this mind does."""
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    stamp = lambda: hive.db.one("SELECT last_input_at FROM agents WHERE id = ?", (a["id"],))["last_input_at"]
    hive.db.update("agents", a["id"], {"last_input_at": ago(hours=5)})
    before = stamp()
    for sender, extra in (("hive:health", {"event": "health_alert", "about": b["id"]}),
                          ("hive:goals", {"event": "review_waiting", "goal_id": "g_x"}),
                          ("hive:schedule", {"event": "wake", "wakeup_id": "w_x"}),
                          ("hive:approvals", None), ("hive:shares", {"event": "share", "share_id": "sh_x"})):
        hive.enqueue_message(a["id"], f"synthetic {sender} note", None, sender, extra)
        assert stamp() == before, sender
    open_goal = client.post(f"/api/swarms/{a['swarm_id']}/goals", json={"title": "anyone"}).json()
    hive.enqueue_message(a["id"], "synthetic broadcast", None, "hive:goals", {"event": "goal", "goal_id": open_goal["id"]})
    assert stamp() == before                                  # a goal offered to the swarm is not addressed to it
    mine = client.post(f"/api/swarms/{a['swarm_id']}/goals", json={"title": "yours", "assignee": a["id"]}).json()
    assert hive.db.one("SELECT assignee FROM goals WHERE id = ?", (mine["id"],))["assignee"] == a["id"]
    assert stamp() > ago(minutes=1)                            # the hive's own assignment note counted
    hive.db.update("agents", a["id"], {"last_input_at": ago(hours=5)})
    hive.enqueue_message(a["id"], "synthetic person", None, "user:u_someone")
    assert stamp() > ago(minutes=1)                            # people and minds always count


def test_stamps_are_compared_by_time_not_text(client):
    """Kimi K5/K7: an offset-formatted or microsecond stamp must not invert the idle signal."""
    from hive.core.db import latest_stamp
    from hive.core.health import IdleWatch
    from hive.core.hive import Hive
    # text order says the +02:00 stamp is later; by time it is two hours earlier
    early, late = "2026-10-10T11:00:00.000000+02:00", "2026-10-10T10:00:00.000Z"
    assert latest_stamp(early, late) == late and latest_stamp(late, early) == late
    assert IdleWatch.last_input({"last_input_at": early, "last_active_at": late}) == late
    moment = datetime.datetime(2026, 10, 10, 10, 30, tzinfo=datetime.timezone.utc)
    row = {"status": "awake", "idle_sleep_minutes": 60, "last_input_at": early, "last_active_at": late,
           "created_at": "2026-10-01T00:00:00.000Z"}
    assert Hive._idle(row, moment) is False                    # 30 min since 10:00Z, not 90 min since 09:00Z
    assert Hive._idle(dict(row, last_active_at=None), moment) is True
    # the idle pass with an offset stamp: one hour ago written as +05:00 is still an hour ago
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    zoned = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=10)).astimezone(
        datetime.timezone(datetime.timedelta(hours=5))).isoformat()
    hive.db.update("agents", a["id"], {"status": "awake", "last_input_at": zoned, "last_active_at": None})
    spend(hive, a["id"], minutes_ago=5)
    facts = hive.health.idle.facts(hive._agent_row(a["id"]))
    assert facts["kind"] is None and 0.1 < facts["idle_hours"] < 0.2 and facts["idle_calls_24h"] == 3
    assert run(hive) == []                                      # input 10 minutes ago: nothing to ask


def test_owed_messages_use_the_index_and_are_capped(client):
    """Kimi K6: the owed-message scan has its composite index and reads a bounded number of candidates."""
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    names = {r["name"] for r in hive.db.all("PRAGMA index_list(messages)")}
    assert "messages_agent_dir_conv" in names
    cols = [r["name"] for r in hive.db.all("PRAGMA index_info(messages_agent_dir_conv)")]
    assert cols == ["agent_id", "direction", "conversation_id", "created_at"]
    for i in range(6):
        hive.enqueue_message(a["id"], f"synthetic {i}", f"c_{a['id']}~user:u_p{i}", f"user:u_p{i}")
    hive.db.execute("UPDATE messages SET created_at = ? WHERE agent_id = ?", (ago(hours=2), a["id"]))
    awake(hive, a["id"], input_ago={"hours": 2})
    watch = hive.health.idle
    assert len(watch.owed(hive._agent_row(a["id"]))) == 6
    watch.OWED_MESSAGE_CANDIDATES = 4
    try:
        assert len(watch.owed(hive._agent_row(a["id"]))) == 4
    finally:
        del watch.OWED_MESSAGE_CANDIDATES
    plan = " ".join(str(dict(r)) for r in hive.db.all(
        "EXPLAIN QUERY PLAN SELECT 1 FROM messages o WHERE o.agent_id = ? AND o.direction = 'out' "
        "AND o.conversation_id = ? AND o.created_at >= ?", (a["id"], "c", "t")))
    assert "messages_agent_dir_conv" in plan


def test_a_silent_awake_mind_is_noticed_without_spend_and_asked_once(client):
    """Kimi's sharpest r1 finding: a mind answering only `wait` spends almost nothing, so spend cannot be the only
    signal. Awake with no input and no output for NOTICE_S is noticed and asked the same question, rate-limited the same
    way; nothing sleeps it."""
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    awake(hive, a["id"], input_ago={"hours": 3})                # no usage rows at all
    awake(hive, b["id"], input_ago={"minutes": 20})             # quiet, but not for an hour
    facts = hive.health.idle.facts(hive._agent_row(a["id"]))
    assert facts["kind"] == "silent" and facts["idle_calls_24h"] == 0
    assert hive.health.idle.facts(hive._agent_row(b["id"]))["kind"] is None
    assert len(run(hive)) == 1
    msgs = health_messages(hive, a["id"])
    assert len(msgs) == 1 and health_messages(hive, b["id"]) == []
    assert "You've been awake 3.0 hours with no input and no output: sleep, or tell me what you're waiting for?" in msgs[0]["text"]
    view = client.get(f"/api/agents/{a['id']}/health/idle").json()
    assert view["status"] == "asked" and view["kind"] == "silent" and view["history"][0]["kind"] == "silent"
    for _ in range(3):
        assert run(hive) == []                                  # once per stretch, and while open
    hive.db.execute("UPDATE health_idle SET status = 'resolved' WHERE agent_id = ?", (a["id"],))
    assert run(hive) == []                                      # same stretch (no input since)
    assert hive.sleep_idle_minds() == {"slept": [], "failed": []}
    assert hive._agent_row(a["id"])["status"] == "awake"        # still no automatic sleep


# ---- r2.1 (Kimi r2 sharpest, #2, #4; stand-in r2 P2) ------------------------------------------------------------

def test_another_minds_message_to_a_personal_mind_is_its_persons_alone(monkeypatch):
    """Kimi r2 sharpest: on a personal mind only real hive notes (hive:*) are no one's chat. An agent:* message in its
    person's conversation is theirs: the loopback operator and another admin see it neither in the transcript, nor by
    conversation id, nor in live frames, unless they audit; the person sees it; real hive notes keep their rule."""
    from hive.core.visibility import Viewer
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, cy_id = _admin_person(c, op, google, "cy@example.com", "Cy")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        own = f"c_{mind['id']}~user:{ana_id}"
        peer = hive.enqueue_message(mind["id"], "synthetic peer note for Ana's mind", own, "agent:a_synthpeer")
        note = hive.enqueue_message(mind["id"], "[GOAL-NOTE] synthetic hive note", own, "hive:goals")
        url = f"/api/agents/{mind['id']}/messages"
        texts = lambda r: [m["text"] for m in r.json()]
        mine = texts(c.get(url, headers=ana))
        assert "synthetic peer note for Ana's mind" in mine and note["text"] in mine
        for who in (op, cy):
            for path in (url, url + f"?conversation_id={own}"):
                seen = texts(c.get(path, headers=who))
                assert "synthetic peer note for Ana's mind" not in seen and note["text"] in seen   # hive notes as before
            for audit in ("all", "personal"):
                assert "synthetic peer note for Ana's mind" in texts(c.get(url + f"?include={audit}", headers=who))
            for path in ("/api/rooms", "/api/rooms?include=personal"):
                assert "synthetic peer note" not in json.dumps(c.get(path, headers=who).json())
        frame = lambda m: json.dumps({"type": "message", "message": hive.message_view(hive.db.one(
            "SELECT * FROM messages WHERE id = ?", (m["id"],)))})
        assert hive.visibility.event_visible(Viewer(f"user:{ana_id}", False), frame(peer)) is True
        assert hive.visibility.event_visible(Viewer("user:operator", True), frame(peer)) is False
        assert hive.visibility.event_visible(Viewer(f"user:{cy_id}", True), frame(peer)) is False
        assert hive.chat_visible(f"user:{cy_id}", hive.message_view(hive.db.one(
            "SELECT * FROM messages WHERE id = ?", (peer["id"],)))) is False
        assert hive.chat_visible(f"user:{cy_id}", hive.message_view(hive.db.one(
            "SELECT * FROM messages WHERE id = ?", (note["id"],)))) is None                   # a real hive note
        # a shared (non-personal) mind keeps the old rule: another (real) mind's message is not anyone's chat
        swarm = c.post("/api/swarms", json={"name": "Shared", "visibility": "public"}, headers=op).json()
        team = c.post("/api/agents", json={"name": "Team", "swarm_id": swarm["id"], "visibility": "public"}, headers=op).json()
        other = c.post("/api/agents", json={"name": "Other", "swarm_id": swarm["id"], "visibility": "public"}, headers=op).json()
        bo_conv = f"c_{team['id']}~user:{ana_id}"
        hive.enqueue_message(team["id"], "synthetic peer to team", bo_conv, f"agent:{other['id']}")
        assert "synthetic peer to team" in texts(c.get(f"/api/agents/{team['id']}/messages", headers=cy))
    finally:
        c.__exit__(None, None, None)


def test_health_question_is_known_by_its_structured_event(client):
    """Kimi r2 #2: Health's question is the row IdleWatch.ask marks extra.event == health_question, not its text; the
    text prefix decides only for a row with no extra (fails closed). Same rule in the transcript SQL and live frames."""
    from hive.core.visibility import Viewer
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    conv = f"c_{a['id']}~user:u_synthana"
    hive.enqueue_message(a["id"], "synthetic ana", conv, "user:u_synthana")
    tagged = hive.enqueue_message(a["id"], "synthetic question with no tag", conv, "hive:health",
                                  extra={"event": "health_question", "question_id": "hq_x"})
    lookalike = hive.enqueue_message(a["id"], "[HEALTH-QUESTION hq_y] synthetic alert lookalike", conv, "hive:health",
                                     extra={"event": "health_alert"})
    legacy = hive.enqueue_message(a["id"], "[HEALTH-QUESTION hq_z] synthetic row with no extra", conv, "hive:health")
    row = lambda m: hive.db.one("SELECT * FROM messages WHERE id = ?", (m["id"],))
    assert hive._health_question(row(tagged)) and hive._health_question(hive.message_view(row(tagged)))
    assert not hive._health_question(row(lookalike)) and not hive._health_question(hive.message_view(row(lookalike)))
    assert hive._health_question(row(legacy)) and hive._health_question(hive.message_view(row(legacy)))
    seen = [m["text"] for m in hive.messages(a["id"], principal="user:u_synthbo")]
    assert lookalike["text"] in seen and tagged["text"] not in seen and legacy["text"] not in seen
    bo = Viewer("user:u_synthbo", False)
    frame = lambda m: json.dumps({"type": "message", "message": hive.message_view(row(m))})
    assert hive.chat_visible(bo.principal, json.loads(frame(tagged))["message"]) is False
    assert hive.chat_visible(bo.principal, json.loads(frame(lookalike))["message"]) is None
    assert hive.chat_visible(bo.principal, json.loads(frame(legacy))["message"]) is False


def test_room_talk_and_one_busy_conversation_cannot_crowd_out_an_owed_direct_message(client):
    """Stand-in r2 P2: room conversations are left out and conversations deduplicated before the candidate cap."""
    swarm, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    hive.rooms.ensure_coffee()
    hive.rooms.sync_team(swarm["id"])
    coffee = hive.db.one("SELECT id, alias FROM rooms WHERE kind = 'coffee'")
    team = hive.db.one("SELECT id, alias FROM rooms WHERE alias LIKE 'team\\_%' ESCAPE '\\' AND swarm_id IS NOT NULL")
    assert coffee and team
    old = lambda minutes: ago(hours=3, minutes=minutes)
    k = 0
    for conv in (coffee["alias"], coffee["id"], team["alias"], team["id"]):
        for _ in range(5):
            m = hive.enqueue_message(a["id"], f"synthetic room talk {k}", conv, f"user:u_room{k}")
            hive.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (old(60 - k), m["id"]))
            k += 1
    busy = f"c_{a['id']}~user:u_busy"
    for i in range(5):
        m = hive.enqueue_message(a["id"], f"synthetic busy {i}", busy, "user:u_busy")
        hive.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (old(30 - i), m["id"]))
    direct = hive.enqueue_message(a["id"], "synthetic direct, unanswered", f"c_{a['id']}~user:u_direct", "user:u_direct")
    hive.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (ago(hours=2), direct["id"]))
    awake(hive, a["id"], input_ago={"hours": 2})
    watch = hive.health.idle
    watch.OWED_MESSAGE_CANDIDATES = 2
    try:
        owed = [i for i in watch.owed(hive._agent_row(a["id"])) if i["type"] == "message"]
    finally:
        del watch.OWED_MESSAGE_CANDIDATES
    assert [i["conversation_id"] for i in owed] == [busy, f"c_{a['id']}~user:u_direct"]
    assert owed[0]["message_id"] == hive.db.one("SELECT id FROM messages WHERE text = 'synthetic busy 0'")["id"]
    assert owed[1]["message_id"] == direct["id"]


def test_unconnected_compares_start_stamps_by_time(client):
    """Kimi r2 #4: Health.mind and check_unconnected read a start written with an offset by its time, not its text."""
    _, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    zone = datetime.timezone(datetime.timedelta(hours=14))   # as text this sorts after now (Z); by time it is overdue
    late = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=hive.health.UNCONNECTED_S + 60))
    zoned = late.astimezone(zone).isoformat(timespec="milliseconds")
    from hive.core.db import now
    assert zoned > now()
    fresh = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=5)).astimezone(
        datetime.timezone(datetime.timedelta(hours=-11))).isoformat(timespec="milliseconds")   # as text: long ago
    assert fresh < now()
    hive.db.update("agents", a["id"], {"status": "starting", "last_active_at": zoned})
    hive.db.update("agents", b["id"], {"status": "starting", "last_active_at": fresh})
    assert client.get(f"/api/agents/{a['id']}/health").json()["health"] == "high"
    assert client.get(f"/api/agents/{b['id']}/health").json()["health"] == "ok"
    assert [x["agent_id"] for x in hive.health.check_unconnected()] == [a["id"]]


def _captured(hive, monkeypatch):
    """The live frames the hive publishes, serialized as the event bus sends them."""
    frames = []
    real = hive.events.publish

    def publish(kind, /, **payload):
        frames.append(json.dumps(dict(type=kind, at="t", **payload)))
        return real(kind, **payload)
    monkeypatch.setattr(hive.events, "publish", publish)
    return frames


def test_a_personal_minds_conversation_is_its_persons_in_both_directions(monkeypatch):
    """Kimi r2.1 sharpest: in a conversation that belongs to a person and their personal mind, the mind's replies
    (record_agent_message, direction 'out') are that person's as much as what was said to it. The loopback operator
    and another admin see neither direction, live, in the transcript, by conversation id or in the room lists, even
    when the mind is not hidden from them, unless they audit over HTTP (?include=all, ?include=personal). The person
    sees everything. The mind's own main stream (c_<mind>) stays the operator's; a shared mind keeps its rules."""
    from hive.core.visibility import Viewer
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, cy_id = _admin_person(c, op, google, "cy@example.com", "Cy")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        own = f"c_{mind['id']}~user:{ana_id}"
        frames = _captured(hive, monkeypatch)
        assert c.post(f"/api/agents/{mind['id']}/messages", json={"text": "synthetic ana says hi"},
                      headers=ana).status_code == 200
        hive.record_agent_message(mind["id"], {"text": "synthetic reply to ana", "conversation_id": own})
        hive.record_agent_message(mind["id"], {"text": "synthetic main stream note"})          # c_<mind>
        both = ("synthetic ana says hi", "synthetic reply to ana")
        live = [f for f in frames if f.startswith('{"type": "message"')]
        chat = [f for f in live if any(t in f for t in both)]
        main = [f for f in live if "synthetic main stream note" in f]
        assert len(chat) == 2 and len(main) == 1
        assert {json.loads(f)["message"]["direction"] for f in chat} == {"in", "out"}
        url = f"/api/agents/{mind['id']}/messages"
        texts = lambda r: [m["text"] for m in r.json()]
        # the mind is hidden from admins (private) and then not hidden (public, as if its person opened it): the
        # conversation stays its person's either way (fresh viewers: hidden ids are cached on one for 2 s)
        for visibility in ("private", "public"):
            hive.db.execute("UPDATE agents SET visibility = ? WHERE id = ?", (visibility, mind["id"]))
            operator, admin, person = Viewer("user:operator", True), Viewer(f"user:{cy_id}", True), Viewer(f"user:{ana_id}", False)
            for f in chat:
                assert hive.visibility.event_visible(person, f) is True
                for v in (operator, admin, Viewer(f"user:{cy_id}", True, audit=True)):
                    assert hive.visibility.event_visible(v, f) is False, (visibility, v.principal, f)
            # the main stream keeps its rules: the operator's own chat (live once the mind is not hidden from it)
            assert hive.visibility.event_visible(operator, main[0]) is (visibility == "public")
            assert hive.visibility.event_visible(admin, main[0]) is False
            mine = texts(c.get(url, headers=ana))
            assert all(t in mine for t in both)
            assert all(t in texts(c.get(url + f"?conversation_id={own}", headers=ana)) for t in both)
            for who in (op, cy):
                for path in (url, url + f"?conversation_id={own}"):
                    seen = texts(c.get(path, headers=who))
                    assert not any(t in seen for t in both), (visibility, path)
                for audit in ("all", "personal"):
                    seen = texts(c.get(url + f"?include={audit}", headers=who))
                    assert all(t in seen for t in both)          # an explicit audit reads both directions
                for path in ("/api/rooms", "/api/rooms?include=personal"):
                    listed = json.dumps(c.get(path, headers=who).json())
                    assert not any(t in listed for t in both)
            assert "synthetic main stream note" in texts(c.get(url, headers=op))   # the operator's own c_<mind>
            for m in hive.db.all("SELECT * FROM messages WHERE conversation_id = ?", (own,)):
                view = hive.message_view(m)
                assert hive.chat_visible("user:operator", view) is False and hive.chat_visible(f"user:{cy_id}", view) is False
                assert hive.chat_visible(f"user:{ana_id}", view) is True
        # a shared mind: the loopback operator keeps the whole stream, live and listed; another person does not
        swarm = c.post("/api/swarms", json={"name": "Shared", "visibility": "public"}, headers=op).json()
        team = c.post("/api/agents", json={"name": "Team", "swarm_id": swarm["id"], "visibility": "public"}, headers=op).json()
        team_conv = f"c_{team['id']}~user:{ana_id}"
        frames.clear()
        hive.record_agent_message(team["id"], {"text": "synthetic team reply to ana", "conversation_id": team_conv})
        hive.enqueue_message(team["id"], "synthetic ana to team", team_conv, f"user:{ana_id}")
        out = [f for f in frames if "synthetic team reply to ana" in f][0]
        assert hive.visibility.event_visible(operator, out) is True and hive.visibility.event_visible(admin, out) is False
        seen = texts(c.get(f"/api/agents/{team['id']}/messages", headers=op))
        assert "synthetic team reply to ana" in seen and "synthetic ana to team" in seen
        seen = texts(c.get(f"/api/agents/{team['id']}/messages", headers=cy))
        assert "synthetic team reply to ana" not in seen and "synthetic ana to team" not in seen
    finally:
        c.__exit__(None, None, None)


def test_an_agent_sender_is_a_note_on_a_shared_mind_only_when_it_is_a_real_mind(client):
    """Kimi r2.1 #1: on a shared or public mind, an agent:* message in someone else's conversation is a visible note
    only from a real, non-deleted mind; an unknown or deleted one fails closed (withheld) in the transcript and live."""
    from hive.core.visibility import Viewer
    swarm, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    conv = f"c_{a['id']}~user:u_synthana"
    hive.enqueue_message(a["id"], "synthetic ana", conv, "user:u_synthana")
    real = hive.enqueue_message(a["id"], "synthetic from a real mind", conv, f"agent:{b['id']}")
    ghost = hive.enqueue_message(a["id"], "synthetic from no mind", conv, "agent:a_synthghost")
    gone_id = client.post("/api/agents", json={"name": "Gone", "swarm_id": swarm["id"]}).json()["id"]
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (gone_id,))    # a deleted mind (soft delete)
    gone = hive.enqueue_message(a["id"], "synthetic from a deleted mind", conv, f"agent:{gone_id}")
    seen = [m["text"] for m in hive.messages(a["id"], principal="user:u_synthbo")]
    assert real["text"] in seen
    assert ghost["text"] not in seen and gone["text"] not in seen
    row = lambda m: hive.message_view(hive.db.one("SELECT * FROM messages WHERE id = ?", (m["id"],)))
    assert hive.chat_visible("user:u_synthbo", row(real)) is None
    assert hive.chat_visible("user:u_synthbo", row(ghost)) is False and hive.chat_visible("user:u_synthbo", row(gone)) is False
    bo = Viewer("user:u_synthbo", True)
    assert hive.visibility.event_visible(bo, json.dumps({"type": "message", "message": row(ghost)})) is False
    assert hive.chat_visible("user:u_synthana", row(ghost)) is True                     # Ana's own conversation


def test_an_unreadable_health_extra_is_logged_once_per_message(client, caplog):
    """Kimi r2.1 #2: the text-prefix fallback with an extra present but unreadable says so, once per message id."""
    _, (a, _) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    conv = f"c_{a['id']}~user:u_synthana"
    m = hive.enqueue_message(a["id"], "[HEALTH-QUESTION hq_q] synthetic corrupt", conv, "hive:health")
    hive.db.execute("UPDATE messages SET extra = ? WHERE id = ?", ("{not json", m["id"]))
    row = hive.db.one("SELECT * FROM messages WHERE id = ?", (m["id"],))
    with caplog.at_level("WARNING", logger="hive"):
        assert hive._health_question(row) and hive._health_question(hive.message_view(row))
        assert hive._health_question(row)
    hits = [r for r in caplog.records if m["id"] in r.getMessage() and "unreadable extra" in r.getMessage()]
    assert len(hits) == 1
    assert m["text"] not in [x["text"] for x in hive.messages(a["id"], principal="user:u_synthbo")]   # still hidden


# ---- r2.3 (stand-in r2.2 P1 #1, #2; Kimi r2.2 sharpest, #2-#4) ---------------------------------------------------

def _bundle_manifest(content):
    import io
    import tarfile
    return json.loads(tarfile.open(fileobj=io.BytesIO(content), mode="r:gz").extractfile("manifest.json").read())


def test_a_personal_minds_idle_record_is_its_persons_even_when_public_or_shared(monkeypatch):
    """Stand-in r2.2 P1 #1: a personal mind's idle record (its Health question and the mind's answer, from its person's
    own conversation) is its person's, and an admin's only by explicit ?include=all|personal, whatever the mind's
    visibility: making it public or sharing it grants nobody else the record, on the list or by id."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, cy_id = _admin_person(c, op, google, "cy@example.com", "Cy")
        bo, bo_id = _person(c, op, google, "bo@example.com", "Bo")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        own = f"c_{mind['id']}~user:{ana_id}"
        awake(hive, mind["id"], input_ago={"hours": 3})
        spend(hive, mind["id"])
        assert len(run(hive)) == 1
        hive.record_agent_message(mind["id"], {"text": "synthetic: resting until Ana writes", "conversation_id": own})
        idle = f"/api/agents/{mind['id']}/health/idle"
        reply = "synthetic: resting until Ana writes"
        for visibility, shared in (("public", []), ("shared", [f"user:{bo_id}", f"user:{cy_id}", "user:operator"])):
            hive.db.execute("UPDATE agents SET visibility = ?, shared_with = ? WHERE id = ?",
                            (visibility, json.dumps(shared), mind["id"]))
            assert c.get(f"/omegahive/api/agents/{mind['id']}", headers=bo).status_code == 200   # Bo sees the mind
            for who in (op, cy, bo):          # the operator, another admin, a member it is shared with / public to
                assert c.get(idle, headers=who).status_code == 404, visibility
                assert mind["id"] not in [m["id"] for m in c.get("/api/health/idle", headers=who).json()["minds"]]
                assert c.post(f"/api/agents/{mind['id']}/health/remind", headers=who).status_code == 404
            for who in (op, cy):              # an admin's explicit audit, read-only
                for include in ("all", "personal"):
                    r = c.get(idle + f"?include={include}", headers=who)
                    assert r.status_code == 200 and r.json()["reply"] == reply
                    assert mind["id"] in [m["id"] for m in c.get(f"/api/health/idle?include={include}", headers=who).json()["minds"]]
                    r = c.post(f"/api/agents/{mind['id']}/health/remind?include={include}", headers=who)
                    assert r.status_code == 403 and r.json()["error"]["code"] == "personal_mind"
            for include in ("all", "personal"):
                assert c.get(idle + f"?include={include}", headers=bo).status_code == 403   # members cannot audit
                assert c.get(f"/api/health/idle?include={include}", headers=bo).status_code == 403
            r = c.get(idle, headers=ana)      # the person
            assert r.status_code == 200 and r.json()["reply"] == reply and r.json()["history"]
            assert [m["id"] for m in c.get("/api/health/idle", headers=ana).json()["minds"]] == [mind["id"]]
    finally:
        c.__exit__(None, None, None)


def test_a_personal_minds_export_carries_its_persons_chats_only_for_them_or_an_audit(monkeypatch):
    """Stand-in r2.2 P1 #2: /api/agents/{id}/export of a personal mind carries its person's conversation (both
    directions) only for its person or an admin's explicit ?include=all|personal; otherwise the bundle holds only what
    the caller may read, marked detail.personal_conversations = "excluded". An authorised bundle carries everything.
    Importing never widens who reads the rows: they keep their conversation ids (so their owner), and land only where
    the mind is still its person's personal mind; elsewhere its people's chats stay behind (recorded)."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, cy_id = _admin_person(c, op, google, "cy@example.com", "Cy")
        bo, bo_id = _person(c, op, google, "bo@example.com", "Bo")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        own = f"c_{mind['id']}~user:{ana_id}"
        assert c.post(f"/api/agents/{mind['id']}/messages", json={"text": "synthetic ana says hi"}, headers=ana).status_code == 200
        hive.record_agent_message(mind["id"], {"text": "synthetic reply to ana", "conversation_id": own})
        hive.record_agent_message(mind["id"], {"text": "synthetic main stream note"})          # c_<mind>, the operator's
        hive.db.execute("UPDATE agents SET visibility = 'public', status = 'asleep' WHERE id = ?", (mind["id"],))
        # r2.5 (stand-in r2.3 P1 #1): the mind is public, so Bo chats with it too, and someone else's Ask turn ran on it
        hive.enqueue_message(mind["id"], "synthetic bo says hi", f"c_{mind['id']}~user:{bo_id}", f"user:{bo_id}")
        hive.record_agent_message(mind["id"], {"text": "synthetic reply to bo", "conversation_id": f"c_{mind['id']}~user:{bo_id}"})
        hive.enqueue_message(mind["id"], "synthetic someone's ask", "ask:t_synthother", f"user:{bo_id}")
        others = {"synthetic bo says hi", "synthetic reply to bo", "synthetic someone's ask", "synthetic main stream note"}
        chat = {"synthetic ana says hi", "synthetic reply to ana"}
        url = f"/api/agents/{mind['id']}/export"

        def export(headers, query=""):
            r = c.post(url + query, headers=headers)
            assert r.status_code == 200, r.text
            m = _bundle_manifest(r.content)
            return r, m, {x["text"] for x in m["messages"]}

        for who in (op, cy):                  # an admin (the operator, another admin) without audit: scoped
            r, m, texts = export(who)
            # exactly what this caller's own transcript shows (the operator keeps its c_<mind>; Cy reads neither)
            # (the export also drops other people's Ask rows, r2.3; this synthetic one has no ask_turns record)
            assert texts == {x["text"] for x in c.get(f"/api/agents/{mind['id']}/messages", headers=who).json()} - {"synthetic someone's ask"}
            assert not texts & chat and ("synthetic main stream note" in texts) == (who is op)
            assert m["detail"]["personal_conversations"] == "excluded" and r.headers["x-personal-conversations"] == "excluded"
            assert not any(x["conversation_id"] == own for x in m["messages"])
        for include in ("all", "personal"):   # an explicit audit: everything, marked
            r, m, texts = export(op, f"?include={include}")
            assert chat <= texts and others <= texts                          # unscoped only for an explicit audit
            assert m["detail"]["personal_conversations"] == "included_audited"
        r, m, texts = export(ana)             # the person: their own transcript's rows (r2.5), not other people's
        assert chat <= texts and m["detail"]["personal_conversations"] == "included_person"
        assert not texts & others
        assert texts == {x["text"] for x in c.get(f"/api/agents/{mind['id']}/messages", headers=ana).json()}
        assert m["mind"]["personal_of"] == f"user:{ana_id}"
        assert c.post(url, headers=bo).status_code == 403                         # not the owner, not an admin
        assert c.post(url + "?include=all", headers=bo).status_code == 403
        moves = [json.loads(x["detail"]) for x in hive.db.all(
            "SELECT detail FROM mind_moves WHERE agent_id = ? AND direction = 'out' ORDER BY created_at, rowid", (mind["id"],))]
        assert [x["personal_conversations"] for x in moves] == ["excluded", "excluded", "included_audited",
                                                                 "included_audited", "included_person"]
        full = c.post(url + "?include=all", headers=op)
        own_bundle = c.post(url, headers=ana)
        # elsewhere (another hive, an ordinary swarm): nothing there binds it to Ana, so the move is refused whole
        # (r2.5, stand-in r2.3 P1 #2), whoever exported it; nothing lands, never a silently incomplete import
        app2, *_ = _env(monkeypatch)
        c2, op2 = _client(app2)
        try:
            swarm = c2.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}, headers=op2).json()
            for bundle in (full, own_bundle, c.post(url, headers=op)):
                arrived = c2.post(f"/api/agents/import?swarm_id={swarm['id']}", content=bundle.content, headers=op2)
                assert arrived.status_code == 409 and arrived.json()["error"]["code"] == "personal_mind_unbound", arrived.text
            h2 = app2.state.hive
            assert h2.db.one("SELECT 1 FROM agents WHERE id = ?", (mind["id"],)) is None
            assert h2.db.all("SELECT 1 FROM messages WHERE agent_id = ?", (mind["id"],)) == []
            assert h2.db.all("SELECT 1 FROM mind_moves WHERE agent_id = ?", (mind["id"],)) == []
        finally:
            c2.__exit__(None, None, None)
        # home again (its row here is still Ana's personal mind): every row returns, each keeping its conversation
        settled = c.post(f"/api/agents/{mind['id']}/settle", headers=op, json={
            "to_hive": "h_synthother", "to_name": "Other", "manifest_sha256": full.headers["x-manifest-sha256"]})
        assert settled.status_code == 200, settled.text
        before = {x["id"]: x["conversation_id"] for x in hive.db.all("SELECT id, conversation_id FROM messages WHERE agent_id = ?",
                                                                       (mind["id"],))}
        hive.db.execute("DELETE FROM messages WHERE agent_id = ?", (mind["id"],))
        back = c.post("/api/agents/import", content=full.content, headers=op)
        assert back.status_code == 200, back.text
        after = {x["id"]: x["conversation_id"] for x in hive.db.all("SELECT id, conversation_id FROM messages WHERE agent_id = ?",
                                                                      (mind["id"],))}
        assert after == before
        texts = lambda r: {x["text"] for x in r.json()}
        msgs = f"/api/agents/{mind['id']}/messages"
        assert chat <= texts(c.get(msgs, headers=ana))
        for who in (op, cy):
            assert not texts(c.get(msgs, headers=who)) & chat
    finally:
        c.__exit__(None, None, None)


def test_a_message_from_no_real_mind_is_not_input(client):
    """Kimi r2.2 sharpest: an agent:* sender that resolves to no real, non-deleted mind is not input, so it never
    resets the mind's idle clock (the same resolution as _noted_sender); a real mind's message still is."""
    swarm, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    stamp = ago(hours=5)
    hive.db.update("agents", a["id"], {"last_input_at": stamp})
    hive.enqueue_message(a["id"], "synthetic from no mind", f"c_{a['id']}", "agent:a_synthghost")
    assert hive._agent_row(a["id"])["last_input_at"] == stamp
    gone_id = client.post("/api/agents", json={"name": "Gone", "swarm_id": swarm["id"]}).json()["id"]
    assert client.delete(f"/api/agents/{gone_id}").status_code == 200
    hive.enqueue_message(a["id"], "synthetic from a deleted mind", f"c_{a['id']}", f"agent:{gone_id}")
    assert hive._agent_row(a["id"])["last_input_at"] == stamp
    hive.enqueue_message(a["id"], "synthetic from a real mind", f"c_{a['id']}", f"agent:{b['id']}")
    assert hive._agent_row(a["id"])["last_input_at"] != stamp


def test_live_audit_never_streams_another_persons_chat(monkeypatch):
    """Kimi r2.2 #2: an audit viewer lifts the hiding of personal minds, never chat privacy: another person's chat
    frame is withheld from it on the live path, through the admin path itself too; the events socket never audits."""
    from hive.core.visibility import Viewer
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, cy_id = _admin_person(c, op, google, "cy@example.com", "Cy")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        frames = _captured(hive, monkeypatch)
        assert c.post(f"/api/agents/{mind['id']}/messages", json={"text": "synthetic ana live"}, headers=ana).status_code == 200
        swarm = c.post("/api/swarms", json={"name": "Shared", "visibility": "public"}, headers=op).json()
        team = c.post("/api/agents", json={"name": "Team", "swarm_id": swarm["id"], "visibility": "public"}, headers=op).json()
        hive.enqueue_message(team["id"], "synthetic ana to team", f"c_{team['id']}~user:{ana_id}", f"user:{ana_id}")
        hive.events.publish("message", message=hive.message_view(hive.db.one(
            "SELECT * FROM messages WHERE text = 'synthetic ana to team'")))
        chat = [f for f in frames if f.startswith('{"type": "message"') and ("synthetic ana live" in f or "synthetic ana to team" in f)]
        assert len(chat) >= 2
        for f in chat:
            for v in (Viewer(f"user:{cy_id}", True, audit=True), Viewer("user:operator", True, audit=True)):
                if "synthetic ana to team" in f and v.principal == "user:operator":
                    continue                  # the loopback operator keeps a shared mind's whole stream
                assert hive.visibility.event_visible(v, f) is False
                assert hive.visibility._admin_event_visible(v, f) is False    # the admin bypass itself
            assert hive.visibility.event_visible(Viewer(f"user:{ana_id}", False), f) is True
    finally:
        c.__exit__(None, None, None)


def test_the_person_reads_a_ghost_senders_row_in_their_own_conversation_over_http(monkeypatch):
    """Kimi r2.2 #4: an agent:* row from no real mind in Ana's conversation with a shared mind is hers over HTTP (the
    transcript and by conversation id) and withheld from another person; Python and SQL agree."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        bo, bo_id = _person(c, op, google, "bo@example.com", "Bo")
        swarm = c.post("/api/swarms", json={"name": "Shared", "visibility": "public"}, headers=op).json()
        team = c.post("/api/agents", json={"name": "Team", "swarm_id": swarm["id"], "visibility": "public"}, headers=op).json()
        conv = f"c_{team['id']}~user:{ana_id}"
        hive.enqueue_message(team["id"], "synthetic ana", conv, f"user:{ana_id}")
        ghost = hive.enqueue_message(team["id"], "synthetic from no mind", conv, "agent:a_synthghost")
        url = f"/omegahive/api/agents/{team['id']}/messages"
        texts = lambda r: [m["text"] for m in r.json()]
        assert ghost["text"] in texts(c.get(url, headers=ana))
        assert ghost["text"] in texts(c.get(url + f"?conversation_id={conv}", headers=ana))
        assert ghost["text"] not in texts(c.get(url, headers=bo))
        assert ghost["text"] not in texts(c.get(url + f"?conversation_id={conv}", headers=bo))
        view = hive.message_view(hive.db.one("SELECT * FROM messages WHERE id = ?", (ghost["id"],)))
        assert hive.chat_visible(f"user:{ana_id}", view) is True and hive.chat_visible(f"user:{bo_id}", view) is False
    finally:
        c.__exit__(None, None, None)


def test_the_live_memo_forgets_a_deleted_mind_at_once(client):
    """Kimi r2.2 #3: chat_visible's per-frame lookups are memoised for 2 s on the live path, but a soft delete clears
    the memo, so a just-deleted mind's agent:* message fails closed at once."""
    swarm, (a, b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    conv = f"c_{a['id']}~user:u_synthana"
    hive.enqueue_message(a["id"], "synthetic ana", conv, "user:u_synthana")
    m = hive.enqueue_message(a["id"], "synthetic from b", conv, f"agent:{b['id']}")
    view = hive.message_view(hive.db.one("SELECT * FROM messages WHERE id = ?", (m["id"],)))
    assert hive.chat_visible("user:u_synthbo", view) is None
    calls = []
    real = hive.db.one
    hive.db.one = lambda *a, **k: (calls.append(a[0]), real(*a, **k))[1]
    try:
        assert hive.chat_visible("user:u_synthbo", view) is None
        assert not any("FROM agents" in q for q in calls)      # served from the memo
    finally:
        hive.db.one = real
    assert client.delete(f"/api/agents/{b['id']}").status_code == 200
    assert hive.chat_visible("user:u_synthbo", view) is False


def test_per_viewer_flags_match_what_the_remind_and_sleep_routes_do(monkeypatch):
    """r2.4 (Surface health-idle r1.1 contract): is_mine, may_remind and may_sleep on /api/agents, /api/agents/{id},
    /api/health/idle and /api/agents/{id}/health/idle, for the person, the loopback operator, another admin, both
    auditing, a member the mind is shared with and a member it is not, with the mind awake and asleep, personal and
    not. Each flag is true exactly when its route accepts the call; personal_of is never exposed."""
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        cy, _ = _admin_person(c, op, google, "cy@example.com", "Cy")
        bo, bo_id = _person(c, op, google, "bo@example.com", "Bo")
        di, _ = _person(c, op, google, "di@example.com", "Di")
        personal = c.get("/api/me/mind", headers=ana).json()["mind"]["id"]
        r = c.post("/api/agents", json={"name": "Synthetic team mind", "visibility": "shared",
                                        "shared_with": [f"user:{bo_id}"]}, headers=ana)
        assert r.status_code == 200, r.text
        team = r.json()["id"]
        assert hive.db.one("SELECT owner, personal_of FROM agents WHERE id = ?", (team,)) == {"owner": f"user:{ana_id}", "personal_of": None}
        hive.db.execute("UPDATE agents SET visibility = 'shared', shared_with = ? WHERE id = ?",
                        (json.dumps([f"user:{bo_id}"]), personal))
        viewers = {"person": (ana, ""), "operator": (op, ""), "admin": (cy, ""),
                   "operator auditing": (op, "?include=personal"), "admin auditing": (cy, "?include=personal"),
                   "shared member": (bo, ""), "unshared member": (di, "")}

        def expected(who, is_personal, state):
            person, admin = who == "person", who in ("operator", "admin", "operator auditing", "admin auditing")
            return {"is_mine": is_personal and person,
                    "may_remind": state == "awake" and (person if is_personal else person or admin),
                    "may_sleep": who != "unshared member"}

        def observed(headers, query, mind):
            seen = []
            listed = [a for a in c.get("/api/agents" + query, headers=headers).json() if a["id"] == mind]
            seen += [("list", a) for a in listed]
            r = c.get(f"/api/agents/{mind}{query}", headers=headers)
            if r.status_code == 200:
                seen.append(("by id", r.json()))
            r = c.get(f"/api/agents/{mind}/health/idle{query}", headers=headers)
            if r.status_code == 200:
                seen.append(("idle by id", r.json()))
            seen += [("idle list", m) for m in c.get("/api/health/idle" + query, headers=headers).json()["minds"] if m["id"] == mind]
            return seen

        def set_state(mind, state):
            if state == "awake":
                awake(hive, mind, input_ago={"hours": 3})
            else:
                hive.db.update("agents", mind, {"status": "asleep", "desired": "asleep"})

        checked = 0
        for mind, is_personal in ((personal, True), (team, False)):
            for state in ("awake", "asleep"):
                for who, (headers, query) in viewers.items():
                    set_state(mind, state)
                    want = expected(who, is_personal, state)
                    seen = observed(headers, query, mind)
                    if who == "unshared member":
                        assert seen == [], (who, is_personal, state)
                    else:
                        assert "by id" in [s for s, _ in seen], (who, is_personal, state)
                    for source, item in seen:
                        assert {k: item[k] for k in want} == want, (who, is_personal, state, source)
                        assert "personal_of" not in item, (who, source)
                        checked += 1
                    # the route accepts exactly when its flag is true
                    r = c.post(f"/api/agents/{mind}/health/remind{query}", headers=headers)
                    assert (r.status_code == 200) == want["may_remind"], (who, is_personal, state, r.text)
                    if r.status_code == 200:
                        assert {k: r.json()[k] for k in want} == want
                    set_state(mind, state)
                    r = c.post(f"/api/agents/{mind}/sleep{query}", headers=headers)
                    assert (r.status_code == 200) == want["may_sleep"], (who, is_personal, state, r.text)
                    if not want["may_sleep"]:
                        assert r.status_code == 404
                        assert hive.db.one("SELECT status FROM agents WHERE id = ?", (mind,))["status"] == state
        assert checked >= 40
    finally:
        c.__exit__(None, None, None)


# ---- r2.5 (stand-in r2.3 P1 #1-#3) -----------------------------------------------------------------------------------

def _repack(content, manifest):
    import io
    import tarfile
    src = tarfile.open(fileobj=io.BytesIO(content), mode="r:gz")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as out:
        for member in src.getmembers():
            data = json.dumps(manifest, indent=1).encode() if member.name == "manifest.json" else src.extractfile(member).read()
            info = tarfile.TarInfo(member.name)
            info.size, info.mode = len(data), 0o600
            out.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_an_old_conversation_tail_keeps_its_owner_across_a_move(monkeypatch):
    """Stand-in r2.3 P1 #3: a conversation owned by its first person speaker, whose first input is older than the rows
    a bundle keeps, still arrives as that person's: the bundle carries the defining row and a conversation_owners map
    from the source's whole history, and import refuses a bundle whose rows would be attributed otherwise."""
    from hive.core import placement
    monkeypatch.setattr(placement, "MESSAGES_KEPT", 3)
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        swarm = c.post("/api/swarms", json={"name": "Synthetic", "visibility": "public"}, headers=op).json()
        mind = c.post("/api/agents", json={"name": "Synthetic mover", "swarm_id": swarm["id"]}, headers=op).json()
        legacy = "c_synthlegacy"                              # a legacy id: owned by its first person speaker
        first = hive.enqueue_message(mind["id"], "synthetic ana opens", legacy, "user:u_synthana")
        for i in range(5):
            hive.record_agent_message(mind["id"], {"text": f"synthetic reply {i}", "conversation_id": legacy})
        assert hive.conversation_owner(mind["id"], legacy) == "user:u_synthana"
        r = c.post(f"/api/agents/{mind['id']}/export", headers=op)
        assert r.status_code == 200, r.text
        manifest = _bundle_manifest(r.content)
        ids = [m["id"] for m in manifest["messages"]]
        assert first["id"] in ids and len(ids) == 4           # the newest 3 plus the defining row, outside the window
        assert manifest["conversation_owners"][legacy] == "user:u_synthana"
        assert set(manifest["conversation_owners"]) == {legacy}  # only carried conversations
        # Without r2.5 the destination would see only replies, attribute the conversation to nobody, and the
        # destination operator alone would read it. Now it arrives as Ana's.
        app2, *_ = _env(monkeypatch)
        c2, op2 = _client(app2)
        try:
            s2 = c2.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}, headers=op2).json()
            arrived = c2.post(f"/api/agents/import?swarm_id={s2['id']}", content=r.content, headers=op2)
            assert arrived.status_code == 200, arrived.text
            h2 = app2.state.hive
            assert h2.conversation_owner(mind["id"], legacy) == "user:u_synthana"
            assert len(h2.db.all("SELECT 1 FROM messages WHERE agent_id = ?", (mind["id"],))) == 4
            assert {m["text"] for m in h2.messages(mind["id"], principal="user:u_synthbo")} & {"synthetic reply 4"} == set()
        finally:
            c2.__exit__(None, None, None)
        # the same bundle with its defining row taken out (or its map edited) is refused whole
        stripped = dict(manifest, messages=[m for m in manifest["messages"] if m["id"] != first["id"]])
        edited = dict(manifest, conversation_owners={**manifest["conversation_owners"], legacy: "user:u_synthbo"})
        for bad in (stripped, edited):
            app3, *_ = _env(monkeypatch)
            c3, op3 = _client(app3)
            try:
                s3 = c3.post("/api/swarms", json={"name": "Third", "visibility": "public"}, headers=op3).json()
                refused = c3.post(f"/api/agents/import?swarm_id={s3['id']}", content=_repack(r.content, bad), headers=op3)
                assert refused.status_code == 409 and refused.json()["error"]["code"] == "conversation_owner_mismatch", refused.text
                h3 = app3.state.hive
                assert h3.db.one("SELECT 1 FROM agents WHERE id = ?", (mind["id"],)) is None
                assert h3.db.all("SELECT 1 FROM messages WHERE agent_id = ?", (mind["id"],)) == []
            finally:
                c3.__exit__(None, None, None)
    finally:
        c.__exit__(None, None, None)


def test_a_personal_minds_old_tail_returns_home_with_its_owner(monkeypatch):
    """Stand-in r2.3 P1 #2/#3 together: a personal mind's bundle lands back home only, every row with it; a legacy
    conversation whose first input is outside the kept window comes back attributed to its person."""
    from hive.core import placement
    monkeypatch.setattr(placement, "MESSAGES_KEPT", 3)
    app, google, _sup, _ = _env(monkeypatch)
    c, op = _client(app)
    hive = app.state.hive
    try:
        ana, ana_id = _person(c, op, google, "ana@example.com", "Ana")
        mind = c.get("/api/me/mind", headers=ana).json()["mind"]
        legacy = "c_synthlegacytail"
        hive.enqueue_message(mind["id"], "synthetic ana long ago", legacy, f"user:{ana_id}")
        for i in range(4):
            hive.record_agent_message(mind["id"], {"text": f"synthetic tail {i}", "conversation_id": legacy})
        full = c.post(f"/api/agents/{mind['id']}/export?include=all", headers=op)
        assert full.status_code == 200, full.text
        assert c.post(f"/api/agents/{mind['id']}/settle", headers=op, json={
            "to_hive": "h_synthother", "to_name": "Other", "manifest_sha256": full.headers["x-manifest-sha256"]}).status_code == 200
        hive.db.execute("DELETE FROM messages WHERE agent_id = ?", (mind["id"],))
        back = c.post("/api/agents/import", content=full.content, headers=op)
        assert back.status_code == 200, back.text
        assert hive.conversation_owner(mind["id"], legacy) == f"user:{ana_id}"
        texts = lambda r: {x["text"] for x in r.json()}
        assert "synthetic tail 3" in texts(c.get(f"/api/agents/{mind['id']}/messages", headers=ana))
        assert "synthetic tail 3" not in texts(c.get(f"/api/agents/{mind['id']}/messages", headers=op))
    finally:
        c.__exit__(None, None, None)
