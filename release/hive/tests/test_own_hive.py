"""Own hive, round H1 (hive/core/ownhive.py; PLATFORM_OWN_HIVE_CONNECTIONS_PLAN_R1.md, the owner 2026-10-13).

One owner per hive (migrated from the first admin, no access changes); limits on your own keys, for you and for each
grant, enforced at call time through Budgets and the reservation snapshot; public/private with a pays setting; "use my
hive" invites that make a guest with a limit on the owner's keys; asking an owner for a limit; First Light's
monthly_limit item.
"""
import time

import pytest

from hive.core.cost_reservations import host_budget_snapshot, host_subjects
from hive.core.db import now
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

OWNER, BOB, ZED = "u_0a0b0c0d", "u_1b1b1b1b", "u_2c2c2c2c"


def spend(hive, agent_id, payer, usd, key_id):
    hive.db.insert("usage", {"agent_id": agent_id, "model": "m", "prompt_tokens": 1, "completion_tokens": 1, "cost_usd": usd,
                             "created_at": now(), "key_id": key_id, "swarm_id": None, "payer": payer})


def add_key(hive, key_id, owner, provider="openrouter"):
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": provider, "label": key_id, "owner": owner,
                                        "secret": "sk-" + key_id + "-secret", "created_at": time.time()}


def code(response):
    return response.json().get("error", {}).get("code") if response.status_code >= 400 else None


def sc(hive, limit_id):
    """A key limit's scope (H1.1: limits count by owner, key and grantee, not by row id)."""
    return hive.db.one("SELECT scope FROM key_limits WHERE id = ?", (limit_id,))["scope"]


def refused(fn, *args):
    with pytest.raises(Exception) as e:
        fn(*args)
    return getattr(e.value, "code", None), (getattr(e.value, "details", None) or {})


@pytest.fixture()
def world(client):  # noqa: F811
    hive = client.app.state.hive
    owner = person(client, OWNER, role="admin")        # the first admin: becomes the owner
    bob = person(client, BOB)                           # a member from before H1 (people.access NULL)
    add_key(hive, "k_0000000a", f"user:{OWNER}")
    sw = client.post("/api/swarms", headers=owner, json={"name": "Home"}).json()
    mind = client.post("/api/agents", headers=owner, json={"name": "Vega", "kind": "omega", "swarm_id": sw["id"], "model": "openrouter/test/vega", "budget_usd": 100,
                                                          "options": {"key": "k_0000000a"}}).json()
    return {"hive": hive, "owner": owner, "bob": bob, "swarm": sw, "mind": mind}


def make_guest(client, hive, limit=3.0, email="juno@example.test"):  # noqa: F811
    view, _token = hive.people.invite(email, "Juno", "member", 7, by=f"user:{OWNER}", kind="use", limit_usd=limit)
    guest = hive.people.accept_invite_for_verified_email(email, "Juno")
    return view, guest


# ---- 1. one owner per hive -------------------------------------------------------------------------------------------

def test_owner_is_migrated_from_the_first_admin_and_stored(client):  # noqa: F811
    hive = client.app.state.hive
    assert client.get("/api/hive/own").json()["owner"] == "user:operator"      # no admin yet: the loopback operator
    assert hive.db.one("SELECT * FROM hive_owner") is None                     # ... not stored as a person
    first = person(client, OWNER, role="admin")
    person(client, BOB)
    out = client.get("/api/hive/own", headers=first).json()
    assert out["owner"] == f"user:{OWNER}" and out["via"] == "first-admin" and out["you_are_owner"] is True
    assert out["visibility"] == "private" and out["pays"] == "own-key"            # defaults change nothing
    person(client, "u_3d3d3d3d", role="admin")                                   # a later admin never takes over
    assert hive.ownhive.owner() == f"user:{OWNER}"
    assert hive.db.one("SELECT owner FROM hive_owner")["owner"] == f"user:{OWNER}"
    # nobody's access changed: the member and the later admin act as before
    assert client.get("/api/people").status_code == 200
    assert client.get("/api/swarms", headers=person(client, "u_4e4e4e4e")).status_code == 200


def test_owner_only_routes(world, client):  # noqa: F811
    other_admin = person(client, "u_5f5f5f5f", role="admin")
    assert code(client.put("/api/hive/own", headers=other_admin, json={"visibility": "public"})) == "owner_only"
    assert code(client.put("/api/hive/own", headers=world["bob"], json={"pays": "hive-key"})) == "owner_only"
    r = client.put("/api/hive/own", headers=world["owner"], json={"visibility": "public", "pays": "hive-key",
                                                                 "visitor_month_usd": 2})
    assert r.status_code == 200 and r.json()["visibility"] == "public" and r.json()["visitor_month_usd"] == 2
    assert code(client.put("/api/hive/own", headers=world["owner"], json={"visibility": "shared"})) == "bad_visibility"
    assert code(client.put("/api/hive/own", headers=world["owner"], json={"pays": "free"})) == "bad_pays"
    # "use my hive" invitations commit the owner's keys: owner only
    body = {"email": "x@example.test", "kind": "use", "limit_usd": 5}
    assert code(client.post("/api/invites", headers=other_admin, json=body)) == "owner_only"
    r = client.post("/api/invites", headers=world["owner"], json=body)
    assert r.status_code == 200 and r.json()["kind"] == "use" and r.json()["limit_usd"] == 5 and "link" in r.json()
    assert code(client.post("/api/invites", headers=world["owner"], json={**body, "kind": "join"})) == "not_yet"
    assert code(client.post("/api/invites", headers=world["owner"],
                            json={"email": "y@example.test", "limit_usd": 5})) == "bad_request"   # member invites carry none
    assert code(client.post("/api/invites", headers=world["owner"], json={**body, "email": "z@example.test",
                                                                         "role": "admin"})) == "bad_role"
    assert client.post("/api/invites", headers=other_admin, json={"email": "m@example.test"}).status_code == 200   # as before


