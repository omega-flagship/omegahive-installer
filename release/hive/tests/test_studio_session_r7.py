"""J3 host round R7: every member's own Studio maker, on their own key (hive/core/studio_makers.py).

the owner 2026-10-19: "everyone needs studio, they just need to use their own keys"; "Yes: each member gets their own Studio maker
mind that runs on their own key. Build it."
- POST /api/studio/setup makes the person's maker on demand (kind omega, the reviewed template's role/prompt/tools, the
  HIVE_STUDIO_MAKER_MODEL model, options.key = their own key), attaches it to the Studio app (the host's one audited
  exception to admin-only attachment) and returns the setup card; a second setup reuses it and re-resolves the key.
- A studio.session request without maker_id takes the person's maker from its binding; another person's maker is refused.
- No own key: 402 own_key_needed, nothing made, attached or reserved. Studio off: nothing made, attached or changed.
Synthetic only: temporary data directories, the R3 fake process driver and stand-in hub, a scripted provider (R4), invented
keys, no provider call, no live hive."""
import json
import time
import types

import pytest

import hive.tests.test_studio_session_r3 as R3
from hive.core.studio_sessions import StudioSessions
from hive.tests.test_studio_session_r3 import (drive, mount, outcome, r3, ses_row, step_row, token_now,  # noqa: F401
                                               upload)
from hive.tests.test_studio_session_r3_handoff import control, stopped_and_released, wait_for  # noqa: F401
from hive.tests.test_studio_session_r4 import PRICE, Transport, chat, reservations_of  # noqa: F401
from hive.tests.test_studio_session_r6 import ChannelHub, ch, fields, load_bridge  # noqa: F401
from hive.tests.test_ask_intents import ORIGIN, a, held, release, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, MODEL, PIN, add_key, err, record, s, submit  # noqa: F401

BOB = "user:u_bob"
BOB_KEY = "k_0000b0b1"
ANN_KEY = "k_0000a0a1"
PROGRAM = "omegadesign"
CARD = {"title": "Poster for Elm Street", "detail": "A poster for the street party",
        "piece": {"scene_id": R3.SCENE, "source_ref": None}, "max_steps": 12, "window_minutes": 60}


def studio_entry(hooks=False):
    module = types.SimpleNamespace()
    if hooks:
        module.offer = module.bind = module.unbind = lambda *a: None
    return {"id": PROGRAM, "name": "OmegaDesign", "version": PIN["version"], "digest": PIN["digest"], "module": module,
            "describe": {"actions": [{"id": "trace", "agents": True}, {"id": "save-source", "agents": False}]}}


def tables(hive):
    names = ("agents", "swarms", "person_minds", "app_attachments", "app_activations", "cost_reservations", "studio_sessions",
             "goals", "studio_maker_audit")
    have = {r["name"] for r in hive.db.all("SELECT name FROM sqlite_master WHERE type = 'table'")}
    return {t: (hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] if t in have else 0) for t in names}


def personal_world(x, monkeypatch):
    """The reviewed template (an Omega Design maker with a role, a prompt and a budget), the host settings naming it and
    the maker model, the Studio app loaded hook-free at the pinned version (as the live omegadesign is), and the REAL
    attachment check (the G1 fixture stubs it). Bob is a second member with his own key; Ann's key is the provider default."""
    hive, c = x.hive, x.client
    role = c.post("/api/roles", json={"name": "Design Director", "prompt": "Direct the piece."}).json()
    x.template = c.post("/api/agents", json={"name": "Design creative-director", "swarm_id": x.home["id"], "model": MODEL,
                                             "budget_usd": 5, "persona": "You are the creative director.",
                                             "role_id": role["id"]}).json()
    x.role = role
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", x.template["id"])
    monkeypatch.setenv("HIVE_STUDIO_MAKER_MODEL", MODEL)
    real_ready = hive.programs._ready
    x.entry = studio_entry()
    monkeypatch.setattr(hive.programs, "_ready", lambda pid: x.entry if pid == PROGRAM else real_ready(pid))
    monkeypatch.setattr(hive.studio, "_app_attached", StudioSessions._app_attached.__get__(hive.studio))
    x.bob = {**person(hive, "u_bob", role="member"), **ORIGIN}
    add_key(hive, BOB_KEY, BOB)
    add_key(hive, ANN_KEY, "user:u_ann")
    hive.keyring.ring.setdefault("defaults", {})["openrouter"] = ANN_KEY
    assert c.put("/api/me/key-limits/self", headers=x.bob, json={"month_usd": 10}).status_code == 200
    return x


@pytest.fixture()
def p(s, monkeypatch):
    return personal_world(s, monkeypatch)


def setup(x, who=None, request=None):
    return x.client.post("/api/studio/setup", headers=who or x.mg, json={} if request is None else {"request": request})


def card(x, who=None, **over):
    r = setup(x, who, {**CARD, **over})
    assert r.status_code == 200, r.text
    return r.json()


def record_card(x, the_card, who=None, op="op-mia-turn-01", omit=("maker_id", "swarm_id")):
    request = {k: v for k, v in the_card["request"].items() if k not in omit}
    return x.client.post(f"/api/ask/{op}/intents", headers=who or x.mg, json={"kind": "studio.session", "request": request})


def maker_of(x, principal=MIA):
    b = x.hive.db.one("SELECT agent_id FROM person_minds WHERE principal = ? AND purpose = 'studio_maker'", (principal,))
    return x.hive.db.one("SELECT * FROM agents WHERE id = ?", (b["agent_id"],)) if b and b["agent_id"] else None


# ---- 1. made on demand, then reused -------------------------------------------------------------------------------------

