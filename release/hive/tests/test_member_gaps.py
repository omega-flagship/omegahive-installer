# Purpose: pins who may switch and reload apps, start and cancel Lab runs and add to a swarm's vocabulary, by its route or
# by a mind's publishing, and that no HTTP route takes the session token from the URL (omega-flagship/omegahive#299,
# item 4).
"""Members' gaps from the second review (#299, item 4), each as the rule it now follows:

- Apps: reload, enable and disable are an admin's, as installing and uninstalling are; anyone else gets 403
  admin_only and nothing changes.
- Lab: starting and cancelling a run is an admin's, since a run uses the hive's machine and its whole environment;
  every read stays open, and each suite says may_run.
- Vocabulary: adding a term acts on the swarm (the vocabulary decides which statements its commons admits), so it is
  the swarm's owner's, its person's or an admin's; a person who only sees the swarm gets 403 owner_only. Swarm views
  carry that answer as may_control. A mind's publishing grows the vocabulary only when the mind acts for one of them;
  any other mind publishes in the vocabulary as it stands.
- Sign-in: HTTP routes read the session from the Authorization header only; the events WebSocket alone takes ?token=.
"""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

ANN, BOB, CY = "u_a2990001", "u_b2990002", "u_c2990003"
APP = "contract-fixture"   # a built-in app every test hive loads


def code(response):
    return response.status_code, (response.json().get("error") or {}).get("code") if response.status_code >= 400 else None


@pytest.fixture()
def h(client):  # noqa: F811
    """Ann is an admin; Bob and Cy are members. Bob owns a public swarm Cy sees, and a private one Cy does not."""
    ann, bob, cy = person(client, ANN, role="admin"), person(client, BOB), person(client, CY)
    shared = client.post("/api/swarms", headers=bob, json={"name": "Bob's commons", "visibility": "public"}).json()
    private = client.post("/api/swarms", headers=bob, json={"name": "Bob's notes"}).json()
    assert shared["visibility"] == "public" and private["visibility"] == "private"
    return SimpleNamespace(client=client, hive=client.app.state.hive, ann=ann, bob=bob, cy=cy, shared=shared,
                           private=private)


def app_enabled(h):
    return {p["id"]: p["enabled"] for p in h.client.get("/api/programs").json()}[APP]


# ---- apps ---------------------------------------------------------------------------------------------------------

def test_only_an_admin_switches_or_reloads_apps(h):
    c = h.client
    assert app_enabled(h) is True
    for path in (f"/api/programs/{APP}/disable", f"/api/programs/{APP}/enable", "/api/programs/reload"):
        assert code(c.post(path, headers=h.bob)) == (403, "admin_only"), path
    assert app_enabled(h) is True                                       # the member's disable changed nothing
    assert c.post(f"/api/programs/{APP}/disable", headers=h.ann).json()["enabled"] is False
    assert code(c.post(f"/api/programs/{APP}/enable", headers=h.bob)) == (403, "admin_only")
    assert app_enabled(h) is False                                      # nor did the member's enable
    assert c.post(f"/api/programs/{APP}/enable", headers=h.ann).json()["enabled"] is True
    assert APP in {p["id"] for p in c.post("/api/programs/reload", headers=h.ann).json()}


def test_a_members_reload_cannot_bring_back_an_app_an_admin_uninstalled(h):
    """Uninstalling leaves the app's files, so a reload would find the app again: that is an admin's call."""
    c = h.client
    assert c.delete(f"/api/programs/{APP}", headers=h.ann).status_code == 200
    assert code(c.post("/api/programs/reload", headers=h.bob)) == (403, "admin_only")
    assert APP not in {p["id"] for p in c.get("/api/programs").json()}


# ---- the Lab ------------------------------------------------------------------------------------------------------

def test_only_an_admin_starts_or_cancels_a_lab_run_and_everyone_reads(h, monkeypatch):
    c, lab = h.client, h.hive.lab
    started = []
    monkeypatch.setattr(lab, "_execute", lambda run_id, suite_id: started.append(suite_id))   # no bench process
    assert code(c.post("/api/lab/runs", headers=h.bob, json={"suite": "bench-drift"})) == (403, "admin_only")
    assert lab.runs() == [] and started == []                           # nothing was started
    run = c.post("/api/lab/runs", headers=h.ann, json={"suite": "bench-drift"}).json()
    assert run["status"] == "running" and [r["id"] for r in lab.runs()] == [run["id"]]
    assert code(c.post(f"/api/lab/runs/{run['id']}/cancel", headers=h.bob)) == (403, "admin_only")
    # an admin passes the guard and meets the route's own answer: the stand-in run has no process to stop
    assert code(c.post(f"/api/lab/runs/{run['id']}/cancel", headers=h.ann)) == (409, "not_running")
    # reading stays open to members, and each suite says whether this person may start and cancel it
    for path in ("/api/lab/suites", "/api/lab/runs", f"/api/lab/runs/{run['id']}", "/api/lab/scorecard",
                 "/api/lab/history/bench-drift"):
        assert c.get(path, headers=h.bob).status_code == 200, path
    assert {s["may_run"] for s in c.get("/api/lab/suites", headers=h.bob).json()} == {False}
    assert {s["may_run"] for s in c.get("/api/lab/suites", headers=h.ann).json()} == {True}


# ---- a swarm's vocabulary -----------------------------------------------------------------------------------------