# ---- 2. limits on your own keys, enforced at call time -----------------------------------------------------------------

def test_own_limit_on_own_key_is_enforced_at_call_time(world, client):  # noqa: F811
    hive, mind = world["hive"], world["mind"]
    agent = hive.agent(mind["id"])
    payer, own = hive.payer_for(agent, f"user:{OWNER}")
    assert (payer, own) == (f"user:{OWNER}", True)
    r = client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0})
    assert r.status_code == 200 and r.json()["grantee"] == "self" and r.json()["key_id"] == "*"
    limit_id = r.json()["id"]
    spend(hive, mind["id"], payer, 0.9, "k_0000000a")
    hive.check_budget(agent, True, 0.05, "k_0000000a", payer, own)                 # room left
    c, d = refused(hive.check_budget, agent, True, 0.2, "k_0000000a", payer, own)  # the owner's own limit refuses
    assert c == "spend_limit" and d["scope"] == sc(hive, limit_id) and d["rule"] == "own"
    # the same limit is a row of the reservation snapshot and a subject of the hold, so concurrent calls are held to it
    rows = {s: (lim, sp) for s, lim, sp in host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, own)}
    label = sc(hive, limit_id) + ":month"
    assert rows[label][0] == 1.0 and abs(rows[label][1] - 0.9) < 1e-9
    assert sc(hive, limit_id) in host_subjects(hive, mind["id"], "k_0000000a", payer, own)
    # only the key's owner sets limits on it
    assert code(client.put("/api/me/key-limits/self", headers=world["bob"],
                           json={"key_id": "k_0000000a", "month_usd": 99})) == "key_owner_only"
    assert code(client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": -1})) == "bad_limit"


def test_reservation_refuses_over_a_key_limit(world, client):  # noqa: F811
    hive, mind = world["hive"], world["mind"]
    from hive.core.cost_reservations import Reservations
    res = Reservations(hive.db)
    limit_id = client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0}).json()["id"]
    payer = f"user:{OWNER}"
    snap = lambda: host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, True)   # noqa: E731
    subjects = host_subjects(hive, mind["id"], "k_0000000a", payer, True)
    res.reserve("r1", {"a": 1}, 0.6, snap, {"agent": mind["id"]}, subjects=subjects)
    with pytest.raises(ValueError, match=sc(hive, limit_id)):                # the first hold counts against the second
        res.reserve("r2", {"a": 2}, 0.6, snap, {"agent": mind["id"]}, subjects=subjects)


def test_grant_limit_replaces_the_member_default_for_that_person(world, client):  # noqa: F811
    hive, mind = world["hive"], world["mind"]
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{BOB}", mind["id"]))   # Bob's use of Vega
    agent = hive.agent(mind["id"])
    assert hive.payer_for(agent, f"user:{OWNER}") == (f"user:{OWNER}", True)   # no grant: billed as at e1717db
    spend(hive, mind["id"], f"user:{BOB}", 49.0, None)                          # Bob's month allowance is nearly used
    r = client.post("/api/me/key-limits/grants", headers=world["owner"],
                    json={"grantee": f"user:{BOB}", "key_id": "k_0000000a", "month_usd": 60})
    assert r.status_code == 200, r.text
    grant = r.json()["id"]
    payer, own = hive.payer_for(agent, f"user:{OWNER}")
    assert (payer, own) == (f"user:{BOB}", False)              # granted: Bob is held himself, by the grant
    hive.budgets.check(agent, 2.0, "k_0000000a", payer, own)    # the grant replaces the member default (49 + 2 > 50)
    c, d = refused(hive.budgets.check, agent, 61.0, "k_0000000a", payer, own)
    assert d["scope"] == sc(hive, grant) and d["rule"] == "grant"
    assert code(client.delete(f"/api/me/key-limits/{grant}", headers=world["bob"])) == "not_found"   # owner only
    assert client.delete(f"/api/me/key-limits/{grant}", headers=world["owner"]).json()["active"] is False
    assert hive.payer_for(agent, f"user:{OWNER}") == (f"user:{OWNER}", True)   # revoked: billed as before H1
    listing = client.get("/api/me/key-limits", headers=world["owner"]).json()
    assert [k["id"] for k in listing["keys"]] == ["k_0000000a"] and "secret" not in str(listing)


# ---- 4. "use my hive": a guest with a limit on the owner's keys --------------------------------------------------------

def test_use_invite_makes_a_guest_held_to_the_invite_limit(world, client):  # noqa: F811
    hive = world["hive"]
    hive.keyring.ring["defaults"]["openrouter"] = "k_0000000a"   # the owner's key is the hive's default
    view, guest = make_guest(client, hive, limit=3.0)
    assert guest["access"] == "guest" and guest["role"] == "member"
    principal = f"user:{guest['id']}"
    grant = hive.db.one("SELECT * FROM key_limits WHERE grantee = ?", (principal,))
    assert grant["owner"] == f"user:{OWNER}" and grant["key_id"] == "*" and grant["month_usd"] == 3.0
    assert grant["source"] == f"invite:{view['id']}"
    mind = hive.personal.ensure(principal)                       # option A: their own personal mind and swarm, here
    agent = hive._agent_row(mind["id"])                          # the stored row, as the model route reads it
    key_id = client.app.state.gateway.paying_key(agent, "openrouter")[0]
    assert key_id == "k_0000000a"                                # the host's key pays
    payer, own = hive.payer_for(agent, f"user:{OWNER}")
    assert (payer, own) == (principal, False)
    assert hive.budgets.paid_without_cap(agent, None, payer, own)   # their $0 personal mind runs on the grant
    spend(hive, mind["id"], payer, 2.9, key_id)
    hive.check_budget(agent, True, 0.05, key_id, payer, own)
    c, d = refused(hive.check_budget, agent, True, 0.5, key_id, payer, own)
    assert d["scope"] == grant["scope"] and d["rule"] == "invite"
    assert not any(s.startswith("person:") and o == "member-default" for s, _p, _l, o in
                   hive.budgets.applicable(agent, key_id, payer, own))   # never the member default
    me = client.get("/api/usage/me", headers=_session(client, principal)).json()
    assert me["allowance_usd"] == 3.0 and me["allowance_origin"] == "invite"
    # a guest never sees the host's keys
    assert client.get("/api/keys", headers=_session(client, principal)).json() == []
    # revoked: nothing pays for them any more
    hive.db.execute("UPDATE key_limits SET revoked_at = ? WHERE id = ?", (now(), grant["id"]))
    c, _ = refused(hive.check_budget, agent, True, 0.01, key_id, payer, own)
    assert c == "no_budget"                                      # their $0 mind has nothing to run on
    c, _ = refused(hive.budgets.check, agent, 0.01, key_id, payer, own)
    assert c == "no_key_grant"                                   # and the host's key refuses them outright


