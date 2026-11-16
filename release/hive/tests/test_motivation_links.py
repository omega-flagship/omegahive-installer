"""Motivations phase 1b: the atomic links route (link, unlink, move, cascade), its idempotency record and replay, separate
source and destination revisions, motivation.links delivery, paired worlds (B3) and group=status. Synthetic data only."""
import json
import re
import secrets
import threading
import time

import pytest

from hive.core.visibility import Viewer
from hive.tests.test_core_api import client, load_settings, create_app, FakeSupervisor, PETTA  # noqa: F401  (fixture)
from hive.tests.test_motivations import goal, ids, motivation, ok, world


def op_id():
    return "op-" + secrets.token_hex(6)


def links(client, headers, mid, op, goal_ids, to_rev=1, cascade=False, operation_id=None, **extra):
    body = {"operation_id": operation_id or op_id(), "op": op, "goal_ids": goal_ids, "cascade": cascade, "expected_to_rev": to_rev, **extra}
    return client.post(f"/api/motivations/{mid}/links", headers=headers, json=body)


def linked(hive, mid):
    return sorted(r["goal_id"] for r in hive.db.all("SELECT goal_id FROM motivation_tasks WHERE motivation_id = ?", (mid,)))


def row(hive, mid):
    return hive.db.one("SELECT * FROM motivations WHERE id = ?", (mid,))


def code(resp):
    return resp.json()["error"]["code"]


def capture(hive):
    published, real = [], hive.events.publish
    hive.events.publish = lambda kind, **payload: (published.append((kind, payload)), real(kind, **payload))
    return published, lambda: setattr(hive.events, "publish", real)


# ---- link, unlink, move: links_version only, never rev or updated_at (B3) --------------------------------------------

