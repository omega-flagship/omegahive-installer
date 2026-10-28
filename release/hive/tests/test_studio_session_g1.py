"""J3 host round R2 (G1): the studio.session intent kind (hive/core/studio_sessions.py, ask_intents.py).

Plan PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md §3.1-3.2, §8 rows G1-a..d; contract J3_ASK_SETS_UP_STUDIO_CONTRACT_R4_3.md §2, §6;
Code's qualification follow-ups J3_R43_BUILD_QUALIFICATION_FOLLOWUPS_20261017.md items 3 and 4 (admission part).
Synthetic only: temporary data directories, fake supervisor, invented keys, no provider call, no live hive. Only HTTP and
the database are used, so each test fails on 1f5fc6c9 by its own assertion (admin-only routes, the fixed kind)."""
import json
import secrets
import time

import pytest

from hive.core.db import now
from hive.core.hive import token_hash
from hive.tests.test_ask_intents import ORIGIN, a, drain, held, release, token_of, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)

MIA = "user:u_mia"
KEY = "k_0000a001"
MODEL = "openrouter/test/maker"
CONSENT = "sha256:" + "c" * 64
PIN = {"id": "omegadesign", "version": "0.4.17-j0-png", "digest": "sha256:" + "a" * 64}


def add_key(hive, key_id, owner, provider="openrouter"):
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": provider, "label": key_id, "owner": owner,
                                        "secret": "sk-" + key_id + "-secret", "created_at": time.time()}


@pytest.fixture()
def s(a, monkeypatch):
    """Mia (a named member) has an Ask turn; a public Studio home with a maker paid by Mia's own key; her monthly total
    is set. The app-attachment check is stubbed here (its own tests below run the real one)."""
    c, hive = a.client, a.hive
    c.put(f"/api/swarms/{a.origin['id']}/visibility", json={"visibility": "shared", "shared_with": [MIA]})
    c.put(f"/api/agents/{a.asker['id']}/visibility", json={"visibility": "shared", "shared_with": [MIA]})
    add_key(hive, KEY, MIA)
    a.home = c.post("/api/swarms", json={"name": "Studio home", "visibility": "public"}).json()
    a.maker = c.post("/api/agents", json={"name": "Maker", "swarm_id": a.home["id"], "model": MODEL, "budget_usd": 5,
                                          "options": {"key": KEY}}).json()
    if hasattr(hive, "studio"):                     # absent on 1f5fc6c9: the tests then fail on their own assertions
        monkeypatch.setattr(hive.studio, "_app_attached", lambda request: True)
        # R2.2 (plan r1.3 F4.2, F1.8): these tests stand in for a qualified build with Studio switched on and a
        # supervisor-managed maker; test_studio_session_r22.py runs the real setting, self-check and qualification
        monkeypatch.setattr(hive.studio, "enabled", True, raising=False)
        monkeypatch.setattr(hive.studio, "execution_qualified", lambda maker: True, raising=False)
    assert c.put("/api/me/key-limits/self", headers=a.mia, json={"month_usd": 10}).status_code == 200
    turn(a, op="op-mia-turn-01", who=a.mia)
    return a


def consent_of(body, monthly):
    """R2.2 (plan r1.1 K10): the consent payload, written out here independently of the host so the recipe is pinned:
    canonical JSON (sorted keys, no spaces, UTF-8), money in integer micro-dollars, sha256."""
    import hashlib
    kind, limit = monthly
    payload = {"schema": "omega-studio-consent-1", "swarm_id": body["swarm_id"], "program_id": body["program_id"],
               "app_pin": body["app_pin"], "maker_id": body["maker_id"], "model": body["model"], "key_id": body["key_id"],
               "role_id": body["role_id"], "tools": body["tools"],
               "payer": "hive_key" if body["key_id"].startswith("env:") else "own_key",
               "monthly": {"kind": kind, "limit_micros": None if limit is None else round(limit * 1_000_000)},
               "cap_micros": round(body.get("cap_usd", 2.0) * 1_000_000),
               "step_cap_micros": round(body.get("step_cap_usd", 0.25) * 1_000_000), "step_window_s": 180,
               "max_steps": body["max_steps"], "window_minutes": body["window_minutes"], "piece": body["piece"],
               "coordinator_exclusive": body.get("coordinator_exclusive", False), "title": body["title"], "detail": body["detail"],
               "disclosures": ["maker_restarts_between_steps", "maker_reads_unsaved_piece_while_live"]}
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def studio_request(x, monthly=None, **over):
    """monthly: the (limit kind, limit) the card showed; default Mia's own-key all-keys total of 10, or the member
    default allowance of 50 on the hive's key."""
    body = {"swarm_id": x.home["id"], "program_id": "omegadesign", "app_pin": dict(PIN), "maker_id": x.maker["id"],
            "title": "Poster for Elm Street", "detail": "A poster for the street party", "piece": {"scene_id": "scene-1", "source_ref": None},
            "key_id": KEY, "model": MODEL, "role_id": None, "tools": [], "max_steps": 12, "window_minutes": 60}
    body.update(over)
    if "consent_digest" not in over:
        if monthly is None:
            monthly = ("member_allowance", 50.0) if str(body["key_id"]).startswith("env:") else ("own_key_limit", 10.0)
        try:
            body["consent_digest"] = consent_of(body, monthly)
        except (KeyError, TypeError, AttributeError):   # a malformed request under test: any well-formed digest
            body["consent_digest"] = CONSENT
    return body