def _session(client, principal):  # noqa: F811
    import secrets
    from hive.core.app import token_hash
    token = secrets.token_urlsafe(24)
    client.app.state.hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                                 "principal": principal})
    return {"Authorization": f"Bearer {token}"}


def test_private_hides_from_a_guest_and_public_shows(world, client):  # noqa: F811
    hive = world["hive"]
    _view, guest = make_guest(client, hive)
    g = _session(client, f"user:{guest['id']}")
    sw = world["swarm"]
    assert client.get(f"/api/swarms/{sw['id']}", headers=g).status_code == 404          # private: invite only
    assert client.get(f"/api/agents/{world['mind']['id']}", headers=g).status_code == 404
    assert code(client.put(f"/api/swarms/{sw['id']}/visibility", headers=g, json={"visibility": "public"})) == "not_found"
    r = client.put(f"/api/swarms/{sw['id']}/visibility", headers=world["owner"], json={"visibility": "public", "pays": "hive-key"})
    assert r.status_code == 200 and r.json()["pays"] == "hive-key"
    assert client.get(f"/api/swarms/{sw['id']}", headers=g).status_code == 200          # public: open
    assert code(client.put(f"/api/swarms/{sw['id']}/visibility", headers=world["owner"], json={"pays": "maybe"})) == "bad_pays"


# ---- 3. public: who pays -----------------------------------------------------------------------------------------------

def test_public_pays_own_key_or_hive_key(world, client):  # noqa: F811
    hive, sw, mind = world["hive"], world["swarm"], world["mind"]
    hive.keyring.ring["defaults"]["openrouter"] = "k_0000000a"
    zed = person(client, ZED)
    hive.db.execute("UPDATE people SET access = 'public' WHERE id = ?", (ZED,))           # a public visitor
    client.put(f"/api/swarms/{sw['id']}/visibility", headers=world["owner"], json={"visibility": "public"})
    agent = dict(hive.agent(mind["id"]), options={})          # the hive's default key, as the Ask conductor uses
    payer = f"user:{ZED}"
    # public, pays own-key (the default): the owner's key may not pay for a visitor
    c, d = refused(hive.budgets.check, agent, 0.01, "k_0000000a", payer, False)
    assert c == "own_key_required" and d["pays"] == "own-key"
    # pays hive-key: the owner's key pays, under the visitor limit when the owner set one
    client.put(f"/api/swarms/{sw['id']}/visibility", headers=world["owner"], json={"pays": "hive-key"})
    hive.budgets.check(agent, 0.01, "k_0000000a", payer, False)
    client.put("/api/hive/own", headers=world["owner"], json={"visitor_month_usd": 0.5})
    c, d = refused(hive.budgets.check, agent, 0.6, "k_0000000a", payer, False)
    assert d["scope"] == f"person:{ZED}" and d["limit_usd"] == 0.5
    # private again: no grant, not public: refused
    client.put(f"/api/swarms/{sw['id']}/visibility", headers=world["owner"], json={"visibility": "private"})
    c, _ = refused(hive.budgets.check, agent, 0.01, "k_0000000a", payer, False)
    assert c == "no_key_grant"
    # the hive itself public with hive-key covers a visitor's own private mind
    client.put("/api/hive/own", headers=world["owner"], json={"visibility": "public", "pays": "hive-key"})
    zsw = client.post("/api/swarms", headers=zed, json={"name": "Zed's"}).json()
    zmind = client.post("/api/agents", headers=zed, json={"name": "Z", "kind": "omega", "swarm_id": zsw["id"]}).json()
    hive.budgets.check(hive.agent(zmind["id"]), 0.01, "k_0000000a", payer, False)
    # a legacy member is never switched or refused by any of this
    hive.budgets.check(agent, 0.01, "k_0000000a", f"user:{BOB}", False)


def test_own_key_pays_for_a_visitor_with_a_key_of_their_own(world, client):  # noqa: F811
    hive, gw = world["hive"], client.app.state.gateway
    hive.keyring.ring["defaults"]["openrouter"] = "k_0000000a"
    person(client, ZED)
    hive.db.execute("UPDATE people SET access = 'public' WHERE id = ?", (ZED,))
    zsw = hive.create_swarm("Z", owner=f"user:{ZED}")
    zmind = hive.create_agent("Z", "omega", zsw["id"], None, "", None, 0.0, None, None, f"user:{ZED}", "private", None)
    agent = hive.agent(zmind["id"])
    assert gw.paying_key(agent, "openrouter")[0] == "k_0000000a"     # no key of their own: the default (then refused)
    add_key(hive, "k_000000ee", f"user:{ZED}")
    key_id = gw.paying_key(agent, "openrouter")[0]
    assert key_id == "k_000000ee"                                     # their own key pays
    payer, own = hive.payer_for(agent, f"user:{ZED}")
    assert own is True
    hive.budgets.check(agent, 5.0, key_id, payer, own)                 # their own money: no use refusal
    # OI-13 r1.1 (the owner 2026-10-19, replacing "a legacy member's mind is never switched"): the default here is the owner's
    # own key, which may not pay for Bob, so Bob's mind is switched to his own key too
    bmind = hive.create_agent("B", "omega", world["swarm"]["id"], None, "", None, 0.0, None, None, f"user:{BOB}", "private", None)
    add_key(hive, "k_000000bb", f"user:{BOB}")
    assert gw.paying_key(hive.agent(bmind["id"]), "openrouter")[0] == "k_000000bb"


