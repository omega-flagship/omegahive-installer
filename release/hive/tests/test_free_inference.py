# Purpose: free inference (hive/core/free_inference.py) and ASI Cloud as a provider: the route exists only with the
# deploy's key and an endpoint the key may travel to, runs only the deploy's models, each person and the hive are held to
# their model calls a day, public visitors only where the deploy opts in, a call costs the hive nothing and counts only
# once it commits at the send boundary, a refusal sends nothing, and the deploy's key never shows in a view, an answer
# or a log line.
"""Synthetic only: a fake OpenAI-compatible transport, invented people and an invented key; no network."""

import asyncio
import datetime
import email.utils
import json
import logging
import pathlib
import re
import tempfile

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core import gateway as gateway_module
from hive.core.config import (FREE, FREE_DEFAULT_MODELS, FREE_DEFAULT_URL, Provider, _load_providers, caller_judged, is_free,
                              load_settings)
from hive.core.budgets import period_start
from hive.core.free_inference import SQLITE_MAX, daily_cap, hive_daily_cap, until_midnight_utc
from hive.core.refusals import KINDS
from hive.core.gateway import FREE_RETRIES, FREE_RETRY_CAP, SEND_GATE, Gateway, GatewayError, free_retry_delay
from hive.core.providers import ProviderError, ProviderStore
from hive.tests.test_core_api import PETTA, FakeSupervisor, agent_headers, make_swarm_and_agents
from hive.tests.test_visibility import person

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

ASI = "https://inference.asicloud.cudos.org/v1"
SC = FREE_DEFAULT_URL   # Singularity Compute's base, where the team's key belongs
DEPLOY_KEY = "invented-free-key-QZ7xW9mK4pL2vN8r"   # what the deploy puts in HIVE_FREE_INFERENCE_KEY
TAIL = DEPLOY_KEY[-6:]                              # a hint shows a key's end: not even that may show
ANN, BOB = "user:u_ann", "user:u_bob"
ANSWER = {"model": "invented", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello from free"}}],
          "usage": {"prompt_tokens": 21, "completion_tokens": 4}}
ENV = ("HIVE_FREE_INFERENCE_KEY", "HIVE_FREE_INFERENCE_MODELS", "HIVE_FREE_INFERENCE_DAILY_CALLS", "HIVE_PROVIDERS_FILE",
       "ASI_API_KEY", "HIVE_LOCAL_ONLY_SWARMS", "HIVE_ASK_CONDUCTOR", "HIVE_FREE_INFERENCE_URL",
       "HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS", "HIVE_FREE_INFERENCE_VISITORS", "HIVE_FREE_INFERENCE_IDLE_WINDOW_S")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)


class Upstream(httpx.AsyncBaseTransport):
    """A fake OpenAI-compatible endpoint that, like httpcore, awaits the send boundary's trace before writing anything.
    fail: raised before that boundary (a connection that never opened, a wait cancelled); after: raised past it (the
    request went, and its answer was lost); plan: (status, headers) for each request in turn, the answer's status once
    it runs out (a 429 with or without Retry-After, then an answer)."""

    def __init__(self, answer=ANSWER, status=200, fail=None, after=None, plan=()):
        self.answer, self.status, self.fail, self.after, self.sent = answer, status, fail, after, []
        self.plan = list(plan)

    async def handle_async_request(self, request):
        if self.fail is not None:
            raise self.fail
        trace = request.extensions.get("trace")
        if trace is not None:
            await trace("http11.send_request_headers.started", {})
        self.sent.append(request)
        if self.after is not None:
            raise self.after
        if self.plan:
            status, headers = self.plan.pop(0)
            if status != 200:
                return httpx.Response(status, headers=headers, json={"error": {"code": "rate_limit_exceeded", "message":
                                      "You have exceeded the rate limits. Please try again later."}})
        return httpx.Response(self.status, json=self.answer)


# ---- configuration ------------------------------------------------------------------------------------------------

def test_no_free_route_without_the_deploys_key(monkeypatch):
    assert FREE not in _load_providers()
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", "   ")
    assert FREE not in _load_providers()


def test_the_free_route_is_singularity_compute_on_the_deploys_key_and_never_local(monkeypatch):
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    free = _load_providers()[FREE]
    assert SC == "https://llm.a.singularitycompute.com/v1"
    assert (free.base_url, free.key_env, free.local, free.prices) == (SC, "HIVE_FREE_INFERENCE_KEY", False, {})
    assert free.models == list(FREE_DEFAULT_MODELS) and free.api_key == DEPLOY_KEY
    assert FREE_DEFAULT_MODELS == ("minimax/minimax-m3.1-flash",)   # MiniMax M3.1 Flash, as Singularity Compute serves it
    assert is_free(FREE) and caller_judged(FREE) and not is_free("asicloud")
    monkeypatch.setenv("HIVE_FREE_INFERENCE_MODELS", " asi1-mini , minimax/minimax-m3 ,")
    assert _load_providers()[FREE].models == ["asi1-mini", "minimax/minimax-m3"]


@pytest.mark.parametrize("url,base", [
    ("https://compute.example.org/v1/", "https://compute.example.org/v1"),   # the endpoint the deploy's key belongs to
    ("http://127.0.0.1:9911/v1", "http://127.0.0.1:9911/v1"),                # a stand-in on this machine
    ("http://compute.example.org/v1", None),                                # the key in clear text: no route at all
    ("http://localhost:9911/v1", None),                                     # a name is never counted as this machine
    ("https://someone:pw@compute.example.org/v1", None),
    ("compute.example.org/v1", None),
    ("https://compute.example.org:8443/v1", "https://compute.example.org:8443/v1"),
    ("https://compute.example.org:bad/v1", None),                           # no request could reach it
    ("https://compute.example.org:99999/v1", None),
    ("https://compute.example.org:0/v1", None),
])
def test_the_endpoint_is_the_deploys_setting_and_never_clear_text(monkeypatch, url, base):
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    monkeypatch.setenv("HIVE_FREE_INFERENCE_URL", url)
    providers = _load_providers()
    if base is None:   # never a fallback to the default endpoint: the key may belong to another
        assert FREE not in providers
    else:
        assert providers[FREE].base_url == base and providers[FREE].api_key == DEPLOY_KEY


def test_asi_cloud_takes_a_persons_own_key_with_asi1_mini_free():
    asi = _load_providers()["asicloud"]
    assert (asi.base_url, asi.key_env, asi.local) == (ASI, "ASI_API_KEY", False)
    # an explicit $0 for that model, the only way a remote model counts as free (Gateway.free_reserve)
    assert asi.models == ["asi1-mini"] and asi.prices == {"asi1-mini": {"in": 0, "out": 0}} and asi.priced("asi1-mini")
    assert not asi.priced("minimax/minimax-m3")   # another model joins only with its price


@pytest.mark.parametrize("entry,kept", [
    ({"name": FREE, "base_url": "http://127.0.0.1:9911/v1", "key_env": "HIVE_FREE_INFERENCE_KEY"}, True),
    ({"name": FREE, "base_url": "http://127.0.0.1:9911/v1", "key_env": "OTHER_KEY"}, False),
    ({"name": FREE, "base_url": "http://127.0.0.1:9911/v1", "key_env": "HIVE_FREE_INFERENCE_KEY", "local": True}, False),
    ({"name": FREE, "base_url": "http://compute.example.org/v1", "key_env": "HIVE_FREE_INFERENCE_KEY"}, False),
    ({"name": "sneaky", "base_url": "http://127.0.0.1:9911/v1", "key_env": "HIVE_FREE_INFERENCE_KEY"}, False),
])
def test_a_providers_file_may_move_the_free_route_but_never_carry_its_key_elsewhere(monkeypatch, tmp_path, entry, kept):
    path = tmp_path / "providers.json"
    path.write_text(json.dumps([dict(entry, models=["invented-model"])]))
    monkeypatch.setenv("HIVE_PROVIDERS_FILE", str(path))
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    providers = _load_providers()
    assert "sneaky" not in providers
    if kept:
        assert providers[FREE].base_url == "http://127.0.0.1:9911/v1" and providers[FREE].local is False
    else:   # refused: the route the environment made stays as it was
        assert providers[FREE].base_url == SC and providers[FREE].key_env == "HIVE_FREE_INFERENCE_KEY"


@pytest.mark.parametrize("raw,cap", [(None, None), ("7", 7), ("0", 0), ("-3", 0), ("seven", 0), ("9" * 30, SQLITE_MAX)])
def test_daily_calls(monkeypatch, raw, cap):
    for name, read, default in (("HIVE_FREE_INFERENCE_DAILY_CALLS", daily_cap, 200),
                                ("HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS", hive_daily_cap, 2000)):
        if raw is not None:
            monkeypatch.setenv(name, raw)
        assert read() == (default if cap is None else cap)


# ---- the gateway, with no hive ------------------------------------------------------------------------------------

class AdmitAll:
    def __init__(self):
        self.calls, self.released, self.refuse = [], [], None

    def admit(self, agent, principal=None, dispatch=False, idle_guard=True):
        self.calls.append((principal, dispatch))
        return ("user:u_ann", "2026-11-17T00:00:00.000Z") if dispatch else None

    def authorize(self, agent, principal=None):   # asked again at the send boundary
        self.calls.append((principal, "authorize"))
        if self.refuse is not None:
            raise self.refuse
        return principal

    def release(self, ticket):
        self.released.append(ticket)


