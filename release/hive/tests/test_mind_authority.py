# Purpose: who may act on a mind, answer its approvals and write its rules, route by route, against the real app
# (flagship #111: item 2, and "members can delete, stop or edit any mind they can see").
"""One rule decides who acts on a mind (visibility.Viewer.controls): a hive admin or the mind's owner. Seeing a mind,
because it is public or shared with you, lets you see it and talk to it, never act on it. Each route that acts on a
mind is tried by its owner, an admin, a person who sees it and one who does not."""

import pytest

from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_phase2_api import authorize
from hive.tests.test_member_rules_p3c import person   # a current sign-in session (a future expiry), as personhood needs

WRITE = '(write-file "x.txt" "y")'


def public_mind(client, headers, name="Ada"):
    """A public mind in a public swarm, both owned by whoever ``headers`` signs in: every signed-in person sees it."""
    sw = client.post("/api/swarms", headers=headers, json={"name": f"{name}'s", "visibility": "public"}).json()
    mind = client.post("/api/agents", headers=headers,
                       json={"name": name, "swarm_id": sw["id"], "visibility": "public"}).json()
    assert mind["owner"] == client.app.state.hive.db.one("SELECT owner FROM agents WHERE id = ?", (mind["id"],))["owner"]
    return mind


def people(client):
    """Ann owns a public mind and a private one; Bob, a member, sees only the public one; Carl, a member, has the
    private one shared with him; Jon is an admin person."""
    ann, bob, carl, jon = (person(client, "u_ann"), person(client, "u_bob"), person(client, "u_carl"),
                           person(client, "u_jon", "admin"))
    public = public_mind(client, ann, "Ada")
    private = client.post("/api/agents", headers=ann, json={"name": "Bea", "swarm_id": public["swarm_id"]}).json()
    shared = client.post("/api/agents", headers=ann, json={"name": "Cy", "swarm_id": public["swarm_id"]}).json()
    assert client.put(f"/api/agents/{shared['id']}/visibility", headers=ann,
                      json={"visibility": "shared", "shared_with": ["user:u_carl"]}).status_code == 200
    return {"ann": ann, "bob": bob, "carl": carl, "jon": jon, "public": public, "private": private, "shared": shared}


def refused(response, status, code):
    assert response.status_code == status and response.json()["error"]["code"] == code, response.text


# ---- acting on a mind --------------------------------------------------------------------------------------------

def test_the_rule_is_an_admin_the_owner_or_the_minds_person():
    from hive.core.visibility import Viewer
    ann, bob, jon = Viewer("user:u_ann", False), Viewer("user:u_bob", False), Viewer("user:u_jon", True)
    public = {"owner": "user:u_ann", "personal_of": None, "visibility": "public", "shared_with": "[]"}
    shared = dict(public, visibility="shared", shared_with='["user:u_bob"]')
    assert ann.controls(public) and jon.controls(public)
    assert bob.sees(public) and not bob.controls(public)              # seeing a public mind is not acting on it
    assert bob.sees(shared) and not bob.controls(shared)              # nor is having it shared with you
    assert bob.controls({"owner": None, "personal_of": "user:u_bob"})  # a personal mind is its person's
    assert not bob.controls({"owner": None, "personal_of": None}) and jon.controls({"owner": None})  # ownerless: admins
    assert not Viewer(None, False).controls({"owner": None})          # the default principal never matches no owner
    assert not jon.controls(None)                                     # nothing there, nothing to act on


# (method, path under /api/agents/{id}, body): every route that acts on a mind, each tried four ways below
ACTS = [
    ("patch", "", {"name": "Renamed"}),
    ("post", "/start", None),
    ("post", "/sleep", None),
    ("post", "/wake", None),
    ("post", "/stop", None),
    ("post", "/memory/reset", None),
    ("post", "/memory/beliefs/retire", {"atom": "(--> a b)"}),
    ("put", "/visibility", {"visibility": "private"}),
    ("post", "/export", None),
    ("post", "/settle", {"to_hive": "h", "to_name": "x", "manifest_sha256": "0" * 64}),
    ("delete", "", None),
]


def act(client, method, mind_id, suffix, body, headers):
    kwargs = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    return getattr(client, method)(f"/api/agents/{mind_id}{suffix}", **kwargs)


