"""OmegaReview's 2026-10-04 deploy review, findings inverted: each defect it reproduced must now be impossible.
Source of the reproductions: omegareview/tests/test_platform_deploy_adversarial.py."""
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_app_seams import PROGRAM, install, review, finding


def test_read_only_validator_cannot_create_a_goal(client, tmp_path, monkeypatch):
    program = PROGRAM.replace('    SEEN.append(', '    await ctx.create_goal("READ_ONLY_SIDE_EFFECT")\n    SEEN.append(')
    install(client, tmp_path, monkeypatch, program)
    hive = client.app.state.hive
    hive.programs._ready("seamapp")["capabilities"] = ["goals:write"]
    rq, reviewer = review(client)
    response = finding(client, rq, reviewer, {"whole": True})
    assert hive.db.one("SELECT id FROM goals WHERE title = ?", ("READ_ONLY_SIDE_EFFECT",)) is None
    assert response.status_code != 200 or response.json().get("error")      # the write was refused, not ignored


def test_read_only_context_refuses_every_write_capability(client):
    from hive.core.programs import ProgramContext
    hive = client.app.state.hive
    sw = client.post("/api/swarms", json={"name": "RO"}).json()
    ctx = ProgramContext(hive, sw["id"], {"id": "x", "capabilities": list(ProgramContext.WRITE_CAPABILITIES)})
    ctx.read_only = True
    for capability in ProgramContext.WRITE_CAPABILITIES:
        try:
            ctx._need(capability)
            raise AssertionError(f"{capability} allowed in a read-only context")
        except Exception as exc:
            assert getattr(exc, "code", None) == "read_only" or "read-only" in str(exc)


def test_finding_refused_when_request_cancelled_during_validation(client, tmp_path, monkeypatch):
    install(client, tmp_path, monkeypatch)
    rq, reviewer = review(client)
    hive = client.app.state.hive
    original = hive.programs.validate_finding_target

    async def interleaved(*args):
        owner = hive.db.one("SELECT * FROM agents WHERE swarm_id = ?", (rq["from_swarm"],))
        await hive.collab.agent_cancel(owner, rq["id"])
        return await original(*args)
    monkeypatch.setattr(hive.programs, "validate_finding_target", interleaved)
    response = finding(client, rq, reviewer, {"whole": True})
    assert response.status_code == 403, response.text
    assert hive.db.one("SELECT id FROM findings WHERE request_id = ?", (rq["id"],)) is None


def test_estimate_counts_every_billable_input_and_refuses_multiple_outputs(client):
    from hive.tests.test_cost_reservations import _mind, _gateway
    from hive.core.gateway import GatewayError
    agent = _mind(client, 0.01)
    gw = _gateway(client)
    base = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 100}
    tools = dict(base, tools=[{"type": "function", "function": {"name": "large", "description": "paid input " * 10000,
                                                                 "parameters": {"type": "object"}}}])
    assert gw.estimate(agent, tools)[1] > gw.estimate(agent, base)[1] * 50      # tool definitions are billable
    assert gw.estimate(agent, tools)[1] > 0.01                                 # and push it over the small cap
    schema = dict(base, response_format={"type": "json_schema", "json_schema": {"schema": {"description": "x" * 50000}}})
    assert gw.estimate(agent, schema)[1] > gw.estimate(agent, base)[1] * 50
    for field in ({"n": 10}, {"best_of": 3}):
        try:
            gw.estimate(agent, dict(base, **field))
            raise AssertionError(f"{field} accepted")
        except GatewayError as exc:
            assert exc.code == "unsupported_field"
    assert gw.estimate(agent, dict(base, n=1))[0] is True                      # n=1 is fine


def test_a_request_that_fits_by_messages_but_not_in_full_is_refused_before_dispatch(client):
    from hive.tests.test_cost_reservations import _mind, _gateway, _fake_chat
    from hive.tests.test_core_api import agent_headers
    agent = _mind(client, 0.01)
    called = []
    gw = _gateway(client)
    _fake_chat(gw)
    original = gw.chat

    async def counting(a, b):
        called.append(1)
        return await original(a, b)
    gw.chat = counting
    body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 10,
            "tools": [{"type": "function", "function": {"name": "big", "description": "x" * 200000, "parameters": {"type": "object"}}}]}
    r = client.post("/llm/v1/chat/completions", json=body, headers=agent_headers(agent))
    assert r.status_code == 402 and called == []                               # refused before any provider call


