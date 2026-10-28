"""J3 host round R2.2: the five R2 follow-ups of plan r1.1 (PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md, section D2).

- D1: the host mints an opaque stream_id ("as_" + 24 hex) in the admission transaction and returns it everywhere;
- S6.1: a Studio session's goal is not announced (the step message, R3, is the maker's only prompt);
- S4.2: piece.source_ref is validated at admission (owner swarm, Studio's source kind, not bound to another live session);
- K10: the host recomputes the consent payload and compares its digest;
- K1: the person's ledger re-checks swarm visibility;
- r1.3 F4.2: HIVE_STUDIO_SESSIONS (off by default) and the startup self-check; F1.8: execution_binding_unqualified.
Synthetic only: temporary data directories, invented keys, no provider call, no live hive."""
import re
import sys

from hive.tests.test_ask_intents import a, drain, held, release, token_of, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import MIA, MODEL, KEY, counts, err, record, s, studio_request, submit  # noqa: F401


def test_D1a_one_host_minted_stream_id_in_the_201_the_ledger_and_the_event(s):
    c = s.client
    iid = record(s).json()["intent_id"]
    with c.websocket_connect(f"/api/events?token={token_of(s.mia)}") as ws:
        assert ws.receive_json()["type"] == "hello"
        r = submit(s, iid)
        frames = drain(ws)
    assert r.status_code == 201, r.text
    body = r.json()
    stream = body["stream_id"]
    assert re.fullmatch(r"as_[0-9a-f]{24}", stream)
    assert stream[3:] != body["session_id"][3:]                                   # not derived from the sid
    assert c.get(f"/api/studio-sessions/{body['session_id']}", headers=s.mia).json()["stream_id"] == stream
    notices = [f for f in frames if f.get("type") == "studio.session"]
    assert [n["stream_id"] for n in notices] == [stream]
    row = s.hive.db.one("SELECT stream_id FROM studio_sessions WHERE id = ?", (body["session_id"],))
    assert row["stream_id"] == stream
    again = submit(s, iid)                                                         # a lost response replays the same id
    assert again.content == r.content


def test_D1b_a_request_carrying_a_stream_id_is_refused_at_record_and_nothing_is_stored(s):
    before = counts(s.hive)
    r = record(s, stream_id="as_" + "0" * 24)
    assert r.status_code == 400 and err(r)["code"] == "bad_request"
    assert counts(s.hive) == before


def test_S6_1_the_studio_goal_is_not_announced_to_anyone(s):
    import asyncio
    hive = s.hive
    before = hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"]
    body = submit(s, record(s).json()["intent_id"]).json()
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"] == before
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (body["goal_id"],))
    asyncio.run(hive.goals.announce(goal))                                         # the guard is in announce itself too
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"] == before


def _source(x, swarm_id, kind="studio-source"):
    return x.hive.collab.create_artifact({"id": x.maker["id"], "swarm_id": swarm_id}, {"kind": kind, "title": "Poster"},
                                         principal=MIA)


def test_S4a_a_foreign_or_wrong_kind_source_is_refused_at_admission_with_zero_rows(s):
    for art in (_source(s, s.team["id"]), _source(s, s.home["id"], kind="plan"), {"id": "ar_missing"}):
        iid = record(s, piece={"scene_id": "scene-1", "source_ref": {"artifact_id": art["id"]}}).json()["intent_id"]
        before = counts(s.hive)
        r = submit(s, iid)
        assert (r.status_code, err(r)["code"]) == (409, "source_not_bindable"), r.text
        assert counts(s.hive) == before


def test_S4a_a_validated_source_is_bound_on_the_session(s):
    art = _source(s, s.home["id"])
    r = submit(s, record(s, piece={"scene_id": "scene-1", "source_ref": {"artifact_id": art["id"]}}).json()["intent_id"])
    assert r.status_code == 201, r.text
    ledger = s.client.get(f"/api/studio-sessions/{r.json()['session_id']}", headers=s.mia).json()
    assert ledger["source_artifact_id"] == art["id"]