def test_public_hive_lets_a_verified_account_in_as_a_visitor(world, client):  # noqa: F811
    hive = world["hive"]
    people = hive.people
    info = {"email_verified": True, "name": "Vi"}
    with hive.db.transaction():
        assert people._enrol_public("vi@example.test", info, "sub-1") is None    # private: invite only
    client.put("/api/hive/own", headers=world["owner"], json={"visibility": "public"})
    with hive.db.transaction():
        assert people._enrol_public("vi@example.test", {"email_verified": False}, "sub-1") is None
        row = people._enrol_public("vi@example.test", info, "sub-1")
    assert row["access"] == "public" and row["role"] == "member" and row["invited_by"] == "public"


# ---- asking for a limit --------------------------------------------------------------------------------------------------

def test_ask_for_a_limit_and_the_owner_approves_adjusts_or_declines(world, client):  # noqa: F811
    hive = world["hive"]
    _view, guest = make_guest(client, hive, limit=3.0)
    principal = f"user:{guest['id']}"
    g = _session(client, principal)
    r = client.post("/api/me/limit-requests", headers=g, json={"amount_usd": 10, "note": "a bigger project"})
    assert r.status_code == 200 and r.json()["owner"] == f"user:{OWNER}" and r.json()["status"] == "pending"
    rid = r.json()["id"]
    assert code(client.post("/api/me/limit-requests", headers=g, json={"amount_usd": 12})) == "already_asked"
    assert client.get("/api/me/limit-requests", headers=world["owner"]).json()["to_decide"][0]["id"] == rid
    # only the asked owner decides
    other_admin = person(client, "u_6a6a6a6a", role="admin")
    assert code(client.post(f"/api/me/limit-requests/{rid}/decide", headers=other_admin, json={"decision": "approve"})) == "not_found"
    assert code(client.post(f"/api/me/limit-requests/{rid}/decide", headers=g, json={"decision": "approve"})) == "not_found"
    r = client.post(f"/api/me/limit-requests/{rid}/decide", headers=world["owner"], json={"decision": "adjust", "amount_usd": 6})
    assert r.status_code == 200 and r.json()["status"] == "adjusted" and r.json()["granted_usd"] == 6
    grant = hive.db.one("SELECT * FROM key_limits WHERE grantee = ? AND revoked_at IS NULL", (principal,))
    assert grant["month_usd"] == 6 and grant["source"].startswith("invite:")       # still their invite grant
    assert code(client.post(f"/api/me/limit-requests/{rid}/decide", headers=world["owner"],
                            json={"decision": "approve"})) == "already_decided"
    rid2 = client.post("/api/me/limit-requests", headers=g, json={"amount_usd": 50}).json()["id"]
    r = client.post(f"/api/me/limit-requests/{rid2}/decide", headers=world["owner"], json={"decision": "decline"})
    assert r.json()["status"] == "declined"
    assert hive.db.one("SELECT month_usd FROM key_limits WHERE id = ?", (grant["id"],))["month_usd"] == 6
    rid3 = client.post("/api/me/limit-requests", headers=g, json={"amount_usd": 8}).json()["id"]
    client.post(f"/api/me/limit-requests/{rid3}/decide", headers=world["owner"], json={"decision": "approve"})
    assert hive.db.one("SELECT month_usd FROM key_limits WHERE id = ?", (grant["id"],))["month_usd"] == 8
    # a request about a mind goes to the owner of the key that pays for it
    r = client.post("/api/me/limit-requests", headers=world["bob"], json={"amount_usd": 10, "agent_id": world["mind"]["id"]})
    assert code(r) == "not_found"                                    # Bob cannot see the private Vega: not found
    client.put(f"/api/agents/{world['mind']['id']}/visibility", headers=world["owner"], json={"visibility": "public"})
    r = client.post("/api/me/limit-requests", headers=world["bob"], json={"amount_usd": 10, "agent_id": world["mind"]["id"]})
    assert r.json()["owner"] == f"user:{OWNER}" and r.json()["key_id"] == "k_0000000a"


# ---- 5. First Light ------------------------------------------------------------------------------------------------------

def _monthly(client, headers):  # noqa: F811
    return next(i for i in client.get("/api/me/setup", headers=headers).json()["items"] if i["id"] == "monthly_limit")


def test_first_light_monthly_limit_is_your_own_or_your_invite(world, client):  # noqa: F811
    hive = world["hive"]
    m = _monthly(client, world["owner"])                    # keys of their own, no limit yet
    assert m["done"] is False and m["enforced"] is False and m["detail"]["set_route"] == "PUT /api/me/key-limits/self"
    client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 20})
    m = _monthly(client, world["owner"])
    assert m["done"] is True and m["enforced"] is True and m["detail"]["enforced_by"] == "own"
    assert m["detail"]["limit_usd"] == 20
    _view, guest = make_guest(client, hive, limit=3.0)
    g = _session(client, f"user:{guest['id']}")
    m = _monthly(client, g)
    assert m["enforced"] is True and m["detail"]["enforced_by"] == "invite" and m["detail"]["limit_usd"] == 3.0
    assert m["detail"]["ask_route"] == "POST /api/me/limit-requests" and m["detail"]["pending_request"] is None
    client.post("/api/me/limit-requests", headers=g, json={"amount_usd": 9})
    assert _monthly(client, g)["detail"]["pending_request"]["amount_usd"] == 9
    provider = next(i for i in client.get("/api/me/setup", headers=g).json()["items"] if i["id"] == "provider_key")
    assert provider["done"] is True and provider["detail"]["guest"] is True
    m = _monthly(client, world["bob"])                      # no key of their own: as before (the member default)
    assert m["detail"]["enforced_by"] == "member-default"


