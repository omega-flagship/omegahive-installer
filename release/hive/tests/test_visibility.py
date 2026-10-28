"""R13: private, shared and public minds and swarms; chosen at creation, changeable after; enforced everywhere."""
import json
import secrets

from hive.core.db import now
from hive.core.hive import token_hash
from hive.core.visibility import Viewer
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def person(client, pid, role="member"):
    hive = client.app.state.hive
    hive.db.insert("people", {"id": pid, "email": f"{pid}@example.test", "name": pid, "role": role, "created_at": now()})
    token = secrets.token_urlsafe(24)
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": f"user:{pid}"})
    return {"Authorization": f"Bearer {token}"}


def test_private_shared_public_for_swarms_and_minds(client):
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
    assert sw["visibility"] == "private" and sw["owner"] == "user:u_ann"
    mind = client.post("/api/agents", headers=ann, json={"name": "Ada", "kind": "module", "swarm_id": sw["id"]}).json()
    # Bob sees neither, and gets not-found (existence is not revealed)
    assert sw["id"] not in [s["id"] for s in client.get("/api/swarms", headers=bob).json()]
    assert mind["id"] not in [a["id"] for a in client.get("/api/agents", headers=bob).json()]
    assert client.get(f"/api/swarms/{sw['id']}", headers=bob).status_code == 404
    assert client.get(f"/api/agents/{mind['id']}/traces", headers=bob).status_code == 404
    assert client.post("/api/agents", headers=bob, json={"name": "x", "kind": "module", "swarm_id": sw["id"]}).status_code == 404
    # the admin always sees (auditability)
    assert sw["id"] in [s["id"] for s in client.get("/api/swarms").json()]
    # only the owner or an admin changes it
    assert client.put(f"/api/swarms/{sw['id']}/visibility", headers=bob, json={"visibility": "public"}).status_code == 404
    shared = client.put(f"/api/swarms/{sw['id']}/visibility", headers=ann, json={"visibility": "shared", "shared_with": ["user:u_bob"]}).json()
    assert shared["visibility"] == "shared" and shared["shared_with"] == ["user:u_bob"]
    assert client.get(f"/api/swarms/{sw['id']}", headers=bob).status_code == 200
    assert client.get(f"/api/agents/{mind['id']}", headers=bob).status_code == 404       # the mind is still private
    client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"visibility": "public"})
    assert client.get(f"/api/agents/{mind['id']}", headers=bob).status_code == 200
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"visibility": "secret"}).status_code == 400
    assert client.put(f"/api/agents/{mind['id']}/visibility", headers=ann, json={"shared_with": ["bob"]}).status_code == 400


def test_live_events_are_filtered_per_person(client):
    ann = person(client, "u_ann2")
    hive = client.app.state.hive
    sw = client.post("/api/swarms", headers=ann, json={"name": "Quiet"}).json()
    bob = Viewer("user:u_bob2", False)
    ev = json.dumps({"type": "swarm.updated", "swarm": {"id": sw["id"], "name": "Quiet"}})
    assert hive.visibility.event_visible(Viewer("user:u_ann2", False), ev)
    assert not hive.visibility.event_visible(bob, ev)
    assert hive.visibility.event_visible(Viewer("user:operator", True), ev)
    # a scoped event that names nothing recognisable is no longer broadcast to everyone (Kimi hotfix-shares r3)
    assert not hive.visibility.event_visible(bob, json.dumps({"type": "usage", "usage": {"model": "m"}}))
    assert not hive.visibility.event_visible(bob, json.dumps({"type": "harness.connected", "invite": {"code": "x"}}))
    assert not hive.visibility.event_visible(bob, json.dumps({"type": "something.new", "item": {"id": "zz_1"}}))
    assert hive.visibility.event_visible(bob, json.dumps({"type": "programs.updated", "programs": []}))