def test_adding_vocabulary_is_the_swarms_owners_its_persons_or_an_admins(h):
    c, sid = h.client, h.shared["id"]

    def add(who, term):
        return c.post(f"/api/swarms/{sid}/vocab", headers=who, json={"terms": [term]})

    assert code(add(h.cy, "ivy")) == (403, "owner_only")                # Cy sees the public swarm and does not own it
    assert c.get(f"/api/swarms/{sid}/vocab", headers=h.cy).json() == []   # reading it stays open, and nothing was added
    assert add(h.bob, "oak").json() == ["oak"]                          # its owner
    assert add(h.ann, "elm").json() == ["elm", "oak"]                   # an admin
    h.hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (f"user:{CY}", sid))
    assert add(h.cy, "ivy").json() == ["elm", "ivy", "oak"]             # its person (Viewer.controls' personal_of)
    private = c.post(f"/api/swarms/{h.private['id']}/vocab", headers=h.cy, json={"terms": ["x"]})
    assert code(private) == (404, "not_found")                          # a swarm Cy cannot see is not found, as before


def test_may_control_on_swarm_views_is_exactly_what_the_vocabulary_route_decides(h):
    c = h.client
    for name, who in (("ann", h.ann), ("bob", h.bob), ("cy", h.cy)):
        listed = {s["id"]: s for s in c.get("/api/swarms", headers=who).json()}
        assert {h.shared["id"]} <= set(listed), name
        for sid, view in listed.items():
            one = c.get(f"/api/swarms/{sid}", headers=who).json()
            added = c.post(f"/api/swarms/{sid}/vocab", headers=who, json={"terms": [f"t{name}"]})
            assert added.status_code in (200, 403), added.text
            assert view["may_control"] is one["may_control"] is (added.status_code == 200), (name, sid, added.text)
    assert c.get(f"/api/swarms/{h.shared['id']}", headers=h.cy).json()["may_control"] is False


def test_a_minds_publishing_grows_the_vocabulary_only_for_someone_who_controls_the_swarm(h):
    """Putting a mind in a swarm takes only sight of it, and the mind may publish there (finish_agent grants it the
    commons), so a mind of Cy's in Bob's public swarm added its statements' words to the vocabulary as it published,
    past the route's 403. A mind grows the vocabulary only when it acts for someone who controls the swarm, as the route
    decides for people; any other mind publishes in the vocabulary as it stands, and a statement with a word outside it
    is quarantined, naming the word, until the swarm's control adds it."""
    c, sid = h.client, h.shared["id"]

    def mind(who, name):
        made = c.post("/api/agents", headers=who, json={"name": name, "swarm_id": sid})
        assert made.status_code == 200, made.text
        return {"Authorization": f"Bearer {made.json()['token']}"}

    def publish(as_mind, statement):
        out = c.post("/api/agent/publish", headers=as_mind, json={"statement": statement, "f": 0.9, "c": 0.8})
        assert out.status_code == 200, out.text
        return out.json()["outcome"], out.json().get("unmapped", [])

    def vocabulary():
        return c.get(f"/api/swarms/{sid}/vocab", headers=h.cy).json()

    cys, bobs, anns = mind(h.cy, "Cy's scout"), mind(h.bob, "Bob's scribe"), mind(h.ann, "Ann's reader")
    assert publish(cys, "(--> ivy plant)") == ("quarantined", ["ivy", "plant"])   # sight let Cy put a mind here, no more
    assert vocabulary() == []
    assert publish(bobs, "(--> oak tree)") == ("adopted", [])                     # the owner's mind grows it
    assert publish(anns, "(--> elm tree)") == ("adopted", [])                     # and an admin's
    assert vocabulary() == ["elm", "oak", "tree"]
    assert publish(cys, "(--> elm oak)") == ("adopted", [])                       # Cy's mind speaks the words there are
    assert c.post(f"/api/swarms/{sid}/vocab", headers=h.bob, json={"terms": ["ivy", "plant"]}).status_code == 200
    assert publish(cys, "(--> ivy plant)") == ("adopted", [])                     # and Cy's own once the owner adds them
    h.hive.db.execute("UPDATE swarms SET personal_of = ? WHERE id = ?", (f"user:{CY}", sid))
    assert publish(cys, "(--> fern plant)") == ("adopted", [])                    # its person's mind (Viewer.controls)
    h.hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", (BOB,))
    assert publish(bobs, "(--> pine tree)") == ("quarantined", ["pine"])          # a disabled owner controls nothing now
    assert vocabulary() == ["elm", "fern", "ivy", "oak", "plant", "tree"]


# ---- the session token ---------------------------------------------------------------------------------------------

def test_no_http_route_takes_the_session_token_from_the_url(h):
    """A token in a URL is kept by proxy logs, browser history and Referer headers. Only the events WebSocket reads
    ?token=, since a browser cannot set a header there (API.md, Auth)."""
    c, team = h.client, h.shared["id"]
    token = c.headers["Authorization"].split(" ", 1)[1]                 # the hive's own sign-in, which each route takes
    anonymous = TestClient(c.app)                                       # sends no Authorization header at all
    for method, path in (("get", "/api/hive"),                           # read through operator()
                         ("get", "/api/me/decisions"),                   # through p4b_person()
                         ("post", f"/api/teams/{team}/children/a_none/control")):   # team_child_control's own read
        assert code(getattr(anonymous, method)(f"{path}?token={token}")) == (401, "unauthorized"), path
        assert getattr(c, method)(path).status_code != 401, path         # the same token, as a header
    with anonymous.websocket_connect(f"/api/events?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"
