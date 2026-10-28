"""App platform P3a: options.key_locked. A locked mind runs only on its owner's own key: only the owner locks or unlocks
it, every options write keeps its key the owner's, the gateway refuses instead of falling back to another payer, and a
key that locked minds use is not removed unless its owner forces it (the minds then stop, still on that key).
Synthetic only: invented people and keys, no provider call."""
import json

import pytest

from hive.core.gateway import GatewayError
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_key_owner_oi13 import ANN, BOB, K_ANN, K_BOB, MODEL, add_key, code, w  # noqa: F401
from hive.tests.test_visibility import person

K_BOB2 = "k_000b0b0c"


def options(hive, agent_id):
    return json.loads(hive.db.one("SELECT options FROM agents WHERE id = ?", (agent_id,))["options"] or "{}")


def locked_mind(w, key=K_BOB):
    r = w.client.post("/api/agents", headers=w.bob, json={"name": "Lox", "kind": "omega", "swarm_id": w.bob_swarm["id"],
                                                         "model": MODEL, "options": {"key": key, "key_locked": True}})
    assert r.status_code == 200, r.text
    return r.json()


def row(hive, agent_id):
    return hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))


# ---- writes ----------------------------------------------------------------------------------------------------------

def test_owner_creates_a_locked_mind_on_their_own_key(w):
    mind = locked_mind(w)
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}


@pytest.mark.parametrize("opts", [{"key_locked": True}, {"key": "env:openrouter", "key_locked": True}])
def test_a_locked_mind_needs_its_owners_own_key(w, opts):
    r = w.client.post("/api/agents", headers=w.bob, json={"name": "Lox", "kind": "omega", "swarm_id": w.bob_swarm["id"],
                                                         "model": MODEL, "options": opts})
    assert (r.status_code, code(r)) == (403, "own_key_only")


def test_an_admin_cannot_unlock_or_move_a_locked_minds_key(w):
    mind = locked_mind(w)
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.ann,
                       json={"options": {"key": K_BOB, "key_locked": False}})
    assert (r.status_code, code(r)) == (403, "key_lock_owner_only")
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.ann, json={"options": {"key": K_ANN, "key_locked": True}})
    assert (r.status_code, code(r)) == (403, "key_lock_owner_only")
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}


def test_an_admin_cannot_move_a_locked_mind_between_its_owners_keys(w):
    add_key(w.hive, K_BOB2, f"user:{BOB}")
    mind = locked_mind(w)
    wanted = {"key": K_BOB2, "key_locked": True}
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.ann, json={"options": wanted})
    assert (r.status_code, code(r)) == (403, "key_lock_owner_only"), r.text
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}
    assert w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")[0] == K_BOB

    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.bob, json={"options": wanted})
    assert r.status_code == 200, r.text
    assert options(w.hive, mind["id"]) == wanted
    assert w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")[0] == K_BOB2


def test_an_admin_can_edit_other_options_without_changing_a_locked_minds_key(w):
    mind = locked_mind(w)
    wanted = {"key": K_BOB, "key_locked": True, "max_output_tokens": 512}
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.ann, json={"options": wanted})
    assert r.status_code == 200, r.text
    assert options(w.hive, mind["id"]) == wanted


def test_the_owner_moves_between_their_own_keys_and_unlocks(w):
    add_key(w.hive, K_BOB2, f"user:{BOB}")
    mind = locked_mind(w)
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.bob, json={"options": {"key": K_BOB2, "key_locked": True}})
    assert r.status_code == 200, r.text
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.bob,
                       json={"options": {"key": K_BOB2, "key_locked": False}})
    assert r.status_code == 200, r.text
    assert options(w.hive, mind["id"]) == {"key": K_BOB2, "key_locked": False}


def test_the_owner_can_confirm_the_lock_when_editing_other_options(w):
    mind = locked_mind(w)
    wanted = {"key": K_BOB, "key_locked": True, "max_output_tokens": 512}
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.bob, json={"options": wanted})
    assert r.status_code == 200, r.text
    assert options(w.hive, mind["id"]) == wanted
    assert w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")[0] == K_BOB