@pytest.mark.parametrize("method,suffix,body", ACTS, ids=[f"{m} {s or '/'}" for m, s, _ in ACTS])
def test_a_person_who_sees_a_mind_but_does_not_own_it_cannot_act_on_it(client, method, suffix, body):
    w = people(client)
    hive = client.app.state.hive
    before = hive.db.one("SELECT name, status, desired, deleted, visibility FROM agents WHERE id = ?", (w["public"]["id"],))
    refused(act(client, method, w["public"]["id"], suffix, body, w["bob"]), 403, "owner_only")      # public: Bob sees it
    refused(act(client, method, w["shared"]["id"], suffix, body, w["carl"]), 403, "owner_only")    # shared with Carl
    refused(act(client, method, w["private"]["id"], suffix, body, w["bob"]), 404, "not_found")     # existence hidden
    assert hive.db.one("SELECT name, status, desired, deleted, visibility FROM agents WHERE id = ?",
                       (w["public"]["id"],)) == before
    assert hive.db.all("SELECT * FROM control_ops WHERE agent_id = ?", (w["public"]["id"],)) == []   # memory untouched


def authority_refusal(response):
    """Whether a route refused who was asking (signed out, not theirs, not seen), not what they asked for."""
    if response.status_code in (401, 403):
        return True
    return response.status_code == 404 and response.json()["error"]["message"] in ("no such mind", "no such agent")


@pytest.mark.parametrize("method,suffix,body", ACTS, ids=[f"{m} {s or '/'}" for m, s, _ in ACTS])
def test_the_owner_and_an_admin_still_act_on_a_mind(client, method, suffix, body):
    w = people(client)
    for who, mind in ((w["ann"], w["public"]), (w["jon"], w["private"]), ({}, w["shared"])):   # owner, admin, operator
        r = act(client, method, mind["id"], suffix, body, who)
        assert not authority_refusal(r), (suffix, r.text)   # past authority; the action's own rules decide the rest


def test_the_flags_say_who_may_act_and_match_the_routes(client):
    w = people(client)
    for headers, mind, may in ((w["ann"], w["public"], True), (w["jon"], w["public"], True), (w["bob"], w["public"], False),
                               (w["carl"], w["shared"], False), ({}, w["shared"], True)):
        one = client.get(f"/api/agents/{mind['id']}", headers=headers).json()
        listed = next(a for a in client.get("/api/agents", headers=headers).json() if a["id"] == mind["id"])
        for view in (one, listed):
            assert (view["may_control"], view["may_sleep"]) == (may, may), (headers, mind["name"])
        r = client.post(f"/api/agents/{mind['id']}/sleep", headers=headers)
        assert (r.status_code not in (403, 404)) == may, r.text


def test_a_personal_mind_is_its_persons_and_an_admin_may_still_delete_it(client):
    w = people(client)
    mine = client.get("/api/me/mind", headers=w["ann"]).json()
    mind_id = (mine.get("mind") or mine)["id"]
    refused(client.post(f"/api/agents/{mind_id}/stop", headers=w["bob"]), 404, "not_found")   # private to Ann
    assert client.post(f"/api/agents/{mind_id}/stop", headers=w["ann"]).status_code == 200
    assert client.delete(f"/api/agents/{mind_id}", headers=w["jon"]).status_code == 200


def test_only_an_admin_stops_every_mind(client):
    w = people(client)
    hive = client.app.state.hive
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake' WHERE id = ?", (w["public"]["id"],))
    for member in (w["bob"], w["ann"]):
        refused(client.post("/api/hive/stop-all", headers=member, json={}), 403, "admin_only")
    assert hive.db.one("SELECT desired FROM agents WHERE id = ?", (w["public"]["id"],))["desired"] == "awake"
    assert client.post("/api/hive/stop-all", headers=w["jon"], json={}).status_code == 200
    assert hive.db.one("SELECT desired FROM agents WHERE id = ?", (w["public"]["id"],))["desired"] == "stopped"


# ---- answering a mind's approvals --------------------------------------------------------------------------------

ANSWERS = [("approve", {}), ("approve", {"remember": True}), ("deny", None), ("decide", {"decision": "once"}),
           ("decide", {"decision": "no"}), ("decide", {"decision": "always"}),
           ("decide", {"decision": "for", "minutes": 5}), ("decide", {"decision": "never"})]


def answer(client, approval_id, how, body, headers):
    kwargs = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    return client.post(f"/api/approvals/{approval_id}/{how}", **kwargs)