def record(x, who=None, op="op-mia-turn-01", monthly=None, **over):
    return x.client.post(f"/api/ask/{op}/intents", headers=who or x.mg,
                         json={"kind": "studio.session", "request": studio_request(x, monthly, **over)})


def submit(x, iid, who=None):
    return x.client.post(f"/api/ask/intents/{iid}/submit", headers=who or x.mg)


def counts(hive):
    out = {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in ("goals", "artifacts", "mind_operations", "ask_intents")}
    exists = hive.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'studio_sessions'")
    out["studio_sessions"] = hive.db.one("SELECT COUNT(*) AS n FROM studio_sessions")["n"] if exists else 0
    return out


def err(response):
    return response.json().get("error", {})


def session_headers(hive, principal, kind="sso"):
    token = secrets.token_urlsafe(24)
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": kind, "principal": principal})
    return {"Authorization": f"Bearer {token}", **ORIGIN}


# ---- G1-a / G1-d: a member records and submits; exact assignee, person creator, host-made proposal artifact ------------

def test_G1a_member_records_and_submits_one_goal_one_host_artifact_one_session(s):
    c, hive = s.client, s.hive
    before = counts(hive)
    r = record(s)
    assert r.status_code == 201, r.text
    intent = r.json()
    assert intent["kind"] == "studio.session" and intent["state"] == "pending"
    assert intent["request"]["cap_usd"] == 2.0 and intent["request"]["step_cap_usd"] == 0.25   # the owner's default backstops
    assert counts(hive) == {**before, "ask_intents": before["ask_intents"] + 1}                 # record creates nothing else
    assert record(s).status_code == 200                                                         # same body: same intent
    out = submit(s, intent["intent_id"])
    assert out.status_code == 201, out.text
    body = out.json()
    after = counts(hive)
    assert {k: after[k] - before[k] for k in after} == {"goals": 1, "artifacts": 1, "mind_operations": 1, "ask_intents": 1,
                                                         "studio_sessions": 1}
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (body["goal_id"],))
    assert goal["assignee"] == s.maker["id"] and goal["created_by"] == MIA and goal["swarm_id"] == s.home["id"]  # G1-d
    art = hive.db.one("SELECT * FROM artifacts WHERE id = ?", (body["proposal_artifact_id"],))
    assert art["created_by"] == "hive:studio:" + body["session_id"] and art["kind"] == "studio-proposals"
    assert art["owner_swarm"] == s.home["id"]
    row = hive.db.one("SELECT * FROM studio_sessions WHERE id = ?", (body["session_id"],))
    assert (row["principal"], row["maker_id"], row["state"], row["payer"], row["own_key"]) == (MIA, s.maker["id"], "active", MIA, 1)
    assert (row["cap_usd"], row["step_cap_usd"], row["step_window_s"]) == (2.0, 0.25, 180)
    assert body["budget_scope"] == "studio:" + body["session_id"]
    linked = hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (intent["intent_id"],))
    assert linked["state"] == "linked" and linked["receiving_goal"] == body["goal_id"]
    view = c.get(f"/api/ask/intents/{intent['intent_id']}", headers=s.mia).json()
    assert view["state"] == "linked" and view["session_id"] == body["session_id"]
    # R2.2 (plan r1.1 S6.1): no goal announce; the session's step message (R3) is the maker's only prompt
    assert not hive.db.all("SELECT agent_id FROM messages WHERE text LIKE ?", (f"%{body['goal_id']}%",))
    # the owner's ledger; anyone else, admins included, 404
    ledger = c.get(f"/api/studio-sessions/{body['session_id']}", headers=s.mia)
    assert ledger.status_code == 200 and ledger.json()["goal_id"] == body["goal_id"] and ledger.json()["steps"] == []
    assert ledger.json()["budget"]["cap"] == 2.0 and ledger.json()["budget"]["held"] == 0
    assert any(m["scope"].startswith("keyuse:") and m["limit"] == 10 for m in ledger.json()["budget"]["monthly"])
    for other in (s.quinn, s.ann):
        assert err(c.get(f"/api/studio-sessions/{body['session_id']}", headers=other)).get("code") == "not_available"