def test_R7_first_setup_creates_the_maker_kind_omega_on_her_own_key_attached_asleep_and_a_second_setup_reuses_it(p):
    hive = p.hive
    before = tables(hive)
    r = setup(p)
    assert r.status_code == 200, r.text
    view = r.json()["maker"]
    m = maker_of(p)
    assert view["id"] == m["id"] and view["created"] is True and view["own_key"] is True and view["key_id"] == KEY
    assert (m["kind"], m["model"], m["owner"], m["visibility"], m["status"]) == ("omega", MODEL, MIA, "private", "asleep")
    options = json.loads(m["options"])
    assert options == {"key": KEY}                                        # her own key; the template has no tools
    assert (m["role_id"], m["persona"], m["budget_usd"]) == (p.role["id"], "You are the creative director.", 5.0)
    home = hive.db.one("SELECT * FROM swarms WHERE id = ?", (m["swarm_id"],))
    assert (home["owner"], home["visibility"], home["personal_of"]) == (MIA, "private", None)
    att = hive.db.one("SELECT * FROM app_attachments WHERE mind = ?", (m["id"],))
    assert (att["program"], att["status"], att["swarm"], att["by_person"]) == (PROGRAM, "active", m["swarm_id"], MIA)
    assert att["request_key"] == f"host:studio_maker:{m['id']}" and view["attachment_id"] == att["id"]
    assert hive.db.one("SELECT COUNT(*) AS n FROM app_activations")["n"] == 0    # never a global "attachments required"
    assert [r["action"] for r in hive.db.all("SELECT action FROM studio_maker_audit WHERE agent_id = ? ORDER BY rowid",
                                             (m["id"],))] == ["created", "attached"]
    after = tables(hive)
    assert (after["agents"], after["swarms"], after["person_minds"], after["app_attachments"]) == (
        before["agents"] + 1, before["swarms"] + 1, before["person_minds"] + 1, before["app_attachments"] + 1)
    assert after["cost_reservations"] == before["cost_reservations"]
    # the second setup reuses it: nothing new
    again = setup(p).json()["maker"]
    assert again["id"] == m["id"] and again["created"] is False and tables(hive) == after
    # Bob (another member) does not see it; Mia does; the admin views do
    ids = lambda who: {a["id"] for a in p.client.get("/api/agents", headers=who).json()}
    assert m["id"] not in ids(p.bob) and m["id"] in ids(p.mg) and m["id"] in ids(p.jg)


def test_R7_the_setup_card_is_the_full_request_with_the_hosts_consent_and_digest(p):
    c = card(p)
    m = maker_of(p)
    req = c["request"]
    assert (req["maker_id"], req["swarm_id"], req["program_id"], req["app_pin"]) == (m["id"], m["swarm_id"], PROGRAM, PIN)
    assert (req["key_id"], req["model"], req["role_id"], req["tools"]) == (KEY, MODEL, p.role["id"], [])
    assert c["consent"]["payer"] == "own_key" and c["consent"]["monthly"] == {"kind": "own_key_limit", "limit_micros": 10_000_000}
    from hive.core.studio_sessions import consent_digest
    assert c["consent_digest"] == req["consent_digest"] == consent_digest(c["consent"])
    assert c["maker_name"] == m["name"] and c["key_label"] == KEY
    bad = setup(p, request={**CARD, "key_id": BOB_KEY})
    assert (bad.status_code, err(bad)["code"]) == (400, "bad_request")      # the hive derives key, maker, model...


# ---- 2. no own key: refused, nothing made ---------------------------------------------------------------------------------

@pytest.mark.parametrize("default", ["ann", "env"])
def test_R7_no_own_key_is_402_own_key_needed_with_nothing_created_attached_or_reserved(p, default):
    hive = p.hive
    del hive.keyring.ring["keys"][KEY]                                    # Mia has no key of her own
    if default == "env":
        hive.keyring.ring["defaults"].pop("openrouter", None)             # a hive key would pay; it must not be used
    before = tables(hive)
    for request in (None, CARD):
        r = setup(p, request=request)
        assert (r.status_code, err(r)["code"]) == (402, "own_key_needed")
        assert "Add your own key in Keys" in err(r)["message"]
    assert tables(hive) == before and maker_of(p) is None
    # recording without a maker finds none and stores nothing
    r = p.client.post("/api/ask/op-mia-turn-01/intents", headers=p.mg,
                      json={"kind": "studio.session", "request": {**CARD, "consent_digest": "sha256:" + "c" * 64}})
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_missing")
    assert tables(hive) == before


# ---- 3. someone else's maker, and the shared maker -----------------------------------------------------------------------

def test_R7_another_members_maker_named_explicitly_is_refused_at_record_and_at_admission(p, monkeypatch):
    hive = p.hive
    mias = card(p)
    bobs = setup(p, p.bob).json()["maker"]                                # Bob's own maker (setup needs no Ask turn)
    assert bobs["id"] != mias["request"]["maker_id"]
    stolen = {**mias["request"], "maker_id": bobs["id"], "swarm_id": bobs["swarm_id"]}
    before = tables(hive)
    r = p.client.post("/api/ask/op-mia-turn-01/intents", headers=p.mg, json={"kind": "studio.session", "request": stolen})
    assert (r.status_code, err(r)["code"]) == (409, "maker_not_yours") and tables(hive) == before
    # an admin is refused too: a personal maker is its person's alone
    with pytest.raises(Exception) as e:
        hive.studio.refuse_others_maker("user:u_quinn", bobs["id"])
    assert e.value.code == "maker_not_yours"
    hive.studio.refuse_others_maker(BOB, bobs["id"])                      # his own: fine
    hive.studio.refuse_others_maker(MIA, p.maker["id"])                   # a shared maker: not affected
    # and admission refuses it on its own (an intent recorded past the record check, its swarm made visible)
    with monkeypatch.context() as mp:
        mp.setattr(hive.studio, "refuse_others_maker", lambda *a: None)
        iid = p.client.post("/api/ask/op-mia-turn-01/intents", headers=p.mg,
                            json={"kind": "studio.session", "request": stolen}).json()["intent_id"]
    hive.db.execute("UPDATE swarms SET visibility = 'public' WHERE id = ?", (bobs["swarm_id"],))
    before = tables(hive)
    r = submit(p, iid)
    assert (r.status_code, err(r)["code"]) == (409, "maker_not_yours"), r.text
    assert tables(hive) == before


def test_R7_the_admin_attached_shared_maker_still_admits_unchanged(p):
    hive = p.hive
    hive.db.execute("INSERT INTO app_activations VALUES (?, ?, 1, 'user:u_quinn')", (PROGRAM, p.home["id"]))
    hive.db.execute("INSERT INTO app_attachments (id, program, swarm, mind, actor, scope, policy, expires, status, by_person) "
                    "VALUES ('at_shared', ?, ?, ?, 'mind', '{}', '{}', NULL, 'active', 'user:u_quinn')",
                    (PROGRAM, p.home["id"], p.maker["id"]))
    r = submit(p, record(p).json()["intent_id"])                           # explicit maker_id: the G1 request
    assert r.status_code == 201, r.text
    assert r.json()["maker_id"] == p.maker["id"] and maker_of(p) is None   # no personal maker made for it