@pytest.mark.parametrize("value", ["yes", 0, 1])
def test_options_key_locked_must_be_a_boolean(w, value):
    r = w.client.post("/api/agents", headers=w.bob, json={"name": "Lox", "kind": "omega", "swarm_id": w.bob_swarm["id"],
                                                         "model": MODEL, "options": {"key": K_BOB, "key_locked": value}})
    assert (r.status_code, code(r)) == (400, "bad_options")


# ---- the gateway: refuse, never fall back -----------------------------------------------------------------------------

def test_the_gateway_pays_a_locked_mind_with_its_owners_key(w):
    mind = locked_mind(w)
    gw = w.client.app.state.gateway
    assert gw.paying_key(row(w.hive, mind["id"]), "openrouter")[0] == K_BOB


def test_a_locked_mind_with_no_key_is_refused_not_paid_by_the_default(w):
    mind = locked_mind(w)
    w.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (json.dumps({"key_locked": True}), mind["id"]))
    with pytest.raises(GatewayError) as exc:
        w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")
    assert exc.value.code == "own_key_needed"


def test_a_locked_mind_on_someone_elses_key_is_refused_at_call_time(w):
    mind = locked_mind(w)   # a stored row edited behind the write checks: the gateway still refuses
    w.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?",
                      (json.dumps({"key": K_ANN, "key_locked": True}), mind["id"]))
    with pytest.raises(GatewayError) as exc:
        w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")
    assert exc.value.code == "own_key_needed"


def test_an_unlocked_mind_with_no_key_keeps_the_default_as_before(w):
    key_id, _ = w.client.app.state.gateway.paying_key(row(w.hive, w.bob_mind["id"]), "openrouter")
    assert key_id != K_BOB


# ---- removing a key ---------------------------------------------------------------------------------------------------

def test_removing_a_key_that_locked_minds_use_is_refused(w):
    mind = locked_mind(w)
    r = w.client.delete(f"/api/keys/{K_BOB}", headers=w.bob)
    assert (r.status_code, code(r)) == (409, "locked_minds")
    assert K_BOB in w.hive.keyring.ring["keys"]
    assert options(w.hive, mind["id"])["key"] == K_BOB


def test_only_the_keys_owner_can_force_it_and_the_minds_then_stop_on_that_key(w):
    mind = locked_mind(w)
    r = w.client.delete(f"/api/keys/{K_BOB}?force=1", headers=w.ann)   # an admin may not orphan someone's locked minds
    assert (r.status_code, code(r)) == (409, "locked_minds")
    r = w.client.delete(f"/api/keys/{K_BOB}?force=1", headers=w.bob)
    assert r.status_code == 200, r.text
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}   # never moved to another payer
    with pytest.raises(GatewayError) as exc:
        w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")
    assert exc.value.code == "key_unavailable"


def test_a_member_removes_their_own_key_but_not_anyone_elses(w):
    r = w.client.delete(f"/api/keys/{K_ANN}", headers=w.bob)
    assert (r.status_code, code(r)) == (403, "admin_only")
    r = w.client.delete(f"/api/keys/{K_BOB}", headers=w.bob)
    assert r.status_code == 200, r.text
    assert K_BOB not in w.hive.keyring.ring["keys"]


def test_unlocked_minds_on_a_removed_key_are_unassigned_as_before(w):
    r = w.client.patch(f"/api/agents/{w.bob_mind['id']}", headers=w.bob, json={"options": {"key": K_BOB}})
    assert r.status_code == 200, r.text
    r = w.client.delete(f"/api/keys/{K_BOB}", headers=w.bob)
    assert r.status_code == 200 and r.json()["unassigned"] == 1
    assert "key" not in options(w.hive, w.bob_mind["id"])


def test_provider_default_removal_refuses_a_members_locked_key_even_for_an_admin(w):
    mind = locked_mind(w)
    assert w.client.patch(f"/api/keys/{K_BOB}", headers=w.ann, json={"default": True}).status_code == 200
    for suffix in ("", "?force=1"):
        r = w.client.delete("/api/providers/openrouter/key" + suffix, headers=w.ann)
        assert (r.status_code, code(r)) == (409, "locked_minds"), r.text
        assert mind["id"] in r.json()["error"]["minds"]
    assert K_BOB in w.hive.keyring.ring["keys"]
    assert w.hive.keyring.ring["defaults"]["openrouter"] == K_BOB
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}
    # The provider picker remains admin-only; the member owns the separate /api/keys removal route.
    r = w.client.delete("/api/providers/openrouter/key?force=1", headers=w.bob)
    assert (r.status_code, code(r)) == (403, "admin_only")