def test_G1a_code_request_stays_admin_only_for_a_member(s):
    from hive.tests.test_ask_intents import request_body
    before = counts(s.hive)
    r = s.client.post("/api/ask/op-mia-turn-01/intents", headers=s.mg, json={"kind": "code.request", "request": request_body(s)})
    assert r.status_code == 403 and err(r)["code"] == "person_required"
    assert counts(s.hive) == before


@pytest.mark.parametrize("who", ["password", "operator_sso"])
def test_G1a_password_and_operator_sessions_are_refused_before_any_write(s, who):
    hive = s.hive
    iid = record(s).json()["intent_id"]
    headers = {"Authorization": f"Bearer {s.client.operator_token}", **ORIGIN} if who == "password" \
        else session_headers(hive, "user:operator")
    before = counts(hive)
    r = s.client.post("/api/ask/op-mia-turn-01/intents", headers=headers,
                      json={"kind": "studio.session", "request": studio_request(s)})
    assert r.status_code == 403 and err(r)["code"] == "person_required"
    r = submit(s, iid, who=headers)
    assert r.status_code == 403 and err(r)["code"] == "person_required"
    assert counts(hive) == before and hive.db.one("SELECT state FROM ask_intents WHERE id = ?", (iid,))["state"] == "pending"


def test_G1a_the_intent_frame_names_the_goal_and_session_and_a_studio_session_event_reaches_only_the_person(s):
    c, hive = s.client, s.hive
    zed = person(hive, "u_zed", role="member")                                   # another member who sees the home
    iid = record(s).json()["intent_id"]
    with c.websocket_connect(f"/api/events?token={token_of(s.mia)}") as mia_ws, \
            c.websocket_connect(f"/api/events?token={token_of(zed)}") as zed_ws, \
            c.websocket_connect(f"/api/events?token={token_of(s.quinn)}") as quinn_ws:
        for ws in (mia_ws, zed_ws, quinn_ws):
            assert ws.receive_json()["type"] == "hello"
        body = submit(s, iid).json()
        mia, zed_frames, quinn = drain(mia_ws), drain(zed_ws), drain(quinn_ws)
    linked = [f for f in mia if f.get("type") == "ask" and f.get("phase") == "intent" and f.get("state") == "linked"]
    assert len(linked) == 1 and linked[0]["goal_id"] == body["goal_id"] and linked[0]["session_id"] == body["session_id"]
    assert linked[0]["operation_id"] == "op-mia-turn-01"
    notices = [f for f in mia if f.get("type") == "studio.session"]
    assert len(notices) == 1
    n = notices[0]
    assert (n["session_id"], n["goal_id"], n["agent_id"], n["proposal_artifact_id"], n["state"], n["operation_id"]) == \
        (body["session_id"], body["goal_id"], s.maker["id"], body["proposal_artifact_id"], "active", "op-mia-turn-01")
    assert not [f for f in zed_frames if f.get("type") == "studio.session"]       # not everyone who sees the swarm
    assert [f["session_id"] for f in quinn if f.get("type") == "studio.session"] == [body["session_id"]]   # admins do


# ---- G1-b: a lost response replays the recorded answer -------------------------------------------------------------

def test_G1b_a_lost_submit_response_replays_the_same_bytes_and_creates_nothing_more(s):
    iid = record(s).json()["intent_id"]
    first = submit(s, iid)
    assert first.status_code == 201
    before = counts(s.hive)
    again = submit(s, iid)
    assert again.status_code == 201 and again.content == first.content
    assert counts(s.hive) == before
    op = s.hive.db.one("SELECT * FROM mind_operations WHERE operation_id = ?", ("ask." + iid,))
    assert op["scope"] == MIA and first.content == op["body"].encode()