# ---- H1.1 (stand-in FIX-FIRST and Kimi follow-ups) -------------------------------------------------------------------

def test_h11_pre_h1_member_on_an_admins_personal_key_is_billed_as_at_base(world, client):  # noqa: F811
    """Item 3, superseded by OI-13 r1.1 (stand-in P1; the owner 2026-10-19 "everyone needs studio, they just need to use
    their own keys"): a member from before H1 chatting on an admin's personal key is no longer billed to the admin. With
    no grant the call is refused (402 own_key_needed) before anything is reserved (a grant admits it: test_key_owner_oi13_
    gateway.py). The H1.1 accounting functions below (applicable, snapshot, record_usage) are themselves unchanged."""
    hive, mind = world["hive"], world["mind"]
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{BOB}", mind["id"]))
    agent = hive._agent_row(mind["id"])
    spend(hive, mind["id"], f"user:{BOB}", 50.0, None)         # Bob's whole member default is already spent
    payer, own = hive.payer_for(agent, f"user:{OWNER}")
    assert (payer, own) == (f"user:{OWNER}", True)             # e1717db: key_owner, True (billing function unchanged)
    c, _ = refused(hive.check_budget, agent, True, 2.0, "k_0000000a", payer, own)
    assert c == "own_key_needed"                               # OI-13 r1.1: never on another person's key without a grant
    scopes = [s for s, _p, _l, _o in hive.budgets.applicable(agent, "k_0000000a", payer, own)]
    assert not any(s.startswith("person:") for s in scopes)
    labels = [s for s, _l, _sp in host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, own)]
    assert not any(s.startswith("person:") or s.startswith("keyuse:") for s in labels)
    hive.record_usage(agent, "m", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.01, "key_id": "k_0000000a"},
                      None, payer)                               # as the chat route records it
    last = hive.db.one("SELECT payer, key_grantee FROM usage ORDER BY id DESC LIMIT 1")
    assert last["payer"] == f"user:{OWNER}" and last["key_grantee"] == "self"


def test_h11_only_the_hive_owner_lets_the_hive_key_pay(world, client):  # noqa: F811
    """Item 1: pays=hive-key on a mind or swarm needs the hive owner; a visitor's own public hive-key mind spends nothing."""
    hive, sw = world["hive"], world["swarm"]
    hive.keyring.ring["defaults"]["openrouter"] = "k_0000000a"
    zed = person(client, ZED)
    hive.db.execute("UPDATE people SET access = 'public' WHERE id = ?", (ZED,))
    zsw = client.post("/api/swarms", headers=zed, json={"name": "Zed's"}).json()
    zmind = client.post("/api/agents", headers=zed, json={"name": "Z", "kind": "omega", "swarm_id": zsw["id"]}).json()
    r = client.put(f"/api/agents/{zmind['id']}/visibility", headers=zed, json={"visibility": "public", "pays": "hive-key"})
    assert code(r) == "owner_only"
    assert code(client.put(f"/api/swarms/{zsw['id']}/visibility", headers=zed, json={"pays": "hive-key"})) == "owner_only"
    other_admin = person(client, "u_7b7b7b7b", role="admin")
    assert code(client.put(f"/api/swarms/{sw['id']}/visibility", headers=other_admin, json={"pays": "hive-key"})) == "owner_only"
    assert client.put(f"/api/agents/{zmind['id']}/visibility", headers=zed,
                      json={"visibility": "public", "pays": "own-key"}).status_code == 200   # narrowing is theirs
    # a hive-key set by anyone but the hive owner (an older row, a direct write) is read as own-key at use
    hive.db.execute("UPDATE agents SET pays = 'hive-key', pays_by = ? WHERE id = ?", (f"user:{ZED}", zmind["id"]))
    c, _ = refused(hive.budgets.check, hive._agent_row(zmind["id"]), 0.01, "k_0000000a", f"user:{ZED}", False)
    assert c == "own_key_required"
    r = client.put(f"/api/agents/{zmind['id']}/visibility", headers=world["owner"], json={"pays": "hive-key"})
    assert r.status_code == 200 and r.json()["pays"] == "hive-key"
    hive.budgets.check(hive._agent_row(zmind["id"]), 0.01, "k_0000000a", f"user:{ZED}", False)   # the owner said so


def test_h11_a_limit_made_later_counts_calls_admitted_before_it(world, client):  # noqa: F811
    """Item 2: reserve, then make a limit, then reserve again: the second sees the first; revoke and remake likewise."""
    hive, mind = world["hive"], world["mind"]
    from hive.core.cost_reservations import Reservations
    res = Reservations(hive.db)
    payer = f"user:{OWNER}"
    snap = lambda: host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, True)   # noqa: E731
    subjects = lambda: host_subjects(hive, mind["id"], "k_0000000a", payer, True)     # noqa: E731
    res.reserve("h1", {"a": 1}, 0.8, snap, {"agent": mind["id"]}, subjects=subjects())   # no limit yet
    first = client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0}).json()["id"]
    with pytest.raises(ValueError, match="Shared budget exhausted: keyuse:"):
        res.reserve("h2", {"a": 2}, 0.8, snap, {"agent": mind["id"]}, subjects=subjects())
    client.delete(f"/api/me/key-limits/{first}", headers=world["owner"])
    again = client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0}).json()["id"]
    assert again != first and sc(hive, again) == sc(hive, first)
    with pytest.raises(ValueError, match="Shared budget exhausted: keyuse:"):
        res.reserve("h3", {"a": 3}, 0.8, snap, {"agent": mind["id"]}, subjects=subjects())