def test_provider_default_removal_unassigns_unlocked_minds_with_the_actor(w, monkeypatch):
    assert w.client.patch(f"/api/keys/{K_BOB}", headers=w.ann, json={"default": True}).status_code == 200
    r = w.client.patch(f"/api/agents/{w.bob_mind['id']}", headers=w.bob,
                       json={"options": {"key": K_BOB, "max_output_tokens": 512}})
    assert r.status_code == 200, r.text
    updates = []
    # Observe the existing fenced update, without re-entering update_agent.
    update_agent_locked = w.hive._update_agent_locked

    def record_update(agent_id, changes, **kwargs):
        updates.append((agent_id, dict(changes["options"]), kwargs.get("by")))
        return update_agent_locked(agent_id, changes, **kwargs)

    monkeypatch.setattr(w.hive, "_update_agent_locked", record_update)
    r = w.client.delete("/api/providers/openrouter/key", headers=w.ann)
    assert r.status_code == 200 and r.json()["name"] == "openrouter", r.text
    assert r.json()["source"] == "env"   # the existing environment fallback is unchanged for unlocked minds
    assert K_BOB not in w.hive.keyring.ring["keys"]
    assert "openrouter" not in w.hive.keyring.ring["defaults"]
    assert options(w.hive, w.bob_mind["id"]) == {"max_output_tokens": 512}
    assert options(w.hive, w.ann_mind["id"]) == {"key": K_ANN}
    assert updates == [(w.bob_mind["id"], {"max_output_tokens": 512}, f"user:{ANN}")]


def test_provider_default_owner_can_force_removal_without_unassigning_locked_minds(w):
    r = w.client.patch(f"/api/agents/{w.ann_mind['id']}", headers=w.ann,
                       json={"options": {"key": K_ANN, "key_locked": True}})
    assert r.status_code == 200, r.text
    r = w.client.patch(f"/api/agents/{w.bob_mind['id']}", headers=w.ann,
                       json={"options": {"key": K_ANN, "max_output_tokens": 512}})
    assert r.status_code == 200, r.text
    assert w.client.patch(f"/api/keys/{K_ANN}", headers=w.ann, json={"default": True}).status_code == 200
    r = w.client.delete("/api/providers/openrouter/key", headers=w.ann)
    assert (r.status_code, code(r)) == (409, "locked_minds"), r.text
    assert K_ANN in w.hive.keyring.ring["keys"]
    r = w.client.delete("/api/providers/openrouter/key?force=1", headers=w.ann)
    assert r.status_code == 200 and r.json()["name"] == "openrouter", r.text
    assert K_ANN not in w.hive.keyring.ring["keys"]
    assert options(w.hive, w.ann_mind["id"]) == {"key": K_ANN, "key_locked": True}
    assert options(w.hive, w.bob_mind["id"]) == {"max_output_tokens": 512}
    with pytest.raises(GatewayError) as exc:
        w.client.app.state.gateway.paying_key(row(w.hive, w.ann_mind["id"]), "openrouter")
    assert exc.value.code == "key_unavailable"


def test_key_removal_guard_matches_an_escaped_json_key_structurally(w):
    mind = locked_mind(w)
    encoded = json.dumps({"key": K_BOB, "key_locked": True}).replace(K_BOB, "\\u006b" + K_BOB[1:])
    assert K_BOB not in encoded and json.loads(encoded)["key"] == K_BOB
    w.hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", (encoded, mind["id"]))
    r = w.client.delete(f"/api/keys/{K_BOB}", headers=w.bob)
    assert (r.status_code, code(r)) == (409, "locked_minds"), r.text
    assert K_BOB in w.hive.keyring.ring["keys"]
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}


# ---- review fixes: import, host creation, embeddings -------------------------------------------------------------------