def test_G1b_a_fault_after_the_link_rolls_back_goal_artifact_and_session(s, monkeypatch):
    from hive.core.ask_intents import Intents
    iid = record(s).json()["intent_id"]
    original = Intents._link

    def faulty(self, intent_id, dispatch_id, recorded):
        original(self, intent_id, dispatch_id, recorded)
        raise RuntimeError("fault after the link CAS")
    monkeypatch.setattr(Intents, "_link", faulty)
    before = counts(s.hive)
    import asyncio
    from hive.core.visibility import Viewer
    with pytest.raises(RuntimeError):
        asyncio.run(s.hive.ask.intents.submit(Viewer(MIA, False), iid, admin=False))
    assert counts(s.hive) == before
    rec = s.hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (iid,))
    assert rec["state"] == "pending" and json.loads(rec["last_dispatch"])["outcome"] == "not_committed"
    monkeypatch.setattr(Intents, "_link", original)
    assert submit(s, iid).status_code == 201 and counts(s.hive)["studio_sessions"] == before["studio_sessions"] + 1


def test_G1b_a_claim_left_by_a_dead_process_is_pending_after_recovery_and_admits_once(s):
    from hive.core import exclusive
    iid = record(s).json()["intent_id"]
    s.hive.db.execute("UPDATE ask_intents SET state = 'dispatching', dispatch_id = 'ad_dead', dispatch_started_at = ? WHERE id = ?",
                      (now(), iid))
    holder = held(s.hive.settings.data_dir)
    try:
        assert exclusive.startup_recovery(holder, s.hive)["ask_intents"] == 1
    finally:
        release(holder)
    assert s.hive.db.one("SELECT state FROM ask_intents WHERE id = ?", (iid,))["state"] == "pending"
    assert counts(s.hive)["studio_sessions"] == 0
    assert submit(s, iid).status_code == 201 and counts(s.hive)["studio_sessions"] == 1


# ---- G1-c: every refusal creates zero rows -------------------------------------------------------------------------

def _drift(x, case):
    hive = x.hive
    if case == "model_drift":
        hive.db.execute("UPDATE agents SET model = 'openrouter/test/other' WHERE id = ?", (x.maker["id"],))
    elif case == "key_drift":
        add_key(hive, "k_0000a002", MIA)
        hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": "k_0000a002"}), x.maker["id"]))
    elif case == "payer_mismatch":
        add_key(hive, "k_0000a003", "user:u_ann")
        hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": "k_0000a003"}), x.maker["id"]))
    elif case == "role_drift":
        hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": KEY, "tools": ["t@1"]}), x.maker["id"]))
    elif case == "maker_busy":
        hive.db.execute("INSERT INTO work_sessions (id, room_id, agent_id, owner, title, status, budget_usd, spent_at_start, "
                        "created_at) VALUES ('ws_busy', 'r_x', ?, 'user:u_quinn', 'other work', 'active', 1, 0, ?)", (x.maker["id"], now()))
    elif case == "budget_exhausted":
        assert x.client.put("/api/me/key-limits/self", headers=x.mia, json={"month_usd": 1.0}).status_code == 200
    elif case == "monthly_total_required":
        hive.db.execute("UPDATE key_limits SET revoked_at = ? WHERE owner = ?", (now(), MIA))
        # a per-key limit never substitutes for the all-keys total (contract §6)
        assert x.client.put("/api/me/key-limits/self", headers=x.mia, json={"month_usd": 5, "key_id": KEY}).status_code == 200
    elif case == "maker_not_member":
        hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (x.team["id"], x.maker["id"]))


@pytest.mark.parametrize("case,status", [("model_drift", 409), ("key_drift", 409), ("payer_mismatch", 409), ("role_drift", 409),
                                         ("maker_busy", 409), ("budget_exhausted", 402), ("monthly_total_required", 402),
                                         ("maker_not_member", 409)])
