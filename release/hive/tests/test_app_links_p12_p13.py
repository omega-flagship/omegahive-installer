"""Synthetic P12/P13 data-contract checks. No setup/open authority is simulated."""
import pytest
import json
from types import SimpleNamespace

from hive.core.app_links import LINK_REASONS, link_result, parse_related_apps
from hive.core.programs import Programs
from hive.core.person_swarms import parse_templates
from hive.core.hive import HiveError, token_hash
from hive.core.visibility import Viewer
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_key_owner_oi13 import w, ANN, BOB, MODEL  # noqa: F401
from hive.tests.test_person_swarms_p2 import p  # noqa: F401
import asyncio
import copy
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event


def test_related_apps_bound_and_detached_from_the_input_list():
    values = [f"target-{i}" for i in range(8)]
    parsed = parse_related_apps(values)
    values.clear()
    assert len(parsed) == 8
    with pytest.raises(ValueError):
        parse_related_apps([f"target-{i}" for i in range(9)])


@pytest.mark.parametrize("value", ["target", {}, [None], ["Target"], ["../target"], ["a"], ["ab", "ab"]])
def test_related_apps_rejects_malformed_declarations(value):
    with pytest.raises(ValueError):
        parse_related_apps(value)


def test_missing_declaration_is_empty_and_self_open_is_not_banned():
    assert parse_related_apps(None) == []
    assert parse_related_apps(["caller-fixture"]) == ["caller-fixture"]


def test_result_constructor_can_only_return_state_and_a_closed_reason():
    assert link_result("ready") == {"state": "ready"}
    assert link_result("declined") == {"state": "declined"}
    assert link_result("needs_grown_up") == {"state": "needs_grown_up"}
    for reason in LINK_REASONS:
        assert link_result("refused", reason) == {"state": "refused", "reason": reason}
    for state, reason in [("pending_adult", None), ("refused", "self"), ("refused", "expired"), ("ready", "depth")]:
        with pytest.raises(ValueError):
            link_result(state, reason)


def test_over_eight_is_a_loader_refusal_before_any_app_import(tmp_path, monkeypatch):
    raw = json.dumps({"id": "caller-fixture", "related_apps": [f"target-{i}" for i in range(9)]}).encode()
    monkeypatch.setattr(Programs, "_source_snapshot", staticmethod(lambda folder: ("sha256:" + "a" * 64, raw)))
    imported = []
    def forbidden_import(*args):
        imported.append(args)
        raise AssertionError("an invalid declaration must not import app code")
    monkeypatch.setattr("hive.core.programs.importlib.util.spec_from_file_location", forbidden_import)
    programs = Programs.__new__(Programs)
    entry = programs._load(tmp_path, tmp_path / "plugin.json", "invented-fixture")
    assert entry["error"].startswith("ValueError: related_apps")
    assert imported == []


def manifest_reader(monkeypatch, raw, digest="sha256:" + "a" * 64):
    programs = Programs.__new__(Programs)
    # No app code or directory is consulted. The synthetic entry deliberately
    # lies about its display fields; only the pinned raw manifest may supply them.
    entry = {"id": "caller-fixture", "name": "MUTATED NAME", "path": "/synthetic-only", "digest": digest,
             "related_apps": ["undeclared-fixture"]}
    programs.hive = SimpleNamespace(error=lambda *args: RuntimeError("closed"))
    programs._ready = lambda app: entry
    programs.pinned_release = lambda app: {"digest": digest, "version": "1", "path": entry["path"]}
    monkeypatch.setattr(Programs, "_source_snapshot", staticmethod(lambda folder: (digest, raw)))
    return programs


def test_release_metadata_uses_the_hashed_manifest_not_mutable_entry_fields(monkeypatch):
    raw = json.dumps({"id": "caller-fixture", "name": "Pinned caller", "version": "1", "related_apps": ["target-fixture"]}).encode()
    programs = manifest_reader(monkeypatch, raw)
    first = programs.link_manifest("caller-fixture")
    assert first == {"id": "caller-fixture", "name": "Pinned caller", "release_digest": "sha256:" + "a" * 64,
                     "version": "1", "related_apps": ["target-fixture"], "capabilities": [], "swarm_templates": {}}
    first["related_apps"].clear()
    assert programs.link_manifest("caller-fixture")["related_apps"] == ["target-fixture"]


@pytest.mark.parametrize("change", ["unpinned", "digest", "id", "version"])
def test_release_metadata_fails_closed_on_a_pin_or_identity_mismatch(monkeypatch, change):
    manifest = {"id": "caller-fixture", "name": "Pinned caller", "version": "1"}
    if change in ("id", "version"):
        manifest[change] = "different"
    programs = manifest_reader(monkeypatch, json.dumps(manifest).encode())
    if change == "unpinned":
        programs.pinned_release = lambda app: None
    if change == "digest":
        monkeypatch.setattr(Programs, "_source_snapshot", staticmethod(lambda folder: ("sha256:" + "b" * 64, b"{}")))
    with pytest.raises(RuntimeError):
        programs.link_manifest("caller-fixture")


CALLER, TARGET, THIRD = "link-caller-fixture", "link-target-fixture", "link-third-fixture"
TEMPLATE = {"minds": [{"slot": "helper", "name": "Invented helper", "model": MODEL}],
            "rules": [{"skill": "denied-skill", "mode": "deny"}]}


@pytest.fixture()
def links(p, monkeypatch):
    """Real API/P2/P1/DB, synthetic pinned catalog, no application/model call."""
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    h = p.hive
    catalog = {}
    for app, related, templates in [(CALLER, [TARGET, THIRD, CALLER], {}),
                                     (TARGET, [CALLER], parse_templates({"helpers": TEMPLATE})),
                                     (THIRD, [], parse_templates({"helpers": TEMPLATE}))]:
        digest = "sha256:" + ("a" if app == CALLER else "b" if app == TARGET else "c") * 64
        h.programs.programs[app] = {"id": app, "name": "PINNED " + app, "version": "1", "digest": digest,
            "error": None, "capabilities": ["person_swarm"] if templates else [], "swarm_templates": templates}
        catalog[app] = {"id": app, "name": "PINNED " + app, "version": "1", "release_digest": digest,
            "related_apps": related, "capabilities": ["person_swarm"] if templates else [], "swarm_templates": templates}
    def metadata(app):
        entry = h.programs._ready(app)
        if app not in catalog or entry["digest"] != catalog[app]["release_digest"]:
            raise h.error(409, "not_available", "synthetic pin mismatch")
        return copy.deepcopy(catalog[app])
    monkeypatch.setattr(h.programs, "link_manifest", metadata)
    monkeypatch.setattr(h.programs, "pinned_release", lambda app: {"digest": metadata(app)["release_digest"], "version": "1"})
    p.catalog, p.time = catalog, [100.0]
    h.app_links.clock = lambda: p.time[0]
    h.app_ask.clock = lambda: p.time[0]
    origin = "http://127.0.0.1:" + os.environ.get("HIVE_PORT", "8700")
    p.headers, p.admin_headers = dict(p.bob, Origin=origin), dict(p.ann, Origin=origin)
    p.principal, p.viewer = f"user:{BOB}", Viewer(f"user:{BOB}", False)
    p.session = token_hash(p.bob["Authorization"].split(" ", 1)[1])
    return p


def register(t, app=CALLER, slot="caller-document", entry=None, swarm=None):
    data = {"swarm_id": swarm or t.bob_swarm["id"], "frame_slot_id": slot}
    if entry:
        data["entry_id"] = entry["id"]
    response = t.client.post(f"/api/programs/{app}/app-links/frames", headers=t.headers, json=data)
    assert response.status_code == 200, response.text
    return response.json()["frame_id"]


def prepare(t, fid, target=TARGET, kind="app-setup", caller=CALLER):
    response = t.client.post(f"/api/programs/{caller}/app-links/frames/{fid}/prepare", headers=t.headers,
                             json={"type": kind, "app": target})
    assert response.status_code == 200, response.text
    return response.json()


def decide(t, fid, rid, approve=True, open_now=False, caller=CALLER):
    response = t.client.post(f"/api/programs/{caller}/app-links/frames/{fid}/reviews/{rid}/decide", headers=t.headers,
                             json={"approve": approve, "open_now": open_now})
    assert response.status_code == 200, response.text
    return response.json()


def setup_entry(t):
    fid = register(t)
    card = prepare(t, fid)["review"]
    result = decide(t, fid, card["id"], open_now=True)
    assert result["result"] == {"state": "ready"}, result
    return fid, card, result["entry"]


def provision_counts(hive):
    return {table: hive.db.one(f"SELECT COUNT(*) AS n FROM {table}")["n"]
            for table in ("agents", "swarms", "app_person_consents", "app_person_minds", "ask_turns")}