@pytest.mark.parametrize("wanted, status, expected_code", [
    ({}, 409, "lock_confirm"),
    ({"key": K_BOB, "key_locked": False}, 403, "key_lock_owner_only"),
])
def test_an_admin_cannot_import_a_locked_mind_back_unlocked(w, wanted, status, expected_code):
    from hive.tests.test_key_owner_oi13 import bundle
    import io as _io, tarfile as _tar
    mind = locked_mind(w)
    # as after export and settle: the row is kept, moved away
    w.hive.db.execute("UPDATE agents SET deleted = 1, moved_to = 'h_elsewhere' WHERE id = ?", (mind["id"],))
    before = {k: row(w.hive, mind["id"])[k] for k in ("owner", "options", "deleted", "moved_to")}
    with _tar.open(fileobj=_io.BytesIO(bundle(mind["id"], wanted)), mode="r:gz") as t:
        manifest = json.loads(t.extractfile("manifest.json").read())
    manifest["mind"]["owner"] = f"user:{BOB}"   # retain stored owner: no owner-transfer refusal may mask the guard
    buf = _io.BytesIO()
    with _tar.open(fileobj=buf, mode="w:gz") as t:
        data = json.dumps(manifest).encode()
        info = _tar.TarInfo("manifest.json"); info.size = len(data); t.addfile(info, _io.BytesIO(data))
    r = w.client.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.ann, content=buf.getvalue())
    assert (r.status_code, code(r)) == (status, expected_code), r.text
    if status == 409:
        assert r.json()["error"]["message"] == "send key_locked: true to keep the lock, or key_locked: false to unlock"
    assert {k: row(w.hive, mind["id"])[k] for k in before} == before


def test_a_nonowner_cannot_import_a_locked_mind_on_another_key_of_its_owner(w):
    from hive.tests.test_key_owner_oi13 import bundle
    import io as _io, tarfile as _tar
    add_key(w.hive, K_BOB2, f"user:{BOB}")
    mind = locked_mind(w)
    w.hive.db.execute("UPDATE agents SET deleted = 1, moved_to = 'h_elsewhere' WHERE id = ?", (mind["id"],))
    before = {k: row(w.hive, mind["id"])[k] for k in ("owner", "options", "deleted", "moved_to")}
    raw = bundle(mind["id"], {"key": K_BOB2, "key_locked": True})
    with _tar.open(fileobj=_io.BytesIO(raw), mode="r:gz") as t:
        manifest = json.loads(t.extractfile("manifest.json").read())
    manifest["mind"]["owner"] = f"user:{BOB}"   # same owner: refusal must be about the changed locked key
    buf = _io.BytesIO()
    with _tar.open(fileobj=buf, mode="w:gz") as t:
        data = json.dumps(manifest).encode()
        info = _tar.TarInfo("manifest.json"); info.size = len(data); t.addfile(info, _io.BytesIO(data))
    r = w.client.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.ann, content=buf.getvalue())
    assert (r.status_code, code(r)) == (403, "key_lock_owner_only"), r.text
    assert {k: row(w.hive, mind["id"])[k] for k in before} == before


def test_a_host_made_locked_mind_must_be_on_its_owners_key(w):
    from hive.core.hive import HiveError
    with pytest.raises(HiveError) as exc:
        w.hive.create_agent("Hosty", swarm_id=w.bob_swarm["id"], model=MODEL, options={"key": K_ANN, "key_locked": True},
                            owner=f"user:{BOB}")
    assert exc.value.code == "own_key_only"
    made = w.hive.create_agent("Hosty", swarm_id=w.bob_swarm["id"], model=MODEL,
                               options={"key": K_BOB, "key_locked": True}, owner=f"user:{BOB}")
    assert options(w.hive, made["id"]) == {"key": K_BOB, "key_locked": True}


