"""Foundation records against the real app/DB. Fake process driver; no provider or mind starts.

These are new, unrun controls. Matching Code-service availability is modeled only
where admission is inspected; that counterpart is not installed-service evidence.
"""
import asyncio
import contextlib
import dataclasses
import copy
import datetime
import json
import re
from pathlib import Path

import pytest

from hive.core.config import load_settings
from hive.core.db import new_id, now
from hive.core.foundation import CODE, REVIEW, CHILD_TEMPLATE, FLOW_TEMPLATE, RULE_ORIGIN, WRITE_SKILLS, READ_SKILLS, NATIVE_SKILLS, HELPER_DENIED, OMEGACODE_AUTHORIZE_SKILLS
from hive.core.hive import HiveError
from hive.tests.test_core_api import PETTA
from hive.tests.test_model_route import hive_app, HEAD, ENV  # noqa: F401 (real factory/DB and original route fixture)
from hive.core import model_route

pytestmark = pytest.mark.skipif(not Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")


@pytest.fixture(autouse=True)
def controlled_environment(monkeypatch):
    for name in (*ENV,"HIVE_MIND_SPAWN"):
        monkeypatch.delenv(name,raising=False)


@pytest.fixture()
def f(hive_app):
    hive = hive_app[0]
    assert hive.foundation._binding(CODE) is not None
    assert hive.foundation._binding(REVIEW) is not None
    return hive


def records(hive):
    return {table: hive.db.all("SELECT * FROM " + table + " ORDER BY rowid")
            for table in ("person_minds", "swarms", "agents", "roles", "swarm_services", "policy_rules")}


def controller(hive, purpose=CODE):
    b = hive.foundation._binding(purpose)
    return hive.db.one("SELECT * FROM agents WHERE id = ?", (b["agent_id"],))


def service_available(hive, monkeypatch):
    # Exact service/config/protocol-denial boundaries are synthetic here. This
    # does not claim a real listener, loaded service or native availability.
    monkeypatch.setattr(hive.services,"by_name",lambda name:{"id":"svc_invented", "name":name,
                                                          "address":"http://127.0.0.1:8724"})
    monkeypatch.setattr(hive.code,"require_intended_release",lambda:None)
    monkeypatch.setattr(hive.foundation,"_code_reachable",lambda service:True)


def available(hive, monkeypatch):
    # Only the external service-currentness boundary is modeled. Actual foundation,
    # policy, templates and admission methods execute unchanged.
    service_available(hive,monkeypatch)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-invented-foundation")
    provider = hive.keyring.provider("openrouter")
    name = HEAD.partition("/")[2]
    monkeypatch.setattr(provider,"prices",{**provider.prices,name:{"in":3,"out":15}})
    hive.foundation.prepare_request(hive.foundation._binding(CODE)["swarm_id"])


def observed_events(hive,monkeypatch):
    events = []
    original = hive.events.publish
    def publish(kind,**payload):
        events.append((kind,copy.deepcopy(payload),hive.db._conn.in_transaction))
        return original(kind,**payload)
    monkeypatch.setattr(hive.events,"publish",publish)
    return events


def test_fresh_start_has_two_bound_asleep_teams_without_start_or_usage(f):
    b, r = f.foundation._binding(CODE), f.foundation._binding(REVIEW)
    assert b["swarm_id"] != r["swarm_id"]
    for binding in (b, r):
        a = controller(f, binding["purpose"])
        team = f.swarm(binding["swarm_id"])
        assert team["coordinator_id"] == a["id"]
        assert a["id"].startswith("a_") and team["id"].startswith("s_")
        assert a["owner"] == binding["principal"] == f.ownhive.owner()
        assert (a["kind"], a["driver"], a["status"], a["desired"]) == ("omega", "local", "asleep", "asleep")
        assert a["id"] not in f.supervisor.starts
        assert f.db.all("SELECT * FROM usage WHERE agent_id = ?", (a["id"],)) == []
    assert controller(f)["budget_usd"] == .50
    assert controller(f, REVIEW)["budget_usd"] == .25
    # Dot's R6 contract: unavailable Code and held Review are not catalogue offers.
    assert f.collab.services(b["swarm_id"]) == []
    assert f.collab.services(r["swarm_id"]) == []
    rules = f.db.all("SELECT * FROM policy_rules WHERE origin = ?", (RULE_ORIGIN,))
    assert {x["skill"] for x in rules} == set(NATIVE_SKILLS)
    assert set(WRITE_SKILLS) <= {x["skill"] for x in rules}
    assert {x["scope"] for x in rules} == {"agent:" + b["agent_id"]}
    assert f.foundation.ensure()["review_proposal_routing"] == "pending-authorized-context-integration"


def test_restart_reuses_original_ids_and_is_a_record_noop(f):
    before, templates = records(f), copy.deepcopy(f.minds.templates)
    from hive.core.foundation import HiveFoundation
    f.foundation = HiveFoundation(f)
    f.foundation.ensure()
    f.foundation.ensure()
    assert records(f) == before and f.minds.templates == templates


def test_template_registration_uses_the_same_database_transaction(f, monkeypatch):
    original = f.minds._template
    calls = []
    def checked(entry, **kwargs):
        assert f.db._conn.in_transaction
        calls.append(entry["template_id"])
        return original(entry, **kwargs)
    monkeypatch.setattr(f.minds, "_template", checked)
    f.foundation.ensure()
    assert calls == [CHILD_TEMPLATE,FLOW_TEMPLATE]


def test_missing_host_coordinator_offer_and_template_are_repaired(f,monkeypatch):
    available(f,monkeypatch)
    b = f.foundation._binding(CODE)
    before = controller(f)
    f.db.execute("UPDATE swarms SET coordinator_id = NULL WHERE id = ?", (b["swarm_id"],))
    f.db.execute("DELETE FROM swarm_services WHERE swarm_id = ?", (b["swarm_id"],))
    del f.minds.templates[CHILD_TEMPLATE]
    f.foundation.ensure()
    assert f.swarm(b["swarm_id"])["coordinator_id"] == before["id"]
    assert f.collab.services(b["swarm_id"]) == ["code"]
    assert f.minds.templates[CHILD_TEMPLATE]["teams"] == [b["swarm_id"]]
    assert controller(f) == before


def test_existing_spend_lower_caps_stops_and_other_offers_are_preserved(f):
    a, b = controller(f), f.foundation._binding(CODE)
    f.db.execute("UPDATE agents SET spent_usd=.09,budget_usd=.10,status='stopped',desired='stopped' WHERE id=?", (a["id"],))
    f.minds.templates[CHILD_TEMPLATE]["max_allocation_usd"] = .07
    f.collab.set_services(b["swarm_id"], ["code", "invented-other"], b["principal"])
    f.foundation.ensure()
    after = controller(f)
    assert (after["spent_usd"], after["budget_usd"], after["status"], after["desired"]) == (.09,.10,"stopped","stopped")
    assert f.minds.templates[CHILD_TEMPLATE]["max_allocation_usd"] == .07
    assert f.collab.services(b["swarm_id"]) == ["code", "invented-other"]
    assert not f.foundation.spawn_enabled(b["swarm_id"])


def test_person_refusal_expires_only_host_allows_and_remains_effective(f, monkeypatch):
    available(f, monkeypatch)
    b = f.foundation._binding(CODE)
    refusal = f.policy.add_rule("swarm:" + b["swarm_id"], "code-mind-*", "deny", origin="answer", granted_by=b["principal"])
    assert not f.foundation.spawn_enabled(b["swarm_id"])
    f.foundation.ensure()
    assert f.db.one("SELECT * FROM policy_rules WHERE id=?", (refusal["id"],)) == refusal
    assert not [x for x in f.policy.all_rules() if x.get("origin") == RULE_ORIGIN]


def test_exact_controller_and_registered_template_limits_not_generic_team(f, monkeypatch):
    available(f, monkeypatch)
    b = f.foundation._binding(CODE)
    limits = f.foundation.admission_limits(b["swarm_id"], b["agent_id"])
    assert {k: limits[k] for k in ("controller_usd","request_usd","child_usd","max_children","lifetime_seconds")} == {
        "controller_usd":.50,"request_usd":.25,"child_usd":.25,"max_children":1,"lifetime_seconds":600}
    assert limits["template_ids"] == (CHILD_TEMPLATE,)
    assert limits["binding"] == tuple(b[k] for k in ("principal","purpose","swarm_id","agent_id","updated_at"))
    assert f.foundation.spawn_enabled(b["swarm_id"])
    with pytest.raises(HiveError, match="not currently admitted"):
        f.foundation.admission_limits(b["swarm_id"], controller(f, REVIEW)["id"])
    assert f.foundation.admission_limits(f.foundation._binding(REVIEW)["swarm_id"]) is None
    assert FLOW_TEMPLATE in f.minds.templates and FLOW_TEMPLATE not in limits["template_ids"]


def test_service_unavailable_is_truthful_and_never_makes_a_child(f):
    before = f.db.all("SELECT * FROM mind_children")
    out = f.foundation.ensure()
    assert out["code_available"] is False
    assert "unavailable" in f.swarm(out["code_team"])["description"].lower()
    assert not f.foundation.spawn_enabled(out["code_team"])
    assert f.db.all("SELECT * FROM mind_children") == before


def test_operator_off_blocks_only_existing_flag_exception(f, monkeypatch):
    available(f, monkeypatch)
    b = f.foundation._binding(CODE)
    assert f.settings.mind_spawn is False and f.foundation.spawn_enabled(b["swarm_id"])
    f.settings.mind_spawn_operator_off = True
    assert not f.foundation.spawn_enabled(b["swarm_id"])


def test_template_collision_and_foreign_coordinator_refuse_without_overwrite(f):
    b = f.foundation._binding(CODE)
    old = copy.deepcopy(f.minds.templates[CHILD_TEMPLATE])
    f.minds.templates[CHILD_TEMPLATE] = old | {"_foundation":"person-template"}
    with pytest.raises(HiveError, match="operator template"):
        f.foundation.ensure()
    assert f.minds.templates[CHILD_TEMPLATE]["_foundation"] == "person-template"
    f.minds.templates[CHILD_TEMPLATE] = old
    foreign = controller(f, REVIEW)["id"]
    f.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?", (foreign,b["swarm_id"]))
    raw_before = f.db.one("SELECT * FROM swarms WHERE id=?",(b["swarm_id"],))
    with pytest.raises(HiveError, match="different coordinator"):
        f.foundation.ensure()
    assert f.db.one("SELECT * FROM swarms WHERE id=?",(b["swarm_id"],)) == raw_before
    assert raw_before["coordinator_id"] == foreign
    # Canonical presentation masks a nonmember; this is not a custody mutation.
    assert f.swarm(b["swarm_id"])["coordinator_id"] is None


def test_first_admin_adopts_original_binding_without_new_actor_or_work(f,monkeypatch):
    old = f.foundation._binding(CODE)
    old_review = f.foundation._binding(REVIEW)
    assert old["principal"] == "user:operator"
    uid = new_id("u")
    f.db.insert("people", {"id":uid,"email":"foundation@example.test","name":"Invented owner","role":"admin","created_at":now()})
    events = observed_events(f,monkeypatch)
    out = f.foundation.ensure("user:" + uid)
    new = f.foundation._binding(CODE)
    assert (new["agent_id"],new["swarm_id"]) == (old["agent_id"],old["swarm_id"])
    assert new["principal"] == controller(f)["owner"] == "user:" + uid
    assert out["studio"] and out["studio"][0]["state"] == "unavailable"
    assert new["agent_id"] not in f.supervisor.starts
    for binding in (old,old_review):
        swarm = [payload["swarm"] for kind,payload,in_tx in events
                 if kind == "swarm.updated" and payload["swarm"]["id"] == binding["swarm_id"] and not in_tx]
        agents = [payload["agent"] for kind,payload,in_tx in events
                  if kind == "agent.updated" and payload["agent"]["id"] == binding["agent_id"] and not in_tx]
        assert swarm and agents
        assert swarm[-1]["owner"] == agents[-1]["owner"] == "user:" + uid


def test_central_personal_signin_hook_adopts_owner_and_retains_personal_mind(f):
    uid = new_id("u")
    principal = "user:" + uid
    f.db.insert("people", {"id":uid,"email":"signin@example.test","name":"Invented signin","role":"admin","created_at":now()})
    row = f.personal.ensure_quietly(principal)
    assert row is not None and row["personal_of"] == principal
    binding = f.foundation._binding(CODE)
    assert binding["principal"] == principal
    before = f.personal.mind_row(principal)
    f.personal.ensure_quietly(principal)
    assert f.personal.mind_row(principal)["id"] == before["id"]
    assert row["id"] not in f.supervisor.starts


def test_busy_owner_adoption_refuses_without_transferring_binding(f):
    old = f.foundation._binding(CODE)
    uid = new_id("u")
    f.db.insert("people", {"id":uid,"email":"busy@example.test","name":"Invented admin","role":"admin","created_at":now()})
    lease = {"id":new_id("ls"),"request_id":new_id("rq"),"controller_id":old["agent_id"],
             "team_id":old["swarm_id"],"template_ids":json.dumps([CHILD_TEMPLATE]),
             "max_children":1,"ceiling_usd":.25,"until":
             (datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=5)).isoformat(),
             "issued_by":old["principal"],"grant_id":None,"created_at":now(),"ended_at":None,"ended_reason":None}
    f.db.insert("mind_leases",lease)
    with pytest.raises(HiveError, match="original request"):
        f.foundation.ensure()
    assert f.foundation._binding(CODE) == old
    assert f.db.one("SELECT * FROM mind_leases WHERE id=?",(lease["id"],)) == lease


