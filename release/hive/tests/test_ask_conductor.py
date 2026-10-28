"""The Ask conductor (hive/core/conductor.py): a host-side model loop over vocabulary v1, with a scripted fake model.

No network and no paid calls: the gateway's chat is replaced by a script; the "paid" provider is a fake with prices.
"""
import asyncio
import contextlib
import json
import logging
import time

import pytest

from hive.core import conductor as cmod
from hive.core.config import Provider
from hive.core.gateway import signal_send
from hive.tests.test_ask import ask, world
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)


# ---- a scripted model ------------------------------------------------------------------------------------------------

def call(name, **args):
    return {"id": f"call_{name}_{len(json.dumps(args))}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


class Script:
    """Answers each model call with the next scripted message (tool calls, or final text); records every request."""

    def __init__(self, *steps, delay=0.0, cost=0.0, repeat_last=False, no_usage=()):
        self.steps, self.delay, self.cost, self.repeat_last = list(steps), delay, cost, repeat_last
        self.no_usage = set(no_usage)   # indices of calls whose response has no usage counters (an unknown cost)
        self.bodies = []

    async def chat(self, agent, body):
        await signal_send()   # as the real transport does at its send boundary (may abort: nothing is sent)
        self.bodies.append(json.loads(json.dumps(body)))
        if self.delay:
            await asyncio.sleep(self.delay)
        step = self.steps[0] if (self.repeat_last and len(self.steps) == 1) else self.steps.pop(0)
        message = {"role": "assistant", "content": step} if isinstance(step, str) else {"role": "assistant", "content": None, "tool_calls": step}
        response = {"id": "fake-1", "model": agent["model"], "choices": [{"index": 0, "message": message}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5}}
        if len(self.bodies) - 1 in self.no_usage:
            del response["usage"]
        return response, {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": self.cost}


@pytest.fixture()
def on(client, monkeypatch):  # noqa: F811
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    w["conductor"] = w["hive"].ask.conductor
    w["ctx"] = {"swarm_id": w["swarm"]["id"]}
    return w


def script(client, s):
    client.app.state.gateway.chat = s.chat
    return s


def frames(hive, op, principal="user:u_ann"):
    t = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = ? AND principal = ?", (op, principal))
    return [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (t["id"],))]


def wait(hive, op, pred, timeout=8.0, principal="user:u_ann"):
    end = time.time() + timeout
    while time.time() < end:
        fs = frames(hive, op, principal)
        if pred(fs):
            return fs
        time.sleep(0.02)
    raise AssertionError(f"timed out; frames: {[f['phase'] for f in frames(hive, op, principal)]}")


def closed(fs):
    return any(f["phase"] in ("done", "refused") for f in fs)


def acts(fs):
    return [f["act"] for f in fs if f["phase"] == "act"]


def dump(hive):
    """Every stored row, as text: what must never contain the view or the memory notes."""
    out = []
    for t in hive.db.all("SELECT name FROM sqlite_master WHERE type = 'table'"):
        out += [json.dumps(r, default=str) for r in hive.db.all(f"SELECT * FROM \"{t['name']}\"")]
    return "\n".join(out)


def tool_results(body):
    return [json.loads(m["content"]) for m in body["messages"] if m.get("role") == "tool"]


RESULT = {"ok": True, "view": {"summary": "SECRETVIEW three goals open", "refs": [{"kind": "goal", "ref": "g_1"}],
                               "acts": ["goal.new"], "fields": [{"id": "goal-search", "label": "Search", "kind": "search"}], "regions": ["list"]},
          "route": "#/goals", "experience": "classic"}


# ---- a full turn ------------------------------------------------------------------------------------------------------

def test_a_full_turn_tool_calls_become_acts_and_results_become_tool_results(client, on, caplog):
    caplog.set_level(logging.DEBUG)
    hive = on["hive"]
    s = script(client, Script([call("say", text="Taking you to Goals."), call("navigate", route="#/goals", label="Goals")],
                              "You're on Goals: three are open."))
    r = ask(client, on["ann"], "op-cond-001", text="show me my goals", context=on["ctx"])
    assert r.status_code == 202 and r.json()["state"] == "thinking" and r.json()["conductor"] == {"model": "mock/conductor"}
    fs = wait(hive, "op-cond-001", lambda fs: acts(fs))
    act = acts(fs)[0]
    assert act["kind"] == "navigate" and act["route"] == "#/goals" and act["label"] == "Goals" and act["act_id"].startswith("ac_")
    assert [f["phase"] for f in fs] == ["accepted", "answer", "act"] and fs[1]["delta"] is True and fs[1]["text"] == "Taking you to Goals."
    res = client.post(f"/api/ask/op-cond-001/acts/{act['act_id']}/result", headers=on["ann"], json=RESULT)
    assert res.status_code == 200 and res.json() == {"act_id": act["act_id"], "recorded": True}
    fs = wait(hive, "op-cond-001", closed)
    assert [f["phase"] for f in fs] == ["accepted", "answer", "act", "answer", "done"]
    final = fs[3]
    assert "delta" not in final and final["text"] == "Taking you to Goals.\n\nYou're on Goals: three are open."
    assert fs[4]["outcome"] == "complete" and set(fs[4]) & {"text", "say", "limit"} == set()
    # the act's result was the tool result of the second model call, with the page's view
    assert len(s.bodies) == 2
    second = tool_results(s.bodies[1])
    assert second[0] == {"ok": True}   # say
    assert second[1]["act_id"] == act["act_id"] and second[1]["ok"] is True and second[1]["route"] == "#/goals"
    assert second[1]["view"]["summary"] == "SECRETVIEW three goals open" and second[1]["view"]["fields"][0]["id"] == "goal-search"
    assert s.bodies[0]["tools"] == cmod.TOOLS and s.bodies[0]["messages"][-1] == {"role": "user", "content": "show me my goals"}
    # nothing reached the coordinator, and the view was never stored or logged
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND conversation_id LIKE 'ask:%'", (on["coord"]["id"],))["n"] == 0
    assert "SECRETVIEW" not in dump(hive) and "SECRETVIEW" not in caplog.text
    turn = client.get("/api/ask/op-cond-001", headers=on["ann"]).json()
    assert turn["state"] == "done" and turn["answer_message_id"]


# ---- the result route ---------------------------------------------------------------------------------------------------

def test_result_route_owner_only_emitted_ids_once_bounded_and_timeout(client, on):
    hive = on["hive"]
    s = script(client, Script([call("point", target={"region": "list"}, caption="here")],
                              [call("scroll", to="bottom")], "Done."))
    on["conductor"].result_timeout = 1.5
    ask(client, on["ann"], "op-cond-res", context=on["ctx"])
    act = acts(wait(hive, "op-cond-res", acts))[0]
    url = f"/api/ask/op-cond-res/acts/{act['act_id']}/result"
    # another person, and an admin who is not the owner: as for an unknown op
    for who in (on["bob"], on["quinn"]):
        r = client.post(url, headers=who, json={"ok": True})
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_available"
    r = client.post("/api/ask/op-cond-res/acts/ac_notemitted/result", headers=on["ann"], json={"ok": True})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_available"
    big = {"ok": True, "view": {"summary": "x" * 9000}}
    r = client.post(url, headers=on["ann"], json=big)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    r = client.post(url, headers=on["ann"], json={"ok": "yes"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"
    assert client.post(url, headers=on["ann"], json={"ok": False, "reason": "unknown_target"}).status_code == 200
    r = client.post(url, headers=on["ann"], json={"ok": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "act_result_recorded"
    # the second act gets no result: after the timeout the conductor goes on with no_result
    fs = wait(hive, "op-cond-res", closed)
    second = acts(fs)[1]
    assert tool_results(s.bodies[1])[0] == {"act_id": act["act_id"], "ok": False, "reason": "unknown_target"}
    assert tool_results(s.bodies[2])[-1] == {"act_id": second["act_id"], "ok": False, "reason": "no_result"}
    late = client.post(f"/api/ask/op-cond-res/acts/{second['act_id']}/result", headers=on["ann"], json={"ok": True})
    assert late.status_code == 409


def test_stop_ends_the_loop_and_a_late_result_is_refused(client, on):
    hive = on["hive"]
    script(client, Script([call("navigate", route="#/rooms")], "never"))
    ask(client, on["ann"], "op-cond-stop", context=on["ctx"])
    act = acts(wait(hive, "op-cond-stop", acts))[0]
    assert client.post("/api/ask/op-cond-stop/stop", headers=on["ann"]).json()["state"] == "refused"
    end = time.time() + 5
    while on["conductor"].tasks and time.time() < end:
        time.sleep(0.02)
    assert not on["conductor"].tasks
    r = client.post(f"/api/ask/op-cond-stop/acts/{act['act_id']}/result", headers=on["ann"], json={"ok": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "turn_closed"
    last = frames(hive, "op-cond-stop")[-1]   # done with the enum, no free text
    assert last["phase"] == "done" and last["outcome"] == "cancelled" and not set(last) & {"text", "say", "reason"}


# ---- turn limits ------------------------------------------------------------------------------------------------------

def test_the_act_limit(client, on):
    script(client, Script([call("say", text=f"step {i}") for i in range(40)], "never"))
    ask(client, on["ann"], "op-cond-acts", context=on["ctx"])
    fs = wait(on["hive"], "op-cond-acts", closed)
    deltas = [f for f in fs if f["phase"] == "answer" and f.get("delta")]
    assert len(deltas) == cmod.MAX_ACTS == 32
    assert fs[-1]["phase"] == "done" and fs[-1]["outcome"] == "act_cap" and "limit" not in fs[-1]
    assert fs[-2]["text"].endswith(cmod.LIMIT_SAY["act_cap"])


def test_the_model_call_limit(client, on):
    s = script(client, Script([call("say", text="again")], repeat_last=True))
    ask(client, on["ann"], "op-cond-calls", context=on["ctx"])
    fs = wait(on["hive"], "op-cond-calls", closed)
    assert len(s.bodies) == cmod.MAX_MODEL_CALLS == 12
    assert fs[-1]["outcome"] == "call_cap" and cmod.LIMIT_SAY["call_cap"] in fs[-2]["text"]


def test_the_time_limit(client, on):
    on["conductor"].turn_seconds = 0.5
    script(client, Script("too late", delay=2.0))
    ask(client, on["ann"], "op-cond-time", context=on["ctx"])
    fs = wait(on["hive"], "op-cond-time", closed)
    assert fs[-1]["outcome"] == "time_cap" and fs[-2]["text"] == cmod.LIMIT_SAY["time_cap"]


def test_the_spend_cap_is_held_through_cost_reservations(client, on, monkeypatch):
    hive = on["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "0.012")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    s = script(client, Script([call("say", text="one")], [call("say", text="two")], "never", cost=0.004))
    ask(client, on["ann"], "op-cond-spend", context=on["ctx"])
    fs = wait(hive, "op-cond-spend", closed)
    # the first call (worst case ~$0.009) fits under $0.012; the second (0.004 spent + ~0.009) does not: refused by the
    # reservation's askturn scope before any call is made
    assert len(s.bodies) == 1
    assert fs[-1]["outcome"] == "spend_cap" and fs[-1]["turn_spent_usd"] == 0.004
    usage = hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (on["coord"]["id"],))
    assert [(u["model"], u["payer"], u["cost_usd"]) for u in usage] == [("fakepaid/x", "user:u_ann", 0.004)]
    held = hive.db.all("SELECT r.state, d.metadata FROM cost_reservations r JOIN cost_reservation_details d ON d.reservation = r.id")
    assert [h["state"] for h in held] == ["settled"] and json.loads(held[0]["metadata"])["kind"] == "ask-conductor"


# ---- the private-app fence ------------------------------------------------------------------------------------------------

def test_acts_naming_a_private_app_are_dropped(client, on):
    s = script(client, Script([call("navigate", route="#/programs/atlas"), call("open", feature="app:truth"),
                               call("highlight", target={"region": "omegatruth-panel"}), call("point", target={"region": "list"})],
                              "ok"))
    ask(client, on["ann"], "op-cond-priv", context=on["ctx"])
    act = acts(wait(on["hive"], "op-cond-priv", acts))[0]
    client.post(f"/api/ask/op-cond-priv/acts/{act['act_id']}/result", headers=on["ann"], json={"ok": True})
    fs = wait(on["hive"], "op-cond-priv", closed)
    assert [a["kind"] for a in acts(fs)] == ["point"]
    blocked = tool_results(s.bodies[1])[:3]
    assert all(b == {"ok": False, "reason": "private"} for b in blocked)
    # and a view a page sends back is fenced again: private refs, fields and regions never reach the model
    assert cmod.fence_view({"refs": [{"kind": "feature", "ref": "app:atlas"}, {"kind": "goal", "ref": "g_1"}],
                            "regions": ["truth-notes", "list"], "fields": [{"id": "atlas.search", "label": "x", "kind": "text"}]}, False) \
        == {"refs": [{"kind": "goal", "ref": "g_1"}], "regions": ["list"]}


# ---- conductor off --------------------------------------------------------------------------------------------------------

def test_conductor_off_leaves_the_ask_unchanged(client, monkeypatch):
    monkeypatch.delenv("HIVE_ASK_CONDUCTOR", raising=False)
    w = world(client)
    s = script(client, Script("never"))
    ctx = {"swarm_id": w["swarm"]["id"]}
    r = ask(client, w["quinn"], "op-off-bad-conductor", context=ctx, conductor={"model": cmod.DEFAULT_MODEL})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"
    # memory_notes are accepted and ignored while off (Surface, 2026-10-07; test_ask_memory covers where they go: nowhere)
    r = ask(client, w["quinn"], "op-off-notes", context=ctx, memory_notes=["likes dark"])
    assert r.status_code == 202 and r.json()["state"] == "accepted" and "conductor" not in r.json()
    notes_turn = r.json()["turn_id"]
    client.post("/api/ask/op-off-notes/stop", headers=w["quinn"])
    delivered = w["hive"].db.all("SELECT text, extra FROM messages WHERE conversation_id = ?", (f"ask:{notes_turn}",))
    assert len(delivered) == 1 and "likes dark" not in json.dumps(delivered)   # delivered as phase 1, without the notes
    r = ask(client, w["ann"], "op-off-0001", context=ctx).json()
    assert r["state"] == "accepted" and "conductor" not in r
    delivered = w["hive"].db.all("SELECT conversation_id FROM messages WHERE agent_id = ? AND direction = 'in' AND conversation_id LIKE 'ask:%' "
                                 "ORDER BY created_at, rowid",   # explicit order: the messages_agent_dir_conv index (idle-minds r2) changes the plan
                                 (w["coord"]["id"],))
    assert [m["conversation_id"] for m in delivered] == [f"ask:{notes_turn}", f"ask:{r['turn_id']}"]
    time.sleep(0.2)
    assert s.bodies == [] and not w["hive"].ask.conductor.tasks
    # and a sleeping coordinator still refuses the phase-1 Ask
    client.post("/api/ask/op-off-0001/stop", headers=w["ann"])
    w["hive"].db.execute("UPDATE agents SET status = 'stopped' WHERE id = ?", (w["coord"]["id"],))
    assert ask(client, w["ann"], "op-off-0002", context=ctx).json()["error"]["code"] == "mind_asleep"


def test_conductor_on_needs_no_awake_coordinator_and_ab_override_is_admin_only(client, on):
    hive = on["hive"]
    hive.db.execute("UPDATE agents SET status = 'stopped' WHERE id = ?", (on["coord"]["id"],))
    script(client, Script("Hello."))
    assert ask(client, on["ann"], "op-cond-aslp", context=on["ctx"]).status_code == 202
    wait(hive, "op-cond-aslp", closed)
    r = ask(client, on["ann"], "op-cond-ab01", context=on["ctx"], conductor={"model": "openrouter/openai/gpt-6.1-sol"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_allowed"
    r = ask(client, on["quinn"], "op-cond-ab02", context=on["ctx"], conductor={"model": "openrouter/some/other"})
    assert r.status_code == 400
    hive.settings.providers["openrouter"].prices = {}   # unpriced: never pickable (Kimi 5)
    r = ask(client, on["quinn"], "op-cond-ab04", context=on["ctx"], conductor={"model": "openrouter/openai/gpt-6.1-sol"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"
    hive.settings.providers["openrouter"].prices = {"openai/gpt-6.1-sol": {"in": 1, "out": 1}}   # priced; the chat is the script
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    r = ask(client, on["quinn"], "op-cond-ab03", context=on["ctx"], conductor={"model": "openrouter/openai/gpt-6.1-sol"})
    assert r.status_code == 202 and r.json()["conductor"] == {"model": "openrouter/openai/gpt-6.1-sol"}


# ---- per-turn memory notes (the owner's memory ruling: the hive keeps none) ---------------------------------------------------------

def test_memory_notes_are_used_for_that_turn_only_and_never_stored_or_logged(client, on, caplog, monkeypatch):
    monkeypatch.setenv("HIVE_ASK_MEMORY", "on")   # notes reach the model only with the memory switch on (test_ask_memory)
    caplog.set_level(logging.DEBUG)
    hive = on["hive"]
    s = script(client, Script("Dark it is."))
    notes = ["prefers the NOTEDARK look", "calls the goals page 'the board'", "atlas sleep score 7"]
    r = ask(client, on["ann"], "op-cond-note", context=on["ctx"], memory_notes=notes)
    assert r.status_code == 202
    wait(hive, "op-cond-note", closed)
    context = s.bodies[0]["messages"][1]["content"]
    assert "- prefers the NOTEDARK look" in context and "the board" in context and "atlas" not in context
    assert "NOTEDARK" not in dump(hive) and "NOTEDARK" not in caplog.text and "the board" not in caplog.text
    assert cmod.notes_digest(notes[:2]) in caplog.text   # a digest and a count only
    # the next turn has none of them
    s2 = script(client, Script("Hi."))
    ask(client, on["ann"], "op-cond-nxt1", context=on["ctx"])
    wait(hive, "op-cond-nxt1", closed)
    assert "NOTEDARK" not in json.dumps(s2.bodies[0])
    # bounds: at most 20 notes, at most 8 KB
    for bad in (["n"] * 21, ["x" * 5000, "y" * 4000], [""], "a string", [3]):
        r = ask(client, on["ann"], f"op-cond-bad-{len(str(bad)) % 1000:03d}", context=on["ctx"], memory_notes=bad)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", bad


def test_no_conductor_memory_routes_exist(client, on):
    for method, path in (("get", "/api/me/ask/memory"), ("delete", "/api/me/ask/memory")):
        assert getattr(client, method)(path, headers=on["ann"]).status_code in (404, 405)


# ---- dispatch ---------------------------------------------------------------------------------------------------------------

def test_dispatch_refuses_cleanly_until_wired(client, on):
    hive = on["hive"]
    assert on["conductor"].intents is hive.ask.intents   # wired to linkage slice 2 on main; unbound below
    on["conductor"].intents = None
    with pytest.raises(cmod.DispatchUnavailable) as e:
        on["conductor"].dispatch("user:u_ann", "op-x", "code.request", {"title": "x"})
    assert e.value.code == "not_available"
    s = script(client, Script([call("dispatch", kind="code.request", request={"title": "Fix the login"}, label="Fix it")], "Sorry."))
    ask(client, on["ann"], "op-cond-disp", context=on["ctx"])
    fs = wait(hive, "op-cond-disp", closed)
    assert "dispatched" not in [f["phase"] for f in fs]
    assert [f["text"] for f in fs if f["phase"] == "answer" and f.get("delta")] == [cmod.DISPATCH_SAY]
    assert tool_results(s.bodies[1])[0]["reason"] == "not_available"
    assert fs[-2]["text"].startswith(cmod.DISPATCH_SAY)


def test_a_wired_dispatch_emits_the_dispatched_frame(client, on):
    hive = on["hive"]
    seen = []

    class Intents:   # slice 2's recorder, faked: records a pending intent and returns its view
        def record(self, viewer, operation_id, body):
            seen.append((viewer.principal, viewer.admin, operation_id, body))
            return 201, {"intent_id": "ai_" + "0" * 24, "kind": body["kind"], "state": "pending", "destination": {"to_swarm": on["swarm"]["id"]}}
    on["conductor"].intents = Intents()
    script(client, Script([call("dispatch", kind="code.request", request={"title": "Fix"}, label="Fix it")], "Recorded."))
    ask(client, on["quinn"], "op-cond-wire", context=on["ctx"])
    t = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-cond-wire'")
    end = time.time() + 5
    while time.time() < end and not hive.db.one("SELECT 1 FROM ask_events WHERE turn_id = ? AND frame LIKE '%\"done\"%'", (t["id"],)):
        time.sleep(0.02)
    fs = [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (t["id"],))]
    d = [f for f in fs if f["phase"] == "dispatched"]
    assert len(d) == 1 and d[0]["intent_id"] == "ai_" + "0" * 24 and d[0]["intent_kind"] == "code.request" and d[0]["label"] == "Fix it"
    assert d[0]["to"] == {"kind": "swarm", "ref": on["swarm"]["id"], "name": "Home"}
    assert seen == [("user:u_quinn", True, "op-cond-wire", {"kind": "code.request", "request": {"title": "Fix"}})]


def test_dispatch_records_exactly_one_pending_slice2_intent_and_emits_dispatched(w, monkeypatch):  # noqa: F811
    """Wired on main: a scripted dispatch records one pending intent through linkage slice 2's real Intents (never
    submitted, no request created), its `intent` frame and the conductor's `dispatched` frame share the turn's quota."""
    from hive.tests.test_mind_control import instruction
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    c, hive = w.client, w.hive
    asker = c.post("/api/agents", json={"name": "Asker", "swarm_id": w.origin["id"]}).json()
    assert c.patch(f"/api/swarms/{w.origin['id']}", json={"coordinator_id": asker["id"]}).status_code == 200
    assert hive.ask.conductor.intents is hive.ask.intents
    submitted = []
    monkeypatch.setattr(hive.ask.intents, "submit", lambda *a, **k: submitted.append(a))
    request = instruction(w)
    request.pop("operation_id")
    before = {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in ("requests", "mind_operations", "ask_intents")}
    s = script(c, Script([call("dispatch", kind="code.request", request=request, label="Fix it")], "Recorded."))
    r = c.post("/api/ask", headers=w.quinn, json={"operation_id": "op-cond-s2", "text": "fix add()", "context": {"swarm_id": w.origin["id"]}})
    assert r.status_code == 202 and r.json()["conductor"] == {"model": "mock/conductor"}
    fs = wait(hive, "op-cond-s2", closed, principal="user:u_quinn")
    rows = hive.db.all("SELECT * FROM ask_intents WHERE turn_id = ?", (r.json()["turn_id"],))
    assert len(rows) == 1 and rows[0]["state"] == "pending" and rows[0]["principal"] == "user:u_quinn" and rows[0]["kind"] == "code.request"
    assert {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in before} == {**before, "ask_intents": before["ask_intents"] + 1}
    assert submitted == []
    assert [f["phase"] for f in fs] == ["accepted", "intent", "dispatched", "answer", "done"]
    assert fs[1]["intent_id"] == rows[0]["id"] and fs[1]["state"] == "pending" and fs[1]["links_rev"] == 1
    d = fs[2]
    assert d["intent_id"] == rows[0]["id"] and d["intent_kind"] == "code.request" and d["label"] == "Fix it"
    assert d["to"] == {"kind": "swarm", "ref": w.team["id"], "name": "Coders"}
    assert fs[-1]["outcome"] == "complete"
    result = tool_results(s.bodies[1])[0]
    assert result["ok"] is True and result["intent_id"] == rows[0]["id"] and result["state"] == "pending"
    links = c.get("/api/ask/op-cond-s2/links", headers=w.quinn).json()
    assert links["links_rev"] == 1 and [x["state"] for x in links["links"]] == ["pending"]


def test_a_steer_on_a_conducting_turn_is_refused_and_writes_nothing(client, on):
    """Slice 2's steer route joins open turns; a conductor turn is open but never reaches the mind and takes no steering:
    404 not_available, and no message, room message, steer row or frame is written."""
    hive = on["hive"]
    script(client, Script([call("point", target={"region": "list"})], "ok"))
    assert ask(client, on["ann"], "op-cond-steer", context=on["ctx"]).status_code == 202
    wait(hive, "op-cond-steer", acts)
    tables = ("messages", "room_messages", "ask_steers", "ask_events", "ask_turns")
    before = {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in tables}
    r = client.post("/api/ask/op-cond-steer/steer", headers=on["ann"], json={"steer_id": "st-cond-0001", "text": "faster", "at_seq": 1})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_available"
    assert {t: hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in tables} == before
    assert hive.db.one("SELECT state FROM ask_turns WHERE operation_id = 'op-cond-steer'")["state"] == "conducting"
    assert hive.db.one("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND conversation_id LIKE 'ask:%'", (on["coord"]["id"],))["n"] == 0


def test_under_quota_pressure_a_dropped_act_is_no_result_at_once_and_answer_done_fill_the_reserve(client, on, monkeypatch):
    """The shared quota (Ask._frame) on a conductor turn: say deltas stop TERMINAL_RESERVE short, an act with no place
    is answered no_result at once (never waited for), and the final answer and done land in the two reserved places."""
    from hive.core import ask as amod
    monkeypatch.setattr(amod, "MAX_EVENTS", 12)
    hive = on["hive"]
    on["conductor"].result_timeout = 60.0   # a waited act would hold the turn far past the bound below
    says = [call("say", text=f"step {i}") for i in range(15)]
    for i, c in enumerate(says):
        c["id"] = f"call_say_{i}"
    s = script(client, Script(says + [call("point", target={"region": "list"})], "final"))
    started = time.time()
    assert ask(client, on["ann"], "op-cond-quota", context=on["ctx"]).status_code == 202
    fs = wait(hive, "op-cond-quota", closed)
    assert time.time() - started < 10.0
    assert [f["seq"] for f in fs] == list(range(1, 13))
    deltas = [f for f in fs if f["phase"] == "answer" and f.get("delta")]
    assert [f["seq"] for f in deltas] == list(range(2, 11))                 # stop at MAX_EVENTS - TERMINAL_RESERVE
    assert acts(fs) == []                                                   # the act had no place: never shown
    point = tool_results(s.bodies[1])[-1]
    assert point["ok"] is False and point["reason"] == "no_result" and point["act_id"].startswith("ac_")
    final, done = fs[-2], fs[-1]
    assert final["seq"] == 11 and final["phase"] == "answer" and "delta" not in final
    assert final["text"] == "\n\n".join([f"step {i}" for i in range(15)] + ["final"])   # dropped deltas still in the answer
    assert done["seq"] == 12 and done["phase"] == "done" and done["outcome"] == "complete"


# ---- act shapes -------------------------------------------------------------------------------------------------------------

def test_act_validation_matches_vocabulary_v1():
    ok = cmod.check_act
    assert ok("look", {"prefs": {"variant": None, "density": "compact"}}) == {"kind": "look", "prefs": {"variant": None, "density": "compact"}}
    assert ok("look", {"prefs": {"variant": {"x": 1}}}) is None          # variant is string | null
    assert ok("navigate", {"route": "goals"}) is None                    # a hash route
    assert ok("fill", {"field": "f1", "text": "x" * 4001}) is None
    assert ok("point", {"target": {"region": "list"}, "caption": "<b>"}) is None
    assert ok("tour.step", {"script": "temporal", "step": 2}) == {"kind": "tour.step", "script": "temporal", "step": 2}
    assert ok("highlight", {"target": {"feature": "nav.goals"}, "ink": {"shape": "circle", "points": [[2, -1]]}})["ink"] \
        == {"shape": "circle", "points": [[1.0, 0.0]]}
    assert ok("scroll", {}) is None and ok("open", {"feature": "goals", "extra": 1}) is None


# ---- scope addition: declared fields and regions, result reasons, private pages ---------------------------------------------

FIELDS = [{"id": "goal-search", "label": "Search goals", "kind": "search"}, {"id": "note.body", "label": "Note", "kind": "prompt"}]


def test_view_fields_and_regions_are_accepted_and_forwarded_to_the_conductor_deduplicated(client, on):
    hive = on["hive"]
    s = script(client, Script("ok"))
    view = {"acts": ["goal.new"], "fields": FIELDS + [FIELDS[0], {"id": "atlas-search", "label": "x", "kind": "text"}],
            "regions": ["list", "detail", "list", "truth-panel"]}
    r = ask(client, on["ann"], "op-cond-view", context={**on["ctx"], "view": view})
    assert r.status_code == 202
    assert r.json()["context"]["view"] == {"acts": ["goal.new"], "fields": FIELDS, "regions": ["list", "detail"]}
    wait(hive, "op-cond-view", closed)
    assert '"fields": [{"id": "goal-search", "label": "Search goals", "kind": "search"}' in s.bodies[0]["messages"][1]["content"]


def test_view_fields_and_regions_refusals_and_size_cap(client, on):
    script(client, Script("ok", repeat_last=True))
    bad = [
        {"fields": "x"},
        {"fields": [{"id": "Goal", "label": "x", "kind": "text"}]},                 # id pattern
        {"fields": [{"id": "a", "label": "", "kind": "text"}]},                     # empty label
        {"fields": [{"id": "a", "label": "x" * 81, "kind": "text"}]},               # long label
        {"fields": [{"id": "a", "label": "a\nb", "kind": "text"}]},                 # control character
        {"fields": [{"id": "a", "label": "x", "kind": "email"}]},                   # kind
        {"fields": [{"id": "a", "label": "x", "kind": "text", "x": 1}]},            # extra key
        {"fields": [{"id": "a", "label": "x"}]},                                    # missing key
        {"fields": [{"id": f"f{i}", "label": "x", "kind": "text"} for i in range(33)]},
        {"regions": ["-x"]}, {"regions": [3]}, {"regions": [f"r{i}" for i in range(33)]},
        {"other": []},
    ]
    for i, view in enumerate(bad):
        r = ask(client, on["ann"], f"op-cond-vbad-{i:02d}", context={**on["ctx"], "view": view})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", view
    big = {"fields": [{"id": f"field-{i:02d}", "label": "L" * 70, "kind": "text"} for i in range(32)]}
    r = ask(client, on["ann"], "op-cond-vbig", context={**on["ctx"], "view": big})
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"


def test_fields_and_regions_are_accepted_but_not_forwarded_with_the_conductor_off(client, monkeypatch):
    monkeypatch.delenv("HIVE_ASK_CONDUCTOR", raising=False)
    w = world(client)
    r = ask(client, w["ann"], "op-off-view", context={"swarm_id": w["swarm"]["id"], "view": {"fields": FIELDS, "regions": ["list"], "acts": ["a.b"]}})
    assert r.status_code == 202 and r.json()["context"]["view"] == {"acts": ["a.b"]}


def test_act_result_reasons_are_the_closed_union(client, on):
    hive = on["hive"]
    steps = [[call("point", target={"region": "list"})] for _ in range(10)] + ["done"]
    script(client, Script(*steps))
    reasons = ["unknown_target", "not_fillable", "stale_origin", "blocked", "reduced_motion_skipped", "invalid", "not_declared",
               "act_cap", "private"]
    ask(client, on["ann"], "op-cond-rsn", context=on["ctx"])
    for i, reason in enumerate(reasons):
        act = acts(wait(hive, "op-cond-rsn", lambda fs: len(acts(fs)) > i))[i]
        url = f"/api/ask/op-cond-rsn/acts/{act['act_id']}/result"
        for wrong in ("other", "BLOCKED"):
            assert client.post(url, headers=on["ann"], json={"ok": False, "reason": wrong}).status_code == 400
        assert client.post(url, headers=on["ann"], json={"ok": False, "reason": reason}).status_code == 200, reason


def test_a_private_apps_page_reaches_the_model_only_as_private(client, on):
    hive = on["hive"]
    s = script(client, Script([call("point", target={"region": "list"})], "ok"))
    ctx = {**on["ctx"], "program": "atlas", "route": "programs/atlas",
           "view": {"refs": [{"kind": "item", "ref": "it_secret1"}], "acts": ["atlas.read"], "fields": FIELDS, "regions": ["list"]}}
    r = ask(client, on["ann"], "op-cond-pvt", context=ctx)
    assert r.status_code == 202 and r.json()["context"] == {"private": True}
    act = acts(wait(hive, "op-cond-pvt", acts))[0]
    client.post(f"/api/ask/op-cond-pvt/acts/{act['act_id']}/result", headers=on["ann"], json=RESULT)
    wait(hive, "op-cond-pvt", closed)
    sent = json.dumps([b["messages"][1:] for b in s.bodies]).lower()   # everything but the fixed system text and tools
    assert s.bodies[0]["messages"][1]["content"].split("\n")[1] == '{"private": true}'
    for leaked in ("atlas", "it_secret1", "goal-search", "SECRETVIEW", "#/goals"):
        assert leaked.lower() not in sent, leaked
    assert tool_results(s.bodies[1])[0] == {"act_id": act["act_id"], "ok": True, "private": True}


# ---- stand-in FIX-FIRST on aa43ae4: regressions ------------------------------------------------------------------------------

@pytest.mark.parametrize("program,route", [("%61tlas", "programs/%61tlas"), ("%2561tlas", "programs/%2561tlas"),
                                           ("ATLAS", "programs/AtLaS"), ("om%65gatruth", "x"), ("x", "programs/%2574ruth"),
                                           ("\uff41tlas", "x")])   # fullwidth 'a': NFKC
def test_an_encoded_or_mixed_case_private_page_is_still_private(client, on, program, route):
    s = script(client, Script("ok"))
    r = ask(client, on["ann"], "op-cond-enc1", context={**on["ctx"], "program": program, "route": route,
                                                        "view": {"fields": FIELDS, "acts": ["goal.new"]}})
    assert r.status_code == 202 and r.json()["context"] == {"private": True}
    wait(on["hive"], "op-cond-enc1", closed)
    assert "goal-search" not in json.dumps(s.bodies[0]["messages"][1:])


@pytest.mark.parametrize("route", ["#/programs/%61tlas", "#/programs/%2561tlas", "#/PROGRAMS/Atlas", "#/apps/%2574ruth"])
def test_an_encoded_private_route_in_an_act_result_reaches_the_model_only_as_private(client, on, route):
    hive = on["hive"]
    s = script(client, Script([call("point", target={"region": "list"})], "ok"))
    ask(client, on["ann"], "op-cond-enc2", context=on["ctx"])
    act = acts(wait(hive, "op-cond-enc2", acts))[0]
    r = client.post(f"/api/ask/op-cond-enc2/acts/{act['act_id']}/result", headers=on["ann"], json={**RESULT, "route": route})
    assert r.status_code == 200
    wait(hive, "op-cond-enc2", closed)
    assert tool_results(s.bodies[1])[0] == {"act_id": act["act_id"], "ok": True, "private": True}
    assert "SECRETVIEW" not in json.dumps(s.bodies)


def test_act_result_views_get_the_initial_view_checks_and_the_2kb_cap(client, on):
    hive = on["hive"]
    script(client, Script([call("point", target={"region": "list"})], "ok"))
    ask(client, on["ann"], "op-cond-rview", context=on["ctx"])
    act = acts(wait(hive, "op-cond-rview", acts))[0]
    url = f"/api/ask/op-cond-rview/acts/{act['act_id']}/result"
    for view in ({"fields": 1}, {"regions": 1}, {"refs": 1}, {"acts": 1}, {"summary": 1}, {"title": "x"},
                 {"fields": [{"id": "Bad", "label": "x", "kind": "text"}]}, {"fields": [{"id": "a", "label": "x", "kind": "email"}]},
                 {"refs": [{"kind": "nope", "ref": "x"}]}, {"regions": ["-x"]}):
        r = client.post(url, headers=on["ann"], json={"ok": True, "view": view})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", view
    big = {"ok": True, "view": {"fields": [{"id": f"field-{i:02d}", "label": "L" * 70, "kind": "text"} for i in range(32)]}}
    r = client.post(url, headers=on["ann"], json=big)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    assert client.post(url, headers=on["ann"], json=RESULT).status_code == 200   # still open for a good one


def test_an_unknown_cost_counts_once_against_the_turn_cap(client, on, monkeypatch):
    hive = on["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    gw = client.app.state.gateway
    probe = {"model": "fakepaid/x", "messages": [{"role": "system", "content": [{"type": "text", "text": cmod.SYSTEM}]},
                                                 {"role": "system", "content": "x" * 300}, {"role": "user", "content": "what changed today?"}],
             "tools": cmod.TOOLS, "tool_choice": "auto", "max_tokens": cmod.MAX_TOKENS}
    first = gw.estimate({**on["coord"], "model": "fakepaid/x", "options": {}}, probe)[1]
    # room for the first call's held worst case plus a second call, but not for that worst case counted twice
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", f"{first * 2.6:.6f}")
    s = script(client, Script([call("say", text="one")], "done", cost=0.001, no_usage={0}))
    ask(client, on["ann"], "op-cond-unk", context=on["ctx"])
    fs = wait(hive, "op-cond-unk", closed)
    assert len(s.bodies) == 2 and fs[-1]["outcome"] == "complete"
    states = sorted(r["state"] for r in hive.db.all("SELECT state FROM cost_reservations"))
    assert states == ["settled", "unknown"]


# ---- the page's own private marker (Surface executor r2: context exactly {private: true}) ---------------------------------------

def test_a_page_sent_private_context_is_accepted_alone_and_resolves_to_private(client, on):
    hive = on["hive"]
    hive.db.execute("INSERT INTO ask_prefs VALUES (?, ?, 0.25, ?)", ("user:u_ann", on["swarm"]["id"], "2026-10-07T00:00:00Z"))
    s = script(client, Script([call("point", target={"region": "list"})], "ok"))
    r = ask(client, on["ann"], "op-cond-pmark", context={"private": True})
    assert r.status_code == 202 and r.json()["context"] == {"private": True}
    act = acts(wait(hive, "op-cond-pmark", acts))[0]
    assert client.post(f"/api/ask/op-cond-pmark/acts/{act['act_id']}/result", headers=on["ann"], json=RESULT).status_code == 200
    wait(hive, "op-cond-pmark", closed)
    assert s.bodies[0]["messages"][1]["content"].split("\n")[1] == '{"private": true}'
    assert tool_results(s.bodies[1])[0] == {"act_id": act["act_id"], "ok": True, "private": True}
    assert "SECRETVIEW" not in json.dumps(s.bodies)


def test_the_private_marker_must_be_literal_true_and_alone(client, on):
    script(client, Script("ok", repeat_last=True))
    for i, ctx in enumerate(({"private": True, "route": "goals"}, {"private": True, "swarm_id": on["swarm"]["id"]},
                             {"private": 1}, {"private": "true"}, {"private": False}, {"private": None})):
        r = ask(client, on["ann"], f"op-cond-pbad-{i}", context=ctx)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid", ctx


def test_an_act_result_from_a_private_page_route_forwards_only_private(client, on):
    hive = on["hive"]
    s = script(client, Script([call("point", target={"region": "list"})], "ok"))
    ask(client, on["ann"], "op-cond-proute", context=on["ctx"])
    act = acts(wait(hive, "op-cond-proute", acts))[0]
    r = client.post(f"/api/ask/op-cond-proute/acts/{act['act_id']}/result", headers=on["ann"],
                    json={**RESULT, "ok": False, "reason": "private", "route": "private", "experience": "classic"})
    assert r.status_code == 200
    wait(hive, "op-cond-proute", closed)
    assert tool_results(s.bodies[1])[0] == {"act_id": act["act_id"], "ok": False, "reason": "private", "private": True}
    assert "SECRETVIEW" not in json.dumps(s.bodies) and "classic" not in json.dumps(s.bodies[1]["messages"][1:])


# ---- Kimi FIX-FIRST on aa43ae4: regressions ------------------------------------------------------------------------------------

def test_kimi1_act_cap_with_a_pending_act_announces_the_limit(client, on):
    hive = on["hive"]
    s = script(client, Script([call("say", text=f"s{i}") for i in range(31)] + [call("navigate", route="#/goals"),
                                                                              call("navigate", route="#/rooms")], "never"))
    ask(client, on["ann"], "op-k1-acts", context=on["ctx"])
    act = acts(wait(hive, "op-k1-acts", acts))[0]
    assert client.post(f"/api/ask/op-k1-acts/acts/{act['act_id']}/result", headers=on["ann"], json=RESULT).status_code == 200
    fs = wait(hive, "op-k1-acts", closed)
    assert len(acts(fs)) == 1 and fs[-1]["outcome"] == "act_cap" and fs[-2]["text"].endswith(cmod.LIMIT_SAY["act_cap"])
    assert len(s.bodies) == 1


def test_kimi1_time_cap_mid_await_announces_the_limit(client, on):
    hive = on["hive"]
    on["conductor"].turn_seconds = 0.8
    script(client, Script([call("navigate", route="#/goals"), call("point", target={"region": "list"})], "never"))
    ask(client, on["ann"], "op-k1-time", context=on["ctx"])
    fs = wait(hive, "op-k1-time", closed)
    assert len(acts(fs)) == 2 and fs[-1]["outcome"] == "time_cap" and fs[-2]["text"] == cmod.LIMIT_SAY["time_cap"]


def test_kimi1_tools_never_leave_a_hole():
    c = cmod.Conductor.__new__(cmod.Conductor)
    c.result_timeout = 0.05
    st = cmod.TurnState("at_x", "user:u_ann", "op", "mock/x", 1.0, False)
    st.deadline = time.monotonic() + 60
    out = [None, None]

    async def go():
        st.loop = asyncio.get_running_loop()
        st.pending = {"ac_1": st.loop.create_future(), "ac_2": st.loop.create_future()}
        task = asyncio.ensure_future(c._await(st, [(0, "c1", "ac_1"), (1, "c2", "ac_2")], out))
        await asyncio.sleep(0)
        task.cancel()   # a cap or a stop unwinding mid-await
        with contextlib.suppress(asyncio.CancelledError):
            await task
    asyncio.run(go())
    assert all(o is not None for o in out)


def test_kimi2_and_3_a_close_wins_once_and_a_late_result_never_reaches_the_loop(client, on):
    hive = on["hive"]
    script(client, Script([call("navigate", route="#/goals")], "never"))
    ask(client, on["ann"], "op-kimi-23", context=on["ctx"])
    act = acts(wait(hive, "op-kimi-23", acts))[0]
    # the turn is closed in the database (a stop committed) before the loop has heard of it
    t = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-kimi-23'")
    hive.db.execute("UPDATE ask_turns SET state = 'refused', reason = 'stopped' WHERE id = ?", (t["id"],))
    r = client.post(f"/api/ask/op-kimi-23/acts/{act['act_id']}/result", headers=on["ann"], json=RESULT)
    assert r.status_code == 409 and r.json()["error"]["code"] == "turn_closed"
    st = on["conductor"].turns[t["id"]]
    assert not st.pending[act["act_id"]].done()   # the dead loop's wait was never fed
    hive.db.execute("UPDATE ask_turns SET state = 'conducting' WHERE id = ?", (t["id"],))
    assert on["conductor"]._finish(st, "x", "spend_cap") is True and on["conductor"]._finish(st, "y", "error") is False
    r = client.post(f"/api/ask/op-kimi-23/acts/{act['act_id']}/result", headers=on["ann"], json=RESULT)
    assert r.status_code == 409
    time.sleep(0.3)
    fs = frames(hive, "op-kimi-23")
    assert [f["phase"] for f in fs].count("done") == 1 and fs[-1]["outcome"] == "spend_cap"


def test_kimi4_the_turn_cap_ignores_the_minds_global_spend(client, on, monkeypatch):
    hive = on["hive"]
    script(client, Script("first"))
    ask(client, on["ann"], "op-kimi-4a", context=on["ctx"])
    wait(hive, "op-kimi-4a", closed)
    # the coordinator spends elsewhere: its global counter moves to just under the thread's $0.25 (admission still passes,
    # as in phase 1); none of it is this thread's usage, so the turn's own cap must not shrink to $0.001
    hive.db.execute("UPDATE agents SET spent_usd = spent_usd + 0.249, budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    s = script(client, Script("second", cost=0.001))
    ask(client, on["ann"], "op-kimi-4b", context=on["ctx"])
    fs = wait(hive, "op-kimi-4b", closed)
    assert len(s.bodies) == 1 and fs[-1]["outcome"] == "complete"


def test_kimi5_the_ab_list_is_unioned_and_unpriced_entries_are_reported(client, on, monkeypatch, caplog):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_AB_MODELS", "fakeunpriced/x")
    models = cmod.ab_models()
    assert set(cmod.DEFAULT_AB_MODELS) <= set(models) and "fakeunpriced/x" in models and models[0] == "mock/conductor"
    caplog.set_level(logging.WARNING)
    assert "fakeunpriced/x" in on["conductor"].check_models() and "fakeunpriced/x" in caplog.text
    r = ask(client, on["quinn"], "op-k5-pick", context=on["ctx"], conductor={"model": "fakeunpriced/x"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"


def test_kimi6_notes_fence_uses_every_private_app():
    assert cmod.fence_notes(["my truth score is 7", "Atlas sleep", "%61tlas", "likes dark"]) == ["likes dark"]


def test_kimi7_thread_deletion_blanks_dispatched_frames(client, on):
    hive = on["hive"]

    class Intents:
        def record(self, viewer, operation_id, body):
            return 201, {"intent_id": "ai_" + "1" * 24, "kind": body["kind"], "state": "pending", "destination": {"to_swarm": on["swarm"]["id"]}}
    on["conductor"].intents = Intents()
    script(client, Script([call("dispatch", kind="code.request", request={"title": "Fix"}, label="Fix it")], "Recorded."))
    r = ask(client, on["quinn"], "op-kimi-07", context=on["ctx"]).json()
    end = time.time() + 5
    while time.time() < end and not hive.db.one("SELECT 1 FROM ask_events WHERE turn_id = ? AND frame LIKE '%\"done\"%'", (r["turn_id"],)):
        time.sleep(0.02)
    assert client.delete(f"/api/ask/threads/{r['thread']['id']}", headers=on["quinn"]).status_code == 200
    fs = [json.loads(x["frame"]) for x in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (r["turn_id"],))]
    d = [f for f in fs if f["phase"] == "dispatched"][0]
    assert d["intent_id"] == "" and d["intent_kind"] == "" and d["to"]["ref"] == "" and d["to"].get("name", "") == "" and d["label"] == ""
    assert "1" * 24 not in json.dumps(fs) and on["swarm"]["id"] not in json.dumps(fs)


# ---- stand-in FIX-FIRST on 183b5f1: canonicalization to a fixed point, fail closed ------------------------------------------

DEEP = "#/programs/%" + "25" * 16 + "61tlas"        # the stand-in's reproduction: 17 decoding passes to 'atlas'
FULLWIDTH = "#/programs/\uff05\uff16\uff11tlas"     # fullwidth '%61': NFKC first makes it an escape, then it decodes
OVER = "#/programs/%" + "25" * 40 + "61x"          # more passes than the limit: never settles, so private


def test_canonicalization_reaches_a_fixed_point_or_fails_closed():
    assert cmod.names_private(DEEP) and cmod.canonical_id(DEEP) == "#/programs/atlas"
    assert cmod.names_private(FULLWIDTH) and cmod.canonical_id(FULLWIDTH) == "#/programs/atlas"
    assert cmod.names_private(OVER)                      # no private word in it at all: private because it never settles
    assert not cmod.names_private("#/goals") and not cmod.names_private("#/search?q=50%25%20off")
    assert cmod.fence_notes([DEEP, FULLWIDTH, OVER, "likes dark"]) == ["likes dark"]


@pytest.mark.parametrize("route", [DEEP, FULLWIDTH, OVER])
def test_deep_fullwidth_and_over_limit_result_routes_reach_the_model_only_as_private(client, on, route):
    hive = on["hive"]
    s = script(client, Script([call("point", target={"region": "list"})], "ok"))
    ask(client, on["ann"], "op-cond-deep", context=on["ctx"])
    act = acts(wait(hive, "op-cond-deep", acts))[0]
    r = client.post(f"/api/ask/op-cond-deep/acts/{act['act_id']}/result", headers=on["ann"], json={**RESULT, "route": route})
    assert r.status_code == 200
    wait(hive, "op-cond-deep", closed)
    assert tool_results(s.bodies[1])[0] == {"act_id": act["act_id"], "ok": True, "private": True}
    assert "SECRETVIEW" not in json.dumps(s.bodies) and "classic" not in json.dumps(s.bodies[1]["messages"][1:])


@pytest.mark.parametrize("program", ["%" + "25" * 16 + "61tlas", "\uff05\uff16\uff11tlas", "%" + "25" * 40 + "61x"])
def test_deep_fullwidth_and_over_limit_page_programs_are_private(client, on, program):
    s = script(client, Script("ok"))
    r = ask(client, on["ann"], "op-cond-deepp", context={**on["ctx"], "program": program, "view": {"fields": FIELDS}})
    assert r.status_code == 202 and r.json()["context"] == {"private": True}
    wait(on["hive"], "op-cond-deepp", closed)
    assert "goal-search" not in json.dumps(s.bodies[0]["messages"][1:])


# ---- takeover: the person took the page back mid-turn (POST /api/ask/{op}/takeover) ----------------------------------------

def gone(conductor, timeout=5.0):
    end = time.time() + timeout
    while (conductor.tasks or conductor.late) and time.time() < end:
        time.sleep(0.02)
    return not conductor.tasks and not conductor.late


def test_takeover_ends_the_turn_at_once_no_further_step_or_act_and_tells_every_view(client, on, monkeypatch):
    hive = on["hive"]
    published = []
    real = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **f: (published.append((kind, f)), real(kind, **f))[1])
    s = script(client, Script([call("navigate", route="#/rooms")], [call("scroll", to="bottom")], "never"))
    r = ask(client, on["ann"], "op-cond-take", context=on["ctx"])
    turn_id = r.json()["turn_id"]
    act = acts(wait(hive, "op-cond-take", acts))[0]
    # another person, and an admin who is not the owner: as for an unknown op, and the turn goes on
    for who in (on["bob"], on["quinn"]):
        x = client.post("/api/ask/op-cond-take/takeover", headers=who, json={"reason": "user_took_over"})
        assert x.status_code == 404 and x.json()["error"]["code"] == "not_available"
    assert hive.ask._row(turn_id)["state"] == "conducting"
    t = client.post("/api/ask/op-cond-take/takeover", headers=on["ann"], json={"reason": "user_took_over"})
    assert t.status_code == 200
    view = t.json()
    assert set(view) == {"operation_id", "turn_id", "state", "ended_at"}
    assert view["turn_id"] == turn_id and view["operation_id"] == "op-cond-take" and view["state"] == "taken_over" and view["ended_at"]
    assert gone(on["conductor"])
    # the waiting act is refused, the model was never called again, and no act frame followed
    r = client.post(f"/api/ask/op-cond-take/acts/{act['act_id']}/result", headers=on["ann"], json={"ok": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "turn_closed"
    time.sleep(0.2)
    assert len(s.bodies) == 1
    fs = frames(hive, "op-cond-take")
    assert [f["phase"] for f in fs] == ["accepted", "act", "done"]
    assert fs[-1]["outcome"] == "cancelled" and fs[-1]["taken_over"] is True and not set(fs[-1]) & {"text", "say", "reason"}
    # published once, as an `ask` frame for Ann (the event fan-out sends those to the asker's every open view only)
    dones = [f for k, f in published if k == "ask" and f.get("phase") == "done" and f.get("turn_id") == turn_id]
    assert len(dones) == 1 and dones[0]["principal"] == "user:u_ann" and dones[0]["taken_over"] is True
    # idempotent: a repeat (with no body at all) answers the same and publishes nothing new
    again = client.post("/api/ask/op-cond-take/takeover", headers=on["ann"])
    assert again.status_code == 200 and again.json() == view
    assert len([1 for k, f in published if k == "ask" and f.get("turn_id") == turn_id and f.get("phase") == "done"]) == 1
    row = client.get("/api/ask/op-cond-take", headers=on["ann"]).json()
    assert row["state"] == "refused" and row["reason"] == "takeover" and row["closed_at"] == view["ended_at"]


def test_takeover_mid_model_call_settles_that_call_at_its_real_cost_and_spends_no_more(client, on, monkeypatch):
    hive = on["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
    s = script(client, Script([call("navigate", route="#/rooms")], [call("say", text="two")], "never", delay=0.6, cost=0.004))
    ask(client, on["ann"], "op-cond-take-paid", context=on["ctx"])
    end = time.time() + 5
    while not s.bodies and time.time() < end:   # the first call is on the wire
        time.sleep(0.01)
    assert len(s.bodies) == 1
    t = client.post("/api/ask/op-cond-take-paid/takeover", headers=on["ann"], json={})
    assert t.status_code == 200 and t.json()["state"] == "taken_over"
    assert gone(on["conductor"])
    time.sleep(0.3)
    fs = frames(hive, "op-cond-take-paid")
    assert [f["phase"] for f in fs] == ["accepted", "done"] and fs[-1]["taken_over"] is True   # no act ever reached the page
    assert len(s.bodies) == 1   # no second model call
    # the cut-off call is settled at what it really cost, once; nothing is left held against Ann's limits
    held = hive.db.all("SELECT state FROM cost_reservations")
    assert [h["state"] for h in held] == ["settled"]
    usage = hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (on["coord"]["id"],))
    assert [(u["model"], u["payer"], u["cost_usd"]) for u in usage] == [("fakepaid/x", "user:u_ann", 0.004)]


def test_takeover_of_a_turn_that_already_ended_answers_its_own_state_unchanged(client, on):
    hive = on["hive"]
    script(client, Script("All done."))
    r = ask(client, on["ann"], "op-cond-take-done", context=on["ctx"])
    wait(hive, "op-cond-take-done", closed)
    before = frames(hive, "op-cond-take-done")
    t = client.post("/api/ask/op-cond-take-done/takeover", headers=on["ann"])
    assert t.status_code == 200 and t.json()["state"] == "done" and t.json()["turn_id"] == r.json()["turn_id"]
    assert frames(hive, "op-cond-take-done") == before and hive.ask._row(r.json()["turn_id"])["reason"] is None


def test_takeover_body_is_none_empty_or_the_one_reason(client, on):
    script(client, Script([call("navigate", route="#/rooms")], "never"))
    ask(client, on["ann"], "op-cond-take-body", context=on["ctx"])
    acts(wait(on["hive"], "op-cond-take-body", acts))
    for bad in ({"reason": "bored"}, {"reason": "user_took_over", "x": 1}, [1]):
        r = client.post("/api/ask/op-cond-take-body/takeover", headers=on["ann"], json=bad)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid"
    r = client.post("/api/ask/op-cond-take-body/takeover", headers=on["ann"], content=b"{" * 2000)
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"
    r = client.post("/api/ask/op-cond-take-unknown/takeover", headers=on["ann"])
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_available"
    assert client.post("/api/ask/op-cond-take-body/takeover", headers=on["ann"]).json()["state"] == "taken_over"
    assert gone(on["conductor"])


def test_takeover_with_the_conductor_off_is_not_available_and_changes_nothing(client, monkeypatch):
    monkeypatch.delenv("HIVE_ASK_CONDUCTOR", raising=False)
    w = world(client)
    r = ask(client, w["ann"], "op-off-take", context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202 and r.json()["state"] == "accepted"
    before = w["hive"].ask._row(r.json()["turn_id"])
    t = client.post("/api/ask/op-off-take/takeover", headers=w["ann"], json={"reason": "user_took_over"})
    assert t.status_code == 404 and t.json()["error"]["code"] == "not_available"
    assert w["hive"].ask._row(r.json()["turn_id"]) == before
    client.post("/api/ask/op-off-take/stop", headers=w["ann"])


# ---- takeover r2 (stand-in P1; Kimi 1, 2, 3, 5, 6) ----------------------------------------------------------------------------

def paid(hive, monkeypatch, on):
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))


def reservation_states(hive):
    return [r["state"] for r in hive.db.all("SELECT state FROM cost_reservations ORDER BY reserved_at")]


@pytest.mark.parametrize("cancel_lands", [True, False])
def test_r2_a_takeover_in_the_gap_before_the_call_starts_never_reaches_the_provider_and_releases_the_hold(
        client, on, monkeypatch, cancel_lands):
    """Stand-in P1: the takeover commits after the reservation but before the provider call starts. Whether or not the
    loop's cancellation has landed by then, the call never goes out and its hold is released (not held, not settled)."""
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    s = script(client, Script([call("navigate", route="#/rooms")], "never", cost=0.004))
    real = conductor.reservations.reserve

    def reserve_then_takeover(key, *a, **k):
        out = real(key, *a, **k)
        t = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-cond-gap'")
        if cancel_lands:   # the route's own close: the row commits, then the loop's cancel is scheduled
            hive.ask._close(t["id"], "refused", "takeover")
        else:              # the row committed, the cancel not yet delivered
            hive.db.execute("UPDATE ask_turns SET state = 'refused', reason = 'takeover', closed_at = ? WHERE id = ?",
                            ("2026-10-08T20:00:00Z", t["id"]))
        return out
    monkeypatch.setattr(conductor.reservations, "reserve", reserve_then_takeover)
    ask(client, on["ann"], "op-cond-gap", context=on["ctx"])
    end = time.time() + 5
    while not reservation_states(hive) and time.time() < end:
        time.sleep(0.01)
    assert gone(conductor)
    time.sleep(0.3)
    assert s.bodies == []                                    # the provider was never called
    assert reservation_states(hive) == ["released"]          # the hold is released, not left held
    assert hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (on["coord"]["id"],)) == []


def test_r2_a_cut_off_call_settles_in_its_own_window_even_past_the_turns_remaining_time(client, on, monkeypatch):
    """Kimi 1 and 6: the provider answers after the turn's own remaining time would have run out; the cut-off call is
    still settled at its real cost (r1 waited only st.remaining() and then held the worst case unknown)."""
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    conductor.turn_seconds = 0.8
    s = script(client, Script("never", delay=1.6, cost=0.004))
    ask(client, on["ann"], "op-cond-slow", context=on["ctx"])
    end = time.time() + 5
    while not s.bodies and time.time() < end:
        time.sleep(0.01)
    assert client.post("/api/ask/op-cond-slow/takeover", headers=on["ann"]).json()["state"] == "taken_over"
    assert gone(conductor, timeout=6)
    assert reservation_states(hive) == ["settled"]
    usage = hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (on["coord"]["id"],))
    assert [(u["payer"], u["cost_usd"]) for u in usage] == [("user:u_ann", 0.004)]


def test_r2_shutdown_lets_cut_off_calls_settle_within_the_grace(monkeypatch):
    """Kimi 2: the app's shutdown drains cut-off calls (Conductor.aclose) before the gateway client closes, so a
    restart mid-takeover does not turn a call that answers within the grace into a held worst case."""
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    from fastapi.testclient import TestClient
    from hive.core.app import create_app
    from hive.core.config import load_settings
    import tempfile
    import pathlib
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")), admin_password="pw", petta_path=PETTA)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    tc = TestClient(app)
    tc.__enter__()
    try:
        tc.headers["Authorization"] = "Bearer " + tc.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        w = world(tc)
        hive = w["hive"]
        paid(hive, monkeypatch, w)
        s = script(tc, Script("never", delay=1.0, cost=0.004))
        ask(tc, w["ann"], "op-cond-down", context={"swarm_id": w["swarm"]["id"]})
        end = time.time() + 5
        while not s.bodies and time.time() < end:
            time.sleep(0.01)
        assert tc.post("/api/ask/op-cond-down/takeover", headers=w["ann"]).json()["state"] == "taken_over"
        time.sleep(0.1)
        assert hive.ask.conductor.late   # the cut-off call is still out when shutdown begins
    finally:
        tc.__exit__(None, None, None)    # the lifespan's shutdown
    assert reservation_states(hive) == ["settled"]


def test_r2_shutdown_past_the_grace_holds_unknown_and_says_so(client, on, monkeypatch, caplog):
    """Kimi 2 and 3: past the grace a cut-off call is held unknown (best effort across a restart), and the log says
    which turn, by exception type only."""
    caplog.set_level(logging.WARNING)
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    s = script(client, Script("never SECRETANSWER", delay=3.0, cost=0.004))
    ask(client, on["ann"], "op-cond-grace", context=on["ctx"])
    end = time.time() + 5
    while not s.bodies and time.time() < end:
        time.sleep(0.01)
    client.post("/api/ask/op-cond-grace/takeover", headers=on["ann"])
    end = time.time() + 5
    while not conductor.late and time.time() < end:
        time.sleep(0.01)
    loop = next(iter(conductor.late)).get_loop()
    asyncio.run_coroutine_threadsafe(conductor.aclose(grace=0.05), loop).result(5)
    assert not conductor.late and reservation_states(hive) == ["unknown"]
    tid = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-cond-grace'")["id"]
    assert f"turn {tid} cut-off call not settled (CancelledError)" in caplog.text and "SECRETANSWER" not in caplog.text


def test_r2_a_failed_settle_is_logged_by_type(client, on, monkeypatch, caplog):
    """Kimi 3: a call whose settlement fails (here: recording its usage) is held unknown and logged, never silent."""
    caplog.set_level(logging.WARNING)
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    script(client, Script("done", cost=0.004))

    def broken(*a, **k):
        raise RuntimeError("db busy")
    monkeypatch.setattr(conductor.reservations, "settle", broken)
    ask(client, on["ann"], "op-cond-badsettle", context=on["ctx"])
    wait(hive, "op-cond-badsettle", closed)
    tid = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-cond-badsettle'")["id"]
    assert reservation_states(hive) == ["unknown"]
    assert f"turn {tid} call not settled (RuntimeError)" in caplog.text


def test_r2_a_json_null_takeover_body_reads_as_none(client, on):
    """Kimi 5: one rule for "no body": none, whitespace, {} and JSON null all read as no body."""
    script(client, Script([call("navigate", route="#/rooms")], "never"))
    ask(client, on["ann"], "op-cond-null", context=on["ctx"])
    acts(wait(on["hive"], "op-cond-null", acts))
    r = client.post("/api/ask/op-cond-null/takeover", headers=on["ann"], content=b"null")
    assert r.status_code == 200 and r.json()["state"] == "taken_over"
    assert client.post("/api/ask/op-cond-null/takeover", headers=on["ann"], content=b"  ").json()["state"] == "taken_over"
    assert gone(on["conductor"])


# ---- takeover r3 (stand-in r2 P1, P2; Kimi r2 1, 2, 5, 6) ---------------------------------------------------------------------

class SlowProvider:
    """A real HTTP provider on 127.0.0.1 (no network beyond loopback): each request is held until released, and every
    request that arrives is recorded with the Ask turn's state at that moment (what reached the provider, and when)."""

    def __init__(self, hive=None, message=None):
        import threading
        self.hive, self.seen, self.release = hive, [], threading.Event()
        self.message = message or {"role": "assistant", "content": "fine"}
        self.loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(self.loop)
            self.server = self.loop.run_until_complete(asyncio.start_server(self.handle, "127.0.0.1", 0))
            self.port = self.server.sockets[0].getsockname()[1]
            ready.set()
            self.loop.run_forever()
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        ready.wait(5)
        self.url = f"http://127.0.0.1:{self.port}"

    async def handle(self, reader, writer):
        self.writers = getattr(self, "writers", [])
        self.writers.append(writer)
        try:
            while True:
                head = await reader.readuntil(b"\r\n\r\n")
                line = head.split(b"\r\n", 1)[0].decode()
                length = next((int(h.split(b":", 1)[1]) for h in head.split(b"\r\n") if h.lower().startswith(b"content-length:")), 0)
                await reader.readexactly(length)
                state = None
                if self.hive is not None and "/chat/completions" in line:
                    t = self.hive.db.one("SELECT state FROM ask_turns ORDER BY created_at DESC LIMIT 1")
                    state = t["state"] if t else None
                self.seen.append((line, state))
                while not self.release.is_set():
                    await asyncio.sleep(0.01)
                payload = json.dumps({"id": "x", "model": "x", "choices": [{"index": 0, "message": self.message}],
                                      "usage": {"prompt_tokens": 10, "completion_tokens": 5}}).encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    def close(self):
        self.release.set()

        async def down():
            self.server.close()
            for w in getattr(self, "writers", []):
                w.close()
            await self.server.wait_closed()
        with contextlib.suppress(Exception):
            asyncio.run_coroutine_threadsafe(down(), self.loop).result(5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()


def test_r3_a_takeover_while_the_call_waits_for_a_connection_never_reaches_the_provider(client, on, monkeypatch):
    """Stand-in r2 P1: the real gateway and transport. The call is waiting for a pooled connection (the pool's one
    connection is busy) when the takeover commits; it is released, never sent: the provider never sees it."""
    import httpx
    hive = on["hive"]
    srv = SlowProvider(hive)
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
        hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
        gw = client.app.state.gateway
        original = gw.client
        gw.client = httpx.AsyncClient(limits=httpx.Limits(max_connections=1), trust_env=False, timeout=30)
        blocker = client.portal.start_task_soon(lambda: gw.client.post(srv.url + "/busy", json={}))
        end = time.time() + 5
        while not srv.seen and time.time() < end:   # the pool's one connection is now held
            time.sleep(0.01)
        ask(client, on["ann"], "op-cond-pool", context=on["ctx"])
        end = time.time() + 5
        while not reservation_states(hive) and time.time() < end:   # the call is reserved, waiting for the connection
            time.sleep(0.01)
        time.sleep(0.2)
        assert reservation_states(hive) == ["reserved"]
        assert client.post("/api/ask/op-cond-pool/takeover", headers=on["ann"]).json()["state"] == "taken_over"
        srv.release.set()   # the connection comes free
        blocker.result(10)
        assert gone(on["conductor"])
        time.sleep(0.3)
        assert [line for line, _ in srv.seen] == ["POST /busy HTTP/1.1"]   # the conductor's call never reached it
        assert reservation_states(hive) == ["released"]
        assert hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (on["coord"]["id"],)) == []
        client.portal.call(gw.client.aclose)
        gw.client = original
    finally:
        srv.close()


def test_r3_the_send_boundary_marks_dispatch_only_as_the_request_leaves(client, on, monkeypatch):
    """Stand-in r2 P1, the other side: a call that does get its connection is dispatched as it is sent, and the provider
    sees it while the turn is still open; it is settled at its cost."""
    import httpx
    hive = on["hive"]
    srv = SlowProvider(hive)
    srv.release.set()
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
        hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
        ask(client, on["ann"], "op-cond-sent", context=on["ctx"])
        fs = wait(hive, "op-cond-sent", closed)
        assert fs[-1]["outcome"] == "complete"
        assert srv.seen == [("POST /chat/completions HTTP/1.1", "conducting")]
        assert reservation_states(hive) == ["settled"]
    finally:
        srv.close()


def test_r3_shutdown_stops_running_loops_and_drains_the_calls_they_cut_off(client, on, monkeypatch):
    """Stand-in r2 P2 and Kimi r2 6: at shutdown a turn's loop is still waiting on a sent call (no takeover, so no
    cut-off call exists yet when the drain begins). aclose cancels and joins the loop, then waits for the call that
    the cancel cut off, and it settles; afterwards no new turn loop starts (an admitted turn closes, spending nothing)."""
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    s = script(client, Script("never", "never", delay=0.8, cost=0.004))
    ask(client, on["ann"], "op-cond-live", context=on["ctx"])
    end = time.time() + 5
    while not s.bodies and time.time() < end:
        time.sleep(0.01)
    assert conductor.tasks and not conductor.late
    client.portal.call(conductor.aclose, 5)
    assert not conductor.tasks and not conductor.late
    assert reservation_states(hive) == ["settled"]
    client.post("/api/ask/op-cond-live/stop", headers=on["ann"])   # its row closes by expiry otherwise (as on any restart)
    r = ask(client, on["ann"], "op-cond-after", context=on["ctx"])
    assert r.status_code == 202
    fs = wait(hive, "op-cond-after", closed)
    assert fs[-1]["phase"] == "done" and fs[-1]["outcome"] == "error" and len(s.bodies) == 1
    assert reservation_states(hive) == ["settled"]


def test_r3_the_time_cap_after_the_call_was_sent_settles_it_too(client, on, monkeypatch):
    """Kimi r2 2: the turn's own time runs out while a sent paid call is out; the call is settled at its cost when it
    answers (r2 cancelled it and held the worst case unknown)."""
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    conductor.turn_seconds = 0.5
    script(client, Script("too late", delay=1.2, cost=0.004))
    ask(client, on["ann"], "op-cond-tcap", context=on["ctx"])
    fs = wait(hive, "op-cond-tcap", closed)
    assert fs[-1]["outcome"] == "time_cap"
    assert gone(conductor, timeout=6)
    assert reservation_states(hive) == ["settled"]


def test_r3_a_failed_shutdown_drain_is_logged_not_silent(monkeypatch, caplog):
    """Kimi r2 1: the shutdown's drain failing is a logged warning (it was suppressed silently)."""
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    from fastapi.testclient import TestClient
    from hive.core.app import create_app
    from hive.core.config import load_settings
    import tempfile
    import pathlib
    caplog.set_level(logging.WARNING)
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")), admin_password="pw", petta_path=PETTA)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    with TestClient(app):
        async def broken(*a, **k):
            raise RuntimeError("drain")
        monkeypatch.setattr(app.state.hive.ask.conductor, "aclose", broken)
    assert "ask conductor: shutdown drain failed (RuntimeError)" in caplog.text


def test_r5_the_commitment_boundary_at_most_the_one_committed_call_leaves_and_it_settles_then_nothing_follows(client, on, monkeypatch):
    """The boundary as it is (owner decision r5): dispatch is commitment to the in-flight call, not its first byte. The
    takeover is queued for the very next scheduling point after dispatch is marked, which is AnyIO's yield before the
    socket write. Then: that one already-authorised request is still handed to the OS after the takeover committed
    (pinned here, honestly), it is settled at its real cost, and no further model call or act follows, although the
    provider's answer asks for another act."""
    from asyncio import selector_events
    hive, conductor = on["hive"], on["conductor"]
    srv = SlowProvider(message={"role": "assistant", "content": None, "tool_calls": [call("navigate", route="#/rooms")]})
    srv.release.set()
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
        hive.db.execute("UPDATE agents SET budget_usd = 10 WHERE id = ?", (on["coord"]["id"],))
        handed = []
        real_write = selector_events._SelectorSocketTransport.write

        def recording_write(self, data):   # the OS hand-off itself: the turn's state at that instant
            if b"/chat/completions" in bytes(data):
                t = hive.db.one("SELECT state FROM ask_turns WHERE operation_id = 'op-cond-edge'")
                handed.append(t["state"] if t else None)
            return real_write(self, data)
        monkeypatch.setattr(selector_events._SelectorSocketTransport, "write", recording_write)
        real_dispatch = conductor.reservations.dispatch

        def dispatch_then_takeover(key):
            real_dispatch(key)
            t = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-cond-edge'")
            asyncio.get_running_loop().call_soon(lambda: hive.ask._close(t["id"], "refused", "takeover"))
        monkeypatch.setattr(conductor.reservations, "dispatch", dispatch_then_takeover)
        ask(client, on["ann"], "op-cond-edge", context=on["ctx"])
        fs = wait(hive, "op-cond-edge", closed)
        assert fs[-1].get("taken_over") is True
        assert gone(conductor)
        time.sleep(0.3)
        assert handed == ["refused"]                       # the one committed call left after the takeover: at most one
        assert [line for line, _ in srv.seen] == ["POST /chat/completions HTTP/1.1"]   # no second call, no retry
        assert reservation_states(hive) == ["settled"]     # settled at its real cost
        usage = hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (on["coord"]["id"],))
        assert len(usage) == 1 and usage[0]["cost_usd"] > 0 and usage[0]["payer"] == "user:u_ann"
        assert not acts(frames(hive, "op-cond-edge"))       # its answer asked for an act; none reached the page
    finally:
        srv.close()


def test_r4_a_cut_off_calls_settle_cancelled_by_shutdown_is_logged_once_by_the_production_path(client, on, monkeypatch, caplog):
    """Stand-in r3 P3: shutdown cancels a cut-off call's settlement while it runs (no test-supplied warning): exactly one
    warning names the turn (r3 logged nothing), and the reservation is held unknown."""
    import threading
    caplog.set_level(logging.WARNING)
    hive, conductor = on["hive"], on["conductor"]
    paid(hive, monkeypatch, on)
    script(client, Script("never", delay=0.3, cost=0.004))
    entered, leave = threading.Event(), threading.Event()

    def slow_settle(*a, **k):   # the settle's worker thread, held until the test lets it go (it then settles nothing)
        entered.set()
        leave.wait(5)
        return False
    monkeypatch.setattr(conductor.reservations, "settle", slow_settle)
    ask(client, on["ann"], "op-cond-once", context=on["ctx"])
    end = time.time() + 5
    while not reservation_states(hive) and time.time() < end:
        time.sleep(0.01)
    client.post("/api/ask/op-cond-once/takeover", headers=on["ann"])
    assert entered.wait(5)            # the call answered; its settle is under way
    client.portal.call(conductor.aclose, 0.05)
    leave.set()
    tid = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-cond-once'")["id"]
    lines = [r.getMessage() for r in caplog.records if f"turn {tid}" in r.getMessage()]
    assert len(lines) == 1 and "settle interrupted (CancelledError)" in lines[0]
    assert reservation_states(hive) == ["unknown"]
