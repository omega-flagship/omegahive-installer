"""OI-13: a mind's assigned key (options.key) decides whose money pays for it (Hive.payer_for bills a person's key to
that person). Only the key's owner, or a hive admin / the hive's owner (policy_writer), may put a person's key on a mind.

A member may assign their own keys, and (as before, what GET /api/keys offers them) the hive's environment keys and a
hive-held provider default; never another person's key, on any path that sets options: POST /api/agents,
PATCH /api/agents/{id}, POST /api/agents/import. Refused, nothing changed. An unchanged key (the one already stored)
is never refused, so a member can still edit a mind that carries someone else's key.

r1.1 (Kimi #4): a key the caller may not use is answered exactly as a key that does not exist (404 unknown_key), so
key ids cannot be probed. Import also validates options (unknown key -> 404) and keeps tools admin-only (stand-in P1 2);
GET /api/keys offers a member only the keys they may assign (Kimi #5).
"""
import io
import json
import tarfile
import time

import pytest

from hive.core.placement import FORMAT
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

ANN, BOB, CY = "u_0a0a0a0a", "u_0b0b0b0b", "u_0c0c0c0c"
K_ANN, K_BOB = "k_000a0a0a", "k_000b0b0b"
MODEL = "openrouter/test/m"


def add_key(hive, key_id, owner, provider="openrouter"):
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": provider, "label": key_id, "owner": owner,
                                        "secret": "sk-" + key_id + "-secret", "created_at": time.time()}


def code(response):
    return response.json().get("error", {}).get("code") if response.status_code >= 400 else None


def not_yours(response, key=None):
    """Refused exactly as a key that does not exist: same status, code and wording (no probing of key ids)."""
    err = response.json().get("error", {}) if response.status_code >= 400 else {}
    return (response.status_code == 404 and err.get("code") == "unknown_key"
            and (key is None or err.get("message") == f"no key {key}"))


def stored_key(hive, agent_id):
    row = hive.db.one("SELECT options FROM agents WHERE id = ?", (agent_id,))
    return json.loads(row["options"] or "{}").get("key")


def who_pays(hive, agent_id):
    """Whom a model call of this mind would bill, as the gateway decides it (payer_for with the assigned key's owner)."""
    row = hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))
    key = json.loads(row["options"] or "{}").get("key")
    owner = (hive.keyring.ring["keys"].get(key) or {}).get("owner") if key else None
    return hive.payer_for(row, key_owner=owner)[0]


@pytest.fixture()
def w(client, monkeypatch):  # noqa: F811
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-env-test")
    hive = client.app.state.hive
    ann = person(client, ANN, role="admin")     # the first admin: the hive's owner
    bob = person(client, BOB)
    add_key(hive, K_ANN, f"user:{ANN}")
    add_key(hive, K_BOB, f"user:{BOB}")
    bob_swarm = client.post("/api/swarms", headers=bob, json={"name": "Bob's lab"}).json()
    bob_mind = client.post("/api/agents", headers=bob, json={"name": "Bix", "kind": "omega", "swarm_id": bob_swarm["id"],
                                                            "model": MODEL}).json()
    assert bob_mind.get("id"), bob_mind
    # a mind Ann pays for, in a swarm Bob can see and edit in
    shared = client.post("/api/swarms", headers=ann, json={"name": "Commons", "visibility": "public"}).json()
    ann_mind = client.post("/api/agents", headers=ann, json={"name": "Vega", "kind": "omega", "swarm_id": shared["id"],
                                                            "model": MODEL, "visibility": "public",
                                                            "options": {"key": K_ANN}}).json()
    assert ann_mind.get("id"), ann_mind
    client.put(f"/api/agents/{ann_mind['id']}/visibility", headers=ann, json={"visibility": "public"})
    return type("W", (), dict(client=client, hive=hive, ann=ann, bob=bob, bob_swarm=bob_swarm, bob_mind=bob_mind,
                              shared=shared, ann_mind=ann_mind))


def usage_on(hive, key_id):
    return hive.db.one("SELECT COUNT(*) AS n FROM usage WHERE key_id = ?", (key_id,))["n"]


# ---- the reproduction: PATCH --------------------------------------------------------------------------------------

def test_member_cannot_put_someone_elses_key_on_a_mind(w):
    c, hive, mid = w.client, w.hive, w.bob_mind["id"]
    assert who_pays(hive, mid) == f"user:{BOB}"
    r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {"key": K_ANN}})
    assert not_yours(r, K_ANN), r.text
    assert stored_key(hive, mid) is None                       # nothing changed
    assert who_pays(hive, mid) == f"user:{BOB}"                # Ann would not be billed
    assert usage_on(hive, K_ANN) == 0