def test_deleted_controller_is_not_recreated_over_person_intent(f):
    old = controller(f)
    f.db.execute("UPDATE agents SET deleted=1 WHERE id=?", (old["id"],))
    count = len(f.db.all("SELECT * FROM agents"))
    with pytest.raises(HiveError, match="not recreated"):
        f.foundation.ensure()
    assert len(f.db.all("SELECT * FROM agents")) == count


@pytest.mark.parametrize("value,enabled,off", [(None,False,False),("0",False,True),("1",True,False)])
def test_existing_operator_flag_presence_is_preserved(monkeypatch,tmp_path,value,enabled,off):
    if value is None:
        monkeypatch.delenv("HIVE_MIND_SPAWN", raising=False)
    else:
        monkeypatch.setenv("HIVE_MIND_SPAWN",value)
    settings = load_settings(data_dir=tmp_path, admin_password="invented", petta_path=PETTA)
    assert (settings.mind_spawn,settings.mind_spawn_operator_off) == (enabled,off)


def test_late_key_pickup_uses_real_router_and_settlement_without_new_actor(f,monkeypatch):
    old = controller(f)
    assert model_route.is_demo(old["model"])
    b = f.foundation._binding(CODE)
    service_available(f,monkeypatch)
    with pytest.raises(HiveError,match="real supported funded route"):
        f.foundation.admission_limits(b["swarm_id"])
    available(f,monkeypatch)
    current = controller(f)
    assert current["id"] == old["id"] and current["model"] == HEAD
    assert model_route.held(f.db,current["id"]) == HEAD
    assert f.minds.templates[CHILD_TEMPLATE]["model_id"] == HEAD
    fact = f.budgets.settlement(current,HEAD,user=f.user_for(current),turn_bound=False)
    assert fact["host_paid"] and fact["bounded"]
    assert current["id"] not in f.supervisor.starts


