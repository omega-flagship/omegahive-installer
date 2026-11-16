"""Release maker provisioning: synthetic API/DB, invented keys; no process or provider call.

Existing R7/R8.3 setup/binding/key/attachment behavior is reused. Only the default template source changes.
"""
import json
import os
from pathlib import Path

import pytest

from hive.core.programs import Programs
from hive.tests.test_studio_session_r7 import (p, setup, tables, maker_of, MIA, KEY, PROGRAM,  # noqa: F401
                                               s, a, w, client)

TEMPLATE = {"name": "Create maker", "kind": "omega", "persona": "Invented release maker. Make a picnic poster.",
            "role": None, "tools": [], "budget_usd": 0}


def pin_release(x, folder, manifest):
    (folder / "plugin.json").write_text(json.dumps(manifest))
    digest = Programs.source_digest(folder)
    x.entry.update(path=str(folder), digest=digest, version=manifest["version"], error=None)
    x.hive.programs.programs[PROGRAM] = x.entry
    x.hive.programs.pins = {PROGRAM: {"release": str(folder), "digest": digest}}
    return digest


@pytest.fixture()
def r(p, tmp_path, monkeypatch):
    monkeypatch.delenv("HIVE_STUDIO_MAKER_TEMPLATE")
    folder = tmp_path / "release"; folder.mkdir()
    # A source file is hashed, never executed by this read. App attachment hooks must not run, either.
    (folder / "program.py").write_text('raise AssertionError("must not execute app code")\n')
    p.manifest = {"id": PROGRAM, "name": "Invented Studio", "version": "0.4.22-test",
                  "maker_templates": {"create-maker": dict(TEMPLATE)}}
    p.folder = folder
    p.digest = pin_release(p, folder, p.manifest)
    monkeypatch.setattr(p.hive.programs, "_ready", Programs._ready.__get__(p.hive.programs))
    def forbidden(*args, **kwargs):
        raise AssertionError("host template provisioning must not call app hooks")
    p.entry["module"].offer = p.entry["module"].bind = p.entry["module"].unbind = forbidden
    p.entry["module"].member_attach = {"actions": ["trace"], "channels": []}
    return p


def test_default_setup_uses_pinned_asset_and_reuses_the_original_binding(r):
    before = tables(r.hive)
    response = setup(r)
    assert response.status_code == 200, response.text
    maker = maker_of(r)
    assert maker["persona"] == TEMPLATE["persona"]
    assert (maker["kind"], maker["role_id"], maker["budget_usd"], maker["status"], maker["owner"]) == (
        "omega", None, 0, "asleep", MIA)
    assert json.loads(maker["options"]) == {"key": KEY}
    assert tables(r.hive)["agents"] == before["agents"] + 1  # no hidden template mind
    assert tables(r.hive)["person_minds"] == before["person_minds"] + 1
    audit = r.hive.db.one("SELECT detail FROM studio_maker_audit WHERE agent_id=? AND action='created'", (maker["id"],))
    detail = json.loads(audit["detail"])
    assert detail["template"] == "omegadesign:create-maker"
    assert detail["release_digest"] == r.digest and detail["release_version"] == "0.4.22-test"
    assert TEMPLATE["persona"] not in audit["detail"]
    after = tables(r.hive)
    response = setup(r)
    assert response.status_code == 200 and response.json()["maker"]["created"] is False
    assert maker_of(r)["id"] == maker["id"] and tables(r.hive) == after


def test_setup_with_no_local_template_mind_still_uses_the_release(r):
    r.hive.db.execute("UPDATE agents SET deleted=1 WHERE id=?", (r.template["id"],))
    response = setup(r)
    assert response.status_code == 200, response.text
    assert maker_of(r)["persona"] == TEMPLATE["persona"]


def test_missing_own_key_refuses_before_creating_or_attaching_anything(r):
    del r.hive.keyring.ring["keys"][KEY]
    before = tables(r.hive)
    response = setup(r)
    assert response.status_code == 402 and response.json()["error"]["code"] == "own_key_needed"
    assert tables(r.hive) == before


def test_explicit_local_override_keeps_its_original_role_persona_and_budget(r, monkeypatch):
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", r.template["id"])
    response = setup(r)
    assert response.status_code == 200, response.text
    maker = maker_of(r)
    assert (maker["persona"], maker["role_id"], maker["budget_usd"]) == (
        "You are the creative director.", r.role["id"], 5)


@pytest.mark.parametrize("override", ["a_deadbeef", "other-app:create-maker", "omegadesign:no-such-template",
                                       "omegadesign:create-maker:other"])
def test_unusable_explicit_override_never_falls_back_to_the_release(r, monkeypatch, override):
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", override)
    before = tables(r.hive)
    response = setup(r)
    assert response.status_code == 409 and response.json()["error"]["reason"] == "template_unusable"
    assert tables(r.hive) == before and r.hive.studio_makers.template_ready() is False


def test_explicit_release_reference_uses_the_same_accessor(r, monkeypatch):
    monkeypatch.setenv("HIVE_STUDIO_MAKER_TEMPLATE", "omegadesign:create-maker")
    assert setup(r).status_code == 200
    assert maker_of(r)["persona"] == TEMPLATE["persona"]


@pytest.mark.parametrize("change", ["unpinned", "manifest", "source", "disabled"])
def test_missing_pin_or_changed_release_refuses_before_writes(r, change):
    before = tables(r.hive)
    if change == "unpinned":
        r.hive.programs.pins = {}
    elif change == "manifest":
        r.manifest["maker_templates"]["create-maker"]["persona"] = "Unpinned altered words."
        (r.folder / "plugin.json").write_text(json.dumps(r.manifest))
    elif change == "source":
        (r.folder / "program.py").write_text("# changed\n")
    else:
        r.hive.programs.disabled.add(PROGRAM)
    response = setup(r)
    assert response.status_code == 409, response.text
    assert tables(r.hive) == before and r.hive.studio_makers.template_ready() is False