def test_S4b_the_source_of_another_live_session_is_refused(s):
    hive = s.hive
    art = _source(s, s.home["id"])
    piece = {"scene_id": "scene-1", "source_ref": {"artifact_id": art["id"]}}
    first = submit(s, record(s, piece=piece).json()["intent_id"]).json()["session_id"]
    # the same source bound by a live session of another person (Mia herself is held to one live session, below)
    hive.db.execute("UPDATE studio_sessions SET principal = 'user:u_ann', maker_id = 'a_0000beef' WHERE id = ?", (first,))
    iid = record(s, piece=piece).json()["intent_id"]
    before = counts(hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "source_not_bindable"), r.text
    assert counts(hive) == before


def test_K10_a_card_that_differs_from_the_hosts_recomputed_consent_is_refused(s):
    from hive.tests.test_studio_session_g1 import consent_of
    hive = s.hive
    shown = studio_request(s)
    other = consent_of({**shown, "cap_usd": 1.0}, ("own_key_limit", 10.0))        # the card showed a different cap
    iid = record(s, consent_digest=other).json()["intent_id"]
    before = counts(hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "consent_mismatch"), r.text
    assert err(r)["consent_digest"] == shown["consent_digest"] and err(r)["consent"]["cap_micros"] == 2_000_000
    assert counts(hive) == before
    # the monthly figure is part of what was confirmed: a total changed after the card needs a new confirmation
    iid = record(s).json()["intent_id"]
    assert s.client.put("/api/me/key-limits/self", headers=s.mia, json={"month_usd": 9}).status_code == 200
    before = counts(hive)
    assert err(submit(s, iid))["code"] == "consent_mismatch" and counts(hive) == before


def test_K1_the_ledger_rechecks_that_the_person_still_sees_the_swarm(s):
    c = s.client
    sid = submit(s, record(s).json()["intent_id"]).json()["session_id"]
    assert c.get(f"/api/studio-sessions/{sid}", headers=s.mia).status_code == 200
    assert c.put(f"/api/swarms/{s.home['id']}/visibility", json={"visibility": "private"}).status_code == 200
    r = c.get(f"/api/studio-sessions/{sid}", headers=s.mia)
    assert (r.status_code, err(r).get("code")) == (404, "not_available")


# ---- plan r1.2 E6.2: the consent-payload version; E2(a): the execution fence check in admission ----------------------

def test_E6_2_a_live_R2_consent_row_is_held_as_consent_legacy_at_startup_and_a_v2_row_is_not(s):
    from hive.core import exclusive
    hive = s.hive
    v2 = submit(s, record(s).json()["intent_id"]).json()["session_id"]
    assert hive.db.one("SELECT consent_payload_version FROM studio_sessions WHERE id = ?", (v2,))["consent_payload_version"] == 2
    # a row as R2's schema wrote it: the column default (1), a client-supplied digest
    row = dict(hive.db.one("SELECT * FROM studio_sessions WHERE id = ?", (v2,)))
    legacy = {**row, "id": "ss_" + "1" * 24, "intent_id": "ai_legacy", "goal_id": "g_legacy",
              "proposal_artifact_id": "ar_legacy", "stream_id": "as_" + "1" * 24, "maker_id": "a_00000000", "principal": "user:u_ann"}
    legacy.pop("consent_payload_version")
    hive.db.insert("studio_sessions", legacy)
    holder = held(hive.settings.data_dir)
    try:
        assert exclusive.startup_recovery(holder, hive)["studio"] == 1
    finally:
        release(holder)
    rows = {r["id"]: r for r in hive.db.all("SELECT id, state, state_reason, consent_payload_version FROM studio_sessions")}
    assert (rows[legacy["id"]]["state"], rows[legacy["id"]]["state_reason"], rows[legacy["id"]]["consent_payload_version"]) \
        == ("held", "consent_legacy", 1)
    assert (rows[v2]["state"], rows[v2]["state_reason"]) == ("active", None)


# ---- Kimi R2 P2-1: one live session per person; stand-in R2 P1: admission is inert ------------------------------------

def _second_maker(x):
    return x.client.post("/api/agents", json={"name": "Maker 2", "swarm_id": x.home["id"], "model": MODEL, "budget_usd": 5,
                                              "options": {"key": KEY}}).json()