def test_h11_claim_recovers_a_hive_whose_owner_cannot_act(world, client):  # noqa: F811
    """Item 4: demotion is never blocked; an enabled admin (or the operator, naming one) claims, logged."""
    hive = world["hive"]
    other_admin = person(client, "u_8c8c8c8c", role="admin")
    assert code(client.post("/api/hive/own/claim", headers=other_admin, json={})) == "owner_present"
    assert client.patch(f"/api/people/{OWNER}", json={"disabled": True}).status_code == 200   # admin powers unchanged
    assert code(client.post("/api/hive/own/claim", headers=world["bob"], json={})) == "admin_only"
    assert code(client.post("/api/hive/own/claim", headers=other_admin, json={"to": f"user:{BOB}"})) == "admin_only"
    r = client.post("/api/hive/own/claim", headers=other_admin, json={})
    assert r.status_code == 200 and r.json()["owner"] == "user:u_8c8c8c8c" and r.json()["via"] == "claimed"
    log = hive.db.one("SELECT * FROM hive_owner_log")
    assert log["previous"] == f"user:{OWNER}" and log["by"] == "user:u_8c8c8c8c" and log["reason"] == "previous owner disabled"
    # the operator hands a stranded hive to a named enabled admin
    client.patch("/api/people/u_8c8c8c8c", json={"role": "member"})
    assert code(client.post("/api/hive/own/claim", json={})) == "bad_request"   # the operator must name an admin
    third = person(client, "u_9d9d9d9d", role="admin")
    assert client.post("/api/hive/own/claim", json={"to": "user:u_9d9d9d9d"}).json()["owner"] == "user:u_9d9d9d9d"
    assert client.put("/api/hive/own", headers=third, json={"pays": "hive-key"}).status_code == 200


def test_h11_ask_turn_and_session_spend_counts_under_the_key_limit(world, client):  # noqa: F811
    """Kimi P2: usage recorded for a pre-H1 person's Ask turn on the owner's key (payer = that person, own_key False, as
    the conductor records) counts under the owner's own limit; a granted person's under their grant."""
    hive, mind = world["hive"], world["mind"]
    limit = client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0}).json()
    agent = hive._agent_row(mind["id"])
    hive.record_usage(agent, "m", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.7, "key_id": "k_0000000a"},
                      None, f"user:{BOB}")                       # the conductor's payer: the asker
    assert hive.db.one("SELECT key_grantee FROM usage ORDER BY id DESC LIMIT 1")["key_grantee"] == "self"
    assert abs(hive.ownhive.spent(sc(hive, limit["id"])) - 0.7) < 1e-9
    c, d = refused(hive.budgets.check, agent, 0.5, "k_0000000a", f"user:{BOB}", False)
    assert d["scope"] == sc(hive, limit["id"])
    grant = client.post("/api/me/key-limits/grants", headers=world["owner"],
                        json={"grantee": f"user:{BOB}", "month_usd": 5}).json()
    hive.record_usage(agent, "m", {"prompt_tokens": 1, "completion_tokens": 1, "cost_usd": 0.4, "key_id": "k_0000000a"},
                      None, f"user:{BOB}")
    assert hive.db.one("SELECT key_grantee FROM usage ORDER BY id DESC LIMIT 1")["key_grantee"] == f"user:{BOB}"
    assert abs(hive.ownhive.spent(sc(hive, grant["id"])) - 0.4) < 1e-9


def test_h11_decide_keeps_a_grants_source_and_use_invites_need_a_limit(world, client):  # noqa: F811
    hive = world["hive"]
    g = client.post("/api/me/key-limits/grants", headers=world["owner"], json={"grantee": f"user:{BOB}", "month_usd": 2}).json()
    assert g["source"] == "owner"
    rid = client.post("/api/me/limit-requests", headers=world["bob"], json={"amount_usd": 4}).json()["id"]
    client.post(f"/api/me/limit-requests/{rid}/decide", headers=world["owner"], json={"decision": "approve"})
    row = hive.db.one("SELECT month_usd, source FROM key_limits WHERE id = ?", (g["id"],))
    assert row["month_usd"] == 4 and row["source"] == "owner"   # Kimi P3: the provenance stays
    # a stored use invitation with no limit is refused at acceptance, never a silent $0 grant
    from hive.core.people import SignInError
    view, _ = hive.people.invite("nolimit@example.test", "N", "member", 7, by=f"user:{OWNER}", kind="use", limit_usd=1)
    hive.db.execute("UPDATE invites SET limit_usd = NULL WHERE id = ?", (view["id"],))
    with pytest.raises(SignInError) as e:
        hive.people.accept_invite_for_verified_email("nolimit@example.test", "N")
    assert e.value.code == "invite_unavailable"
    assert code(client.post("/api/invites", headers=world["owner"], json={"email": "q@example.test", "kind": "use"})) == "bad_limit"


def test_h11_owner_routes_refuse_before_reading_the_body(world, client):  # noqa: F811
    """Kimi P3: owner and key-owner routes are gated at route level, before the body is read or validated."""
    other_admin = person(client, "u_aeaeaeae", role="admin")
    r = client.put("/api/hive/own", headers=other_admin, content=b"not json", )
    assert r.status_code == 403 and code(r) == "owner_only"
    hive = world["hive"]
    import secrets
    from hive.core.app import token_hash
    token = secrets.token_urlsafe(24)   # a session that is not a named person (a family principal)
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": "user:fam"})
    fam = {"Authorization": f"Bearer {token}"}
    for method, path in (("put", "/api/me/key-limits/self"), ("post", "/api/me/key-limits/grants"),
                         ("delete", "/api/me/key-limits/kl_00000000")):
        r = getattr(client, method)(path, headers=fam) if method == "delete" else getattr(client, method)(path, headers=fam, content=b"x")
        assert r.status_code == 403 and code(r) == "key_owner_only", (path, r.text)


