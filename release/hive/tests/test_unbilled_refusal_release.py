# Purpose: tests that an error answer its provider documents as unbilled releases its hold, that one reporting a charge
# settles at it, and that everything else (another provider, a body not in the provider's own shape, a timeout, a dropped
# connection) stays unknown, through the gateway's classification, the chat route and the real transport.
"""An error answer its provider documents as never charged (Anthropic: failed requests aren't charged; OpenRouter: its
own refusals before any model runs, 400, 401, 402, 403 and 503) releases its hold instead of leaving it unknown for
an hour and then settling it at the worst case, when its body is exactly the provider's own error shape with no usage or
cost in it. A refusal whose body reports a charge settles at that charge; any other usage or cost evidence, every other
provider (OpenAI documents no such rule), an OpenRouter call that asked for web search or file parsing, timeouts and
dropped connections stay unknown (Codex FIX-FIRST on 7aa4f1e6 kept the body rules).

Synthetic minds, a scripted model or a loopback HTTP provider on 127.0.0.1: no network and no provider calls.
"""
import asyncio
import http.server
import threading

import httpx
import pytest

from hive.core.config import Provider
from hive.core.cost_reservations import Reservations, outstanding
from hive.core.gateway import GatewayError, canonical_refusal_body, paid_extras, refusal_charge, unbilled, upstream_refusal
from hive.tests.test_core_api import client, make_swarm_and_agents, agent_headers  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1c import gw, mint, open_turn, call, code, states  # noqa: F401  (fixture)

MODEL = "anthropic/claude-opus-5-5"
BODY = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 700}   # ~$0.0527 held per call


def _refusal(status, body=b'{"error":{"code":402,"message":"Insufficient credits"}}', provider="openrouter"):
    return upstream_refusal(provider, httpx.Response(status, content=body))


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504, 529])
@pytest.mark.parametrize("provider,body", [
    ("anthropic", '{{"error":{{"message":"refused","type":"api_error","param":null,"code":null}}}}'),
    ("anthropic", '{{"type":"error","error":{{"type":"rate_limit_error","message":"refused"}},"request_id":"req_011"}}'),
])
def test_every_documented_error_answer_without_usage_is_unbilled(status, provider, body):
    err = _refusal(status, body.format(status=status).encode(), provider)
    assert unbilled(err) is True and refusal_charge(err) is None


# OpenRouter (openrouter.ai/docs/api-reference/errors): 401 credentials, 402 credits and 403 forbidden are its own
# refusals, as before; 400 bad request and 503 "no available model provider" are released while the body names no
# provider; a 408, 429, 502 or any other status can follow a call a provider already started, so it stays held.
@pytest.mark.parametrize("status,released", [(400, True), (401, True), (402, True), (403, True), (503, True),
                                             (404, False), (408, False), (413, False), (422, False), (429, False),
                                             (500, False), (502, False), (504, False), (529, False)])
def test_openrouter_releases_only_its_own_refusals_before_any_model_runs(status, released):
    err = _refusal(status, b'{"error":{"code":%d,"message":"refused"}}' % status)
    assert unbilled(err) is released and refusal_charge(err) is None


@pytest.mark.parametrize("status", [400, 503])
@pytest.mark.parametrize("metadata,released", [
    ('{"provider_name":"OpenRouter"}', True), ('{"limit_source":"router"}', True),
    ('{"provider_name":"Upstream"}', False), ('{"error_type":"invalid_request"}', False),
    ('{"provider_code":"invalid_request_error"}', False), ('{"raw":"upstream said no"}', False),
])
def test_an_openrouter_400_or_503_is_released_only_while_its_body_names_no_provider(status, metadata, released):
    err = _refusal(status, b'{"error":{"code":%d,"message":"refused","metadata":%s}}' % (status, metadata.encode()))
    assert unbilled(err) is released


@pytest.mark.parametrize("status", [401, 402, 403])
def test_openrouter_401_402_and_403_stay_released_with_a_provider_named_as_before(status):
    body = b'{"error":{"code":%d,"message":"refused","metadata":{"provider_name":"Upstream"}}}' % status
    assert unbilled(_refusal(status, body)) is True


# OpenRouter: "The HTTP Response will have the same status code as error.code"; its 401, 402 and 403 refusals were
# already released with any of those three codes, and still are.
@pytest.mark.parametrize("status,code,released", [(408, 402, False), (500, 502, False), (429, 400, False),
                                                  (402, 429, False), (401, 402, True), (403, 401, True)])
def test_an_openrouter_error_code_must_be_its_status(status, code, released):
    err = _refusal(status, b'{"error":{"code":%d,"message":"refused"}}' % code)
    assert unbilled(err) is released


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


