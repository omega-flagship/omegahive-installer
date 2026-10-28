"""J3 host R8.3: a hooked Studio app attaches a person's own maker only through its own member_attach declaration.

Dot -> Design / Surface contract (2026-10-20, coordination/inbox/...-member-attach-fix-contract.md): the live Design app
0.4.20 defines offer/bind/unbind, pure and admin-only (``_attachment_admin``), so host ca84ecb2 refused every member's
own maker (template_ready False, 409 studio_maker_attach_unsupported) and the Ask never offered "Draw live with a mind".
R8.3, for the configured Studio program only: a hooked app is attachable by the host IF AND ONLY IF it exports a valid
``member_attach`` ({"actions": [...offered...], "channels": []}); the attach then runs NO app hook, stores exactly the
declared scope, is recorded as the host actor, and keeps every person/binding/swarm/owner check and the idempotency of R7.
No declaration, or a malformed one, keeps today's refusal. Cleanup (admin revoke, reconcile, deleted maker, disabled
person, sweep) ends such a row without hooks. Synthetic only: temporary data directories, invented keys, no live hive."""
import importlib.util
import json
import os
import pathlib
import types

import pytest

import hive.tests.test_studio_session_r3 as R3
from hive.core.studio_makers import HOST_ACTOR
from hive.tests.test_studio_session_r7 import (BOB, CARD, PROGRAM, caps, card, maker_of, p, personal_world,  # noqa: F401
                                               setup, studio_entry, tables)
from hive.tests.test_ask_intents import a  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import MIA, PIN, err, s  # noqa: F401

OFFERED = ["trace", "motion"]                   # the shape of 0.4.20's describe(): every op agents True but save-source
VALID = {"actions": ["trace", "motion"], "channels": []}
REAL_0420 = pathlib.Path(os.environ.get("OMEGADESIGN_0420_DIR",
                                        "/path/to/OmegaHive/.runtime/omegadesign-release/0.4.20"))
_ABSENT = object()


def hooked_module(calls, declaration=_ABSENT, hooks=("offer", "bind", "unbind")):
    """A module shaped as Design 0.4.20's attachment surface (offer/bind/unbind, admin-only), whose hooks record the call
    and raise: R8.3 must never call any of them."""
    module = types.ModuleType("omegadesign_r83_fixture")

    def hook(name):
        def run(*args, **kwargs):
            calls.append(name)
            raise AssertionError(f"R8.3 must not call the app's {name} hook")
        return run
    for name in hooks:
        setattr(module, name, hook(name))
    if declaration is not _ABSENT:
        module.member_attach = declaration
    return module


RELEASE = "/opt/omegahive/apps/omegadesign-r83-fixture"
# Kimi on Design 0.4.21: the real 0.4.21 declaration equals the full agents set of 0.4.20's describe()
FULL_0421 = ["init", "inspect", "revise", "direction", "reuse-identity", "select", "svg", "ui", "react", "merge", "motion",
             "model-init", "model-inspect", "model-revise", "model-glb"]


def entry_for(module, describe=None, digest=PIN["digest"]):
    return {"id": PROGRAM, "name": "OmegaDesign", "version": PIN["version"], "digest": digest, "module": module,
            "path": RELEASE, "source": "pinned",
            "describe": describe or {"actions": [{"id": "trace", "agents": True}, {"id": "motion", "agents": True},
                                                 {"id": "save-source", "agents": False}]}}


@pytest.fixture()
def calls():
    return []


@pytest.fixture(autouse=True)
def pinned(p, monkeypatch):
    """The Studio app is the digest-pinned release (HIVE_APP_PINS as Programs holds it after a reload); R8.3 honours
    member_attach only then. Tests of the unpinned case clear or change it."""
    monkeypatch.setattr(p.hive.programs, "pins", {PROGRAM: {"release": RELEASE, "digest": PIN["digest"]}})


def host_row(hive, mind_id):
    return hive.db.one("SELECT * FROM app_attachments WHERE mind = ? ORDER BY rowid DESC LIMIT 1", (mind_id,))