def test_mutable_entry_and_environment_cannot_replace_the_captured_manifest(r, monkeypatch):
    r.entry["maker_templates"] = {"create-maker": {**TEMPLATE, "persona": "Mutated entry words."}}
    monkeypatch.setenv("HIVE_APP_PINS", "{}")  # only an owner reload may replace the captured host pins
    assert setup(r).status_code == 200
    assert maker_of(r)["persona"] == TEMPLATE["persona"]


@pytest.mark.parametrize("field,value", [("kind", "iter"), ("name", ""), ("persona", ""),
    ("role", "r_deadbeef"), ("tools", ["not-a-tool-version"]), ("budget_usd", -1),
    ("budget_usd", True), ("budget_usd", float("inf")), ("budget_usd", float("nan")), ("key", "k_deadbeef")])
def test_invalid_reviewed_template_is_refused_before_effects(r, field, value):
    r.manifest["maker_templates"]["create-maker"][field] = value
    pin_release(r, r.folder, r.manifest)
    before = tables(r.hive)
    response = setup(r)
    assert response.status_code == 409, response.text
    assert tables(r.hive) == before


def test_startup_self_check_reads_the_asset_before_makers_constructs_without_writes(r, monkeypatch, caplog):
    monkeypatch.delattr(r.hive, "studio_makers")
    monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
    monkeypatch.setattr(r.hive.studio, "components", lambda: {"synthetic present component": True})
    before = tables(r.hive)
    with caplog.at_level("WARNING", logger="hive"):
        assert r.hive.studio.self_check() == (True, [])
    assert not any("HIVE_STUDIO_MAKER_TEMPLATE" in record.getMessage() for record in caplog.records)
    assert tables(r.hive) == before


def test_existing_person_maker_is_not_replaced_when_the_release_changes(r):
    assert setup(r).status_code == 200
    original = maker_of(r)
    r.manifest["version"] = "0.4.23-test"
    r.manifest["maker_templates"]["create-maker"]["persona"] = "A later invented release persona."
    pin_release(r, r.folder, r.manifest)
    after = tables(r.hive)
    assert setup(r).status_code == 200
    assert maker_of(r)["id"] == original["id"]
    assert maker_of(r)["persona"] == original["persona"] and tables(r.hive) == after


def test_reviewed_0422_release_asset_resolves_with_its_actual_source_digest(r, monkeypatch):
    from hive.core.studio_makers import release_template
    supplied = os.environ.get('HIVE_TEST_STUDIO_0422_RELEASE')
    if not supplied:
        pytest.skip("HIVE_TEST_STUDIO_0422_RELEASE is unset")
    folder = Path(supplied).expanduser().resolve()
    assert folder.is_dir(), 'configured Studio0.4.22 release asset is missing'
    digest = "sha256:64abf47808a469d37154be509266977b1a3887f0d39f0b974d7d5c3bce7f6f6e"
    assert Programs.source_digest(folder) == digest
    r.entry.update(path=str(folder), digest=digest, version="0.4.22")
    monkeypatch.setattr(r.hive.programs, "pins", {PROGRAM: {"release": str(folder), "digest": digest}})
    template = release_template(r.hive)
    assert template["id"] == "omegadesign:create-maker" and template["release_digest"] == digest
    assert template["role_id"] is None and json.loads(template["options"]) == {"tools": []}
    assert template["persona"] == json.loads((folder / "plugin.json").read_text())["maker_templates"]["create-maker"]["persona"]


@pytest.mark.parametrize("consumer", ["setup", "startup"])
def test_oversized_integer_budget_refuses_setup_and_startup_without_crashing(r, monkeypatch, caplog, consumer):
    r.manifest["maker_templates"]["create-maker"]["budget_usd"] = 10**400
    pin_release(r, r.folder, r.manifest)
    before = tables(r.hive)
    if consumer == "setup":
        response = setup(r)
        assert response.status_code == 409
    else:
        monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
        monkeypatch.setattr(r.hive.studio, "components", lambda: {"synthetic present component": True})
        with caplog.at_level("WARNING", logger="hive"):
            assert r.hive.studio.self_check() == (True, [])  # unavailable template warns; it does not abort host startup
        assert any("maker template" in record.getMessage() for record in caplog.records)
    assert tables(r.hive) == before


@pytest.mark.parametrize("consumer", ["setup", "startup"])
def test_captured_digest_mismatch_refuses_valid_identity_even_when_outer_readiness_passes(r, monkeypatch, caplog, consumer):
    # Deliberately let _ready pass. The captured bytes have the correct app id/version/name and template, so the
    # two captured-digest checks are the only reason to refuse; removing both must turn this test red.
    monkeypatch.setattr(r.hive.programs, "_ready", lambda _: r.entry)
    raw = json.dumps(r.manifest).encode()
    monkeypatch.setattr(Programs, "_source_snapshot", staticmethod(lambda folder: ("sha256:" + "b" * 64, raw)))
    before = tables(r.hive)
    if consumer == "setup":
        response = setup(r)
        assert response.status_code == 409, response.text
    else:
        monkeypatch.setenv("HIVE_STUDIO_SESSIONS", "on")
        monkeypatch.setattr(r.hive.studio, "components", lambda: {"synthetic present component": True})
        with caplog.at_level("WARNING", logger="hive"):
            assert r.hive.studio.self_check() == (True, [])
        assert any("maker template" in record.getMessage() for record in caplog.records)
    assert tables(r.hive) == before