def test_explicit_controller_and_template_models_are_never_silently_replaced(f,monkeypatch):
    old = controller(f)
    f.update_agent(old["id"],{"model":"mock/person-choice"},by="user:operator")
    assert model_route.held(f.db,old["id"]) is None
    monkeypatch.setenv("OPENROUTER_API_KEY","sk-or-invented-foundation")
    p = f.keyring.provider("openrouter")
    monkeypatch.setattr(p,"prices",{**p.prices,HEAD.partition("/")[2]:{"in":3,"out":15}})
    service_available(f,monkeypatch)
    with pytest.raises(HiveError,match="real supported funded route"):
        f.foundation.prepare_request(old["swarm_id"])
    assert controller(f)["model"] == "mock/person-choice"
    # A person's template model also remains theirs and cannot pass as a funded helper.
    f.minds.templates[CHILD_TEMPLATE]["model_id"] = "mock/template-choice"
    f.foundation.ensure()
    assert f.minds.templates[CHILD_TEMPLATE]["model_id"] == "mock/template-choice"


def test_bound_controller_ceiling_remains_hard_for_own_calls_and_lower_caps(f):
    a = controller(f)
    f.db.execute("UPDATE agents SET budget_usd=1.0 WHERE id=?",(a["id"],))
    assert f.foundation.controller_ceiling(a["id"]) == .50
    f.db.execute("UPDATE agents SET budget_usd=.06,status='stopped',desired='stopped' WHERE id=?",(a["id"],))
    assert f.foundation.controller_ceiling(a["id"]) == .50
    assert controller(f)["budget_usd"] == .06
    assert f.foundation.controller_ceiling(controller(f,REVIEW)["id"]) is None


@pytest.mark.parametrize("purpose,stage", [
    (CODE,"before-team-publication"),
    (CODE,"team-bound"),(REVIEW,"team-bound"),
    (CODE,"before-controller-publication"),(REVIEW,"before-controller-publication"),
    (CODE,"controller-bound"),(REVIEW,"controller-bound"),
    (CODE,"controller-prepared"),(REVIEW,"controller-prepared"),
    (CODE,"rules-bound"),(CODE,"templates-registered")])
def test_interruption_restart_reuses_original_published_records(monkeypatch,tmp_path,purpose,stage):
    from hive.core.foundation import HiveFoundation
    from hive.tests.test_personal_mind import _env
    original = HiveFoundation.__init__
    failed = []
    def init(self,hive):
        original(self,hive)
        def interrupt(at):
            reached = self._binding(purpose) is not None or (purpose == CODE and stage == "before-team-publication")
            if at == stage and reached and not failed:
                failed.append(at)
                raise RuntimeError("invented publication interruption")
        self._fault = interrupt
    monkeypatch.setattr(HiveFoundation,"__init__",init)
    app,_,supervisor,_ = _env(monkeypatch,tmp=str(tmp_path))
    hive = app.state.hive
    try:
        assert failed == [stage], "the actual startup boundary must have been reached"
        before = {b["purpose"]:(b["swarm_id"],b["agent_id"]) for b in hive.db.all(
            "SELECT * FROM person_minds WHERE purpose IN (?,?)",(CODE,REVIEW))}
        hive.foundation._fault = lambda at:None
        from hive.core.foundation import HiveFoundation as Subject
        hive.foundation = Subject(hive)
        hive.foundation._fault = lambda at:None
        hive.foundation.ensure()
        after = {b["purpose"]:(b["swarm_id"],b["agent_id"]) for b in hive.db.all(
            "SELECT * FROM person_minds WHERE purpose IN (?,?)",(CODE,REVIEW))}
        assert set(after) == {CODE,REVIEW}
        for kind,(team,agent) in before.items():
            assert after[kind][0] == team
            if agent is not None:
                assert after[kind][1] == agent
        ids = [after[CODE][1],after[REVIEW][1]]
        assert len(hive.db.all("SELECT * FROM agents WHERE id IN (?,?)",tuple(ids))) == 2
        assert len(hive.db.all("SELECT * FROM swarms WHERE name IN ('Create · Code','Review')")) == 2
        assert len(hive.db.all("SELECT * FROM agents WHERE swarm_id IN (?,?)",
                              (after[CODE][0],after[REVIEW][0]))) == 2
        assert len(hive.db.all("SELECT * FROM roles WHERE name='Foundation proposal reviewer'")) == 1
        assert all(hive.agent(a)["status"] == "asleep" for a in ids)
        assert not set(ids)&set(supervisor.starts)
        assert hive.db.all("SELECT * FROM usage") == []
    finally:
        asyncio.run(hive.gateway.client.aclose())
        asyncio.run(hive.people.client.aclose())
        hive.db._conn.close()


def test_authorized_owner_own_key_is_funded_without_becoming_host_paid(f,monkeypatch):
    uid = new_id("u")
    principal = "user:" + uid
    f.db.insert("people",{"id":uid,"email":"own-key@example.test","name":"Invented owner","role":"admin","created_at":now()})
    f.foundation.ensure(principal)
    provider = f.keyring.provider("openrouter")
    monkeypatch.setattr(provider,"prices",{**provider.prices,HEAD.partition("/")[2]:{"in":3,"out":15}})
    kid = new_id("k")
    monkeypatch.setitem(f.keyring.ring["keys"],kid,{
        "id":kid,"provider":"openrouter","label":"Invented own key","owner":principal,"secret":"sk-invented-own-key"})
    monkeypatch.setitem(f.keyring.ring["defaults"],"openrouter",kid)
    f.keyring._apply_defaults()  # original in-memory paying route; no save, verify, or HTTP call
    service_available(f,monkeypatch)
    b = f.foundation._binding(CODE)
    out = f.foundation.prepare_request(b["swarm_id"])
    a = controller(f)
    fact = f.budgets.settlement(a,HEAD,user=principal,turn_bound=False)
    assert a["model"] == HEAD and fact["bounded"] and fact["own_key"] and not fact["host_paid"]
    assert fact["payer"] == fact["key_owner"] == principal
    assert out["max_children"] == 1 and out["child_usd"] == .25
    # The original personal policy stays host-only on the exact same settlement.
    answer = model_route.choose("personal-mind:dialogue",f.keyring,f.ownhive,pins="check",
        settle=lambda model:f.budgets.settlement(a,model,user=principal,turn_bound=False))
    assert "refused" in answer
    assert a["id"] not in f.supervisor.starts


def test_real_local_provider_is_free_bounded_and_not_mock_host_paid(f,monkeypatch):
    monkeypatch.setenv("HIVE_DEFAULT_MODEL","local/invented-foundation-model")
    service_available(f,monkeypatch)
    b = f.foundation._binding(CODE)
    f.foundation.prepare_request(b["swarm_id"])
    a = controller(f)
    fact = f.budgets.settlement(a,a["model"],user=f.user_for(a),turn_bound=False)
    assert a["model"] == "local/invented-foundation-model"
    assert fact["free"] and fact["bounded"] and not fact["host_paid"]
    assert f.minds.templates[CHILD_TEMPLATE]["model_id"] == a["model"]
    assert a["id"] not in f.supervisor.starts


@pytest.mark.parametrize("case",["unknown","unpriced","no-key","zero-cap","unauthorized-key","demo"])
def test_foundation_funding_rejects_unsupported_or_unbounded_current_model(f,monkeypatch,case):
    a = controller(f)
    selected = HEAD
    provider = f.keyring.provider("openrouter")
    monkeypatch.setattr(provider,"prices",{**provider.prices,HEAD.partition("/")[2]:{"in":3,"out":15}})
    monkeypatch.setenv("OPENROUTER_API_KEY","sk-invented-funding-negative")
    if case == "unknown":
        selected = "missing/model"
    elif case == "unpriced":
        monkeypatch.setattr(provider,"prices",{})
    elif case == "no-key":
        monkeypatch.delenv("OPENROUTER_API_KEY")
    elif case == "zero-cap":
        a = a | {"budget_usd":0}
        f.db.execute("DELETE FROM budgets")  # no panel total admitting a cap-less synthetic mind
    elif case == "unauthorized-key":
        # A named owner with no grant must not consume another person's key.
        uid = new_id("u")
        principal = "user:" + uid
        f.db.insert("people",{"id":uid,"email":"denied@example.test","name":"Invented member","role":"member","access":"guest","created_at":now()})
        a = a | {"owner":principal}
        kid = new_id("k")
        monkeypatch.setitem(f.keyring.ring["keys"],kid,{
            "id":kid,"provider":"openrouter","label":"Other invented owner","owner":"user:"+new_id("u"),"secret":"sk-invented-not-authorized"})
        monkeypatch.setitem(f.keyring.ring["defaults"],"openrouter",kid)
        f.keyring._apply_defaults()
    else:
        selected = "mock/echo"
    result = model_route.choose("foundation-code:proposal",f.keyring,f.ownhive,pins="check",selected=selected,
        settle=lambda model:f.budgets.settlement(a,model,user=f.user_for(a),turn_bound=False))
    assert "refused" in result


