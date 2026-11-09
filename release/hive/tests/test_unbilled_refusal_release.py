"""A refusal guaranteed unbilled by provider and status (OpenRouter 401/402/403, no usage or cost in its body) releases
its hold instead of leaving it unknown for 24 hours and then settling it at the worst case. A refusal whose body reports
a charge settles at that charge; any other usage or cost evidence, every other status (429, 400, 422, 408, 5xx) and every
other provider, timeouts and dropped connections stay unknown (Codex FIX-FIRST on 7aa4f1e6).

Synthetic minds, a scripted model or a loopback HTTP provider on 127.0.0.1: no network and no provider calls.
"""
import asyncio
import http.server
import threading

import httpx
import pytest

from hive.core.config import Provider
from hive.core.cost_reservations import Reservations, outstanding
from hive.core.gateway import GatewayError, refusal_charge, unbilled, upstream_refusal
from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1c import gw, mint, open_turn, call, code, states  # noqa: F401  (fixture)

MODEL = "anthropic/claude-opus-5-5"
BODY = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 700}   # ~$0.0527 held per call


def _refusal(status, body=b'{"error":{"code":402,"message":"Insufficient credits"}}', provider="openrouter"):
    return upstream_refusal(provider, httpx.Response(status, content=body))


@pytest.mark.parametrize("status", [401, 402, 403])
def test_an_allowlisted_openrouter_refusal_without_usage_is_unbilled(status):
    err = _refusal(status)
    assert unbilled(err) is True and refusal_charge(err) is None


@pytest.mark.parametrize("body", [b'{"error":{"message":"x"},"usage":{"prompt_tokens":"?"}}',
                                  b'{"error":{"message":"x","metadata":{"cost":0}}}',
                                  b'{"usage":{"cost":0.0}}', b'not json, but usage: 12 tokens',
                                  b'{"error":{"message":"x","usage":null}}'])
def test_a_402_carrying_usage_or_cost_is_never_unbilled(body):
    assert unbilled(_refusal(402, body)) is False


ENCODED = [
    rb'{"error":{"metadata":{"raw":"{\"usage\":{\"cost\":0.04}}"}}}',              # JSON inside a string value
    rb'{"error":{"\u0075sage":{"\u0063ost":0.04}}}',                              # unicode-escaped keys
    rb'{"error":{"metadata":{"raw":"{\"\\u0075sage\":1}"}}}',                      # escaped key inside nested JSON
    rb'{"error":{"metadata":{"raw":"[\"{\\\"c\\u006fst\\\":1}\"]"}}}',             # JSON in a string in a string
    rb'{"error":{"message":"Your request COST was 0.04"}}',                       # a value, any case
    rb'plain text with \u0075sage escaped',                                        # not JSON at all
]


@pytest.mark.parametrize("body", ENCODED)
def test_charge_evidence_anywhere_in_the_body_blocks_release(body):
    err = _refusal(402, body)
    assert unbilled(err) is False
    assert refusal_charge(err) is None                    # nothing structured at top level to price: held unknown


@pytest.mark.parametrize("body", ENCODED[:2])
def test_a_402_with_nested_or_escaped_charge_evidence_stays_unknown_on_the_route(client, body):
    a = _mind(client, 0.10)
    _failing_chat(client.app.state.gateway, _refusal(402, body))
    _post(client, a)
    assert [r["state"] for r in client.app.state.hive.db.all("SELECT state FROM cost_reservations")] == ["unknown"]


CANONICAL_402 = '{"error":{"code":402,"message":"Insufficient credits. Add more at openrouter.ai/settings/credits"}}'


