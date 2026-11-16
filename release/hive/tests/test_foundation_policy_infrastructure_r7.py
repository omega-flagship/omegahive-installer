"""R7 policy projection controls: real app/DB, synthetic people, no worker or provider starts.

Original owner/approval, budget, catalogue, wording and power tests stay unchanged.
Infrastructure is an explicit read view of the same rule rows, never another authority.
"""
import copy

import pytest

from hive.core.db import now
from hive.core.foundation import CODE, REVIEW, NATIVE_SKILLS, READ_SKILLS, WRITE_SKILLS, RULE_ORIGIN
from hive.tests.test_hive_foundation import (  # noqa: F401 (original real-app fixtures)
    f, hive_app, controlled_environment, controller,
)


def by_id(rows):
    return {row["id"]: dict(row) for row in rows}


def test_ordinary_listing_stays_empty_while_all_nine_real_rules_remain_stored_and_enforced(f):
    code, review = controller(f), controller(f, REVIEW)
    stored = f.db.all("SELECT * FROM policy_rules WHERE expires_at IS NULL ORDER BY created_at")
    assert len(stored) == len(NATIVE_SKILLS) == 9
    assert f.policy.rules() == []
    assert by_id(f.policy.all_rules()) == by_id(stored)
    shown = f.policy.infrastructure_rules()
    assert {row["id"] for row in shown} == {row["id"] for row in stored}
    for row in shown:
        assert {key: value for key, value in row.items() if key != "infrastructure"} == by_id(stored)[row["id"]]
        proof = row["infrastructure"]
        assert (proof["purpose"], proof["agent_id"], proof["swarm_id"], proof["binding_principal"]) == (
            CODE, code["id"], code["swarm_id"], code["owner"])
        assert proof["rule_origin"] == RULE_ORIGIN
        assert proof["historical_granted_by"] == row["granted_by"]
        assert proof["execution_admission_verified"] is False
    for skill in NATIVE_SKILLS:
        assert f.policy.decide(code, skill)[0] == "allow"
        assert f.policy.decide(review, skill)[0] == ("deny" if skill in WRITE_SKILLS else "ask")


def test_original_policy_route_defaults_to_ordinary_and_explicit_views_disclose_infrastructure(hive_app):
    hive, client, admin, _, _ = hive_app
    for url in ("/api/policy", "/api/policy?view=ordinary"):
        response = client.get(url, headers=admin)
        assert response.status_code == 200 and response.json() == []
    infrastructure = client.get("/api/policy?view=infrastructure", headers=admin)
    assert infrastructure.status_code == 200
    assert len(infrastructure.json()) == 9
    assert all(row["infrastructure"]["purpose"] == CODE for row in infrastructure.json())
    all_views = client.get("/api/policy?view=all", headers=admin)
    assert all_views.status_code == 200
    assert all_views.json() == {"rules": [], "infrastructure_rules": infrastructure.json()}
    assert by_id(hive.policy.all_rules()) == by_id(
        [{key: value for key, value in row.items() if key != "infrastructure"} for row in infrastructure.json()])
    bad = client.get("/api/policy?view=hidden", headers=admin)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_request"
    anonymous = client.get("/api/policy?view=all")
    assert anonymous.status_code == 401


def test_policy_writer_cannot_claim_host_origin_through_request_data(hive_app):
    hive, client, admin, _, _ = hive_app
    code = controller(hive)
    response = client.post("/api/policy", headers=admin, json={
        "scope": "agent:" + code["id"], "skill": READ_SKILLS[0], "mode": "allow", "origin": RULE_ORIGIN,
    })
    assert response.status_code == 200, response.text
    row = response.json()
    assert row["origin"] == "" and row["granted_by"] == "user:operator"
    assert by_id(hive.policy.rules()) == {row["id"]: row}
    assert row["id"] not in {item["id"] for item in hive.policy.infrastructure_rules()}


@pytest.mark.parametrize("change", ["foreign_actor", "swarm_scope", "other_skill", "other_origin", "ask", "deny"])
def test_origin_alone_never_hides_an_ordinary_rule(f, change):
    code, review = controller(f), controller(f, REVIEW)
    scope, skill, mode, origin = "agent:" + code["id"], READ_SKILLS[0], "allow", RULE_ORIGIN
    if change == "foreign_actor":
        scope = "agent:" + review["id"]
    elif change == "swarm_scope":
        scope = "swarm:" + code["swarm_id"]
    elif change == "other_skill":
        skill = "send"
    elif change == "other_origin":
        origin = "answer"
    else:
        mode = change
    row = f.policy.add_rule(scope, skill, mode, origin=origin, granted_by=code["owner"])
    assert by_id(f.policy.rules()) == {row["id"]: row}
    assert row["id"] not in {item["id"] for item in f.policy.infrastructure_rules()}
    assert by_id(f.policy.all_rules())[row["id"]] == row


