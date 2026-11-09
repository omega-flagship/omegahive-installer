"""Personal-mind gateway r1c: the mind token and the gateway route (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.1, §2.2,
r1.1 §A, §J, §K; T-TOK*, T-ORG, T-GW*, T-GATE1-4 through the route, T-PRIV token part, T-LO).

Synthetic people, a scripted model or a loopback HTTP provider on 127.0.0.1: no network and no provider calls.
"""
import asyncio
import http.server
import json
import threading
import time

import httpx
import pytest

from hive.core import redact
from hive.core.config import Provider
from hive.core.gateway import signal_send
from hive.core.hive import token_hash
from hive.tests.test_ask import ask, world
from hive.tests.test_ask_conductor import SlowProvider
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

ORIGIN = {"Origin": "http://127.0.0.1:8700"}
BROWSER = {"answer_in": "browser"}
MSG = {"messages": [{"role": "user", "content": "hello"}]}
CHAT = "/api/me/mind/llm/v1/chat/completions"


class Fake:
    """The model: awaits the send gate as a transport does, records what reached it, answers with usage."""

    def __init__(self, cost=0.001, usage=True, delay=0.0, text="fine", key_id="env:fakepaid"):
        self.cost, self.usage, self.delay, self.text, self.bodies = cost, usage, delay, text, []
        self.key_id = key_id

    async def chat(self, agent, body):
        await signal_send()
        self.bodies.append({"model": agent["model"], **json.loads(json.dumps(body))})
        if self.delay:
            await asyncio.sleep(self.delay)
        response = {"id": "r-1", "model": agent["model"], "choices": [{"index": 0, "message": {"role": "assistant", "content": self.text}}]}
        if self.usage:
            response["usage"] = {"prompt_tokens": 10, "completion_tokens": 5}
        return response, {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": self.cost, "key_id": self.key_id}


@pytest.fixture()
def gw(client, monkeypatch):  # noqa: F811
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    w = world(client)
    hive = w["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    w["mine"] = hive.personal.ensure("user:u_ann")
    hive.db.execute("UPDATE agents SET model = 'fakepaid/x' WHERE id = ?", (w["mine"]["id"],))
    w["client"] = client
    w["fake"] = Fake()
    client.app.state.gateway.chat = w["fake"].chat
    return w


def mint(client, headers):  # noqa: F811
    r = client.post("/api/me/mind/session", headers={**headers, **ORIGIN}, json={})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def open_turn(client, headers, op):  # noqa: F811
    r = ask(client, headers, op, **BROWSER)
    assert r.status_code == 202, r.text
    return r.json()["turn_id"]


def call(client, token, turn_id, body=None, purpose="turn", origin=ORIGIN, extra=None):  # noqa: F811
    headers = {"Authorization": f"Bearer {token}", **(origin or {}), **(extra or {})}
    if purpose is not None:
        headers["X-Mind-Purpose"] = purpose
    if turn_id is not None:
        headers["X-Mind-Turn"] = turn_id
    return client.post(CHAT, headers=headers, json=MSG if body is None else body)


def code(r):
    return r.json().get("error", {}).get("code") if r.status_code >= 400 else None


def states(hive):
    return [r["state"] for r in hive.db.all("SELECT state FROM cost_reservations ORDER BY reserved_at")]


def hive_headers(r):
    return {k for k in r.headers if k.lower().startswith("x-hive-")}


# ---- T-TOK1: minted, hashed, registered, narrow ----------------------------------------------------------------------

def test_T_TOK1_mint_shape_storage_and_the_token_reaches_the_gateway_only(gw):
    client, hive = gw["client"], gw["hive"]
    r = client.post("/api/me/mind/session", headers={**gw["ann"], **ORIGIN}, json={})
    assert r.status_code == 201 and r.headers["cache-control"] == "no-store"
    out = r.json()
    assert set(out) == {"token", "expires_at", "mind", "scope"} and out["scope"] == ["chat"]
    assert out["token"].startswith("mt_") and len(out["token"]) > 40 and out["mind"] == {"id": gw["mine"]["id"]}
    row = hive.db.one("SELECT * FROM mind_tokens")
    assert row["token_hash"] == token_hash(out["token"]) and 1795 < row["expires_at"] - row["created_at"] <= 1800
    assert out["token"] not in json.dumps(hive.db.all("SELECT * FROM mind_tokens"))           # stored hashed only
    assert redact.REDACTOR.holds(out["token"])                                                # registered while live
    assert client.post("/api/me/mind/session", headers={**gw["ann"], **ORIGIN}, json={"x": 1}).json()["error"]["code"] == "invalid"
    # it is not a session and not a mind's token: every other family refuses it
    auth = {"Authorization": f"Bearer {out['token']}", **ORIGIN}
    for method, path in (("GET", "/api/me/mind"), ("GET", "/api/ask"), ("POST", "/api/me/mind/session"),
                         ("GET", "/api/agents"), ("POST", "/llm/v1/chat/completions"), ("GET", "/api/agent/goals"),
                         ("POST", "/mcp")):
        resp = client.request(method, path, headers=auth, json={})
        assert resp.status_code in (401, 404), (path, resp.status_code)
        assert resp.status_code != 200 and out["token"] not in resp.text
    assert call(client, out["token"], open_turn(client, gw["ann"], "op-tok1-01")).status_code == 200


def test_T_TOK1_the_events_socket_and_the_hub_refuse_it(gw):
    client = gw["client"]
    token = mint(client, gw["ann"])
    from starlette.websockets import WebSocketDisconnect
    for path in (f"/api/events?token={token}", "/agent-hub"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path, headers={"Authorization": f"Bearer {token}"}) as ws:
                ws.send_json({"type": "auth", "token": token})
                ws.receive_json()
                ws.receive_json()


# ---- T-TOK2: every revocation path ---------------------------------------------------------------------------------

@pytest.mark.parametrize("how", ["delete", "signout", "disable", "mind_deleted", "expiry", "fifth_mint"])
def test_T_TOK2_revocation_paths(gw, how):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-tok2-01")
    assert call(client, token, turn).status_code == 200
    if how == "delete":
        r = client.delete("/api/me/mind/session", headers={**gw["ann"], **ORIGIN})
        assert r.json() == {"revoked": 1}
    elif how == "signout":
        assert client.post("/api/auth/logout", headers=gw["ann"]).status_code == 200
    elif how == "disable":
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_ann'")
    elif how == "mind_deleted":
        hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (gw["mine"]["id"],))
    elif how == "expiry":
        hive.db.execute("UPDATE mind_tokens SET expires_at = ?", (time.time() - 1,))
    elif how == "fifth_mint":
        for _ in range(4):
            mint(client, gw["ann"])
        assert hive.db.one("SELECT COUNT(*) AS n FROM mind_tokens WHERE revoked_at IS NULL")["n"] == 4
    r = call(client, token, turn)
    assert (r.status_code, code(r)) == (401, "mind_token_expired"), r.text
    assert not hive_headers(r)
    hive.mind_tokens.sweep()
    if how != "disable" and how != "mind_deleted":   # those leave the token row live; the resolver refuses it each call
        assert not redact.REDACTOR.holds(token)                                    # unregistered once it is gone


def test_T_TOK2_the_redactor_unregisters_on_delete_and_expiry(gw):
    client, hive = gw["client"], gw["hive"]
    a, b = mint(client, gw["ann"]), mint(client, gw["ann"])
    assert redact.REDACTOR.holds(a) and redact.REDACTOR.holds(b)
    hive.db.execute("UPDATE mind_tokens SET expires_at = ? WHERE token_hash = ?", (time.time() - 1, token_hash(a)))
    hive.mind_tokens.sweep()
    assert not redact.REDACTOR.holds(a) and redact.REDACTOR.holds(b)
    client.delete("/api/me/mind/session", headers={**gw["ann"], **ORIGIN})
    assert not redact.REDACTOR.holds(b)


# ---- T-TOK3: only a header Bearer mt_ token -------------------------------------------------------------------------

def test_T_TOK3_query_cookie_session_and_agent_tokens_are_refused(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-tok3-01")
    h = {**ORIGIN, "X-Mind-Purpose": "turn", "X-Mind-Turn": turn}
    assert code(client.post(CHAT + f"?token={token}", headers=h, json=MSG)) == "invalid"
    assert code(client.post(CHAT + f"?token={token}", headers={**h, "Authorization": f"Bearer {token}"}, json=MSG)) == "invalid"
    assert code(client.post(CHAT, headers={**h, "Cookie": f"hive_token={token}"}, json=MSG)) == "mind_token_required"
    assert code(client.post(CHAT, headers={**h, **gw["ann"]}, json=MSG)) == "mind_token_required"   # the session itself
    agent_token = client.post("/api/agents", json={"name": "Probe", "swarm_id": gw["swarm"]["id"]}).json()["token"]
    assert code(client.post(CHAT, headers={**h, "Authorization": f"Bearer {agent_token}"}, json=MSG)) == "mind_token_required"
    assert code(client.post(CHAT, headers={**h, "Authorization": "Bearer mt_not-a-real-token"}, json=MSG)) == "mind_token_required"
    assert gw["fake"].bodies == []


def test_T_TOK4_the_101st_call_on_one_token_is_refused(gw):
    client, hive = gw["client"], gw["hive"]
    hive.settings.max_llm_calls_per_minute = 0
    import os
    os.environ["HIVE_MIND_TURN_MAX_CALLS"] = "500"
    try:
        token = mint(client, gw["ann"])
        turn = open_turn(client, gw["ann"], "op-tok4-01")
        gw["fake"].cost = 0.0
        for i in range(100):
            assert call(client, token, turn).status_code == 200, i
        r = call(client, token, turn)
        assert (r.status_code, code(r)) == (401, "mind_token_expired") and len(gw["fake"].bodies) == 100
        assert call(client, mint(client, gw["ann"]), turn).status_code == 200            # a fresh mint carries on
    finally:
        del os.environ["HIVE_MIND_TURN_MAX_CALLS"]


# ---- T-ORG: Origin on the token, gateway and done routes ------------------------------------------------------------

@pytest.mark.parametrize("origin,expect", [(None, "origin_required"), ("null", "origin_refused"),
                                           ("https://evil.example", "origin_refused")])
def test_T_ORG_origin_none_null_or_foreign_is_403(gw, origin, expect):
    client = gw["client"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-org-0001")
    o = {} if origin is None else {"Origin": origin}
    r = client.post("/api/me/mind/session", headers={**gw["ann"], **o}, json={})
    assert (r.status_code, code(r)) == (403, expect)
    assert client.delete("/api/me/mind/session", headers={**gw["ann"], **o}).status_code == 403
    r = call(client, token, turn, origin=o)
    assert (r.status_code, code(r)) == (403, expect) and not hive_headers(r)
    assert client.post("/api/ask/op-org-0001/done", headers={**gw["ann"], **o}, json={"outcome": "answered"}).status_code == 403
    assert gw["fake"].bodies == []


# ---- T-GW1: a call, its money and its headers ------------------------------------------------------------------------

def test_T_GW1_a_call_is_billed_reserved_and_answered_with_its_money_headers(gw):
    client, hive, mine = gw["client"], gw["hive"], gw["mine"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw1-0001")
    r = call(client, token, turn, body={**MSG, "model": "other/model", "max_tokens": 100})
    assert r.status_code == 200, r.text
    assert r.json()["choices"][0]["message"]["content"] == "fine" and r.json()["id"] == "r-1"     # the provider's body
    assert r.headers["x-hive-call-cost-state"] == "settled" and r.headers["x-hive-call-cost-usd"] == "0.001000"
    assert r.headers["x-hive-turn-calls-remaining"] == "49" and r.headers["cache-control"] == "no-store"
    assert float(r.headers["x-hive-turn-remaining-usd"]) == pytest.approx(0.249, abs=1e-6)   # min(turn 0.25, thread 0.25) - 0.001
    assert gw["fake"].bodies[0]["model"] == "fakepaid/x" and "model" not in {k for k in gw["fake"].bodies[0] if k != "model"} - {"model"}
    assert gw["fake"].bodies[0]["max_tokens"] == 100
    usage = hive.db.one("SELECT * FROM usage")
    assert (usage["agent_id"], usage["payer"], usage["cost_usd"]) == (mine["id"], "user:u_ann", 0.001)
    rid = hive.db.one("SELECT id, state FROM cost_reservations")
    assert rid["state"] == "settled"
    meta = json.loads(hive.db.one("SELECT metadata FROM cost_reservation_details")["metadata"])
    assert (meta["kind"], meta["payer"], meta["turn"], meta["agent"]) == ("browser-mind", "user:u_ann", turn, mine["id"])
    scopes = {s["scope"] for s in hive.db.all("SELECT scope FROM cost_reservation_scopes")}
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,))
    assert {"askturn:" + turn, "askthread:" + t["thread_id"], "person:u_ann:month"} <= scopes
    assert t["calls"] == 1 and t["state"] == "browser"
    assert hive.agent(mine["id"])["status"] == "asleep"
    # the turn's own spend reads from its reservations when it closes
    client.post(f"/api/ask/op-gw1-0001/done", headers={**gw["ann"], **ORIGIN}, json={"outcome": "answered"})
    assert hive.db.one("SELECT spent_usd_approx FROM ask_turns WHERE id = ?", (turn,))["spent_usd_approx"] == pytest.approx(0.001)


def test_T_GW1_a_free_model_takes_no_reservation_but_counts(gw):
    client, hive = gw["client"], gw["hive"]
    hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (gw["mine"]["id"],))
    gw["fake"].cost = 0.0
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw1-free")
    r = call(client, token, turn)
    assert r.status_code == 200 and r.headers["x-hive-call-cost-state"] == "free"
    assert states(hive) == [] and hive.db.one("SELECT calls FROM ask_turns WHERE id = ?", (turn,))["calls"] == 1


# ---- T-GW2: the request shape -----------------------------------------------------------------------------------

def test_T_GW2_headers_and_body_allowlist(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw2-0001")
    assert code(call(client, token, turn, purpose=None)) == "purpose_required"
    assert code(call(client, token, turn, purpose="consolidate")) == "windows_unavailable"
    assert code(call(client, token, turn, purpose="other")) == "invalid"
    assert code(call(client, token, None)) == "not_available"
    assert code(call(client, token, "at_nosuchturn")) == "not_available"
    for body in ({**MSG, "temperature": 1}, {**MSG, "max_tokens": 0}, {**MSG, "max_tokens": 4097}, {**MSG, "max_tokens": True},
                 {"messages": []}, {"tools": []}, {**MSG, "stream": True}):
        r = call(client, token, turn, body=body)
        assert (r.status_code, code(r)) == (400, "invalid"), body
    r = call(client, token, turn, body={"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]})
    assert (r.status_code, code(r)) == (400, "unsupported_content")
    big = {"messages": [{"role": "user", "content": "x" * (1024 * 1024)}]}
    assert call(client, token, turn, body=big).status_code == 413
    assert gw["fake"].bodies == [] and hive.db.one("SELECT calls FROM ask_turns WHERE id = ?", (turn,))["calls"] == 0
    # another person's turn reads exactly as none
    bob_turn_owner = gw["jon"]
    hive.personal.ensure("user:u_jon")
    jon_turn = open_turn(client, bob_turn_owner, "op-gw2-jon1")
    assert code(call(client, token, jon_turn)) == "not_available"
    # a closed turn
    client.post("/api/ask/op-gw2-0001/done", headers={**gw["ann"], **ORIGIN}, json={"outcome": "answered"})
    assert (call(client, token, turn).status_code, code(call(client, token, turn))) == (409, "turn_closed")


# ---- T-GW3: the call ceiling ---------------------------------------------------------------------------------------

def test_T_GW3_the_51st_call_is_call_cap_with_no_dispatch(gw):
    client, hive = gw["client"], gw["hive"]
    gw["fake"].cost = 0.0
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw3-0001")
    for i in range(50):
        assert call(client, token, turn).status_code == 200, i
    r = call(client, token, turn)
    assert (r.status_code, code(r)) == (429, "call_cap") and len(gw["fake"].bodies) == 50 and not hive_headers(r)
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,))
    frames = [json.loads(f["frame"]) for f in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (turn,))]
    assert t["state"] == "refused" and frames[-1]["outcome"] == "call_cap"
    assert code(call(client, token, turn)) == "turn_closed"


# ---- T-GW4: concurrent calls never exceed the turn's and the thread's guards ------------------------------------------

@pytest.mark.parametrize("guard", ["turn", "thread"])
def test_T_GW4_concurrent_calls_never_exceed_the_turn_or_thread_cap(gw, monkeypatch, guard):
    client, hive = gw["client"], gw["hive"]
    if guard == "turn":
        monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "0.01")
    else:
        assert client.put("/api/me/ask", headers=gw["ann"], json={"thread_budget_usd": 0.01}).status_code == 200
    gw["fake"].delay, gw["fake"].cost = 0.2, 0.004
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw4-0001")
    out = []

    def one():
        out.append(call(client, token, turn))
    threads = [threading.Thread(target=one) for _ in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join(20)
    ok = [r for r in out if r.status_code == 200]
    refused = [r for r in out if r.status_code != 200]
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,))
    label = "askturn:" + turn if guard == "turn" else "askthread:" + t["thread_id"]
    total = hive.db.one("SELECT COALESCE(SUM(CASE WHEN r.state = 'settled' THEN r.actual ELSE r.maximum END), 0) AS n "
                        "FROM cost_reservations r JOIN cost_reservation_scopes c ON c.reservation = r.id WHERE c.scope = ? "
                        "AND r.state != 'released'", (label,))["n"] / 1e6
    assert ok and refused and total <= 0.01 + 1e-9
    kinds = {r.json()["error"].get("limit", {}).get("kind") for r in refused if code(r) == "spend_limit"}
    assert kinds <= {"per_turn" if guard == "turn" else "thread"} and kinds
    assert all(code(r) in ("spend_limit", "turn_closed") and not hive_headers(r) for r in refused)
    frames = [json.loads(f["frame"]) for f in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (turn,))]
    assert t["state"] == "refused" and frames[-1]["outcome"] == "spend_cap" and frames[-1]["limit"]["kind"] in kinds