@pytest.mark.parametrize("body", [
    CANONICAL_402.encode("utf-16"), CANONICAL_402.encode("utf-16-le"), CANONICAL_402.encode("utf-16-be"),
    CANONICAL_402.encode("utf-32"), CANONICAL_402.encode("utf-32-le"),
    b"\xef\xbb\xbf" + CANONICAL_402.encode(),                                       # UTF-8 with a BOM
    b'{"usage":{"cost":0.04}}'.decode().encode("utf-16"),                            # Codex's case
    b"",                                                                              # empty
    b"Insufficient credits",                                                          # not JSON
    b'{"error":{"code":402,"message":"x"},"id":"gen-1"}',                             # extra top-level key
    b'{"error":{"code":402,"message":"x","type":"billing"}}',                         # extra error key
    b'{"error":{"code":402,"message":"x","metadata":{"raw":{"a":1}}}}',               # nested metadata object
    b'{"error":{"code":402,"message":"x","metadata":{"a":[1]}}}',                     # metadata list value
    b'{"error":{"code":402,"message":"x","metadata":{"a":1.5}}}',                     # metadata float value
    b'{"error":{"code":402,"message":"x","metadata":{"a":true}}}',                    # metadata bool value
    b'{"error":{"code":402,"message":"x","metadata":{"raw":"{\\\"\\\\u0075sage\\\":1}"}}}',  # escaped JSON in a value
    b'{"error":{"code":"402","message":"x"}}',                                        # code not an int
    b'{"error":{"code":true,"message":"x"}}',                                         # code a bool
    b'{"error":{"code":500,"message":"x"}}',                                          # code not a refusal code
    b'{"error":{"message":"x"}}',                                                     # no code
    b'{"error":{"code":402,"message":7}}',                                            # message not a string
    b'{"error":{"code":402,"message":"x","metadata":{"provider_cost":"0"}}}',         # cost in a metadata key
    b'{"error":{"code":402,"message":"\\u0055SAGE limit"}}',                        # escaped usage in the message
    b'[{"error":{"code":402,"message":"x"}}]',                                        # not an object
    ('{"error":{"code":402,"message":"' + "x" * 4100 + '"}}').encode(),               # over 4 KB
    b'{"error":{"code":402,"message":"\xff"}}',                                      # not strict UTF-8
])
def test_only_the_canonical_openrouter_shape_is_unbilled(body):
    assert unbilled(_refusal(402, body)) is False


@pytest.mark.parametrize("body", [
    CANONICAL_402.encode(),
    b'{"error":{"code":402,"message":"Insufficient credits","metadata":{"provider_name":"OpenRouter","limit":0}}}',
    b'{"error":{"code":401,"message":"No auth credentials found"}}',
])
def test_the_canonical_openrouter_402_is_unbilled(body):
    assert unbilled(_refusal(402, body)) is True


def test_a_utf16_body_with_a_top_level_cost_is_settled_at_it(client):
    a = _mind(client, 0.10)
    _failing_chat(client.app.state.gateway, _refusal(402, b'{"usage":{"cost":0.04}}'.decode().encode("utf-16")))
    _post(client, a)
    row = client.app.state.hive.db.one("SELECT state, actual FROM cost_reservations")
    assert (row["state"], row["actual"]) == ("settled", 40_000)


@pytest.mark.parametrize("body,expected", [(CANONICAL_402.encode(), "released"),
                                           (CANONICAL_402.encode("utf-16"), "unknown"),
                                           (b"", "unknown"),
                                           (b'{"error":{"code":402,"message":"x","metadata":{"raw":{"a":1}}}}', "unknown")])
def test_on_the_route_only_the_canonical_402_releases(client, body, expected):
    a = _mind(client, 0.10)
    _failing_chat(client.app.state.gateway, _refusal(402, body))
    _post(client, a)
    assert [r["state"] for r in client.app.state.hive.db.all("SELECT state FROM cost_reservations")] == [expected]


def test_a_plain_402_with_braces_and_no_charge_words_is_still_unbilled():
    assert unbilled(_refusal(402, b'{"error":{"code":402,"message":"Insufficient credits {add more}","metadata":{}}}'))


def test_a_refusal_reporting_a_cost_carries_that_charge():
    err = _refusal(429, b'{"error":{"message":"rate limited"},"usage":{"cost":0.04}}')
    assert unbilled(err) is False and refusal_charge(err) == 0.04


@pytest.mark.parametrize("exc", [_refusal(400), _refusal(404), _refusal(422), _refusal(429), _refusal(413),
                                 _refusal(402, provider="anthropic"), _refusal(401, provider="openai"),
                                 _refusal(408), _refusal(499), _refusal(500), _refusal(502), _refusal(503),
                                 httpx.ReadTimeout("t"), httpx.RemoteProtocolError("drop"), asyncio.TimeoutError(),
                                 GatewayError(402, "own_key_needed", "x"), GatewayError(502, "upstream_usage_invalid", "x"),
                                 RuntimeError("x")])