def test_host_card_uses_pinned_names_template_and_host_price_guide_before_effects(links):
    t = links
    fid = register(t)
    before = provision_counts(t.hive)
    card = prepare(t, fid)["review"]
    assert provision_counts(t.hive) == before
    assert card["caller_name"] == t.catalog[CALLER]["name"]
    assert card["target_name"] == t.catalog[TARGET]["name"]
    assert card["template"]["template_digest"] == t.catalog[TARGET]["swarm_templates"]["helpers"]["digest"]
    assert card["price_guide"] and MODEL in card["price_guide"][0]
    assert card["approved_revision"]
    assert decide(t, fid, card["id"], approve=False) == {"result": {"state": "declined"}}
    assert provision_counts(t.hive) == before


def test_undeclared_installed_and_absent_targets_are_the_same_without_lookup(links, monkeypatch):
    t = links; fid = register(t)
    lookups = []
    monkeypatch.setattr(t.hive.app_links, "_target", lambda *args: lookups.append(args))
    for target in ("installed-unrelated-fixture", "absent-unrelated-fixture"):
        assert prepare(t, fid, target) == {"result": {"state": "refused", "reason": "not_related"}}
    assert lookups == []


def test_pending_reuse_busy_three_setup_calls_and_revision_expiry(links):
    t = links; fid = register(t)
    first = prepare(t, fid)["review"]
    assert prepare(t, fid)["review"]["id"] == first["id"]
    assert prepare(t, fid, THIRD) == {"result": {"state": "refused", "reason": "busy"}}
    assert prepare(t, fid) == {"result": {"state": "refused", "reason": "rate_limited"}}
    t.time[0] += 60
    t.hive.person_swarms.withdraw(t.principal, TARGET, "helpers")
    assert prepare(t, fid) == {"result": {"state": "declined"}}
    assert decide(t, fid, first["id"]) == {"result": {"state": "declined"}}


def test_child_gets_host_line_and_no_provision_or_session_and_null_is_adult(links):
    t = links
    t.hive.db.execute("UPDATE people SET profile_kind = 'child' WHERE id = ?", (BOB,))
    fid = register(t); before = provision_counts(t.hive)
    for kind in ("app-setup", "app-open"):
        assert prepare(t, fid, kind=kind) == {"result": {"state": "needs_grown_up"}, "notice": "A grown-up needs to do this bit"}
    assert provision_counts(t.hive) == before
    t.hive.db.execute("UPDATE people SET profile_kind = NULL WHERE id = ?", (BOB,))
    assert "review" in prepare(t, fid)


def test_profile_kind_admin_acl_rejects_member_self_service_and_admin_self_change(links):
    t = links
    path = f"/api/people/{BOB}/profile-kind"
    assert t.client.patch(path, headers=t.headers, json={"profile_kind": "adult"}).status_code == 403
    assert t.client.patch(f"/api/people/{ANN}/profile-kind", headers=t.admin_headers, json={"profile_kind": "adult"}).status_code == 403
    assert t.client.patch(path, headers=t.admin_headers, json={"profile_kind": "restricted"}).status_code == 400
    assert t.client.patch(path, headers=t.admin_headers, json={"profile_kind": "child"}).status_code == 200
    assert t.hive.db.one("SELECT profile_kind FROM people WHERE id = ?", (BOB,))["profile_kind"] == "child"