def test_link_unlink_and_move_touch_only_links_version(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    m, n = motivation(client, p1, title="M"), motivation(client, p1, title="N")
    a, b = goal(client, w["t1"], "a"), goal(client, w["t2"], "b")
    published, restore = capture(hive)
    try:
        out = ok(links(client, p1, m["id"], "link", [a["id"], b["id"]]))
    finally:
        restore()
    assert sorted(out["applied"]) == sorted([a["id"], b["id"]]) and out["unchanged"] == []
    assert [k for k, _ in published] == ["motivation.links", "motivation.links"]        # one per (motivation, swarm); no content event
    assert {p["swarm_id"]: p["linked"] for _, p in published} == {w["t1"]: [a["id"]], w["t2"]: [b["id"]]}
    after = row(hive, m["id"])
    assert (after["rev"], after["updated_at"], after["links_version"]) == (1, m["updated_at"], 1)
    assert ok(links(client, p1, m["id"], "link", [a["id"]]))["unchanged"] == [a["id"]]   # an existing pair is a no-op
    assert row(hive, m["id"])["links_version"] == 1
    ok(links(client, p1, m["id"], "unlink", [a["id"]]))
    assert code(links(client, p1, m["id"], "unlink", [a["id"]])) == "link_changed"        # the pair must exist
    moved = ok(links(client, p1, n["id"], "move", [b["id"]], from_motivation_id=m["id"], expected_from_rev=1))
    assert moved["applied"] == [b["id"]] and moved["from_motivation"]["id"] == m["id"]
    assert linked(hive, m["id"]) == [] and linked(hive, n["id"]) == [b["id"]]
    assert (row(hive, m["id"])["links_version"], row(hive, n["id"])["links_version"]) == (3, 1)
    assert (row(hive, n["id"])["rev"], row(hive, n["id"])["updated_at"]) == (1, n["updated_at"])
    # status, scope, open swarm
    ok(client.patch(f"/api/motivations/{n['id']}", headers=p1, json={"status": "retired", "expected_rev": 1}))
    assert code(links(client, p1, n["id"], "link", [a["id"]], to_rev=2)) == "motivation_closed"
    assert ok(links(client, p1, n["id"], "unlink", [b["id"]], to_rev=2))["applied"] == [b["id"]]   # unlinking a retired one is fine
    team = motivation(client, p1, title="T1 team", owner=f"swarm:{w['t1']}")
    assert code(links(client, p1, team["id"], "link", [b["id"]])) == "scope_mismatch"
    hive.archive_swarm(w["t2"], "user:operator")
    assert code(links(client, p1, m["id"], "link", [b["id"]])) == "swarm_archived"
    for bad in ({"op": "relink"}, {"cascade": None}, {"goal_ids": []}, {"goal_ids": ["g_x"] * 201}, {"expected_to_rev": "1"},
                {"operation_id": "short"}, {"extra": 1}):
        body = {"operation_id": op_id(), "op": "link", "goal_ids": [a["id"]], "cascade": False, "expected_to_rev": 1, **bad}
        assert client.post(f"/api/motivations/{m['id']}/links", headers=p1, json={k: v for k, v in body.items() if v is not None}).status_code == 400, bad


def test_only_an_editor_links_and_hidden_ids_answer_as_missing(client):
    w = world(client)
    hive, p1, p2 = w["hive"], w["p1"], w["p2"]
    shared = motivation(client, p1, title="shared", visibility="shared", shared_with=["user:u_p2"])
    hidden = motivation(client, p1, title="hidden")
    mine = motivation(client, p2, title="p2's")
    t1g, t2g = goal(client, w["t1"]), goal(client, w["t2"])
    missing = links(client, p2, "mo_00000000", "link", [t1g["id"]])
    for mid in (shared["id"], hidden["id"]):                       # readable-but-not-editable and hidden: both as missing
        r = links(client, p2, mid, "link", [t1g["id"]])
        assert (r.status_code, r.json()) == (missing.status_code, missing.json()) == (404, missing.json())
    a, b = links(client, p2, mine["id"], "link", [t2g["id"]]), links(client, p2, mine["id"], "link", ["g_00000000"])
    assert (a.status_code, a.json()) == (b.status_code, b.json()) == (404, b.json())
    assert linked(hive, mine["id"]) == [] and hive.db.one("SELECT COUNT(*) AS n FROM motivation_ops")["n"] == 0   # refusals write nothing


# ---- 8.1 case 7: cascades -----------------------------------------------------------------------------------------

def test_cascade_changes_every_descendant_or_none_and_never_anyone_elses_links(client):
    w = world(client)
    hive, p1, p2 = w["hive"], w["p1"], w["p2"]
    m = motivation(client, p1, title="M", owner=f"swarm:{w['t1']}")
    root = goal(client, w["t1"], "root")
    c1 = goal(client, w["t1"], "c1", parent_id=root["id"])
    c2 = goal(client, w["t1"], "c2", parent_id=c1["id"])
    other = goal(client, w["t1"], "other")
    p2s = motivation(client, p2, title="p2 private")
    hidden = motivation(client, p1, title="p1 hidden")
    ok(links(client, p2, p2s["id"], "link", [c1["id"]]))
    ok(links(client, p1, hidden["id"], "link", [c2["id"]]))
    out = ok(links(client, p1, m["id"], "link", [root["id"]], cascade=True))
    assert sorted(out["applied"]) == sorted([root["id"], c1["id"], c2["id"]])
    assert linked(hive, p2s["id"]) == [c1["id"]] and linked(hive, hidden["id"]) == [c2["id"]]   # untouched
    ok(links(client, p1, m["id"], "unlink", [root["id"]], cascade=True))
    assert linked(hive, m["id"]) == [] and linked(hive, p2s["id"]) == [c1["id"]] and linked(hive, hidden["id"]) == [c2["id"]]
    # a failing named row refuses all
    before = row(hive, m["id"])["links_version"]
    assert links(client, p1, m["id"], "link", [root["id"], "g_00000000"], cascade=True).status_code == 404
    hive.db.execute("UPDATE goals SET swarm_id = ? WHERE id = ?", (w["t2"], c2["id"]))           # an anomalous descendant
    refused = links(client, p1, m["id"], "link", [root["id"], other["id"]], cascade=True)
    assert code(refused) == "cascade_refused" and c2["id"] not in refused.text
    assert linked(hive, m["id"]) == [] and row(hive, m["id"])["links_version"] == before
    assert sorted(ok(links(client, p1, m["id"], "link", [root["id"], other["id"]], cascade=False))["applied"]) == sorted([root["id"], other["id"]])


def test_concurrent_moves_from_one_motivation_give_one_success_and_one_link_changed(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    a, b, c = (motivation(client, p1, title=t) for t in "ABC")
    g = goal(client, w["t1"])
    ok(links(client, p1, a["id"], "link", [g["id"]]))
    first = links(client, p1, b["id"], "move", [g["id"]], from_motivation_id=a["id"], expected_from_rev=1)
    second = links(client, p1, c["id"], "move", [g["id"]], from_motivation_id=a["id"], expected_from_rev=1)
    assert first.status_code == 200 and code(second) == "link_changed"
    assert linked(hive, b["id"]) == [g["id"]] and linked(hive, c["id"]) == []
    # the same race on threads, straight at the module: one wins, the other is refused whole
    ok(links(client, p1, a["id"], "link", [g["id"]]))
    viewer, results = Viewer("user:u_p1", False), []
    barrier = threading.Barrier(2)

    def move(dest):
        barrier.wait()
        try:
            hive.motivations.link(viewer, dest, {"operation_id": op_id(), "op": "move", "goal_ids": [g["id"]], "cascade": False,
                                                 "expected_to_rev": 1, "from_motivation_id": a["id"], "expected_from_rev": 1})
            results.append("ok")
        except Exception as exc:
            results.append(exc.code)
    threads = [threading.Thread(target=move, args=(d,)) for d in (b["id"], c["id"])]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["link_changed", "ok"] and linked(hive, a["id"]) == []


# ---- 8.1 case 11: idempotency bound to destination and body; replay re-checks authority now --------------------------

def test_one_key_one_request(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    a, b, src = (motivation(client, p1, title=t) for t in ("A", "B", "S"))
    g, h = goal(client, w["t1"], "g"), goal(client, w["t1"], "h")
    key = op_id()
    first = ok(links(client, p1, a["id"], "link", [g["id"]], operation_id=key))
    again = ok(links(client, p1, a["id"], "link", [g["id"]], operation_id=key))
    assert again["replayed"] is True and (again["applied"], again["unchanged"]) == (first["applied"], first["unchanged"])
    assert row(hive, a["id"])["links_version"] == 1                                         # the replay changed nothing
    assert code(links(client, p1, b["id"], "link", [g["id"]], operation_id=key)) == "operation_conflict"   # another destination
    for change in ({"goal_ids": [h["id"]]}, {"cascade": True}, {"to_rev": 2}, {"expected_to_links_version": 1}, {"op": "unlink"}):
        args = {"op": "link", "goal_ids": [g["id"]], **change}
        assert code(links(client, p1, a["id"], args.pop("op"), args.pop("goal_ids"), operation_id=key, **args)) == "operation_conflict", change
    ok(links(client, p1, src["id"], "link", [h["id"]]))
    mkey = op_id()
    ok(links(client, p1, b["id"], "move", [h["id"]], operation_id=mkey, from_motivation_id=src["id"], expected_from_rev=1))
    for change in ({"from_motivation_id": a["id"]}, {"expected_from_rev": 2}, {"expected_from_links_version": 0}):
        args = {"from_motivation_id": src["id"], "expected_from_rev": 1, **change}
        assert code(links(client, p1, b["id"], "move", [h["id"]], operation_id=mkey, **args)) == "operation_conflict", change
    p2m = motivation(client, w["p2"], title="p2")["id"]
    assert ok(links(client, w["p2"], p2m, "link", [g["id"]], operation_id=key))["applied"] == [g["id"]]   # keys are per principal


def test_replay_after_losing_authority_is_the_first_time_refusal(client):
    w = world(client)
    hive, p1, p2, p3 = w["hive"], w["p1"], w["p2"], w["p3"]
    g = goal(client, w["t1"], "work")
    missing = links(client, p3, "mo_00000000", "link", [g["id"]]).json()
    # lost team ownership: P3 owned T1 and linked to its private team motivation; T1 goes back to P1
    hive.db.execute("UPDATE swarms SET owner = 'user:u_p3' WHERE id = ?", (w["t1"],))
    tm = motivation(client, p3, title="team secret", owner=f"swarm:{w['t1']}", visibility="private")
    key = op_id()
    ok(links(client, p3, tm["id"], "link", [g["id"]], operation_id=key))
    hive.db.execute("UPDATE swarms SET owner = 'user:u_p1' WHERE id = ?", (w["t1"],))
    r = links(client, p3, tm["id"], "link", [g["id"]], operation_id=key)
    assert (r.status_code, r.json()) == (404, missing) and g["id"] not in r.text and "team secret" not in r.text
    # a personal row reassigned by an admin
    pm = motivation(client, p2, title="p2 aim")
    key2 = op_id()
    ok(links(client, p2, pm["id"], "link", [g["id"]], operation_id=key2))
    hive.db.execute("UPDATE motivations SET owner = 'user:u_p1' WHERE id = ?", (pm["id"],))
    r = links(client, p2, pm["id"], "link", [g["id"]], operation_id=key2)
    assert (r.status_code, r.json()) == (404, missing) and "p2 aim" not in r.text
    # visibility narrowed: P2 no longer sees the task's swarm
    pm2 = motivation(client, p2, title="p2 second")
    key3 = op_id()
    ok(links(client, p2, pm2["id"], "link", [g["id"]], operation_id=key3))
    ok(client.put(f"/api/swarms/{w['t1']}/visibility", headers=p1, json={"visibility": "shared", "shared_with": ["user:u_p3"]}))
    r = links(client, p2, pm2["id"], "link", [g["id"]], operation_id=key3)
    assert r.status_code == 404 and g["id"] not in r.text
    # a demoted admin who can no longer read the row
    hive.db.execute("UPDATE people SET role = 'admin' WHERE id = 'u_p4'")
    pm1 = motivation(client, p1, title="p1 private")
    key4 = op_id()
    ok(links(client, w["p4"], pm1["id"], "link", [g["id"]], operation_id=key4))
    hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_p4'")
    r = links(client, w["p4"], pm1["id"], "link", [g["id"]], operation_id=key4)
    assert (r.status_code, r.json()) == (404, missing) and "p1 private" not in r.text


def test_replay_with_authority_returns_the_stored_outcome_and_the_current_view(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    m = motivation(client, p1, title="before")
    g = goal(client, w["t1"])
    key = op_id()
    first = ok(links(client, p1, m["id"], "link", [g["id"]], operation_id=key, expected_to_links_version=0))
    assert first["motivation"]["links_version"] == 1
    ok(client.patch(f"/api/motivations/{m['id']}", headers=p1, json={"title": "after", "expected_rev": 1}))
    # the consumed preconditions (rev 1, links_version 0) are stale now; replay re-checks authority, not them
    again = ok(links(client, p1, m["id"], "link", [g["id"]], operation_id=key, expected_to_links_version=0))
    assert again["applied"] == [g["id"]] and again["motivation"]["title"] == "after" and again["motivation"]["rev"] == 2
    stored = json.loads(hive.db.one("SELECT outcome FROM motivation_ops WHERE operation_id = ?", (key,))["outcome"])
    assert stored == {"applied": [g["id"]], "unchanged": []}                                  # ids only, never a view


def test_links_and_their_operation_record_commit_together(client, monkeypatch):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    m = motivation(client, p1, title="M")
    g = goal(client, w["t1"])
    viewer = Viewer("user:u_p1", False)
    body = {"operation_id": "fault-op-01", "op": "link", "goal_ids": [g["id"]], "cascade": False, "expected_to_rev": 1}

    def fault(*args, **kwargs):
        raise RuntimeError("injected between the links and the record")
    published, restore = capture(hive)
    monkeypatch.setattr(hive.motivations, "_record_op", fault)
    try:
        hive.motivations.link(viewer, m["id"], body)
        raise AssertionError("no fault")
    except RuntimeError:
        pass
    finally:
        restore()
    assert linked(hive, m["id"]) == [] and row(hive, m["id"])["links_version"] == 0
    assert hive.db.one("SELECT COUNT(*) AS n FROM motivation_ops")["n"] == 0 and not [k for k, _ in published if k.startswith("motivation")]
    monkeypatch.undo()
    assert hive.motivations.link(viewer, m["id"], body)["applied"] == [g["id"]]               # evaluated afresh


# ---- 8.1 case 12: separate source and destination revisions ---------------------------------------------------------

def test_a_move_checks_each_side_against_its_own_revision(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    src, dst = motivation(client, p1, title="src"), motivation(client, p1, title="dst")
    for mo, target in ((src, 3), (dst, 7)):
        for rev in range(1, target):
            ok(client.patch(f"/api/motivations/{mo['id']}", headers=p1, json={"why": f"r{rev}", "expected_rev": rev}))
    g = goal(client, w["t1"])
    ok(links(client, p1, src["id"], "link", [g["id"]], to_rev=3))
    for to_rev, from_rev in ((7, 2), (6, 3)):
        r = links(client, p1, dst["id"], "move", [g["id"]], to_rev=to_rev, from_motivation_id=src["id"], expected_from_rev=from_rev)
        assert code(r) == "motivation_changed"
        assert linked(hive, src["id"]) == [g["id"]] and linked(hive, dst["id"]) == []
    assert code(links(client, p1, dst["id"], "move", [g["id"]], to_rev=7, from_motivation_id=src["id"], expected_from_rev=3,
                      expected_from_links_version=0)) == "motivation_changed"
    assert links(client, p1, dst["id"], "move", [g["id"]], to_rev=7, expected_from_rev=3).status_code == 400
    assert links(client, p1, dst["id"], "move", [g["id"]], to_rev=7, from_motivation_id=src["id"]).status_code == 400
    assert links(client, p1, dst["id"], "link", [g["id"]], to_rev=7, expected_from_rev=3).status_code == 400
    assert links(client, p1, dst["id"], "link", [g["id"]], to_rev=7, from_motivation_id=src["id"]).status_code == 400
    assert links(client, p1, dst["id"], "move", [g["id"]], to_rev=7, from_motivation_id=dst["id"], expected_from_rev=7).status_code == 400
    ok(links(client, p1, dst["id"], "move", [g["id"]], to_rev=7, from_motivation_id=src["id"], expected_from_rev=3))
    assert linked(hive, src["id"]) == [] and linked(hive, dst["id"]) == [g["id"]]


# ---- 8.1 case 14: event delivery ----------------------------------------------------------------------------------

def test_motivation_links_reaches_only_who_reads_the_motivation_and_sees_the_swarm(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    span = motivation(client, p1, title="span", visibility="shared", shared_with=["user:u_p2"])
    a, h = goal(client, w["t1"], "a"), goal(client, w["t2"], "h")
    published, restore = capture(hive)
    try:
        ok(links(client, p1, span["id"], "link", [a["id"], h["id"]]))
    finally:
        restore()
    assert "motivation.updated" not in [k for k, _ in published]                            # never for a link-only change
    frames = {p["swarm_id"]: json.dumps({"type": k, **p}) for k, p in published if k == "motivation.links"}
    who = {p: Viewer(f"user:u_{p}", False) for p in ("p1", "p2", "p3", "p4")}
    seen = lambda frame: {p for p, v in who.items() if hive.visibility.event_visible(v, frame)}
    assert seen(frames[w["t1"]]) == {"p1", "p2"} and seen(frames[w["t2"]]) == {"p1"}
    assert hive.visibility.event_visible(Viewer("user:operator", True), frames[w["t2"]])
    ev = lambda **f: json.dumps({"type": "motivation.links", "motivation_id": span["id"], "swarm_id": w["t1"], "linked": [a["id"]], "unlinked": [], **f})
    assert seen(ev()) == {"p1", "p2"}
    assert seen(ev(linked=[a["id"], h["id"]])) == set()                     # a goal outside the declared swarm: withheld
    assert seen(ev(swarm_id=w["t2"])) == set()                              # the emitter's swarm is checked against the goal's owner row
    assert seen(ev(linked=["g_00000000"])) == set() and seen(ev(linked=[])) == set() and seen(ev(swarm_id=None)) == set()
    assert seen(ev(linked="g_x")) == set() and seen(ev(motivation_id="mo_00000000")) == set()
    hive.db.execute("DELETE FROM motivations WHERE id = ?", (span["id"],))
    assert seen(frames[w["t1"]]) == set()                                   # a missing row fails closed


# ---- 8.1 case 13: paired worlds (B3) ---------------------------------------------------------------------------------

ID = re.compile(r"\b(?:mo|g|s|a|r|rq|req)_[0-9a-f]{8}(?:[0-9a-f]{24})?\b")
TS = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z")


def normal(value):
    """Ids and timestamps of fixtures differ between hives; replace them by order of appearance. Cursors are opaque."""
    text = json.dumps(value, sort_keys=True)
    text = re.sub(r'"cursor": "[^"]+"', '"cursor": "C"', text)
    seen = {}
    text = ID.sub(lambda m: seen.setdefault(m.group(0), f"ID{len(seen)}"), text)
    return TS.sub("T", text)


def _stream(client, token, action):
    """The real event stream for one person over an interval: everything until a sentinel published after it."""
    hive = client.app.state.hive
    frames = []
    with client.websocket_connect(f"/api/events?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
        action()
        hive.events.publish("programs.updated", programs=[])
        while True:
            frame = json.loads(ws.receive_text())
            if frame["type"] == "programs.updated":
                return frames
            frames.append({k: v for k, v in frame.items() if k != "at"})


def _all_pages(client, headers, **params):
    out, cursor = [], None
    while True:
        page = ok(client.get("/api/tasks", headers=headers, params={**params, **({"cursor": cursor} if cursor else {})}))
        out.append(page)
        cursor = page.get("cursor")
        if not cursor:
            return out


def _build(c, variant):
    w = world(c)
    pause = lambda: time.sleep(0.003)
    m = {}
    for name, extra in (("span", {"visibility": "shared", "shared_with": ["user:u_p2"]}), ("private", {}),
                        ("team", {"owner": f"swarm:{w['t1']}"})):
        m[name] = motivation(c, w["p1"], title=name, **extra)
        pause()
    g = {}
    for name, swarm, prio in (("a", "t1", 0.9), ("b", "t1", 0.8), ("c", "t1", 0.7), ("d", "t1", 0.65), ("h", "t2", 0.6)):
        g[name] = goal(c, w[swarm], name, priority=prio)
        pause()
    ok(links(c, w["p1"], m["span"]["id"], "link", [g["a"]["id"]]))
    ok(links(c, w["p1"], m["team"]["id"], "link", [g["b"]["id"]]))
    token = w["p2"]["Authorization"][7:]

    def act():
        if variant == "hidden-team":       # P1 links the spanning motivation P2 reads to a task in T2, which P2 cannot see
            ok(links(c, w["p1"], m["span"]["id"], "link", [g["h"]["id"]]))
        elif variant == "private":         # P1 links a T1 task P2 sees to P1's private motivation
            ok(links(c, w["p1"], m["private"]["id"], "link", [g["c"]["id"]]))
    events = _stream(c, token, act)
    p2 = w["p2"]
    obs = {"events": events, "span": ok(c.get(f"/api/motivations/{m['span']['id']}", headers=p2)),
           "team": ok(c.get(f"/api/motivations/{m['team']['id']}", headers=p2)), "list": ok(c.get("/api/motivations", headers=p2)),
           "list_paged": [ok(c.get("/api/motivations", headers=p2, params={"limit": 1}))["items"]]}
    for label, params in (("all", {}), ("span", {"motivation": m["span"]["id"]}), ("team", {"motivation": m["team"]["id"]}),
                          ("unsorted", {"motivation": "none"}), ("t1", {"swarm": w["t1"]}), ("updated", {"sort": "updated"}),
                          ("q", {"q": "c"}), ("top", {"top": "1"})):
        obs[label] = _all_pages(c, p2, limit=1, **params)
    obs["group"] = ok(c.get("/api/tasks", headers=p2, params={"group": "status", "limit": 1}))
    obs["group_unsorted"] = ok(c.get("/api/tasks", headers=p2, params={"group": "status", "motivation": "none"}))
    obs["private_404"] = c.get(f"/api/motivations/{m['private']['id']}", headers=p2).json()
    return w, m, g, obs


def _paired(variant):
    worlds = []
    for _ in range(2):
        import pathlib
        import tempfile
        from fastapi.testclient import TestClient
        settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-paired-")), admin_password="pw", petta_path=PETTA)
        worlds.append(TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)))
    out = []
    for i, tc in enumerate(worlds):
        with tc:
            tc.headers["Authorization"] = "Bearer " + tc.post("/api/auth/login", json={"password": "pw"}).json()["token"]
            w, m, g, obs = _build(tc, variant if i == 1 else None)
            if i == 1:
                hive = tc.app.state.hive
                changed = m["private"] if variant == "private" else m["span"]
                after = hive.db.one("SELECT rev, updated_at, links_version FROM motivations WHERE id = ?", (changed["id"],))
                assert (after["rev"], after["updated_at"]) == (changed["rev"], changed["updated_at"]) and after["links_version"] == 1 + (variant == "hidden-team")
                # positive control: a visible link change reaches P2, and P2's Tasks view changes with it
                frames = _stream(tc, w["p2"]["Authorization"][7:], lambda: ok(links(tc, w["p1"], m["team"]["id"], "link", [g["d"]["id"]])))
                assert frames == [{"type": "motivation.links", "motivation_id": m["team"]["id"], "swarm_id": w["t1"], "linked": [g["d"]["id"]], "unlinked": []}]
                assert [x["motivations"] for x in ok(tc.get("/api/tasks", headers=w["p2"], params={"q": "d"}))["items"]] == [[{"id": m["team"]["id"], "title": "team", "status": "active"}]]
            out.append(obs)
    return out


def test_paired_worlds_a_hidden_team_link_changes_nothing_p2_can_observe():
    one, two = _paired("hidden-team")
    assert one["events"] == two["events"] == []
    for key in one:
        assert normal(one[key]) == normal(two[key]), key


def test_paired_worlds_a_link_to_a_private_motivation_changes_nothing_p2_can_observe():
    one, two = _paired("private")
    assert one["events"] == two["events"] == []
    for key in one:
        assert normal(one[key]) == normal(two[key]), key


# ---- group=status (S4): counts plus a first page per status, each column on its own cursor ---------------------------

def test_group_status_pages_each_column_on_its_own_cursor(client):
    w = world(client)
    p1 = w["p1"]
    made = [goal(client, w["t1"], f"g{i}", priority=0.9 - i / 20) for i in range(4)]
    ok(client.patch(f"/api/goals/{made[3]['id']}", json={"status": "cancelled"}))
    grouped = ok(client.get("/api/tasks", headers=p1, params={"group": "status", "limit": 1}))
    assert grouped["counts"]["total"] == 4 and grouped["counts"]["by_status"]["open"] == 3 and grouped["counts"]["by_status"]["cancelled"] == 1
    assert list(grouped["groups"]) == ["open", "claimed", "waiting", "submitted", "stalled", "done", "failed", "cancelled"]
    assert ids(grouped["groups"]["cancelled"]["items"]) == [made[3]["id"]] and grouped["groups"]["cancelled"]["cursor"] is None
    column, cursor = ids(grouped["groups"]["open"]["items"]), grouped["groups"]["open"]["cursor"]
    while cursor:
        page = ok(client.get("/api/tasks", headers=p1, params={"group": "status", "limit": 1, "cursor": cursor}))
        assert page["group"] == "open"
        column += ids(page["items"])
        cursor = page["cursor"]
    assert column == [g["id"] for g in made[:3]]
    open_cursor = grouped["groups"]["open"]["cursor"]
    assert code(client.get("/api/tasks", headers=p1, params={"limit": 1, "cursor": open_cursor})) == "cursor_invalid"
    assert code(client.get("/api/tasks", headers=p1, params={"group": "status", "status": "cancelled", "limit": 1, "cursor": open_cursor})) == "cursor_invalid"
    only = ok(client.get("/api/tasks", headers=p1, params={"group": "status", "status": "open,cancelled"}))
    assert list(only["groups"]) == ["open", "cancelled"] and only["counts"]["total"] == 4


@pytest.mark.parametrize('width', [8, 32])
def test_paired_world_normalizer_preserves_equivalence_at_both_identifier_widths(width):
    for prefix in ('mo', 'g', 's', 'a', 'r', 'rq', 'req'):
        left = {'id': prefix + '_' + 'a' * width, 'same': prefix + '_' + 'a' * width}
        right = {'id': prefix + '_' + 'b' * width, 'same': prefix + '_' + 'b' * width}
        assert normal(left) == normal(right) == json.dumps({'id': 'ID0', 'same': 'ID0'}, sort_keys=True)


@pytest.mark.parametrize('width', [7, 9, 16, 31, 33])
def test_paired_world_normalizer_never_partially_replaces_an_unfamiliar_width(width):
    value = {'id': 'g_' + 'a' * width}
    assert normal(value) == json.dumps(value, sort_keys=True)