def audits(hive, mind_id, action="attached"):
    return [json.loads(r["detail"] or "{}") for r in hive.db.all(
        "SELECT detail FROM studio_maker_audit WHERE agent_id = ? AND action = ? ORDER BY rowid", (mind_id, action))]


# ---- 1. no declaration: refused exactly as before ------------------------------------------------------------------------

def test_R83_a_hooked_0420_shaped_app_without_member_attach_stays_refused_and_no_hook_runs(p, calls):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls))
    assert hive.studio_makers.template_ready() is False
    assert "studio_sessions" not in caps(p)
    r = setup(p)
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_attach_unsupported")
    m = maker_of(p)
    assert hive.db.one("SELECT COUNT(*) AS n FROM app_attachments WHERE mind = ?", (m["id"],))["n"] == 0
    assert calls == []


# ---- 2. a valid declaration: attached with exactly that scope, no hook, as the host --------------------------------------

def test_R83_a_hooked_app_with_a_valid_member_attach_is_ready_and_setup_attaches_exactly_the_declared_scope(p, calls):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls, {"actions": ["motion"], "channels": []}))
    assert hive.studio_makers.template_ready() is True
    assert caps(p)["studio_sessions"] is True
    r = setup(p)
    assert r.status_code == 200, r.text
    m = maker_of(p)
    att = host_row(hive, m["id"])
    assert (att["status"], att["actor"], att["by_person"], att["swarm"]) == ("active", HOST_ACTOR, MIA, m["swarm_id"])
    assert json.loads(att["scope"]) == {"actions": ["motion"], "channels": []}           # exactly the declaration
    assert json.loads(att["policy"]) == {"motion": "ask"}
    assert att["request_key"] == f"host:studio_maker:{m['id']}" and r.json()["maker"]["attachment_id"] == att["id"]
    assert hive.db.one("SELECT COUNT(*) AS n FROM app_activations")["n"] == 0
    assert audits(hive, m["id"]) == [{"attachment": att["id"], "program": PROGRAM, "swarm_id": m["swarm_id"],
                                      "by": HOST_ACTOR, "scope_source": "member_attach", "actions": ["motion"],
                                      "channels": []}]
    assert hive.app_attachments.host_studio_active(PROGRAM, m["swarm_id"]) is True
    # idempotent: a second setup returns the same row and writes nothing
    before = tables(hive)
    again = setup(p).json()["maker"]
    assert again["attachment_id"] == att["id"] and tables(hive) == before
    # and the setup card's request is attached at its pin through the real check (hooked app: attachments required)
    c = card(p)
    assert hive.app_attachments.required(p.entry) is True and hive.studio._app_attached(c["request"]) is True
    assert calls == []


def test_R83_the_person_binding_swarm_and_owner_checks_are_unchanged_for_a_declared_app(p, calls):
    hive = p.hive
    setup(p)
    setup(p, p.bob)
    mia, bob = maker_of(p), maker_of(p, BOB)
    hive.db.execute("UPDATE app_attachments SET status = 'revoked'")
    p.entry = entry_for(hooked_module(calls, VALID))
    attach = hive.app_attachments.host_attach_studio_maker
    before = tables(hive)
    for program, mind, principal in ((PROGRAM, p.maker["id"], MIA), (PROGRAM, p.template["id"], MIA),
                                     (PROGRAM, bob["id"], MIA), (PROGRAM, mia["id"], BOB),
                                     (PROGRAM, mia["id"], "user:operator"), ("seamapp", mia["id"], MIA)):
        with pytest.raises(Exception) as e:
            attach(program, mind, principal)
        assert getattr(e.value, "code", None) == "attachment_refused", (program, mind, principal)
        assert tables(hive) == before
    hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (p.home["id"], mia["id"]))
    with pytest.raises(Exception) as e:
        attach(PROGRAM, mia["id"], MIA)
    assert e.value.code == "attachment_refused"
    hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (mia["swarm_id"], mia["id"]))
    # a live non-host attachment of the mind (e.g. an admin's) is already_attached, as before
    hive.db.insert("app_attachments", {"id": "at_other", "program": PROGRAM, "swarm": mia["swarm_id"], "mind": mia["id"],
                                       "actor": "x", "scope": json.dumps(VALID), "policy": "{}", "expires": None,
                                       "status": "binding", "by_person": "user:u_quinn", "revoked_by": None,
                                       "request_key": "admin-1", "payload_digest": "d", "binding": None})
    with pytest.raises(Exception) as e:
        attach(PROGRAM, mia["id"], MIA)
    assert e.value.code == "already_attached"
    assert calls == []