def test_P2_1_a_person_cannot_stack_a_second_live_session_on_another_maker(s):
    assert submit(s, record(s).json()["intent_id"]).status_code == 201
    second = _second_maker(s)
    s.client.post("/api/ask/op-mia-turn-01/stop", headers=s.mia)
    turn(s, op="op-mia-turn-02", who=s.mia, text="another")
    iid = record(s, op="op-mia-turn-02", maker_id=second["id"]).json()["intent_id"]
    before = counts(s.hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "person_session_live"), r.text
    assert counts(s.hive) == before


def test_P2_1_two_admissions_racing_past_the_pre_check_end_at_the_person_index(s, monkeypatch):
    """The race: both submits see no live session (the pre-check is stubbed to see none, as two transactions on
    different connections would), and the second commit hits the live-person index."""
    hive = s.hive
    assert submit(s, record(s).json()["intent_id"]).status_code == 201
    second = _second_maker(s)
    s.client.post("/api/ask/op-mia-turn-01/stop", headers=s.mia)
    turn(s, op="op-mia-turn-02", who=s.mia, text="another")
    iid = record(s, op="op-mia-turn-02", maker_id=second["id"]).json()["intent_id"]
    real_one = hive.db.one

    def blind(sql, params=()):
        if "FROM studio_sessions WHERE principal = ?" in sql:
            return None
        return real_one(sql, params)
    monkeypatch.setattr(hive.db, "one", blind)
    before = counts(s.hive)
    r = submit(s, iid)
    monkeypatch.setattr(hive.db, "one", real_one)
    assert (r.status_code, err(r)["code"]) == (409, "person_session_live"), r.text
    assert counts(s.hive) == before


def test_P5_coordinator_exclusive_is_bound_by_the_host_consent_payload(s):
    from hive.tests.test_studio_session_g1 import consent_of
    hive = s.hive
    hive.db.execute("UPDATE agents SET swarm_id = ?, model = ?, options = ?, budget_usd = 5 WHERE id = ?",
                    (s.home["id"], MODEL, '{"key": "%s"}' % KEY, s.asker["id"]))
    hive.db.execute("UPDATE ask_turns SET state = 'answered' WHERE operation_id = 'op-mia-turn-01'")
    shown = studio_request(s, maker_id=s.asker["id"])                       # the card did not offer exclusivity
    iid = record(s, maker_id=s.asker["id"], coordinator_exclusive=True,
                 consent_digest=consent_of(shown, ("own_key_limit", 10.0))).json()["intent_id"]
    before = counts(hive)
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (409, "consent_mismatch") and err(r)["consent"]["coordinator_exclusive"] is True
    assert counts(hive) == before


def test_standin_P1_submit_wakes_no_one_sends_nothing_and_the_maker_cannot_spend(s, monkeypatch):
    hive = s.hive
    hive.db.execute("UPDATE agents SET status = 'asleep' WHERE id = ?", (s.maker["id"],))
    woken = []
    monkeypatch.setattr(hive, "lifecycle", lambda agent_id, action, expect=None: woken.append((agent_id, action)))
    messages = hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"]
    body = submit(s, record(s).json()["intent_id"]).json()
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages")["n"] == messages and woken == []
    # no step exists in R2.2: any paid call from the maker is refused before a reservation exists
    token = hive.db.one("SELECT * FROM agents WHERE id = ?", (s.maker["id"],))
    from hive.tests.test_studio_session_g1 import err as error_of
    reservations = hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"]
    r = s.client.post("/llm/v1/chat/completions", headers={"Authorization": f"Bearer {s.maker['token']}"},
                      json={"messages": [{"role": "user", "content": "draw"}], "max_tokens": 10})
    assert (r.status_code, error_of(r)["code"]) == (409, "studio_step_closed"), r.text
    assert error_of(r)["session_id"] == body["session_id"] and token is not None
    assert hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == reservations


# ---- plan r1.3 F4.2: Studio is off until the whole paid path exists; F1.8: a supervisor-managed maker ----------------