def free_gateway(upstream):
    gate = Gateway({FREE: Provider(FREE, SC, "HIVE_FREE_INFERENCE_KEY", models=list(FREE_DEFAULT_MODELS))})
    asyncio.run(gate.client.aclose())
    gate.client = httpx.AsyncClient(transport=upstream)
    return gate


AGENT = {"id": "a_00000001", "name": "invented", "model": f"free/{FREE_DEFAULT_MODELS[0]}", "swarm_id": "s_00000001",
         "options": {"key": "k_0000beef", "key_locked": False}}   # an assigned key never pays on the free route
TICKET = ("user:u_ann", "2026-11-17T00:00:00.000Z")   # what AdmitAll counts a call as


def test_the_gateway_sends_on_the_deploys_key_only_and_records_nothing_spent(monkeypatch):
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    upstream = Upstream(answer=dict(ANSWER, usage={"prompt_tokens": 21, "completion_tokens": 4, "cost": 0.003}))
    gate = free_gateway(upstream)
    gate.free_gate = AdmitAll()
    gate.paying_key = lambda *a: pytest.fail("the free route never looks for a paying key")
    assert gate.estimate(AGENT, {"messages": []}, principal=ANN) == (False, 0.0)
    response, usage = asyncio.run(gate.chat(AGENT, {"messages": [{"role": "user", "content": "hi"}]}, principal=ANN))
    assert response["choices"][0]["message"]["content"] == "hello from free"
    assert usage["cost_usd"] == 0.0 and usage["reported_cost_usd"] is None and usage["payer_mode"] == "free"
    assert (usage["prompt_tokens"], usage["completion_tokens"], usage["key_id"]) == (21, 4, None)
    (sent,) = upstream.sent
    assert sent.headers["authorization"] == f"Bearer {DEPLOY_KEY}" and str(sent.url) == f"{SC}/chat/completions"
    assert json.loads(sent.content)["model"] == FREE_DEFAULT_MODELS[0]
    # admitted at the estimate, counted before dispatch, its authority asked again at the send boundary, each for the
    # person the caller named
    assert gate.free_gate.calls == [(ANN, False), (ANN, True), (ANN, "authorize")] and gate.free_gate.released == []


def test_no_gate_no_route_and_no_embeddings_refuse_before_any_network(monkeypatch):
    upstream = Upstream()
    gate = free_gateway(upstream)
    for attempt in (lambda: gate.estimate(AGENT, {"messages": []}), lambda: asyncio.run(gate.chat(AGENT, {"messages": []}))):
        with pytest.raises(GatewayError) as refusal:
            attempt()
        assert (refusal.value.status, refusal.value.code) == (403, "free_inference_off")
    gate.free_gate = AdmitAll()
    with pytest.raises(GatewayError) as refusal:
        asyncio.run(gate.embeddings(AGENT["model"], {"input": "x"}, agent=AGENT))
    assert refusal.value.code == "unsupported_route"
    gone = Gateway({})   # the deploy took the key away: a mind left on the route is told so
    with pytest.raises(GatewayError) as refusal:
        gone.estimate(AGENT, {"messages": []})
    assert (refusal.value.status, refusal.value.code) == (403, "free_inference_off")
    assert upstream.sent == []


class ClosingTurn:
    """authorize_agent for a mind whose turn closes once its call has started: chat's own first check passes, the send
    boundary's refuses."""

    def __init__(self):
        self.checks = 0

    def __call__(self, agent_id):
        self.checks += 1
        if self.checks > 1:
            raise GatewayError(409, "turn_closed", "this turn closed")


async def closed_send_gate():
    raise GatewayError(409, "turn_closed", "the Ask turn closed before its call went")


@pytest.mark.parametrize("where,fail,counted", [
    ("before", httpx.ConnectError("refused"), False), ("before", httpx.ConnectTimeout("slow"), False),
    ("before", httpx.PoolTimeout("busy"), False), ("before", asyncio.CancelledError(), False),
    ("boundary", "send-gate", False), ("boundary", "turn", False), ("boundary", "authority", False),
    ("after", httpx.ReadTimeout("late"), True), ("after", httpx.RemoteProtocolError("dropped"), True),
])
def test_a_call_counts_only_once_it_commits_at_the_send_boundary(monkeypatch, where, fail, counted):
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    upstream = Upstream(fail=fail if where == "before" else None, after=fail if where == "after" else None)
    gate = free_gateway(upstream)
    gate.free_gate = AdmitAll()
    if fail == "turn":
        gate.authorize_agent = ClosingTurn()
    if fail == "authority":   # the person was disabled while the call waited for its connection
        gate.free_gate.refuse = GatewayError(403, "free_inference_person_only", "no longer a person it admits")

    async def run():
        if fail == "send-gate":   # the Ask's commitment gate, refusing a turn that closed
            SEND_GATE.set(closed_send_gate)
        return await gate.chat(AGENT, {"messages": [{"role": "user", "content": "hi"}]}, principal=ANN)

    with pytest.raises((GatewayError, httpx.HTTPError, asyncio.CancelledError)):
        asyncio.run(run())
    assert gate.free_gate.calls[0] == (ANN, True)   # counted once, at dispatch
    assert gate.free_gate.released == ([] if counted else [TICKET])
    assert len(upstream.sent) == (1 if where == "after" else 0)


# ---- a busy endpoint: its 429s retried, then refused in plain words --------------------------------------------------

@pytest.mark.parametrize("headers,attempt,rng,expected", [
    ({"retry-after-ms": "1500", "retry-after": "7"}, 0, 0.5, 1.5),   # the answer's own wait, milliseconds first
    ({"retry-after": "3"}, 3, 0.5, 3.0),                             # seconds, whatever the attempt
    ({"retry-after": "30"}, 0, 0.5, None),                           # longer than a call waits: no retry
    ({"retry-after": "0"}, 1, 0.5, 1.0),                             # zero is none given: backoff, 0.5 of min(8, 2)
    ({"retry-after": "soon"}, 2, 0.5, 2.0),                          # unreadable: backoff, 0.5 of min(8, 4)
    ({}, 0, 0.999, 0.999), ({}, 4, 0.999, 0.999 * FREE_RETRY_CAP), ({}, 9, 0.0, 0.0),   # full jitter under the cap
])
def test_a_429_waits_what_the_answer_asks_or_a_full_jitter_backoff(headers, attempt, rng, expected):
    got = free_retry_delay(attempt, httpx.Headers(headers), rng=lambda: rng)
    if expected is None:
        assert got is None
    else:
        assert got == pytest.approx(expected)


def test_a_429s_http_date_counts_from_now():
    now = datetime.datetime.now(datetime.timezone.utc)
    soon, past = (email.utils.format_datetime(now + datetime.timedelta(seconds=s), usegmt=True) for s in (5, -5))
    assert 3.5 < free_retry_delay(0, httpx.Headers({"retry-after": soon}), rng=lambda: 0.0) <= 5.0
    assert free_retry_delay(1, httpx.Headers({"retry-after": past}), rng=lambda: 0.5) == pytest.approx(1.0)


def busy_gateway(monkeypatch, plan):
    """The gateway over an endpoint answering `plan` first; each wait the policy chooses is skipped, and recorded."""
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    upstream = Upstream(plan=plan)
    gate = free_gateway(upstream)
    gate.free_gate = AdmitAll()
    chosen = []

    def no_wait(attempt, headers):
        real = free_retry_delay(attempt, headers)
        chosen.append(real)
        return None if real is None else 0.0

    monkeypatch.setattr(gateway_module, "free_retry_delay", no_wait)
    return gate, upstream, chosen


HI = {"messages": [{"role": "user", "content": "hi"}]}


def test_a_429_is_retried_and_the_call_counts_once(monkeypatch):
    gate, upstream, chosen = busy_gateway(monkeypatch, [(429, {}), (429, {"retry-after": "2"})])
    response, usage = asyncio.run(gate.chat(AGENT, HI, principal=ANN))
    assert response["choices"][0]["message"]["content"] == "hello from free" and usage["payer_mode"] == "free"
    assert len(upstream.sent) == 3 and chosen[1] == 2.0   # retried twice, the second time after the wait it asked for
    assert gate.free_gate.calls.count((ANN, True)) == 1   # one call: counted once, at dispatch
    assert gate.free_gate.calls.count((ANN, "authorize")) == 3   # each send judged again at its own boundary
    assert gate.free_gate.released == []


@pytest.mark.parametrize("plan,sent,wait,when", [
    # every retry refused too, with no wait asked (Singularity Compute's 429): the loop's next wait, said as a moment
    ([(429, {})] * (FREE_RETRIES + 1), FREE_RETRIES + 1, 0.0, "in a moment"),
    ([(429, {"retry-after": "60"})], 1, 60.0, "in about a minute"),   # asked longer than a call waits: no retry
    # however long it asks, a mind holds at most half an hour (refusals.LONGEST_WAIT_S), and the sentence says that
    ([(429, {"retry-after": "3600"})], 1, 1800.0, "in about 30 minutes"),
])
def test_a_call_still_refused_after_its_retries_is_busy_in_plain_words_and_counts_nothing(monkeypatch, caplog, plan, sent, wait, when):
    caplog.set_level(logging.DEBUG)
    gate, upstream, chosen = busy_gateway(monkeypatch, plan)
    with pytest.raises(GatewayError) as refusal:
        asyncio.run(gate.chat(AGENT, HI, principal=ANN))
    said = KINDS["free_inference_busy"].say.format(when=when)
    assert (refusal.value.status, refusal.value.code, refusal.value.message) == (429, "free_inference_busy", said)
    # what helps is waiting: as long as the answer asked, up to half an hour, else the wait the loop would have made next
    assert refusal.value.remedy == "wait" and refusal.value.retry_after == wait
    assert len(upstream.sent) == sent and gate.free_gate.released == [TICKET]   # nothing served: its count goes back
    assert "rate limits" not in refusal.value.message and DEPLOY_KEY not in caplog.text and TAIL not in caplog.text