# ---- H1.2: holds from before the upgrade -----------------------------------------------------------------------------

def _base_hold(hive, rid, state, mind_id, payer, key_id, usd=0.8, metadata=True):
    """A hold exactly as the base version (e1717db) left it: its row, details and the subjects it recorded (hive, mind,
    the paying person when not on their own key, the key), no key-limit scope."""
    import json as _json
    hive.db.execute("INSERT INTO cost_reservations (id, binding, maximum, state, reserved_at) VALUES (?, ?, ?, ?, ?)",
                    (rid, "b-" + rid, int(usd * 1_000_000), state, time.time()))
    meta = {"agent": mind_id, "model": "openrouter/test/vega", "payer": payer, "key": key_id, "payload_hash": "x"}
    hive.db.execute("INSERT INTO cost_reservation_details (reservation, metadata) VALUES (?, ?)",
                    (rid, _json.dumps(meta) if metadata else "not json"))
    for subject in ("hive", f"agent:{mind_id}", f"key:{key_id}"):
        hive.db.execute("INSERT INTO cost_reservation_subjects (reservation, subject) VALUES (?, ?)", (rid, subject))


def _restart(client):  # noqa: F811
    """A new process on the same data directory (create_app runs the startup upgrade); no lifespan, nothing served."""
    from hive.core.app import create_app
    from hive.tests.test_core_api import FakeSupervisor
    return create_app(client.app.state.hive.settings, supervisor=FakeSupervisor(), reconcile_seconds=0).state.hive


@pytest.mark.parametrize("state", ["reserved", "dispatched", "unknown"])
def test_h12_upgrade_gives_open_base_holds_their_key_scopes(world, client, state):  # noqa: F811
    """Stand-in H1.1 P1: a base-version $0.80 hold (any open state) is counted by a $1 key limit made after the upgrade,
    so a second $0.80 is refused, never $1.60 against $1."""
    hive, mind = world["hive"], world["mind"]
    from hive.core.cost_reservations import Reservations
    payer = f"user:{OWNER}"
    _base_hold(hive, "base-1", state, mind["id"], payer, "k_0000000a")
    fresh = _restart(client)                                    # the upgrade runs at startup
    subjects = {r["subject"] for r in fresh.db.all("SELECT subject FROM cost_reservation_subjects WHERE reservation = 'base-1'")}
    assert set(fresh.ownhive.subjects("k_0000000a", payer)) <= subjects   # the same rule as a new reservation
    client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0})
    res = Reservations(hive.db)
    snap = lambda: host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, True)   # noqa: E731
    with pytest.raises(ValueError, match="Shared budget exhausted: keyuse:"):
        res.reserve("new-1", {"a": 1}, 0.8, snap, {"agent": mind["id"]},
                    subjects=host_subjects(hive, mind["id"], "k_0000000a", payer, True))
    assert _restart(client).ownhive.backfill_hold_scopes() == (0, 0)                       # idempotent


def test_h12_unreadable_base_holds_count_against_every_scope(world, client):  # noqa: F811
    hive, mind = world["hive"], world["mind"]
    from hive.core.cost_reservations import Reservations
    _base_hold(hive, "base-2", "unknown", mind["id"], f"user:{OWNER}", "k_0000000a", metadata=False)
    assert hive.ownhive.backfill_hold_scopes() == (1, 1)
    assert hive.db.one("SELECT 1 FROM cost_reservation_subjects WHERE reservation = 'base-2' AND subject = '*'")
    client.post("/api/me/key-limits/grants", headers=world["owner"], json={"grantee": f"user:{BOB}", "month_usd": 1.0})
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{BOB}", mind["id"]))
    payer = f"user:{BOB}"
    snap = lambda: host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, False)   # noqa: E731
    with pytest.raises(ValueError, match="Shared budget exhausted: keyuse:"):           # even Bob's grant counts it
        Reservations(hive.db).reserve("new-2", {"a": 2}, 0.8, snap, {"agent": mind["id"]},
                                      subjects=host_subjects(hive, mind["id"], "k_0000000a", payer, False))


def test_h12_a_grant_made_while_a_call_is_held_counts_it(world, client):  # noqa: F811
    """Conservative subjects: a pre-H1 person's hold (the owner's own scope) is also in that person's scope, so a grant
    made afterwards counts it."""
    hive, mind = world["hive"], world["mind"]
    from hive.core.cost_reservations import Reservations
    res = Reservations(hive.db)
    hive.db.execute("UPDATE agents SET owner = ? WHERE id = ?", (f"user:{BOB}", mind["id"]))
    bob = f"user:{BOB}"
    snap = lambda: host_budget_snapshot(hive, mind["id"], "k_0000000a", bob, False)   # noqa: E731
    subjects = lambda: host_subjects(hive, mind["id"], "k_0000000a", bob, False)     # noqa: E731
    res.reserve("g1", {"a": 1}, 0.8, snap, {"agent": mind["id"]}, subjects=subjects())   # legacy: the owner's scope
    client.post("/api/me/key-limits/grants", headers=world["owner"], json={"grantee": bob, "month_usd": 1.0})
    with pytest.raises(ValueError, match="Shared budget exhausted: keyuse:"):
        res.reserve("g2", {"a": 2}, 0.8, snap, {"agent": mind["id"]}, subjects=subjects())


# ---- H1.3: startup never stops on a bad hold; env keys are the hive owner's ------------------------------------------

def _raw_hold(hive, rid, raw, state="unknown", usd=0.8):
    hive.db.execute("INSERT INTO cost_reservations (id, binding, maximum, state, reserved_at) VALUES (?, ?, ?, ?, ?)",
                    (rid, "b-" + rid, int(usd * 1_000_000), state, time.time()))
    hive.db.execute("INSERT INTO cost_reservation_details (reservation, metadata) VALUES (?, ?)", (rid, raw))
    hive.db.execute("INSERT INTO cost_reservation_subjects (reservation, subject) VALUES (?, 'hive')", (rid,))


