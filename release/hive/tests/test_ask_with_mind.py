"""Purpose: an Ask turn made while the person uses a mind's chat or card answers as that mind (Jon, 16 Nov: "the ask
will auto route to whichever mind you're interacting with").

Invented lives only: Ann (user:u_ann) and her own mind, renamed Taiga here; the test world's swarm Home with its
coordinator Orchestra and a mind called Worker.
- with Worker in use (context `with`), the turn is routed to Home (its coordinator holds the thread, the money and the
  limits) and speaks as Worker: the system prompt, the accepted frame and the turn view all name Worker;
- with nothing in use, a turn still speaks as Taiga; a mind named in the words still routes "about" it, in Taiga's voice;
- Taiga in use is a turn with her own mind; a mind she can't see, an external member, or one in a swarm the Ask may not
  use routes as if nothing were in use;
- a hive without the conductor routes as if nothing were in use, since only the conductor speaks as that mind;
- the context's `with` is shape-checked like `mind`.
"""
import json

from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, closed, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_personal_mind_ask import _on


def _world(client, monkeypatch):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    hive.db.execute("UPDATE agents SET name = 'Taiga' WHERE id = ?", (w["mine"]["id"],))
    hive.db.execute("UPDATE agents SET persona = 'Worker builds garden tools.' WHERE id = ?", (w["worker"]["id"],))
    # the coordinator answers on the host's priced key (_on): a $5 cap of its own, so a swarm turn reaches the model
    hive.db.execute("UPDATE agents SET budget_usd = 5 WHERE id = ?", (w["coord"]["id"],))
    return w


def _system(body):
    return body["messages"][0]["content"][0]["text"]


def _named(mind):
    return {"mind_id": mind["id"], "name": mind["name"]}


def test_with_worker_in_use_the_turn_is_routed_to_its_swarm_and_speaks_as_worker(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive, worker = w["hive"], w["worker"]
    s = script(client, Script("Worker here: the planner is nearly done."))
    r = ask(client, w["ann"], "op-with-worker-1", text="how is the planner going?", context={"with": worker["id"], "route": "hive"})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["thread"]["mind"]["id"] == w["coord"]["id"]           # the swarm's coordinator holds the turn, as before
    assert body["acting_as"] is None and body["speaks_as"] == _named(worker)
    wait(hive, "op-with-worker-1", closed)
    system = _system(s.bodies[0])
    assert "You are Worker, a mind in OmegaHive, in the swarm Home" in system and "Worker builds garden tools." in system
    assert "You are Taiga" not in system
    assert client.get("/api/ask/op-with-worker-1", headers=w["ann"]).json()["speaks_as"] == _named(worker)
    frames = [json.loads(row["frame"]) for row in hive.db.all(
        "SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (body["turn_id"],))]
    assert next(f for f in frames if f["phase"] == "accepted")["speaks_as"] == _named(worker)


def test_with_nothing_in_use_or_a_mind_named_in_the_words_the_turn_speaks_as_her_own_mind(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive, worker, mine = w["hive"], w["worker"], w["mine"]
    taiga = {"mind_id": mine["id"], "name": "Taiga"}
    script(client, Script("ok", repeat_last=True))
    plain = ask(client, w["ann"], "op-with-none-01", context={"swarm_id": w["swarm"]["id"]}).json()
    assert plain["speaks_as"] == taiga
    wait(hive, "op-with-none-01", closed)
    about = ask(client, w["ann"], "op-with-about-1", text="what is Worker doing?", context={"mind": worker["id"], "with": worker["id"]}).json()
    assert about["speaks_as"] == taiga                                  # named in the words: asked about, not addressed
    wait(hive, "op-with-about-1", closed)


def test_her_own_mind_in_use_is_a_turn_with_her_own_mind(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    script(client, Script("Taiga here."))
    r = ask(client, w["ann"], "op-with-own-001", context={"with": mine["id"]}).json()
    assert r["thread"]["mind"]["id"] == mine["id"] and r["acting_as"]["mind_id"] == mine["id"]
    assert r["speaks_as"] == {"mind_id": mine["id"], "name": "Taiga"}
    wait(hive, "op-with-own-001", closed)


def test_a_mind_in_use_the_ask_cannot_reach_is_passed_over(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    taiga = {"mind_id": mine["id"], "name": "Taiga"}
    hushed = client.post("/api/agents", json={"name": "Hushed", "swarm_id": w["swarm"]["id"]}).json()
    hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = ?", (hushed["id"],))
    module = client.post("/api/agents", json={"name": "Outside", "kind": "module", "swarm_id": w["swarm"]["id"]}).json()
    client.put(f"/api/agents/{module['id']}/visibility", json={"visibility": "shared", "shared_with": ["user:u_ann"]})
    other_swarm = client.post("/api/swarms", json={"name": "Elsewhere", "visibility": "public"}).json()   # Ann is not in it
    stranger = client.post("/api/agents", json={"name": "Stranger", "swarm_id": other_swarm["id"]}).json()
    client.put(f"/api/agents/{stranger['id']}/visibility", json={"visibility": "public"})
    script(client, Script("ok", repeat_last=True))
    for i, in_use in enumerate((hushed["id"], module["id"], stranger["id"])):
        r = ask(client, w["ann"], f"op-with-pass-{i:02d}", context={"with": in_use})
        assert r.status_code == 202, r.text
        assert r.json()["thread"]["mind"]["id"] == mine["id"] and r.json()["speaks_as"] == taiga
        wait(hive, f"op-with-pass-{i:02d}", closed)


def test_without_the_conductor_the_mind_in_use_routes_nothing(client, monkeypatch):
    # only the conductor can speak as the mind in use (personal.speaker), so a hive without it routes as if no chat were
    # open: never to Worker's swarm, whose coordinator would answer in its own voice
    w = _on(client, monkeypatch, conductor=False)
    r = ask(client, w["ann"], "op-with-off-001", context={"with": w["worker"]["id"]})
    assert w["coord"]["id"] not in r.text, r.text


def test_with_is_shape_checked_like_mind(client, monkeypatch):
    w = _world(client, monkeypatch)
    for i, bad in enumerate((3, "", "x" * 201, {"id": w["worker"]["id"]})):
        r = ask(client, w["ann"], f"op-with-bad-{i:02d}", context={"with": bad})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", (bad, r.text)