def test_a_call_cancelled_while_it_waits_to_retry_gives_its_count_back(monkeypatch):
    monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", DEPLOY_KEY)
    upstream = Upstream(plan=[(429, {"retry-after": "5"})])
    gate = free_gateway(upstream)
    gate.free_gate = AdmitAll()

    async def run():
        task = asyncio.ensure_future(gate.chat(AGENT, HI, principal=ANN))
        while not upstream.sent:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)   # waiting the 5 s the answer asked for
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert len(upstream.sent) == 1 and gate.free_gate.released == [TICKET]


@pytest.mark.parametrize("hive_client", [{}], indirect=True)
def test_a_minds_call_on_a_busy_route_is_refused_in_plain_words_and_counts_nothing(hive_client, monkeypatch):
    hive_client.upstream.plan = [(429, {"retry-after": "60"})]
    agent = free_mind(hive_client)
    response = call(hive_client, agent)
    said = KINDS["free_inference_busy"].say.format(when="in about a minute")   # the wait the endpoint asked for
    assert response.status_code == 429 and response.json()["error"] == {"code": "free_inference_busy", "message": said}
    assert hive_client.hive.gateway.free_gate.used(ANN) == 0 and usage_rows(hive_client, agent) == []


def _page_words(path, table):
    """The codes a table in the page words, by its rows' keys."""
    source = (pathlib.Path(__file__).resolve().parents[1] / "ui" / "src" / path).read_text()
    return set(re.findall(r"^\s+(\w+): ['{]", source.split(table, 1)[1].split("\n}\n", 1)[0], re.M))


def test_a_minds_error_card_words_every_refusal_in_the_table():
    """A mind's last error (lib/llmErrors.ts KNOWN) names each refusal in refusals.py's table by its own reason, never the
    per-minute limit's words a bare 429 would get."""
    keys = _page_words("lib/llmErrors.ts", "const KNOWN")
    assert set(KINDS) <= keys, sorted(set(KINDS) - keys)


def test_an_ask_stop_words_no_refusal_from_the_table_a_second_time():
    """A refusal from the table ends an Ask turn as its answer, in the table's words, so the page's own stop words
    (words.ts DONE_ERROR_WORDS) hold none of them: one there would print the same refusal twice."""
    keys = _page_words("features/ask/words.ts", "export const DONE_ERROR_WORDS")
    assert not keys & set(KINDS), sorted(keys & set(KINDS))


# ---- the whole route, on a hive ------------------------------------------------------------------------------------

def make_client(monkeypatch, cap=None, key=DEPLOY_KEY, hive_cap=None):
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    if key:
        monkeypatch.setenv("HIVE_FREE_INFERENCE_KEY", key)
    if cap is not None:
        monkeypatch.setenv("HIVE_FREE_INFERENCE_DAILY_CALLS", str(cap))
    if hive_cap is not None:
        monkeypatch.setenv("HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS", str(hive_cap))
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")), admin_password="pw",
                             petta_path=PETTA)
    return TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0))


@pytest.fixture
def hive_client(monkeypatch, request):
    with make_client(monkeypatch, **getattr(request, "param", {})) as client:
        token = client.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        client.headers["Authorization"] = f"Bearer {token}"
        client.hive = client.app.state.hive
        client.upstream = Upstream()
        old = client.hive.gateway.client
        client.hive.gateway.client = httpx.AsyncClient(transport=client.upstream)
        asyncio.run(old.aclose())
        client.ann, client.bob = person(client, "u_ann"), person(client, "u_bob")
        yield client


def free_mind(client, owner=ANN, model=f"{FREE}/{FREE_DEFAULT_MODELS[0]}", asked=True, new=False, n=1):
    """A mind made by the admin, then owned by a person and set on the free route. asked: someone has just written to it
    (Hive.mark_asked), as for a mind in use; False leaves it never addressed, which the free route lets rest once its
    window from creation has passed: made two hours ago, unless new. n > 1: the other minds of its swarm come back too,
    as (mind, others)."""
    swarm, agents = make_swarm_and_agents(client, n=n)
    agent = agents[0]
    client.hive.db.execute("UPDATE agents SET owner = ?, model = ? WHERE id = ?", (owner, model, agent["id"]))
    if asked:
        client.hive.mark_asked(agent["id"])
    elif not new:
        client.hive.db.execute("UPDATE agents SET created_at = ? WHERE id = ?", (stamp_ago(hours=2), agent["id"]))
    for a in agents:
        a["swarm_id"] = swarm["id"]
    return agent if n == 1 else (agent, agents[1:])


def call(client, agent):
    return client.post("/llm/v1/chat/completions", headers=agent_headers(agent),
                       json={"messages": [{"role": "user", "content": "invented question"}]})


def usage_rows(client, agent):
    return client.hive.db.all("SELECT * FROM usage WHERE agent_id = ?", (agent["id"],))


def test_a_persons_mind_answers_on_the_deploys_key_and_nobody_pays(hive_client):
    agent = free_mind(hive_client)
    response = call(hive_client, agent)
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == "hello from free"
    (sent,) = hive_client.upstream.sent
    assert sent.headers["authorization"] == f"Bearer {DEPLOY_KEY}" and str(sent.url).startswith(SC)
    (row,) = usage_rows(hive_client, agent)
    assert (row["payer"], row["payer_mode"], row["key_id"], row["cost_usd"]) == (ANN, "free", None, 0.0)
    assert (row["prompt_tokens"], row["completion_tokens"]) == (21, 4)
    assert hive_client.app.state.hive.gateway.free_gate.used(ANN) == 1


@pytest.mark.parametrize("hive_client", [{"cap": 2}], indirect=True)
def test_each_person_is_held_to_their_own_calls_a_day(hive_client):
    ann, bob = free_mind(hive_client), free_mind(hive_client, owner=BOB)
    assert [call(hive_client, ann).status_code for _ in range(2)] == [200, 200]
    refused = call(hive_client, ann)
    assert refused.status_code == 429
    error = refused.json()["error"]
    assert error["code"] == "free_inference_daily_cap" and "2 free model calls" in error["message"]
    assert "replies in rooms and their goals included" in error["message"]   # what a mind does counts, said where it bites
    assert len(hive_client.upstream.sent) == 2 and len(usage_rows(hive_client, ann)) == 2   # nothing sent past the cap
    assert call(hive_client, bob).status_code == 200   # another person's day is their own
    gate = hive_client.hive.gateway.free_gate
    with pytest.raises(GatewayError) as full:   # the count at dispatch refuses her too, saying her calls come back at midnight
        gate.admit(hive_client.hive._agent_row(ann["id"]), dispatch=True)
    assert (full.value.code, full.value.remedy) == ("free_inference_daily_cap", "wait") and 0 < full.value.retry_after <= 86400
    assert (gate.used(ANN), gate.used(BOB)) == (2, 1)


@pytest.mark.parametrize("hive_client", [{"cap": 5, "hive_cap": 3}], indirect=True)
def test_the_hive_has_a_ceiling_of_its_own_however_many_people_call(hive_client):
    ann, bob = free_mind(hive_client), free_mind(hive_client, owner=BOB)
    assert [call(hive_client, ann).status_code for _ in range(2)] + [call(hive_client, bob).status_code] == [200] * 3
    refused = call(hive_client, bob)   # Bob has 4 of his 5 calls left, but the hive's 3 are used
    error = refused.json()["error"]
    assert (refused.status_code, error["code"]) == (429, "free_inference_hive_daily_cap")
    assert error["message"].startswith("This hive has used all 3 of its free model calls for today.")
    assert len(hive_client.upstream.sent) == 3   # nothing sent past the ceiling
    gate = hive_client.hive.gateway.free_gate
    assert (gate.used(ANN), gate.used(BOB), gate.hive_used()) == (2, 1, 3)
    # the count taken at dispatch holds the ceiling by itself, as calls racing past the estimate's check rely on
    with pytest.raises(GatewayError) as racing:
        gate.admit(hive_client.hive._agent_row(bob["id"]), dispatch=True)
    assert racing.value.code == "free_inference_hive_daily_cap" and gate.hive_used() == 3
    assert racing.value.remedy == "wait" and 0 < racing.value.retry_after <= 86400   # its calls come back at midnight UTC
    with pytest.raises(Exception) as refusal:   # First Light says it in its own words
        hive_client.hive.onboarding.preflight(hive_client.hive._agent_row(bob["id"]))
    assert getattr(refusal.value, "code", None) == "free_hive_cap"


@pytest.mark.parametrize("moment,left", [
    (datetime.datetime(2026, 11, 17, 23, 0, tzinfo=datetime.timezone.utc), 3600.0),
    (datetime.datetime(2026, 11, 17, 0, 0, tzinfo=datetime.timezone.utc), 86400.0),   # at midnight: the whole day ahead
    (datetime.datetime(2026, 12, 31, 23, 59, 30, 500000, tzinfo=datetime.timezone.utc), 29.5),   # across a year's end
])
def test_a_used_up_day_comes_back_when_the_counts_next_day_starts(moment, left):
    """A daily cap's retry_after is the time to the next UTC midnight, where the day the counts use (period_start) starts."""
    assert until_midnight_utc(moment) == left
    reset = moment + datetime.timedelta(seconds=left)
    assert period_start("day", reset) == reset.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.mark.parametrize("hive_client", [{"cap": 0}, {"hive_cap": 0}], indirect=True)