def test_G1c_a_refused_submit_creates_zero_rows(s, case, status):
    if case == "payer_mismatch":   # the card truthfully showed another person's key: the calls would not be billed to Mia
        _drift(s, case)
        iid = record(s, key_id="k_0000a003").json()["intent_id"]
    elif case == "budget_exhausted":   # the card truthfully showed the 1.0 total (a changed total is a new consent, K10)
        _drift(s, case)
        iid = record(s, monthly=("own_key_limit", 1.0)).json()["intent_id"]
    else:
        iid = record(s).json()["intent_id"]
        _drift(s, case)
    before = counts(s.hive)
    r = submit(s, iid)
    code = "spend_limit" if case == "monthly_total_required" else case
    assert (r.status_code, err(r).get("code")) == (status, code), r.text
    assert counts(s.hive) == before
    rec = s.hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (iid,))
    assert rec["state"] == "refused" and json.loads(rec["last_refusal"])["code"] == code
    if case == "budget_exhausted":
        assert err(r)["scope"].startswith("keyuse:") and err(r)["headroom_usd"] == 1.0
    if case == "monthly_total_required":   # follow-up 4: the exact common envelope, unknown figures null
        assert err(r)["reason"] == "monthly_total_required"
        assert err(r)["limit"] == {"kind": "own_key_limit", "limit_usd": None, "spent_usd": None, "held_usd": None}


def test_G1c_the_maker_named_by_name_is_refused_at_record_and_nothing_is_stored(s):
    before = counts(s.hive)
    r = record(s, maker_id="Maker")
    assert r.status_code == 400 and err(r)["reason"] == "maker_id_not_id"
    assert counts(s.hive) == before


@pytest.mark.parametrize("over", [{"payer": MIA}, {"goal_id": "g_x"}, {"principal": MIA}, {"step_cap_usd": 3.0},
                                  {"cap_usd": 0}, {"piece": {"scene_id": "x", "source_ref": {"artifact_id": "ar_x", "owner": MIA}}}])
def test_G1c_smuggled_authority_or_bad_money_is_refused_at_record(s, over):
    before = counts(s.hive)
    r = record(s, **over)
    assert r.status_code == 400 and err(r)["code"] == "bad_request"
    assert counts(s.hive) == before


def test_G1c_a_second_session_for_the_same_maker_is_busy(s):
    first = submit(s, record(s).json()["intent_id"])
    assert first.status_code == 201
    s.client.post("/api/ask/op-mia-turn-01/stop", headers=s.mia)
    turn(s, op="op-mia-turn-02", who=s.mia, text="another")
    iid = record(s, op="op-mia-turn-02").json()["intent_id"]
    before = counts(s.hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "maker_busy") and counts(s.hive) == before


def test_G1c_the_ask_mind_as_maker_needs_the_cards_exclusivity(s):
    c, hive = s.client, s.hive
    hive.db.execute("UPDATE agents SET swarm_id = ?, model = ?, options = ?, budget_usd = 5 WHERE id = ?",
                    (s.home["id"], MODEL, json.dumps({"key": KEY}), s.asker["id"]))
    hive.db.execute("UPDATE ask_turns SET state = 'answered' WHERE operation_id = 'op-mia-turn-01'")
    iid = record(s, maker_id=s.asker["id"]).json()["intent_id"]
    before = counts(hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "maker_is_coordinator") and counts(hive) == before
    c.post(f"/api/ask/intents/{iid}/abandon", headers=s.mg)
    iid = record(s, maker_id=s.asker["id"], coordinator_exclusive=True, cap_usd=0.2, step_cap_usd=0.1).json()["intent_id"]
    r = submit(s, iid)
    assert r.status_code == 201, r.text


def test_G1c_identity_is_rechecked_at_submit_and_another_person_gets_404(s):
    """Follow-up 3: the transaction-time identity check is a server fence; never another person's bearer."""
    import asyncio
    from hive.core.visibility import Viewer
    iid = record(s).json()["intent_id"]
    assert err(submit(s, iid, who=s.ag)).get("code") == "not_available"          # another (admin) person: 404
    s.hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_mia'")
    before = counts(s.hive)
    assert err(submit(s, iid)).get("code") in ("person_required", "unauthorized")   # the route gate
    with pytest.raises(Exception) as e:                                               # the admission's own re-check
        asyncio.run(s.hive.ask.intents.submit(Viewer(MIA, False), iid, admin=False))
    assert getattr(e.value, "code", None) == "person_required"
    assert counts(s.hive) == before


# ---- the real app-attachment check ---------------------------------------------------------------------------------