def test_F4a_studio_is_off_by_default_and_record_and_submit_are_404_with_zero_rows(s, monkeypatch):
    hive = s.hive
    iid = record(s).json()["intent_id"]                                   # recorded while the fixture's build is "on"
    monkeypatch.setattr(hive.studio, "enabled", False)
    before = counts(hive)
    r = record(s, title="Another")
    assert (r.status_code, err(r)["code"]) == (404, "not_available")
    r = submit(s, iid)
    assert (r.status_code, err(r)["code"]) == (404, "not_available")
    assert counts(hive) == before
    assert hive.db.one("SELECT state FROM ask_intents WHERE id = ?", (iid,))["state"] == "pending"


def test_F4a_the_setting_alone_cannot_turn_studio_on_while_the_build_lacks_its_parts(s, monkeypatch):
    studio = s.hive.studio
    monkeypatch.delenv("HIVE_STUDIO_SESSIONS", raising=False)
    assert studio.self_check()[0] is False                                # default off
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    enabled, missing = studio.self_check()
    # R3 built the step plane, the fence table and token rotation; R4 the gateway reservation hook and SEND_GATE; R5 the
    # pause and resume controls. On a Mac only the reviewed safe-restart override is still missing (none adopted)
    from hive.core import studio_sessions as SS
    monkeypatch.setattr(SS, "host_platform", lambda: "darwin")
    enabled, missing = studio.self_check()
    assert enabled is False and missing == ["mac safe-restart exact-commit override"]
    assert "gateway session/execution hook" not in missing and "SEND_GATE session wiring" not in missing
    assert "studio_sessions table" not in missing
    # only a build with every part passes (stand-in for R5's qualified build)
    monkeypatch.setattr(studio, "components", lambda: {"all": True})
    assert studio.self_check() == (True, [])
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "off")
    assert studio.self_check()[0] is False


def test_F4a_a_freshly_built_hive_has_studio_off_even_with_the_setting_on(monkeypatch, tmp_path):
    import pathlib
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "1")
    app = create_app(load_settings(data_dir=pathlib.Path(tmp_path), admin_password="pw", petta_path=PETTA),
                     supervisor=FakeSupervisor(), reconcile_seconds=0)
    studio = app.state.hive.studio
    # R5: every part is in this build; on a Mac host the reviewed safe-restart override is still missing, so the setting
    # alone cannot turn Studio on there (off a Mac it can: test_studio_session_r5.py)
    if sys.platform == "darwin":
        assert studio.enabled is False and studio.missing == ["mac safe-restart exact-commit override"]
    else:
        assert studio.enabled is True and studio.missing == []


def test_F1_8_a_maker_the_supervisor_cannot_restart_is_refused_with_zero_rows(s, monkeypatch):
    from hive.core.studio_sessions import StudioSessions
    from hive.supervisor.drivers import Driver
    hive = s.hive
    monkeypatch.setattr(hive.studio, "execution_qualified", StudioSessions.execution_qualified.__get__(hive.studio))
    iid = record(s).json()["intent_id"]
    before = counts(hive)
    r = submit(s, iid)                                                    # the test supervisor has no drivers at all
    assert (r.status_code, err(r)["code"]) == (409, "execution_binding_unqualified"), r.text
    assert counts(hive) == before

    class NoEvidence(Driver):                                             # can stop and start, gives no boundary evidence
        def start(self, agent, env): ...
        def stop(self, agent_id): ...

    class Managed(NoEvidence):
        def execution(self, agent_id):
            return "pid:1"
    driver = s.maker.get("driver") or hive.settings.default_driver
    monkeypatch.setattr(hive.supervisor, "drivers", {driver: NoEvidence()}, raising=False)
    assert hive.studio.execution_qualified(hive.agent(s.maker["id"])) is False
    monkeypatch.setattr(hive.supervisor, "drivers", {driver: Managed()}, raising=False)
    assert submit(s, record(s).json()["intent_id"]).status_code == 201


# ---- R2.3 (stand-in R2.2 P1): upgrading a hive whose R2 rows give one person two live sessions -------------------------