def test_a_day_of_zero_calls_turns_it_off(hive_client):
    response = call(hive_client, free_mind(hive_client))
    assert (response.status_code, response.json()["error"]["code"]) == (403, "free_inference_off")
    assert hive_client.upstream.sent == []
    status = {p["name"]: p for p in hive_client.get("/api/providers", headers=hive_client.ann).json()}[FREE]
    assert status["configured"] is False   # so nothing offers it
    admin = {p["name"]: p for p in hive_client.get("/api/providers").json()}[FREE]
    assert admin["daily_calls"] == 0   # nor to an admin, who sees the route unprojected


@pytest.mark.parametrize("hive_client", [{"cap": "9" * 30, "hive_cap": "9" * 30}], indirect=True)
def test_a_cap_past_sqlites_integers_admits_instead_of_failing(hive_client):
    assert call(hive_client, free_mind(hive_client)).status_code == 200


def visitor(client, pid="u_vic"):
    """A public visitor: signed in on a public hive with no invite (ownhive access 'public')."""
    headers = person(client, pid)
    client.hive.db.execute("UPDATE people SET access = 'public' WHERE id = ?", (pid,))
    return headers


@pytest.mark.parametrize("opted_in", [False, True])
def test_a_public_visitor_is_left_out_unless_the_deploy_opts_in(hive_client, monkeypatch, opted_in):
    if opted_in:
        monkeypatch.setenv("HIVE_FREE_INFERENCE_VISITORS", "1")
    vic = visitor(hive_client)
    status = {p["name"]: p for p in hive_client.get("/api/providers", headers=vic).json()}[FREE]
    listed = [m["id"] for m in hive_client.get("/api/models", headers=vic).json() if m["provider"] == FREE]
    response = call(hive_client, free_mind(hive_client, owner="user:u_vic"))
    if opted_in:
        assert status["configured"] is True and listed == [f"{FREE}/{FREE_DEFAULT_MODELS[0]}"]
        assert response.status_code == 200, response.text
    else:   # not offered to them, not in their model list, and refused before anything is sent
        assert (status["configured"], status["connected"], listed) == (False, False, [])
        assert (response.status_code, response.json()["error"]["code"]) == (403, "free_inference_invited_only")
        assert hive_client.upstream.sent == []
    member = {p["name"]: p for p in hive_client.get("/api/providers", headers=hive_client.ann).json()}[FREE]
    assert member["configured"] is True   # an invited member is offered it either way


def test_only_a_model_the_deploy_offers_runs_on_its_key(hive_client):
    mine = hive_client.get("/api/me/mind", headers=hive_client.ann).json()["mind"]
    refused = hive_client.patch(f"/api/agents/{mine['id']}", headers=hive_client.ann,
                                json={"model": "free/invented/pricey-model"})
    error = refused.json()["error"]
    assert (refused.status_code, error["code"]) == (403, "free_model_not_offered")
    assert error["message"] == f"This hive's free inference doesn't offer invented/pricey-model. It offers {FREE_DEFAULT_MODELS[0]}."
    created = hive_client.post("/api/agents", json={"name": "Ivy", "model": "free/invented/pricey-model"})
    assert (created.status_code, created.json()["error"]["code"]) == (403, "free_model_not_offered")
    dropped = free_mind(hive_client, model="free/invented/dropped-model")   # chosen before the deploy dropped it
    response = call(hive_client, dropped)
    assert (response.status_code, response.json()["error"]["code"]) == (403, "free_model_not_offered")
    assert hive_client.upstream.sent == [] and hive_client.hive.gateway.free_gate.used(ANN) == 0
    kept = hive_client.patch(f"/api/agents/{dropped['id']}", json={"name": "Renamed", "model": "free/invented/dropped-model"})
    assert kept.status_code == 200, kept.text   # an edit that keeps the model is not refused for it
    moved = hive_client.patch(f"/api/agents/{dropped['id']}", json={"model": f"free/{FREE_DEFAULT_MODELS[0]}"})
    assert moved.status_code == 200 and call(hive_client, dropped).status_code == 200


def test_a_call_for_no_one_or_a_disabled_person_is_refused_with_nothing_sent(hive_client):
    nobody = free_mind(hive_client, owner=None)   # a hive mind with no person behind it
    response = call(hive_client, nobody)
    assert (response.status_code, response.json()["error"]["code"]) == (403, "free_inference_person_only")
    hive_client.hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_bob'")
    response = call(hive_client, free_mind(hive_client, owner=BOB))
    assert (response.status_code, response.json()["error"]["code"]) == (403, "free_inference_person_only")
    assert hive_client.upstream.sent == []


@pytest.mark.parametrize("hive_client", [{"key": None}], indirect=True)
def test_without_the_key_nothing_offers_it_and_a_call_is_refused(hive_client):
    assert FREE not in {p["name"] for p in hive_client.get("/api/providers").json()}
    assert not [m for m in hive_client.get("/api/models", headers=hive_client.ann).json() if m["provider"] == FREE]
    response = call(hive_client, free_mind(hive_client))
    assert (response.status_code, response.json()["error"]["code"]) == (403, "free_inference_off")
    assert hive_client.upstream.sent == []


def test_a_local_only_swarm_never_reaches_it(hive_client, monkeypatch):
    agent = free_mind(hive_client)
    monkeypatch.setenv("HIVE_LOCAL_ONLY_SWARMS", json.dumps([agent["swarm_id"]]))
    assert call(hive_client, agent).status_code == 403 and hive_client.upstream.sent == []


@pytest.mark.parametrize("hive_client", [{"cap": 1}], indirect=True)
def test_settlement_and_the_mind_page_say_free_and_bounded(hive_client):
    hive = hive_client.hive
    mine = hive_client.get("/api/me/mind", headers=hive_client.ann).json()["mind"]
    moved = hive_client.patch(f"/api/agents/{mine['id']}", headers=hive_client.ann,
                              json={"model": f"free/{FREE_DEFAULT_MODELS[0]}"})
    assert moved.status_code == 200, moved.text   # the person moves their own mind, as First Light does
    row = hive._agent_row(mine["id"])
    settled = hive.budgets.settlement(row, row["model"])
    assert (settled["payer"], settled["payer_mode"], settled["bounded"], settled["key_id"]) == (ANN, "free", True, None)
    assert settled["free"] is False and settled["host_paid"] is False   # never the host's money, never host-chosen
    page = hive_client.get("/api/me/mind", headers=hive_client.ann).json()["mind"]
    assert page["paid_by"] == ("no one: the free inference this hive's deploy provides, up to 1 model calls a day for you, "
                               "its replies in rooms and its goals included")
    assert hive.budgets.call_limits(row) == {"free": True, "reason": None, "limits": []}
    setup = {i["id"]: i for i in hive_client.get("/api/me/setup", headers=hive_client.ann).json()["items"]}
    assert setup["provider_key"]["done"] and setup["monthly_limit"]["done"]   # no key, and no money to limit
    assert hive.onboarding.preflight(row) is None
    hive.gateway.free_gate.admit(row, principal=ANN, dispatch=True)   # the day's one call is used, by her own Ask
    assert hive.budgets.settlement(row, row["model"])["reason"] == "free_inference_daily_cap"
    with pytest.raises(Exception) as refusal:
        hive.onboarding.preflight(row)
    assert getattr(refusal.value, "code", None) == "free_daily_cap"


def test_the_free_models_are_listed_for_every_signed_in_person(hive_client):
    for headers in (hive_client.ann, hive_client.bob, {}):   # members and the admin
        listed = [m["id"] for m in hive_client.get("/api/models", headers=headers or None).json() if m["provider"] == FREE]
        assert listed == [f"{FREE}/{FREE_DEFAULT_MODELS[0]}"]
    status = {p["name"]: p for p in hive_client.get("/api/providers", headers=hive_client.ann).json()}[FREE]
    assert status["label"] == "Free inference" and status["needs_key"] is False and status["daily_calls"] == 200


# ---- a mind no one has asked rests: its own wakes spend none of its person's free calls ---------------------------

WAKE_CALLS = 8   # one wake of a mind's loop: (+ 2 maxWakeLoops) model calls (runtime native_core), every 15 minutes


def stamp_ago(**delta):
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(**delta)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def rests(client, agent, calls=WAKE_CALLS):
    """A wake's calls are each refused at once as resting, counted against no one and sent nowhere."""
    sent, used = len(client.upstream.sent), client.hive.gateway.free_gate.used(ANN)
    said = KINDS["free_inference_idle"].say
    for _ in range(calls):
        response = call(client, agent)
        assert response.status_code == 429, response.text
        assert response.json()["error"] == {"code": "free_inference_idle", "message": said}
    assert len(client.upstream.sent) == sent and client.hive.gateway.free_gate.used(ANN) == used
    kept = client.hive.model_refusals[agent["id"]]   # the mind's chat and Health say why it is quiet
    assert kept["code"] == "free_inference_idle" and kept["say"] == KINDS["free_inference_idle"].mind_say