def test_T_GW4_no_monthly_total_is_monthly_total_required_and_closes_the_turn(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["jon"])                                # Jon: an admin with no month rule, on the hive's key
    hive.db.execute("UPDATE agents SET model = 'fakepaid/x' WHERE personal_of = 'user:u_jon'")
    turn = open_turn(client, gw["jon"], "op-gw4-jon1")
    r = call(client, token, turn)
    assert (r.status_code, code(r)) == (402, "spend_limit")
    assert r.json()["error"]["limit"] == {"kind": "member_allowance", "current_usd": None, "limit_usd": None,
                                          "estimate_usd": None, "reason": "monthly_total_required"}
    assert states(hive) == [] and gw["fake"].bodies == []


# ---- T-GW5: an unknown outcome stays held, also after /done ----------------------------------------------------------

def test_T_GW5_an_unknown_call_stays_held_after_done(gw):
    client, hive = gw["client"], gw["hive"]
    gw["fake"].usage = False
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw5-0001")
    r = call(client, token, turn)
    assert r.status_code == 200 and r.headers["x-hive-call-cost-state"] == "unknown"
    assert float(r.headers["x-hive-call-cost-usd"]) > 0
    assert states(hive) == ["unknown"]
    client.post("/api/ask/op-gw5-0001/done", headers={**gw["ann"], **ORIGIN}, json={"outcome": "answered"})
    assert states(hive) == ["unknown"]


