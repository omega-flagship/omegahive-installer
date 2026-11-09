"""App platform P2: a person-owned swarm from an app's reviewed template.

Consent first (nothing written before it), bound to exactly what the card showed (template digest, the person's own
key, their own-key monthly total); minds asleep, owned, private and key-locked (P3a); idempotent and repairing;
withdrawal is a tombstone that ensure and repair honour; a template's rules are a ceiling no other rule or durable
answer lowers. Synthetic only: an invented app, people and keys; no provider call."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from hive.core.person_swarms import parse_templates
from hive.core.programs import ProgramContext
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_key_owner_oi13 import ANN, BOB, K_BOB, MODEL, add_key, code, w  # noqa: F401

APP = "demo-helpers"
TEMPLATE = {"minds": [{"slot": "errands", "name": "Errands", "persona": "Runs errands.", "model": MODEL, "budget_usd": 1},
                      {"slot": "watcher", "name": "Watcher", "model": MODEL}],
            "rules": [{"skill": "code-*", "mode": "deny"}, {"skill": "web-*", "mode": "ask"},
                      {"skill": "skill-*", "mode": "deny"}]}


def install(hive, template=TEMPLATE):
    hive.programs.programs[APP] = {"id": APP, "name": "Demo helpers", "capabilities": ["person_swarm"],
                                   "error": None, "swarm_templates": parse_templates({"helpers": template})}


@pytest.fixture()
def p(w, monkeypatch):
    # The process stand-in launches no process. Its explicit synthetic stop oracle
    # is separate from the production supervisor's positive driver verification.
    monkeypatch.setattr(w.hive.supervisor, "verify_stopped", lambda agent_id: None, raising=False)
    install(w.hive)
    assert w.client.put("/api/me/key-limits/self", headers=w.bob, json={"month_usd": 10}).status_code == 200
    return w


BOB_P = f"user:{BOB}"


def counts(hive):
    return {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"]
            for t in ("agents", "swarms", "app_person_minds", "app_person_swarms", "app_template_rules")}


def card(x):
    r = x.client.get(f"/api/me/app-swarms/{APP}/helpers", headers=x.bob)
    assert r.status_code == 200, r.text
    return r.json()


def consent(x, shown=None):
    c = shown or card(x)
    return x.client.post(f"/api/me/app-swarms/{APP}/helpers/consent", headers=x.bob,
                         json={k: c[k] for k in ("template_digest", "key_id", "month_usd", "consent_revision", "authority_revision")})


def ensure(x):
    return x.hive.person_swarms.ensure(BOB_P, APP, "helpers")


def opts(hive, agent_id):
    return json.loads(hive.db.one("SELECT options FROM agents WHERE id = ?", (agent_id,))["options"] or "{}")


# ---- templates -----------------------------------------------------------------------------------------------------

def test_a_template_may_never_carry_an_allow():
    with pytest.raises(ValueError, match="never allow"):
        parse_templates({"t": {"minds": [{"slot": "a", "name": "A", "model": MODEL}], "rules": [{"skill": "x", "mode": "allow"}]}})


def test_the_digest_follows_the_template():
    a = parse_templates({"t": TEMPLATE})["t"]["digest"]
    b = parse_templates({"t": {**TEMPLATE, "rules": TEMPLATE["rules"][:1]}})["t"]["digest"]
    assert a != b


# ---- consent first --------------------------------------------------------------------------------------------------

def test_the_card_shows_her_own_key_her_monthly_total_and_the_digest(p):
    c = card(p)
    assert (c["key_id"], c["month_usd"], len(c["minds"])) == (K_BOB, 10.0, 2)
    assert c["template_digest"] == p.hive.programs.get(APP)["swarm_templates"]["helpers"]["digest"]


def test_nothing_is_written_before_consent(p):
    before = counts(p.hive)
    assert ensure(p)["status"] == "consent_required"
    assert counts(p.hive) == before


def test_consent_must_match_the_card_as_it_stands(p):
    c = card(p)
    r = consent(p, {**c, "month_usd": 99})
    assert (r.status_code, code(r)) == (409, "card_changed")


def test_ready_minds_are_hers_asleep_private_and_key_locked(p):
    assert consent(p).status_code == 200
    out = ensure(p)
    assert out["status"] == "ready" and set(out["minds"]) == {"errands", "watcher"}
    swarm = p.hive.db.one("SELECT * FROM swarms WHERE id = ?", (out["swarm_id"],))
    assert (swarm["owner"], swarm["visibility"]) == (BOB_P, "private")
    for agent_id in out["minds"].values():
        row = p.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
        assert (row["owner"], row["visibility"], row["status"], row["swarm_id"]) == (BOB_P, "private", "asleep", out["swarm_id"])
        assert opts(p.hive, agent_id) == {"key": K_BOB, "key_locked": True}


def test_ensure_is_idempotent(p):
    consent(p)
    first, second = ensure(p), ensure(p)
    assert first == second


def test_a_half_made_slot_is_removed_and_made_again(p):
    consent(p)
    first = ensure(p)
    p.hive.db.execute("UPDATE app_person_minds SET finished = 0 WHERE slot = 'errands'")
    second = ensure(p)
    assert second["minds"]["errands"] != first["minds"]["errands"]
    assert second["minds"]["watcher"] == first["minds"]["watcher"]
    assert p.hive.db.one("SELECT deleted FROM agents WHERE id = ?", (first["minds"]["errands"],))["deleted"] == 1


# ---- consent is bound to what was shown --------------------------------------------------------------------------------

def test_a_changed_template_needs_consent_again_and_puts_the_old_minds_to_sleep(p):
    consent(p)
    out = ensure(p)
    agent_id = out["minds"]["errands"]
    p.hive.db.execute("UPDATE agents SET status = 'awake' WHERE id = ?", (agent_id,))
    install(p.hive, {**TEMPLATE, "rules": TEMPLATE["rules"][:1]})
    assert ensure(p)["status"] == "consent_required"
    assert p.hive.db.one("SELECT status FROM agents WHERE id = ?", (agent_id,))["status"] != "awake"


def test_a_changed_monthly_total_needs_consent_again(p):
    consent(p)
    ensure(p)
    assert p.client.put("/api/me/key-limits/self", headers=p.bob, json={"month_usd": 25}).status_code == 200
    assert ensure(p)["status"] == "consent_required"


def test_withdrawal_is_a_tombstone_repair_never_resurrects(p):
    consent(p)
    ensure(p)
    r = p.client.post(f"/api/me/app-swarms/{APP}/helpers/withdraw", headers=p.bob)
    assert r.status_code == 200, r.text
    p.hive.db.execute("UPDATE app_person_minds SET finished = 0")   # a crash left a slot to repair
    before = counts(p.hive)
    assert ensure(p)["status"] == "consent_required"
    assert counts(p.hive) == before


# ---- the context method ------------------------------------------------------------------------------------------------

def _ctx(p, actor=None, read_only=False):
    ctx = ProgramContext(p.hive, p.bob_swarm["id"], p.hive.programs.get(APP))
    ctx.actor, ctx.read_only = actor, read_only
    return ctx


async def host_person_action(p, monkeypatch, hook, *, principal=BOB_P, key="p2-host-setup", read_only=False,
                             capability=True):
    """Real host confirm -> person_act -> persisted action -> Programs.act.

    The invented app has no attachment requirement; confirmation, person gate,
    stable key, real host record and dispatcher are not stubbed.
    """
    from hive.core.program_actions import ProgramActions, act_payload, digest
    entry = p.hive.programs.get(APP)
    entry["capabilities"] = ["person_swarm"] if capability else []
    entry["describe"] = {"actions": [{"id": "setup", "person_activity": True}]}
    entry["module"] = SimpleNamespace(act=hook)
    monkeypatch.setattr(p.hive.app_attachments, "required", lambda _entry: False)
    session = p.hive.db.one("SELECT * FROM sessions WHERE principal = ? AND kind = 'sso'", (principal,))
    assert session is not None
    person = p.hive.db.one("SELECT role FROM people WHERE id = ?", (principal[5:],))
    actor = ProgramActions.person_actor(session, person["role"], p.shared["id"])
    if read_only:
        original = p.hive.programs.act
        async def readonly(*args, **kwargs):
            return await original(*args, **dict(kwargs, read_only=True))
        monkeypatch.setattr(p.hive.programs, "act", readonly)
    payload = act_payload([], {}, None)
    token = p.hive.program_actions.mint_confirm(actor, session["token_hash"], APP, p.shared["id"],
        {"swarm_id": p.shared["id"], "action": "setup", "payload": payload, "payload_digest": digest(payload)})
    return await p.hive.program_actions.person_act(actor, APP, p.shared["id"],
        {"action": "setup", "items": [], "params": {}, "idempotency_key": key,
         "confirm_token": token["confirm_token"]}, session_hash=session["token_hash"])


def test_the_context_runs_only_for_the_acting_person(p, monkeypatch):
    from hive.core.hive import HiveError
    for actor in ({"kind": "mind", "id": p.bob_mind["id"]}, {"kind": "person", "principal": BOB_P}):
        with pytest.raises(HiveError) as exc:
            _ctx(p, actor).ensure_person_swarm("helpers")
        assert exc.value.status == 403 and exc.value.code == "person_required"
    def hook(ctx, action, items, params):
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    result = asyncio.run(host_person_action(p, monkeypatch, hook))
    assert result["detail"] == {"status": "consent_required"}
    row = p.hive.db.one("SELECT * FROM program_actions WHERE idempotency_key = 'p2-host-setup'")
    assert row["principal"] == BOB_P and row["status"] == "done"
    assert p.hive.db.one("SELECT used_at FROM confirm_tokens WHERE intent = ?", (row["id"],))["used_at"] is not None


def test_an_app_without_the_capability_is_refused(p, monkeypatch):
    from hive.core.hive import HiveError
    def hook(ctx, action, items, params):
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    with pytest.raises(HiveError) as exc:
        asyncio.run(host_person_action(p, monkeypatch, hook, capability=False))
    assert exc.value.code == "capability_missing"


def test_a_host_read_only_act_cannot_mutate_its_guard_away(p, monkeypatch):
    from hive.core.hive import HiveError
    def hook(ctx, action, items, params):
        ctx.read_only = False
        return {"status": "done", "detail": ctx.ensure_person_swarm("helpers")}
    with pytest.raises(HiveError) as exc:
        asyncio.run(host_person_action(p, monkeypatch, hook, read_only=True))
    assert exc.value.code == "read_only"


# ---- the ceiling ---------------------------------------------------------------------------------------------------------

def _mind(p):
    consent(p)
    agent_id = ensure(p)["minds"]["errands"]
    return p.hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))


def test_a_template_glob_deny_beats_a_member_exact_ask_or_allow(p):
    agent = _mind(p)
    p.hive.policy.add_rule(f"agent:{agent['id']}", "code-edit", "allow", publish=False)
    assert p.hive.policy.decide(agent, "code-edit")[0] == "deny"


def test_a_template_ask_beats_an_exact_allow_at_any_scope(p):
    agent = _mind(p)
    p.hive.policy.add_rule(f"agent:{agent['id']}", "web-fetch", "allow", publish=False)
    p.hive.policy.add_rule("hive", "web-fetch", "allow", publish=False)
    assert p.hive.policy.decide(agent, "web-fetch")[0] == "ask"


def test_a_template_deny_holds_even_for_discovery_skills(p):
    agent = _mind(p)
    assert p.hive.policy.decide(agent, "skill-help")[0] == "deny"


@pytest.mark.parametrize("decision", ["always", "for"])
def test_a_durable_answer_on_a_capped_skill_is_once_only(p, decision):
    agent = _mind(p)
    approval = p.hive.policy._file(agent, "web-fetch", "(web-fetch \"x\")", "asks first")
    asyncio.run(p.hive.policy.answer(approval["id"], decision, operator=BOB_P, minutes=30))
    allows = [r for r in p.hive.policy.rules() if r["scope"] == f"agent:{agent['id']}" and r["mode"] == "allow"]
    assert allows == []
    assert p.hive.policy.decide(agent, "web-fetch")[0] == "ask"


def test_deleting_a_mind_drops_its_binding_and_ceiling(p):
    agent = _mind(p)
    p.hive.delete_agent(agent["id"])
    assert p.hive.person_swarms.ceiling(agent["id"], "code-edit") is None
    assert p.hive.db.one("SELECT 1 FROM app_person_minds WHERE agent_id = ?", (agent["id"],)) is None


@pytest.mark.parametrize("modes", [("deny", "ask"), ("ask", "deny")])
def test_duplicate_skill_patterns_refuse_the_app_before_module_import(p, tmp_path, modes):
    template = {**TEMPLATE, "rules": [{"skill": "code-*", "mode": mode} for mode in modes]}
    with pytest.raises(ValueError, match="duplicate skill pattern"):
        parse_templates({"helpers": template})
    folder = tmp_path / "duplicate-helpers"
    folder.mkdir()
    manifest = folder / "plugin.json"
    manifest.write_text(json.dumps({"id": "duplicate-helpers", "capabilities": ["person_swarm"],
                                    "swarm_templates": {"helpers": template}}))
    (folder / "program.py").write_text("raise AssertionError('duplicate app module must not run')\n")
    entry = p.hive.programs._load(folder, manifest, "synthetic")
    assert "duplicate skill pattern" in entry["error"] and entry["module"] is None


@pytest.mark.parametrize("phase", ["create", "repair"])
@pytest.mark.parametrize("modes", [("deny", "ask"), ("ask", "deny")])
def test_storage_keeps_strongest_mode_if_template_parser_was_bypassed(p, phase, modes):
    before_ids = None
    if phase == "repair":
        assert consent(p).status_code == 200
        before_ids = ensure(p)["minds"]
    changed = {**TEMPLATE, "minds": [{**TEMPLATE["minds"][0], "persona": "Fresh explicitly reviewed repair."},
                                    TEMPLATE["minds"][1]]}
    install(p.hive, changed)
    template = p.hive.programs.get(APP)["swarm_templates"]["helpers"]
    template["rules"] = [{"skill": "code-*", "mode": mode} for mode in modes]  # deliberately bypass parser
    assert consent(p).status_code == 200
    out = ensure(p)
    if before_ids is not None:
        assert out["minds"] == before_ids
    for agent_id in out["minds"].values():
        rows = p.hive.db.all("SELECT skill, mode FROM app_template_rules WHERE agent_id = ?", (agent_id,))
        assert rows == [{"skill": "code-*", "mode": "deny"}]
        p.hive.policy.add_rule(f"agent:{agent_id}", "code-edit", "allow", publish=False)
        assert p.hive.policy.decide(p.hive.agent(agent_id), "code-edit")[0] == "deny"


def test_an_earlier_dated_own_key_between_card_and_consent_is_refused(p):
    old = card(p)
    assert old["key_id"] == K_BOB
    new_key = "k_b0b2ca01"
    add_key(p.hive, new_key, BOB_P)
    p.hive.keyring.ring["keys"][new_key]["created_at"] = p.hive.keyring.ring["keys"][K_BOB]["created_at"] - 1
    before = counts(p.hive)
    response = consent(p, old)
    assert (response.status_code, code(response)) == (409, "card_changed")
    assert counts(p.hive) == before
    assert p.hive.db.one("SELECT 1 FROM app_person_consents WHERE principal = ?", (BOB_P,)) is None
    shown = card(p)
    assert shown["key_id"] == new_key and consent(p, shown).status_code == 200
    assert all(opts(p.hive, agent_id)["key"] == new_key for agent_id in ensure(p)["minds"].values())



def test_an_earlier_dated_own_key_after_consent_requires_fresh_consent(p):
    assert consent(p).status_code == 200
    original = ensure(p)
    new_key = "k_b0b2ca02"
    add_key(p.hive, new_key, BOB_P)
    p.hive.keyring.ring["keys"][new_key]["created_at"] = p.hive.keyring.ring["keys"][K_BOB]["created_at"] - 1
    assert ensure(p)["status"] == "consent_required"
    assert all(stored["status"] == "asleep" for stored in (
        p.hive.db.one("SELECT status FROM agents WHERE id = ?", (aid,)) for aid in original["minds"].values()))
    shown = card(p)
    assert shown["key_id"] == new_key and consent(p, shown).status_code == 200
    repaired = ensure(p)
    assert repaired["minds"] == original["minds"]
    assert all(opts(p.hive, aid)["key"] == new_key for aid in repaired["minds"].values())


def test_person_swarm_insert_refuses_a_namespace_alias_that_appears_after_allocation(p, monkeypatch):
    from hive.core.hive import HiveError
    from hive.tests.test_identity_namespace import late_alias
    assert consent(p).status_code == 200
    captured = late_alias(p.hive, monkeypatch)
    with pytest.raises(HiveError, match='workspace namespace'):
        ensure(p)
    assert p.hive.db.one('SELECT id FROM agents WHERE id=?', (captured['id'],)) is None
    assert p.hive.db.one('SELECT 1 FROM app_person_minds WHERE agent_id=?', (captured['id'],)) is None