def test_a_mind_no_one_asked_rests_and_its_wakes_spend_none_of_its_persons_free_calls(hive_client):
    agent = free_mind(hive_client, asked=False)
    assert hive_client.hive.db.one("SELECT last_input_at FROM agents WHERE id = ?", (agent["id"],))["last_input_at"] is None
    rests(hive_client, agent)
    assert hive_client.hive.gateway.free_gate.used(ANN) == 0 and hive_client.upstream.sent == []
    assert usage_rows(hive_client, agent) == []
    said = KINDS["free_inference_idle"].say
    assert said.startswith("Resting:") and "free_inference" not in said and "A message wakes it." in said


def test_a_persons_message_wakes_a_resting_mind_and_its_calls_count(hive_client):
    agent = free_mind(hive_client, asked=False)
    rests(hive_client, agent, calls=2)
    wrote = hive_client.post(f"/api/agents/{agent['id']}/messages", headers=hive_client.ann, json={"text": "invented question"})
    assert wrote.status_code == 200, wrote.text
    assert [call(hive_client, agent).status_code for _ in range(3)] == [200] * 3
    assert hive_client.hive.gateway.free_gate.used(ANN) == 3 and len(hive_client.upstream.sent) == 3


def test_a_minds_own_words_never_wake_it(hive_client):
    """What a mind does by itself between wakes (a message to another mind, a reply in its chat, a belief it publishes, a
    goal result, its inbox polls over HTTP) stamps last_input_at or last_active_at, so neither can say someone asked it:
    a mind posting on its own wakes would keep itself awake. Only the mind it wrote to was asked."""
    hive = hive_client.hive
    agent, (other,) = free_mind(hive_client, asked=False, n=2)
    headers = agent_headers(agent)
    hive.mark_asked(agent["id"], stamp_ago(hours=1))   # a person last wrote an hour ago
    goal = hive_client.post("/api/agent/goals", headers=headers, json={"title": "invented task"}).json()   # its own goal
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/claim", headers=headers).status_code == 200
    rests(hive_client, agent, calls=2)
    before = hive.db.one("SELECT last_asked_at FROM agents WHERE id = ?", (agent["id"],))["last_asked_at"]
    room = hive_client.post("/api/rooms", json={"kind": "group", "name": "Duo",
                                                "members": [f"agent:{agent['id']}", f"agent:{other['id']}"]}).json()
    to_other = hive_client.post(f"/api/agent/rooms/{room['id']}/messages", headers=headers,
                                json={"text": f"@{other['name']} invented note"})
    assert to_other.status_code == 200 and to_other.json()["delivered_to"] == [f"agent:{other['id']}"], to_other.text
    assert hive_client.post("/api/agent/messages", headers=headers, json={"text": "thinking out loud"}).status_code == 200
    published = hive_client.post("/api/agent/publish", headers=headers, json={"statement": "(--> sky blue)", "f": .9, "c": .8})
    assert published.status_code == 200, published.text
    result = hive_client.post(f"/api/agent/goals/{goal['id']}/result", headers=headers,
                              json={"status": "done", "result": "invented result"})
    assert result.status_code == 200, result.text
    assert hive_client.get("/api/agent/inbox", headers=headers).status_code == 200
    row = hive.db.one("SELECT last_input_at, last_active_at, last_asked_at FROM agents WHERE id = ?", (agent["id"],))
    assert row["last_input_at"] > before and row["last_active_at"] > before   # what the guard must not read
    assert row["last_asked_at"] == before
    rests(hive_client, agent)
    assert hive_client.upstream.sent == [] and hive.gateway.free_gate.used(ANN) == 0
    # a message from another mind passes on only how fresh the sender's own asking is (Hive.mark_asked_by)
    assert hive.db.one("SELECT last_asked_at FROM agents WHERE id = ?", (other["id"],))["last_asked_at"] == before


class _Later(datetime.datetime):
    """The clock the free gate reads, moved ahead (FreeGate.resting), for a window to pass without waiting."""
    ahead = datetime.timedelta(0)

    @classmethod
    def now(cls, tz=None):
        return datetime.datetime.now(tz) + cls.ahead


def later(monkeypatch, **delta):
    import types
    from hive.core import free_inference
    monkeypatch.setattr(_Later, "ahead", datetime.timedelta(**delta))
    monkeypatch.setattr(free_inference, "datetime", types.SimpleNamespace(
        datetime=_Later, timezone=datetime.timezone, timedelta=datetime.timedelta))


def free_minds(client, n, new=False):
    """n minds of one swarm, all Ann's and on the free route, never asked (made two hours ago unless new), in one room."""
    first, others = free_mind(client, asked=False, new=new, n=n)
    minds = [first, *others]
    room = client.post("/api/rooms", json={"kind": "group", "name": "Minds",
                                           "members": [f"agent:{m['id']}" for m in minds]}).json()
    for m in others:
        client.hive.db.execute("UPDATE agents SET owner = ?, model = ?, created_at = ? WHERE id = ?",
                               (ANN, first_model(client, first), stamp_ago(hours=2), m["id"]))
    return minds, room


def first_model(client, mind):
    return client.hive.db.one("SELECT model FROM agents WHERE id = ?", (mind["id"],))["model"]


def mind_says(client, room, sender, to):
    """One mind's message reaching another, at the one place every route lands (Hive.enqueue_message, as rooms, DMs and
    goal notes deliver), so the idle guard is tested apart from the throughput limit a room's post meets first
    (mind_posts, below)."""
    client.hive.enqueue_message(to["id"], "invented note", room["id"], f"agent:{sender['id']}")


def asked_at(client, mind):
    return client.hive.db.one("SELECT last_asked_at FROM agents WHERE id = ?", (mind["id"],))["last_asked_at"]


def mind_posts(client, room, sender, to):
    """sender's post naming `to` in the room, on the minds' own route (throughput.Throughput.admit judges each delivery):
    the minds it reached."""
    posted = client.post(f"/api/agent/rooms/{room['id']}/messages", headers=agent_headers(sender),
                         json={"text": f"@{to['name']} invented note"})
    assert posted.status_code == 200, posted.text
    return posted.json()["delivered_to"]


def hive_says(client, room):
    return [m["text"] for m in client.get(f"/api/rooms/{room['id']}/messages").json() if m["sender"] == "system:hive"]


def stored(client, mind):
    return client.hive.db.one("SELECT * FROM agents WHERE id = ?", (mind["id"],))


def test_a_free_mind_with_no_money_budget_gets_minds_messages_while_its_person_has_free_calls(hive_client):
    """The free route costs no money: a mind on it with budget 0 (no money headroom at all, the usual case) is judged by
    the free calls left, not by money. A delivery is not a call: it counts none, and passes on only the sender's asking."""
    hive = hive_client.hive
    (a, b), room = free_minds(hive_client, 2)
    assert hive.budgets.headroom_micros(stored(hive_client, b)) == 0   # what refused it before
    hive.mark_asked(a["id"], stamp_ago(minutes=20))
    assert mind_posts(hive_client, room, a, b) == [f"agent:{b['id']}"]
    assert hive_says(hive_client, room) == []
    assert asked_at(hive_client, b) == asked_at(hive_client, a)        # her message's time, never now
    assert hive.gateway.free_gate.used(ANN) == 0 and hive_client.upstream.sent == []


@pytest.mark.parametrize("hive_client,full,why", [
    ({"cap": 3}, ANN, "{name}'s person has used up today's free calls (they come back at midnight UTC)"),
    ({"cap": 5, "hive_cap": 3}, BOB, "the hive has used up today's free calls (they come back at midnight UTC)"),
], indirect=["hive_client"])
def test_a_free_mind_whose_free_calls_are_used_up_today_gets_no_minds_messages_and_the_room_says_why(hive_client, full, why):
    """Its person's calls today, or the hive's. Judged whether or not the mind is resting (b was never asked): the day
    being used up is what the room must say."""
    hive = hive_client.hive
    (a, b), room = free_minds(hive_client, 2)
    hive.mark_asked(a["id"], stamp_ago(minutes=20))
    hive.db.execute("INSERT INTO free_inference_calls (person, day, calls) VALUES (?, ?, 3)", (full, period_start("day")))
    assert mind_posts(hive_client, room, a, b) == []
    assert hive_says(hive_client, room) == [f"Not delivered to {b['name']}: {why.format(name=b['name'])}."]
    assert hive.gateway.free_gate.used(full) == 3 and hive_client.upstream.sent == []   # the check counts nothing


def test_a_paid_mind_with_no_budget_left_still_gets_no_minds_messages(hive_client):
    hive = hive_client.hive
    (a, b), room = free_minds(hive_client, 2)
    hive.db.execute("UPDATE agents SET model = ? WHERE id = ?", ("openai/gpt-6.1", b["id"]))
    hive.mark_asked(a["id"], stamp_ago(minutes=20))
    assert hive.budgets.headroom_micros(stored(hive_client, b)) == 0
    assert mind_posts(hive_client, room, a, b) == []
    assert hive_says(hive_client, room) == [f"Not delivered to {b['name']}: {b['name']} has no budget left to answer."]


def test_two_minds_talking_with_no_person_rest_after_the_window(hive_client, monkeypatch):
    (a, b), room = free_minds(hive_client, 2)
    hive_client.hive.mark_asked(a["id"], stamp_ago(minutes=20))   # a person last wrote to a twenty minutes ago
    for _ in range(3):
        mind_says(hive_client, room, a, b)
        mind_says(hive_client, room, b, a)
    assert asked_at(hive_client, a) == asked_at(hive_client, b)   # their talk passes on her message's time, never now
    assert call(hive_client, a).status_code == 200 and call(hive_client, b).status_code == 200
    later(monkeypatch, minutes=11)   # thirty-one minutes after her message
    for _ in range(3):
        mind_says(hive_client, room, a, b)
        mind_says(hive_client, room, b, a)
    rests(hive_client, a)
    rests(hive_client, b)