# the studio_sessions table exactly as R2/R2.1 (f1bb1475) created it
R2_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS studio_sessions (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, principal TEXT NOT NULL,
  ask_turn_id TEXT NOT NULL, thread_id TEXT, swarm_id TEXT NOT NULL, program_id TEXT NOT NULL, app_pin TEXT NOT NULL,
  maker_id TEXT NOT NULL, goal_id TEXT NOT NULL UNIQUE, proposal_artifact_id TEXT NOT NULL UNIQUE, piece TEXT NOT NULL,
  payer TEXT NOT NULL, own_key INTEGER NOT NULL, key_id TEXT NOT NULL, model TEXT NOT NULL, role_id TEXT, tools TEXT NOT NULL,
  cap_usd REAL NOT NULL, step_cap_usd REAL NOT NULL, step_window_s INTEGER NOT NULL, max_steps INTEGER NOT NULL,
  expires_at TEXT NOT NULL, consent_digest TEXT NOT NULL, state TEXT NOT NULL, state_reason TEXT,
  next_dir_seq INTEGER NOT NULL DEFAULT 1, receiver_generation INTEGER NOT NULL DEFAULT 0, stop_control_id TEXT,
  fenced_at TEXT, stopped_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    "CREATE UNIQUE INDEX IF NOT EXISTS studio_sessions_live_maker ON studio_sessions(maker_id) "
    "WHERE state IN ('active', 'paused', 'stopping')",
    "CREATE INDEX IF NOT EXISTS studio_sessions_principal ON studio_sessions(principal, created_at)",
]


def test_R23_a_hive_with_two_live_R2_sessions_for_one_person_starts_and_both_are_held(tmp_path):
    import pathlib
    import sqlite3
    from hive.core import exclusive
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    data = pathlib.Path(tmp_path)
    con = sqlite3.connect(data / "hive.db")
    for statement in R2_SCHEMA:
        con.execute(statement)
    for n, maker in ((1, "a_0000aaa1"), (2, "a_0000aaa2")):               # valid under R2: one person, two makers
        con.execute("INSERT INTO studio_sessions (id, intent_id, principal, ask_turn_id, swarm_id, program_id, app_pin, maker_id, "
                    "goal_id, proposal_artifact_id, piece, payer, own_key, key_id, model, tools, cap_usd, step_cap_usd, "
                    "step_window_s, max_steps, expires_at, consent_digest, state, created_at, updated_at) VALUES "
                    "(?, ?, ?, 't_1', 's_00000001', 'omegadesign', '{}', ?, ?, ?, '{}', ?, 1, 'k_0000a001', 'm', '[]', 2, 0.25, "
                    "180, 12, '2026-10-18T00:00:00.000Z', ?, 'active', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z')",
                    (f"ss_{n:024d}", f"ai_{n}", MIA, maker, f"g_{n}", f"ar_{n}", MIA, "sha256:" + "c" * 64))
    con.commit()
    con.close()
    app = create_app(load_settings(data_dir=data, admin_password="pw", petta_path=PETTA),
                     supervisor=FakeSupervisor(), reconcile_seconds=0)               # the hive starts
    hive = app.state.hive
    assert hive.studio.index_failures == [] and hive.studio.enabled is False
    holder = held(data)
    try:
        assert exclusive.startup_recovery(holder, hive)["studio"] == 2
    finally:
        release(holder)
    rows = hive.db.all("SELECT state, state_reason, consent_payload_version FROM studio_sessions ORDER BY id")
    assert [(r["state"], r["state_reason"], r["consent_payload_version"]) for r in rows] == \
        [("held", "consent_legacy", 1), ("held", "consent_legacy", 1)]                # every row kept, none rewritten