# ---- T-GW6 / T-GW7: no provider text; no money headers on a refusal ----------------------------------------------------

class _ErrorProvider:
    """A loopback provider that fails with a body full of words that must never reach the page."""

    def __init__(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):   # noqa: N802
                self.rfile.read(int(self.headers.get("content-length") or 0))
                body = b'{"error": {"message": "SECRET-PROVIDER-WORDS sk-or-v1-abcdefghijklmnop"}}'
                self.send_response(500)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()


def test_T_GW6_a_provider_failure_returns_a_code_only_and_keeps_the_hold(gw):
    client, hive = gw["client"], gw["hive"]
    srv = _ErrorProvider()
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        gwy = client.app.state.gateway
        del gwy.chat   # the real gateway and transport
        token = mint(client, gw["ann"])
        turn = open_turn(client, gw["ann"], "op-gw6-0001")
        r = call(client, token, turn)
        assert (r.status_code, code(r)) == (502, "upstream_error")
        assert "SECRET" not in r.text and "sk-or" not in r.text and r.json()["error"]["held_usd"] > 0
        assert not hive_headers(r) and states(hive) == ["unknown"]
    finally:
        srv.close()


def test_T_GW7_no_money_headers_on_any_refusal(gw):
    client = gw["client"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw7-0001")
    for r in (call(client, token, turn, purpose=None), call(client, token, "at_none"), call(client, "mt_x", turn),
              call(client, token, turn, body={"bad": 1}), call(client, token, turn, origin={})):
        assert r.status_code >= 400 and not hive_headers(r)


# ---- T-GATE1-4 (r1.1 §A): through the route, with the real gateway and a blocked connection --------------------------

class _Blocked:
    """The real gateway with a one-connection pool held by another request: the gateway call waits for a connection."""

    def __init__(self, gw):
        self.client, self.hive = gw["client"], gw["hive"]
        self.srv = SlowProvider(self.hive)
        self.hive.settings.providers["fakepaid"] = Provider("fakepaid", self.srv.url, prices={"*": {"in": 1, "out": 1}})
        self.gwy = self.client.app.state.gateway
        del self.gwy.chat
        self.original = self.gwy.client
        self.gwy.client = httpx.AsyncClient(limits=httpx.Limits(max_connections=1), trust_env=False, timeout=30)
        self.blocker = self.client.portal.start_task_soon(lambda: self.gwy.client.post(self.srv.url + "/busy", json={}))
        end = time.time() + 5
        while not self.srv.seen and time.time() < end:
            time.sleep(0.01)

    def start(self, token, turn):
        self.result = []
        self.thread = threading.Thread(target=lambda: self.result.append(call(self.client, token, turn)))
        self.thread.start()
        end = time.time() + 5
        while states(self.hive) != ["reserved"] and time.time() < end:   # reserved, waiting for the connection
            time.sleep(0.01)
        time.sleep(0.2)
        assert states(self.hive) == ["reserved"]

    def finish(self):
        self.srv.release.set()
        self.blocker.result(10)
        self.thread.join(10)
        time.sleep(0.2)
        return self.result[0]

    def close(self):
        self.client.portal.call(self.gwy.client.aclose)
        self.gwy.client = self.original
        self.srv.close()


def _closer(gw, how, token, turn):
    client, hive = gw["client"], gw["hive"]
    if how == "stop":
        assert client.post("/api/ask/op-gate-0001/stop", headers=gw["ann"]).status_code == 200
    elif how == "done":
        assert client.post("/api/ask/op-gate-0001/done", headers={**gw["ann"], **ORIGIN}, json={"outcome": "stopped"}).status_code == 200
    elif how == "idle":
        hive.ask.expire(time.time() + 121)
    elif how == "absolute":
        import os
        os.environ["HIVE_ASK_BROWSER_IDLE_SECONDS"] = "100000"
        try:
            hive.ask.expire(hive.db.one("SELECT deadline FROM ask_turns WHERE id = ?", (turn,))["deadline"] + 1)
        finally:
            del os.environ["HIVE_ASK_BROWSER_IDLE_SECONDS"]
    elif how == "delete":
        assert client.delete("/api/me/mind/session", headers={**gw["ann"], **ORIGIN}).json() == {"revoked": 1}
    elif how == "signout":
        assert client.post("/api/auth/logout", headers=gw["ann"]).status_code == 200
    elif how == "disable":
        hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_ann'")
    elif how == "mind_deleted":
        hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (gw["mine"]["id"],))
    elif how == "token_expiry":
        hive.db.execute("UPDATE mind_tokens SET expires_at = ?", (time.time() - 1,))