def test_c2_binds_exact_displayed_revision_and_does_not_authorize_ordinary_frame_entry(links):
    t = links; _, shown, entry = setup_entry(t)
    consent = t.hive.db.one("SELECT * FROM app_person_consents WHERE principal = ? AND program_id = ?", (t.principal, TARGET))
    assert consent["granted_at"] == shown["approved_revision"]
    host = t.hive.app_links.entries[entry["id"]]
    assert host["p2"]["consent_revision"] == {"granted_at": shown["approved_revision"], "withdrawn_at": None}
    ordinary = t.client.post(f"/api/programs/{TARGET}/ask/frames", headers=t.headers,
                            json={"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "ordinary-not-authorized"})
    assert ordinary.status_code == 409
    assert ordinary.json()["error"]["code"] == "consent_required"


def test_two_workspaces_two_windows_redeem_one_pass_exactly_once(links):
    t = links; source, _, entry = setup_entry(t)
    first = register(t, TARGET, "workspace-one-window-one", entry, entry["swarm_id"])
    second = register(t, TARGET, "workspace-two-window-two", entry, entry["swarm_id"])
    def redeem(slot, fid):
        try:
            lease = t.hive.app_links.redeem(t.viewer, t.session, entry["id"],
                {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": slot})
            return fid, lease
        except HiveError:
            return fid, None
    with ThreadPoolExecutor(max_workers=2) as pool:
        outputs = list(pool.map(lambda args: redeem(*args), [("workspace-one-window-one", first), ("workspace-two-window-two", second)]))
    winners = [(fid, lease) for fid, lease in outputs if lease is not None]
    assert len(winners) == 1
    assert t.hive.app_links.entries[entry["id"]]["target_frame"] == winners[0][0]
    assert t.hive.app_links.check_entry(t.viewer, t.session, entry["id"], winners[0][0]) == {"current": True}
    # Closing the caller after a fast redemption must preserve that exact handoff.
    t.hive.app_links.close(t.viewer, t.session, CALLER, source, entry["id"])
    assert t.hive.app_links.check_entry(t.viewer, t.session, entry["id"], winners[0][0]) == {"current": True}


@pytest.mark.parametrize("change", ["expired", "withdrawn", "reconsent", "identity", "uninstall", "limits", "limits_roundtrip", "key"])
def test_c2_invalidations_are_live_at_redemption(links, change):
    t = links; _, _, entry = setup_entry(t)
    register(t, TARGET, "new-target-document", entry, entry["swarm_id"])
    if change == "expired": t.time[0] += 120
    elif change == "withdrawn": t.hive.person_swarms.withdraw(t.principal, TARGET, "helpers")
    elif change == "reconsent":
        t.hive.person_swarms.withdraw(t.principal, TARGET, "helpers")
        t.hive.person_swarms.consent(t.principal, TARGET, "helpers", t.hive.person_swarms.card(t.principal, TARGET, "helpers"))
    elif change == "identity": t.hive.app_links.mark_session(t.session)
    elif change == "uninstall": t.hive.programs.disabled.add(TARGET)
    elif change in ("limits", "limits_roundtrip"):
        assert t.client.put("/api/me/key-limits/self", headers=t.headers, json={"month_usd": 20}).status_code == 200
        if change == "limits_roundtrip":
            assert t.client.put("/api/me/key-limits/self", headers=t.headers, json={"month_usd": 10}).status_code == 200
    elif change == "key":
        chosen = t.hive.app_links.entries[entry["id"]]["p2"]["key_id"]
        t.hive.keyring.ring["keys"].pop(chosen)  # synthetic fixture key; no provider or private file
    with pytest.raises(HiveError):
        t.hive.app_links.redeem(t.viewer, t.session, entry["id"],
            {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "new-target-document"})


def test_generation_close_expires_pending_review_without_rebinding(links):
    t = links; fid = register(t); review = prepare(t, fid)["review"]
    t.hive.app_links.close(t.viewer, t.session, CALLER, fid)
    assert t.hive.app_links.reviews[review["id"]]["settled"] == {"state": "declined"}
    assert provision_counts(t.hive)["app_person_consents"] == 0
    with pytest.raises(HiveError):
        t.hive.app_links.decide(t.viewer, t.session, CALLER, fid, review["id"], {"approve": True, "open_now": True})


def test_p13_has_no_extra_rate_quota_and_each_open_needs_its_own_host_decision(links):
    t = links; fid = register(t); first = prepare(t, fid)["review"]
    assert decide(t, fid, first["id"])["result"] == {"state": "ready"}
    for _ in range(6):
        card = prepare(t, fid, kind="app-open")["review"]
        assert card["kind"] == "app-open"
        assert decide(t, fid, card["id"], approve=False)["result"] == {"state": "declined"}
    assert t.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations")["n"] == 0


def test_structured_intent_is_rejected_before_act_and_does_not_enter_rule_arguments(links, monkeypatch):
    t = links; calls = []
    monkeypatch.setattr(t.hive.programs, "_ready", lambda app: calls.append(app))
    with pytest.raises(HiveError):
        asyncio.run(t.hive.programs.act(TARGET, t.bob_swarm["id"], "denied-skill", [],
                    params={"nested": {"untrusted_intent": "denied-skill"}}))
    assert calls == []


@pytest.mark.parametrize("count", [0, 2])
def test_target_requires_exactly_one_reviewed_person_template(links, count):
    t = links
    templates = {} if count == 0 else parse_templates({"first": TEMPLATE, "second": TEMPLATE})
    t.catalog[TARGET]["swarm_templates"] = templates
    t.hive.programs.programs[TARGET]["swarm_templates"] = templates
    result = prepare(t, register(t))
    assert result["result"] == {"state": "refused", "reason": "not_available"}
    assert provision_counts(t.hive)["app_person_minds"] == 0


def test_tombstoned_target_stays_withdrawn_instead_of_gaining_an_onward_restore_choice(links):
    t = links; t.hive.person_swarms.withdraw(t.principal, TARGET, "helpers")
    before = provision_counts(t.hive)
    row = t.hive.db.one("SELECT * FROM app_person_consents WHERE principal = ? AND program_id = ?", (t.principal, TARGET))
    assert prepare(t, register(t))["result"] == {"state": "refused", "reason": "not_available"}
    assert provision_counts(t.hive) == before
    assert t.hive.db.one("SELECT * FROM app_person_consents WHERE principal = ? AND program_id = ?", (t.principal, TARGET)) == row


def test_child_cannot_open_a_target_set_up_by_another_principal(links):
    t = links; setup_entry(t)
    t.hive.db.execute("UPDATE people SET profile_kind = 'child' WHERE id = ?", (ANN,))
    opened = t.client.post(f"/api/programs/{CALLER}/app-links/frames", headers=t.admin_headers,
                          json={"swarm_id": t.shared["id"], "frame_slot_id": "child-other-window"})
    assert opened.status_code == 200
    before = provision_counts(t.hive)
    result = t.client.post(f"/api/programs/{CALLER}/app-links/frames/{opened.json()['frame_id']}/prepare",
                           headers=t.admin_headers, json={"type": "app-open", "app": TARGET})
    assert result.json()["result"] == {"state": "needs_grown_up"}
    assert provision_counts(t.hive) == before


def test_self_setup_is_forbidden_without_inventing_a_self_open_ban(links):
    t = links; fid = register(t)
    assert prepare(t, fid, CALLER)["result"] == {"state": "refused", "reason": "not_available"}
    templates = parse_templates({"helpers": TEMPLATE})
    t.catalog[CALLER]["swarm_templates"] = templates
    t.catalog[CALLER]["capabilities"] = ["person_swarm"]
    t.hive.programs.programs[CALLER].update(swarm_templates=templates, capabilities=["person_swarm"])
    p2 = t.hive.person_swarms
    p2.consent(t.principal, CALLER, "helpers", p2.card(t.principal, CALLER, "helpers"))
    assert p2.ensure(t.principal, CALLER, "helpers")["status"] == "ready"
    assert prepare(t, fid, CALLER, kind="app-open")["review"]["target"] == CALLER


def test_external_fields_and_foreign_origin_do_not_enable_a_p5_grant_or_navigation(links):
    t = links; fid = register(t)
    route = f"/api/programs/{CALLER}/app-links/frames/{fid}/prepare"
    result = t.client.post(route, headers=t.headers, json={"type": "app-open", "app": TARGET, "external": True})
    assert result.json() == {"result": {"state": "refused", "reason": "not_available"}}
    assert t.client.post(route, headers=dict(t.headers, Origin="https://external.test"), json={"type": "app-open", "app": TARGET}).status_code == 403


def test_view_intent_is_read_only_and_never_an_argument_to_grant_or_rule_entry(links, monkeypatch):
    t = links; seen = {}
    async def view(ctx, focus, stage):
        seen["input"] = dict(ctx.view_input)
        seen["focus"], seen["stage"] = focus, stage
        assert "untrusted_intent" not in (ctx.viewer or {})
        with pytest.raises(TypeError):
            ctx.view_input["untrusted_intent"] = "authority"
        return {"synthetic_view": True}
    async def admit(entry, swarm, viewer, check, fn, *args):
        assert len(args) == 3  # existing ctx/focus/stage ABI, not intent in a rule selector
        return await fn(*args)
    grants = []
    t.hive.programs.programs[TARGET]["module"] = SimpleNamespace(view=view)
    monkeypatch.setattr(t.hive.programs, "_admitting", admit)
    monkeypatch.setattr(t.hive.programs, "renew_grants", lambda *args: grants.append(args))
    result = asyncio.run(t.hive.programs.view(TARGET, t.bob_swarm["id"], viewer={"principal": t.principal}, untrusted_intent="denied-skill"))
    assert result == {"synthetic_view": True}
    assert seen == {"input": {"untrusted_intent": "denied-skill"}, "focus": None, "stage": "unfold"}
    assert len(grants[0]) == 3 and grants[0][1] == {"principal": t.principal}
    assert t.catalog[TARGET]["swarm_templates"]["helpers"]["rules"] == [{"skill": "denied-skill", "mode": "deny"}]
    grants.clear()
    with pytest.raises(HiveError):
        asyncio.run(t.hive.programs.view(TARGET, t.bob_swarm["id"], untrusted_intent="x" * 201))
    assert grants == []


def test_fresh_back_needs_current_normal_consent_and_old_frame_never_revives(links):
    t = links; old = register(t)
    with pytest.raises(HiveError):
        t.hive.app_links.check_frame(t.viewer, t.session, CALLER, old)
    def grant():
        card = t.client.get(f"/api/programs/{CALLER}/ask/consent", headers=t.headers).json()
        return t.client.post(f"/api/programs/{CALLER}/ask/consent", headers=t.headers, json={"card_id": card["card_id"]})
    assert grant().status_code == 200
    assert t.hive.app_links.check_frame(t.viewer, t.session, CALLER, old) == {"current": True}
    assert t.client.request("DELETE", f"/api/programs/{CALLER}/ask/consent", headers=t.headers, json={}).status_code == 200
    assert grant().status_code == 200
    with pytest.raises(HiveError):
        t.hive.app_links.check_frame(t.viewer, t.session, CALLER, old)
    fresh = register(t, slot="fresh-back-document")
    assert t.hive.app_links.check_frame(t.viewer, t.session, CALLER, fresh) == {"current": True}


@pytest.mark.parametrize("change", ["ask_revocation_without_prior_row", "setup_withdrawal", "uninstall", "identity"])
def test_opaque_presentation_freshness_drops_on_caller_generation_end(links, change):
    t = links; _, _, entry = setup_entry(t)
    assert t.hive.app_links.presentation_current(t.viewer, t.session, entry["id"]) == {"current": True}
    if change == "ask_revocation_without_prior_row":
        t.hive.app_ask.revoke(t.viewer, t.session, CALLER)
    elif change == "setup_withdrawal":
        t.hive.person_swarms.withdraw(t.principal, CALLER, "helpers")
    elif change == "uninstall":
        t.hive.programs.disabled.add(CALLER)
    elif change == "identity":
        t.hive.app_links.fence_person(t.principal)
    assert t.hive.app_links.presentation_current(t.viewer, t.session, entry["id"]) == {"current": False}


def test_presentation_proof_survives_closed_target_but_is_consumed_once_on_fresh_back(links):
    t = links; _, _, entry = setup_entry(t)
    target = register(t, TARGET, "target-document", entry, entry["swarm_id"])
    t.hive.app_links.redeem(t.viewer, t.session, entry["id"], {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "target-document"})
    t.hive.app_links.close(t.viewer, t.session, TARGET, target)
    register(t, slot="fresh-caller-back")  # sweeps dead grants, not retained presentation metadata
    assert t.hive.app_links.presentation_current(t.viewer, t.session, entry["id"]) == {"current": True}
    card = t.hive.app_ask.card(t.viewer, t.session, CALLER)
    t.hive.app_ask.consent(t.viewer, t.session, CALLER, {"card_id": card["card_id"]})
    assert t.hive.app_links.presentation_current(t.viewer, t.session, entry["id"], consume=True) == {"current": True}
    assert t.hive.app_links.presentation_current(t.viewer, t.session, entry["id"]) == {"current": False}


@pytest.mark.parametrize("previously_consented", [False, True])
def test_pending_open_does_not_rebind_to_another_documents_reconsent(links, previously_consented):
    t = links
    fid = register(t)
    setup = prepare(t, fid)["review"]
    assert decide(t, fid, setup["id"]) == {"result": {"state": "ready"}}
    if previously_consented:
        ask = t.hive.app_ask.card(t.viewer, t.session, TARGET)
        t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": ask["card_id"]})
    shown = prepare(t, fid, kind="app-open")["review"]
    displayed = copy.deepcopy(t.hive.app_links.reviews[shown["id"]]["ask"])
    assert displayed["consented"] is previously_consented

    t.hive.app_ask.revoke(t.viewer, t.session, TARGET)
    changed = t.hive.app_ask.card(t.viewer, t.session, TARGET)
    renewed = t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": changed["card_id"]})
    assert renewed["consented"] is True
    assert renewed["consent_epoch"] != displayed["consent_epoch"]
    before, entries = provision_counts(t.hive), set(t.hive.app_links.entries)

    assert decide(t, fid, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert set(t.hive.app_links.entries) == entries
    assert provision_counts(t.hive) == before
    assert t.hive.app_ask.card(t.viewer, t.session, TARGET)["consent_id"] == renewed["consent_id"]


def test_mint_does_not_select_a_new_consent_row_after_its_snapshot_check(links, monkeypatch):
    t = links
    fid = register(t)
    setup = prepare(t, fid)["review"]
    assert decide(t, fid, setup["id"]) == {"result": {"state": "ready"}}
    ask = t.hive.app_ask.card(t.viewer, t.session, TARGET)
    t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": ask["card_id"]})
    shown = prepare(t, fid, kind="app-open")["review"]
    original_card = t.hive.app_ask.card
    interleaved = []

    def replace_after_read(viewer, session, app):
        observed = original_card(viewer, session, app)
        if app == TARGET and not interleaved:
            interleaved.append(observed["consent_epoch"])
            t.hive.app_ask.revoke(viewer, session, app)
            fresh = original_card(viewer, session, app)
            t.hive.app_ask.consent(viewer, session, app, {"card_id": fresh["card_id"]})
        return observed

    monkeypatch.setattr(t.hive.app_ask, "card", replace_after_read)
    entries = set(t.hive.app_links.entries)
    assert decide(t, fid, shown["id"], open_now=True) == {"result": {"state": "refused", "reason": "not_ready"}}
    assert len(interleaved) == 1
    assert set(t.hive.app_links.entries) == entries


def test_first_session_promotion_selects_new_active_consent_and_fences_old_entry(links):
    t = links
    caller = register(t)
    setup = prepare(t, caller)["review"]
    result = decide(t, caller, setup["id"], open_now=True)
    assert result["result"] == {"state": "ready"}
    entry = result["entry"]
    host_entry = t.hive.app_links.entries[entry["id"]]
    old_id, old_epoch = host_entry["consent_id"], host_entry["consent_epoch"]

    target_frame = register(t, TARGET, "first-session-target", entry, entry["swarm_id"])
    t.hive.app_links.redeem(t.viewer, t.session, entry["id"], {
        "release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "first-session-target"})
    assert t.hive.app_links.first_session_current(old_id, t.viewer, t.session)

    shown = t.hive.app_ask.card(t.viewer, t.session, TARGET)
    assert shown["consent_id"] == old_id
    assert shown["consent_epoch"] == old_epoch
    assert shown["consented"] is False
    promoted = t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": shown["card_id"]})

    assert promoted["consented"] is True
    assert promoted["consent_id"] != old_id
    assert promoted["consent_epoch"] == old_epoch + 1
    selected = t.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ? AND digest = ? "
                             "ORDER BY epoch DESC, revoked ASC, created_at DESC, id DESC LIMIT 1",
                             (t.principal, TARGET, t.catalog[TARGET]["release_digest"]))
    assert selected["id"] == promoted["consent_id"]
    assert not selected["revoked"] and not selected["first_session_only"]
    assert t.hive.app_links.check_frame(t.viewer, t.session, TARGET, target_frame) == {"current": True}
    old = t.hive.db.one("SELECT * FROM app_ask_consents WHERE id = ?", (old_id,))
    assert old["revoked"] and old["epoch"] == promoted["consent_epoch"]
    assert not t.hive.app_links.first_session_current(old_id, t.viewer, t.session)


@pytest.mark.parametrize("ordinary_slot", ["target-document", "other-live-document"])
def test_link_redemption_does_not_fence_another_documents_live_p1_generation(links, ordinary_slot):
    t = links
    caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    card = t.hive.app_ask.card(t.viewer, t.session, TARGET)
    consent = t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": card["card_id"]})
    ordinary = t.hive.app_ask.frame(t.viewer, t.session, TARGET, {
        "release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": ordinary_slot})
    shown = prepare(t, caller, kind="app-open")["review"]
    opened = decide(t, caller, shown["id"], open_now=True)
    assert opened["result"] == {"state": "ready"}
    entry = opened["entry"]
    target = register(t, TARGET, "target-document", entry, entry["swarm_id"])
    host_entry = t.hive.app_links.entries[entry["id"]]
    before_entry = dict(host_entry)
    before_first = dict(t.hive.app_links.first_sessions)
    before_generation = t.hive.db.one("SELECT * FROM app_ask_generations WHERE id = ?", (ordinary["generation_id"],))
    before_count = t.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations")["n"]
    before_deadline = t.hive.app_ask.deadlines[ordinary["generation_id"]]

    with pytest.raises(HiveError):
        t.hive.app_links.redeem(t.viewer, t.session, entry["id"], {
            "release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "target-document"})

    assert t.hive.db.one("SELECT * FROM app_ask_generations WHERE id = ?", (ordinary["generation_id"],)) == before_generation
    assert before_generation["status"] == "active"
    assert t.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations")["n"] == before_count
    assert ordinary["generation_id"] not in t.hive.app_ask.fenced
    assert t.hive.app_ask.deadlines[ordinary["generation_id"]] == before_deadline
    assert host_entry == before_entry and not host_entry["used"]
    assert host_entry["target_frame"] == target
    assert t.hive.app_links.first_sessions == before_first
    assert t.hive.app_ask.presence(t.viewer, t.session, TARGET, ordinary["generation_id"])["generation_id"] == ordinary["generation_id"]
    assert t.hive.app_ask.card(t.viewer, t.session, TARGET)["consent_id"] == consent["consent_id"]


def test_link_document_keeps_its_namespaced_p1_lease_without_replaying_first_entry(links):
    t = links
    _, _, entry = setup_entry(t)
    target = register(t, TARGET, "target-document", entry, entry["swarm_id"])
    data = {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "target-document"}
    lease = t.hive.app_links.redeem(t.viewer, t.session, entry["id"], data)
    generation = t.hive.db.one("SELECT * FROM app_ask_generations WHERE id = ?", (lease["generation_id"],))
    assert generation["slot"] == "app-link:" + target
    assert generation["session_hash"] == t.session and generation["status"] == "active"
    assert "slot" not in lease and "frame_slot_id" not in lease
    assert "app-link:" not in json.dumps(lease)
    assert data["frame_slot_id"] == "target-document"
    assert t.hive.app_links.check_entry(t.viewer, t.session, entry["id"], target) == {"current": True}
    assert t.hive.app_links.first_session_current(lease["consent_id"], t.viewer, t.session)
    with pytest.raises(HiveError):
        t.hive.app_links.redeem(t.viewer, t.session, entry["id"], data)
    renewed = t.hive.app_ask.presence(t.viewer, t.session, TARGET, lease["generation_id"])
    assert renewed["generation_id"] == lease["generation_id"]
    assert renewed["consent_id"] == lease["consent_id"]
    assert t.hive.db.one("SELECT status FROM app_ask_generations WHERE id = ?", (lease["generation_id"],))["status"] == "active"


@pytest.mark.parametrize("previously_consented", [False, True])
def test_pending_review_poll_declines_target_ask_revision_without_minting_cards(links, previously_consented):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    if previously_consented:
        card = t.hive.app_ask.card(t.viewer, t.session, TARGET)
        t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": card["card_id"]})
    shown = prepare(t, caller, kind="app-open")["review"]
    if previously_consented:
        t.hive.app_ask.revoke(t.viewer, t.session, TARGET)
    else:
        other_card = t.hive.app_ask.card(t.viewer, t.session, TARGET)
        t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": other_card["card_id"]})
    cards, entries, before = set(t.hive.app_ask.cards), set(t.hive.app_links.entries), provision_counts(t.hive)
    assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"result": {"state": "declined"}}
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert set(t.hive.app_ask.cards) == cards
    assert set(t.hive.app_links.entries) == entries
    assert provision_counts(t.hive) == before


def test_pending_review_declines_target_ask_revocation_even_without_a_consent_row(links):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    shown = prepare(t, caller, kind="app-open")["review"]
    assert t.hive.db.one("SELECT id FROM app_ask_consents WHERE principal = ? AND app_id = ?", (t.principal, TARGET)) is None
    t.hive.app_ask.revoke(t.viewer, t.session, TARGET)
    cards, entries, before = set(t.hive.app_ask.cards), set(t.hive.app_links.entries), provision_counts(t.hive)
    assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"result": {"state": "declined"}}
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert set(t.hive.app_ask.cards) == cards and set(t.hive.app_links.entries) == entries
    assert provision_counts(t.hive) == before


@pytest.mark.parametrize("count", [0, 1, 512])
def test_link_sweep_uses_one_session_query_for_the_bounded_entry_set(links, monkeypatch, count):
    t = links; _, _, first = setup_entry(t)
    seed = t.hive.app_links.entries[first["id"]]
    t.hive.app_links.entries = {f"synthetic-entry-{i}": dict(copy.deepcopy(seed), id=f"synthetic-entry-{i}") for i in range(count)}
    one, all_rows = t.hive.db.one, t.hive.db.all
    reads = []
    def watch_one(sql, args=()):
        if "FROM sessions" in sql: reads.append(("one", sql, args))
        return one(sql, args)
    def watch_all(sql, args=()):
        if "FROM sessions" in sql: reads.append(("all", sql, args))
        return all_rows(sql, args)
    monkeypatch.setattr(t.hive.db, "one", watch_one)
    monkeypatch.setattr(t.hive.db, "all", watch_all)
    t.hive.app_links._sweep()
    assert len(reads) == (1 if count else 0)
    if count:
        assert reads[0][0] == "all" and tuple(reads[0][2]) == (t.session,)
    assert len(t.hive.app_links.entries) == count
    assert all(not entry["fenced"] and entry["presentation_open"] for entry in t.hive.app_links.entries.values())


@pytest.mark.parametrize("change", ["expired", "missing", "session", "signin", "person"])
def test_batched_link_sweep_keeps_expiry_and_identity_fences(links, change):
    t = links; _, _, first = setup_entry(t)
    entry = t.hive.app_links.entries[first["id"]]
    t.hive.app_links.first_sessions[entry["consent_id"]] = entry
    if change == "expired":
        t.hive.db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (t.hive.app_ask.wall_clock() - 1, t.session))
    elif change == "missing":
        t.hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (t.session,))
    elif change == "session": t.hive.app_links.mark_session(t.session)
    elif change == "signin": t.hive.app_links.mark_signin(entry["signin"])
    elif change == "person": t.hive.app_links.fence_person(t.principal)
    t.hive.app_links._sweep()
    assert entry["fenced"] and not entry["presentation_open"]
    assert first["id"] not in t.hive.app_links.entries
    assert entry["consent_id"] not in t.hive.app_links.first_sessions


def test_pending_review_snapshots_target_revocation_before_reading_ask_card(links, monkeypatch):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    card = t.hive.app_ask.card
    interleaved = []
    def revoke_after_read(viewer, session, app):
        observed = card(viewer, session, app)
        if app == TARGET and not interleaved:
            interleaved.append(observed["consent_epoch"])
            t.hive.app_ask.revoke(viewer, session, app)
        return observed
    monkeypatch.setattr(t.hive.app_ask, "card", revoke_after_read)
    shown = prepare(t, caller, kind="app-open")["review"]
    assert interleaved == [0]
    assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"result": {"state": "declined"}}
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert not t.hive.app_links.entries


def test_link_sweep_batches_the_full_distinct_session_bound_without_opening_missing_accounts(links, monkeypatch):
    t = links; _, _, first = setup_entry(t)
    seed = t.hive.app_links.entries[first["id"]]
    t.hive.app_links.entries = {f"synthetic-entry-{i}": dict(copy.deepcopy(seed), id=f"synthetic-entry-{i}", session=f"synthetic-missing-session-{i}") for i in range(512)}
    query = t.hive.db.all
    calls = []
    def watch(sql, args=()):
        if "FROM sessions" in sql: calls.append(tuple(args))
        return query(sql, args)
    monkeypatch.setattr(t.hive.db, "all", watch)
    t.hive.app_links._sweep()
    assert len(calls) == 1 and len(calls[0]) == len(set(calls[0])) == 512
    assert not t.hive.app_links.entries


class ObservedContendedLock:
    """Fixture-only proxy: records a real failed nonblocking acquisition."""
    def __init__(self, lock, contended):
        self.lock, self.contended = lock, contended
    def acquire(self, blocking=True, timeout=-1):
        if not blocking:
            return self.lock.acquire(False)
        if self.lock.acquire(False):
            return True
        self.contended.set()
        return self.lock.acquire(timeout=5 if timeout < 0 else min(timeout, 5))
    def release(self):
        self.lock.release()
    def __enter__(self):
        if not self.acquire():
            raise RuntimeError("bounded fixture lock acquisition timed out")
        return self
    def __exit__(self, *args):
        self.release()
    def __getattr__(self, name):
        return getattr(self.lock, name)


def test_concurrent_p1_generation_commits_before_link_redemption_without_being_fenced(links, monkeypatch):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    card = t.hive.app_ask.card(t.viewer, t.session, TARGET)
    t.hive.app_ask.consent(t.viewer, t.session, TARGET, {"card_id": card["card_id"]})
    shown = prepare(t, caller, kind="app-open")["review"]
    entry = decide(t, caller, shown["id"], open_now=True)["entry"]
    register(t, TARGET, "target-document", entry, entry["swarm_id"])
    host_entry = t.hive.app_links.entries[entry["id"]]
    before_entry, before_first = dict(host_entry), dict(t.hive.app_links.first_sessions)
    inserted, release, db_contended = Event(), Event(), Event()
    monkeypatch.setattr(t.hive.db, "_lock", ObservedContendedLock(t.hive.db._lock, db_contended))
    real_insert = t.hive.db.insert
    def pause_generation(table, values):
        result = real_insert(table, values)
        if table == "app_ask_generations" and values.get("slot") == "target-document":
            inserted.set()
            assert release.wait(5), "bounded fixture release was not signalled"
        return result
    monkeypatch.setattr(t.hive.db, "insert", pause_generation)
    data = {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "target-document"}
    def linked():
        return t.hive.app_links.redeem(t.viewer, t.session, entry["id"], data)
    with ThreadPoolExecutor(max_workers=2) as pool:
        ordinary = pool.submit(t.hive.app_ask.frame, t.viewer, t.session, TARGET, data)
        try:
            assert inserted.wait(5), "ordinary generation did not reach its transaction"
            redemption = pool.submit(linked)
            assert db_contended.wait(5), "link did not contend on the real DB gate"
        finally:
            release.set()
        lease = ordinary.result(timeout=5)
        with pytest.raises(HiveError):
            redemption.result(timeout=5)
    assert t.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations")["n"] == 1
    assert t.hive.db.one("SELECT status FROM app_ask_generations WHERE id = ?", (lease["generation_id"],))["status"] == "active"
    assert lease["generation_id"] not in t.hive.app_ask.fenced
    assert host_entry == before_entry and not host_entry["used"]
    assert t.hive.app_links.first_sessions == before_first
    assert t.hive.app_ask.presence(t.viewer, t.session, TARGET, lease["generation_id"])["generation_id"] == lease["generation_id"]


@pytest.mark.parametrize("operation", ["decide", "prepare"])
def test_no_row_revocation_holds_complete_link_boundary_until_db_finishes(links, monkeypatch, operation):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    shown = prepare(t, caller, kind="app-open")["review"]
    assert t.hive.db.one("SELECT id FROM app_ask_consents WHERE principal = ? AND app_id = ?", (t.principal, TARGET)) is None
    entries, first = dict(t.hive.app_links.entries), dict(t.hive.app_links.first_sessions)
    db_contended, guard_contended = Event(), Event()
    monkeypatch.setattr(t.hive.db, "_lock", ObservedContendedLock(t.hive.db._lock, db_contended))
    monkeypatch.setattr(t.hive.app_links, "guard", ObservedContendedLock(t.hive.app_links.guard, guard_contended))
    def pending_request():
        if operation == "prepare":
            return t.hive.app_links.prepare(t.viewer, t.session, CALLER, caller, {"type": "app-open", "app": TARGET})
        return t.hive.app_links.decide(t.viewer, t.session, CALLER, caller, shown["id"], {"approve": True, "open_now": True})
    with ThreadPoolExecutor(max_workers=2) as pool:
        with t.hive.db.transaction():
            revoked = pool.submit(t.hive.app_ask.revoke, t.viewer, t.session, TARGET)
            assert db_contended.wait(5), "revocation did not reach the occupied DB gate"
            assert t.hive.app_links.reviews[shown["id"]]["target_app_epoch"] != t.hive.app_links.app_epochs[(t.principal, TARGET)]
            attempted = pool.submit(pending_request)
            assert guard_contended.wait(5), "review/decision was not held behind complete revocation"
        assert revoked.result(timeout=5) == {"revoked": True}
        assert attempted.result(timeout=5) == {"result": {"state": "declined"}}
    assert t.hive.db.one("SELECT id FROM app_ask_consents WHERE principal = ? AND app_id = ?", (t.principal, TARGET)) is None
    assert t.hive.app_links.entries == entries and t.hive.app_links.first_sessions == first
    assert t.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations")["n"] == 0


def test_mint_and_later_no_row_revoke_serialize_without_a_usable_stale_entry(links, monkeypatch):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    shown = prepare(t, caller, kind="app-open")["review"]
    in_card, continue_mint, guard_contended = Event(), Event(), Event()
    monkeypatch.setattr(t.hive.app_links, "guard", ObservedContendedLock(t.hive.app_links.guard, guard_contended))
    real_card = t.hive.app_ask.card
    paused = []
    def gated_card(viewer, session, app):
        with t.hive.db.transaction():
            observed = real_card(viewer, session, app)
            if app == TARGET and not paused:
                paused.append(True); in_card.set()
                assert continue_mint.wait(5), "bounded mint release was not signalled"
            return observed
    monkeypatch.setattr(t.hive.app_ask, "card", gated_card)
    with ThreadPoolExecutor(max_workers=2) as pool:
        minted = pool.submit(t.hive.app_links.decide, t.viewer, t.session, CALLER, caller, shown["id"], {"approve": True, "open_now": True})
        try:
            assert in_card.wait(5), "mint did not reach the DB-protected card read"
            revoked = pool.submit(t.hive.app_ask.revoke, t.viewer, t.session, TARGET)
            assert guard_contended.wait(5), "revocation did not contend on mint's link boundary"
            assert t.hive.app_links.reviews[shown["id"]]["target_app_epoch"] == t.hive.app_links.app_epochs.get((t.principal, TARGET), 0)
        finally:
            continue_mint.set()
        result = minted.result(timeout=5)
        assert result["result"] == {"state": "ready"}
        assert revoked.result(timeout=5) == {"revoked": True}
    consent = t.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ?", (t.principal, TARGET))
    assert consent["revoked"] and consent["epoch"] == 2
    with pytest.raises(HiveError):
        t.hive.app_links.entry_card(t.viewer, t.session, result["entry"]["id"])
    assert not t.hive.app_links.first_sessions


def test_mint_rolls_back_ask_consent_and_entry_after_postgrant_boundary_failure(links, monkeypatch):
    t = links; caller = register(t)
    setup = prepare(t, caller)["review"]
    assert decide(t, caller, setup["id"]) == {"result": {"state": "ready"}}
    shown = prepare(t, caller, kind="app-open")["review"]
    before_entries, before_first = dict(t.hive.app_links.entries), dict(t.hive.app_links.first_sessions)
    grant = t.hive.app_ask.consent
    calls = []
    def invalidate_after_grant(*args, **kwargs):
        result = grant(*args, **kwargs)
        calls.append(True)
        t.hive.app_links.revoke_app(t.principal, TARGET)  # synthetic raw boundary fault inside the grant
        return result
    monkeypatch.setattr(t.hive.app_ask, "consent", invalidate_after_grant)
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "refused", "reason": "not_ready"}}
    assert calls == [True]
    assert t.hive.db.one("SELECT id FROM app_ask_consents WHERE principal = ? AND app_id = ?", (t.principal, TARGET)) is None
    assert t.hive.app_links.entries == before_entries and t.hive.app_links.first_sessions == before_first
    assert t.hive.db.one("SELECT COUNT(*) AS n FROM app_ask_generations")["n"] == 0


def ask_ready_link_fixture(t):
    """P1's controlled coordinator precondition; no supervisor/model is started."""
    assigned = t.client.patch(f"/api/swarms/{t.bob_swarm['id']}", headers=t.admin_headers,
                              json={"coordinator_id": t.bob_mind["id"]})
    assert assigned.status_code == 200, assigned.text
    # Same synthetic readiness convention as accepted test_ask.world: the hub
    # treats a coordinator as hive-run only when both status and desired awake.
    t.hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (t.bob_mind["id"],))
    selected = t.client.put("/api/me/ask", headers=t.headers, json={"swarm_id": t.bob_swarm["id"]})
    assert selected.status_code == 200, selected.text
    prefs = selected.json()
    assert prefs["swarm_id"] == t.bob_swarm["id"]
    assert prefs["swarm"]["orchestrator"]["id"] == t.bob_mind["id"]
    assert prefs["swarm"]["orchestrator"]["status"] == "awake"