def test_a_chain_a_person_started_goes_on_inside_her_window_only(hive_client, monkeypatch):
    (a, b, c), room = free_minds(hive_client, 3)
    wrote = hive_client.post(f"/api/agents/{a['id']}/messages", headers=hive_client.ann, json={"text": "invented question"})
    assert wrote.status_code == 200, wrote.text
    mind_says(hive_client, room, a, b)
    mind_says(hive_client, room, b, c)
    assert asked_at(hive_client, a) == asked_at(hive_client, b) == asked_at(hive_client, c)
    assert [call(hive_client, m).status_code for m in (a, b, c)] == [200] * 3
    later(monkeypatch, minutes=31)
    mind_says(hive_client, room, a, b)
    mind_says(hive_client, room, b, c)
    for m in (a, b, c):
        rests(hive_client, m, calls=2)
    assert hive_client.hive.gateway.free_gate.used(ANN) == 3


@pytest.mark.parametrize("new", [True, False])
def test_a_mind_no_one_asked_passes_nothing_on(hive_client, new):
    """Two minds of one owner, never asked; a writes to b: all of b's wake calls rest. A never-asked mind's window from
    its creation is its own, so even a new one writing to a resting mind wakes nothing."""
    (a, b), room = free_minds(hive_client, 2, new=new)   # a new, or made two hours ago; b made two hours ago
    assert asked_at(hive_client, a) is None
    if new:
        assert call(hive_client, a).status_code == 200
    mind_says(hive_client, room, a, b)
    assert asked_at(hive_client, b) is None
    rests(hive_client, b)


def test_a_new_mind_gets_the_window_once_from_its_creation(hive_client):
    agent = free_mind(hive_client, asked=False, new=True)
    hive = hive_client.hive
    assert hive.db.one("SELECT last_asked_at FROM agents WHERE id = ?", (agent["id"],))["last_asked_at"] is None
    assert [call(hive_client, agent).status_code for _ in range(WAKE_CALLS)] == [200] * WAKE_CALLS   # its first wake
    assert hive.gateway.free_gate.used(ANN) == WAKE_CALLS
    hive.db.execute("UPDATE agents SET created_at = ? WHERE id = ?", (stamp_ago(minutes=31), agent["id"]))
    rests(hive_client, agent)   # the same mind past the window, with nothing from outside since
    assert hive.gateway.free_gate.used(ANN) == WAKE_CALLS and len(hive_client.upstream.sent) == WAKE_CALLS


@pytest.mark.parametrize("dispatch", [False, True])
def test_resting_is_judged_on_both_admissions_before_anything_counts(hive_client, dispatch):
    """The estimate's check (dispatch=False) and the count just before sending (dispatch=True) both refuse a resting
    mind, before the day's count is touched: a call that got past the first while its window closed is caught by the
    second."""
    agent = free_mind(hive_client, asked=False)
    gate, row = hive_client.hive.gateway.free_gate, hive_client.hive._agent_row(agent["id"])
    with pytest.raises(GatewayError) as resting:
        gate.admit(row, dispatch=dispatch)
    assert (resting.value.status, resting.value.code, resting.value.remedy) == (429, "free_inference_idle", "wait")
    assert gate.used(ANN) == 0 and gate.hive_used() == 0
    assert hive_client.hive.db.all("SELECT * FROM free_inference_calls") == []   # not even an empty row for the day
    hive_client.hive.mark_asked(agent["id"])
    assert gate.admit(row, dispatch=dispatch) == ((ANN, period_start("day")) if dispatch else None)
    assert gate.used(ANN) == (1 if dispatch else 0)


def test_resting_is_the_hives_own_refusal_never_a_providers_wait(hive_client):
    """free_inference_idle asks nothing of a provider, so no wait is kept on the mind (Hive.model_refusal_holds): the
    first message lets its next call go at once, and a refused call never reaches the endpoint."""
    kind = KINDS["free_inference_idle"]
    assert kind.upstream is False and kind.remedy == "wait"
    agent = free_mind(hive_client, asked=False)
    rests(hive_client, agent)
    hive = hive_client.hive
    assert hive_client.upstream.sent == []   # the fake endpoint got no request at all
    assert hive.model_refusals[agent["id"]]["retry_at"] is None
    assert hive.model_refusal_holds(hive._agent_row(agent["id"])) is None
    hive.enqueue_message(agent["id"], "invented question", None, ANN)
    assert call(hive_client, agent).status_code == 200 and len(hive_client.upstream.sent) == 1


@pytest.mark.parametrize("step", ["claim", "heartbeat"])
def test_a_claim_or_heartbeat_on_a_persons_goal_wakes_it(hive_client, step):
    """A person's goal carries its making as its asking (goals.asked_at): claiming it, or a heartbeat on it, passes that on."""
    agent = free_mind(hive_client, asked=False)
    goal = hive_client.post(f"/api/swarms/{agent['swarm_id']}/goals", json={"title": "invented task"}).json()
    made = hive_client.hive.db.one("SELECT asked_at, created_at, created_by FROM goals WHERE id = ?", (goal["id"],))
    assert made["created_by"].startswith("user:") and made["asked_at"] == made["created_at"]
    hive_client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(agent))
    if step == "heartbeat":   # long after the claim, the holder says it is still on the work
        hive_client.hive.db.execute("UPDATE agents SET last_asked_at = ? WHERE id = ?", (stamp_ago(hours=2), agent["id"]))
        beat = hive_client.post(f"/api/agent/goals/{goal['id']}/heartbeat", headers=agent_headers(agent))
        assert beat.status_code == 200, beat.text
    assert asked_at(hive_client, agent) == made["asked_at"]
    assert call(hive_client, agent).status_code == 200
    assert hive_client.hive.gateway.free_gate.used(ANN) == 1


def test_a_mind_no_one_asked_cant_wake_itself_with_its_own_goal(hive_client):
    """hive-goal-create, claim and heartbeat by a mind no one asked: its goal carries no asking, so its calls rest."""
    agent = free_mind(hive_client, asked=False)
    headers = agent_headers(agent)
    goal = hive_client.post("/api/agent/goals", headers=headers, json={"title": "invented task"})
    assert goal.status_code == 200, goal.text
    goal = goal.json()
    assert hive_client.hive.db.one("SELECT asked_at FROM goals WHERE id = ?", (goal["id"],))["asked_at"] is None
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/claim", headers=headers).status_code == 200
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/heartbeat", headers=headers).status_code == 200
    assert asked_at(hive_client, agent) is None
    rests(hive_client, agent)
    assert hive_client.upstream.sent == []


def test_a_goal_a_mind_makes_runs_on_the_asking_that_started_it(hive_client, monkeypatch):
    """A person writes to A; A makes a goal inside her window; B claims it and is admitted, until her window runs out.
    (A goal a mind makes is not a person's goal, so no live-lease admit holds B past it: on_persons_goal.)"""
    (a, b), _ = free_minds(hive_client, 2)
    wrote = hive_client.post(f"/api/agents/{a['id']}/messages", headers=hive_client.ann, json={"text": "invented question"})
    assert wrote.status_code == 200, wrote.text
    goal = hive_client.post("/api/agent/goals", headers=agent_headers(a), json={"title": "invented subtask"}).json()
    assert hive_client.hive.db.one("SELECT asked_at FROM goals WHERE id = ?", (goal["id"],))["asked_at"] == asked_at(hive_client, a)
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(b)).status_code == 200
    assert asked_at(hive_client, b) == asked_at(hive_client, a)
    assert call(hive_client, b).status_code == 200
    later(monkeypatch, minutes=31)
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/heartbeat", headers=agent_headers(b)).status_code == 200
    rests(hive_client, b)


@pytest.mark.parametrize("lease", ["live", "expired"])
def test_a_live_lease_on_a_persons_goal_keeps_its_mind_going(hive_client, lease):
    """The runtime sends no heartbeat by itself and a lease (60 minutes) outlasts the window (30): while the mind holds a
    live lease on a goal a person made, it doesn't rest mid-run; once the lease has lapsed, it does."""
    agent = free_mind(hive_client, asked=False)
    goal = hive_client.post(f"/api/swarms/{agent['swarm_id']}/goals", json={"title": "invented task"}).json()
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(agent)).status_code == 200
    hive_client.hive.db.execute("UPDATE agents SET last_asked_at = ? WHERE id = ?", (stamp_ago(minutes=45), agent["id"]))
    if lease == "live":
        assert hive_client.hive.db.one("SELECT lease_until FROM goals WHERE id = ?", (goal["id"],))["lease_until"] > stamp_ago()
        assert [call(hive_client, agent).status_code for _ in range(WAKE_CALLS)] == [200] * WAKE_CALLS
    else:
        hive_client.hive.db.execute("UPDATE goals SET lease_until = ? WHERE id = ?", (stamp_ago(minutes=1), goal["id"]))
        rests(hive_client, agent)