@pytest.mark.parametrize("how,expect", [("stop", (409, "turn_closed")), ("done", (409, "turn_closed")),          # T-GATE1
                                        ("idle", (409, "turn_closed")), ("absolute", (409, "turn_closed")),       # T-GATE2
                                        ("delete", (401, "mind_token_expired")), ("signout", (401, "mind_token_expired")),
                                        ("disable", (401, "mind_token_expired")),
                                        ("mind_deleted", (401, "mind_token_expired")),
                                        ("token_expiry", (401, "mind_token_expired"))])                           # T-GATE3
def test_T_GATE1_3_a_close_or_revocation_while_the_call_waits_sends_nothing_and_releases(gw, how, expect):
    token = mint(gw["client"], gw["ann"])
    turn = open_turn(gw["client"], gw["ann"], "op-gate-0001")
    b = _Blocked(gw)
    try:
        b.start(token, turn)
        _closer(gw, how, token, turn)
        r = b.finish()
        assert (r.status_code, code(r)) == expect, r.text
        assert [line for line, _ in b.srv.seen] == ["POST /busy HTTP/1.1"]          # the call never reached the provider
        assert states(gw["hive"]) == ["released"] and not hive_headers(r)
        assert gw["hive"].db.all("SELECT * FROM usage") == []
    finally:
        b.close()