def test_ambiguous_outcomes_are_not_unbilled(exc):
    assert unbilled(exc) is False


def _mind(client, budget):
    _, (a,) = make_swarm_and_agents(client, n=1, model=MODEL, budget_usd=budget)
    return a


def _failing_chat(gateway, exc):
    async def chat(agent, body):
        raise exc
    gateway.chat = chat


def _ok_chat(gateway):
    async def chat(agent, body):
        out = int(body.get("max_tokens") or 0)
        return ({"id": "r1", "model": MODEL, "usage": {"prompt_tokens": 10, "completion_tokens": out}},
                {"prompt_tokens": 10, "completion_tokens": out, "cost_usd": (10 * 15 + out * 75) / 1_000_000})
    gateway.chat = chat


def _post(client, a):
    try:
        return client.post("/llm/v1/chat/completions", json=BODY, headers=agent_headers(a)).status_code
    except Exception as exc:   # noqa: BLE001  (TestClient re-raises the route's own exception)
        return exc


def test_a_402_releases_its_hold_and_the_next_call_is_admitted(client):
    a = _mind(client, 0.10)                     # room for one held call, not two
    gw_ = client.app.state.gateway
    _failing_chat(gw_, _refusal(402))
    _post(client, a)
    hive = client.app.state.hive
    rows = hive.db.all("SELECT id, state FROM cost_reservations")
    assert [r["state"] for r in rows] == ["released"]
    res = hive.db.one("SELECT * FROM cost_reservation_resolutions WHERE reservation = ?", (rows[0]["id"],))
    assert res["action"] == "release" and res["decided_by"] == "hive:provider-refusal" and "402" in res["reason"]
    assert client.get("/api/budgets/reservations").json() == []
    assert hive.agent(a["id"])["spent_usd"] == 0
    _failing_chat(gw_, _refusal(402))           # a run of refusals never accumulates holds
    _post(client, a)
    _post(client, a)
    _ok_chat(gw_)
    assert _post(client, a) == 200


@pytest.mark.parametrize("exc", [httpx.ReadTimeout("t"), _refusal(503), _refusal(408), _refusal(429), _refusal(400),
                                 _refusal(422), _refusal(402, b'{"error":{"message":"x"},"usage":{"prompt_tokens":"?"}}')])
def test_a_timeout_5xx_other_4xx_or_unpriceable_usage_stays_unknown(client, exc):
    a = _mind(client, 0.10)
    gw_ = client.app.state.gateway
    _failing_chat(gw_, exc)
    _post(client, a)
    held = client.get("/api/budgets/reservations").json()
    assert len(held) == 1 and held[0]["state"] == "unknown"
    _ok_chat(gw_)
    assert _post(client, a) == 402              # still held: the cap cannot be overrun


@pytest.mark.parametrize("status", [429, 402])
def test_a_refusal_reporting_a_cost_is_settled_at_it_and_never_released(client, status):
    a = _mind(client, 0.10)
    gw_ = client.app.state.gateway
    _failing_chat(gw_, _refusal(status, b'{"error":{"message":"x"},"usage":{"cost":0.06}}'))
    _post(client, a)
    hive = client.app.state.hive
    row = hive.db.one("SELECT state, actual FROM cost_reservations")
    assert (row["state"], row["actual"]) == ("settled", 60_000)       # the charge is recorded, not discarded
    assert abs(hive.agent(a["id"])["spent_usd"] - 0.06) < 1e-9
    assert hive.db.one("SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage WHERE agent_id = ?", (a["id"],))["c"] == 0.06
    assert client.get("/api/budgets/reservations").json() == []
    _ok_chat(gw_)
    assert _post(client, a) == 402              # $0.06 spent + a ~$0.0527 hold exceeds the $0.10 cap