def test_foundation_without_actual_settlement_never_uses_default_key_preview_as_admission(f,monkeypatch):
    available(f,monkeypatch)
    preview = model_route.choose("foundation-code:proposal",f.keyring,f.ownhive,pins="check")
    assert "refused" in preview
    original = model_route.facts([HEAD],f.keyring,f.ownhive)
    assert original and type(original[0]) is model_route.RouteFact


def foreign_member(f):
    b = f.foundation._binding(CODE)
    return f.create_agent("Invented different coordinator","omega",b["swarm_id"],
                          "mock/echo",budget_usd=.03,owner=b["principal"],by=b["principal"])


def test_same_team_foreign_coordinator_refuses_and_preserves_visible_and_raw_choice(f):
    b = f.foundation._binding(CODE)
    foreign = foreign_member(f)
    f.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?",(foreign["id"],b["swarm_id"]))
    before = records(f)
    assert f.swarm(b["swarm_id"])["coordinator_id"] == foreign["id"]
    with pytest.raises(HiveError,match="different coordinator"):
        f.foundation.ensure()
    assert records(f) == before
    assert f.swarm(b["swarm_id"])["coordinator_id"] == foreign["id"]


def test_coordinator_chosen_before_transaction_is_rechecked_before_repair(f,monkeypatch):
    b = f.foundation._binding(CODE)
    foreign = foreign_member(f)
    f.db.execute("UPDATE swarms SET coordinator_id=NULL WHERE id=?",(b["swarm_id"],))
    original = f.db.transaction
    selected = []
    @contextlib.contextmanager
    def choose_before_transaction():
        if not selected:
            f.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?",(foreign["id"],b["swarm_id"]))
            selected.append(f.db.one("SELECT * FROM swarms WHERE id=?",(b["swarm_id"],)))
        with original():
            yield
    monkeypatch.setattr(f.db,"transaction",choose_before_transaction)
    with pytest.raises(HiveError,match="different coordinator"):
        f.foundation.ensure()
    assert selected and f.db.one("SELECT * FROM swarms WHERE id=?",(b["swarm_id"],)) == selected[0]


def test_foreign_coordinator_refuses_before_foundation_owner_adoption(f,monkeypatch):
    b = f.foundation._binding(CODE)
    foreign = foreign_member(f)
    f.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?",(foreign["id"],b["swarm_id"]))
    uid = new_id("u")
    f.db.insert("people",{"id":uid,"email":"adopt-blocked@example.test","name":"Invented new owner","role":"admin","created_at":now()})
    before = records(f)
    events = observed_events(f,monkeypatch)
    with pytest.raises(HiveError,match="different coordinator"):
        f.foundation.ensure("user:"+uid)
    # OwnHive may publish its legitimate first-admin owner. Foundation's old
    # binding/team/controller/role/policy records must remain untouched.
    assert records(f) == before
    assert f.foundation._binding(CODE) == b
    assert events == []


def test_partially_created_team_keeps_person_coordinator_before_new_controller(monkeypatch,tmp_path):
    from hive.core.foundation import HiveFoundation
    from hive.tests.test_personal_mind import _env
    original = HiveFoundation.__init__
    def init(self,hive):
        original(self,hive)
        def interrupted(stage):
            if stage == "team-bound":
                raise RuntimeError("invented stop after original team binding")
        self._fault = interrupted
    monkeypatch.setattr(HiveFoundation,"__init__",init)
    app,_,_,_ = _env(monkeypatch,tmp=str(tmp_path))
    hive = app.state.hive
    try:
        b = hive.foundation._binding(CODE)
        assert b is not None and b["agent_id"] is None
        foreign = foreign_member(hive)
        hive.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?",(foreign["id"],b["swarm_id"]))
        before = records(hive)
        hive.foundation._fault = lambda stage:None
        with pytest.raises(HiveError,match="different coordinator"):
            hive.foundation.ensure()
        assert records(hive) == before and hive.foundation._binding(CODE) == b
    finally:
        asyncio.run(hive.gateway.client.aclose())
        asyncio.run(hive.people.client.aclose())
        hive.db._conn.close()


def test_rolled_back_owner_adoption_emits_no_phantom_update(f,monkeypatch):
    uid = new_id("u")
    principal = "user:" + uid
    f.db.insert("people",{"id":uid,"email":"rollback-owner@example.test","name":"Invented rollback owner","role":"admin","created_at":now()})
    before = records(f)
    events = observed_events(f,monkeypatch)
    original = f.db.transaction
    failed = []
    @contextlib.contextmanager
    def rollback_after_adoption():
        with original():
            yield
            if not failed and f.foundation._binding(CODE)["principal"] == principal:
                failed.append(True)
                raise RuntimeError("invented rollback before ownership commit")
    monkeypatch.setattr(f.db,"transaction",rollback_after_adoption)
    with pytest.raises(RuntimeError,match="rollback before ownership commit"):
        f.foundation.ensure(principal)
    assert failed and events == [] and records(f) == before


@pytest.mark.parametrize("value,enabled,off",[(None,False,False),("0",False,True),("1",True,False)])
def test_real_create_app_wires_foundation_operator_setting_and_final_asleep_event(monkeypatch,tmp_path,value,enabled,off):
    from hive.core.events import EventBus
    from hive.core.foundation import HiveFoundation
    from hive.tests.test_personal_mind import _env
    if value is not None:
        monkeypatch.setenv("HIVE_MIND_SPAWN",value)
    events = []
    original = EventBus.publish
    def publish(bus,kind,**payload):
        events.append((kind,copy.deepcopy(payload)))
        return original(bus,kind,**payload)
    monkeypatch.setattr(EventBus,"publish",publish)
    # _env calls actual production create_app. No Foundation or Settings attribute
    # is injected; only the existing fake process driver/Google client is supplied.
    app,_,supervisor,_ = _env(monkeypatch,tmp=str(tmp_path))
    hive = app.state.hive
    try:
        assert type(hive.foundation) is HiveFoundation and hive.foundation.hive is hive
        assert "mind_spawn_operator_off" in {field.name for field in dataclasses.fields(hive.settings)}
        assert (hive.settings.mind_spawn,hive.settings.mind_spawn_operator_off) == (enabled,off)
        for purpose in (CODE,REVIEW):
            binding = hive.foundation._binding(purpose)
            assert binding is not None and binding["agent_id"]
            updates = [payload["agent"] for kind,payload in events
                       if kind == "agent.updated" and payload["agent"]["id"] == binding["agent_id"]]
            assert updates and updates[-1]["status"] == "asleep"
            assert hive.agent(binding["agent_id"])["status"] == "asleep"
            assert binding["agent_id"] not in supervisor.starts
        assert hive.db.all("SELECT * FROM usage") == []
    finally:
        asyncio.run(hive.gateway.client.aclose())
        asyncio.run(hive.people.client.aclose())
        hive.db._conn.close()


def test_early_startup_without_Code_object_is_unavailable_not_an_exception(f,monkeypatch):
    with monkeypatch.context() as scoped:
        scoped.delattr(f,"code")
        scoped.setattr(f.services,"by_name",lambda name:{"name":name})
        assert f.foundation._code_available() is False