def person_behind_goal(client, agent, source):
    """A goal a person started another way, recorded as the hive records it: a Create plan's step (create_plan_ports:
    created_by create-plan:<plan>, its run's person) or a request's receiving goal (research and the Code controller:
    created_by request:<id>, its from_principal). Returns the goal row."""
    hive, at = client.hive, stamp_ago()
    if source == "create-plan":
        hive.db.insert("create_plan_runs", {"plan_id": "pl_invented01", "person": ANN, "sentence": "invented app",
                                            "epoch": "ep-invented", "reducer_sha256": "0" * 64,
                                            "review_policy": "review-required", "lease": 1, "piece_cap": 1, "fix_cap": 1,
                                            "phase": "claimed", "status": "building", "created_at": at, "updated_at": at})
        created_by = "create-plan:pl_invented01"
    else:
        hive.db.insert("requests", {"id": "rq_invented01", "kind": "research", "title": "invented", "from_swarm": agent["swarm_id"],
                                    "from_principal": ANN, "to_swarm": agent["swarm_id"], "context_refs": "[]",
                                    "constraints": "{}", "acceptance": "{}", "budget_root": "rq_invented01", "limit_usd": 1.0,
                                    "ancestry": "[]", "depth": 0, "created_at": at})
        created_by = "request:rq_invented01"
    view = hive.goals._create_record(agent["swarm_id"], "Create plan pl_invented01: build", "invented", 0.6,
                                     created_by=created_by, assignee=agent["id"])
    return hive.db.one("SELECT * FROM goals WHERE id = ?", (view["id"],))


@pytest.mark.parametrize("source", ["create-plan", "request"])
def test_a_goal_a_person_started_through_create_or_a_request_is_hers(hive_client, monkeypatch, source):
    """Create on the free route: a plan's step (or a request's goal) resolves to the person behind it (Goals.person_behind),
    so it carries its making as its asking, and its mind goes on past the window while its lease is live, and rests once
    the lease has lapsed with no new asking."""
    agent = free_mind(hive_client, asked=False)
    goal = person_behind_goal(hive_client, agent, source)
    assert hive_client.hive.goals.person_behind(goal["created_by"]) == ANN and goal["asked_at"] == goal["created_at"]
    assert hive_client.post(f"/api/agent/goals/{goal['id']}/claim", headers=agent_headers(agent)).status_code == 200
    assert asked_at(hive_client, agent) == goal["asked_at"]
    later(monkeypatch, minutes=45)   # past the window, inside the 60-minute lease
    assert [call(hive_client, agent).status_code for _ in range(WAKE_CALLS)] == [200] * WAKE_CALLS
    hive_client.hive.db.execute("UPDATE goals SET lease_until = ? WHERE id = ?", (stamp_ago(), goal["id"]))   # lapsed
    rests(hive_client, agent)
    assert hive_client.hive.gateway.free_gate.used(ANN) == WAKE_CALLS


def test_no_person_is_guessed_behind_a_goal(hive_client):
    """A program's, the hive's own, a mind's, an unknown request's or plan's: no person (and no asking carried)."""
    goals = hive_client.hive.goals
    for creator in ("program:invented", "host:screens", "hive:flows", "agent:a_00000001", "request:rq_missing",
                    "create-plan:pl_missing", "", None):
        assert goals.person_behind(creator) is None, creator
        assert goals._creator_asked(creator, stamp_ago()) is None, creator
    assert goals.person_behind("user:u_ann") == ANN


def test_a_resting_mind_assigned_a_request_by_a_mind_a_person_asked_wakes_and_claims(hive_client):
    """Through collaboration's real route (POST /api/agent/requests): the receiving goal is written before its requests
    row, so its asking is resolved when it is passed on (Goals.asking). Mind r works a person's goal; it asks swarm V for a
    review, assigned to the resting reviewer v, whose goal note then carries r's asking: v is admitted and claims."""
    client, hive = hive_client, hive_client.hive
    R, V = (client.post("/api/swarms", json={"name": n}).json() for n in ("Requester", "Review"))
    role = client.post("/api/roles", json={"name": "Critic security r", "prompt": "review",
                                           "mandate": {"id": "security", "version": "1"}}).json()["id"]
    r = client.post("/api/agents", json={"name": "Asker", "kind": "module", "swarm_id": R["id"]}).json()
    v = client.post("/api/agents", json={"name": "Critic", "kind": "module", "swarm_id": V["id"], "role_id": role}).json()
    hive.db.execute("UPDATE agents SET owner = ?, model = ?, created_at = ? WHERE id = ?",
                    (ANN, f"{FREE}/{FREE_DEFAULT_MODELS[0]}", stamp_ago(hours=2), v["id"]))   # resting, never asked
    rests(client, v, calls=2)
    work = client.post(f"/api/swarms/{R['id']}/goals", json={"title": "invented work", "assignee": r["name"]}).json()
    assert client.post(f"/api/agent/goals/{work['id']}/claim", headers=agent_headers(r)).status_code == 200
    client.put(f"/api/swarms/{V['id']}/services", json={"kinds": ["review"]})
    asked = client.post("/api/agent/requests", headers=agent_headers(r),
                        json={"kind": "review", "to_swarm": V["id"], "title": "Review invented", "from_goal": work["id"],
                              "constraints": {"mandates": [{"id": "security", "version": "1"}]}})
    assert asked.status_code == 200, asked.text
    goal = asked.json()["receiving_goal"]
    assert asked_at(client, v) == asked_at(client, r)   # the goal note carried r's asking
    assert hive.db.one("SELECT asked_at FROM goals WHERE id = ?", (goal,))["asked_at"] == asked_at(client, r)
    assert call(client, v).status_code == 200
    assert client.post(f"/api/agent/goals/{goal}/claim", headers=agent_headers(v)).status_code == 200


def test_the_migration_fills_last_asked_at_from_last_input_at_once(tmp_path):
    from hive.core.db import Database
    path = tmp_path / "hive.db"
    db = Database(path)
    for i, stamp in enumerate(("2026-11-19T10:00:00.000Z", None)):
        db.execute("INSERT INTO agents (id, name, kind, model, hue, status, driver, token_hash, created_at, last_input_at) "
                   "VALUES (?, 'invented', 'omega', 'mock/x', 1, 'awake', 'hive', ?, '2026-11-01T00:00:00.000Z', ?)",
                   (f"a_{i}", f"t{i}", stamp))
    db.execute("ALTER TABLE agents DROP COLUMN last_asked_at")   # as a hive from before this change has it
    db = Database(path)
    rows = {r["id"]: r["last_asked_at"] for r in db.all("SELECT id, last_asked_at FROM agents")}
    assert rows == {"a_0": "2026-11-19T10:00:00.000Z", "a_1": None}
    db.execute("UPDATE agents SET last_asked_at = NULL")
    db = Database(path)   # once: a later start fills nothing
    assert [r["last_asked_at"] for r in db.all("SELECT last_asked_at FROM agents")] == [None, None]


def test_the_migration_fills_a_persons_goals_asking_once(tmp_path):
    from hive.core.db import Database
    path = tmp_path / "hive.db"
    db = Database(path)
    for gid, creator in (("g_person", "user:u_ann"), ("g_mind", "agent:a_0"), ("g_plan", "create-plan:pl_x")):
        db.execute("INSERT INTO goals (id, swarm_id, title, priority, status, created_by, created_at, updated_at) "
                   "VALUES (?, 's_0', 'invented', 0.5, 'open', ?, '2026-11-19T10:00:00.000Z', '2026-11-19T10:00:00.000Z')",
                   (gid, creator))
    db.execute("ALTER TABLE goals DROP COLUMN asked_at")   # as a hive from before this change has it
    db = Database(path)
    rows = {r["id"]: r["asked_at"] for r in db.all("SELECT id, asked_at FROM goals")}
    # a person's own goal at once; the others are resolved when they are passed on (Goals.asking)
    assert rows == {"g_person": "2026-11-19T10:00:00.000Z", "g_mind": None, "g_plan": None}
    db.execute("UPDATE goals SET asked_at = NULL")
    db = Database(path)   # once: a later start fills nothing
    assert {r["asked_at"] for r in db.all("SELECT asked_at FROM goals")} == {None}


def test_an_ask_on_a_resting_mind_goes_at_once(hive_client):
    """An Ask delivered to a swarm's coordinator is the asker's message (Ask._admit -> enqueue_message), so the mind's own
    calls for it go at once; a conducting Ask turn and a browser turn name the person asking (principal) on the call
    itself, which is admitted even while the mind rests."""
    hive, client = hive_client.hive, hive_client
    sw = client.post("/api/swarms", json={"name": "Home", "visibility": "shared", "shared_with": [ANN]}).json()
    client.put(f"/api/swarms/{sw['id']}/visibility", json={"visibility": "shared", "shared_with": [ANN]})
    coord = client.post("/api/agents", json={"name": "Orchestra", "swarm_id": sw["id"]}).json()
    client.put(f"/api/agents/{coord['id']}/visibility", json={"visibility": "shared", "shared_with": [ANN]})
    assert client.patch(f"/api/swarms/{sw['id']}", json={"coordinator_id": coord["id"]}).status_code == 200
    hive.db.execute("UPDATE agents SET status = 'awake', desired = 'awake', owner = ?, model = ?, created_at = ?, "
                    "last_asked_at = NULL WHERE id = ?", (ANN, f"{FREE}/{FREE_DEFAULT_MODELS[0]}", stamp_ago(hours=2), coord["id"]))
    rests(client, coord, calls=2)   # awake, made long ago, never asked
    asked = client.post("/api/ask", headers=client.ann, json={"operation_id": "op-idle-ask", "text": "invented question",
                                                              "context": {"swarm_id": sw["id"]}})
    assert asked.status_code == 202, asked.text
    assert [call(client, coord).status_code for _ in range(WAKE_CALLS)] == [200] * WAKE_CALLS   # its turn, at once
    assert hive.gateway.free_gate.used(ANN) == WAKE_CALLS
    # the conductor's and the mind gateway's call: the person asking named on it, on a mind resting again
    hive.db.execute("UPDATE agents SET last_asked_at = ? WHERE id = ?", (stamp_ago(hours=2), coord["id"]))
    row, gw = hive._agent_row(coord["id"]), hive.gateway
    assert gw.free_gate.resting(row)
    assert gw.estimate(row, {"messages": []}, principal=ANN) == (False, 0.0)
    response, _ = asyncio.run(gw.chat(row, {"messages": [{"role": "user", "content": "hi"}]}, principal=ANN))
    assert response["choices"][0]["message"]["content"] == "hello from free"
    assert gw.free_gate.used(ANN) == WAKE_CALLS + 1 and len(client.upstream.sent) == WAKE_CALLS + 1