def _second_hold_refused(client, world):  # noqa: F811
    from hive.core.cost_reservations import Reservations
    hive, mind = world["hive"], world["mind"]
    payer = f"user:{OWNER}"
    client.put("/api/me/key-limits/self", headers=world["owner"], json={"month_usd": 1.0})
    snap = lambda: host_budget_snapshot(hive, mind["id"], "k_0000000a", payer, True)   # noqa: E731
    with pytest.raises(ValueError, match="Shared budget exhausted: keyuse:"):
        Reservations(hive.db).reserve("next", {"a": 1}, 0.8, snap, {"agent": mind["id"]},
                                      subjects=host_subjects(hive, mind["id"], "k_0000000a", payer, True))


BAD = {
    "embeddings-list-key": '{"payer": "user:u_00000002", "kind": "embeddings", "key": ["bad"]}',
    "embeddings-dict-key": '{"payer": "user:u_00000002", "kind": "embeddings", "key": {"k": 1}}',
    "int-key": '{"payer": "user:u_00000002", "key": 7}',
    "garbage-key": '{"payer": "user:u_00000002", "key": "not a key id"}',
    "list-payer": '{"payer": ["user:u_00000002"], "key": "k_0000000a"}',
    "dict-payer": '{"payer": {"p": 1}, "key": "k_0000000a"}',
    "no-key-recorded": '{"payer": "user:u_00000002", "kind": "chat"}',
    "json-list": '["payer", "key"]',
    "not-json": "{nope",
}


@pytest.mark.parametrize("case", sorted(BAD))
def test_h13_a_malformed_hold_never_stops_startup_and_stays_counted(world, client, case):  # noqa: F811
    hive = world["hive"]
    _raw_hold(hive, "bad-1", BAD[case])
    fresh = _restart(client)                                    # the hive starts
    assert fresh.db.one("SELECT 1 FROM cost_reservation_subjects WHERE reservation = 'bad-1' AND subject = '*'")
    _second_hold_refused(client, world)                         # and the $0.80 is still counted by a $1 limit


def test_h13_a_failing_upgrade_still_starts_and_counts_open_holds(world, client, monkeypatch):  # noqa: F811
    from hive.core.ownhive import OwnHive
    hive = world["hive"]
    _raw_hold(hive, "bad-2", '{"payer": "user:u_00000002", "key": "k_0000000a"}', state="reserved")

    def boom(self):
        raise RuntimeError("upgrade failed")
    monkeypatch.setattr(OwnHive, "backfill_hold_scopes", boom)
    _restart(client)
    assert hive.db.one("SELECT 1 FROM cost_reservation_subjects WHERE reservation = 'bad-2' AND subject = '*'")
    _second_hold_refused(client, world)


def test_h13_env_key_holds_and_spend_belong_to_the_hive_owner_even_unlisted(world, client):  # noqa: F811
    """Kimi's probe: a base hold on env:<provider> that the providers map no longer lists still gets the hive owner's
    '*' own scope (held), and settled spend on it counts in that scope too (spent): no asymmetry at admission."""
    hive, mind = world["hive"], world["mind"]
    payer = f"user:{OWNER}"
    assert "goneprov" not in (hive.settings.providers or {})
    _raw_hold(hive, "env-1", '{"agent": "%s", "payer": "%s", "key": "env:goneprov"}' % (mind["id"], payer), state="dispatched")
    _restart(client)
    subjects = {r["subject"] for r in hive.db.all("SELECT subject FROM cost_reservation_subjects WHERE reservation = 'env-1'")}
    assert set(hive.ownhive.subjects("env:goneprov", payer)) <= subjects and "*" not in subjects
    _second_hold_refused(client, world)
    limit = hive.db.one("SELECT scope FROM key_limits WHERE grantee = 'self' AND key_id = '*' AND revoked_at IS NULL")
    spend(hive, mind["id"], payer, 0.3, "env:goneprov")
    assert abs(hive.ownhive.spent(limit["scope"]) - 0.3) < 1e-9
    spend(hive, mind["id"], payer, 0.2, "k_000000bb")           # a key no longer in the ring: the hive owner's too
    assert abs(hive.ownhive.spent(limit["scope"]) - 0.5) < 1e-9
    add_key(hive, "k_000000cc", f"user:{BOB}")                   # another person's key is never the owner's
    spend(hive, mind["id"], payer, 0.4, "k_000000cc")
    assert abs(hive.ownhive.spent(limit["scope"]) - 0.5) < 1e-9


def test_h13_a_hold_whose_scopes_cannot_be_worked_out_is_counted_everywhere(world, client, monkeypatch):  # noqa: F811
    """Defence in depth: valid-looking metadata whose subjects raise (any unforeseen failure) is '*', and startup goes on."""
    from hive.core.ownhive import OwnHive
    hive = world["hive"]
    _raw_hold(hive, "bad-3", '{"payer": "user:u_00000002", "key": "k_0000000a"}', state="dispatched")
    _raw_hold(hive, "good-3", '{"payer": "user:%s", "key": "k_0000000a"}' % OWNER, state="dispatched", usd=0.01)
    real = OwnHive.subjects

    def flaky(self, key_id, payer):
        if payer == "user:u_00000002":
            raise TypeError("unforeseen")
        return real(self, key_id, payer)
    monkeypatch.setattr(OwnHive, "subjects", flaky)
    _restart(client)
    assert hive.db.one("SELECT 1 FROM cost_reservation_subjects WHERE reservation = 'bad-3' AND subject = '*'")
    good = {r["subject"] for r in hive.db.all("SELECT subject FROM cost_reservation_subjects WHERE reservation = 'good-3'")}
    assert "*" not in good and any(x.startswith("keyuse:") for x in good)   # one bad row never costs the others theirs
    monkeypatch.setattr(OwnHive, "subjects", real)
    _second_hold_refused(client, world)