def test_T_GATE4_a_close_after_the_gate_passed_settles_the_call_at_its_cost(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gate-0001")
    srv = SlowProvider(hive)
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        del client.app.state.gateway.chat
        result = []
        th = threading.Thread(target=lambda: result.append(call(client, token, turn)))
        th.start()
        end = time.time() + 5
        while not srv.seen and time.time() < end:
            time.sleep(0.01)
        assert srv.seen == [("POST /chat/completions HTTP/1.1", "browser")] and states(hive) == ["dispatched"]
        assert client.post("/api/ask/op-gate-0001/stop", headers=gw["ann"]).status_code == 200   # closes while in flight
        srv.release.set()
        th.join(10)
        r = result[0]
        assert r.status_code == 200 and r.headers["x-hive-call-cost-state"] == "settled"
        assert states(hive) == ["settled"] and hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 1
    finally:
        srv.close()


@pytest.mark.parametrize("past", ["idle", "absolute", "both"])
def test_T_GATE2_r1c2_a_deadline_passed_while_queued_sends_nothing_without_reconciliation(gw, past):
    """r1c stand-in P1-2: the deadlines are applied at the send gate itself. Nothing calls ask.expire() here and the
    turn is still `browser` in its row when the gate runs (this client runs no reconcile loop): the queued call must not
    leave."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gate-0001")
    b = _Blocked(gw)
    try:
        b.start(token, turn)
        gone = time.time() - 1
        if past in ("absolute", "both"):
            hive.db.execute("UPDATE ask_turns SET deadline = ? WHERE id = ?", (gone, turn))
        if past in ("idle", "both"):
            hive.db.execute("UPDATE ask_turns SET last_call_at = ? WHERE id = ?", (gone - 121, turn))
        assert hive.db.one("SELECT state FROM ask_turns WHERE id = ?", (turn,))["state"] == "browser"
        r = b.finish()
        assert (r.status_code, code(r)) == (409, "turn_closed"), r.text
        assert [line for line, _ in b.srv.seen] == ["POST /busy HTTP/1.1"]          # the call never reached the provider
        assert states(hive) == ["released"] and not hive_headers(r)
        assert hive.db.all("SELECT * FROM usage") == []
        t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,))
        assert t["state"] == "refused"                                              # and the turn closed at the gate
    finally:
        b.close()


def test_r1c2_the_turns_last_allowed_call_passes_the_gate(gw):
    """Kimi r1c note 2: the gate allows calls == ceiling (this call is already counted); the 50th call is answered."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-gw3-0050")
    hive.db.execute("UPDATE ask_turns SET calls = 49 WHERE id = ?", (turn,))
    r = call(client, token, turn)
    assert r.status_code == 200 and r.headers["x-hive-turn-calls-remaining"] == "0" and len(gw["fake"].bodies) == 1
    assert code(call(client, token, turn)) == "call_cap"


# ---- r1c stand-in P1-1: no mind token in any access-log line, in every mode -------------------------------------------

def _logged(gw, requests):
    """A real uvicorn on 127.0.0.1 serving the hive, with the hive's own access-log filter (hive/__main__, as main()
    installs it) and the redactor off (not a local owner): runs `requests(http, base)` and returns every captured line."""
    import io
    import logging

    import uvicorn

    from hive.__main__ import ACCESS_LOGGERS, redact_access_logs

    assert not redact.REDACTOR.enabled
    loggers = [logging.getLogger(name) for name in ACCESS_LOGGERS]
    before = [list(lg.filters) for lg in loggers]
    out = io.StringIO()
    handler = logging.StreamHandler(out)
    handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
    logging.getLogger("uvicorn").addHandler(handler)
    server = uvicorn.Server(uvicorn.Config(gw["client"].app, host="127.0.0.1", port=0, lifespan="off", log_config=None,
                                           log_level="info", access_log=True))
    th = threading.Thread(target=server.run, daemon=True)
    try:
        redact_access_logs()
        th.start()
        end = time.time() + 10
        while not server.started and time.time() < end:
            time.sleep(0.02)
        base = "http://127.0.0.1:%d" % server.servers[0].sockets[0].getsockname()[1]
        with httpx.Client(trust_env=False, timeout=10) as http:
            requests(http, base)
    finally:
        server.should_exit = True
        th.join(10)
        logging.getLogger("uvicorn").removeHandler(handler)
        for lg, filters in zip(loggers, before):
            lg.filters[:] = filters
    return out.getvalue()


def _no_token_in(text, token):
    """Neither the token's secret nor its first 16 characters, in the text or in any percent-decoding of it."""
    import urllib.parse
    secret = token[len("mt_"):]
    for _ in range(10):
        assert secret not in text and secret[:16] not in text, text
        text, before = urllib.parse.unquote(text), text
        if text == before:
            break