def test_promoting_link_consent_drains_real_frame_after_db_link_and_p2_gates(links, monkeypatch):
    t = links
    ask_ready_link_fixture(t)
    caller, _, entry = setup_entry(t)
    register(t, TARGET, "drain-target-document", entry, entry["swarm_id"])
    lease = t.hive.app_links.redeem(t.viewer, t.session, entry["id"], {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "drain-target-document"})
    sent = t.client.post(f"/api/programs/{TARGET}/ask/frames/{lease['generation_id']}/ops", headers=t.headers,
                         json={"op": "send", "op_id": "synthetic-drain-order", "text": "Synthetic ordering fixture"})
    assert sent.status_code == 200, sent.text
    turn = sent.json()
    shown = prepare(t, caller, kind="app-open")["review"]
    gate = t.hive.app_ask.turn_gate(t.principal, turn["operation_id"])
    turn_held, let_turn_take_db, turn_got_db = Event(), Event(), Event()
    real_drain = t.hive.app_ask.drain_fences
    observations = []
    def drain():
        if lease["generation_id"] in t.hive.app_ask.pending_teardown:
            owned = (t.hive.db._lock._is_owned(), t.hive.app_links.guard._is_owned(),
                     t.hive.person_swarms._program_lock(TARGET)._is_owned(), t.hive.person_swarms._lock(t.principal, TARGET)._is_owned())
            observations.append(owned)
            try:
                assert not any(owned), "drain still owns DB/link/P2 gates"
                let_turn_take_db.set()
                assert turn_got_db.wait(5), "owned turn worker could not take DB while drain was pending"
            finally:
                let_turn_take_db.set()
        return real_drain()
    monkeypatch.setattr(t.hive.app_ask, "drain_fences", drain)
    def turn_worker():
        with gate:
            turn_held.set()
            assert let_turn_take_db.wait(5), "bounded turn release was not signalled"
            with t.hive.db.transaction():
                assert t.hive.db.one("SELECT 1 AS n")["n"] == 1
                turn_got_db.set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        owned_turn = pool.submit(turn_worker)
        try:
            assert turn_held.wait(5), "owned turn gate was not acquired"
            minted = pool.submit(t.hive.app_links.decide, t.viewer, t.session, CALLER, caller, shown["id"], {"approve": True, "open_now": True})
            result = minted.result(timeout=10)
        finally:
            let_turn_take_db.set()
        owned_turn.result(timeout=5)
    assert result["result"] == {"state": "ready"}
    assert observations and all(not any(row) for row in observations)
    assert lease["generation_id"] not in t.hive.app_ask.pending_teardown
    presentation = t.hive.db.one("SELECT owner, generation_id FROM app_ask_presentations WHERE turn_id = ?", (turn["turn_id"],))
    assert presentation == {"owner": "host", "generation_id": None}


