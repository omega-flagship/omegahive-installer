"""Purpose: tests that a cap on a mind or a swarm is set and removed only by its owner, and every other limit only by a
hive admin, the routes and the flags the UI reads alike, as the limit law decides (Jon on #615, 21 Nov: "No admin
controls another user"; on #256, 23 Nov: a cap on a mind is set only by that mind's owner, not by an admin over someone
else's mind). INVENTED people and minds."""
import inspect
import re

from fastapi.routing import APIRoute

from hive.core.limit_policy import LimitPolicy
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def world(client):
    """Ann, a member, owns a public swarm and a public mind in it; Jon is an admin; Bob, another member, sees both."""
    ann, jon, bob = person(client, "u_ann"), person(client, "u_jon", role="admin"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's", "visibility": "public"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Wren", "kind": "module", "swarm_id": sw["id"]}).json()
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"visibility": "public"}).status_code == 200
    return ann, jon, bob, sw, mind


def refused(r):
    return r.status_code, r.json()["error"]["code"]


def test_only_a_minds_or_swarms_owner_sets_or_removes_its_cap(client):
    ann, jon, bob, sw, mind = world(client)
    for scope in (f"agent:{mind['id']}", f"swarm:{sw['id']}"):
        rule = {"scope": scope, "period": "month", "limit_usd": 5}
        for other in (jon, bob):                       # an admin over someone else's, and a member who only sees it
            assert refused(client.post("/api/budgets", headers=other, json=rule)) == (403, "owner_only")
        made = client.post("/api/budgets", headers=ann, json=rule)
        assert made.status_code == 200, made.text
        for other in (jon, bob):
            assert refused(client.delete(f"/api/budgets/{made.json()['id']}", headers=other)) == (403, "owner_only")
        assert client.delete(f"/api/budgets/{made.json()['id']}", headers=ann).status_code == 200
    # an admin caps their own mind as any owner does
    own = client.post("/api/agents", json={"name": "Hollis", "kind": "module", "swarm_id": sw["id"]}).json()
    assert client.post("/api/budgets", json={"scope": f"agent:{own['id']}", "period": "day", "limit_usd": 1}).status_code == 200


def test_a_cap_on_a_mind_the_person_does_not_see_is_not_found(client):
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's own"}).json()           # private
    mind = client.post("/api/agents", headers=ann, json={"name": "Quiet", "kind": "module", "swarm_id": sw["id"]}).json()
    for scope in (f"agent:{mind['id']}", f"swarm:{sw['id']}", "agent:a_00000000"):
        rule = {"scope": scope, "period": "month", "limit_usd": 5}
        assert refused(client.post("/api/budgets", headers=bob, json=rule)) == (404, "not_found")


def test_every_other_limit_stays_a_hive_admins(client):
    ann, jon, bob, sw, mind = world(client)
    person(client, "u_" + "a" * 32)                        # a person a person:<id> scope can name
    for scope in ("hive", "every-mind", "person:u_" + "a" * 32):
        rule = {"scope": scope, "period": "month", "limit_usd": 50}
        assert refused(client.post("/api/budgets", headers=ann, json=rule)) == (403, "admin_only")
        made = client.post("/api/budgets", headers=jon, json=rule)
        assert made.status_code == 200, made.text
        assert refused(client.delete(f"/api/budgets/{made.json()['id']}", headers=ann)) == (403, "admin_only")
        assert client.delete(f"/api/budgets/{made.json()['id']}", headers=jon).status_code == 200


def test_only_the_owner_changes_a_minds_own_cap(client):
    ann, jon, bob, sw, mind = world(client)
    hive = client.app.state.hive
    assert refused(client.patch(f"/api/agents/{mind['id']}", headers=jon, json={"budget_usd": 3})) == (403, "owner_only")
    # an admin still edits the rest of someone else's mind, and sending back the cap it has changes nothing
    r = client.patch(f"/api/agents/{mind['id']}", headers=jon, json={"name": "Wren Two", "budget_usd": 0})
    assert r.status_code == 200, r.text
    assert client.patch(f"/api/agents/{mind['id']}", headers=ann, json={"budget_usd": 3}).status_code == 200
    assert float(hive.agent(mind["id"])["budget_usd"]) == 3
    assert refused(client.patch(f"/api/agents/{mind['id']}", headers=jon, json={"budget_usd": 0})) == (403, "owner_only")
    assert float(hive.agent(mind["id"])["budget_usd"]) == 3