def test_multimodal_or_external_content_is_refused_before_paid_dispatch(client):
    """OmegaReview residual: a short image_url does not bound its cost."""
    from hive.tests.test_cost_reservations import _mind, _gateway
    from hive.core.gateway import GatewayError
    agent = _mind(client, 0.01)
    gw = _gateway(client)
    for body in ({"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x/y.png"}}]}]},
                 {"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "input_audio"}]}]},
                 {"messages": [{"role": "user", "content": "hi"}], "modalities": ["audio"]}):
        try:
            gw.estimate(agent, body)
            raise AssertionError(f"accepted {body}")
        except GatewayError as exc:
            assert exc.code == "unsupported_content"
    assert gw.estimate(agent, {"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]})[0] is True


def test_duplicate_put_cannot_send_a_local_only_asset_off_the_machine(client):
    """OmegaReview (Integration): effective local-only = stored OR new, checked before any remote write."""
    hive = client.app.state.hive

    class FakeRemote:
        kind = "s3"
        def __init__(self): self.writes = []
        def put(self, digest, data): self.writes.append(digest)
        def get(self, digest): return None
        def has(self, digest): return False
        def delete(self, digest): pass

    remote = FakeRemote()
    hive.assets.stores["cloud"] = remote
    try:
        hive.assets.put(b"secret bytes", mime="text/plain", by="t", name="s", local_only=True)
        try:
            hive.assets.put(b"secret bytes", mime="text/plain", by="t", name="s", store="cloud")
            raise AssertionError("remote duplicate of a local-only asset accepted")
        except Exception as exc:
            assert getattr(exc, "code", "") == "local_only", exc
        assert remote.writes == []                         # nothing reached the remote store
    finally:
        hive.assets.stores.pop("cloud", None)


def test_a_racing_remote_put_cannot_slip_past_a_local_only_put_in_flight(client):
    """Kimi 2026-10-04: check-then-put TOCTOU. A pauses mid-write; B (same bytes, remote) must wait, then be refused."""
    import threading
    hive = client.app.state.hive
    local = hive.assets.stores["local"]
    gate, entered = threading.Event(), threading.Event()
    real_put = local.put

    def slow_put(digest, data):
        entered.set()
        gate.wait(5)
        real_put(digest, data)

    class FakeRemote:
        kind = "s3"
        def __init__(self): self.writes = []
        def put(self, digest, data): self.writes.append(digest)
        def get(self, digest): return None
        def has(self, digest): return False
        def delete(self, digest): pass

    remote = FakeRemote()
    hive.assets.stores["cloud"] = remote
    local.put = slow_put
    outcome = {}
    try:
        a = threading.Thread(target=lambda: hive.assets.put(b"race bytes", mime="text/plain", by="a", local_only=True))
        a.start()
        assert entered.wait(5)

        def b():
            try:
                hive.assets.put(b"race bytes", mime="text/plain", by="b", store="cloud")
                outcome["b"] = "accepted"
            except Exception as exc:
                outcome["b"] = getattr(exc, "code", repr(exc))
        tb = threading.Thread(target=b)
        tb.start()
        tb.join(0.5)                                       # B must be held while A is mid-write
        gate.set()
        a.join(5); tb.join(5)
        assert outcome.get("b") == "local_only", outcome
        assert remote.writes == []
    finally:
        local.put = real_put
        hive.assets.stores.pop("cloud", None)


def test_responses_style_input_media_is_refused_before_paid_dispatch(client):
    """Kimi 2026-10-04: `input` is forwarded verbatim, so it obeys the text-only rule."""
    from hive.tests.test_cost_reservations import _mind, _gateway
    from hive.core.gateway import GatewayError
    agent = _mind(client, 0.01)
    gw = _gateway(client)
    for body in ({"input": [{"type": "input_image", "image_url": "https://x/y.png"}]},
                 {"input": [{"role": "user", "content": [{"type": "input_image", "image_url": "https://x/y.png"}]}]},
                 {"messages": [{"role": "user", "content": {"type": "image_url"}}]}):
        try:
            gw.estimate(agent, body)
            raise AssertionError(f"accepted {body}")
        except GatewayError as exc:
            assert exc.code == "unsupported_content"
    assert gw.estimate(agent, {"input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]})[0] is True