def test_r1c2_the_access_log_never_keeps_a_mind_token(gw):
    """Every way of putting a live token in a URL's query is refused and leaves no usable copy in the access log."""
    import urllib.parse
    client = gw["client"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-log-0001")
    encoded = urllib.parse.quote(token, safe="").replace("_", "%5F")
    h = {"Authorization": f"Bearer {token}", **ORIGIN, "X-Mind-Purpose": "turn", "X-Mind-Turn": turn}

    def requests(http, base):
        for url in (CHAT + f"?token={token}", CHAT + f"?t={token}", CHAT + f"?{token}", CHAT + f"?x={encoded}",
                    f"/api/ask?q={token}", f"/api/nosuch/{token}"):
            r = http.post(base + url, headers=h, json=MSG)
            assert r.status_code != 200 and token not in r.text, url
        http.get(base + "/api/me/mind/inbox?after=x1", headers=h)   # control: another route's query stays as on live

    text = _logged(gw, requests)
    assert text.count("uvicorn.access") == 7 and "/api/me/mind/inbox?after=x1" in text, text
    _no_token_in(text, token)
    assert gw["fake"].bodies == [] and "/api/me/mind/llm/v1/chat/completions?REDACTED" in text


def _forms(token):
    """A token as a client might put it in a URL: plain, after a word character or `_`, `_` encoded once and twice,
    and every third character encoded with lower-case hex under an upper-case prefix."""
    secret = token[len("mt_"):]
    once = token.replace("_", "%5F")
    mixed = "M%74%5f" + "".join("%%%02x" % ord(c) if i % 3 == 0 else c for i, c in enumerate(secret))
    return {"plain": token, "word": "x" + token, "underscore": "prefix_" + token, "once": once,
            "twice": once.replace("%", "%25"), "mixed": mixed, "mixed_twice": mixed.replace("%", "%25")}


def test_r1c3_a_token_in_any_path_or_query_form_is_not_logged_even_after_a_restart(gw):
    """r1c.2 stand-in P1 / Kimi P2: the token shape alone keeps every form out of the log, in a 404 path and in a
    query. After a restart the redactor holds no raw token (simulated: this process's registry emptied) while the token
    is still valid; nothing in the filter depends on that registry."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-log-0002")
    hive.mind_tokens._raw.clear()
    redact.unregister(token)
    assert not redact.REDACTOR.holds(token)
    assert call(client, token, turn).status_code == 200                              # still valid after the "restart"
    forms = _forms(token)

    def requests(http, base):
        for name, form in forms.items():
            for url in (f"/api/nosuch/{form}", f"/api/ask?q={form}"):
                r = http.get(base + url)
                assert r.status_code != 200 and token not in r.text, (name, url)

    text = _logged(gw, requests)
    assert text.count("uvicorn.access") == 2 * len(forms), text
    _no_token_in(text, token)


def test_r1c3_scrub_logged_decodes_until_stable_and_fails_closed():
    import urllib.parse

    from hive.core.mind_gateway import UNLOGGABLE, scrub_logged
    token = "mt_" + "Ab3_" + "x" * 39
    assert scrub_logged("/api/ask?q=1&after=x1") == "/api/ask?q=1&after=x1"          # nothing to find: unchanged
    assert scrub_logged("/api/a/mt_short") == "/api/a/mt_short"                      # not a token's length
    for name, form in _forms(token).items():
        out = scrub_logged("/api/nosuch/" + form)
        assert "Ab3_xxxxxxxx" not in out and "Ab3_xxxxxxxx" not in urllib.parse.unquote(urllib.parse.unquote(out)), name
    assert scrub_logged("/a/" + token + "/%FF") == UNLOGGABLE                         # not UTF-8 once decoded
    deep = token.replace("_", "%5F")
    for _ in range(9):
        deep = deep.replace("%", "%25")                                              # ten encodings deep
    assert scrub_logged("/a/" + deep) == UNLOGGABLE                                  # still changing after 8 decodings
    assert scrub_logged("/a/%FF") == UNLOGGABLE


def test_r1c3_an_idle_deadline_passed_while_the_body_is_read_is_not_refreshed_away(gw, monkeypatch):
    """r1c.2 stand-in P1: the turn is checked before the body is awaited; if its idle deadline passes during that
    await, the count must refuse (not refresh last_call_at): 409 turn_closed, the turn closes timed_out, nothing is
    reserved or sent."""
    from hive.core.mind_gateway import MindGateway
    client, hive = gw["client"], gw["hive"]
    monkeypatch.setenv("HIVE_ASK_BROWSER_IDLE_SECONDS", "1")
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-idle-0001")
    real = MindGateway.chat

    async def chat(self, request, origins, read_body):
        async def slow_body(req, limit):
            data = await read_body(req, limit)        # the route's own reader
            await asyncio.sleep(1.3)                  # the idle deadline passes while the body is being read
            return data
        return await real(self, request, origins, slow_body)
    monkeypatch.setattr(MindGateway, "chat", chat)
    r = call(client, token, turn)
    assert (r.status_code, code(r)) == (409, "turn_closed"), r.text
    assert gw["fake"].bodies == [] and states(hive) == [] and not hive_headers(r)
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,))
    frames = [json.loads(f["frame"]) for f in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (turn,))]
    assert t["state"] == "refused" and t["calls"] == 0 and frames[-1]["outcome"] == "time_cap"


# ---- T-PRIV (the token part) --------------------------------------------------------------------------------------

def test_T_PRIV_no_table_holds_the_token_or_the_turns_words(gw):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    words = "quartz-zebra-private"
    turn = open_turn(client, gw["ann"], "op-priv-001")
    assert call(client, token, turn, body={"messages": [{"role": "user", "content": words}]}).status_code == 200
    client.delete("/api/me/mind/session", headers={**gw["ann"], **ORIGIN})
    for t in hive.db.all("SELECT name FROM sqlite_master WHERE type = 'table'"):
        dumped = json.dumps(hive.db.all(f'SELECT * FROM "{t["name"]}"'), default=str)
        assert token not in dumped and words not in dumped, t["name"]


# ---- the flag unset: the three routes are unknown paths ----------------------------------------------------------------

def test_flag_unset_the_token_and_gateway_routes_are_unknown_paths(client, monkeypatch):  # noqa: F811
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    w = world(client)
    for method, path in (("POST", "/api/me/mind/session"), ("DELETE", "/api/me/mind/session"), ("POST", CHAT)):
        a = client.request(method, path, headers={**w["ann"], **ORIGIN}, json={})
        b = client.request(method, path + "-nosuch", headers={**w["ann"], **ORIGIN}, json={})
        assert (a.status_code, a.json()) == (b.status_code, b.json()) == (404, {"detail": "Not Found"}), path
    assert w["hive"].db.one("SELECT COUNT(*) AS n FROM mind_tokens")["n"] == 0


# ---- T-LO (J1b, now on live): the local owner's own key completes a turn -----------------------------------------------

def test_T_LO1_2_a_local_owner_on_their_own_key_completes_a_browser_turn(monkeypatch):
    from fastapi.testclient import TestClient

    from hive.tests import test_local_owner as lo
    for name in lo.localowner.SIGNIN_SETTINGS + lo.localowner.PUBLIC_SETTINGS + ("HIVE_HOST", "HIVE_LOCAL_BROWSER_PORT"):
        monkeypatch.delenv(name, raising=False)
    for k, v in (("HIVE_LOCAL_OWNER", "1"), ("HIVE_MIND_SANDBOX", "1"), ("HIVE_PORT", "8700"), ("HIVE_MIND_GATEWAY", "1")):
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    monkeypatch.setattr(lo.preflight, "run_and_record", lambda data_dir: dict(lo.PASSED))
    app, data = lo.make_app()
    try:
        with TestClient(app, base_url=lo.BASE) as c:
            c.local = app.state.hive.local_owner
            hive = app.state.hive
            auth = {"Authorization": f"Bearer {lo.sign_in(c)}"}
            owner = hive.ownhive.owner()
            mine = hive.personal.ensure(owner)
            hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
            hive.db.execute("UPDATE agents SET model = 'fakepaid/x' WHERE id = ?", (mine["id"],))
            hive.keyring.ring["keys"]["k_0000000f"] = {"id": "k_0000000f", "provider": "fakepaid", "label": "mine",
                                                     "owner": owner, "secret": "sk-test-owner-key-0000", "created_at": time.time()}
            hive.keyring.ring["defaults"]["fakepaid"] = "k_0000000f"
            hive.ownhive._write_limit(owner, "*", "self", 10.0, None, "owner", "", owner)
            fake = Fake(cost=0.002, key_id="k_0000000f")
            app.state.gateway.chat = fake.chat
            r = c.post("/api/ask", headers={**auth, **lo.ORIGIN}, json={"operation_id": "op-lo-00001", "text": "hi", **BROWSER})
            assert r.status_code == 202, r.text
            turn = r.json()["turn_id"]
            m = c.post("/api/me/mind/session", headers={**auth, **lo.ORIGIN}, json={})
            assert m.status_code == 201, m.text
            token = m.json()["token"]
            assert redact.REDACTOR.enabled and redact.REDACTOR.holds(token)
            # no Origin: refused by the gateway itself (the boundary lets a non-session Bearer through)
            r0 = c.post(CHAT, headers={"Authorization": f"Bearer {token}", "X-Mind-Purpose": "turn", "X-Mind-Turn": turn}, json=MSG)
            assert (r0.status_code, code(r0)) == (403, "origin_required")
            r1 = c.post(CHAT, headers={"Authorization": f"Bearer {token}", "X-Mind-Purpose": "turn", "X-Mind-Turn": turn, **lo.ORIGIN},
                        json=MSG)
            assert r1.status_code == 200, r1.text and r1.headers["x-hive-call-cost-state"] == "settled"
            u = hive.db.one("SELECT payer, key_id FROM usage")
            assert (u["payer"], u["key_id"]) == (owner, "k_0000000f")
            meta = json.loads(hive.db.one("SELECT metadata FROM cost_reservation_details")["metadata"])
            assert (meta["payer"], meta["key"]) == (owner, "k_0000000f")
            assert hive.ownhive.spent(hive.ownhive.total_row(owner)["scope"]) == pytest.approx(0.002)
            assert c.delete("/api/me/mind/session", headers={**auth, **lo.ORIGIN}).json() == {"revoked": 1}
            assert not redact.REDACTOR.holds(token)
    finally:
        redact.REDACTOR.enabled = False
        import shutil
        shutil.rmtree(data, ignore_errors=True)


# ---- the r1e hooks (PLATFORM_GATEWAY_R1E_REVIEW_REQUEST "For r1c"): advisory, never on the decision path ---------------

class _Evidence:
    """Stands in for r1e's hive.mindgateway: records what the call path reports."""

    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def call_refused(self, call_id, kind):
        self.calls.append(("call_refused", call_id, kind))
        if self.fail:
            raise RuntimeError("commons down")

    def call_reported(self, reservation_id, model, reported):
        self.calls.append(("call_reported", reservation_id, model, reported))
        if self.fail:
            raise RuntimeError("commons down")


@pytest.fixture()
def ev(gw, monkeypatch):
    """Stands in for r1e's commons; check_budget is wrapped so the evidence ids it is given are recorded."""
    hive = gw["hive"]
    e = _Evidence()
    e.evidence_ids = []
    real = hive.check_budget

    def check_budget(*a, evidence_id=None, **k):
        e.evidence_ids.append(evidence_id)
        return real(*a, **k)
    monkeypatch.setattr(hive, "mindgateway", e, raising=False)
    monkeypatch.setattr(hive, "check_budget", check_budget)
    return e


def test_r1e_hooks_a_settled_call_reports_true_with_its_reservation_and_evidence_id(gw, ev):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev1-0001")
    assert call(client, token, turn).status_code == 200
    rid = hive.db.one("SELECT id FROM cost_reservations")["id"]
    assert ev.calls == [("call_reported", rid, "fakepaid/x", True)]
    assert ev.evidence_ids == [rid]          # the call's request id is its reservation id and its evidence id


def test_r1e_hooks_an_unknown_call_reports_false(gw, ev):
    client, hive = gw["client"], gw["hive"]
    gw["fake"].usage = False
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev2-0001")
    assert call(client, token, turn).headers["x-hive-call-cost-state"] == "unknown"
    rid = hive.db.one("SELECT id FROM cost_reservations")["id"]
    assert ev.calls == [("call_reported", rid, "fakepaid/x", False)]


def test_r1e_hooks_the_51st_call_is_left_to_the_close(gw, ev):
    """The 51st call closes the turn call_cap, and the close records that refusal (r1e's turn_closed); the call path does
    not record it a second time (r1e's open "one owner per refusal kind")."""
    client = gw["client"]
    gw["fake"].cost = 0.0
    hive = gw["hive"]
    hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (gw["mine"]["id"],))
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev3-0001")
    for _ in range(50):
        assert call(client, token, turn).status_code == 200
    assert code(call(client, token, turn)) == "call_cap"
    assert not [c for c in ev.calls if c[0] == "call_refused"]
    assert not [c for c in ev.calls if c[0] == "call_reported"]   # free calls take no reservation: nothing to report