def test_R7_without_an_activation_the_shared_maker_is_still_not_attached(p):
    """The relaxed activation rule is the personal maker's only: a shared maker with a row but no activation is refused."""
    p.hive.db.execute("INSERT INTO app_attachments (id, program, swarm, mind, actor, scope, policy, expires, status, by_person) "
                      "VALUES ('at_shared', ?, ?, ?, 'mind', '{}', '{}', NULL, 'active', 'user:u_quinn')",
                      (PROGRAM, p.home["id"], p.maker["id"]))
    r = submit(p, record(p).json()["intent_id"])
    assert (r.status_code, err(r)["code"]) == (409, "app_not_attached")


# ---- 4. a key change: key_drift, then a fresh card admits -------------------------------------------------------------------

def test_R7_a_key_change_gives_key_drift_then_a_fresh_card_admits_on_the_new_key(p):
    hive = p.hive
    old = card(p)
    iid = record_card(p, old).json()["intent_id"]
    # Mia replaces her key: the old one is removed, a new one added
    del hive.keyring.ring["keys"][KEY]
    add_key(hive, "k_0000a002", MIA)
    r = submit(p, iid)
    assert (r.status_code, err(r)["code"]) == (409, "key_drift")
    assert hive.db.one("SELECT COUNT(*) AS n FROM studio_sessions")["n"] == 0
    fresh = card(p)                                                       # the next setup re-resolves the key
    assert fresh["request"]["key_id"] == "k_0000a002" and fresh["maker"]["created"] is False
    assert json.loads(maker_of(p)["options"])["key"] == "k_0000a002"
    assert hive.db.one("SELECT action FROM studio_maker_audit WHERE action = 'resolved'") is not None
    r = submit(p, record_card(p, fresh).json()["intent_id"])
    assert r.status_code == 201, r.text
    row = hive.db.one("SELECT * FROM studio_sessions")
    assert (row["key_id"], row["payer"], row["own_key"], row["maker_id"]) == ("k_0000a002", MIA, 1, maker_of(p)["id"])


def test_R7_a_new_own_default_key_is_preferred_and_the_maker_never_takes_anyone_elses(p):
    hive = p.hive
    card(p)
    add_key(hive, "k_0000a003", MIA)
    hive.keyring.ring["defaults"]["openrouter"] = "k_0000a003"           # her own key is now the provider default
    assert card(p)["request"]["key_id"] == "k_0000a003"
    hive.keyring.ring["defaults"]["openrouter"] = BOB_KEY                 # someone else's default never pays for her
    assert card(p)["request"]["key_id"] == KEY                           # her earliest own key


# ---- 5. Studio off -----------------------------------------------------------------------------------------------------

def test_R7_pin_with_studio_off_nothing_is_created_attached_or_changed_for_anyone(p, monkeypatch):
    hive = p.hive
    monkeypatch.setattr(hive.studio, "enabled", False)
    before = tables(hive)
    for request in (None, CARD):
        r = setup(p, request=request)
        assert (r.status_code, err(r)["code"]) == (404, "not_available")
    r = p.client.post("/api/ask/op-mia-turn-01/intents", headers=p.mg,
                      json={"kind": "studio.session", "request": {**CARD, "consent_digest": "sha256:" + "c" * 64}})
    assert r.status_code == 404
    assert hive.studio_makers.sweep() == 0
    assert hive.studio_makers.retire_for(MIA) is None
    assert p.client.patch("/api/people/u_bob", headers=p.quinn, json={"disabled": True}).status_code == 200
    assert tables(hive) == before


def test_R7_with_studio_off_an_existing_maker_is_left_alone(p, monkeypatch):
    setup(p)
    m = maker_of(p)
    monkeypatch.setattr(p.hive.studio, "enabled", False)
    before = tables(p.hive)
    assert p.client.patch("/api/people/u_mia", headers=p.quinn, json={"disabled": True}).status_code == 200
    assert p.hive.studio_makers.sweep() == 0
    assert tables(p.hive) == before and maker_of(p)["id"] == m["id"] and not maker_of(p)["deleted"]


# ---- 6. the attachment exception is this maker's and this app's only --------------------------------------------------------

def test_R7_the_attachment_exception_cannot_be_used_for_any_other_mind_or_program(p, monkeypatch):
    hive = p.hive
    setup(p)
    setup(p, p.bob)
    mia, bob = maker_of(p), maker_of(p, BOB)
    attach = hive.app_attachments.host_attach_studio_maker
    before = tables(hive)
    for program, mind, principal in ((PROGRAM, p.maker["id"], MIA),        # the shared maker
                                     (PROGRAM, p.template["id"], MIA),      # the template
                                     (PROGRAM, p.asker["id"], MIA),         # her Ask mind
                                     (PROGRAM, bob["id"], MIA),             # someone else's maker
                                     (PROGRAM, mia["id"], BOB),             # hers, for someone else
                                     (PROGRAM, mia["id"], "user:operator"),
                                     ("seamapp", mia["id"], MIA)):          # another app
        with pytest.raises(Exception) as e:
            attach(program, mind, principal)
        assert getattr(e.value, "code", None) == "attachment_refused", (program, mind, principal)
        assert tables(hive) == before, (program, mind, principal)          # each refusal writes nothing
    # a maker moved out of its Studio home is refused too
    hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (p.home["id"], mia["id"]))
    with pytest.raises(Exception) as e:
        attach(PROGRAM, mia["id"], MIA)
    assert e.value.code == "attachment_refused"
    hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (mia["swarm_id"], mia["id"]))
    # an app that has its own attachment hooks is never attached this way
    hive.db.execute("UPDATE app_attachments SET status = 'revoked' WHERE mind = ?", (mia["id"],))
    p.entry = studio_entry(hooks=True)
    with pytest.raises(Exception) as e:
        attach(PROGRAM, mia["id"], MIA)
    assert e.value.code == "studio_maker_attach_unsupported"
    hive.db.execute("UPDATE app_attachments SET status = 'active' WHERE mind = ?", (mia["id"],))
    assert tables(hive) == before
    # the admin routes stay admin-only for a member, her own maker included
    r = p.client.post(f"/api/programs/{PROGRAM}/attachments", headers=p.mg,
                      json={"mind_id": mia["id"], "actions": ["trace"], "policy": {"trace": "allow"}, "idempotency_key": "x1"})
    assert r.status_code in (401, 403), r.text
    r = p.client.post(f"/api/programs/{PROGRAM}/activations", headers=p.mg, json={"swarm_id": mia["swarm_id"]})
    assert r.status_code in (401, 403), r.text