def test_a_call_for_the_person_asking_is_never_resting(hive_client):
    """The Ask's conductor and a browser turn name the person asking (principal): that person is the input."""
    agent = free_mind(hive_client, asked=False)
    gate, row = hive_client.hive.gateway.free_gate, hive_client.hive._agent_row(agent["id"])
    assert gate.admit(row, principal=ANN, dispatch=True) == (ANN, period_start("day"))
    with pytest.raises(GatewayError) as resting:
        gate.admit(row, dispatch=True)
    assert resting.value.code == "free_inference_idle" and gate.used(ANN) == 1
    # First Light and the mind's page ask whether the route would serve it, not whether it is resting now
    assert hive_client.hive.onboarding.preflight(row) is None
    assert hive_client.hive.budgets.settlement(row, row["model"])["reason"] is None


@pytest.mark.parametrize("hive_client", [{"key": None}], indirect=True)
def test_a_paid_mind_no_one_asked_is_unaffected(hive_client, monkeypatch):
    monkeypatch.setenv("ASI_API_KEY", "invented-hive-asi-key-0005")
    hive_client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 5})
    _, (agent,) = make_swarm_and_agents(hive_client, n=1, model="asicloud/asi1-mini")
    hive_client.hive.db.execute("UPDATE agents SET budget_usd = 1, owner = ? WHERE id = ?", (ANN, agent["id"]))
    assert hive_client.hive.db.one("SELECT last_input_at FROM agents WHERE id = ?", (agent["id"],))["last_input_at"] is None
    assert [call(hive_client, agent).status_code for _ in range(3)] == [200] * 3


def test_a_window_of_zero_turns_resting_off_and_old_input_rests_again(hive_client, monkeypatch):
    agent = free_mind(hive_client)
    assert call(hive_client, agent).status_code == 200
    hive_client.hive.db.execute("UPDATE agents SET last_asked_at = ?, last_input_at = ? WHERE id = ?",
                                (stamp_ago(minutes=31), stamp_ago(minutes=31), agent["id"]))
    rests(hive_client, agent)   # half an hour by default: input older than that is none
    monkeypatch.setenv("HIVE_FREE_INFERENCE_IDLE_WINDOW_S", "3600")
    assert call(hive_client, agent).status_code == 200
    monkeypatch.setenv("HIVE_FREE_INFERENCE_IDLE_WINDOW_S", "0")
    never = free_mind(hive_client, asked=False)
    assert call(hive_client, never).status_code == 200 and call(hive_client, agent).status_code == 200
    assert hive_client.hive.gateway.free_gate.used(ANN) == 4


@pytest.mark.parametrize("raw,window", [(None, 1800), ("600", 600), ("0", 0), ("-5", 1800), ("soon", 1800)])
def test_the_idle_window_setting(monkeypatch, raw, window):
    from hive.core.free_inference import FREE_IDLE_WINDOW_S, idle_window
    if raw is not None:
        monkeypatch.setenv("HIVE_FREE_INFERENCE_IDLE_WINDOW_S", raw)
    assert FREE_IDLE_WINDOW_S == 1800 and idle_window() == window   # unreadable keeps the guard on, never off


# ---- the deploy's key is never shown ------------------------------------------------------------------------------

def never_shown(text):
    assert DEPLOY_KEY not in text and TAIL not in text


def test_no_view_shows_any_part_of_the_deploys_key(hive_client):
    call(hive_client, free_mind(hive_client))   # it has paid for a call, as it would have on a live hive
    for headers in ({}, hive_client.ann):
        for path in ("/api/providers", f"/api/providers/{FREE}", "/api/models", "/api/keys", "/api/me/setup"):
            response = hive_client.get(path, headers=headers or None)
            if response.status_code == 200:
                never_shown(response.text)
    status = hive_client.get(f"/api/providers/{FREE}").json()
    assert (status["key_hint"], status["keys"], status["account"], status["source"]) == ("", 0, None, None)
    keys = hive_client.get("/api/keys").json()
    assert not [k for k in (keys if isinstance(keys, list) else keys.get("keys", [])) if k.get("provider") == FREE]
    never_shown(hive_client.get("/api/me/mind", headers=hive_client.ann).text)
    never_shown(json.dumps(hive_client.hive.db.all("SELECT * FROM usage")))


def test_nobody_can_store_assign_or_check_a_key_on_the_free_route(hive_client):
    response = hive_client.post("/api/keys", json={"provider": FREE, "key": "invented-person-key-0002"})
    assert response.status_code == 400 and response.json()["error"]["code"] == "no_key_needed"
    agent = free_mind(hive_client)
    response = hive_client.patch(f"/api/agents/{agent['id']}", json={"options": {"key": f"env:{FREE}"}})
    assert response.status_code == 400   # never assignable: it is no key anyone holds
    store = hive_client.hive.providers
    assert store.env_key_view(FREE) is None and asyncio.run(store.account(FREE)) is None
    assert hive_client.upstream.sent == []   # nothing checked it at the endpoint either


@pytest.mark.parametrize("upstream", ["refused", "unreachable"])
def test_a_failed_call_logs_and_answers_without_the_key(hive_client, caplog, upstream):
    caplog.set_level(logging.DEBUG)
    if upstream == "refused":   # an upstream that echoes the key it was sent
        hive_client.upstream.status, hive_client.upstream.answer = 401, {"error": {"message": f"bad key {DEPLOY_KEY}"}}
    else:
        hive_client.upstream.fail = httpx.ConnectError(f"cannot reach {SC}")
    with TestClient(hive_client.app, raise_server_exceptions=False) as quiet:
        response = quiet.post("/llm/v1/chat/completions", headers=agent_headers(free_mind(hive_client)),
                              json={"messages": [{"role": "user", "content": "invented question"}]})
    if upstream == "refused":   # the provider's refusal of the deploy's key, in the hive's words, never its body
        assert (response.status_code, response.json()["error"]["code"]) == (401, "free_inference_key_refused")
    assert response.status_code >= 400
    never_shown(response.text)
    for record in caplog.records:
        never_shown(record.getMessage())
        never_shown(str(record.args))


def test_no_mind_inherits_the_deploys_key():
    from hive.supervisor.sandbox import mind_environment
    env = mind_environment({"PATH": "/usr/bin", "HIVE_FREE_INFERENCE_KEY": DEPLOY_KEY, "HIVE_FREE_INFERENCE_MODELS": "asi1-mini",
                            "OMEGACLAW_FREE_INFERENCE_KEY": DEPLOY_KEY}, {})
    never_shown(json.dumps(env))   # a mind gets an allowlisted environment, so a mind never reads the key either


def test_the_redactor_knows_the_deploys_key(hive_client):
    from hive.core.redact import REDACTOR
    assert REDACTOR.holds(DEPLOY_KEY)   # scrubbed from logs and errors wherever the hive scrubs (redact.enable)


# ---- ASI Cloud with a person's own key ----------------------------------------------------------------------------

@pytest.mark.parametrize("status,ok", [(200, True), (401, False)])
def test_an_asi_cloud_key_is_checked_against_its_model_list(status, ok, tmp_path):
    upstream = Upstream(answer={"object": "list", "data": [{"id": "asi1-mini"}]}, status=status)
    settings = load_settings(data_dir=tmp_path, admin_password="pw", petta_path=PETTA)
    store = ProviderStore(settings, client=httpx.AsyncClient(transport=upstream))
    if ok:
        assert asyncio.run(store.verify("asicloud", "invented-asi-key-0003")) == {"label": "ASI Cloud key"}
    else:
        with pytest.raises(ProviderError) as refusal:
            asyncio.run(store.verify("asicloud", "invented-asi-key-0003"))
        assert refusal.value.code == "bad_key"
    (sent,) = upstream.sent
    assert str(sent.url) == f"{ASI}/models" and sent.headers["authorization"] == "Bearer invented-asi-key-0003"


@pytest.mark.parametrize("hive_client", [{"key": None}], indirect=True)
def test_a_mind_on_asi_cloud_answers_on_the_hives_asi_key(hive_client, monkeypatch):
    monkeypatch.setenv("ASI_API_KEY", "invented-hive-asi-key-0004")
    hive_client.post("/api/budgets", json={"scope": "hive", "period": "month", "limit_usd": 5})
    swarm, (agent,) = make_swarm_and_agents(hive_client, n=1, model="asicloud/asi1-mini")
    hive_client.hive.db.execute("UPDATE agents SET budget_usd = 1 WHERE id = ?", (agent["id"],))
    response = call(hive_client, agent)
    assert response.status_code == 200, response.text
    (sent,) = hive_client.upstream.sent
    assert sent.headers["authorization"] == "Bearer invented-hive-asi-key-0004"
    assert json.loads(sent.content)["model"] == "asi1-mini" and str(sent.url) == f"{ASI}/chat/completions"