@pytest.mark.parametrize("exc", [_refusal(401, provider="openai"), _refusal(429, provider="openai"),
                                 _refusal(503, b"<html>502 Bad Gateway</html>"), _refusal(503, b"<html>bad</html>", "anthropic"),
                                 _refusal(429, b'{"error":{"message":"x","type":"t","usage":{"input_tokens":9}}}', "anthropic"),
                                 _refusal(400, b'{"error":{"message":"x","param":{"a":1}}}', "anthropic"),
                                 _refusal(400, b'{"error":{"message":"x","code":true}}', "anthropic"),
                                 _refusal(400, b'{"error":{"message":"x"},"id":"msg_1","model":"m"}', "anthropic"),
                                 _refusal(400, b'{"error":{"message":"x"},"type":7}', "anthropic"),
                                 _refusal(400, b'{"error":{"message":"Your cost limit was reached"}}', "anthropic"),
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


def _someone_writes(client, a):
    """Someone writes to the mind after its call was refused: the refusal kept on it (Hive.model_refusal_release) no
    longer answers its next call, so the money rules are what answer it."""
    assert client.post(f"/api/agents/{a['id']}/messages", json={"text": "go on"}).status_code == 200


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
    _someone_writes(client, a)
    _post(client, a)
    _someone_writes(client, a)
    _post(client, a)
    _ok_chat(gw_)
    _someone_writes(client, a)
    assert _post(client, a) == 200


@pytest.mark.parametrize("exc", [httpx.ReadTimeout("t"), httpx.RemoteProtocolError("drop"), _refusal(429, provider="openai"),
                                 _refusal(503, b"<html>502 Bad Gateway</html>"),
                                 _refusal(402, b'{"error":{"message":"x"},"usage":{"prompt_tokens":"?"}}')])
def test_a_timeout_an_undocumented_provider_or_unpriceable_usage_stays_unknown(client, exc):
    a = _mind(client, 0.10)
    gw_ = client.app.state.gateway
    _failing_chat(gw_, exc)
    _post(client, a)
    held = client.get("/api/budgets/reservations").json()
    assert len(held) == 1 and held[0]["state"] == "unknown"
    _ok_chat(gw_)
    _someone_writes(client, a)
    assert _post(client, a) == 402              # still held: the cap cannot be overrun


@pytest.mark.parametrize("status,message", [(408, "Request timed out"), (429, "Rate limit exceeded"),
                                            (502, "Provider returned error")])
def test_an_openrouter_408_429_or_502_stays_held_on_the_route(client, status, message):
    a = _mind(client, 0.10)
    _failing_chat(client.app.state.gateway, _refusal(status, b'{"error":{"code":%d,"message":"%s"}}' % (status, message.encode())))
    _post(client, a)
    assert [r["state"] for r in client.get("/api/budgets/reservations").json()] == ["unknown"]


@pytest.mark.parametrize("exc", [_refusal(503, b'{"error":{"code":503,"message":"No available provider"}}'),
                                 _refusal(402, b'{"error":{"code":402,"message":"Insufficient credits"}}'),
                                 _refusal(400, b'{"error":{"code":400,"message":"bad"}}'),
                                 _refusal(529, b'{"error":{"message":"Overloaded","type":"overloaded_error"}}', "anthropic"),
                                 _refusal(402, b'{"error":{"message":"Your credit balance is too low","type":"billing_error"}}', "anthropic")])
def test_a_documented_error_answer_releases_its_hold_with_its_status(client, exc):
    a = _mind(client, 0.10)
    _failing_chat(client.app.state.gateway, exc)
    _post(client, a)
    hive = client.app.state.hive
    row = hive.db.one("SELECT id, state FROM cost_reservations")
    res = hive.db.one("SELECT * FROM cost_reservation_resolutions WHERE reservation = ?", (row["id"],))
    assert row["state"] == "released" and res["decided_by"] == "hive:provider-refusal" and str(exc.status) in res["reason"]
    assert client.get("/api/budgets/reservations").json() == []


@pytest.mark.parametrize("body,extra", [
    ({"plugins": [{"id": "web"}]}, True), ({"web_search_options": {}}, True), ({"model": "openai/gpt-x:online"}, True),
    ({"messages": [{"role": "user", "content": [{"type": "file", "file": {"filename": "a.pdf"}}]}]}, True),
    ({"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}, False), ({"plugins": []}, False), ({}, False),
])
def test_paid_extras_are_the_services_openrouter_may_bill_after_an_error(body, extra):
    assert paid_extras(body) is extra


@pytest.mark.parametrize("model,extra,unbilled_after", [("vendor/model", {}, True),
                                                        ("vendor/model", {"plugins": [{"id": "web"}]}, False),
                                                        ("vendor/model:online", {}, False)])
def test_the_gateway_keeps_an_openrouter_error_billed_when_paid_extras_were_asked_for(model, extra, unbilled_after):
    from hive.core.gateway import Gateway
    sent = []

    def provider(request):
        sent.append(request)
        return httpx.Response(503, content=b'{"error":{"code":503,"message":"Provider returned error"}}')
    gateway = Gateway({"openrouter": Provider("openrouter", "https://openrouter.test/api/v1", prices={"*": {"in": 1, "out": 1}})})
    gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(provider))
    agent = {"id": "a_00000001", "name": "Vega", "model": "openrouter/" + model}
    with pytest.raises(GatewayError) as caught:
        asyncio.run(gateway.chat(agent, dict(BODY, **extra)))
    assert len(sent) == 1 and caught.value.status == 503 and unbilled(caught.value) is unbilled_after


def test_a_shape_check_never_passes_another_providers_body():
    openrouter = b'{"error":{"code":402,"message":"Insufficient credits"}}'
    assert canonical_refusal_body(openrouter, 402, "openrouter") is True
    assert canonical_refusal_body(openrouter, 402, "openai") is False
    assert canonical_refusal_body(b'{"error":{"message":"x","type":"t"}}', 400, "openrouter") is False


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
    _someone_writes(client, a)
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
    # an unknown row settles by itself at the expiry (expire_unknown); a settled one keeps its outcome
    res.reserve("r-unknown", {"p": 2}, 0.05, snap, metadata=meta, dispatched=True)
    res.unknown("r-unknown")
    assert res.release_unbilled("r-unknown", 402) is False and res.get("r-unknown")["state"] == "unknown"
    assert res.release_unbilled("r-sent", 402) is False and res.get("r-sent")["state"] == "settled"
    assert res.release_unbilled("missing", 402) is False
    assert [r["id"] for r in outstanding(res)] == ["r-unknown"]


def test_an_unknown_row_from_an_earlier_402_settles_by_itself_and_corrects_to_nothing_billed(client):
    """Existing stuck rows (no status was recorded with them): each settles at its worst case an hour on, and a person
    who reads the provider's billing corrects it to nothing billed."""
    a = _mind(client, 0.10)
    gw_ = client.app.state.gateway
    _failing_chat(gw_, RuntimeError("as before this fix"))
    _post(client, a)
    held = client.get("/api/budgets/reservations").json()
    assert held[0]["state"] == "unknown"
    client.app.state.hive.db.execute("UPDATE cost_reservations SET unknown_at = unknown_at - 3601 WHERE state = 'unknown'")
    client.portal.call(client.app.state.reconcile_once)
    r = client.post(f"/api/budgets/reservations/{held[0]['id']}/correct",
                    json={"action": "release", "reason": "OpenRouter answered 402 (billing); nothing was billed"})
    assert r.status_code == 200 and r.json()["actual"] == 0
    _ok_chat(gw_)
    _someone_writes(client, a)
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
    """This route's provider is named fakepaid; it is given OpenRouter's statuses and error shape here (both are keyed by
    provider), so the loopback stands in for OpenRouter."""
    from hive.core import gateway as gateway_mod
    monkeypatch.setitem(gateway_mod.UNBILLED_REFUSALS, "fakepaid", gateway_mod.UNBILLED_REFUSALS["openrouter"])
    monkeypatch.setitem(gateway_mod._ERROR_SHAPES, "fakepaid", gateway_mod._ERROR_SHAPES["openrouter"])
    client, hive = gw["client"], gw["hive"]
    srv = _RefusingProvider(status, body)
    try:
        hive.settings.providers["fakepaid"] = Provider("fakepaid", srv.url, prices={"*": {"in": 1, "out": 1}})
        del client.app.state.gateway.chat   # the real gateway and transport
        token = mint(client, gw["ann"])
        turn = open_turn(client, gw["ann"], f"op-unbilled-{status}")
        r = call(client, token, turn)
        # the provider's refusal, said as refusals.py's row for its status in the hive's words
        assert (r.status_code, code(r)) == (status, {402: "provider_no_credit", 500: "provider_unavailable",
                                                    429: "provider_busy"}[status])
        assert states(hive) == expected
        assert ("held_usd" in (r.json()["error"] or {})) == (expected == ["unknown"])
        if expected == ["settled"]:   # 1000 prompt tokens at $1 per million, recorded for the mind
            assert hive.db.one("SELECT actual FROM cost_reservations")["actual"] == 1000
    finally:
        srv.close()