def test_R7_reconcile_leaves_the_host_row_alone_and_an_admin_revoke_ends_it_without_hooks(p):
    hive = p.hive
    setup(p)
    m = maker_of(p)
    R3.on_loop(p, hive.app_attachments.reconcile)
    att = hive.db.one("SELECT * FROM app_attachments WHERE mind = ?", (m["id"],))
    assert att["status"] == "active"                                       # no activation row, still active
    r = p.client.delete(f"/api/programs/{PROGRAM}/attachments/{att['id']}", headers=p.quinn)
    assert r.status_code == 200, r.text
    assert hive.db.one("SELECT status FROM app_attachments WHERE id = ?", (att["id"],))["status"] == "revoked"
    again = setup(p).json()["maker"]                                       # the next setup attaches it again
    assert again["id"] == m["id"] and again["attachment_id"] not in (None, att["id"])


# ---- 7. lifecycle: no orphans; recreated; sleep authority -----------------------------------------------------------------

def test_R7_deleting_the_maker_leaves_no_orphans_and_the_next_setup_recreates_it(p):
    hive = p.hive
    setup(p)
    m = maker_of(p)
    r = p.client.delete(f"/api/agents/{m['id']}", headers=p.mg)            # the person deletes her own maker
    assert r.status_code == 200, r.text
    assert maker_of(p) is None                                             # the binding went with it
    assert hive.db.one("SELECT status FROM app_attachments WHERE mind = ?", (m["id"],))["status"] == "revoked"
    again = setup(p).json()["maker"]
    assert again["created"] is True and again["id"] != m["id"]
    assert again["swarm_id"] == m["swarm_id"]                               # her Studio home is reused
    assert hive.db.one("SELECT status FROM app_attachments WHERE mind = ?", (again["id"],))["status"] == "active"


def test_R7_a_disabled_person_s_maker_is_retired_and_a_stale_binding_is_swept(p):
    hive = p.hive
    setup(p)
    m = maker_of(p)
    assert p.client.patch("/api/people/u_mia", headers=p.quinn, json={"disabled": True}).status_code == 200
    assert hive.db.one("SELECT deleted FROM agents WHERE id = ?", (m["id"],))["deleted"] == 1
    assert hive.db.one("SELECT agent_id FROM person_minds WHERE principal = ?", (MIA,))["agent_id"] is None
    assert hive.db.one("SELECT status FROM app_attachments WHERE mind = ?", (m["id"],))["status"] == "revoked"
    # a binding left pointing at a deleted mind (e.g. from before this build) is dropped by the startup sweep
    setup(p, p.bob)
    b = maker_of(p, BOB)
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (b["id"],))
    hive.studio_makers.sweep()
    assert hive.db.one("SELECT agent_id FROM person_minds WHERE principal = ?", (BOB,))["agent_id"] is None
    assert hive.db.one("SELECT status FROM app_attachments WHERE mind = ?", (b["id"],))["status"] == "revoked"


def test_R7_sleep_follows_the_spawn_hierarchy_its_person_and_admins_may_sleep_it_others_never_see_it(p):
    setup(p)
    m = maker_of(p)
    assert p.client.post(f"/api/agents/{m['id']}/sleep", headers=p.bob).status_code == 404
    assert p.client.post(f"/api/agents/{m['id']}/sleep", headers=p.mg).status_code == 200
    assert p.client.post(f"/api/agents/{m['id']}/sleep", headers=p.jg).status_code == 200


# ---- 8. end to end on a personal maker: setup, frame over the hub, context, publish, done, outcome, Stop; billing ----------

@pytest.fixture()
def pr(r3, monkeypatch):
    """R3's world (the real Supervisor over the fake driver, stand-in hub) with the personal-maker settings, and Mia's own
    maker made by setup; the R3 helpers then address it (x.maker). It is asleep: the handoff starts it."""
    x = personal_world(r3, monkeypatch)
    view = setup(x).json()["maker"]
    x.shared = x.maker
    x.maker = dict(maker_of(x))
    x.driver.known.add(view["id"])
    assert view["status"] == "asleep" and view["id"] not in x.driver.procs
    return x


def open_personal(x):
    r = submit(x, record_card(x, card(x)).json()["intent_id"])
    assert r.status_code == 201, r.text
    return r.json()