def test_the_flags_say_what_the_routes_allow(client):
    ann, jon, bob, sw, mind = world(client)
    assert client.post("/api/budgets", headers=ann, json={"scope": f"agent:{mind['id']}", "period": "month",
                                                          "limit_usd": 5}).status_code == 200
    assert client.post("/api/budgets", headers=jon, json={"scope": "hive", "period": "month", "limit_usd": 50}).status_code == 200

    def flags(headers):
        rows = {r["scope"]: r["may_change"] for r in client.get("/api/budgets", headers=headers).json()}
        minds = {a["id"]: a.get("may_cap") for a in client.get("/api/agents", headers=headers).json()}
        swarms = {s["id"]: s.get("may_cap") for s in client.get("/api/swarms", headers=headers).json()}
        return rows.get(f"agent:{mind['id']}"), rows.get("hive"), minds.get(mind["id"]), swarms.get(sw["id"])

    assert flags(ann) == (True, False, True, True)
    assert flags(jon) == (False, True, False, False)
    assert flags(bob) == (False, False, False, False)
    # the Limits page's rows and its old defaults carry the same answer: Ann's $10 is hers to remove, the admin's own his
    assert client.patch(f"/api/agents/{mind['id']}", headers=ann, json={"budget_usd": 10}).status_code == 200
    own = client.post("/api/agents", json={"name": "Hollis", "kind": "module", "swarm_id": sw["id"], "budget_usd": 10}).json()
    view = client.get("/api/budgets/limits").json()
    assert {r["scope"]: r["may_change"] for r in view["caps"]}[f"agent:{mind['id']}"] is False
    assert {o["agent_id"]: o["may_change"] for o in view["old_defaults"] if o["kind"] == "mind"} == {mind["id"]: False,
                                                                                                    own["id"]: True}


def test_a_cap_on_a_mind_or_swarm_made_before_owners_were_recorded_is_an_admins(client):
    ann, jon, bob, sw, mind = world(client)
    hive = client.app.state.hive
    hive.db.execute("UPDATE agents SET owner = NULL WHERE id = ?", (mind["id"],))
    hive.db.execute("UPDATE swarms SET owner = NULL WHERE id = ?", (sw["id"],))
    for scope in (f"agent:{mind['id']}", f"swarm:{sw['id']}"):
        rule = {"scope": scope, "period": "month", "limit_usd": 5}
        for other in (ann, bob):                       # Ann no longer recorded as its owner, and a member who sees it
            assert refused(client.post("/api/budgets", headers=other, json=rule)) == (403, "owner_only")
        assert client.post("/api/budgets", headers=jon, json=rule).status_code == 200


def test_the_routes_and_flags_answer_what_the_law_says(client):
    """The host enforces the limit law's verdict and adds no rule of its own: a law refusing everything refuses Ann her
    own mind's cap and flags it so, and its refusal word picks the route's answer."""
    ann, jon, bob, sw, mind = world(client)
    hive = client.app.state.hive
    hive.limit_policy = LimitPolicy(lambda _query: ["(Refused owner-only)"])
    rule = {"scope": f"agent:{mind['id']}", "period": "month", "limit_usd": 5}
    assert refused(client.post("/api/budgets", headers=ann, json=rule)) == (403, "owner_only")
    patched = client.patch(f"/api/agents/{mind['id']}", headers=ann, json={"budget_usd": 3})
    assert refused(patched) == (403, "owner_only")
    assert {a["id"]: a.get("may_cap") for a in client.get("/api/agents", headers=ann).json()}[mind["id"]] is False
    hive.limit_policy = LimitPolicy(lambda _query: ["(Refused admin-only)"])
    assert refused(client.post("/api/budgets", headers=jon, json={"scope": "hive", "period": "month",
                                                                  "limit_usd": 50})) == (403, "admin_only")


# Every route whose handler reads a budget or a limit from its body or writes a budget rule, with the check that keeps
# a cap on a person's mind or swarm theirs (Jon on #704: a test listing them keeps a new one from skipping cap_refusal).
CAP_WRITERS = {
    ("POST", "/api/budgets"): "limit_refusal",               # a rule on any scope
    ("DELETE", "/api/budgets/{rule_id}"): "limit_refusal",
    ("PATCH", "/api/agents/{agent_id}"): "cap_refusal",      # a changed budget_usd
    ("POST", "/api/agents"): "its creator's",                # a new mind, owned by whoever makes it
    ("POST", "/api/keys"): "a key's",                        # a limit on the person's own key, not a mind or a swarm
    ("PUT", "/api/me/key-limits/self"): "a key's",
    ("POST", "/api/invites"): "a key's",                     # a use invitation's limit on the inviter's own key
}
WRITES_A_LIMIT = re.compile(r"budget_usd|limit_usd|month_usd|cap_usd|budgets\.(?:set|remove)\(")


def test_every_route_that_writes_a_cap_is_listed_with_its_check(client):
    found = {}
    for route in client.app.routes:
        if isinstance(route, APIRoute):
            source = inspect.getsource(route.endpoint)
            if WRITES_A_LIMIT.search(source):
                found.update({(method, route.path): source for method in route.methods})
    assert set(found) == set(CAP_WRITERS)
    for key, check in CAP_WRITERS.items():
        if check.endswith("_refusal"):
            assert check + "(" in found[key], key
    # a new mind's cap is its creator's own: an admin can't make a capped mind owned by someone else
    ann, jon, bob, sw, mind = world(client)
    made = client.post("/api/agents", headers=jon, json={"name": "Teal", "kind": "module", "swarm_id": sw["id"],
                                                         "budget_usd": 3, "owner": "user:u_ann"}).json()
    assert client.app.state.hive.agent(made["id"])["owner"] == "user:u_jon"