def _embed_world(w, monkeypatch):
    from hive.core.hive import token_hash
    hive = w.hive
    monkeypatch.setattr(hive.settings.providers["openrouter"], "prices", {"test/embed": {"in": 1.0, "out": 1.0}, "test/m": {"in": 1.0, "out": 1.0}})
    monkeypatch.setattr(hive.settings, "embedding_model", "openrouter/test/embed")
    gw = w.client.app.state.gateway
    sent = []

    async def embeddings(model, data, agent=None, key_id=None):
        sent.append((model, key_id))
        return {"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [0.1]}], "model": model,
                "usage": {"prompt_tokens": 3, "total_tokens": 3}}
    monkeypatch.setattr(gw, "embeddings", embeddings)
    mind = locked_mind(w)
    hive.db.execute("UPDATE agents SET token_hash = ?, budget_usd = 5 WHERE id = ?", (token_hash("tok-p3a"), mind["id"]))
    return mind, sent


def test_a_locked_mind_embeds_on_its_assigned_key(w, monkeypatch):
    mind, sent = _embed_world(w, monkeypatch)
    r = w.client.post("/llm/v1/embeddings", headers={"Authorization": "Bearer tok-p3a"}, json={"input": ["x"]})
    assert r.status_code == 200, r.text
    assert sent == [("openrouter/test/embed", K_BOB)]


def test_a_locked_minds_embeddings_stop_when_its_key_is_gone(w, monkeypatch):
    add_key(w.hive, K_BOB2, f"user:{BOB}")   # another of the owner's keys must not take over
    mind, sent = _embed_world(w, monkeypatch)
    r = w.client.delete(f"/api/keys/{K_BOB}?force=1", headers=w.bob)
    assert r.status_code == 200, r.text
    r = w.client.post("/llm/v1/embeddings", headers={"Authorization": "Bearer tok-p3a"}, json={"input": ["x"]})
    assert (r.status_code, code(r)) == (402, "key_unavailable"), r.text
    assert sent == []


def test_after_a_forced_removal_the_owner_moves_the_mind_to_another_own_key(w):
    add_key(w.hive, K_BOB2, f"user:{BOB}")
    mind = locked_mind(w)
    assert w.client.delete(f"/api/keys/{K_BOB}?force=1", headers=w.bob).status_code == 200
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.bob, json={"options": {"key": K_BOB2, "key_locked": True}})
    assert r.status_code == 200, r.text
    assert w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")[0] == K_BOB2


def test_an_admin_cannot_repoint_a_locked_mind_after_its_key_is_force_removed(w):
    add_key(w.hive, K_BOB2, f"user:{BOB}")
    mind = locked_mind(w)
    r = w.client.delete(f"/api/keys/{K_BOB}?force=1", headers=w.bob)
    assert r.status_code == 200, r.text
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.ann,
                       json={"options": {"key": K_BOB2, "key_locked": True}})
    assert (r.status_code, code(r)) == (403, "key_lock_owner_only"), r.text
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}
    with pytest.raises(GatewayError) as exc:
        w.client.app.state.gateway.paying_key(row(w.hive, mind["id"]), "openrouter")
    assert exc.value.code == "key_unavailable"


@pytest.mark.parametrize("wanted", [{"max_output_tokens": 512}, {"key": K_BOB, "max_output_tokens": 512}])
def test_an_owner_options_patch_must_explicitly_confirm_the_stored_lock(w, wanted):
    mind = locked_mind(w)
    r = w.client.patch(f"/api/agents/{mind['id']}", headers=w.bob, json={"options": wanted})
    assert (r.status_code, code(r)) == (409, "lock_confirm"), r.text
    assert r.json()["error"]["message"] == "send key_locked: true to keep the lock, or key_locked: false to unlock"
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}


def test_an_import_cannot_change_a_locked_minds_owner_then_unlock_it(w):
    from hive.tests.test_key_owner_oi13 import bundle
    import io as _io, tarfile as _tar
    mind = locked_mind(w)
    w.hive.db.execute("UPDATE agents SET deleted = 1, moved_to = 'h_elsewhere' WHERE id = ?", (mind["id"],))
    raw = bundle(mind["id"], {"key": K_BOB, "key_locked": True})
    with _tar.open(fileobj=_io.BytesIO(raw), mode="r:gz") as t:
        manifest = json.loads(t.extractfile("manifest.json").read())
    manifest["mind"]["owner"] = f"user:{ANN}"
    buf = _io.BytesIO()
    with _tar.open(fileobj=buf, mode="w:gz") as t:
        data = json.dumps(manifest).encode()
        info = _tar.TarInfo("manifest.json"); info.size = len(data); t.addfile(info, _io.BytesIO(data))
    r = w.client.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.ann, content=buf.getvalue())
    assert (r.status_code, code(r)) == (403, "key_lock_owner_only"), r.text
    assert w.hive.db.one("SELECT owner FROM agents WHERE id = ?", (mind["id"],))["owner"] == f"user:{BOB}"


