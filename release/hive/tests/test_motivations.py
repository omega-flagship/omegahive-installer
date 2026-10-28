"""Motivations phase 1a: readable/editable, CRUD, mind creation (Q2), disabled parent_id (Q1), /api/tasks, cursors, the
motivation.updated rule, and the design 1.6 freeze (no motivation data on any old goal path). Synthetic data only."""
import asyncio
import base64
import hashlib
import hmac
import json
import pathlib
import re
import secrets

from hive.core.db import now
from hive.core.hive import token_hash
from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)

ADMIN = Viewer("user:operator", True)


def person(client, pid):
    hive = client.app.state.hive
    hive.db.insert("people", {"id": pid, "email": f"{pid}@example.test", "name": pid, "role": "member", "created_at": now()})
    token = secrets.token_urlsafe(24)
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": f"user:{pid}"})
    return {"Authorization": f"Bearer {token}"}


def ok(resp, status=200):
    assert resp.status_code == status, resp.text
    return resp.json()


def world(client):
    """P1 owns team T1 (shared with P2 and P3) and private team T2 (P1 only). P3 is a T1 member who is not its owner."""
    w = {"hive": client.app.state.hive, "p1": person(client, "u_p1"), "p2": person(client, "u_p2"), "p3": person(client, "u_p3"),
         "p4": person(client, "u_p4")}
    w["t1"] = ok(client.post("/api/swarms", headers=w["p1"], json={"name": "T1"}))["id"]
    ok(client.put(f"/api/swarms/{w['t1']}/visibility", headers=w["p1"], json={"visibility": "shared", "shared_with": ["user:u_p2", "user:u_p3"]}))
    w["t2"] = ok(client.post("/api/swarms", headers=w["p1"], json={"name": "T2"}))["id"]
    return w


def motivation(client, headers, **body):
    return ok(client.post("/api/motivations", headers=headers, json={"title": body.pop("title", "aim"), **body}))


def goal(client, swarm_id, title="task", priority=0.5, parent_id=None):
    return ok(client.post(f"/api/swarms/{swarm_id}/goals", json={"title": title, "priority": priority, "parent_id": parent_id}))


def link_db(hive, mid, gid):
    hive.db.execute("INSERT INTO motivation_tasks (motivation_id, goal_id, linked_by, linked_at) VALUES (?, ?, 'test', ?)", (mid, gid, now()))


def ids(items):
    return [i["id"] for i in items]


def kinds(w):
    """Every kind of motivation of design 8.1 case 2."""
    c, p1 = w["client"], w["p1"]
    return {"private": motivation(c, p1, title="private"),
            "shared": motivation(c, p1, title="shared", visibility="shared", shared_with=["user:u_p2"]),
            "public": motivation(c, p1, title="public", visibility="public"),
            "team_public": motivation(c, p1, title="team public", owner=f"swarm:{w['t1']}"),
            "team_private": motivation(c, p1, title="team private", owner=f"swarm:{w['t1']}", visibility="private"),
            "spanning": motivation(c, p1, title="spanning", visibility="shared", shared_with=["user:u_p2"])}


# ---- 8.1 cases 1 and 2: two people, two teams, every kind -----------------------------------------------------------

def test_every_kind_reads_only_where_it_should(client):
    w = world(client)
    w["client"] = client
    m = kinds(w)
    assert m["team_public"]["visibility"] == "public" and m["private"]["visibility"] == "private"
    assert m["spanning"]["swarm_id"] is None and m["team_public"]["swarm_id"] == w["t1"]
    seen = lambda h: set(ids(ok(client.get("/api/motivations", headers=h))["items"]))
    assert seen(w["p1"]) == {v["id"] for v in m.values()} - {m["team_private"]["id"]} | {m["team_private"]["id"]}
    assert seen(w["p2"]) == {m["shared"]["id"], m["public"]["id"], m["team_public"]["id"], m["spanning"]["id"]}
    assert seen(w["p3"]) == {m["public"]["id"], m["team_public"]["id"]}
    assert seen(w["p4"]) == {m["public"]["id"]}                       # sees no team: a team row needs its swarm
    assert seen({}) >= {v["id"] for v in m.values()}                   # the admin always sees
    # who may create what
    assert client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": f"swarm:{w['t1']}"}).json()["error"]["code"] == "owner_only"
    assert client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": f"swarm:{w['t2']}"}).status_code == 404
    assert client.post("/api/motivations", headers=w["p2"], json={"title": "x", "swarm_id": w["t2"]}).status_code == 404
    assert client.post("/api/motivations", json={"title": "operator is not a person"}).json()["error"]["code"] == "bad_scope"
    assert client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": "user:u_p1"}).json()["error"]["code"] == "owner_only"
    assert client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": f"agent:a_12345678"}).json()["error"]["code"] == "bad_scope"
    assert client.post("/api/motivations", headers=w["p1"], json={"title": "x", "owner": f"swarm:{w['t1']}", "swarm_id": w["t2"]}).json()["error"]["code"] == "bad_scope"
    assert client.post("/api/motivations", headers=w["p1"], json={"title": ""}).status_code == 400
    assert client.post("/api/motivations", headers=w["p1"], json={"title": "x" * 201}).status_code == 400
    assert client.post("/api/motivations", headers=w["p1"], json={"title": "x", "rev": 9}).status_code == 400
    made = ok(client.post("/api/motivations", json={"title": "for p2", "owner": "user:u_p2"}))      # an admin, for a person
    assert made["owner"] == "user:u_p2" and made["created_by"] == "user:operator"
    assert ok(client.post("/api/motivations", json={"title": "team", "owner": f"swarm:{w['t2']}"}))["owner"] == f"swarm:{w['t2']}"
    mine = ok(client.post("/api/motivations", headers=w["p2"], json={"title": "p2 in t1", "swarm_id": w["t1"]}))
    assert mine["owner"] == "user:u_p2" and mine["swarm_id"] == w["t1"] and mine["editable"] is True and "shared_with" in mine
    reader = ok(client.get(f"/api/motivations/{m['shared']['id']}", headers=w["p2"]))
    assert reader["editable"] is False and "shared_with" not in reader and "links_version" not in reader