def test_member_cannot_swap_a_shared_minds_key_to_someone_elses(w):
    """Bob may edit Ann's shared mind, but may not move it onto a third person's key either."""
    c, hive = w.client, w.hive
    person(c, CY)
    add_key(hive, "k_000c0c0c", f"user:{CY}")
    r = c.patch(f"/api/agents/{w.ann_mind['id']}", headers=w.bob, json={"options": {"key": "k_000c0c0c"}})
    assert not_yours(r, "k_000c0c0c"), r.text
    assert stored_key(hive, w.ann_mind["id"]) == K_ANN


def test_member_sets_own_key(w):
    c, hive, mid = w.client, w.hive, w.bob_mind["id"]
    r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {"key": K_BOB}})
    assert r.status_code == 200, r.text
    assert stored_key(hive, mid) == K_BOB and who_pays(hive, mid) == f"user:{BOB}"
    r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {}})   # and takes it off again
    assert r.status_code == 200 and stored_key(hive, mid) is None


def test_member_keeps_hive_environment_key_as_before(w):
    """GET /api/keys offers a member the hive's environment keys; choosing one stays allowed (existing behaviour)."""
    c, hive, mid = w.client, w.hive, w.bob_mind["id"]
    assert "env:openrouter" in [k["id"] for k in c.get("/api/keys", headers=w.bob).json()]
    r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {"key": "env:openrouter"}})
    assert r.status_code == 200, r.text
    assert stored_key(hive, mid) == "env:openrouter"


def test_guest_may_not_take_the_hive_environment_key(w):
    c, hive = w.client, w.hive
    cy = person(c, CY)
    sw = c.post("/api/swarms", headers=cy, json={"name": "Cy's"}).json()
    mind = c.post("/api/agents", headers=cy, json={"name": "Cyx", "kind": "omega", "swarm_id": sw["id"], "model": MODEL}).json()
    hive.db.execute("UPDATE people SET access = 'guest' WHERE id = ?", (CY,))
    assert "env:openrouter" not in [k["id"] for k in c.get("/api/keys", headers=cy).json()]
    r = c.patch(f"/api/agents/{mind['id']}", headers=cy, json={"options": {"key": "env:openrouter"}})
    assert not_yours(r), r.text
    assert stored_key(hive, mind["id"]) is None


def test_admin_sets_any_key(w):
    c, hive, mid = w.client, w.hive, w.bob_mind["id"]
    r = c.patch(f"/api/agents/{mid}", headers=w.ann, json={"options": {"key": K_ANN}})
    assert r.status_code == 200, r.text
    assert stored_key(hive, mid) == K_ANN
    r = c.patch(f"/api/agents/{w.ann_mind['id']}", headers=w.ann, json={"options": {"key": K_BOB}})
    assert r.status_code == 200 and stored_key(hive, w.ann_mind["id"]) == K_BOB
    r = c.patch(f"/api/agents/{mid}", json={"options": {"key": "env:openrouter"}})   # the loopback operator
    assert r.status_code == 200 and stored_key(hive, mid) == "env:openrouter"


def test_unchanged_key_is_not_refused(w):
    """A member editing a mind that already carries someone else's key: the same key, or no options at all, is fine."""
    c, hive, mid = w.client, w.hive, w.ann_mind["id"]
    r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"name": "Vega two"})
    assert r.status_code == 200, r.text
    r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"persona": "kind", "options": {"key": K_ANN, "max_output_tokens": 512}})
    assert r.status_code == 200, r.text
    assert stored_key(hive, mid) == K_ANN and json.loads(hive.db.one("SELECT options FROM agents WHERE id = ?", (mid,))["options"])["max_output_tokens"] == 512
    # moving it to the member's own key is allowed; moving it back to Ann's is then a change, and refused
    assert c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {"key": K_BOB}}).status_code == 200
    assert not_yours(c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {"key": K_ANN}}), K_ANN)
    assert stored_key(hive, mid) == K_BOB


# ---- creation -------------------------------------------------------------------------------------------------------

def test_member_creation_with_someone_elses_key_is_refused(w):
    c, hive = w.client, w.hive
    before = hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"]
    r = c.post("/api/agents", headers=w.bob, json={"name": "Thief", "kind": "omega", "swarm_id": w.bob_swarm["id"],
                                                    "model": MODEL, "options": {"key": K_ANN}})
    assert not_yours(r, K_ANN), r.text
    assert hive.db.one("SELECT COUNT(*) AS n FROM agents")["n"] == before