def test_R23_an_index_existing_rows_contradict_never_stops_startup_and_keeps_studio_off(tmp_path, monkeypatch):
    import pathlib
    from hive.core import studio_sessions
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    data = pathlib.Path(tmp_path)
    create_app(load_settings(data_dir=data, admin_password="pw", petta_path=PETTA), supervisor=FakeSupervisor(),
               reconcile_seconds=0)
    import sqlite3
    monkeypatch.setattr(studio_sessions, "INDEXES", studio_sessions.INDEXES + [
        "CREATE UNIQUE INDEX IF NOT EXISTS studio_test_one_row ON studio_sessions(program_id)"])
    # seed two rows with one program id, then rebuild: the contradicted index is reported, startup goes on
    con = sqlite3.connect(data / "hive.db")
    cols = "intent_id, principal, ask_turn_id, swarm_id, program_id, app_pin, maker_id, goal_id, proposal_artifact_id, piece, " \
           "stream_id, payer, own_key, key_id, model, tools, cap_usd, step_cap_usd, step_window_s, max_steps, expires_at, " \
           "consent_digest, state, created_at, updated_at, id"
    for n in (1, 2):
        con.execute(f"INSERT INTO studio_sessions ({cols}) VALUES (?, 'user:u_x', 't', 's', 'p', '{{}}', ?, ?, ?, '{{}}', ?, "
                    "'user:u_x', 1, 'k', 'm', '[]', 2, 0.25, 180, 1, 'x', 'x', 'stopped', 'x', 'x', ?)",
                    (f"ai_{n}", f"a_{n}", f"g_{n}", f"ar_{n}", f"as_{n}", f"ss_{n}"))
    con.commit()
    con.close()
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    app = create_app(load_settings(data_dir=data, admin_password="pw", petta_path=PETTA), supervisor=FakeSupervisor(),
                     reconcile_seconds=0)
    studio = app.state.hive.studio
    assert studio.index_failures == ["studio_test_one_row"]
    assert studio.enabled is False and "studio_sessions unique indexes" in studio.missing


# ---- R2.4 (stand-in R2.3 P1): held or legacy sessions never block a mind's ordinary paid work --------------------------

def test_R24_a_maker_whose_R2_session_was_held_as_legacy_makes_ordinary_paid_calls_again(s):
    from hive.core import exclusive
    hive, c = s.hive, s.client
    sid = submit(s, record(s).json()["intent_id"]).json()["session_id"]
    # as an R2 hive left it: a live session with the R2 consent meaning (version 1), for this maker
    hive.db.execute("UPDATE studio_sessions SET consent_payload_version = 1 WHERE id = ?", (sid,))
    holder = held(hive.settings.data_dir)
    try:
        assert exclusive.startup_recovery(holder, hive)["studio"] == 1
    finally:
        release(holder)
    assert hive.db.one("SELECT state, state_reason FROM studio_sessions WHERE id = ?", (sid,))["state_reason"] == "consent_legacy"
    mock = c.post("/api/agents", json={"name": "Probe", "swarm_id": s.home["id"]}).json()["model"]
    hive.db.execute("UPDATE agents SET model = ?, options = '{}' WHERE id = ?", (mock, s.maker["id"]))   # offline model
    for enabled in (False, True):                                           # Studio off (the shipped state), and on
        hive.studio.enabled = enabled
        r = c.post("/llm/v1/chat/completions", headers={"Authorization": f"Bearer {s.maker['token']}"},
                   json={"messages": [{"role": "user", "content": "no news"}]})
        assert r.status_code == 200, r.text
    assert hive.db.one("SELECT state FROM studio_sessions WHERE id = ?", (sid,))["state"] == "held"   # the row is kept


def test_R24_with_studio_off_no_maker_is_fenced_even_with_a_live_session(s):
    hive, c = s.hive, s.client
    submit(s, record(s).json()["intent_id"])
    mock = c.post("/api/agents", json={"name": "Probe", "swarm_id": s.home["id"]}).json()["model"]
    hive.db.execute("UPDATE agents SET model = ?, options = '{}' WHERE id = ?", (mock, s.maker["id"]))
    hive.studio.enabled = False
    r = c.post("/llm/v1/chat/completions", headers={"Authorization": f"Bearer {s.maker['token']}"},
               json={"messages": [{"role": "user", "content": "no news"}]})
    assert r.status_code == 200, r.text
    hive.studio.enabled = True                                              # on: a live v2 session still fences
    r = c.post("/llm/v1/chat/completions", headers={"Authorization": f"Bearer {s.maker['token']}"},
               json={"messages": [{"role": "user", "content": "no news"}]})
    assert (r.status_code, err(r)["code"]) == (409, "studio_step_closed")
