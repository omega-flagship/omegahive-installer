"""Purpose: an Ask turn made while the person uses a mind's chat or card answers as that mind (Jon, 16 Nov: "the ask
will auto route to whichever mind you're interacting with").

Invented lives only: Ann (user:u_ann) and her own mind, renamed Taiga here; Bob (user:u_bob) and his own mind; the test
world's swarm Home with its coordinator Orchestra and a mind called Worker.
- with Worker in use (context `with`), the turn is routed to Home (its coordinator holds the thread, the money and the
  limits) and speaks as Worker: the system prompt, the accepted frame and the turn view all name Worker;
- with nothing in use, a turn still speaks as Taiga; a mind named in the words still routes "about" it, in Taiga's voice;
- Taiga in use is a turn with her own mind; a mind she can't see, an external member, one in a swarm the Ask may not
  use, or another person's own mind (Bob's, even shared with her in a swarm she's in) routes as if nothing were in use,
  and Bob's own mind never speaks for her turn;
- a hive without the conductor routes as if nothing were in use, since only the conductor speaks as that mind;
- the context's `with` is shape-checked like `mind`;
- a mind she chose (context `chosen` beside `mind`: her pick in the Ask, or @Name) speaks, Worker or the swarm's
  coordinator for a swarm she picked, while a mind only named in the words doesn't; a chosen mind she can't see, or
  Bob's own mind, refuses the turn and is never spoken as; `chosen` is only ever true, and only beside `mind`. A tester
  on v0.38 picked Create in the Ask and her own mind answered.
"""
import json

from hive.core.visibility import Viewer
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
    # another person's own mind, with everything else open to Ann: Bob's own swarm and mind both shared with her, so she
    # sees the mind and takes part in its swarm. Only the personal rule passes it over: routing refuses it (it coordinates
    # Bob's own swarm, and a personal mind answers its own person only), and so does speaking (personal.may_speak_with)
    bobs = hive.personal.ensure("user:u_bob")
    for table, row_id in (("swarms", bobs["swarm_id"]), ("agents", bobs["id"])):
        hive.db.execute(f"UPDATE {table} SET visibility = 'shared', shared_with = ? WHERE id = ?",
                        (json.dumps(["user:u_ann"]), row_id))
    ann, bobs, bobs_swarm = Viewer("user:u_ann", False), hive.ask._mind(bobs["id"]), hive.ask._swarm(bobs["swarm_id"])
    assert ann.sees(bobs) and ann.sees(bobs_swarm) and hive.ask.participates(ann, bobs_swarm)
    assert not hive.personal.may_speak_with("user:u_ann", bobs, bobs)
    assert hive.personal.speaker("user:u_ann", bobs, True, bobs)["id"] == mine["id"]
    script(client, Script("ok", repeat_last=True))
    for i, in_use in enumerate((hushed["id"], module["id"], stranger["id"], bobs["id"])):
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


def test_a_mind_she_chose_speaks_and_a_mind_only_named_does_not(client, monkeypatch):
    # a tester on v0.38 picked Create in the Ask, and her own mind answered: a chosen mind speaks, under its swarm's
    # coordinator's thread, money and limits, as the mind in use does
    w = _world(client, monkeypatch)
    hive, worker, mine = w["hive"], w["worker"], w["mine"]
    script(client, Script("ok", repeat_last=True))
    chose = ask(client, w["ann"], "op-chose-work-1", text="how is the planner going?", context={"mind": worker["id"], "chosen": True}).json()
    assert chose["thread"]["mind"]["id"] == w["coord"]["id"] and chose["speaks_as"] == _named(worker)
    wait(hive, "op-chose-work-1", closed)
    named = ask(client, w["ann"], "op-chose-name-1", text="what is Worker doing?", context={"mind": worker["id"]}).json()
    assert named["speaks_as"] == {"mind_id": mine["id"], "name": "Taiga"}   # named in the words: asked about
    wait(hive, "op-chose-name-1", closed)
    # a swarm she picked: its coordinator, chosen, speaks for it
    swarm = ask(client, w["ann"], "op-chose-swrm-1", context={"mind": w["coord"]["id"], "swarm_id": w["swarm"]["id"], "chosen": True}).json()
    assert swarm["thread"]["mind"]["id"] == w["coord"]["id"] and swarm["speaks_as"] == _named(w["coord"])
    wait(hive, "op-chose-swrm-1", closed)


def test_a_chosen_mind_she_cannot_reach_refuses_the_turn_and_is_never_spoken_as(client, monkeypatch):
    w = _world(client, monkeypatch)
    hive = w["hive"]
    script(client, Script("ok", repeat_last=True))
    hushed = client.post("/api/agents", json={"name": "Hushed", "swarm_id": w["swarm"]["id"]}).json()
    hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = ?", (hushed["id"],))
    # Bob's own mind and swarm, both shared with Ann: she sees the mind, and still may not choose it
    bobs = hive.personal.ensure("user:u_bob")
    for table, row_id in (("swarms", bobs["swarm_id"]), ("agents", bobs["id"])):
        hive.db.execute(f"UPDATE {table} SET visibility = 'shared', shared_with = ? WHERE id = ?",
                        (json.dumps(["user:u_ann"]), row_id))
    for i, mind in enumerate((hushed["id"], bobs["id"])):
        r = ask(client, w["ann"], f"op-chose-deny-{i}", context={"mind": mind, "chosen": True})
        assert r.status_code >= 400, r.text
        assert hive.db.one("SELECT 1 FROM ask_turns WHERE operation_id = ?", (f"op-chose-deny-{i}",)) is None


def test_chosen_is_only_ever_true_and_only_beside_mind(client, monkeypatch):
    w = _world(client, monkeypatch)
    for i, ctx in enumerate(({"chosen": True}, {"with": w["worker"]["id"], "chosen": True},
                             {"mind": w["worker"]["id"], "chosen": False}, {"mind": w["worker"]["id"], "chosen": "yes"},
                             {"mind": w["worker"]["id"], "chosen": 1}, {"mind": w["worker"]["id"], "chosen": None})):
        r = ask(client, w["ann"], f"op-chose-bad-{i:02d}", context=ctx)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", (ctx, r.text)