def test_r1e_hooks_a_failing_commons_never_touches_the_call(gw, ev):
    client, hive = gw["client"], gw["hive"]
    ev.fail = True
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev4-0001")
    r = call(client, token, turn)
    assert r.status_code == 200 and r.headers["x-hive-call-cost-state"] == "settled" and states(hive) == ["settled"]


# ---- r1de.2: the gateway's calls in the real mindgateway commons (r1e merged; no stand-in) ----------------------------

def _evidence_rows(hive):
    from hive.tests.test_mind_gateway_r1e import rows
    return [(r["source"].split(":")[0], r["statement"], r["f"]) for r in rows(hive)]


@pytest.fixture()
def commons(gw):
    from hive.tests.test_mind_gateway_r1e import clear_commons, rebuild
    rebuild(gw["hive"])                                         # the flag is set after the shared client built the hive
    clear_commons(gw["hive"])
    from hive.core import mindgateway_evidence
    return mindgateway_evidence


def test_r1de2_a_gateway_call_records_its_usage_and_its_turn_with_no_ids(gw, commons):
    client, hive = gw["client"], gw["hive"]
    catalog, model = hive.model_catalog(), "fakepaid/x"           # the fixture's paid model (uncatalogued: other-model)
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev6-0001")
    assert call(client, token, turn).status_code == 200
    rid = hive.db.one("SELECT id FROM cost_reservations")["id"]
    assert _evidence_rows(hive) == [("usage", commons.usage_statement(model, catalog), 1.0)]
    assert hive.db.one("SELECT source FROM mindgateway_evidence")["source"] == commons.hashed("usage", rid)
    gw["fake"].usage = False                                   # the next call is held unknown: f = 0, its own source
    assert call(client, token, turn).headers["x-hive-call-cost-state"] == "unknown"
    assert [f for k, _, f in _evidence_rows(hive) if k == "usage"] == [1.0, 0.0]
    assert client.post("/api/ask/op-ev6-0001/done", headers={**gw["ann"], **ORIGIN},
                       json={"outcome": "answered"}).status_code == 200
    assert _evidence_rows(hive)[2:] == [("within", commons.within_cap_statement(model, catalog), 1.0),
                                        ("complete", commons.complete_statement(model, catalog), 1.0)]
    t = hive.db.one("SELECT * FROM ask_turns WHERE id = ?", (turn,))
    text = json.dumps([dict(r) for r in hive.db.all("SELECT * FROM mindgateway_evidence")]) \
        + json.dumps(hive.spaces.beliefs("mindgateway"))
    for ident in (rid, turn, t["thread_id"], t["operation_id"], gw["mine"]["id"], "u_ann", token):
        assert ident not in text, ident