def active_first_link_presentation(t):
    ask_ready_link_fixture(t)
    caller, _, entry = setup_entry(t)
    register(t, TARGET, "rollback-target-document", entry, entry["swarm_id"])
    lease = t.hive.app_links.redeem(t.viewer, t.session, entry["id"], {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "rollback-target-document"})
    sent = t.client.post(f"/api/programs/{TARGET}/ask/frames/{lease['generation_id']}/ops", headers=t.headers,
                         json={"op": "send", "op_id": "synthetic-promotion-rollback", "text": "Synthetic promotion fixture"})
    assert sent.status_code == 200, sent.text
    turn = sent.json()
    subscribed = t.client.post(f"/api/programs/{TARGET}/ask/frames/{lease['generation_id']}/ops", headers=t.headers,
                               json={"op": "subscribe", "operation_id": turn["operation_id"]})
    assert subscribed.status_code == 200, subscribed.text
    # A controlled byte buffer tests preservation; no provider/private body is used.
    with t.hive.db.transaction():
        t.hive.app_ask.live_frames[(lease["generation_id"], turn["turn_id"], 999)] = b'{"synthetic_fixture":true}'
    return caller, entry, lease, turn, subscribed.json()["subscription_id"]


def prior_generation_state(t, lease):
    g = lease["generation_id"]; ask = t.hive.app_ask
    return {
        "consent": t.hive.db.one("SELECT * FROM app_ask_consents WHERE id = ?", (lease["consent_id"],)),
        "generation": t.hive.db.one("SELECT * FROM app_ask_generations WHERE id = ?", (g,)),
        "fenced_present": g in ask.fenced, "fenced_value": ask.fenced.get(g),
        "pending": g in ask.pending_teardown,
        "deadline_present": g in ask.deadlines, "deadline": ask.deadlines.get(g),
        "rate_present": g in ask.rates, "rate": ask.rates.get(g),
        "subscriptions": copy.deepcopy({k: v for k, v in ask.subscriptions.items() if v["generation"] == g}),
        "live_frames": {k: v for k, v in ask.live_frames.items() if k[0] == g},
        "index_present": g in ask.generation_index, "index": ask.generation_index.get(g),
        "signin_present": g in ask.generation_signins, "signin": ask.generation_signins.get(g),
    }