def test_initial_owner_change_before_creation_transaction_publishes_no_stale_team(monkeypatch,tmp_path):
    from hive.core.foundation import HiveFoundation
    from hive.tests.test_personal_mind import _env
    original_init = HiveFoundation.__init__
    first = []
    principal = []
    def init(self,hive):
        original_init(self,hive)
        original_transaction = hive.db.transaction
        injected = []
        @contextlib.contextmanager
        def first_admin_before_transaction():
            change = not injected
            if change:
                injected.append(True)
                uid = new_id("u")
                principal.append("user:"+uid)
                hive.db.insert("people",{"id":uid,"email":"initial-owner-drift@example.test",
                    "name":"Invented initial admin","role":"admin","created_at":now()})
            with original_transaction():
                try:
                    yield
                finally:
                    if change:
                        # Capture the actual first publication attempt before a
                        # later legitimate personal-backfill retry can repair it.
                        first.append({"bindings":hive.db.all(
                            "SELECT * FROM person_minds WHERE purpose IN (?,?)",(CODE,REVIEW)),
                            "teams":hive.db.all("SELECT * FROM swarms WHERE name IN ('Create · Code','Review')")})
        monkeypatch.setattr(hive.db,"transaction",first_admin_before_transaction)
    monkeypatch.setattr(HiveFoundation,"__init__",init)
    app,_,_,_ = _env(monkeypatch,tmp=str(tmp_path))
    hive = app.state.hive
    try:
        assert len(first) == 1 and first[0] == {"bindings":[],"teams":[]}
        assert len(principal) == 1
        hive.foundation.ensure(principal[0])
        for purpose in (CODE,REVIEW):
            b = hive.foundation._binding(purpose)
            assert b["principal"] == controller(hive,purpose)["owner"] == principal[0]
    finally:
        asyncio.run(hive.gateway.client.aclose())
        asyncio.run(hive.people.client.aclose())
        hive.db._conn.close()


# R5 controls: actual Foundation -> Hive -> original after_commit, no caller or
# callback stand-in. Every app/DB below is the existing disposable fixture.
def observed_team_sync(hive,monkeypatch):
    syncs = []
    original = hive._team_sync
    def sync(swarm_id=None):
        syncs.append((swarm_id,hive.db._conn.in_transaction))
        return original(swarm_id)
    monkeypatch.setattr(hive,"_team_sync",sync)
    return syncs


@pytest.mark.parametrize("purpose",[CODE,REVIEW])
@pytest.mark.parametrize("stage",["before-team-publication","team-bound"])
def test_creation_rollback_drops_swarm_notice_and_room_sync(f,monkeypatch,purpose,stage):
    # Missing publication is not authority to adopt another team by its name.
    f.db.execute("DELETE FROM person_minds WHERE purpose=?",(purpose,))
    before = records(f)
    events = observed_events(f,monkeypatch)
    syncs = observed_team_sync(f,monkeypatch)
    def interrupt(at):
        if at == stage:
            raise RuntimeError("invented creation rollback")
    monkeypatch.setattr(f.foundation,"_fault",interrupt)
    with pytest.raises(RuntimeError,match="creation rollback"):
        with f.db.transaction():
            f.foundation._ensure_team(purpose,"Invented rollback foundation",f.foundation._owner_read(),.25)
    assert records(f) == before
    assert f.foundation._binding(purpose) is None
    assert events == [] and syncs == []


@pytest.mark.parametrize("purpose",[CODE,REVIEW])
def test_creation_commit_notifies_and_syncs_only_after_outer_commit(f,monkeypatch,purpose):
    f.db.execute("DELETE FROM person_minds WHERE purpose=?",(purpose,))
    events = observed_events(f,monkeypatch)
    syncs = observed_team_sync(f,monkeypatch)
    def stop_before_controller(at):
        if at == "team-bound":
            raise RuntimeError("invented stop after durable team")
    monkeypatch.setattr(f.foundation,"_fault",stop_before_controller)
    with pytest.raises(RuntimeError,match="after durable team"):
        f.foundation._ensure_team(purpose,"Invented committed foundation",f.foundation._owner_read(),.25)
    binding = f.foundation._binding(purpose)
    assert binding is not None and binding["agent_id"] is None
    team = f.swarm(binding["swarm_id"])
    notices = [e for e in events if e[0] == "swarm.updated" and e[1]["swarm"]["id"] == team["id"]]
    assert notices == [("swarm.updated",{"swarm":team},False)]
    assert syncs == [(team["id"],False)]
    assert f.db.one("SELECT id FROM agents WHERE swarm_id=?",(team["id"],)) is None


@pytest.mark.parametrize("purpose",[CODE,REVIEW])
def test_coordinator_repair_rollback_drops_the_original_swarm_notice(f,monkeypatch,purpose):
    binding = f.foundation._binding(purpose)
    f.db.execute("UPDATE swarms SET coordinator_id=NULL WHERE id=?",(binding["swarm_id"],))
    before = records(f)
    events = observed_events(f,monkeypatch)
    syncs = observed_team_sync(f,monkeypatch)
    with pytest.raises(RuntimeError,match="repair rollback"):
        with f.db.transaction():
            f.foundation._ensure_team(purpose,"Unused repair name",binding["principal"],.25)
            assert f.db.one("SELECT coordinator_id FROM swarms WHERE id=?",(binding["swarm_id"],))["coordinator_id"] == binding["agent_id"]
            assert events == [] and syncs == []
            raise RuntimeError("invented repair rollback")
    assert records(f) == before
    assert events == [] and syncs == []


@pytest.mark.parametrize("purpose",[CODE,REVIEW])
def test_coordinator_repair_commit_emits_current_custody_after_outer_commit(f,monkeypatch,purpose):
    binding = f.foundation._binding(purpose)
    f.db.execute("UPDATE swarms SET coordinator_id=NULL WHERE id=?",(binding["swarm_id"],))
    events = observed_events(f,monkeypatch)
    syncs = observed_team_sync(f,monkeypatch)
    with f.db.transaction():
        f.foundation._ensure_team(purpose,"Unused repair name",binding["principal"],.25)
        assert events == [] and syncs == []
    team = f.swarm(binding["swarm_id"])
    assert team["coordinator_id"] == binding["agent_id"]
    assert events == [("swarm.updated",{"swarm":team},False)]
    assert syncs == []


def test_five_read_allows_are_exact_controller_only_and_writes_stay_explicit(f):
    assert READ_SKILLS == ("code-mind-templates","code-mind-status","code-mind-scan","code-mind-request","code-mind-work")
    code,other = controller(f),controller(f,REVIEW)
    for skill in READ_SKILLS:
        assert f.policy.decide(code,skill)[0] == "allow"
        assert f.policy.decide(other,skill)[0] == "ask"
    for skill in WRITE_SKILLS:
        assert f.policy.decide(code,skill)[0] == "allow"
        assert f.policy.decide(other,skill)[0] == "deny"
    rules = [r for r in f.policy.all_rules() if r["origin"] == RULE_ORIGIN]
    assert len(rules) == 9 and {r["skill"] for r in rules} == set(NATIVE_SKILLS)
    assert {r["scope"] for r in rules} == {"agent:"+code["id"]}


@pytest.mark.parametrize("scope_kind",["hive","swarm","agent"])
@pytest.mark.parametrize("mode",["ask","deny"])
def test_current_person_read_refusals_survive_seed_and_admission(f,monkeypatch,scope_kind,mode):
    available(f,monkeypatch)
    code = controller(f)
    scope = {"hive":"hive","swarm":"swarm:"+code["swarm_id"],"agent":"agent:"+code["id"]}[scope_kind]
    for skill in READ_SKILLS:
        refusal = f.policy.add_rule(scope,skill,mode,origin="answer",granted_by=code["owner"])
        f.foundation.ensure()
        assert f.db.one("SELECT * FROM policy_rules WHERE id=?",(refusal["id"],)) == refusal
        assert f.policy.decide(code,skill)[0] == mode
        assert not [r for r in f.policy.all_rules() if r["origin"] == RULE_ORIGIN and r["skill"] == skill]
        assert not f.foundation.spawn_enabled(code["swarm_id"])
        f.db.execute("DELETE FROM policy_rules WHERE id=?",(refusal["id"],))
        f.foundation.ensure()
        assert f.policy.decide(code,skill)[0] == "allow"
        assert f.foundation.spawn_enabled(code["swarm_id"])