@pytest.mark.parametrize("change", ["purpose", "agent_owner", "swarm_owner", "coordinator", "agent_swarm", "deleted", "driver", "kind", "archived"])
def test_drifted_binding_cannot_hide_active_rule_rows(f, change):
    code, review = controller(f), controller(f, REVIEW)
    before = by_id(f.policy.all_rules())
    if change == "purpose":
        f.db.execute("UPDATE person_minds SET purpose=? WHERE purpose=?", ("synthetic_stale_purpose", CODE))
    elif change == "agent_owner":
        f.db.execute("UPDATE agents SET owner=? WHERE id=?", ("user:synthetic_other", code["id"]))
    elif change == "swarm_owner":
        f.db.execute("UPDATE swarms SET owner=? WHERE id=?", ("user:synthetic_other", code["swarm_id"]))
    elif change == "coordinator":
        f.db.execute("UPDATE swarms SET coordinator_id=? WHERE id=?", (review["id"], code["swarm_id"]))
    elif change == "agent_swarm":
        f.db.execute("UPDATE agents SET swarm_id=? WHERE id=?", (review["swarm_id"], code["id"]))
    elif change == "deleted":
        f.db.execute("UPDATE agents SET deleted=1 WHERE id=?", (code["id"],))
    elif change == "driver":
        f.db.execute("UPDATE agents SET driver='synthetic_other' WHERE id=?", (code["id"],))
    elif change == "kind":
        f.db.execute("UPDATE agents SET kind='module' WHERE id=?", (code["id"],))
    else:
        f.db.execute("UPDATE swarms SET archived_at=? WHERE id=?", (now(), code["swarm_id"]))
    assert f.policy.infrastructure_rules() == []
    assert by_id(f.policy.rules()) == by_id(f.policy.all_rules()) == before


def test_global_owner_change_and_later_adoption_preserve_historical_grantor_provenance(f):
    original = dict(f.foundation._binding(CODE))
    before = by_id(f.policy.all_rules())
    person = "u_r7_projection_owner"
    f.db.insert("people", {"id": person, "email": "r7-owner@example.test", "name": "R7 synthetic owner",
                           "role": "admin", "created_at": now()})
    f.db.execute("UPDATE hive_owner SET owner=?, via='first-admin' WHERE id=1", ("user:" + person,))
    shown = f.policy.infrastructure_rules()
    assert len(shown) == 9 and f.policy.rules() == []
    assert all(row["infrastructure"]["owner_drift"] is True for row in shown)
    assert all(row["infrastructure"]["current_hive_owner"] == "user:" + person for row in shown)
    assert f.foundation._binding(CODE) == original  # the read did not adopt anyone
    assert by_id(f.policy.all_rules()) == before
    f.foundation.ensure()
    binding = f.foundation._binding(CODE)
    assert binding["principal"] == "user:" + person
    shown = f.policy.infrastructure_rules()
    assert len(shown) == 9 and f.policy.rules() == []
    assert all(row["infrastructure"]["owner_drift"] is False for row in shown)
    assert all(row["infrastructure"]["historical_granted_by"] == original["principal"] for row in shown)
    assert by_id(f.policy.all_rules()) == before


@pytest.mark.parametrize("scope_kind", ["hive", "swarm", "agent"])
@pytest.mark.parametrize("mode", ["ask", "deny"])
def test_person_refusals_stay_ordinary_and_foundation_refresh_preserves_their_effect(f, scope_kind, mode):
    code = controller(f)
    scope = {"hive": "hive", "swarm": "swarm:" + code["swarm_id"], "agent": "agent:" + code["id"]}[scope_kind]
    row = f.policy.add_rule(scope, READ_SKILLS[0], mode, origin="answer", granted_by=code["owner"])
    f.foundation.ensure()
    assert by_id(f.policy.rules()) == {row["id"]: row}
    assert f.policy.decide(code, READ_SKILLS[0])[0] == mode
    assert row["id"] in by_id(f.policy.all_rules())
    assert READ_SKILLS[0] not in {item["skill"] for item in f.policy.infrastructure_rules()}


def test_role_cleanup_and_answer_supersession_keep_real_host_grants(f):
    code = controller(f)
    original = by_id(f.policy.all_rules())
    role_rule = f.policy.add_rule("agent:" + code["id"], "send", "ask", note="role:R7 synthetic", granted_by=code["owner"])
    with f.db.transaction():
        f.roles._apply_rules(code["id"], None)
    assert f.db.one("SELECT * FROM policy_rules WHERE id=?", (role_rule["id"],)) is None
    assert by_id(f.policy.all_rules()) == original
    answer = f.policy.add_rule("agent:" + code["id"], READ_SKILLS[0], "ask", origin="answer", granted_by=code["owner"])
    f.policy._supersede(code["id"], READ_SKILLS[0])
    assert answer["id"] not in by_id(f.policy.all_rules())
    assert by_id(f.policy.all_rules()) == original
    assert f.policy.decide(code, READ_SKILLS[0])[0] == "allow"


def test_policy_updated_events_truthfully_include_both_views_and_do_not_mutate_rows(f, monkeypatch):
    events = []
    monkeypatch.setattr(f.events, "publish", lambda kind, **payload: events.append((kind, copy.deepcopy(payload))))
    row = f.policy.add_rule("hive", "synthetic-r7-policy", "ask", origin="answer", granted_by="user:operator")
    assert len(events) == 1 and events[0][0] == "policy.updated"
    payload = events[0][1]
    assert payload == f.policy.rule_views()
    assert payload["rules"] == [row] and len(payload["infrastructure_rules"]) == 9
    stored = by_id(f.policy.all_rules())
    payload["infrastructure_rules"][0]["infrastructure"]["purpose"] = "changed-in-test-copy"
    assert by_id(f.policy.all_rules()) == stored
    assert all(item["infrastructure"]["purpose"] == CODE for item in f.policy.infrastructure_rules())