def test_failed_promotion_preserves_active_prior_lease_and_process_state(links, monkeypatch):
    t = links; caller, entry, lease, turn, subscription = active_first_link_presentation(t)
    shown = prepare(t, caller, kind="app-open")["review"]
    before = prior_generation_state(t, lease)
    assert before["generation"]["status"] == "active" and before["consent"]["first_session_only"]
    assert not before["fenced_present"] and not before["pending"]
    assert subscription in before["subscriptions"] and before["live_frames"]
    host_entry = t.hive.app_links.entries[entry["id"]]
    before_control = {k: host_entry[k] for k in ("used", "fenced", "target_frame", "person_epoch", "limits_epoch", "target_app_epoch")}
    existing_entries = set(t.hive.app_links.entries)
    check = t.hive.app_links._entry_current
    staged = []
    def fail_new_entry(value, viewer, session, used=False):
        result = check(value, viewer, session, used=used)
        if value["id"] not in existing_entries:
            staged.append(value["consent_id"])
            raise RuntimeError("synthetic non-revoking failure after promotion")
        return result
    monkeypatch.setattr(t.hive.app_links, "_entry_current", fail_new_entry)
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "refused", "reason": "not_ready"}}
    assert len(staged) == 1 and staged[0] != lease["consent_id"]
    assert prior_generation_state(t, lease) == before
    assert t.hive.db.all("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ?", (t.principal, TARGET)) == [before["consent"]]
    assert set(t.hive.app_links.entries) == existing_entries
    assert {k: host_entry[k] for k in before_control} == before_control
    assert t.hive.app_links.first_sessions[lease["consent_id"]] is host_entry
    renewed = t.hive.app_ask.presence(t.viewer, t.session, TARGET, lease["generation_id"])
    assert renewed["generation_id"] == lease["generation_id"]
    assert t.hive.app_links.first_session_current(lease["consent_id"], t.viewer, t.session)
    presentation = t.hive.db.one("SELECT owner, generation_id FROM app_ask_presentations WHERE turn_id = ?", (turn["turn_id"],))
    assert presentation == {"owner": "frame", "generation_id": lease["generation_id"]}