def test_reseeding_expires_only_stale_foundation_nine_and_preserves_other_rules(f):
    code,other = controller(f),controller(f,REVIEW)
    stale = [f.policy.add_rule("agent:"+other["id"],skill,"allow",origin=RULE_ORIGIN,granted_by=other["owner"]) for skill in NATIVE_SKILLS]
    unrelated = f.policy.add_rule("agent:"+other["id"],"send","allow",origin=RULE_ORIGIN,granted_by=other["owner"])
    person = f.policy.add_rule("agent:"+other["id"],"code-mind-work","ask",origin="answer",granted_by=other["owner"])
    f.foundation.ensure()
    for row in stale:
        current = f.db.one("SELECT * FROM policy_rules WHERE id=?",(row["id"],))
        assert current["expires_at"] is not None
        assert current["scope"] == row["scope"] and current["skill"] == row["skill"] and current["origin"] == RULE_ORIGIN
    assert f.db.one("SELECT * FROM policy_rules WHERE id=?",(unrelated["id"],)) == unrelated
    assert f.db.one("SELECT * FROM policy_rules WHERE id=?",(person["id"],)) == person
    assert {r["skill"] for r in f.policy.all_rules() if r["origin"] == RULE_ORIGIN and r["scope"] == "agent:"+code["id"]} == set(NATIVE_SKILLS)
    assert f.policy.decide(other,"code-mind-work")[0] == "ask"


def test_code_offer_tracks_reachable_funded_route_and_review_stays_held(f,monkeypatch):
    from hive.core.foundation import OFFER_ORIGIN
    code = f.foundation._binding(CODE)["swarm_id"]
    review = f.foundation._binding(REVIEW)["swarm_id"]
    assert f.collab.services(code) == f.collab.services(review) == []
    available(f,monkeypatch)
    assert f.collab.services(code) == ["code"] and f.collab.services(review) == []
    assert f.db.one("SELECT set_by FROM swarm_services WHERE swarm_id=?",(code,))["set_by"] == OFFER_ORIGIN
    monkeypatch.setattr(f.foundation,"_code_reachable",lambda service:False)
    f.foundation.ensure()
    assert f.collab.services(code) == [] and f.collab.services(review) == []
    assert "unavailable" in f.swarm(code)["description"].lower()
    monkeypatch.setattr(f.foundation,"_code_reachable",lambda service:True)
    f.foundation.ensure()
    assert f.collab.services(code) == ["code"] and f.collab.services(review) == []
    monkeypatch.delenv("OPENROUTER_API_KEY")
    f.foundation.ensure()
    assert f.collab.services(code) == [] and f.collab.services(review) == []
    assert not f.supervisor.starts and f.db.all("SELECT * FROM usage") == []


@pytest.mark.parametrize("missing",["unreachable","mismatched","unfunded"])
def test_unavailable_code_withdraws_only_automatic_offer_and_refuses_plainly(f,monkeypatch,missing):
    available(f,monkeypatch)
    code = f.foundation._binding(CODE)["swarm_id"]
    if missing == "unreachable":
        monkeypatch.setattr(f.foundation,"_code_reachable",lambda service:False)
    elif missing == "mismatched":
        def mismatch():
            raise f.error(503,"service_release_mismatch","invented mismatched service")
        monkeypatch.setattr(f.code,"require_intended_release",mismatch)
    else:
        monkeypatch.delenv("OPENROUTER_API_KEY")
    with pytest.raises(HiveError,match="Code is unavailable"):
        f.foundation.prepare_request(code)
    assert f.collab.services(code) == []
    assert f.db.all("SELECT * FROM requests") == f.db.all("SELECT * FROM mind_leases") == []
    assert not f.supervisor.starts


@pytest.mark.parametrize("kinds,private",[(["invented-other"],[]),(["invented-other"],["code"]),(["code","invented-other"],[])])
def test_person_offer_row_and_private_preferences_are_never_rewritten(f,monkeypatch,kinds,private):
    available(f,monkeypatch)
    binding = f.foundation._binding(CODE)
    code = binding["swarm_id"]
    f.collab.set_services(code,kinds,binding["principal"],connection_only_kinds=private)
    before = f.db.one("SELECT * FROM swarm_services WHERE swarm_id=?",(code,))
    f.foundation.ensure()
    assert f.db.one("SELECT * FROM swarm_services WHERE swarm_id=?",(code,)) == before
    if "code" not in kinds:
        with pytest.raises(HiveError,match="person's current offer settings"):
            f.foundation.prepare_request(code)
    else:
        assert f.foundation.prepare_request(code)["request_usd"] == .25
    assert f.db.one("SELECT * FROM swarm_services WHERE swarm_id=?",(code,)) == before
    monkeypatch.setattr(f.foundation,"_code_reachable",lambda service:False)
    f.foundation.ensure()
    assert f.db.one("SELECT * FROM swarm_services WHERE swarm_id=?",(code,)) == before


@pytest.mark.parametrize("kinds,private",[(["review","invented-other"],[]),(["invented-other"],["review"])])
def test_person_review_offer_conflict_is_surfaced_without_deletion(f,monkeypatch,kinds,private):
    available(f,monkeypatch)
    binding = f.foundation._binding(REVIEW)
    review = binding["swarm_id"]
    f.collab.set_services(review,kinds,binding["principal"],connection_only_kinds=private)
    before = f.db.one("SELECT * FROM swarm_services WHERE swarm_id=?",(review,))
    with pytest.raises(HiveError,match="owner must resolve"):
        f.foundation.ensure()
    assert f.db.one("SELECT * FROM swarm_services WHERE swarm_id=?",(review,)) == before
    assert controller(f,REVIEW)["status"] == "asleep" and not f.supervisor.starts


def test_offer_observation_rechecks_registration_identity_outside_database(f,monkeypatch):
    available(f,monkeypatch)
    code = f.foundation._binding(CODE)["swarm_id"]
    service = {"id":"svc_before","name":"omegacode","address":"http://127.0.0.1:8724"}
    monkeypatch.setattr(f.services,"by_name",lambda name:dict(service))
    observed = []
    def probe(row):
        assert not f.db._conn.in_transaction
        observed.append(row["id"])
        service["id"] = "svc_after"
        return True
    monkeypatch.setattr(f.foundation,"_code_reachable",probe)
    assert f.foundation.ensure()["code_available"] is False
    assert observed == ["svc_before"] and f.collab.services(code) == []


def test_atomic_foundation_admission_never_invokes_readiness_socket(f,monkeypatch):
    available(f,monkeypatch)
    code = f.foundation._binding(CODE)["swarm_id"]
    def forbidden(service):
        raise AssertionError("network observation entered atomic admission")
    monkeypatch.setattr(f.foundation,"_code_reachable",forbidden)
    assert f.foundation.admission_limits(code)["request_usd"] == .25
    assert f.foundation.controller_ceiling(controller(f)["id"]) == .50


def test_held_review_has_no_same_owner_service_or_role_capability_offer(f):
    binding = f.foundation._binding(REVIEW)
    reviewer = controller(f,REVIEW)
    role = f.roles.view(f.roles.get(reviewer["role_id"]))
    assert role["mandate"] is None and role["media"] == []
    assert (reviewer["status"],reviewer["desired"]) == ("asleep","asleep")
    requester = f.create_swarm("Invented same-owner requester",owner=binding["principal"],visibility="private")
    assert f.collab.requester_viewer(requester["id"]).sees(f.swarm(binding["swarm_id"]))
    assert f.collab.requester_viewer(requester["id"]).sees(reviewer)
    services = f.collab.service_catalogue(requester["id"])
    assert not any(o["provider_swarm"] == binding["swarm_id"] for o in services["offers"])
    advertised = f.collab.capability_catalogue(requester["id"])
    assert not any(o["provider"]["id"] == reviewer["id"] for o in advertised["offers"])
    # Positive control: the original consumer still advertises an explicitly
    # declared, visible role. Only the held role producer is restricted.
    explicit = f.roles.create({"name":"Invented catalogue positive", "prompt":"Synthetic metadata only",
        "rules":[], "mandate":{"id":"invented-review-control","version":"1"}, "media":["deck"]})
    lead = controller(f)
    f.db.update("agents",lead["id"],{"role_id":explicit["id"]})
    advertised = f.collab.capability_catalogue(requester["id"])
    positive = [o for o in advertised["offers"] if o["provider"]["id"] == lead["id"]]
    assert {(o["capability"]["source"],o["capability"]["name"]) for o in positive} == {
        ("role.mandate","invented-review-control"),("role.media","deck")}
    assert not any(o["provider"]["id"] == reviewer["id"] for o in advertised["offers"])
    assert not f.supervisor.starts and f.db.all("SELECT * FROM usage") == []


