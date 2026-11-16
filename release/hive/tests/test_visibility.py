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
        kinds |= set(re.findall(r'\b_event\(\s*["\']([a-z_.]+)["\']', f.read_text()))   # media.py's own emitter
    assert len(kinds) >= 40, f"parse regressed: {len(kinds)} kinds"
    assert not [k for k in kinds if event_rule(k) is None], [k for k in kinds if event_rule(k) is None]
    assert event_rule("rcp.evidence_failed") == "admin"            # the one f-string emitter (governance_evidence)


def test_media_events_reach_only_people_who_see_the_mind(client):
    """omega-flagship/omegahive#36: a billed-but-refused image and a breaker change are as private as their mind,
    like budget.overrun."""
    from hive.core.visibility import event_rule
    ann = person(client, "u_ann4")
    hive = client.app.state.hive
    sw = client.post("/api/swarms", headers=ann, json={"name": "Studio"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Brush", "kind": "module", "swarm_id": sw["id"]}).json()
    see, hidden, admin = Viewer("user:u_ann4", False), Viewer("user:u_bob4", False), Viewer("user:operator", True)
    for kind in ("media.billed_refused", "media.breaker_tripped", "media.breaker_reset", "web.breaker_tripped",
                 "web.breaker_reset"):
        assert event_rule(kind) == "scoped", kind
        frame = json.dumps({"type": kind, "agent": mind["id"], "agent_id": mind["id"], "reservation": "media:x"})   # as emitted
        assert hive.visibility.event_visible(see, frame), kind
        assert hive.visibility.event_visible(admin, frame), kind
        assert not hive.visibility.event_visible(hidden, frame), kind


def _plan_row(hive, plan_id, person_principal):
    at = now()
    hive.db.insert("create_plan_runs", {"plan_id": plan_id, "person": person_principal, "sentence": "a todo app", "epoch": "e1",
                                        "reducer_sha256": "x", "review_policy": "review-required", "lease": 0, "piece_cap": 1,
                                        "fix_cap": 1, "status": "accepted", "created_at": at, "updated_at": at})


def _sees3(hive, frame, see, hidden, admin, label):
    assert hive.visibility.event_visible(see, frame), label
    assert hive.visibility.event_visible(admin, frame), label
    assert not hive.visibility.event_visible(hidden, frame), label


def test_create_plan_events_reach_only_the_plans_person(client):
    """A plan's live updates reach the person who started it (create_plan_runs.person) and admins, no other member."""
    from hive.core.visibility import event_rule
    hive = client.app.state.hive
    _plan_row(hive, "cp_vis1", "user:u_pat")
    see, hidden, admin = Viewer("user:u_pat", False), Viewer("user:u_quinn", False), Viewer("user:operator", True)
    frames = {"create.plan.question": {"q": "q1", "about": "{}", "text": "Which colour?"},
              "create.plan.status": {"phase": "planning", "status": "running"},
              "create.plan.piece": {"piece": "p1", "state": "building"},
              "create.plan.preview": {"ckpt": "c1"},
              "code.controller.member_ready": {"piece": "p1", "cand": "c1", "task_id": "mt_x"}}
    for kind, extra in frames.items():
        assert event_rule(kind) == "plan_person", kind
        _sees3(hive, json.dumps({"type": kind, "plan_id": "cp_vis1", **extra}), see, hidden, admin, kind)
        # an unknown plan, or no plan_id at all, reaches no member (fail closed)
        assert not hive.visibility.event_visible(see, json.dumps({"type": kind, "plan_id": "cp_nope", **extra})), kind
        assert not hive.visibility.event_visible(see, json.dumps({"type": kind, **extra})), kind


def test_code_controller_events_follow_the_request_or_the_plan(client):
    """request_id names a minds request row: the controller's events follow GET /api/requests/{id}/controller (both
    swarms visible). A plan member's run has no request row and follows its plan's person."""
    from hive.core.visibility import event_rule
    ann = person(client, "u_ann7")
    hive = client.app.state.hive
    a = client.post("/api/swarms", headers=ann, json={"name": "Asker"}).json()
    b = client.post("/api/swarms", headers=ann, json={"name": "Coders"}).json()
    hive.db.insert("requests", {"id": "rq_vis1", "kind": "code", "title": "t", "from_swarm": a["id"], "from_principal": "user:u_ann7",
                                "to_swarm": b["id"], "context_refs": "[]", "constraints": "[]", "acceptance": "[]",
                                "budget_root": "rq_vis1", "limit_usd": 1.0, "ancestry": "[]", "depth": 0, "created_at": now()})
    _plan_row(hive, "cp_vis2", "user:u_pat7")
    at = now()
    hive.db.execute("INSERT INTO code_controller_runs (request_id, lease_id, controller_id, person, profile, max_repairs, "
                    "reducer_sha256, status, created_at, updated_at, member) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    ("mt_vis2", "l", "plan:cp_vis2", "user:u_pat7", "member", 1, "x", "accepted", at, at,
                     json.dumps({"plan_id": "cp_vis2", "piece": "p1"})))
    ann_v, pat, bob, admin = (Viewer("user:u_ann7", False), Viewer("user:u_pat7", False), Viewer("user:u_bob7", False),
                              Viewer("user:operator", True))
    for kind in ("code.controller", "code.controller.status", "code.controller.ready", "code.controller.applied"):
        assert event_rule(kind) == "code_run", kind
        _sees3(hive, json.dumps({"type": kind, "request_id": "rq_vis1", "status": "testing"}), ann_v, bob, admin, kind)
        _sees3(hive, json.dumps({"type": kind, "request_id": "mt_vis2", "status": "testing"}), pat, ann_v, admin, kind)
        assert not hive.visibility.event_visible(ann_v, json.dumps({"type": kind, "request_id": "rq_nope"})), kind
    # one swarm of the request shared is not enough: the HTTP route needs both
    client.put(f"/api/swarms/{a['id']}/visibility", headers=ann, json={"visibility": "shared", "shared_with": ["user:u_bob7"]})
    assert not hive.visibility.event_visible(bob, json.dumps({"type": "code.controller", "request_id": "rq_vis1"}))


def test_asset_stored_follows_the_assets_owner_swarm(client):
    from hive.core.visibility import event_rule
    ann = person(client, "u_ann8")
    hive = client.app.state.hive
    sw = client.post("/api/swarms", headers=ann, json={"name": "Files"}).json()
    mind = client.post("/api/agents", headers=ann, json={"name": "Filer", "kind": "module", "swarm_id": sw["id"]}).json()
    see, hidden, admin = Viewer("user:u_ann8", False), Viewer("user:u_bob8", False), Viewer("user:operator", True)
    assert event_rule("asset.stored") == "asset"
    frame = lambda **f: json.dumps({"type": "asset.stored", "sha256": "ab" * 32, **f})   # as emitted (assets.put)
    _sees3(hive, frame(owner_swarm=sw["id"], by="user:u_ann8"), see, hidden, admin, "person")
    _sees3(hive, frame(owner_swarm=sw["id"], by=f"agent:{mind['id']}"), see, hidden, admin, "mind")
    # the swarm shared with bob, but the mind that stored it still private to ann: withheld from bob
    client.put(f"/api/swarms/{sw['id']}/visibility", headers=ann, json={"visibility": "shared", "shared_with": ["user:u_bob8"]})
    assert hive.visibility.event_visible(hidden, frame(owner_swarm=sw["id"], by="user:u_ann8"))
    assert not hive.visibility.event_visible(hidden, frame(owner_swarm=sw["id"], by=f"agent:{mind['id']}"))
    # no owner swarm: operator business
    assert not hive.visibility.event_visible(see, frame(owner_swarm=None, by="user:operator"))
    assert hive.visibility.event_visible(admin, frame(owner_swarm=None, by="user:operator"))


def test_repo_map_events_reach_only_who_may_read_the_map(client):
    """An owner map (a private code repo) reaches the hive's owner and its grantees, never another admin or member; a
    swarm map whoever sees the swarm; a map not stored yet only the owner."""
    from hive.core.visibility import event_rule
    ann = person(client, "u_ann9")
    hive = client.app.state.hive
    owner = hive.ownhive.owner()
    sw = client.post("/api/swarms", headers=ann, json={"name": "Mapped"}).json()

    def stored(repo, sha, visibility):
        hive.db.insert("repo_maps", {"repo": repo, "sha": sha, "digest": "d", "schema": "repo-map/1", "state": "complete",
                                     "visibility": visibility, "header": "{}", "counts": "{}", "loaded_by": "host",
                                     "loaded_at": now()})
    stored("secret-code", "s1", "owner")
    stored(f"assets-{sw['id']}", "s2", f"swarm:{sw['id']}")
    own, other_admin, member = Viewer(owner, True), Viewer("user:u_adm9", True), Viewer("user:u_bob9", False)
    for kind in ("repo_maps.updated", "repo_maps.stale"):
        assert event_rule(kind) == "repo_map", kind
        private = json.dumps({"type": kind, "repo": "secret-code", "sha": "s1", "built_sha": "s1", "digest": "d"})
        assert hive.visibility.event_visible(own, private), kind
        assert not hive.visibility.event_visible(other_admin, private), kind
        assert not hive.visibility.event_visible(member, private), kind
        hive.repo_maps.grant("secret-code", "user:u_bob9", owner)
        assert hive.visibility.event_visible(member, private), kind
        hive.repo_maps.revoke_grant("secret-code", "user:u_bob9")
        swarm_map = json.dumps({"type": kind, "repo": f"assets-{sw['id']}", "sha": "s2", "built_sha": "s2"})
        _sees3(hive, swarm_map, Viewer("user:u_ann9", False), member, other_admin, kind)
        unknown = json.dumps({"type": kind, "repo": "never-built", "built_sha": None, "state": "stale-unknown"})
        assert hive.visibility.event_visible(own, unknown), kind
        assert not hive.visibility.event_visible(other_admin, unknown), kind
        assert not hive.visibility.event_visible(member, unknown), kind


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
            kinds |= set(re.findall(r'\b_event\(\s*["\']([a-z_.]+)["\']', f.read_text()))   # media.py's own emitter
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