# ---- 8.1 case 3: a guessed hidden id answers exactly as a missing one -------------------------------------------------

def test_guessed_hidden_ids_answer_as_missing(client):
    w = world(client)
    hidden = motivation(client, w["p1"], title="secret")["id"]
    team_hidden = motivation(client, w["p1"], title="t2 aim", owner=f"swarm:{w['t2']}")["id"]
    for mid in (hidden, team_hidden):
        for missing in ("mo_00000000", "mo_" + "f" * 8):
            for path in ("/api/motivations/{}", "/api/tasks?motivation={}"):
                a, b = client.get(path.format(mid), headers=w["p2"]), client.get(path.format(missing), headers=w["p2"])
                assert (a.status_code, a.json()) == (b.status_code, b.json()) == (404, b.json())
            a = client.patch(f"/api/motivations/{mid}", headers=w["p2"], json={"title": "x", "expected_rev": 1})
            b = client.patch(f"/api/motivations/{missing}", headers=w["p2"], json={"title": "x", "expected_rev": 1})
            assert (a.status_code, a.json()) == (b.status_code, b.json())
            a = client.put(f"/api/motivations/{mid}/visibility", headers=w["p2"], json={"visibility": "public", "expected_rev": 1})
            b = client.put(f"/api/motivations/{missing}/visibility", headers=w["p2"], json={"visibility": "public", "expected_rev": 1})
            assert (a.status_code, a.json()) == (b.status_code, b.json())
    hive = w["hive"]
    for mid in (hidden, team_hidden, "mo_00000000"):
        assert not hive.visibility.event_visible(Viewer("user:u_p2", False), json.dumps({"type": "motivation.updated", "motivation": {"id": mid}}))


# ---- 8.1 case 4: the private team owner ---------------------------------------------------------------------------

def test_private_team_motivation_follows_the_effective_owner(client):
    w = world(client)
    hive = w["hive"]
    mo = motivation(client, w["p1"], title="team private", owner=f"swarm:{w['t1']}", visibility="private")
    assert ok(client.get(f"/api/motivations/{mo['id']}", headers=w["p1"]))["editable"] is True
    ok(client.patch(f"/api/motivations/{mo['id']}", headers=w["p1"], json={"title": "owner edit", "expected_rev": 1}))
    for member in ("p2", "p3"):                                        # members of T1, not its owner
        assert client.get(f"/api/motivations/{mo['id']}", headers=w[member]).status_code == 404
        assert client.patch(f"/api/motivations/{mo['id']}", headers=w[member], json={"title": "x", "expected_rev": 2}).status_code == 404
    shared = motivation(client, w["p1"], title="team shared", owner=f"swarm:{w['t1']}", visibility="shared", shared_with=["user:u_p3"])
    assert client.get(f"/api/motivations/{shared['id']}", headers=w["p3"]).status_code == 200
    assert client.get(f"/api/motivations/{shared['id']}", headers=w["p2"]).status_code == 404
    hive.db.execute("UPDATE swarms SET owner = 'user:u_p3' WHERE id = ?", (w["t1"],))   # the swarm changes hands
    got = ok(client.get(f"/api/motivations/{mo['id']}", headers=w["p3"]))
    assert got["editable"] is True and got["title"] == "owner edit"
    ok(client.patch(f"/api/motivations/{mo['id']}", headers=w["p3"], json={"status": "paused", "expected_rev": 2}))
    assert client.get(f"/api/motivations/{mo['id']}", headers=w["p1"]).status_code == 404   # P1 no longer sees T1 at all
    hive.db.execute("UPDATE motivations SET owner = 'swarm:s_elsewhere' WHERE id = ?", (mo["id"],))   # inconsistent: fail closed
    assert client.get(f"/api/motivations/{mo['id']}", headers=w["p3"]).status_code == 404


# ---- 8.1 case 5: visibility tightening, mid-paging included --------------------------------------------------------