# ---- 3. malformed declarations fail closed --------------------------------------------------------------------------------

@pytest.mark.parametrize("declaration", [
    {"actions": ["trace"], "channels": [], "policy": {"trace": "allow"}},   # extra key
    {"actions": ["trace"]},                                                  # missing key
    {"actions": ["trace"], "channels": ["hub"]},                             # non-empty channels
    {"actions": ["trace"], "channels": ()},                                  # channels not a list
    {"actions": ["save-source"], "channels": []},                            # not offered to minds
    {"actions": ["trace", "nope"], "channels": []},                          # not an action of the app
    {"actions": ["trace", "trace"], "channels": []},                         # duplicates
    {"actions": [], "channels": []},                                         # empty
    {"actions": ("trace",), "channels": []},                                 # actions not a list
    {"actions": ["trace", 1], "channels": []},                               # not a string
    ["trace"], "trace", None, types.SimpleNamespace(actions=["trace"], channels=[]),   # not a dict
], ids=["extra-key", "missing-key", "channels", "channels-tuple", "not-offered", "unknown", "duplicates", "empty",
        "tuple", "non-str", "list", "str", "none", "object"])
def test_R83_a_malformed_member_attach_is_no_declaration(p, calls, declaration):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls, declaration))
    assert hive.app_attachments.member_attach(p.entry) is None
    assert hive.studio_makers.template_ready() is False
    r = setup(p)
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_attach_unsupported")
    assert hive.db.one("SELECT COUNT(*) AS n FROM app_attachments WHERE mind = ?", (maker_of(p)["id"],))["n"] == 0
    assert calls == []


def test_R83_a_bind_only_app_stays_refused_even_with_a_declaration(p, calls):
    for declaration in (_ABSENT, VALID):
        p.entry = entry_for(hooked_module(calls, declaration, hooks=("bind",)))
        assert p.hive.studio_makers.template_ready() is False
        r = setup(p)
        assert (r.status_code, err(r)["code"]) == (409, "studio_maker_attach_unsupported")
    assert calls == []


# ---- 3b. Kimi on Design 0.4.21: equal set, deep copy, pinned identity -----------------------------------------------------

def test_R83_a_declaration_equal_to_the_full_offered_set_is_accepted(p, calls):
    describe = {"actions": [{"id": op, "agents": True} for op in FULL_0421] + [{"id": "save-source", "agents": False}]}
    p.entry = entry_for(hooked_module(calls, {"actions": list(FULL_0421), "channels": []}), describe)
    assert p.hive.app_attachments.member_attach(p.entry) == {"actions": FULL_0421, "channels": []}   # subset OR equal
    assert p.hive.studio_makers.template_ready() is True
    assert setup(p).status_code == 200
    assert json.loads(host_row(p.hive, maker_of(p)["id"])["scope"]) == {"actions": FULL_0421, "channels": []}
    assert calls == []