def test_G1c_the_real_attachment_check_refuses_an_unattached_app_and_accepts_the_pinned_attachment(s, monkeypatch):
    from hive.core.studio_sessions import StudioSessions
    hive = s.hive
    monkeypatch.setattr(hive.studio, "_app_attached", StudioSessions._app_attached.__get__(hive.studio))
    iid = record(s).json()["intent_id"]
    before = counts(hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "app_not_attached") and counts(hive) == before
    monkeypatch.setattr(hive.programs, "_ready", lambda pid: {"id": pid, "version": PIN["version"], "digest": PIN["digest"]})
    hive.db.execute("INSERT INTO app_activations VALUES ('omegadesign', ?, 1, 'user:u_quinn')", (s.home["id"],))
    hive.db.execute("INSERT INTO app_attachments (id, program, swarm, mind, actor, scope, policy, expires, status, by_person) "
                    "VALUES ('at_1', 'omegadesign', ?, ?, 'mind', '{}', '{}', NULL, 'active', 'user:u_quinn')",
                    (s.home["id"], s.maker["id"]))
    request = studio_request(s)
    assert hive.studio._app_attached(request) is True
    assert hive.studio._app_attached({**request, "app_pin": {**PIN, "version": "0.4.18"}}) is False
    assert submit(s, iid).status_code == 201


# ---- R2.1 (Platform ruling): on the hive's key the monthly total is the person's month allowance ----------------------

def person_rule(hive, scope, usd):
    """A person month rule as the Limits page stores it (Budgets.set's scope pattern wants an 8-hex person id; the
    fixture people are u_mia / u_quinn)."""
    hive.db.insert("budgets", {"id": "b_" + secrets.token_hex(4), "scope": scope, "period": "month", "limit_usd": usd,
                               "note": "", "created_at": now()})


def _hive_key_maker(x):
    x.hive.db.execute("UPDATE agents SET options = '{}' WHERE id = ?", (x.maker["id"],))
    x.hive.db.execute("UPDATE key_limits SET revoked_at = ? WHERE owner = ?", (now(), MIA))   # no own-key total in play


def test_R21_a_member_on_the_hive_key_is_admitted_under_the_member_default_allowance(s):
    _hive_key_maker(s)
    r = submit(s, record(s, key_id="env:openrouter").json()["intent_id"])
    assert r.status_code == 201, r.text
    row = s.hive.db.one("SELECT payer, own_key FROM studio_sessions WHERE id = ?", (r.json()["session_id"],))
    assert (row["payer"], row["own_key"]) == (MIA, 0)


def test_R21_a_cap_that_does_not_fit_the_remaining_allowance_is_refused_with_its_figures(s, monkeypatch):
    _hive_key_maker(s)
    monkeypatch.setenv("HIVE_MEMBER_MONTHLY_USD", "1.5")
    iid = record(s, key_id="env:openrouter", monthly=("member_allowance", 1.5)).json()["intent_id"]
    before = counts(s.hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"], err(r)["reason"]) == (402, "spend_limit", "monthly_total_required"), r.text
    assert err(r)["limit"] == {"kind": "member_allowance", "limit_usd": 1.5, "spent_usd": 0.0, "held_usd": 0.0}
    assert counts(s.hive) == before
    # a person rule replaces the member default; the card the person saw named 1.5, so it is confirmed again (R2.2 K10)
    person_rule(s.hive, "person:u_mia", 3)
    assert err(submit(s, iid))["code"] == "consent_mismatch"
    iid = record(s, key_id="env:openrouter", monthly=("member_allowance", 3.0)).json()["intent_id"]
    assert submit(s, iid).status_code == 201


def test_R21_an_admin_with_no_person_rule_has_no_allowance_until_one_is_set(s):
    _hive_key_maker(s)
    s.client.post("/api/ask/op-mia-turn-01/stop", headers=s.mia)                   # the Ask mind is free for the owner
    turn(s)                                                                         # the owner (a named admin) asks
    body = {"kind": "studio.session", "request": studio_request(s, ("member_allowance", None), key_id="env:openrouter")}
    iid = s.client.post("/api/ask/op-turn-0001/intents", headers=s.jg, json=body).json()["intent_id"]
    before = counts(s.hive)
    r = submit(s, iid, who=s.jg)
    assert (r.status_code, err(r)["code"], err(r)["reason"]) == (402, "spend_limit", "monthly_total_required"), r.text
    assert err(r)["limit"] == {"kind": "member_allowance", "limit_usd": None, "spent_usd": None, "held_usd": None}
    assert counts(s.hive) == before
    person_rule(s.hive, "person:u_quinn", 10)
    body = {"kind": "studio.session", "request": studio_request(s, ("member_allowance", 10.0), key_id="env:openrouter")}
    iid = s.client.post("/api/ask/op-turn-0001/intents", headers=s.jg, json=body).json()["intent_id"]
    assert submit(s, iid, who=s.jg).status_code == 201