def test_tightening_removes_items_projections_and_events_at_once(client):
    w = world(client)
    hive, p2 = w["hive"], w["p2"]
    sh = motivation(client, w["p1"], title="shared", visibility="shared", shared_with=["user:u_p2"])
    tasks = [goal(client, w["t1"], f"t{i}", priority=0.9 - i / 10) for i in range(4)]
    for t in tasks[:2]:
        link_db(hive, sh["id"], t["id"])
    first = ok(client.get("/api/tasks", headers=p2, params={"motivation": "none", "limit": 1}))
    assert first["counts"]["total"] == 2 and ids(first["items"]) == [tasks[2]["id"]]
    by_mo = ok(client.get("/api/tasks", headers=p2, params={"motivation": sh["id"]}))
    assert ids(by_mo["items"]) == [tasks[0]["id"], tasks[1]["id"]]
    assert by_mo["items"][0]["motivations"] == [{"id": sh["id"], "title": "shared", "status": "active"}]
    published = []
    real = hive.events.publish
    hive.events.publish = lambda kind, **payload: (published.append(json.dumps({"type": kind, **payload})), real(kind, **payload))
    try:
        ok(client.put(f"/api/motivations/{sh['id']}/visibility", headers=w["p1"], json={"visibility": "private", "expected_rev": 1}))
    finally:
        hive.events.publish = real
    assert [json.loads(e)["type"] for e in published] == ["motivation.updated"]
    assert not hive.visibility.event_visible(Viewer("user:u_p2", False), published[0])
    assert hive.visibility.event_visible(Viewer("user:u_p1", False), published[0])
    assert client.get(f"/api/motivations/{sh['id']}", headers=p2).status_code == 404
    assert client.get("/api/tasks", headers=p2, params={"motivation": sh["id"]}).status_code == 404
    rest = ok(client.get("/api/tasks", headers=p2, params={"motivation": "none", "limit": 1, "cursor": first["cursor"]}))
    assert rest["counts"]["total"] == 4 and ids(rest["items"]) == [tasks[3]["id"]]   # page 2 judged now; counts shift with it
    assert all(i["motivations"] == [] for i in ok(client.get("/api/tasks", headers=p2))["items"])


# ---- 8.1 case 6: cursors -------------------------------------------------------------------------------------------

def _pages(client, headers, **params):
    out, cursor = [], None
    while True:
        page = ok(client.get("/api/tasks", headers=headers, params={**params, **({"cursor": cursor} if cursor else {})}))
        out += ids(page["items"])
        cursor = page["cursor"]
        if not cursor:
            return out


def _forge(token, mac_key=None, **changes):
    raw, tag = token.split(".")
    body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    body.update(changes)
    raw2 = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
    return raw2 + "." + (hmac.new(mac_key, raw2.encode(), "sha256").hexdigest() if mac_key else tag)