def test_concurrent_raw_revoke_survives_failed_promotion_without_map_restore(links, monkeypatch):
    t = links; caller, entry, lease, _, _ = active_first_link_presentation(t)
    shown = prepare(t, caller, kind="app-open")["review"]
    staged, release_failure, guard_contended = Event(), Event(), Event()
    monkeypatch.setattr(t.hive.app_links, "guard", ObservedContendedLock(t.hive.app_links.guard, guard_contended))
    grant = t.hive.app_ask.consent
    def fail_after_staged_grant(*args, **kwargs):
        grant(*args, **kwargs)
        staged.set()
        assert release_failure.wait(5), "bounded failed-promotion release was not signalled"
        raise RuntimeError("synthetic non-revoking promotion failure")
    monkeypatch.setattr(t.hive.app_ask, "consent", fail_after_staged_grant)
    with ThreadPoolExecutor(max_workers=2) as pool:
        promotion = pool.submit(t.hive.app_links.decide, t.viewer, t.session, CALLER, caller, shown["id"], {"approve": True, "open_now": True})
        try:
            assert staged.wait(5), "promotion did not reach its provisional grant"
            revoked = pool.submit(t.hive.app_ask.revoke, t.viewer, t.session, TARGET)
            assert guard_contended.wait(5), "real revocation did not contend on promotion's link guard"
            assert t.hive.app_ask.fenced.get(lease["generation_id"]) == "suspended"
            assert lease["generation_id"] in t.hive.app_ask.pending_teardown
        finally:
            release_failure.set()
        assert promotion.result(timeout=10) == {"result": {"state": "refused", "reason": "not_ready"}}
        assert revoked.result(timeout=10) == {"revoked": True}
    original = t.hive.db.one("SELECT * FROM app_ask_consents WHERE id = ?", (lease["consent_id"],))
    assert original["revoked"] and original["epoch"] == lease["consent_epoch"] + 1
    assert t.hive.db.one("SELECT status FROM app_ask_generations WHERE id = ?", (lease["generation_id"],))["status"] != "active"
    assert not t.hive.app_links.first_session_current(lease["consent_id"], t.viewer, t.session)
    with pytest.raises(HiveError):
        t.hive.app_ask.presence(t.viewer, t.session, TARGET, lease["generation_id"])
    with pytest.raises(HiveError):
        t.hive.app_links.entry_card(t.viewer, t.session, entry["id"])


@pytest.mark.parametrize("failure", ["before", "partial", "cleanup"])
def test_p122_callback_failure_fences_entire_old_consent_and_preserves_other_grants(links, monkeypatch, caplog, failure):
    t = links; caller, entry, lease, turn, subscription = active_first_link_presentation(t)
    ask = t.hive.app_ask
    # A separate real P1 consent/lease must never enter the fallback scope.
    card = ask.card(t.viewer, t.session, THIRD)
    ask.consent(t.viewer, t.session, THIRD, {"card_id": card["card_id"]})
    unrelated = ask.frame(t.viewer, t.session, THIRD,
        {"release_digest": t.catalog[THIRD]["release_digest"], "frame_slot_id": "p122-unrelated-document"})
    unrelated_before = prior_generation_state(t, unrelated)
    # Controlled historical SQL rows belong to the old consent even when absent
    # from generation_index. One begins unfenced; another has a real raw reason.
    old_row = t.hive.db.one("SELECT * FROM app_ask_generations WHERE id = ?", (lease["generation_id"],))
    history = [lease["generation_id"] + "-p122-history", lease["generation_id"] + "-p122-raw"]
    for index, generation in enumerate(history):
        historical = dict(old_row, id=generation, status="suspended", slot="p122-history-" + str(index))
        t.hive.db.insert("app_ask_generations", historical)
        ask.deadlines[generation] = t.time[0] + 15
        ask.rates[generation] = (20.0, t.time[0])
        ask.subscriptions["p122-history-sub-" + str(index)] = dict(ask.subscriptions[subscription], generation=generation)
        ask.live_frames[(generation, turn["turn_id"], 996 + index)] = b'{"p122_synthetic_history":true}'
    old_ids = {lease["generation_id"], *history}
    assert all(generation not in ask.fenced and generation not in ask.pending_teardown for generation in old_ids)
    shown = prepare(t, caller, kind="app-open")["review"]
    original_callback, original_drain, original_teardown = ask._committed_replacement_fences, ask.drain_fences, ask._teardown
    callbacks, fenced_before_drain, teardowns, new_leases, new_states = [], [], [], [], []
    class FailOnePop(dict):
        failed = False
        def pop(self, key, *default):
            if not self.failed:
                self.failed = True
                raise ValueError("synthetic cleanup payload must not be logged")
            return super().pop(key, *default)
    def forced_failure(generations):
        callbacks.append(tuple(generations))
        assert not t.hive.db._lock._is_owned()
        # A real ordinary P1 generation for the just-committed NEW consent can
        # enter concurrently before fallback. Use its private no-drain primitive;
        # the owned worker neither needs the link guard nor tears down old turns.
        with ThreadPoolExecutor(max_workers=1) as pool:
            fresh = pool.submit(ask._frame, t.viewer, t.session, TARGET,
                {"release_digest": t.catalog[TARGET]["release_digest"], "frame_slot_id": "p122-concurrent-new-consent"}).result(timeout=5)
        assert fresh["consent_id"] != lease["consent_id"]
        new_leases.append(fresh)
        new_states.append(prior_generation_state(t, fresh))
        if failure == "partial":
            original_callback(generations[:1])
        if failure == "cleanup":
            ask.deadlines = FailOnePop(ask.deadlines)
        ask.mark_fenced(history[1], "signed_out")
        raise RuntimeError("synthetic callback payload must not be logged")
    monkeypatch.setattr(ask, "_committed_replacement_fences", forced_failure)
    def gate_state():
        return (t.hive.db._lock._is_owned(), t.hive.app_links.guard._is_owned(),
            t.hive.person_swarms._program_lock(TARGET)._is_owned(), t.hive.person_swarms._lock(t.principal, TARGET)._is_owned())
    def drain():
        if old_ids & ask.pending_teardown:
            assert old_ids <= ask.pending_teardown and all(generation in ask.fenced for generation in old_ids)
            assert ask.fenced[history[1]] == "signed_out"
            assert unrelated["generation_id"] not in ask.fenced and unrelated["generation_id"] not in ask.pending_teardown
            assert len(new_leases) == 1
            assert new_leases[0]["generation_id"] not in ask.fenced and new_leases[0]["generation_id"] not in ask.pending_teardown
            assert prior_generation_state(t, new_leases[0]) == new_states[0]
            assert not any(gate_state()), "failure fallback drain still owns DB/link/P2 gates"
            fenced_before_drain.append(set(ask.fenced) & old_ids)
        return original_drain()
    def teardown(generation):
        if generation in old_ids:
            assert generation in ask.fenced
            assert not any(gate_state()), "failure fallback teardown still owns DB/link/P2 gates"
            teardowns.append(generation)
        return original_teardown(generation)
    monkeypatch.setattr(ask, "drain_fences", drain)
    monkeypatch.setattr(ask, "_teardown", teardown)
    caplog.set_level("ERROR", logger="hive.core.app_ask")
    caplog.clear()
    result = decide(t, caller, shown["id"], open_now=True)
    assert result["result"] == {"state": "ready"}
    assert callbacks == [(lease["generation_id"],)]
    assert fenced_before_drain == [old_ids] and set(teardowns) == old_ids
    assert not old_ids & ask.pending_teardown
    assert prior_generation_state(t, unrelated) == unrelated_before
    messages = [record.getMessage() for record in caplog.records if record.name == "hive.core.app_ask"]
    assert "AppAsk replacement callback failed; old consent=" + lease["consent_id"] + " error_type=RuntimeError" in messages
    assert ("AppAsk replacement cleanup failed; old consent=" + lease["consent_id"] + " error_type=ValueError" in messages) == (failure == "cleanup")
    assert "synthetic callback payload" not in caplog.text and "synthetic cleanup payload" not in caplog.text
    assert all(not record.exc_info for record in caplog.records if record.name == "hive.core.app_ask")
    prior = t.hive.db.one("SELECT revoked, epoch FROM app_ask_consents WHERE id = ?", (lease["consent_id"],))
    assert prior == {"revoked": 1, "epoch": lease["consent_epoch"] + 1}
    for generation in old_ids:
        with pytest.raises(HiveError):
            ask.presence(t.viewer, t.session, TARGET, generation)
    presentation = t.hive.db.one("SELECT owner, generation_id FROM app_ask_presentations WHERE turn_id = ?", (turn["turn_id"],))
    assert presentation == {"owner": "host", "generation_id": None}
    new_entry = result["entry"]
    new_card = t.hive.app_links.entry_card(t.viewer, t.session, new_entry["id"])
    assert new_card["consent_id"] != lease["consent_id"] and new_card["consented"]
    new_lease = new_leases[0]
    assert new_lease["consent_id"] == new_card["consent_id"] and new_lease["generation_id"] not in old_ids
    assert prior_generation_state(t, new_lease) == new_states[0]
    assert ask.presence(t.viewer, t.session, TARGET, new_lease["generation_id"])["generation_id"] == new_lease["generation_id"]
    assert prior_generation_state(t, unrelated) == unrelated_before