@pytest.mark.parametrize("entry",["ensure","prepare_request"])
@pytest.mark.parametrize("drift",["model","same-model-key"])
def test_offer_publication_rechecks_actual_funding_after_outside_observation(f,monkeypatch,entry,drift):
    available(f,monkeypatch)
    binding = f.foundation._binding(CODE)
    before = controller(f)
    assert f.collab.services(binding["swarm_id"]) == ["code"]
    observed = []
    def probe(service):
        assert not f.db._conn.in_transaction
        observed.append((service["id"],service["address"]))
        if drift == "model":
            f.update_agent(before["id"],{"model":"mock/person-choice"},by=binding["principal"])
            # A person's explicit template choice made during the observation
            # must not be replaced later from the old controller snapshot.
            with f.db.transaction():
                f.minds.templates[CHILD_TEMPLATE]["model_id"] = "mock/person-template"
        else:
            monkeypatch.delenv("OPENROUTER_API_KEY")
        return True
    monkeypatch.setattr(f.foundation,"_code_reachable",probe)
    if entry == "ensure":
        assert f.foundation.ensure()["code_available"] is False
    else:
        with pytest.raises(HiveError,match="Code is unavailable"):
            f.foundation.prepare_request(binding["swarm_id"])
    assert observed == [("svc_invented","http://127.0.0.1:8724")]
    assert f.collab.services(binding["swarm_id"]) == []
    assert "unavailable" in f.swarm(binding["swarm_id"])["description"].lower()
    current = controller(f)
    assert current["id"] == before["id"]
    if drift == "model":
        assert current["model"] == "mock/person-choice"
        assert f.minds.templates[CHILD_TEMPLATE]["model_id"] == "mock/person-template"
    else:
        assert current["model"] == before["model"]
    assert not f.supervisor.starts and f.db.all("SELECT * FROM usage") == []


@pytest.mark.parametrize("reason", ["release_mismatch", "duplicate_discovery", "pin_conflict", "unpinned", "pins_invalid"])
def test_quiet_foundation_pin_refusal_is_one_warning_without_traceback(f, monkeypatch, caplog, reason):
    """Real Foundation/Programs refusal path; only maker and registry inputs are modeled."""
    uid = new_id("u")
    principal = "user:" + uid
    f.db.insert("people", {"id":uid, "email":"logging@example.test", "name":"Invented owner",
                           "role":"admin", "created_at":now()})
    monkeypatch.setenv("HIVE_STUDIO_PROGRAM", "omegadesign")
    monkeypatch.setattr(f.programs, "get", lambda program: {"error":reason + ": synthetic pin refusal"})
    def refused(person):
        assert person == principal
        return f.programs._ready("omegadesign")
    monkeypatch.setattr(f.studio_makers, "ensure", refused)
    caplog.clear()
    with caplog.at_level("WARNING", logger="hive"):
        assert f.foundation.ensure_quietly(principal) is None
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelname == "WARNING" and record.exc_info is None and record.stack_info is None
    assert record.getMessage() == ('hive foundation refused studio_program="omegadesign" reason="' + reason
                                   + '"; existing records retained')
    assert "Traceback (most recent call last):" not in caplog.text
    assert not f.supervisor.starts and f.db.all("SELECT * FROM usage") == []


def test_quiet_foundation_warning_fields_cannot_add_log_lines_or_private_details(f, monkeypatch, caplog):
    monkeypatch.setenv("HIVE_STUDIO_PROGRAM", "omegadesign\nTraceback (most recent call last):")
    error = HiveError(409, "refused\r\n\u2028Traceback (most recent call last):", "private diagnostic must stay private",
                      {"private":"invented sensitive detail"})
    def refused(principal=None):
        raise error
    monkeypatch.setattr(f.foundation, "ensure", refused)
    caplog.clear()
    with caplog.at_level("WARNING", logger="hive"):
        assert f.foundation.ensure_quietly("user:invented-private-principal") is None
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelname == "WARNING" and record.exc_info is None and record.stack_info is None
    assert len(record.getMessage().splitlines()) == 1
    assert "\\n" in record.getMessage() and "\\r" in record.getMessage() and "\\u2028" in record.getMessage()
    assert "private diagnostic" not in caplog.text and "invented sensitive detail" not in caplog.text
    assert "invented-private-principal" not in caplog.text


def test_quiet_foundation_unexpected_error_keeps_traceback_without_escaping(f, monkeypatch, caplog):
    error = RuntimeError("invented unexpected failure")
    error.code = "release_mismatch"  # A code-like attribute does not make an error an expected refusal.
    def broken(principal=None):
        raise error
    monkeypatch.setattr(f.foundation, "ensure", broken)
    caplog.clear()
    with caplog.at_level("WARNING", logger="hive"):
        assert f.foundation.ensure_quietly() is None
    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.levelname == "ERROR" and record.exc_info[1] is error
    assert record.getMessage() == "hive foundation could not be completed; existing records retained"
    assert "Traceback (most recent call last):" in caplog.text


def test_quiet_foundation_success_is_returned_unchanged_without_a_warning(f, monkeypatch, caplog):
    result = {"code_team":"invented-team", "studio":[]}
    calls = []
    def ensured(principal=None):
        calls.append(principal)
        return result
    monkeypatch.setattr(f.foundation, "ensure", ensured)
    caplog.clear()
    with caplog.at_level("WARNING", logger="hive"):
        assert f.foundation.ensure_quietly("user:invented") is result
    assert calls == ["user:invented"] and caplog.records == []


# ---- request helpers stay on the proposal path (attempt 13: code-read, then code-open, then blocked) ----

def _helper_hints():
    import importlib.util, re, sys
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "src"))
    spec = importlib.util.spec_from_file_location("hive_commons_helper_only", root / "modules/hive/src/hive_commons.py")
    hc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hc)
    text = (root / "modules/code/catalog.metta").read_text(encoding="utf-8")
    text += (root / "modules/hive/catalog.metta").read_text(encoding="utf-8")
    lines = [re.sub(r'\\(.)', r'\1', m) for m in re.findall(r'\(SkillContextHint\s+"[^"]+"\s+"((?:[^"\\]|\\.)+)"\)', text)]
    raw = "(" + " ".join('"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"' for s in lines) + ")"
    return hc, raw


def _skills_line(f, agent, monkeypatch):
    """The prompt's SKILLS line as this mind sees it: the real hive decisions, not a fake."""
    import re
    hc, raw = _helper_hints()
    hc._skill_view.update(at=0.0, key=None, modes=None)
    monkeypatch.setattr(hc, "_call", lambda method, path, payload=None: (f.policy.decisions(agent, payload["skills"]), None))
    return " ".join(re.findall(r'"((?:[^"\\]|\\.)*)"', hc.skill_hints(raw)))


def _helper(f, template_id=CHILD_TEMPLATE):
    """A mind made as spawn makes a request helper: the template's persona and role (the foundation helper role)."""
    from hive.core.foundation import HELPER_GUIDANCE
    b = f.foundation._binding(CODE)
    template = f.minds.templates[CHILD_TEMPLATE] if template_id == CHILD_TEMPLATE else {"template_id": template_id,
                                                                                         "role_id": None}
    persona = f.foundation.child_persona(template) or ""
    agent = f.create_agent("Invented helper", "omega", b["swarm_id"], "mock/echo", persona=persona,
                           budget_usd=.03, owner=b["principal"], by=b["principal"], role_id=template["role_id"])
    is_helper = template_id == CHILD_TEMPLATE
    assert (template["role_id"] == f.foundation.helper_role()["id"]) is is_helper
    assert (persona == HELPER_GUIDANCE) is is_helper
    return f.db.one("SELECT * FROM agents WHERE id=?", (agent["id"],))


