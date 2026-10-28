import json
from types import SimpleNamespace
import pytest
from hive.core.db import Database
from hive.core.evolve import EvolveRegistry
from hive.core.evolve_preflight import OBJECTIVE, digest
from hive.core.evolve_projection import project
from hive.core.programs import ProgramContext, validate_graph
from hive.plugins.omegaevolve import program


@pytest.fixture
def registry(tmp_path):
    hive = SimpleNamespace(db=Database(tmp_path / "evolve.sqlite"), lab=None)
    return EvolveRegistry(hive)


def actor(swarm="s1", owner=False):
    return {"principal": "user:quinn" if owner else "agent:researcher", "swarm_id": swarm,
            "kind": "person" if owner else "mind", "role": "owner" if owner else None,
            "local_operator": False}


def contribution():
    return {"title": "Synthetic proposal", "claim": "Try a clearer skill-help revision",
            "method": "synthetic critique", "affected_revision": digest("help-v1"),
            "evidence": [{"source": "synthetic-report", "locator": "case-1", "origin": "synthetic-origin"}],
            "uncertainty": {"method": "qualitative", "status": "unverified"}}


def registration():
    return {"objective": OBJECTIVE, "baseline_pin": digest("baseline"), "candidate_pin": digest("candidate"),
            "evaluator_pin": digest("evaluator"), "heldout_digest": digest("hidden"),
            "budget": {"model_calls": 0, "network_calls": 0}, "quality_rubric": "task success",
            "beneficialness_criteria": "protected floors", "stop_rule": "stop at cap",
            "review_owners": ["OmegaReview", "OmegaAlignment"],
            "thresholds": {"min_quality": .8, "min_quality_gain": .1, "max_attempts": 3, "max_cost": 0}}


def test_contribution_has_host_author_and_unresolved_custody(registry):
    row = registry.contribute("s1", actor(), contribution())
    assert row["author"] == "agent:researcher"
    assert row["body"]["evidence"][0]["verified"] is False
    assert row["body"]["adoption_authorized"] is False
    assert registry.records("s2", row["id"]) == []


def test_missing_provenance_and_authority_payload_refused(registry):
    for field, value in (("evidence", []), ("uncertainty", {}), ("adopter", "Quinn"),
                         ("code", "!(import! &self evil)")):
        payload = contribution()
        payload[field] = value
        with pytest.raises(ValueError):
            registry.contribute("s1", actor(), payload)


def test_identity_and_swarm_cannot_be_forged(registry):
    for identity in (None, actor("s2")):
        with pytest.raises(PermissionError):
            registry.contribute("s1", identity, contribution())


def test_retry_and_retraction_preserve_original(registry):
    first = registry.contribute("s1", actor(), contribution())
    assert registry.contribute("s1", actor(), contribution())["id"] == first["id"]
    correction = dict(contribution(), predecessor=first["id"], claim="Retract the earlier synthetic claim")
    second = registry.contribute("s1", actor(), correction)
    assert second["id"] != first["id"]
    assert registry.records("s1", first["id"])[0] == first
    with pytest.raises(ValueError):
        registry.contribute("s2", actor("s2"), correction)


def test_registration_requires_named_owner(registry):
    for identity in (actor(), dict(actor(owner=True), local_operator=True)):
        with pytest.raises(PermissionError):
            registry.register("s1", identity, registration())
    sealed = registry.register("s1", actor(owner=True), registration())
    assert sealed["body"]["state"] == "registered-offline"


def test_a_named_admin_person_is_the_owner_and_nothing_else_is(registry):
    admin = dict(actor(owner=True), role="admin")
    assert registry.register("s1", admin, registration())["body"]["state"] == "registered-offline"
    for refused in (dict(admin, role="member"), dict(admin, local_operator=True), dict(admin, principal="user:operator"),
                    dict(admin, principal="agent:researcher"), dict(admin, swarm_id="s2"), dict(admin, kind="mind")):
        with pytest.raises(PermissionError):
            registry.register("s1", refused, registration())


def test_lab_receipt_uses_host_run_and_claims_only_protocol(registry):
    experiment = registry.register("s1", actor(owner=True), registration())
    run = {"suite": "tests-evolve", "status": "passed", "commit_sha": "synthetic-pin",
           "cases": [{"status": "passed"}]}
    registry.hive.lab = SimpleNamespace(run=lambda identifier: run)
    receipt = registry.lab_receipt("s1", actor(owner=True), experiment["id"], "lab-synthetic")
    assert receipt["body"]["candidate_evaluated"] is False
    assert receipt["body"]["adoption_authorized"] is False
    assert receipt["body"]["beneficialness"] == "unassessed"
    run["cases"][0]["status"] = "skipped"
    with pytest.raises(ValueError):
        registry.lab_receipt("s1", actor(owner=True), experiment["id"], "lab-synthetic")


def test_graph_is_contract_valid(registry):
    ctx = SimpleNamespace(evolve_snapshot=lambda focus: registry.snapshot("s1", focus))
    graph = program.view(ctx, None, "unfold")
    def fail(message):
        raise AssertionError(message)
    validate_graph("omegaevolve", program.describe(), graph, "unfold", fail)
    assert "Native shared AtomSpace publication is not enabled" in graph["notes"][2]


def test_r17_cannot_accept_unreviewed_completion():
    assert program.validate_result(None, {}, {"adopter": "Quinn", "review": "accepted"}).get("errors")


def test_native_projection_never_embeds_submitted_code(registry):
    payload = contribution()
    payload["claim"] = '\") !(py-call ("os.system" "echo evil")) ;'
    record = registry.contribute("s1", actor(), payload)
    atom = project(record)
    assert "py-call" not in atom and "evil" not in atom
    assert digest(record["body"]) in atom
    assert registry.records("s1", record["id"])[0]["body"]["claim"] == payload["claim"]


def test_records_survive_database_reopen(tmp_path):
    path = tmp_path / "restart.sqlite"
    first = EvolveRegistry(SimpleNamespace(db=Database(path)))
    record = first.contribute("s1", actor(), contribution())
    first.db._conn.close()
    reopened = EvolveRegistry(SimpleNamespace(db=Database(path)))
    assert reopened.records("s1", record["id"]) == [record]


def test_other_program_cannot_use_registry_even_with_capability(registry):
    registry.hive.swarm = lambda identifier: {"id": identifier}
    ctx = ProgramContext(registry.hive, "s1", {"id": "other", "capabilities": ["evolve:read"]})
    with pytest.raises(PermissionError):
        ctx.evolve_records()