def test_release_unbilled_is_idempotent_and_never_touches_an_unknown_or_settled_row(client):
    hive = client.app.state.hive
    a = _mind(client, 1.0)
    res = Reservations(hive.db)
    snap = lambda: [("agent:" + a["id"] + ":total", 1.0, 0.0)]   # noqa: E731
    meta = {"agent": a["id"], "model": MODEL}
    res.reserve("r-sent", {"p": 1}, 0.05, snap, metadata=meta, dispatched=True)
    assert res.release_unbilled("r-sent", 402) is True
    assert res.release_unbilled("r-sent", 402) is False         # replay: no second change, one resolution row
    assert res.get("r-sent")["state"] == "released"
    assert hive.db.one("SELECT COUNT(*) AS n FROM cost_reservation_resolutions WHERE reservation='r-sent'")["n"] == 1
    again = res.reserve("r-sent", {"p": 1}, 0.05, snap, metadata=meta, dispatched=True)   # same identity: no new hold
    assert again["new"] is False and again["state"] == "released"
    # a charge that arrives anyway is recorded and flagged, never dropped
    recorded = []
    assert res.settle("r-sent", 0.01, lambda: recorded.append(1)) is True
    assert recorded == [1] and res.get("r-sent")["state"] == "settled"
    assert hive.db.one("SELECT source FROM cost_overruns WHERE reservation='r-sent'")["source"] == "late-after-release"
    # an unknown row is a person's to resolve; a settled one keeps its outcome
    res.reserve("r-unknown", {"p": 2}, 0.05, snap, metadata=meta, dispatched=True)
    res.unknown("r-unknown")
    assert res.release_unbilled("r-unknown", 402) is False and res.get("r-unknown")["state"] == "unknown"
    assert res.release_unbilled("r-sent", 402) is False and res.get("r-sent")["state"] == "settled"
    assert res.release_unbilled("missing", 402) is False
    assert [r["id"] for r in outstanding(res)] == ["r-unknown"]


def test_an_unknown_row_from_an_earlier_402_is_released_through_the_resolve_route(client):
    """Existing stuck rows (no status was recorded with them): a person releases each with a reason."""
    a = _mind(client, 0.10)
    gw_ = client.app.state.gateway
    _failing_chat(gw_, RuntimeError("as before this fix"))
    _post(client, a)
    held = client.get("/api/budgets/reservations").json()
    assert held[0]["state"] == "unknown"
    r = client.post(f"/api/budgets/reservations/{held[0]['id']}/resolve",
                    json={"action": "release", "reason": "OpenRouter answered 402 (billing); nothing was billed"})
    assert r.status_code == 200 and r.json()["state"] == "released"
    _ok_chat(gw_)
    assert _post(client, a) == 200


class _RefusingProvider:
    """A loopback provider that answers every call with the given status."""

    def __init__(self, status, body):
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):   # noqa: N802
                self.rfile.read(int(self.headers.get("content-length") or 0))
                self.send_response(status)
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


@pytest.mark.parametrize("status,body,expected", [
    (402, b'{"error": {"code": 402, "message": "Insufficient credits"}}', ["released"]),
    (500, b'{"error": {"message": "x"}}', ["unknown"]),
    (429, b'{"error": {"message": "x"}}', ["unknown"]),
    (402, b'{"error": {"message": "x"}, "usage": {"total_tokens": 3}}', ["unknown"]),
    (429, b'{"error": {"message": "x"}, "usage": {"prompt_tokens": 1000, "completion_tokens": 0}}', ["settled"]),
])
def test_the_personal_mind_gateway_through_the_real_transport(gw, monkeypatch, status, body, expected):  # noqa: F811
    """This route's provider is named fakepaid; it is given OpenRouter's allowlist entry here (the allowlist is keyed by
    provider), so the loopback stands in for OpenRouter."""
    from hive.core import gateway as gateway_mod
    monkeypatch.setitem(gateway_mod.UNBILLED_REFUSALS, "fakepaid", gateway_mod.UNBILLED_REFUSALS["openrouter"])
    client, hive = gw["client"], gw["hive"]
    srv = _RefusingProvider(status, body)
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        del client.app.state.gateway.chat   # the real gateway and transport
        token = mint(client, gw["ann"])
        turn = open_turn(client, gw["ann"], f"op-unbilled-{status}")
        r = call(client, token, turn)
        assert (r.status_code, code(r)) == (502, "upstream_error")
        assert states(hive) == expected
        assert ("held_usd" in (r.json()["error"] or {})) == (expected == ["unknown"])
        if expected == ["settled"]:   # 1000 prompt tokens at $1 per million, recorded for the mind
            assert hive.db.one("SELECT actual FROM cost_reservations")["actual"] == 1000
    finally:
        srv.close()