def test_R83_the_stored_scope_is_a_deep_copy_and_never_re_read_from_the_live_module(p, calls):
    hive = p.hive
    declaration = {"actions": ["trace", "motion"], "channels": []}
    module = hooked_module(calls, declaration)
    p.entry = entry_for(module)
    got = hive.app_attachments.member_attach(p.entry)
    assert got == declaration and got["actions"] is not declaration["actions"] and got["channels"] is not declaration["channels"]
    assert setup(p).status_code == 200
    att = host_row(hive, maker_of(p)["id"])
    declaration["actions"].clear()                                       # the module's dict mutated after attach
    declaration["actions"].append("trace")
    declaration["channels"].append("hub")
    assert json.loads(host_row(hive, maker_of(p)["id"])["scope"]) == {"actions": ["trace", "motion"], "channels": []}
    view = hive.app_attachments.view(host_row(hive, maker_of(p)["id"]))
    assert (view["actions"], view["channels"]) == (["trace", "motion"], [])
    # the existing attachment answers from its row (idempotent), not from the now-malformed live declaration
    module.member_attach = {"actions": ["trace"], "channels": []}
    again = hive.app_attachments.host_attach_studio_maker(PROGRAM, maker_of(p)["id"], MIA)
    assert again["id"] == att["id"] and again["actions"] == ["trace", "motion"]
    assert calls == []


@pytest.mark.parametrize("pins", ["none", "absent", "other-digest", "bad-digest"])
def test_R83_member_attach_is_honoured_only_for_the_digest_pinned_release(p, calls, monkeypatch, pins):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls, VALID))
    if pins == "none":
        monkeypatch.setattr(hive.programs, "pins", None)
    elif pins == "absent":
        monkeypatch.setattr(hive.programs, "pins", {"seamapp": {"release": RELEASE, "digest": PIN["digest"]}})
    elif pins == "other-digest":
        p.entry = entry_for(hooked_module(calls, VALID), digest="sha256:" + "b" * 64)
    else:
        monkeypatch.setattr(hive.programs, "pins", {PROGRAM: {"release": RELEASE, "digest": None}})
    assert hive.app_attachments.pinned_member_attach(p.entry) is None
    assert hive.studio_makers.template_ready() is False
    r = setup(p)
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_attach_unsupported")
    assert hive.db.one("SELECT COUNT(*) AS n FROM app_attachments WHERE mind = ?", (maker_of(p)["id"],))["n"] == 0
    assert calls == []


# ---- 4. nothing changes for any other program, or for a hook-free Studio ---------------------------------------------------

def test_R83_a_declaration_is_honoured_only_for_the_configured_studio_program(p, calls, monkeypatch):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls, VALID))
    monkeypatch.setenv("HIVE_STUDIO_PROGRAM", "otherstudio")       # Studio is another program here
    setup_ok = hive.studio_makers.template_ready()
    assert setup_ok is False                                       # otherstudio isn't loaded
    with pytest.raises(Exception) as e:
        hive.app_attachments.host_attach_studio_maker(PROGRAM, p.maker["id"], MIA)
    assert e.value.code == "attachment_refused"
    assert hive.db.one("SELECT COUNT(*) AS n FROM app_attachments")["n"] == 0
    assert calls == []


def test_R83_a_hook_free_studio_keeps_the_R7_scope_whatever_it_declares(p):
    module = studio_entry()["module"]
    module.member_attach = {"actions": ["nope"], "channels": ["x"]}    # ignored: no hooks to stand in for
    p.entry = {**studio_entry(), "module": module}
    assert p.hive.studio_makers.template_ready() is True
    assert setup(p).status_code == 200
    att = host_row(p.hive, maker_of(p)["id"])
    assert json.loads(att["scope"]) == {"actions": ["trace"], "channels": None}
    assert audits(p.hive, maker_of(p)["id"])[0].keys() == {"attachment", "program", "swarm_id"}


# ---- 5. cleanup ends a declared-scope row without hooks --------------------------------------------------------------------