def test_helper_skills_line_hides_direct_workspace_heads_and_keeps_the_proposal_path(f, monkeypatch):
    helper = _helper(f)
    line = _skills_line(f, helper, monkeypatch)
    for gone in ("code-open", "code-exec", "code-replace", "code-create", "code-move",
                 "code-remove", "code-git", "code-git-export", "code-merge-apply", "code-test-prepare"):
        assert not re.search(r"(?<![\w-])" + re.escape(gone) + r"(?![\w-])", line), gone
    for kept in ("code-proposal-context", "code-proposal-read", "code-propose", "hive-goal-propose", "hive-goal-claim"):
        assert kept in line, kept
    assert "Never code-open" in helper["persona"] and "code-proposal-context ws_id" in helper["persona"]


def test_helper_calling_code_open_is_denied_and_the_proposal_heads_still_run(f):
    helper = _helper(f)
    out = f.policy.authorize(helper, '(code-open "g_invented" "synthetic")')
    assert out["decision"] == "deny" and out["message"].startswith("HIVE-DENIED code-open")
    assert f.policy.authorize(helper, '(code-exec "ls")')["decision"] == "deny"
    # OmegaCode authorizes the helper's own proposal-path operations under these names; they must stay open.
    for skill in OMEGACODE_AUTHORIZE_SKILLS:
        assert f.policy.decide(helper, skill)[0] != "deny", skill
    for skill in ("code-proposal-context", "code-proposal-read", "code-propose", "hive-goal-propose"):
        assert f.policy.decide(helper, skill)[0] == "allow", skill
    assert f.policy.decide(helper, "code-mind-work")[0] == "ask"   # unchanged: never widened for a helper
    assert f.policy.decide(helper, "code-helper-instruction")[0] == "allow"   # its own request's instruction, by its role
    # the rules are the role's (note role:<name>), not seeded per agent
    rules = [r for r in f.policy.all_rules() if r["scope"] == "agent:" + helper["id"]]
    assert rules and all(r["note"] == "role:Foundation request helper" for r in rules)
    assert not [r for r in rules if r.get("origin") == "hive:foundation:code-helper:v1"]
    assert f.db.all("SELECT * FROM approvals WHERE agent_id=?", (helper["id"],)) == []


def test_controller_skills_are_unchanged_by_a_helper(f, monkeypatch):
    code = controller(f)
    skills = ["code-open", "code-read", "code-propose", "code-proposal-context", "code-test-prepare",
              *NATIVE_SKILLS, "hive-goal-propose"]
    before = f.policy.decisions(code, skills)
    line_before = _skills_line(f, code, monkeypatch)
    _helper(f)
    assert f.policy.decisions(code, skills) == before
    assert _skills_line(f, code, monkeypatch) == line_before
    assert "code-open" in line_before and "code-read" in line_before


def test_a_mind_from_another_template_is_unaffected(f, monkeypatch):
    other = _helper(f, template_id="person.code-helper.v1")
    assert other["persona"] == ""
    assert not [r for r in f.policy.all_rules() if r["scope"] == "agent:" + other["id"]]
    assert f.policy.decide(other, "code-open")[0] == "allow"
    assert f.policy.decide(other, "code-read")[0] == "allow"
    assert "code-open" in _skills_line(f, other, monkeypatch)


def test_helper_denials_never_cover_a_name_omegacode_authorizes_under():
    """Live attempt 14: denying code-read/code-workspace refused the helper's own code-proposal-context."""
    import fnmatch
    for pattern in HELPER_DENIED:
        for skill in OMEGACODE_AUTHORIZE_SKILLS:
            assert not fnmatch.fnmatchcase(skill, pattern), (pattern, skill)


def test_the_helper_role_has_host_provenance_and_rides_the_template(f):
    from hive.core.foundation import HELPER_ROLE, HELPER_ROLE_PURPOSE, HELPER_ROLE_RULES
    role = f.foundation.helper_role()
    bound = f.db.one("SELECT role_id FROM foundation_roles WHERE purpose = ?", (HELPER_ROLE_PURPOSE,))
    assert bound["role_id"] == role["id"] and role["name"] == HELPER_ROLE
    assert json.loads(role["rules"]) == HELPER_ROLE_RULES
    assert f.minds.templates[CHILD_TEMPLATE]["role_id"] == role["id"]
    assert f.foundation.helper_role()["id"] == role["id"]                 # idempotent: never a second role
    # a name is never provenance: with the binding gone, a same-named role is refused, never adopted
    f.db.execute("DELETE FROM foundation_roles WHERE purpose = ?", (HELPER_ROLE_PURPOSE,))
    with pytest.raises(Exception):
        f.foundation.helper_role()


def test_helpers_with_seeded_rules_are_migrated_to_the_role(f):
    from hive.core.foundation import HELPER_DENIED, HELPER_NOTE, HELPER_ORIGIN
    b = f.foundation._binding(CODE)
    old = f.create_agent("Old helper", "omega", b["swarm_id"], "mock/echo", budget_usd=.03, owner=b["principal"],
                         by=b["principal"])
    for skill in HELPER_DENIED:      # as b7131590 seeded them
        f.policy.add_rule("agent:" + old["id"], skill, "deny", note=HELPER_NOTE, origin=HELPER_ORIGIN, publish=False,
                          granted_by=b["principal"])
    assert f.foundation.migrate_helpers() == [old["id"]]
    agent = f.db.one("SELECT * FROM agents WHERE id = ?", (old["id"],))
    assert agent["role_id"] == f.foundation.helper_role()["id"]
    rules = [r for r in f.policy.all_rules() if r["scope"] == "agent:" + old["id"]]
    assert not [r for r in rules if r.get("origin") == HELPER_ORIGIN]
    assert f.policy.decide(agent, "code-open")[0] == "deny" and f.policy.decide(agent, "code-helper-instruction")[0] == "allow"
    assert f.foundation.migrate_helpers() == []                            # idempotent


def test_a_seeded_helper_that_holds_another_role_keeps_its_denials(f):
    from hive.core.foundation import HELPER_DENIED, HELPER_NOTE, HELPER_ORIGIN
    b = f.foundation._binding(CODE)
    other = f.roles.create({"name": "Invented other role", "summary": "s", "prompt": "p", "rules": [], "mandate": None,
                            "media": []})
    old = f.create_agent("Old helper with a role", "omega", b["swarm_id"], "mock/echo", budget_usd=.03,
                         owner=b["principal"], by=b["principal"], role_id=other["id"])
    for skill in HELPER_DENIED:
        f.policy.add_rule("agent:" + old["id"], skill, "deny", note=HELPER_NOTE, origin=HELPER_ORIGIN, publish=False,
                          granted_by=b["principal"])
    assert old["id"] not in f.foundation.migrate_helpers()
    agent = f.db.one("SELECT * FROM agents WHERE id = ?", (old["id"],))
    assert agent["role_id"] == other["id"] and f.policy.decide(agent, "code-open")[0] == "deny"   # never unrestricted


def test_a_missing_helper_role_is_said_plainly(f):
    from hive.core.foundation import HELPER_ROLE_PURPOSE
    assert f.foundation.helper_role_problem() is None
    role = f.foundation.helper_role()
    f.db.execute("UPDATE agents SET role_id = NULL WHERE role_id = ?", (role["id"],))
    f.db.execute("DELETE FROM roles WHERE id = ?", (role["id"],))
    assert "removed" in f.foundation.helper_role_problem()
    f.db.execute("DELETE FROM foundation_roles WHERE purpose = ?", (HELPER_ROLE_PURPOSE,))
    assert "not been created" in f.foundation.helper_role_problem()