def test_member_creation_with_own_key_and_admin_with_any(w):
    c, hive = w.client, w.hive
    r = c.post("/api/agents", headers=w.bob, json={"name": "Mine", "kind": "omega", "swarm_id": w.bob_swarm["id"],
                                                    "model": MODEL, "options": {"key": K_BOB}})
    assert r.status_code == 200, r.text
    assert stored_key(hive, r.json()["id"]) == K_BOB
    r = c.post("/api/agents", headers=w.ann, json={"name": "Lent", "kind": "omega", "swarm_id": w.shared["id"],
                                                    "model": MODEL, "options": {"key": K_BOB}})
    assert r.status_code == 200, r.text
    assert stored_key(hive, r.json()["id"]) == K_BOB


# ---- import (a bundle carries the mind's options) -------------------------------------------------------------------

def bundle(agent_id, options):
    manifest = {"format": FORMAT, "exported_at": time.time(), "from": {"id": "h_elsewhere", "name": "Elsewhere"},
                "mind": {"id": agent_id, "name": "Wanderer", "kind": "omega", "model": MODEL, "persona": "",
                         "options": json.dumps(options), "hue": 10, "budget_usd": 0, "visibility": "private",
                         "shared_with": "[]"},
                "messages": [], "wakeups": [], "rules": [], "files": {}}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = json.dumps(manifest).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_member_import_with_someone_elses_key_is_refused(w):
    c, hive = w.client, w.hive
    r = c.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.bob,
               content=bundle("a_oi13aaaa", {"key": K_ANN}))
    assert not_yours(r, K_ANN), r.text
    assert hive.db.one("SELECT 1 FROM agents WHERE id = ?", ("a_oi13aaaa",)) is None
    r = c.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.bob,
               content=bundle("a_oi13bbbb", {"key": K_BOB}))
    assert r.status_code == 200, r.text
    assert stored_key(hive, "a_oi13bbbb") == K_BOB


def test_import_with_an_unknown_key_is_refused_like_create(w):
    """Kimi #6: a key id this hive does not hold is 404 unknown_key on import, as on create and PATCH."""
    c, hive = w.client, w.hive
    for headers in (w.bob, w.ann):
        r = c.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=headers,
                   content=bundle("a_oi13cccc", {"key": "k_0ddba11f"}))
        assert not_yours(r, "k_0ddba11f"), r.text
    assert hive.db.one("SELECT 1 FROM agents WHERE id = ?", ("a_oi13cccc",)) is None


def test_import_keeps_tools_admin_only(w):
    """Stand-in P1 2: a member's bundle may not carry options.tools (create and PATCH reserve them to admins)."""
    c, hive = w.client, w.hive
    tools = {"tools": ["omegahive.tools.attention@0.1.0"]}
    r = c.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.bob, content=bundle("a_oi13dddd", tools))
    assert r.status_code == 403 and code(r) == "admin_only", r.text
    assert hive.db.one("SELECT 1 FROM agents WHERE id = ?", ("a_oi13dddd",)) is None
    r = c.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.bob,
               content=bundle("a_oi13eeee", {"tools": "not a list"}))
    assert r.status_code == 400 and code(r) == "bad_options", r.text


def test_imported_options_are_stored_clean(w):
    c, hive = w.client, w.hive
    r = c.post(f"/api/agents/import?swarm_id={w.bob_swarm['id']}", headers=w.bob,
               content=bundle("a_oi13ffff", {"key": K_BOB, "junk": 1}))
    assert r.status_code == 200, r.text
    assert json.loads(hive.db.one("SELECT options FROM agents WHERE id = ?", ("a_oi13ffff",))["options"]) == {"key": K_BOB}


def test_key_listing_offers_a_member_only_what_they_may_assign(w):
    """Kimi #5: GET /api/keys (and so the KeyPicker) never offers a member a key the assignment check refuses."""
    c, hive = w.client, w.hive
    hive.keyring.ring["defaults"]["openrouter"] = K_ANN          # Ann's own key is the provider default
    hive.keyring.ring["keys"]["k_000d0d0d"] = {"id": "k_000d0d0d", "provider": "openrouter", "label": "ops", "owner": "hive",
                                              "secret": "sk-ops", "created_at": time.time()}
    offered = [k["id"] for k in c.get("/api/keys", headers=w.bob).json()]
    assert K_ANN not in offered and K_BOB in offered and "env:openrouter" in offered
    mid = w.bob_mind["id"]
    for key in offered:                                         # every offered key is accepted
        r = c.patch(f"/api/agents/{mid}", headers=w.bob, json={"options": {"key": key}})
        assert r.status_code == 200, (key, r.text)
    admin_sees = [k["id"] for k in c.get("/api/keys", headers=w.ann).json()]
    assert K_ANN in admin_sees and "k_000d0d0d" in admin_sees