def test_approval_events_reach_only_people_who_see_the_mind(client):
    """A decision is as private as its mind: the person who sees the mind (and an admin) gets approval.created and
    approval.updated; a person who cannot see it never does (restR2's rest counts read only these frames)."""
    from hive.core.visibility import event_rule
    ann = person(client, "u_ann3")
    hive = client.app.state.hive
    sw = client.post("/api/swarms", headers=ann, json={"name": "Ledger"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Quill", "kind": "module", "swarm_id": sw["id"]}).json()
    see, hidden, admin = Viewer("user:u_ann3", False), Viewer("user:u_bob3", False), Viewer("user:operator", True)
    for kind, status in (("approval.created", "pending"), ("approval.updated", "approved")):
        frame = json.dumps({"type": kind, "approval": {"id": "ap_v1", "agent_id": mind["id"], "status": status}})
        assert hive.visibility.event_visible(see, frame), kind
        assert hive.visibility.event_visible(admin, frame), kind
        assert not hive.visibility.event_visible(hidden, frame), kind
    # and by rule: both kinds are scoped to the minds a person sees (not public, not admin-only, not unregistered)
    assert event_rule("approval.created") == "scoped" and event_rule("approval.updated") == "scoped"

def test_things_that_existed_before_stay_public(client):
    hive = client.app.state.hive
    hive.db.execute("INSERT INTO swarms (id, name, description, hue, created_at) VALUES ('s_old', 'Old', '', 1, ?)", (now(),))
    bob = person(client, "u_bob3")
    assert "s_old" in [s["id"] for s in client.get("/api/swarms", headers=bob).json()]


def test_every_published_event_kind_has_a_rule():
    """Kimi hotfix-shares r3: a new emitter must be given a visibility rule, or this fails."""
    import pathlib
    import re
    from hive.core.visibility import event_rule
    root = pathlib.Path(__file__).resolve().parents[1]
    kinds = set()
    for f in root.rglob("*.py"):
        if "tests" in f.parts:
            continue
        kinds |= set(re.findall(r'events\.publish\(\s*["\']([a-z_.]+)["\']', f.read_text()))
    assert len(kinds) >= 40, f"parse regressed: {len(kinds)} kinds"
    assert not [k for k in kinds if event_rule(k) is None], [k for k in kinds if event_rule(k) is None]
    assert event_rule("rcp.evidence_failed") == "admin"            # the one f-string emitter (governance_evidence)


def test_members_still_receive_what_they_may_read(client):
    """Kimi next10-events B1-B3: the registry must not fail closed into darkness for member-readable kinds."""
    import json as _json
    from hive.core.visibility import Viewer
    hive = client.app.state.hive
    ana, bob, admin = Viewer("user:u_ana", False), Viewer("user:u_bob", False), Viewer("user:operator", True)
    ev = lambda **f: _json.dumps(f)
    assert hive.visibility.event_visible(ana, ev(type="lab.run", run={"id": "lr_1"}))
    assert hive.visibility.event_visible(ana, ev(type="lab.log", run_id="lr_1", text="step 1"))   # the emitter's real shape
    mine = ev(type="person_request.created", request={"id": "pr_1", "requested_by": "user:u_ana", "payload": {"swarm_id": "s_x"}})
    assert hive.visibility.event_visible(ana, mine) and not hive.visibility.event_visible(bob, mine)
    assert hive.visibility.event_visible(admin, mine)
    assert not hive.visibility.event_visible(bob, ev(type="person_request.updated", request={"id": "pr_2"}))
    # the hostile frame: someone else's ask, delivered to bob (Kimi r2)
    assert not hive.visibility.event_visible(bob, ev(type="person_request.updated", request={"id": "pr_2", "requested_by": "user:u_ana"}))


def test_every_rule_names_a_kind_that_is_actually_published():
    """Kimi B4: a stale or misspelled rule key would silently never apply."""
    import pathlib
    import re
    from hive.core.visibility import EVENT_RULES
    root = pathlib.Path(__file__).resolve().parents[1]
    kinds = set()
    for f in root.rglob("*.py"):
        if "tests" not in f.parts:
            kinds |= set(re.findall(r'events\.publish\(\s*["\']([a-z_.]+)["\']', f.read_text()))
    stale = set(EVENT_RULES) - kinds
    if stale:
        raise AssertionError(f"rules for kinds nothing publishes: {sorted(stale)}")


def test_a_visible_share_notice_to_a_hidden_mind_is_still_withheld(client):
    """Kimi A1: the notice rule and the recipient's own visibility must both hold."""
    import asyncio
    import json as _json
    from hive.core.visibility import Viewer
    from hive.tests.test_share_visibility import share_between
    hive = client.app.state.hive
    public = client.post("/api/swarms", json={"name": "A1", "visibility": "public"}).json()["id"]
    sid = share_between(client, public)                                   # a share the member may see
    private = client.post("/api/swarms", json={"name": "A1h", "visibility": "private"}).json()["id"]
    hidden = hive.create_agent("Hidden", "omega", private, "mock/echo", "", None, 0, None, None)
    asyncio.run(hive.shares._tell(hidden["id"], f"[SHARE-OFFERED {sid}] x", sid, "share_offered"))
    note = hive.messages(hidden["id"])[-1]
    assert not hive.visibility.event_visible(Viewer("user:u_a1", False), _json.dumps({"type": "message", "message": note}))


def test_a_connection_is_seen_only_by_people_who_see_both_its_swarms(client):
    """Kimi next10-events r2/r3: a connection links two swarms and is judged by both, in the list, the single-item route
    and the live event alike; its coordinator minds (private by default) are implied by that link."""
    import json as _json
    from hive.core.visibility import Viewer
    from hive.tests.test_visibility import person as _person
    hive = client.app.state.hive
    pub = client.post("/api/swarms", json={"name": "CPub", "visibility": "public"}).json()["id"]
    pub2 = client.post("/api/swarms", json={"name": "CPub2", "visibility": "public"}).json()["id"]
    priv = client.post("/api/swarms", json={"name": "CPriv", "visibility": "private"}).json()["id"]
    a = hive.create_agent("CA", "omega", pub, "mock/echo", "", None, 0, None, None)      # private minds, by default
    b = hive.create_agent("CB", "omega", pub2, "mock/echo", "", None, 0, None, None)
    open_c = {"id": "c_open", "from_swarm": pub, "to_swarm": pub2, "from_coordinator": a["id"], "to_coordinator": b["id"]}
    hidden_c = {**open_c, "id": "c_hidden", "to_swarm": priv}
    member = Viewer("user:u_conn", False)
    frame = lambda c: _json.dumps({"type": "connection.updated", "connection": c})
    assert hive.visibility.event_visible(member, frame(open_c))               # private coordinators do not hide it
    assert not hive.visibility.event_visible(member, frame(hidden_c))
    assert [c["id"] for c in hive.visibility.filter_items(member, [open_c, hidden_c])] == ["c_open"]


def test_the_single_connection_route_follows_the_same_rule(client, monkeypatch):
    from hive.tests.test_visibility import person as _person
    hive = client.app.state.hive
    priv = client.post("/api/swarms", json={"name": "CPriv2", "visibility": "private"}).json()["id"]
    pub = client.post("/api/swarms", json={"name": "CPub3", "visibility": "public"}).json()["id"]
    hidden = {"id": "c_x", "from_swarm": pub, "to_swarm": priv, "from_coordinator": "a_1", "to_coordinator": "a_2"}
    shown = {**hidden, "id": "c_y", "to_swarm": pub}
    monkeypatch.setattr(hive.agreements, "get", lambda cid: {"c_x": hidden, "c_y": shown}[cid])
    monkeypatch.setattr(hive.agreements, "view", lambda row: dict(row))
    ana = _person(client, "u_conn2", "member")
    assert client.get("/api/connections/c_x", headers=ana).status_code == 404
    assert client.get("/api/connections/c_y", headers=ana).status_code == 200
    assert client.get("/api/connections/c_x").status_code == 200                # admins see everything


def test_a_withheld_id_less_event_is_logged_once(client, caplog):
    import json as _json
    import logging
    from hive.core import visibility as vis
    vis._WITHHELD_LOGGED.discard("usage")
    member = vis.Viewer("user:u_log", False)
    with caplog.at_level(logging.WARNING, logger="hive"):
        for _ in range(3):
            assert not client.app.state.hive.visibility.event_visible(member, _json.dumps({"type": "usage", "usage": {"run_id": "x"}}))
    assert sum("names no mind, swarm or room" in r.getMessage() for r in caplog.records) == 1