def test_R83_reconcile_and_an_admin_revoke_end_a_declared_row_without_hooks_and_setup_reattaches(p, calls):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls, VALID))
    setup(p)
    m = maker_of(p)
    R3.on_loop(p, hive.app_attachments.reconcile)
    att = host_row(hive, m["id"])
    assert att["status"] == "active"
    r = p.client.delete(f"/api/programs/{PROGRAM}/attachments/{att['id']}", headers=p.quinn)
    assert r.status_code == 200, r.text
    assert hive.db.one("SELECT status FROM app_attachments WHERE id = ?", (att["id"],))["status"] == "revoked"
    # an unbind_pending host row (e.g. a crash mid-revoke) is finished by reconcile, without hooks
    again = setup(p).json()["maker"]
    assert again["attachment_id"] not in (None, att["id"])
    hive.db.execute("UPDATE app_attachments SET status = 'unbind_pending' WHERE id = ?", (again["attachment_id"],))
    R3.on_loop(p, hive.app_attachments.reconcile)
    assert hive.db.one("SELECT status FROM app_attachments WHERE id = ?", (again["attachment_id"],))["status"] == "revoked"
    assert calls == []


def test_R83_a_deleted_maker_a_disabled_person_and_the_sweep_end_declared_rows_without_hooks(p, calls):
    hive = p.hive
    p.entry = entry_for(hooked_module(calls, VALID))
    setup(p)
    m = maker_of(p)
    assert p.client.delete(f"/api/agents/{m['id']}", headers=p.mg).status_code == 200
    assert host_row(hive, m["id"])["status"] == "revoked" and maker_of(p) is None
    setup(p)
    m2 = maker_of(p)
    assert host_row(hive, m2["id"])["status"] == "active"
    assert p.client.patch("/api/people/u_mia", headers=p.quinn, json={"disabled": True}).status_code == 200
    assert hive.db.one("SELECT deleted FROM agents WHERE id = ?", (m2["id"],))["deleted"] == 1
    assert host_row(hive, m2["id"])["status"] == "revoked"
    setup(p, p.bob)
    b = maker_of(p, BOB)
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (b["id"],))
    hive.studio_makers.sweep()
    assert host_row(hive, b["id"])["status"] == "revoked"
    assert calls == []


# ---- 6. the actual Design 0.4.20 module (skipped where its release folder is absent) -------------------------------------

def load_0420():
    spec = importlib.util.spec_from_file_location("_r83_omegadesign_0420_program", REAL_0420 / "program.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(not (REAL_0420 / "program.py").is_file(), reason="Design 0.4.20 release folder not present")
def test_R83_the_actual_0420_module_is_refused_and_with_a_0421_shaped_declaration_is_attached_hook_free(p, monkeypatch):
    hive = p.hive
    real = load_0420()
    assert all(callable(getattr(real, h, None)) for h in ("offer", "bind", "unbind")) and not hasattr(real, "member_attach")
    calls = []
    for hook in ("offer", "bind", "unbind"):
        original = getattr(real, hook)
        monkeypatch.setattr(real, hook, lambda *a, _h=hook, _o=original, **k: (calls.append(_h), _o(*a, **k))[1])
    describe = real.describe()
    p.entry = entry_for(real, describe)
    assert hive.studio_makers.template_ready() is False
    r = setup(p)
    assert (r.status_code, err(r)["code"]) == (409, "studio_maker_attach_unsupported")
    # 0.4.21's shape: exactly the actions 0.4.20's own offer() returns, computed here from describe() (not by calling it)
    offered = [x["id"] for x in describe["actions"] if x.get("agents") is True]
    assert "save-source" not in offered and offered == FULL_0421      # 0.4.21 declares exactly this, equal to the set
    monkeypatch.setattr(real, "member_attach", {"actions": list(offered), "channels": []}, raising=False)
    assert hive.studio_makers.template_ready() is True
    r = setup(p)
    assert r.status_code == 200, r.text
    att = host_row(hive, maker_of(p)["id"])
    assert (att["status"], att["actor"]) == ("active", HOST_ACTOR)
    assert json.loads(att["scope"]) == {"actions": offered, "channels": []}
    assert p.client.delete(f"/api/programs/{PROGRAM}/attachments/{att['id']}", headers=p.quinn).status_code == 200
    assert hive.db.one("SELECT status FROM app_attachments WHERE id = ?", (att["id"],))["status"] == "revoked"
    assert calls == []