def test_cursors_continue_once_and_refuse_anything_edited(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    made = [goal(client, w["t1"] if i % 2 else w["t2"], f"c{i}", priority=[0.9, 0.5, 0.5, 0.5, 0.1, 0.7, 0.5][i]) for i in range(7)]
    full = ids(ok(client.get("/api/tasks", headers=p1, params={"limit": 200}))["items"])
    assert sorted(full) == sorted(ids(made)) and len(full) == 7
    assert _pages(client, p1, limit=2) == full                         # static: each exactly once, in the full order
    assert sorted(_pages(client, p1, limit=3, sort="updated")) == sorted(full)
    page = ok(client.get("/api/tasks", headers=p1, params={"limit": 2}))
    cur = page["cursor"]
    bad = lambda token, h=p1, **params: client.get("/api/tasks", headers=h, params={"limit": 2, "cursor": token, **params})
    assert bad(cur).status_code == 200
    assert bad(cur, q="c").json()["error"]["code"] == "cursor_invalid"            # filter-bound
    assert bad(cur, sort="updated").json()["error"]["code"] == "cursor_invalid"
    assert bad(cur, h=w["p2"]).json()["error"]["code"] == "cursor_invalid"         # principal-bound
    for edit in ({"key": [0.0, "2000-01-01T00:00:00.000Z", "g_0"]}, {"filter": "0" * 64}, {"principal": "user:u_p2"}, {"v": 2}):
        assert bad(_forge(cur, **edit)).json()["error"]["code"] == "cursor_invalid"
    assert bad(_forge(cur, mac_key=secrets.token_bytes(32), principal="user:u_p1")).json()["error"]["code"] == "cursor_invalid"   # another hive's key
    assert bad(cur[:-1] + ("0" if cur[-1] != "0" else "1")).json()["error"]["code"] == "cursor_invalid"
    assert bad("x" * 600).json()["error"]["code"] == "cursor_invalid" and bad("not-a-cursor").status_code == 400
    # mutated rows: a moved priority may repeat or skip that task only; nothing else is lost or repeated, nothing errors
    first = ids(page["items"])
    moved = next(g for g in made if g["id"] not in first)
    client.patch(f"/api/goals/{moved['id']}", json={"priority": 0.95})
    rest, c2 = [], cur
    while c2:
        p = ok(client.get("/api/tasks", headers=p1, params={"limit": 2, "cursor": c2}))
        rest += ids(p["items"])
        c2 = p["cursor"]
    others = [i for i in first + rest if i != moved["id"]]
    assert sorted(others) == sorted(set(full) - {moved["id"]}) and len(others) == len(set(others))
    # visibility is re-evaluated on page 2: P2 loses T1 between pages
    two = ok(client.get("/api/tasks", headers=w["p2"], params={"limit": 1}))
    assert two["cursor"]
    ok(client.put(f"/api/swarms/{w['t1']}/visibility", headers=p1, json={"visibility": "private"}))
    assert ok(client.get("/api/tasks", headers=w["p2"], params={"limit": 1, "cursor": two["cursor"]}))["items"] == []
    # the motivation list pages on the same kind of cursor
    for i in range(5):
        motivation(client, p1, title=f"m{i}")
    seen, cursor = [], None
    while True:
        page = ok(client.get("/api/motivations", headers=p1, params={"limit": 2, **({"cursor": cursor} if cursor else {})}))
        seen += ids(page["items"])
        cursor = page["cursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 5
    assert client.get("/api/motivations", headers=p1, params={"limit": 2, "status": "paused", "cursor": cur}).json()["error"]["code"] == "cursor_invalid"
    key = (pathlib.Path(hive.settings.data_dir) / "motivations-cursor.key")
    assert len(key.read_bytes()) == 32 and oct(key.stat().st_mode)[-3:] == "600"


def test_tasks_filters_check_what_they_name(client):
    w = world(client)
    hive, p2 = w["hive"], w["p2"]
    t1g, t2g = goal(client, w["t1"], "visible"), goal(client, w["t2"], "hidden")
    mind = ok(client.post("/api/agents", json={"name": "Seen", "swarm_id": w["t1"]}))
    hidden_mind = ok(client.post("/api/agents", json={"name": "Unseen", "swarm_id": w["t2"]}))
    ok(client.put(f"/api/agents/{mind['id']}/visibility", json={"visibility": "public"}))
    assert ids(ok(client.get("/api/tasks", headers=p2))["items"]) == [t1g["id"]]
    assert client.get("/api/tasks", headers=p2, params={"swarm": w["t2"]}).json() == client.get("/api/tasks", headers=p2, params={"swarm": "s_00000000"}).json()
    assert client.get("/api/tasks", headers=p2, params={"mind": hidden_mind["id"]}).json() == client.get("/api/tasks", headers=p2, params={"mind": "a_00000000"}).json()
    assert client.get("/api/tasks", headers=p2, params={"mind": hidden_mind["id"]}).status_code == 404
    hive.db.execute("UPDATE goals SET assignee = ? WHERE id = ?", (mind["id"], t1g["id"]))
    assert ids(ok(client.get("/api/tasks", headers=p2, params={"mind": mind["id"]}))["items"]) == [t1g["id"]]
    assert ids(ok(client.get("/api/tasks", headers=p2, params={"q": "visi"}))["items"]) == [t1g["id"]]
    assert ok(client.get("/api/tasks", headers=p2, params={"q": "%"}))["items"] == []
    assert ok(client.get("/api/tasks", headers=p2, params={"status": "done,claimed"}))["items"] == []
    for params in ({"status": "nope"}, {"sort": "random"}, {"group": "mind"}, {"limit": "0"}, {"limit": "201"}, {"q": "x" * 101}, {"top": "maybe"}):
        assert client.get("/api/tasks", headers=p2, params=params).status_code == 400, params
    child = goal(client, w["t1"], "child", parent_id=t1g["id"])
    assert ids(ok(client.get("/api/tasks", headers=p2, params={"top": "true"}))["items"]) == [t1g["id"]]
    assert set(ids(ok(client.get("/api/tasks", headers=p2))["items"])) == {t1g["id"], child["id"]}
    assert set(ids(ok(client.get("/api/tasks"))["items"])) == {t1g["id"], child["id"], t2g["id"]}   # admin: every swarm


# ---- 8.1 cases 8 and 9: aggregates from visible work only; hidden equals unlinked -----------------------------------

def test_a_shared_spanning_motivation_shows_nothing_from_a_hidden_team(client):
    w = world(client)
    hive, p2 = w["hive"], w["p2"]
    span = motivation(client, w["p1"], title="spanning", visibility="shared", shared_with=["user:u_p2"])
    a, b = goal(client, w["t1"], "in t1"), goal(client, w["t2"], "in t2")
    link_db(hive, span["id"], a["id"])
    before = ok(client.get(f"/api/motivations/{span['id']}", headers=p2))
    link_db(hive, span["id"], b["id"])
    after = ok(client.get(f"/api/motivations/{span['id']}", headers=p2))
    assert before == after and not ({"progress", "minds", "money", "last_activity_at", "links_version"} & set(after))
    got = ok(client.get("/api/tasks", headers=p2, params={"motivation": span["id"]}))
    assert ids(got["items"]) == [a["id"]] and got["counts"]["total"] == 1
    assert w["t2"] not in json.dumps(got) and b["id"] not in json.dumps(got)
    assert ok(client.get("/api/tasks", headers=w["p1"], params={"motivation": span["id"]}))["counts"]["total"] == 2


def test_for_p2_a_hidden_link_is_identical_to_no_link(client):
    w = world(client)
    hive, p2 = w["hive"], w["p2"]
    private = motivation(client, w["p1"], title="mine only")
    a, b = goal(client, w["t1"], "same", 0.5), goal(client, w["t1"], "same", 0.5)
    link_db(hive, private["id"], a["id"])
    items = {i["id"]: i for i in ok(client.get("/api/tasks", headers=p2))["items"]}
    strip = lambda i: {k: v for k, v in i.items() if k not in ("id", "created_at", "updated_at")}
    assert strip(items[a["id"]]) == strip(items[b["id"]]) and items[a["id"]]["motivations"] == []
    unsorted = ok(client.get("/api/tasks", headers=p2, params={"motivation": "none"}))
    assert set(ids(unsorted["items"])) == {a["id"], b["id"]} and unsorted["counts"]["total"] == 2
    assert ok(client.get("/api/tasks", headers=w["p1"], params={"motivation": "none"}))["counts"]["total"] == 1
    assert _pages(client, p2, motivation="none", limit=1) == ids(unsorted["items"])
    a_err = client.get("/api/tasks", headers=p2, params={"motivation": private["id"]})
    assert (a_err.status_code, a_err.json()) == (404, client.get("/api/tasks", headers=p2, params={"motivation": "mo_00000000"}).json())


# ---- content edits, revisions, the stale visibility write (8.1 case 12, last items), events ------------------------

def test_content_edits_bump_rev_and_a_stale_write_never_wins(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    mo = motivation(client, p1, title="first", visibility="shared", shared_with=["user:u_p2"])
    assert mo["rev"] == 1
    assert client.patch(f"/api/motivations/{mo['id']}", headers=p1, json={"title": "no rev"}).status_code == 400
    edited = ok(client.patch(f"/api/motivations/{mo['id']}", headers=p1, json={"title": "second", "why": "because", "expected_rev": 1}))
    assert edited["rev"] == 2 and edited["updated_at"] >= mo["updated_at"] and edited["why"] == "because"
    assert client.patch(f"/api/motivations/{mo['id']}", headers=p1, json={"title": "late", "expected_rev": 1}).json()["error"]["code"] == "motivation_changed"
    assert client.patch(f"/api/motivations/{mo['id']}", headers=p1, json={"status": "gone", "expected_rev": 2}).status_code == 400
    newer = ok(client.put(f"/api/motivations/{mo['id']}/visibility", headers=p1, json={"visibility": "private", "expected_rev": 2}))
    stale = client.put(f"/api/motivations/{mo['id']}/visibility", headers=p1, json={"visibility": "public", "expected_rev": 2})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "motivation_changed"
    now_row = ok(client.get(f"/api/motivations/{mo['id']}", headers=p1))
    assert now_row["visibility"] == "private" and now_row["rev"] == newer["rev"] == 3
    assert client.put(f"/api/motivations/{mo['id']}/visibility", headers=p1, json={"visibility": "public"}).status_code == 400
    assert client.put(f"/api/motivations/{mo['id']}/visibility", headers=p1, json={"shared_with": ["bob"], "expected_rev": 3}).status_code == 400
    retired = ok(client.patch(f"/api/motivations/{mo['id']}", headers=p1, json={"status": "retired", "expected_rev": 3}))
    assert retired["status"] == "retired" and retired["status_changed_at"]
    assert client.delete(f"/api/motivations/{mo['id']}", headers=p1).status_code in (404, 405)    # no delete: retired is the end
    team = motivation(client, p1, title="t2 team", owner=f"swarm:{w['t2']}")
    hive.archive_swarm(w["t2"], "user:operator")
    assert client.patch(f"/api/motivations/{team['id']}", headers=p1, json={"title": "x", "expected_rev": 1}).json()["error"]["code"] == "swarm_archived"
    assert client.post("/api/motivations", headers=p1, json={"title": "x", "owner": f"swarm:{w['t2']}"}).json()["error"]["code"] == "swarm_archived"


def test_motivation_updated_is_judged_against_the_stored_row(client):
    w = world(client)
    hive = w["hive"]
    published = []
    real = hive.events.publish
    hive.events.publish = lambda kind, **payload: (published.append((kind, payload)), real(kind, **payload))
    try:
        team = motivation(client, w["p1"], title="team", owner=f"swarm:{w['t1']}")
        ok(client.patch(f"/api/motivations/{team['id']}", headers=w["p1"], json={"why": "w", "expected_rev": 1}))
        ok(client.put(f"/api/motivations/{team['id']}/visibility", headers=w["p1"], json={"visibility": "private", "expected_rev": 2}))
        client.patch(f"/api/motivations/{team['id']}", headers=w["p1"], json={"why": "w", "expected_rev": 1})   # refused: no event
    finally:
        hive.events.publish = real
    mine = [(k, p) for k, p in published if k.startswith("motivation")]
    assert [k for k, _ in mine] == ["motivation.updated"] * 3
    assert set(mine[0][1]["motivation"]) == {"id", "title", "why", "owner", "swarm_id", "status", "visibility", "rev", "parent_id",
                                             "created_by", "created_at", "updated_at", "status_changed_at"}
    frame = json.dumps({"type": "motivation.updated", **mine[0][1]})
    assert hive.visibility.event_visible(Viewer("user:u_p1", False), frame)
    assert not hive.visibility.event_visible(Viewer("user:u_p3", False), frame)    # judged now: the row is private
    assert not hive.visibility.event_visible(Viewer("user:u_p4", False), frame)
    hive.db.execute("DELETE FROM motivations WHERE id = ?", (team["id"],))
    assert not hive.visibility.event_visible(Viewer("user:u_p1", False), frame)    # a missing row fails closed
    for broken in ({"type": "motivation.updated"}, {"type": "motivation.updated", "motivation": "mo_x"}, {"type": "motivation.updated", "motivation": {}}):
        assert not hive.visibility.event_visible(Viewer("user:u_p1", False), json.dumps(broken))


# ---- owner Q2: minds create, owned by themselves or their own swarm; they read back what they created ------------------

def test_minds_create_motivations_only_for_themselves_or_their_own_swarm(client):
    w = world(client)
    hive = w["hive"]
    ada = ok(client.post("/api/agents", json={"name": "Ada", "swarm_id": w["t1"]}))
    bea = ok(client.post("/api/agents", json={"name": "Bea", "swarm_id": w["t1"]}))
    a, b = agent_headers(ada), agent_headers(bea)
    own = ok(client.post("/api/agent/motivations", headers=a, json={"title": "learn MeTTa", "why": "to think", "operation_id": "ada-own-0001"}))["motivation"]
    team = ok(client.post("/api/agent/motivations", headers=a, json={"title": "ship it", "scope": "team", "operation_id": "ada-team-0001"}))["motivation"]
    assert (own["owner"], own["swarm_id"], own["created_by"], own["visibility"]) == (f"agent:{ada['id']}", w["t1"], f"agent:{ada['id']}", "public")
    assert (team["owner"], team["swarm_id"], team["created_by"]) == (f"swarm:{w['t1']}", w["t1"], f"agent:{ada['id']}")
    # spoofing: a person owner, a foreign swarm, a visibility or a creator is never accepted
    for spoof in ({"owner": "user:u_p1"}, {"swarm_id": w["t2"]}, {"owner": f"swarm:{w['t2']}"}, {"visibility": "private"},
                  {"shared_with": ["user:u_p2"]}, {"created_by": "user:u_p1"}, {"scope": "hive"}):
        r = client.post("/api/agent/motivations", headers=a, json={"title": "x", **spoof})
        assert r.status_code == 400 and r.json()["error"]["code"] == "bad_scope", spoof
    assert client.post("/api/agent/motivations", headers={"Authorization": "Bearer nope"}, json={"title": "x", "operation_id": "nope-0001"}).status_code == 401
    # self-read: the creator only, by its id; a teammate reads nothing of it
    assert set(ids(ok(client.get("/api/agent/motivations", headers=a))["motivations"])) == {team["id"], own["id"]}
    assert ok(client.get("/api/agent/motivations", headers=b))["motivations"] == []
    # people: swarm members read it (member-visible), with its creator; only the swarm's owner (or an admin) edits it
    got = ok(client.get(f"/api/motivations/{own['id']}", headers=w["p2"]))
    assert got["created_by"] == f"agent:{ada['id']}" and got["editable"] is False
    assert client.get(f"/api/motivations/{own['id']}", headers=w["p4"]).status_code == 404
    assert ok(client.get(f"/api/motivations/{team['id']}", headers=w["p1"]))["editable"] is True
    assert client.patch(f"/api/motivations/{team['id']}", headers=w["p3"], json={"title": "x", "expected_rev": 1}).status_code == 404
    ok(client.patch(f"/api/motivations/{own['id']}", headers=w["p1"], json={"status": "paused", "expected_rev": 1}))
    # replay: same key and body returns the first; another body conflicts
    body = {"title": "retry me", "operation_id": "mind-op-0001"}
    first = ok(client.post("/api/agent/motivations", headers=a, json=body))["motivation"]
    again = ok(client.post("/api/agent/motivations", headers=a, json=body))
    assert again["replayed"] is True and again["motivation"]["id"] == first["id"]
    assert client.post("/api/agent/motivations", headers=a, json={**body, "title": "other"}).json()["error"]["code"] == "operation_conflict"
    assert client.post("/api/agent/motivations", headers=b, json=body).status_code == 200      # keys are per mind
    # a swarm move: the replay is a conflict (its derived swarm changed), never a creation in the new swarm
    t3 = ok(client.post("/api/swarms", json={"name": "T3", "visibility": "public"}))["id"]
    ok(client.patch(f"/api/agents/{ada['id']}", json={"swarm_id": t3}))
    assert client.post("/api/agent/motivations", headers=a, json=body).json()["error"]["code"] == "operation_conflict"
    assert hive.db.one("SELECT COUNT(*) AS n FROM motivations WHERE swarm_id = ?", (t3,))["n"] == 0
    assert first["id"] in ids(ok(client.get("/api/agent/motivations", headers=a))["motivations"])   # still its own, by identity
    assert ok(client.post("/api/agent/motivations", headers=a, json={"title": "new home", "operation_id": "ada-home-0001"}))["motivation"]["swarm_id"] == t3
    # missing swarm, archived swarm, deleted mind
    loner = hive.create_agent("Loner", "module", None, "mock/echo", "", None, 0, None, None)
    assert client.post("/api/agent/motivations", headers=agent_headers(loner), json={"title": "x", "operation_id": "loner-0001"}).json()["error"]["code"] == "no_swarm"
    hive.archive_swarm(t3, "user:operator")
    assert client.post("/api/agent/motivations", headers=a, json={"title": "x", "operation_id": "ada-arch-0001"}).json()["error"]["code"] == "swarm_archived"
    hive.delete_agent(bea["id"])
    assert client.post("/api/agent/motivations", headers=b, json={"title": "x", "operation_id": "bea-gone-0001"}).status_code == 401
    # the creation transaction re-reads the mind: a mind deleted after authentication creates nothing
    m = hive.motivations
    gone = dict(ada, id="a_deadbeef")
    try:
        m.agent_create(gone, {"title": "x", "operation_id": "gone-0001"})
        raise AssertionError("created for a missing mind")
    except Exception as exc:
        assert getattr(exc, "status", None) == 401


def test_the_mcp_tools_create_and_read_back_only_own_motivations(client):
    w = world(client)
    hive = w["hive"]
    ada = hive.create_agent("Ada", "module", w["t1"], "mock/echo", "", None, 0, None, None)
    bea = hive.create_agent("Bea", "module", w["t1"], "mock/echo", "", None, 0, None, None)
    call = lambda agent, name, args: asyncio.run(hive.harnesses.call(agent, name, args))
    made = call(ada, "hive_motivation_create", {"title": "via mcp", "scope": "team", "operation_id": "mcp-team-0001"})["motivation"]
    assert made["owner"] == f"swarm:{w['t1']}" and made["created_by"] == f"agent:{ada['id']}"
    assert ids(call(ada, "hive_motivations", {})["motivations"]) == [made["id"]]
    assert call(bea, "hive_motivations", {})["motivations"] == []
    for spoof in ({"owner": "user:u_p1"}, {"swarm_id": w["t2"]}, {"parent_id": "mo_00000000"}, {"operation_id": "short"}):
        try:
            call(ada, "hive_motivation_create", {"title": "x", **spoof})
            raise AssertionError(spoof)
        except Exception as exc:
            assert getattr(exc, "status", None) == 400, spoof
    from hive.core import mcp
    names = {t["name"]: t for t in mcp.TOOLS}
    assert {"hive_motivation_create", "hive_motivations"} <= set(names)
    assert "tasks (goals)" in names["hive_goals"]["description"] and "task (goal)" in names["hive_goal_create"]["description"]
    assert hive.policy.decide(ada, "hive-motivation-create")[0] == "allow"


# ---- owner Q1: parent_id exists, refused everywhere while the setting is off ------------------------------------------

def test_parent_id_is_refused_by_every_route_while_switched_off(client):
    w = world(client)
    hive = w["hive"]
    assert hive.settings.motivation_hierarchy is False
    parent = motivation(client, w["p1"], title="parent")
    assert parent["parent_id"] is None
    ada = ok(client.post("/api/agents", json={"name": "Ada", "swarm_id": w["t1"]}))
    refusals = [client.post("/api/motivations", headers=w["p1"], json={"title": "c", "parent_id": parent["id"]}),
                client.post("/api/motivations", headers=w["p1"], json={"title": "c", "parent_id": None}),
                client.patch(f"/api/motivations/{parent['id']}", headers=w["p1"], json={"parent_id": parent["id"], "expected_rev": 1}),
                client.put(f"/api/motivations/{parent['id']}/visibility", headers=w["p1"], json={"parent_id": None, "expected_rev": 1}),
                client.post("/api/agent/motivations", headers=agent_headers(ada), json={"title": "c", "parent_id": parent["id"]}),
                client.post(f"/api/motivations/{parent['id']}/links", headers=w["p1"], json={"parent_id": parent["id"]})]
    assert [r.json()["error"]["code"] for r in refusals] == ["parent_disabled"] * 6
    assert hive.db.one("SELECT COUNT(*) AS n FROM motivations WHERE parent_id IS NOT NULL")["n"] == 0
    # switched on (not this phase's default): same owner and scope, two levels, never re-parented by PATCH
    hive.settings.motivation_hierarchy = True
    child = ok(client.post("/api/motivations", headers=w["p1"], json={"title": "child", "parent_id": parent["id"]}))
    assert child["parent_id"] == parent["id"]
    assert client.post("/api/motivations", headers=w["p1"], json={"title": "g", "parent_id": child["id"]}).json()["error"]["code"] == "too_deep"
    assert client.post("/api/motivations", headers=w["p1"], json={"title": "t", "owner": f"swarm:{w['t1']}", "parent_id": parent["id"]}).json()["error"]["code"] == "bad_parent"
    assert client.post("/api/motivations", headers=w["p2"], json={"title": "t", "parent_id": parent["id"]}).status_code == 404
    assert client.patch(f"/api/motivations/{child['id']}", headers=w["p1"], json={"parent_id": None, "expected_rev": 1}).json()["error"]["code"] == "parent_fixed"


# ---- 8.1 case 10: zero motivation metadata on every old goal path (design 1.6 freeze) --------------------------------

OLD_PATHS = ("goals.py", "boards.py", "programs.py", "mcp.py", "collab.py", "sessions.py", "delegation.py", "code.py", "flows.py")


def test_no_old_goal_serialiser_reads_the_motivation_tables():
    core = pathlib.Path(__file__).resolve().parents[1] / "core"
    for name in OLD_PATHS:
        text = (core / name).read_text()
        assert not re.search(r"motivation_tasks|motivation_ops|FROM\s+motivations|JOIN\s+motivations", text), name
    readers = {f.name for f in core.glob("*.py") if re.search(r"motivation_tasks|FROM\s+motivations", f.read_text())}
    assert readers == {"motivations.py"}, readers


def snapshot(client, w, gid, agent, program_ctx):
    hive = client.app.state.hive
    call = lambda name, args: asyncio.run(hive.harnesses.call(hive.db.one("SELECT * FROM agents WHERE id = ?", (agent["id"],)), name, args))
    return {"view": hive.goals.view(hive.goals.get(gid)), "view_full": hive.goals.view_full(hive.goals.get(gid)),
            "list": hive.goals.list(w["t1"]), "for_agent": hive.goals.for_agent(agent, gid),
            "http_list": ok(client.get(f"/api/swarms/{w['t1']}/goals")), "http_get": ok(client.get(f"/api/goals/{gid}")),
            "agent_list": ok(client.get("/api/agent/goals", headers=agent_headers(agent), params={"status": ""})),
            "agent_get": ok(client.get(f"/api/agent/goals/{gid}", headers=agent_headers(agent))),
            "board": ok(client.get("/api/boards/swarm", params={"entity_id": w["t1"]})),
            "own_board": ok(client.get("/api/agent/board", headers=agent_headers(agent))),
            "ctx_goals": program_ctx.goals(), "ctx_goal": program_ctx.goal(gid),
            "mcp_goals": call("hive_goals", {"status": "all"}), "mcp_get": call("hive_goal_get", {"goal_id": gid}),
            "mcp_summary": hive.harnesses._result("hive_goal_get", call("hive_goal_get", {"goal_id": gid}))}


def test_old_goal_outputs_are_byte_identical_with_and_without_links(client):
    from hive.core.programs import ProgramContext
    w = world(client)
    hive = w["hive"]
    agent = ok(client.post("/api/agents", json={"name": "Freeze", "swarm_id": w["t1"]}))
    g, h = goal(client, w["t1"], "linked"), goal(client, w["t1"], "never linked")
    ctx = ProgramContext(hive, w["t1"], {"id": "demo", "capabilities": ["goals:read"]})
    before = snapshot(client, w, g["id"], agent, ctx)
    for mo in (motivation(client, w["p1"], title="personal"), motivation(client, w["p1"], title="team", owner=f"swarm:{w['t1']}")):
        link_db(hive, mo["id"], g["id"])
    after = snapshot(client, w, g["id"], agent, ctx)
    assert json.dumps(before, sort_keys=True, default=str) == json.dumps(after, sort_keys=True, default=str)
    assert "motiv" not in json.dumps(after, default=str)
    # write paths and the goal.updated broadcast: the linked goal's outputs have the unlinked goal's exact key sets
    published = []
    real = hive.events.publish
    hive.events.publish = lambda kind, **payload: (published.append((kind, payload)), real(kind, **payload))
    try:
        outs = {}
        for x in (g, h):
            outs[x["id"]] = [ok(client.post(f"/api/agent/goals/{x['id']}/claim", headers=agent_headers(agent))),
                             ok(client.post(f"/api/agent/goals/{x['id']}/heartbeat", headers=agent_headers(agent))),
                             ok(client.patch(f"/api/goals/{x['id']}", json={"priority": 0.7}))]
    finally:
        hive.events.publish = real
    assert [sorted(o) for o in outs[g["id"]]] == [sorted(o) for o in outs[h["id"]]]
    events = [p for k, p in published if k == "goal.updated"]
    assert events and {json.dumps(sorted(e["goal"])) for e in events} == {json.dumps(sorted(events[0]["goal"]))}
    assert "motiv" not in json.dumps([outs, published], default=str)