def test_r1de2_the_51st_call_is_one_call_cap_observation(gw, commons):
    client, hive = gw["client"], gw["hive"]
    gw["fake"].cost = 0.0
    hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (gw["mine"]["id"],))
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev7-0001")
    for _ in range(50):
        assert call(client, token, turn).status_code == 200
    assert code(call(client, token, turn)) == "call_cap"
    refused = [r for r in _evidence_rows(hive) if r[1] == commons.refused_statement("call_cap")]
    assert refused == [("cap", commons.refused_statement("call_cap"), 1.0)]
    assert hive.spaces.belief("mindgateway", commons.refused_statement("call_cap"))["tv"]["c"] == pytest.approx(0.5)


def test_r1de2_a_refusal_at_the_reservation_records_its_limit_kind_once(gw, commons, monkeypatch):
    """The per-turn guard refuses at the reservation, after check_budget passed: the call path records it by kind."""
    client, hive = gw["client"], gw["hive"]
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "0.0000001")
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev8-0001")
    r = call(client, token, turn)
    assert (r.status_code, code(r)) == (402, "spend_limit") and r.json()["error"]["limit"]["kind"] == "per_turn"
    got = _evidence_rows(hive)
    assert [x for x in got if x[0] == "refused"] == [("refused", commons.refused_statement("per_turn"), 1.0)]
    assert ("cap", commons.refused_statement("spend_cap"), 1.0) in got          # and the close's own cap hit


def test_r1de2_a_check_budget_refusal_is_recorded_once_with_the_call_id(gw, commons, monkeypatch):
    """check_budget records its own refusal under the gateway's call id; _refuse_spend does not record it again."""
    client, hive = gw["client"], gw["hive"]
    given = []
    real = hive.check_budget

    def check_budget(*a, **k):
        given.append(k.get("evidence_id"))
        return real(*a, **k)
    monkeypatch.setattr(hive, "check_budget", check_budget)
    token = mint(client, gw["jon"])                                # Jon: an admin with no month rule (T-GW4 above)
    hive.db.execute("UPDATE agents SET model = 'fakepaid/x' WHERE personal_of = 'user:u_jon'")
    r = call(client, token, open_turn(client, gw["jon"], "op-ev9-0001"))
    assert (r.status_code, code(r)) == (402, "spend_limit")
    refused = hive.db.all("SELECT source, statement FROM mindgateway_evidence WHERE source LIKE 'refused:%'")
    assert [x["statement"] for x in refused] == [commons.refused_statement("monthly_total_required")]
    assert len(given) == 1 and given[0] and refused[0]["source"] == commons.hashed("refused", given[0])


@pytest.mark.parametrize("closer", ["call_cap", "spend_limit"])
def test_r1de4_a_done_that_loses_to_the_hosts_close_is_not_recorded_again(gw, commons, monkeypatch, closer):
    """Kimi r1de.2 P3 #2: the host closed the turn first (the 51st call, or a spend refusal); the browser's /done that
    follows loses, and the turn is recorded once, by the winner."""
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-ev10-0001")
    if closer == "call_cap":
        gw["fake"].cost = 0.0
        hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (gw["mine"]["id"],))
        for _ in range(50):
            assert call(client, token, turn).status_code == 200
        assert code(call(client, token, turn)) == "call_cap"
        outcome = "call_cap"
    else:
        monkeypatch.setenv("HIVE_ASK_CONDUCTOR_TURN_USD", "0.0000001")
        assert code(call(client, token, turn)) == "spend_limit"
        outcome = "spend_cap"
    before = _evidence_rows(hive)
    closes = [(kind, f) for kind, _, f in before if kind in ("within", "complete", "cap")]
    assert sorted(closes) == [("cap", 1.0), ("complete", 0.0), ("within", 0.0)]   # the host's close, once
    assert ("cap", commons.refused_statement(outcome), 1.0) in before
    r = client.post("/api/ask/op-ev10-0001/done", headers={**gw["ann"], **ORIGIN}, json={"outcome": "answered"})
    assert r.status_code < 500
    assert hive.db.one("SELECT state FROM ask_turns WHERE id = ?", (turn,))["state"] == "refused"   # the host's close stands
    assert _evidence_rows(hive) == before


def test_settings_mind_gateway_mirrors_the_flag(monkeypatch):
    from hive.core.config import load_settings
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    assert load_settings().mind_gateway is False
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    assert load_settings().mind_gateway is True
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "on")
    assert load_settings().mind_gateway is False