def test_a_locked_studio_makers_embeddings_stop_when_its_key_is_gone(w, monkeypatch):
    add_key(w.hive, K_BOB2, f"user:{BOB}")
    mind, sent = _embed_world(w, monkeypatch)
    monkeypatch.setattr(w.hive.studio_makers, "person_of", lambda agent_id: f"user:{BOB}" if agent_id == mind["id"] else None)
    assert w.client.delete(f"/api/keys/{K_BOB}?force=1", headers=w.bob).status_code == 200
    r = w.client.post("/llm/v1/embeddings", headers={"Authorization": "Bearer tok-p3a"}, json={"input": ["x"]})
    assert (r.status_code, code(r)) == (402, "key_unavailable"), r.text
    assert sent == []


def test_a_locked_mind_refuses_a_nonowner_without_an_owner_grant(w):
    from hive.core.hive import HiveError
    mind = locked_mind(w)
    w.hive.ownhive.person_key_check(row(w.hive, mind["id"]), K_BOB, user=f"user:{BOB}")   # the owner: fine
    with pytest.raises(HiveError) as exc:   # no owner grant: refused, never billed to the owner
        w.hive.ownhive.person_key_check(row(w.hive, mind["id"]), K_BOB, user=f"user:{ANN}")
    assert exc.value.code == "own_key_needed"


def test_an_owner_grant_keeps_a_locked_mind_on_its_owners_key(w, monkeypatch):
    """The lock fixes the paying key, preserving the owner's choice to grant someone a limit on it.
    Admission and usage attribution only: this invented cost never calls a provider."""
    from hive.core.hive import HiveError
    mind = locked_mind(w)
    agent = row(w.hive, mind["id"])
    original_user_for = w.hive.user_for
    monkeypatch.setattr(w.hive, "user_for", lambda a: f"user:{ANN}" if a["id"] == mind["id"] else original_user_for(a))
    key_id, _secret = w.client.app.state.gateway.paying_key(agent, "openrouter")
    assert key_id == K_BOB
    with pytest.raises(HiveError) as exc:
        w.hive.ownhive.person_key_check(agent, key_id)
    assert exc.value.code == "own_key_needed"

    r = w.client.post("/api/me/key-limits/grants", headers=w.bob,
                      json={"grantee": f"user:{ANN}", "key_id": K_BOB, "month_usd": 1})
    assert r.status_code == 200, r.text
    grant = r.json()
    assert (grant["owner"], grant["key_id"], grant["grantee"]) == (f"user:{BOB}", K_BOB, f"user:{ANN}")
    w.hive.ownhive.person_key_check(agent, key_id)
    payer, own_key = w.hive.payer_for(agent, key_owner=f"user:{BOB}")
    assert (payer, own_key) == (f"user:{ANN}", False)
    w.hive.ownhive.use_check(agent, key_id, payer)
    assert w.client.app.state.gateway.paying_key(agent, "openrouter")[0] == K_BOB
    w.hive.record_usage(agent, MODEL, {"prompt_tokens": 1, "completion_tokens": 1,
                                     "cost_usd": 0.25, "key_id": key_id}, payer=payer)
    usage = w.hive.db.one("SELECT key_id, payer, key_grantee FROM usage WHERE agent_id = ?", (mind["id"],))
    assert (usage["key_id"], usage["payer"], usage["key_grantee"]) == (K_BOB, f"user:{ANN}", f"user:{ANN}")
    assert options(w.hive, mind["id"]) == {"key": K_BOB, "key_locked": True}

    r = w.client.delete(f"/api/me/key-limits/{grant['id']}", headers=w.bob)
    assert r.status_code == 200 and r.json()["active"] is False
    with pytest.raises(HiveError) as exc:
        w.hive.ownhive.person_key_check(agent, key_id)
    assert exc.value.code == "own_key_needed"