def test_R7_end_to_end_one_step_on_a_personal_maker_over_the_hub_and_the_native_omega_skills(pr, ch, monkeypatch):
    hive = pr.hive
    bridge = load_bridge()

    def via_host(request, timeout):
        path = request.full_url.split("http://hive.test", 1)[1]
        data = json.loads(request.data) if request.data else None
        r = pr.client.request(request.get_method(), path, headers={"Authorization": request.get_header("Authorization")},
                              json=data)
        if r.status_code >= 400:
            import io
            import urllib.error
            raise urllib.error.HTTPError(request.full_url, r.status_code, "x", {}, io.BytesIO(r.content))

        class Answer:
            def read(self):
                return r.content

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        return Answer()
    monkeypatch.setattr(bridge, "_open", via_host)
    ChannelHub.daemon = ch.daemon
    monkeypatch.setattr(R3, "Hub", ChannelHub)
    try:
        session = open_personal(pr)                                         # setup, record without maker_id, submit
        sid = session["session_id"]
        assert session["maker_id"] == pr.maker["id"]
        m = mount(pr, sid, session["stream_id"]).json()
        ack = upload(pr, sid, m, 1).json()
        drive(pr)
        step = step_row(pr, sid, 1)
        assert step is not None and step["state"] == "admitted", ses_row(pr, sid)["state_reason"]
        assert ("start", pr.maker["id"]) in pr.driver.calls                # the asleep maker was started by the handoff
        assert wait_for(lambda: step_row(pr, sid, 1)["delivered_at"] is not None)
        events = [b for b in ch.getLastMessage().split("\n\n") if "event=studio_step" in b]
        assert len(events) == 1, events
        f = fields(events[0])
        assert (f["studio_session_id"], f["studio_execution_id"]) == (sid, step["execution_id"])
        monkeypatch.setenv("HIVE_API_URL", "http://hive.test")
        monkeypatch.setenv("HIVE_WS_TOKEN", token_now(pr))
        seen = json.loads(bridge.context(sid, f["studio_execution_id"]))
        assert seen["preview"] is False and step_row(pr, sid, 1)["read_at"] is not None
        body = '{"schema": "omega-maker-revision-2", "items": [{"op_id": "op-mine-1", "set": {"fill": "#0af"}}]}'
        out = bridge.publish(seen["proposal_artifact_id"], f["studio_execution_id"],
                             "none" if seen["parent"] is None else str(seen["parent"]), body)
        assert out.startswith("HIVE-STUDIO-PUBLISHED"), out
        row = step_row(pr, sid, 1)
        rev = hive.db.one("SELECT body, digest FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                          (seen["proposal_artifact_id"], row["proposal_n"]))
        assert rev["body"] == body
        assert bridge.done(sid, "1", f["studio_execution_id"], "false") == "HIVE-STUDIO-DONE step 1 finished more=False"
        prop = {"artifact_id": seen["proposal_artifact_id"], "revision": row["proposal_n"], "digest": rev["digest"]}
        r = outcome(pr, sid, 1, m, prop, ack)
        assert r.status_code == 200, r.text
        assert step_row(pr, sid, 1)["outcome"] == "applied"
        assert control(pr, sid, "stop").status_code == 200
        stopped_and_released(pr, sid)
    finally:
        ChannelHub.daemon = None


def test_R7_a_steps_paid_call_is_billed_to_the_person_on_her_own_key(pr, monkeypatch):
    hive = pr.hive
    monkeypatch.setattr(hive.settings.providers["openrouter"], "prices", {"test/maker": PRICE})
    pr.transport = Transport()
    gw = pr.client.app.state.gateway
    pr.transport.key_of = lambda agent: gw.paying_key(agent, "openrouter")[0]
    monkeypatch.setattr(gw, "chat", pr.transport.chat)
    session = open_personal(pr)
    sid = session["session_id"]
    row = ses_row(pr, sid)
    assert (row["payer"], row["own_key"], row["key_id"]) == (MIA, 1, KEY)
    m = mount(pr, sid, session["stream_id"]).json()
    upload(pr, sid, m, 1)
    drive(pr)
    step = step_row(pr, sid, 1)
    assert step is not None and step["state"] == "admitted", ses_row(pr, sid)["state_reason"]
    assert R3.context(pr, sid, step["execution_id"]).status_code == 200
    r = chat(pr)
    assert r.status_code == 200, r.text
    assert pr.transport.sent == [pr.maker["id"]]
    res = reservations_of(pr)
    assert len(res) == 1
    meta = res[0]["metadata"]
    assert (meta["payer"], meta["key"], meta["studio_session"] if "studio_session" in meta else sid) == (MIA, KEY, sid)
    usage = hive.db.one("SELECT * FROM usage WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1", (pr.maker["id"],))
    assert (usage["payer"], usage["key_id"]) == (MIA, KEY)
    # nothing was paid by the hive's key or anyone else's
    assert not hive.db.one("SELECT 1 FROM usage WHERE agent_id = ? AND (key_id != ? OR payer != ?)", (pr.maker["id"], KEY, MIA))


def test_R7_while_its_session_is_live_setup_never_changes_the_makers_key_and_a_second_session_is_refused(pr):
    open_personal(pr)
    maker = maker_of(pr)
    add_key(pr.hive, "k_0000a004", MIA)
    pr.hive.keyring.ring["defaults"]["openrouter"] = "k_0000a004"        # a new own default meanwhile
    again = setup(pr).json()["maker"]
    assert again["id"] == maker["id"] and again["key_id"] == KEY          # S5: the consented binding stays while live
    assert pr.hive.db.one("SELECT 1 FROM studio_maker_audit WHERE action = 'resolved'") is None
    r = submit(pr, record_card(pr, card(pr)).json()["intent_id"])         # one live session per person, per maker
    assert r.status_code == 409 and err(r)["code"] in ("person_session_live", "maker_busy", "intent_pending"), r.text


# ---- R7.1 (coordinator: switch-on blockers) ---------------------------------------------------------------------------------

STEP_SKILLS = ("hive-studio-context", "hive-studio-publish", "hive-studio-done")


def deny_all_role(x):
    """The Design Director role as it is on the Mac (rules: "*" deny), re-applied to the minds that hold it."""
    hive = x.hive
    hive.db.execute("UPDATE roles SET rules = ? WHERE id = ?", (json.dumps([{"skill": "*", "mode": "deny"}]), x.role["id"]))
    for row in hive.db.all("SELECT id FROM agents WHERE role_id = ? AND deleted = 0", (x.role["id"],)):
        hive.roles.apply(row["id"])


def modes(x, agent_id, skills):
    agent = x.hive.agent(agent_id)
    return {s: x.hive.policy.decide(agent, s)[0] for s in skills}


def test_R71_a_deny_all_role_permits_exactly_the_three_step_skills_to_a_live_maker_and_nothing_else(pr):
    hive = pr.hive
    deny_all_role(pr)
    maker, template = pr.maker["id"], pr.template["id"]
    others = ("hive-goals", "hive-revision", "shell", "hive-room-post", "write-file")
    # before any session: the maker is an ordinary mind under its role
    assert set(modes(pr, maker, STEP_SKILLS).values()) == {"deny"}
    session = open_personal(pr)
    sid = session["session_id"]
    assert modes(pr, maker, STEP_SKILLS) == {s: "allow" for s in STEP_SKILLS}
    assert set(modes(pr, maker, others).values()) == {"deny"}           # the role still denies everything else
    # the gate the omega loop asks (Policy.authorize): the same answers
    agent = hive.agent(maker)
    assert hive.policy.authorize(agent, f'(hive-studio-context "{sid}" "ex_x")')["decision"] == "allow"
    assert hive.policy.authorize(agent, '(hive-goals)')["decision"] == "deny"
    # an ordinary mind with the same role, and the shared maker, stay denied
    assert set(modes(pr, template, STEP_SKILLS).values()) == {"deny"}
    hive.db.execute("UPDATE agents SET role_id = ? WHERE id = ?", (pr.role["id"], pr.shared["id"]))
    hive.roles.apply(pr.shared["id"])
    assert set(modes(pr, pr.shared["id"], STEP_SKILLS).values()) == {"deny"}
    # the role definition is untouched
    assert json.loads(hive.db.one("SELECT rules FROM roles WHERE id = ?", (pr.role["id"],))["rules"]) == [
        {"skill": "*", "mode": "deny"}]
    # a rule naming one exactly still decides
    hive.db.insert("policy_rules", {"id": "r_exactdeny", "scope": f"agent:{maker}", "skill": "hive-studio-done",
                                    "mode": "deny", "note": "a person said never", "created_at": "2026-10-19T00:00:00.000Z"})
    assert modes(pr, maker, ("hive-studio-done",)) == {"hive-studio-done": "deny"}
    hive.db.execute("DELETE FROM policy_rules WHERE id = 'r_exactdeny'")
    # Stop: back to the role's answer
    assert control(pr, sid, "stop").status_code == 200
    stopped_and_released(pr, sid)
    assert set(modes(pr, maker, STEP_SKILLS).values()) == {"deny"}


def test_R71_with_studio_off_a_live_session_row_never_opens_the_step_skills(pr, monkeypatch):
    deny_all_role(pr)
    open_personal(pr)
    monkeypatch.setattr(pr.hive.studio, "enabled", False)
    assert set(modes(pr, pr.maker["id"], STEP_SKILLS).values()) == {"deny"}


def caps(x, who=None):
    return x.client.get("/api/me/ask", headers=who or x.mg).json()["capabilities"]


def test_R71_capabilities_studio_sessions_is_true_only_when_the_self_check_passes_and_the_template_is_usable(p, monkeypatch):
    studio = p.hive.studio
    assert caps(p) == {"conductor": False, "memory": False, "studio_sessions": True, "studio_directions": True}   # R7.3
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    # the real self-check with a component missing: off, and not advertised
    monkeypatch.setattr(studio, "components", lambda: {"gateway session/execution hook": True, "something": False})
    monkeypatch.setattr(studio, "enabled", studio.self_check()[0])
    assert studio.enabled is False and caps(p) == {"conductor": False, "memory": False}
    # every component present: on, advertised
    monkeypatch.setattr(studio, "components", lambda: {"gateway session/execution hook": True})
    monkeypatch.setattr(studio, "enabled", studio.self_check()[0])
    assert studio.enabled is True and caps(p)["studio_sessions"] is True
    # on, but no usable template: members' makers can't be made, so not advertised
    monkeypatch.delenv("HIVE_STUDIO_MAKER_TEMPLATE")
    assert "studio_sessions" not in caps(p)
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", p.maker["id"])        # exists, but kind changed below
    p.hive.db.execute("UPDATE agents SET kind = 'iter' WHERE id = ?", (p.maker["id"],))
    assert "studio_sessions" not in caps(p)


def test_R71_pin_with_studio_off_the_capabilities_are_exactly_as_before(p, monkeypatch):
    monkeypatch.setattr(p.hive.studio, "enabled", False)
    assert caps(p) == {"conductor": False, "memory": False}


def test_R71_template_unset_setup_refuses_with_an_admin_facing_code_and_startup_says_so(p, monkeypatch, caplog):
    hive = p.hive
    monkeypatch.delenv("HIVE_STUDIO_MAKER_TEMPLATE")
    before = tables(hive)
    r = setup(p, request=CARD)
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_unavailable")
    assert err(r)["reason"] == "template_unset"
    assert "ask an admin" in err(r)["message"] and tables(hive) == before
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    monkeypatch.setattr(hive.studio, "components", lambda: {"x": True})
    import logging
    with caplog.at_level(logging.WARNING, logger="hive"):
        assert hive.studio.self_check() == (True, [])
    assert any("HIVE_STUDIO_MAKER_TEMPLATE" in rec.getMessage() for rec in caplog.records)
    caplog.clear()
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", p.template["id"])
    with caplog.at_level(logging.WARNING, logger="hive"):
        hive.studio.self_check()
    assert not any("HIVE_STUDIO_MAKER_TEMPLATE" in rec.getMessage() for rec in caplog.records)


# ---- R7.2 (stand-in R7.0 P1: own keys only at every boundary; Kimi R7.0 follow-ups) -----------------------------------------

HIVE_KEY = "k_0000c0c1"


def hive_key(x):
    """A hive-held key (owner 'hive'), made the provider default: what a member 'on the hive's key' would pay with."""
    x.hive.keyring.ring["keys"][HIVE_KEY] = {"id": HIVE_KEY, "provider": "openrouter", "label": "hive", "owner": "hive",
                                             "secret": "sk-hive", "created_at": time.time()}
    x.hive.keyring.ring["defaults"]["openrouter"] = HIVE_KEY
    return HIVE_KEY


def patch_key(x, agent_id, key, who):
    return x.client.patch(f"/api/agents/{agent_id}", headers=who, json={"options": {"key": key} if key else {}})


@pytest.mark.parametrize("who", ["mia", "quinn"])
def test_R72_patch_puts_only_the_bound_members_own_key_on_her_maker_admins_included(p, who):
    hive = p.hive
    setup(p)
    m = maker_of(p)
    headers = p.mg if who == "mia" else p.quinn
    hive_key(p)
    for key in (HIVE_KEY, "env:openrouter", BOB_KEY, ANN_KEY):
        r = patch_key(p, m["id"], key, headers)
        if key == "env:openrouter":
            # no environment key is configured in this test hive: Hive._options refuses it first (400 bad_key); with
            # one configured the R7.2 guard answers 403 own_key_only (key_person(env:*) is None, never her key)
            assert r.status_code in (400, 403) and err(r)["code"] in ("bad_key", "own_key_only"), r.text
        elif who == "mia" and key in (BOB_KEY, ANN_KEY):
            assert (r.status_code, err(r)["code"]) == (404, "unknown_key"), (key, r.text)   # OI-13 answers first for her
        else:
            assert (r.status_code, err(r)["code"]) == (403, "own_key_only"), (key, r.text)
        assert json.loads(maker_of(p)["options"])["key"] == KEY
    add_key(hive, "k_0000a005", MIA)
    assert patch_key(p, m["id"], "k_0000a005", headers).status_code == 200      # another of her own keys: fine
    assert patch_key(p, m["id"], None, headers).status_code == 200              # removing the key: fine
    # the shared maker is unchanged: an admin may still put the hive key on it
    assert patch_key(p, p.maker["id"], HIVE_KEY, p.quinn).status_code == 200


@pytest.mark.parametrize("case", ["hive", "env", "other_member"])
def test_R72_a_post_setup_reassignment_is_refused_at_admission_for_a_direct_record_and_for_the_card(p, case):
    hive = p.hive
    old = card(p)
    m = maker_of(p)
    key = {"hive": hive_key(p), "env": "env:openrouter", "other_member": BOB_KEY}[case]
    # past the PATCH guard (an earlier build, a direct DB edit): the row now names that key
    hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": key}), m["id"]))
    # env: with no environment key configured here the gateway cannot resolve it, so admission's existing key check
    # answers key_drift first; with one configured the R7.2 check answers own_key_needed. Either way nothing is written.
    expect = {"other_member": [(409, "key_drift")], "hive": [(402, "own_key_needed")],
              "env": [(402, "own_key_needed"), (409, "key_drift")]}[case]
    # a direct record naming the current key (so key_drift on the card's key is not what stops it)
    request = {**{k: v for k, v in old["request"].items() if k not in ("maker_id", "swarm_id")}, "key_id": key}
    before = tables(hive)
    iid = p.client.post("/api/ask/op-mia-turn-01/intents", headers=p.mg,
                        json={"kind": "studio.session", "request": request}).json()["intent_id"]
    r = submit(p, iid)
    assert (r.status_code, err(r)["code"]) in expect, r.text
    assert tables(hive) == {**before, "goals": before["goals"]} and hive.db.one(
        "SELECT COUNT(*) AS n FROM studio_sessions")["n"] == 0
    assert reservations_of(p, m["id"]) == []


@pytest.mark.parametrize("case", ["hive", "other_member", "none"])
def test_R72_a_live_personal_makers_paid_call_on_any_key_but_hers_is_refused_before_reservation_or_dispatch(pr, monkeypatch,
                                                                                                         case):
    hive = pr.hive
    monkeypatch.setattr(hive.settings.providers["openrouter"], "prices", {"test/maker": PRICE})
    pr.transport = Transport()
    gw = pr.client.app.state.gateway
    pr.transport.key_of = lambda agent: gw.paying_key(agent, "openrouter")[0]
    monkeypatch.setattr(gw, "chat", pr.transport.chat)
    session = open_personal(pr)
    sid = session["session_id"]
    m = mount(pr, sid, session["stream_id"]).json()
    upload(pr, sid, m, 1)
    drive(pr)
    step = step_row(pr, sid, 1)
    assert step is not None and step["state"] == "admitted"
    assert R3.context(pr, sid, step["execution_id"]).status_code == 200
    key = {"hive": hive_key(pr), "other_member": BOB_KEY, "none": None}[case]
    if case == "none":
        hive.keyring.ring["defaults"]["openrouter"] = hive_key(pr)        # no key: the default (the hive's) would pay
    hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key": key} if key else {}), pr.maker["id"]))
    r = chat(pr)
    assert (r.status_code, err(r)["code"]) == (402, "own_key_needed"), r.text
    assert pr.transport.sent == [] and reservations_of(pr) == []
    assert not hive.db.one("SELECT 1 FROM usage WHERE agent_id = ?", (pr.maker["id"],))


def test_R72_the_shared_makers_paid_calls_and_admission_are_unchanged_on_the_hive_key(p):
    hive = p.hive
    setup(p)                                                               # a personal maker exists alongside
    agent = hive.agent(p.maker["id"])
    assert hive.studio_makers.key_refusal(p.maker["id"], "env:openrouter", "call") is None
    assert hive.studio_makers.key_refusal(p.maker["id"], BOB_KEY, "admission") is None
    assert hive.studio_makers.key_refusal(maker_of(p)["id"], KEY, "call") is None   # hers, on her own key
    assert agent["id"] == p.maker["id"]


def test_R72_simultaneous_setups_make_exactly_one_maker(p):
    import threading
    hive = p.hive
    before = tables(hive)
    out, barrier = [], threading.Barrier(4)

    def go():
        barrier.wait()
        out.append(hive.studio_makers.ensure(MIA))
    threads = [threading.Thread(target=go) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert len(out) == 4 and len({row["id"] for row, _ in out}) == 1
    assert sorted(created for _, created in out) == [False, False, False, True]
    after = tables(hive)
    assert (after["agents"], after["swarms"], after["person_minds"], after["app_attachments"]) == (
        before["agents"] + 1, before["swarms"] + 1, before["person_minds"] + 1, before["app_attachments"] + 1)


def test_R72_an_existing_maker_whose_person_has_no_key_left_gets_402_and_is_left_untouched(p):
    setup(p)
    m = maker_of(p)
    del p.hive.keyring.ring["keys"][KEY]
    before = tables(p.hive)
    r = setup(p, request=CARD)
    assert (r.status_code, err(r)["code"]) == (402, "own_key_needed")
    assert tables(p.hive) == before and maker_of(p)["options"] == m["options"]


def test_R72_capability_is_absent_when_the_studio_program_would_refuse_setup(p, monkeypatch):
    assert caps(p)["studio_sessions"] is True
    p.entry = studio_entry(hooks=True)                                     # a hooked Studio: setup would be refused
    assert "studio_sessions" not in caps(p)
    r = setup(p)
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_attach_unsupported")
    p.entry = studio_entry()
    real = p.hive.programs._ready
    monkeypatch.setattr(p.hive.programs, "_ready", lambda pid: (_ for _ in ()).throw(p.hive.error(409, "program_disabled", "x"))
                        if pid == PROGRAM else real(pid))
    assert "studio_sessions" not in caps(p)                                # not loaded / not ready


@pytest.mark.parametrize("state", ["held", "ended_unreleased"])
def test_R72_kimi_the_step_skills_open_only_for_a_live_session_never_a_held_or_unreleased_one(pr, state):
    """Kimi R7.0 sharpest point: the relaxation keys on live_session_of (active/paused/stopping), not studio_owns."""
    deny_all_role(pr)
    sid = open_personal(pr)["session_id"]
    assert modes(pr, pr.maker["id"], STEP_SKILLS) == {s: "allow" for s in STEP_SKILLS}
    if state == "held":
        pr.hive.db.execute("UPDATE studio_sessions SET state = 'held' WHERE id = ?", (sid,))
    else:
        pr.hive.db.execute("UPDATE studio_sessions SET state = 'stopped', maker_released = 0 WHERE id = ?", (sid,))
    assert pr.hive.studio.studio_owns(pr.maker["id"]) is True               # Studio still owns it...
    assert set(modes(pr, pr.maker["id"], STEP_SKILLS).values()) == {"deny"}  # ...but the step skills stay closed


# ---- R7.3: studio_directions is published exactly with studio_sessions ----------------------------------------------------

def test_R73_studio_directions_is_true_together_with_studio_sessions_and_absent_whenever_it_is(p, monkeypatch):
    on = caps(p)
    assert on == {"conductor": False, "memory": False, "studio_sessions": True, "studio_directions": True}
    put = p.client.put("/api/me/ask", headers=p.mg, json={"thread_budget_usd": 1.0})
    assert put.status_code == 200 and put.json()["capabilities"] == on, put.text                 # PUT: same shape
    p.entry = studio_entry(hooks=True)                                     # program not attachable
    assert caps(p) == {"conductor": False, "memory": False}
    p.entry = studio_entry()
    monkeypatch.delenv("HIVE_STUDIO_MAKER_TEMPLATE")                       # template not ready
    assert caps(p) == {"conductor": False, "memory": False}
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", p.template["id"])
    monkeypatch.setattr(p.hive.studio, "enabled", False)                   # Studio off
    assert caps(p) == {"conductor": False, "memory": False}


# ---- R7.3 (stand-in R7.1 P1): a personal maker's recall embeds on its person's own key, or free; never pauses ------------------

def recall_world(x, monkeypatch, embedding_model):
    """Priced chat and embeddings; the hive's key is every provider's default (what OI-13 alone would pay embeddings with);
    a scripted provider for chat; embeddings recorded with the key they would send (the no-cost embedder runs for real)."""
    from hive.core.gateway import signal_send
    hive = x.hive
    for name in ("openrouter", "openai"):
        monkeypatch.setattr(hive.settings.providers[name], "prices", {"test/maker": PRICE, "test/embed": PRICE})
    monkeypatch.setattr(hive.settings, "embedding_model", embedding_model)
    hive_key(x)
    hive.keyring.ring["keys"]["k_0000c0c2"] = {"id": "k_0000c0c2", "provider": "openai", "label": "hive-openai",
                                               "owner": "hive", "secret": "sk-hive-oa", "created_at": time.time()}
    hive.keyring.ring["defaults"]["openai"] = "k_0000c0c2"
    gw = x.client.app.state.gateway
    x.transport = Transport()
    x.transport.key_of = lambda agent: gw.paying_key(agent, "openrouter")[0]
    monkeypatch.setattr(gw, "chat", x.transport.chat)
    real, x.embedded = gw.embeddings, []

    async def embeddings(model, data, agent=None, key_id=None):
        if model.startswith("mock/"):
            x.embedded.append((model, None))
            return await real(model, data, agent=agent)
        await signal_send()
        x.embedded.append((model, key_id))
        return {"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2]}], "model": model,
                "usage": {"prompt_tokens": 7, "total_tokens": 7}}
    monkeypatch.setattr(gw, "embeddings", embeddings)


def recall_then_chat(x):
    session = open_personal(x)
    sid = session["session_id"]
    m = mount(x, sid, session["stream_id"]).json()
    upload(x, sid, m, 1)
    drive(x)
    step = step_row(x, sid, 1)
    assert step is not None and step["state"] == "admitted"
    assert R3.context(x, sid, step["execution_id"]).status_code == 200
    r = x.client.post("/llm/v1/embeddings", headers=R3.maker_headers(x), json={"input": ["the headline"]})   # recall
    assert r.status_code == 200, r.text
    assert ses_row(x, sid)["state"] == "active" and step_row(x, sid, 1)["state"] == "admitted"            # not paused
    r = chat(x)
    assert r.status_code == 200, r.text
    assert ses_row(x, sid)["state"] == "active"
    return sid


def test_R73_with_an_own_key_for_the_embedding_provider_recall_then_chat_complete_on_her_keys(pr, monkeypatch):
    hive = pr.hive
    recall_world(pr, monkeypatch, "openrouter/test/embed")
    recall_then_chat(pr)
    assert pr.embedded == [("openrouter/test/embed", KEY)]                # sent with HER key, not the hive default
    rows = hive.db.all("SELECT key_id, payer FROM usage WHERE agent_id = ?", (pr.maker["id"],))
    assert len(rows) == 2 and {(r["key_id"], r["payer"]) for r in rows} == {(KEY, MIA)}
    assert all(r_["metadata"]["key"] == KEY and r_["metadata"]["payer"] == MIA for r_ in reservations_of(pr))


def test_R73_with_no_own_key_for_the_embedding_provider_recall_is_free_and_chat_completes_on_her_key(pr, monkeypatch):
    hive = pr.hive
    recall_world(pr, monkeypatch, "openai/test/embed")                    # she has only an OpenRouter key
    recall_then_chat(pr)
    assert pr.embedded == [("mock/hash", None)]                           # the no-cost embedder; nothing paid
    rows = hive.db.all("SELECT key_id, payer FROM usage WHERE agent_id = ?", (pr.maker["id"],))
    assert [(r["key_id"], r["payer"]) for r in rows] == [(KEY, MIA)]      # only the chat call, on her key
    assert [r_["metadata"].get("kind") for r_ in reservations_of(pr)] == [None]   # one reservation: the chat


def test_R73_a_refused_recall_on_her_own_key_never_pauses_the_session(pr, monkeypatch):
    hive = pr.hive
    recall_world(pr, monkeypatch, "openrouter/test/embed")
    session = open_personal(pr)
    sid = session["session_id"]
    m = mount(pr, sid, session["stream_id"]).json()
    upload(pr, sid, m, 1)
    drive(pr)
    step = step_row(pr, sid, 1)
    assert R3.context(pr, sid, step["execution_id"]).status_code == 200
    from hive.core.hive import HiveError
    original = hive.check_budget

    def refuse_embeddings(agent, paid=False, estimate=0.0, key_id=None, payer=None, own_key=False):
        if pr.embedded is not None and estimate and estimate < 0.001:     # the embeddings call's tiny estimate
            raise HiveError(402, "spend_limit", "over her own-key limit")
        return original(agent, paid, estimate, key_id, payer, own_key)
    monkeypatch.setattr(hive, "check_budget", refuse_embeddings)
    r = pr.client.post("/llm/v1/embeddings", headers=R3.maker_headers(pr), json={"input": ["x"]})
    assert (r.status_code, err(r)["code"]) == (402, "spend_limit")
    assert ses_row(pr, sid)["state"] == "active" and step_row(pr, sid, 1)["state"] == "admitted"
    assert pr.embedded == [] and reservations_of(pr) == []


def test_R73_shared_maker_and_ordinary_mind_embeddings_keep_the_provider_default(pr, monkeypatch):
    recall_world(pr, monkeypatch, "openrouter/test/embed")
    # an ordinary mind of the hive (no person): the hive-held default pays, as OI-13 r1.2
    r = pr.client.post("/llm/v1/embeddings", headers={"Authorization": f"Bearer {pr.template['token']}"},
                       json={"input": ["x"]})
    assert r.status_code == 200, r.text
    assert pr.embedded == [("openrouter/test/embed", None)]               # default key: no key_id override
    row = pr.hive.db.one("SELECT key_id FROM usage WHERE agent_id = ?", (pr.template["id"],))
    assert row["key_id"] == HIVE_KEY