@pytest.mark.parametrize("how,body", ANSWERS, ids=[f"{h} {b}" for h, b in ANSWERS])
def test_only_the_minds_owner_or_an_admin_answers_its_approvals(client, how, body):
    w = people(client)
    hive = client.app.state.hive
    for headers, mind, status, code in ((w["bob"], w["public"], 403, "owner_only"), (w["carl"], w["shared"], 403, "owner_only"),
                                        (w["bob"], w["private"], 404, "not_found")):
        pending = authorize(client, mind, WRITE)["approval_id"]
        refused(answer(client, pending, how, body, headers), status, code)
        assert hive.db.one("SELECT status FROM approvals WHERE id = ?", (pending,))["status"] == "pending"
    assert hive.db.all("SELECT * FROM policy_rules WHERE origin = 'answer'") == []
    for headers, mind in ((w["ann"], w["public"]), (w["jon"], w["public"]), ({}, w["shared"])):   # owner, admins
        pending = authorize(client, mind, f'(write-file "{len(hive.db.all("SELECT id FROM approvals"))}.txt" "y")')
        r = answer(client, pending["approval_id"], how, body, headers)
        assert r.status_code == 200 and r.json()["status"] in ("approved", "denied"), r.text
        hive.db.execute("DELETE FROM policy_rules WHERE origin = 'answer'")   # so the next request asks again


def test_the_approval_list_says_who_may_answer_and_anyone_who_sees_reads_the_track_record(client):
    w = people(client)
    pending = authorize(client, w["public"], WRITE)["approval_id"]
    hidden = authorize(client, w["private"], WRITE)["approval_id"]
    for headers, may in ((w["ann"], True), (w["jon"], True), ({}, True), (w["bob"], False), (w["carl"], False)):
        listed = {a["id"]: a for a in client.get("/api/approvals", headers=headers).json()}
        assert listed[pending]["may_answer"] is may
        assert client.get(f"/api/approvals/{pending}/track-record", headers=headers).status_code == 200
    assert hidden not in {a["id"] for a in client.get("/api/approvals", headers=w["bob"]).json()}
    refused(client.get(f"/api/approvals/{hidden}/track-record", headers=w["bob"]), 404, "not_found")


def test_an_owner_only_mind_is_answered_by_its_owner_alone(client):
    w = people(client)
    mind = w["public"]
    assert client.patch(f"/api/agents/{mind['id']}", headers=w["ann"],
                        json={"options": {"approvals": "owner_only"}}).status_code == 200
    pending = authorize(client, mind, WRITE)["approval_id"]
    listed = {a["id"]: a for a in client.get("/api/approvals", headers=w["jon"]).json()}
    assert listed[pending]["may_answer"] is False
    refused(answer(client, pending, "approve", {}, w["jon"]), 403, "approval_owner_only")
    assert answer(client, pending, "approve", {}, w["ann"]).json()["status"] == "approved"


# ---- writing rules (closed on dev/latest, so on #82's head: confirmed here) ----------------------------------------

def test_a_member_writes_only_ask_or_deny_rules_on_minds_they_own_and_deletes_only_those(client):
    w = people(client)
    hive = client.app.state.hive
    own = public_mind(client, w["bob"], "Bo")
    refused(client.post("/api/policy", headers=w["bob"], json={"scope": "hive", "skill": "*", "mode": "allow"}),
            403, "admin_only")
    refused(client.post("/api/policy", headers=w["bob"], json={"scope": f"agent:{own['id']}", "skill": "*", "mode": "allow"}),
            403, "admin_only")
    refused(client.post("/api/policy", headers=w["bob"],
                        json={"scope": f"agent:{w['public']['id']}", "skill": "shell", "mode": "deny"}), 403, "owner_only")
    rule = client.post("/api/policy", headers=w["bob"], json={"scope": f"agent:{own['id']}", "skill": "shell", "mode": "deny"})
    assert rule.status_code == 200, rule.text
    admin_rule = client.post("/api/policy", json={"scope": "hive", "skill": "net*", "mode": "ask"}).json()
    assert client.delete(f"/api/policy/{admin_rule['id']}", headers=w["bob"]).status_code == 403
    assert client.delete(f"/api/policy/{rule.json()['id']}", headers=w["ann"]).status_code == 403
    assert hive.db.one("SELECT COUNT(*) AS n FROM policy_rules WHERE id IN (?, ?)", (admin_rule["id"], rule.json()["id"]))["n"] == 2
    assert client.delete(f"/api/policy/{rule.json()['id']}", headers=w["bob"]).status_code == 200