@pytest.mark.parametrize("field", ["name", "version", "related_apps", "permission"])
def test_p122_pending_review_declines_semantic_display_change_without_card_effects(links, monkeypatch, field):
    t = links; caller = register(t)
    shown = prepare(t, caller)["review"]
    if field == "name":
        t.catalog[TARGET]["name"] = "Changed pinned target name"
    elif field == "version":
        t.catalog[TARGET]["version"] = "2"
    elif field == "related_apps":
        t.catalog[TARGET]["related_apps"] = [THIRD]
    else:
        monkeypatch.setattr("hive.core.app_ask.PERMISSION", "A changed host permission statement")
    cards = copy.deepcopy(t.hive.app_ask.cards)
    entries, counts = set(t.hive.app_links.entries), provision_counts(t.hive)
    assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"result": {"state": "declined"}}
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert t.hive.app_ask.cards == cards and set(t.hive.app_links.entries) == entries
    assert provision_counts(t.hive) == counts


@pytest.mark.parametrize("field", ["template_digest", "key_id", "month_usd", "consent_revision", "authority_revision"])
def test_p122_pending_review_keeps_all_five_operative_p2_fields(links, monkeypatch, field):
    t = links; caller = register(t)
    shown = prepare(t, caller)["review"]
    original = t.hive.person_swarms.card
    changed = {"template_digest": "sha256:" + "f" * 64, "key_id": "synthetic-changed-key", "month_usd": 17.0,
        "consent_revision": {"granted_at": "synthetic-new-revision", "withdrawn_at": None}, "authority_revision": "synthetic-authority-revision"}
    def card(*args, **kwargs):
        value = original(*args, **kwargs)
        value[field] = (value[field] or 0) + 1 if field == "month_usd" else changed[field]
        return value
    monkeypatch.setattr(t.hive.person_swarms, "card", card)
    cards, entries, counts = copy.deepcopy(t.hive.app_ask.cards), set(t.hive.app_links.entries), provision_counts(t.hive)
    assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"result": {"state": "declined"}}
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert t.hive.app_ask.cards == cards and set(t.hive.app_links.entries) == entries and provision_counts(t.hive) == counts


@pytest.mark.parametrize("surface", ["ask", "p2", "release", "advisory"])
def test_p122_pending_review_ignores_nonprojected_metadata_and_advisory_bit(links, monkeypatch, surface):
    t = links; caller = register(t)
    shown = prepare(t, caller)["review"]
    calls = []
    if surface == "ask":
        owner, name = t.hive.app_ask, "card_metadata"
    elif surface in ("p2", "advisory"):
        owner, name = t.hive.person_swarms, "card"
    else:
        owner, name = t.hive.programs, "link_manifest"
    original = getattr(owner, name)
    def volatile(*args, **kwargs):
        value = original(*args, **kwargs)
        calls.append(None)
        if surface == "advisory":
            value["consent_current"] = not value["consent_current"]
        else:
            value["card_id"] = "p122-volatile-card-" + str(len(calls))
            value["nonce"] = "p122-volatile-nonce-" + str(len(calls))
            value["display_nonce"] = {"synthetic_sequence": len(calls)}
        return value
    monkeypatch.setattr(owner, name, volatile)
    # An expired host card is deliberately retained: polling must not prune it.
    t.hive.app_ask.cards["p122-expired-card"] = {"until": t.time[0] - 1, "synthetic": True}
    cards, entries, counts = copy.deepcopy(t.hive.app_ask.cards), set(t.hive.app_links.entries), provision_counts(t.hive)
    for _ in range(2):
        assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"review": shown}
        assert prepare(t, caller) == {"review": shown}
    assert calls and t.hive.app_ask.cards == cards
    assert set(t.hive.app_links.entries) == entries and provision_counts(t.hive) == counts
    result = decide(t, caller, shown["id"], open_now=True)
    assert result["result"] == {"state": "ready"}
    # P2 volatile/advisory metadata must stay harmless through mint and entry read.
    assert t.hive.app_links.entry_card(t.viewer, t.session, result["entry"]["id"])["consented"]


@pytest.mark.parametrize("change", ["p2_missing", "ask_malformed", "p2_malformed"])
def test_p122_pending_review_fails_closed_on_missing_or_malformed_projected_fields(links, monkeypatch, change):
    t = links; caller = register(t)
    shown = prepare(t, caller)["review"]
    if change.startswith("ask"):
        owner, name = t.hive.app_ask, "card_metadata"
    else:
        owner, name = t.hive.person_swarms, "card"
    original = getattr(owner, name)
    def malformed(*args, **kwargs):
        value = original(*args, **kwargs)
        if change == "p2_missing":
            value.pop("authority_revision")
        elif change == "p2_malformed":
            value["month_usd"] = True  # bool is not a monthly total
        else:
            value["consent_epoch"] = True  # bool is not an epoch integer
        return value
    monkeypatch.setattr(owner, name, malformed)
    cards, entries, counts = copy.deepcopy(t.hive.app_ask.cards), set(t.hive.app_links.entries), provision_counts(t.hive)
    assert t.hive.app_links.review(t.viewer, t.session, CALLER, caller, shown["id"]) == {"result": {"state": "declined"}}
    assert decide(t, caller, shown["id"], open_now=True) == {"result": {"state": "declined"}}
    assert t.hive.app_ask.cards == cards and set(t.hive.app_links.entries) == entries and provision_counts(t.hive) == counts
