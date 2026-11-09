"""P1 media route (hive/core/media.py): one metered image route behind HIVE_MEDIA_ROUTE=on.

Mock vendor only (httpx.MockTransport on the gateway's client): no provider is ever called. Synthetic data, in-process
hive, disposable data directories."""
import asyncio
import base64
import copy
import dataclasses
import json
import logging
import pathlib
import struct
import tempfile
import zlib

import httpx
import pytest
from fastapi.testclient import TestClient

from hive.core.app import create_app
from hive.core.config import load_settings
from hive.core.cost_reservations import Reservations
from hive.core.media import MediaRoute, image_info
from hive.tests.test_core_api import PETTA, FakeSupervisor, agent_headers, client, make_swarm_and_agents  # noqa: F401

SECRET = "sk-or-TEST-SECRET-never-shown-0123456789"
MIND_MODEL = "openrouter/anthropic/claude-sonnet-5.5"
ENDPOINT = {
    "provider_name": "Mock Seed", "provider_slug": "mock-seed", "provider_tag": None,
    "supported_parameters": {"size": {"type": "enum", "values": ["64x64", "64x32"]},
                             "quality": {"type": "enum", "values": ["low", "high"]},
                             "output_format": {"type": "enum", "values": ["png", "jpeg"]},
                             "input_references": {"type": "range", "min": 0, "max": 2},
                             "n": {"type": "range", "min": 1, "max": 10}},
    "allowed_passthrough_parameters": [], "supports_streaming": False,
    "pricing": [{"billable": "output_image", "unit": "image", "cost_usd": 0.04},
                {"billable": "input_reference", "unit": "image", "cost_usd": 0}],   # a documented free unit is a known price
}
PIN = {"model": "mock-author/mock-image", "endpoint": ENDPOINT,
       "geometry": {"64x64": {"width": 64, "height": 64, "controls": {"size": "64x64"}}},
       "quality": ["high"], "max_references": 1, "max_output_bytes": 200_000, "timeout_seconds": 5}


def png(w=64, h=64):
    raw = b"".join(b"\x00" + b"\x7f" * (3 * w) for _ in range(h))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def corrupt_png(w=64, h=64):
    """A well-formed chunk structure (valid CRCs) whose compressed pixel data is garbage."""
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", b"\x78\x9c" + bytes(range(256)) * 4) + chunk(b"IEND", b""))


BROKEN = {"corrupted": corrupt_png(), "truncated": png()[: len(png()) // 2], "header_only": png()[:33]}


class Vendor:
    """A mock POST /images: records every request and answers as told."""

    def __init__(self):
        self.posts, self.delay, self.status = [], 0.0, 200
        self.image, self.cost, self.count, self.raw = png(), 0.035, 1, None

    async def __call__(self, request):
        self.posts.append({"url": str(request.url), "auth": request.headers.get("authorization"),
                           "body": json.loads(request.content)})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.raw is not None:
            return httpx.Response(self.status, content=self.raw)
        usage = {"prompt_tokens": 0, "completion_tokens": 4175, "total_tokens": 4175}
        if self.cost is not None:
            usage["cost"] = self.cost
        data = [{"b64_json": base64.b64encode(self.image).decode()} for _ in range(self.count)]
        return httpx.Response(self.status, json={"created": 1748372400, "data": data, "usage": usage})


def _app(media_route=True, pin=PIN):
    settings = load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-media-")), admin_password="pw",
                             petta_path=PETTA, media_route=media_route, offline=True)
    settings.providers = dict(settings.providers)
    settings.providers["openrouter"] = dataclasses.replace(settings.providers["openrouter"], media={
        "image.generate": copy.deepcopy(pin), "image.generate-quality": copy.deepcopy(pin)} if pin else {})
    return create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)


@pytest.fixture
def m():
    app = _app()
    with TestClient(app) as c:
        token = c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        c.headers["Authorization"] = f"Bearer {token}"
        app.state.gateway.providers["openrouter"].stored_key = SECRET      # set after the keyring applied its defaults
        c.vendor = Vendor()
        app.state.gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(c.vendor), trust_env=False)
        c.hive = app.state.hive
        yield c


def _mind(c, budget=1.0, allow=True):
    swarm, (a,) = make_swarm_and_agents(c, n=1, model=MIND_MODEL, budget_usd=budget)
    if allow:                                  # r2: the host allowlist names the minds that may use each op
        if getattr(c.hive.settings, "media_allow", None) is None:
            c.hive.settings.media_allow = {}   # (a pre-r2 Settings, for the fail-before run)
        for op in ("image.generate", "image.generate-quality"):
            c.hive.settings.media_allow.setdefault(op, []).append(f"agent:{a['id']}")
    return swarm, a


def _req(op_id="op-0001-abcdef", **extra):
    return {"op": "image.generate", "operation_id": op_id, "prompt": "a quiet garden at dusk", **extra}


def _pin(c, **changes):
    c.hive.settings.providers["openrouter"].media["image.generate"].update(copy.deepcopy(changes))


def _states(c):
    return [r["state"] for r in c.hive.db.all("SELECT state FROM cost_reservations ORDER BY rowid")]


# ---- happy path ----------------------------------------------------------------------------------------------------

def test_one_image_is_reserved_settled_and_stored_in_the_tasks_swarm(m):
    swarm, a = _mind(m)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["state"] == "settled" and out["billing"]["actual_usd"] == 0.035 and out["billing"]["held_usd"] == 0.04
    assert out["billing"]["origin"] == "provider-usage-cost"
    assert out["resolved_model"] == "UNKNOWN" and out["response_id"] == "UNKNOWN"          # the Image API returns neither
    assert out["asset"]["width"] == 64 and out["asset"]["mime"] == "image/png" and out["asset"]["owner_swarm"] == swarm["id"]
    # the wire: dedicated /images, pinned upstream with no fallback, png, one output, no response_format, key injected
    (post,) = m.vendor.posts
    assert post["url"] == "https://openrouter.ai/api/v1/images" and post["auth"] == f"Bearer {SECRET}"
    assert post["body"] == {"model": "mock-author/mock-image", "prompt": "a quiet garden at dusk", "n": 1, "size": "64x64",
                            "quality": "high", "output_format": "png",
                            "provider": {"only": ["mock-seed"], "allow_fallbacks": False}}
    # native custody: the mind reads its own swarm's asset back; usage is metered on the media model
    got = m.get(f"/api/agent/assets/{out['asset']['sha256']}", headers=agent_headers(a))
    assert got.status_code == 200 and got.content == m.vendor.image
    (usage,) = m.hive.db.all("SELECT * FROM usage")
    assert usage["model"] == "openrouter/mock-author/mock-image" and usage["cost_usd"] == 0.035 and usage["resolved_model"] is None
    assert m.hive.agent(a["id"])["spent_usd"] == pytest.approx(0.035)
    assert _states(m) == ["settled"]


def test_a_reference_is_sent_as_a_data_url_and_must_be_readable(m):
    _, a = _mind(m)
    ref = m.post("/api/agent/assets", content=png(), headers={**agent_headers(a), "content-type": "image/png"}).json()
    r = m.post("/llm/v1/media", json=_req(references=[{"sha256": ref["sha256"]}]), headers=agent_headers(a))
    assert r.status_code == 200, r.text
    (sent,) = m.vendor.posts[0]["body"]["input_references"]
    assert sent == {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png()).decode()}}
    # another swarm's asset is not a reference for this mind, and no reservation or call happens
    _, b = _mind(m)
    r = m.post("/llm/v1/media", json=_req("op-other-0001", references=[{"sha256": ref["sha256"]}]), headers=agent_headers(b))
    assert r.status_code == 404 and len(m.vendor.posts) == 1


# ---- prices are proven before dispatch ---------------------------------------------------------------------------

@pytest.mark.parametrize("line", [
    {"billable": "output_image", "unit": "second", "cost_usd": 0.01},          # unknown unit
    {"billable": "output_video", "unit": "image", "cost_usd": 0.01},           # unknown billable
    {"billable": "output_image", "unit": "token", "cost_usd": 0.00003},        # no documented image-token ceiling
])
def test_an_unknown_or_unboundable_unit_is_refused_before_dispatch(m, line):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "pricing": ENDPOINT["pricing"] + [line]})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 422 and r.json()["error"]["code"] == "media_unpriced"
    assert m.vendor.posts == [] and _states(m) == []


@pytest.mark.parametrize("cost", [float("inf"), float("nan"), -0.01, "0.04", None, True])
def test_a_non_finite_negative_or_missing_price_is_refused(m, cost):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "pricing": [{"billable": "output_image", "unit": "image", "cost_usd": cost}]})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 422 and r.json()["error"]["code"] == "media_unpriced"
    assert m.vendor.posts == [] and _states(m) == []


@pytest.mark.parametrize("billable", ["input_font", "input_image", "input_reference", "output_image"])
def test_token_pricing_is_refused_for_everything_but_text(m, billable):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "pricing": ENDPOINT["pricing"] + [{"billable": billable, "unit": "token", "cost_usd": 0.00001}]})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 422 and r.json()["error"]["code"] == "media_unpriced"
    assert m.vendor.posts == [] and _states(m) == []


def test_an_all_zero_schedule_is_refused_but_a_zero_line_beside_a_paid_one_is_not(m):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "pricing": [{"billable": "input_reference", "unit": "image", "cost_usd": 0}]})
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 422
    _pin(m, endpoint=ENDPOINT)          # the paid output line plus the documented free input line
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200


def test_megapixel_and_text_token_lines_bound_the_worst_case(m):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "pricing": [{"billable": "output_image", "unit": "megapixel", "cost_usd": 0.03},
                                              {"billable": "input_text", "unit": "token", "cost_usd": 0.00001},
                                              {"billable": "output_image", "unit": "image", "cost_usd": 0.5, "variant": "4K"}]},
         geometry={"64x64": {"width": 64, "height": 64, "controls": {"size": "64x64"}, "variant": "1K"}})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    prompt_bytes = len("a quiet garden at dusk".encode())
    # every line counts: a variant label never excludes a price (r2)
    assert r.json()["billing"]["held_usd"] == pytest.approx(0.03 + (prompt_bytes + 1) * 0.00001 + 0.5)


def test_a_4k_dispatch_reserves_the_4k_price_whatever_variant_the_operator_labels(m):
    _, a = _mind(m)
    endpoint = {**ENDPOINT, "supported_parameters": {**ENDPOINT["supported_parameters"],
                                                     "resolution": {"type": "enum", "values": ["1K", "4K"]}},
                "pricing": [{"billable": "output_image", "unit": "image", "cost_usd": 0.05, "variant": "1K"},
                            {"billable": "output_image", "unit": "image", "cost_usd": 0.5, "variant": "4K"}]}
    _pin(m, endpoint=endpoint, geometry={"4K": {"width": 64, "height": 64, "controls": {"resolution": "4K"}, "variant": "1K"}})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 200, r.text
    assert m.vendor.posts[0]["body"]["resolution"] == "4K"
    assert r.json()["billing"]["held_usd"] >= 0.5 and r.json()["billing"]["held_usd"] == pytest.approx(0.55)


def test_an_unsupported_control_in_the_pin_is_refused(m):
    _, a = _mind(m)
    _pin(m, geometry={"2K": {"width": 2048, "height": 2048, "controls": {"resolution": "2K"}}})   # endpoint has no resolution
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_pin_invalid" and m.vendor.posts == []


# ---- one operation, one vendor call ---------------------------------------------------------------------------------

@pytest.mark.parametrize("w,h,pin", [
    (8193, 1, {}),                                                   # wider than the 4096 default
    (1, 4097, {}),                                                   # taller than the default
    (0, 64, {}),                                                     # empty
    (64, 64, {"max_reference_pixels": 4095}),                        # over an operator-pinned pixel cap
    (64, 64, {"max_reference_width": 63}),
])
def test_reference_dimensions_are_capped_before_reservation(m, w, h, pin):
    _, a = _mind(m)
    if pin:
        _pin(m, **pin)
    header = png(1, 1)[:16] + struct.pack(">II", w, h) + png(1, 1)[24:]   # a tiny file claiming these dimensions
    ref = m.post("/api/agent/assets", content=header, headers={**agent_headers(a), "content-type": "image/png"}).json()
    r = m.post("/llm/v1/media", json=_req(references=[{"sha256": ref["sha256"]}]), headers=agent_headers(a))
    assert r.status_code == 413 and r.json()["error"]["code"] == "reference_dimensions"
    assert m.vendor.posts == [] and _states(m) == []


def test_a_repeated_operation_id_replays_without_a_second_vendor_call(m):
    _, a = _mind(m)
    first = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).json()
    again = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert again.status_code == 200 and again.json()["replay"] is True and again.json()["asset"] == first["asset"]
    assert len(m.vendor.posts) == 1 and len(m.hive.db.all("SELECT * FROM usage")) == 1     # one settlement, once
    changed = m.post("/llm/v1/media", json=_req(prompt="something else"), headers=agent_headers(a))
    assert changed.status_code == 409 and changed.json()["error"]["code"] == "operation_conflict"
    assert len(m.vendor.posts) == 1
    # the billing identity is the mind's own (agent, op, operation_id): another mind's same id is its own operation
    _, b = _mind(m)
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(b)).status_code == 200 and len(m.vendor.posts) == 2


def test_a_retry_without_an_id_reuses_the_derived_operation(m):
    _, a = _mind(m, budget=0.07)
    _pin(m, timeout_seconds=1)
    m.vendor.delay = 3
    plain = {"op": "image.generate", "prompt": "a quiet garden at dusk"}
    r = m.post("/llm/v1/media", json=plain, headers=agent_headers(a))
    assert r.status_code == 504 and len(m.vendor.posts) == 1
    m.vendor.delay = 0
    # the same request again (whitespace normalized), as a skill retry or after a restart: one vendor call, still held
    again = m.post("/llm/v1/media", json={**plain, "prompt": "  a quiet garden at dusk \n"}, headers=agent_headers(a))
    assert again.status_code == 409 and again.json()["error"]["code"] == "outcome_unknown" and len(m.vendor.posts) == 1
    assert again.json()["error"]["reservation"] == r.json()["error"]["reservation"]
    assert _states(m) == ["unknown"]


def test_the_derived_id_binds_mind_task_op_and_request():
    base = MediaRoute.derive("a_1", "g_1", "image.generate", "p", "64x64", None, [])
    assert base == MediaRoute.derive("a_1", "g_1", "image.generate", "p", "64x64", None, None) and base.startswith("auto-")
    others = {MediaRoute.derive("a_2", "g_1", "image.generate", "p", "64x64", None, []),
              MediaRoute.derive("a_1", "g_2", "image.generate", "p", "64x64", None, []),
              MediaRoute.derive("a_1", None, "image.generate", "p", "64x64", None, []),
              MediaRoute.derive("a_1", "g_1", "image.generate-quality", "p", "64x64", None, []),
              MediaRoute.derive("a_1", "g_1", "image.generate", "q", "64x64", None, []),
              MediaRoute.derive("a_1", "g_1", "image.generate", "p", "64x64", "high", []),
              MediaRoute.derive("a_1", "g_1", "image.generate", "p", "64x64", None, [{"sha256": "ab" * 32}])}
    assert base not in others and len(others) == 7


def test_concurrent_requests_for_one_operation_make_one_vendor_call(m):
    _, a = _mind(m)
    m.vendor.delay = 0.2

    async def both():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url="http://t") as c:
            return await asyncio.gather(*[c.post("/llm/v1/media", json=_req(), headers=agent_headers(a)) for _ in range(3)])
    codes = sorted(r.status_code for r in asyncio.run(both()))
    assert codes == [200, 409, 409] and len(m.vendor.posts) == 1


def test_caps_hold_under_concurrency(m):
    _, a = _mind(m, budget=0.07)          # room for one $0.04 worst case, not two
    m.vendor.delay = 0.2

    async def two():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=m.app), base_url="http://t") as c:
            return await asyncio.gather(*[c.post("/llm/v1/media", json=_req(f"op-cap-{i:06d}"), headers=agent_headers(a))
                                          for i in range(2)])
    codes = sorted(r.status_code for r in asyncio.run(two()))
    assert codes == [200, 402] and len(m.vendor.posts) == 1
    assert m.hive.agent(a["id"])["spent_usd"] <= 0.07


def test_an_exhausted_cap_is_refused_before_dispatch(m):
    _, a = _mind(m, budget=0.03)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 402 and m.vendor.posts == []


# ---- unknown outcomes are held, never retried ----------------------------------------------------------------------

def test_a_vendor_timeout_is_unknown_held_and_never_retried(m):
    _, a = _mind(m, budget=0.07)
    _pin(m, timeout_seconds=1)
    m.vendor.delay = 3
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 504 and r.json()["error"]["code"] == "outcome_unknown"
    rid = r.json()["error"]["reservation"]
    assert _states(m) == ["unknown"] and len(m.vendor.posts) == 1
    m.vendor.delay = 0
    again = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert again.status_code == 409 and again.json()["error"]["code"] == "outcome_unknown" and len(m.vendor.posts) == 1
    # the held worst case still counts against the cap: a new operation cannot spend it
    assert m.post("/llm/v1/media", json=_req("op-next-000001"), headers=agent_headers(a)).status_code == 402
    # a person resolves it with the vendor's own billing evidence; the replay then says billed, no image, still no call
    done = m.post(f"/api/budgets/reservations/{rid}/resolve",
                  json={"action": "settle", "actual_usd": 0.04, "reason": "provider activity shows $0.04"})
    assert done.status_code == 200 and done.json()["state"] == "settled"
    assert m.hive.db.one("SELECT cost_usd FROM usage")["cost_usd"] == 0.04
    final = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert final.status_code == 409 and final.json()["error"]["code"] == "output_refused" and len(m.vendor.posts) == 1


@pytest.mark.parametrize("raw", [
    json.dumps({"created": 1, "data": [{"b64_json": base64.b64encode(png()).decode()}]}),                       # no usage
    json.dumps({"created": 1, "data": [{"b64_json": base64.b64encode(png()).decode()}], "usage": {"cost": -1}}),
    '{"created": 1, "data": [], "usage": {"cost": NaN}}',
])
def test_missing_negative_or_non_finite_cost_is_held_not_zero(m, raw):
    _, a = _mind(m)
    m.vendor.raw = raw
    m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert _states(m) == ["unknown"] and m.hive.db.all("SELECT * FROM usage") == []


def test_a_vendor_error_is_held_unknown_not_zero(m):
    _, a = _mind(m)
    m.vendor.status, m.vendor.raw = 500, '{"error": {"message": "upstream busy"}}'
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["code"] == "outcome_unknown" and _states(m) == ["unknown"]


def test_a_cost_above_the_hold_is_settled_and_flagged(m):
    _, a = _mind(m)
    m.vendor.cost = 0.5
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200
    (over,) = m.get("/api/budgets/overruns").json()
    assert over["maximum"] == 40_000 and over["actual"] == 500_000


def test_a_restart_mid_call_leaves_it_unknown_and_the_retry_makes_no_call(m, monkeypatch):
    _, a = _mind(m)
    # the process dies with the vendor's answer unread: nothing after dispatch runs (no settle, no hold)
    monkeypatch.setattr(MediaRoute, "_finish", lambda self, *args: {"process": "died"})
    m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert _states(m) == ["dispatched"]
    with m.hive.db.transaction():
        Reservations.recover_startup(m.hive.db)                              # the startup recovery of the next process
    monkeypatch.undo()
    assert _states(m) == ["unknown"]
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 409 and r.json()["error"]["code"] == "outcome_unknown" and len(m.vendor.posts) == 1


# ---- billing and the asset are separate outcomes --------------------------------------------------------------------

@pytest.mark.parametrize("change,code", [
    ({"image": png(64, 32)}, "output_dimensions"),
    ({"count": 2}, "output_count"),
    ({"image": b"GIF89a" + b"\x00" * 64}, "output_not_image"),
])
def test_wrong_output_is_refused_but_still_billed(m, change, code):
    _, a = _mind(m)
    for k, v in change.items():
        setattr(m.vendor, k, v)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["code"] == "output_refused" and r.json()["error"]["refusal"] == code
    assert r.json()["error"]["state"] == "settled" and r.json()["error"]["asset"] is None
    assert r.json()["error"]["billing"]["state"] == "billed_refused" and r.json()["error"]["outcome"] == "billed_refused"
    assert m.hive.db.all("SELECT * FROM assets") == [] and len(m.hive.db.all("SELECT * FROM usage")) == 1


def test_oversize_output_is_refused(m):
    _, a = _mind(m)
    _pin(m, max_output_bytes=100)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["refusal"] == "output_too_large"
    assert r.json()["error"]["state"] == "settled" and m.hive.db.all("SELECT * FROM assets") == []
    # a response over the read cap cannot be read for billing either: held unknown
    _pin(m, max_response_bytes=100, max_output_bytes=200_000)
    r = m.post("/llm/v1/media", json=_req("op-big-000001"), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["code"] == "outcome_unknown" and _states(m)[-1] == "unknown"


# ---- the switches ---------------------------------------------------------------------------------------------------

def test_a_per_mind_deny_rule_stops_it(m):
    _, a = _mind(m)
    rule = m.post("/api/policy", json={"scope": f"agent:{a['id']}", "skill": "generate-image", "mode": "deny", "note": "off"})
    assert rule.status_code == 200
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 403 and r.json()["error"]["code"] == "policy_denied"
    assert m.vendor.posts == [] and _states(m) == []
    # the quality tier has its own skill name and its own switch
    q = m.post("/llm/v1/media", json=_req(op="image.generate-quality"), headers=agent_headers(a))
    assert q.status_code == 200 and len(m.vendor.posts) == 1


@pytest.mark.parametrize("built_ui", [False, True])
def test_switch_off_the_route_is_absent(built_ui, monkeypatch, tmp_path):
    """Absent means 404 whether or not a UI build (hive/ui/dist) is present. With one, the UI's GET catch-all used to
    answer an unknown POST under /llm/v1 with 405 (MesTTo, 870dea4). Methods a real route serves keep their 405, and a
    POST to a UI page is still 405."""
    from hive.core import app as app_module
    dist = tmp_path / "dist"
    if built_ui:
        dist.mkdir()
        (dist / "index.html").write_text("synthetic UI")
    monkeypatch.setattr(app_module, "UI_DIST", dist)
    settings = load_settings(data_dir=tmp_path / "data", admin_password="pw", petta_path=PETTA)
    with TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)) as c:
        c.headers["Authorization"] = "Bearer " + c.post("/api/auth/login", json={"password": "pw"}).json()["token"]
        _, (a,) = make_swarm_and_agents(c, n=1, model=MIND_MODEL, budget_usd=1.0)
        assert c.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 404
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            assert c.request(method, "/llm/v1/media").status_code == 404, method
            assert c.request(method, "/api/no-such-route").status_code == 404, method
        assert c.post("/api/health").status_code == 405                       # a GET-only route keeps its 405
        if built_ui:
            assert c.get("/some/page").status_code == 200 and c.post("/some/page").status_code == 405


def test_inspection_stays_closed(m):
    _, a = _mind(m)
    r = m.post("/llm/v1/media", json=_req(op="image.inspect"), headers=agent_headers(a))
    assert r.status_code == 501 and r.json()["error"]["code"] == "op_closed" and m.vendor.posts == []


def test_an_unpinned_op_is_unavailable(m):
    _, a = _mind(m)
    m.hive.settings.providers["openrouter"].media.pop("image.generate-quality")
    r = m.post("/llm/v1/media", json=_req(op="image.generate-quality"), headers=agent_headers(a))
    assert r.status_code == 404 and r.json()["error"]["code"] == "op_unavailable"


def test_a_session_ending_during_admission_refuses_the_call(m, monkeypatch):
    from hive.core.visibility import Viewer
    _, a = _mind(m)
    s = m.post("/api/sessions", json={"mind": a["id"], "title": "garden", "budget_usd": 0.5}).json()
    original = m.hive.check_budget

    def then_end(*args, **kwargs):          # the close lands after admission checks, before the reservation transaction
        result = original(*args, **kwargs)
        m.hive.sessions.end(Viewer("user:operator", True), s["id"])
        return result
    monkeypatch.setattr(m.hive, "check_budget", then_end)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 409 and r.json()["error"]["code"] == "session_changed"
    assert m.vendor.posts == [] and _states(m) == []


def _named_session(c, agent_id):
    from hive.core.db import now
    c.hive.db.execute("INSERT INTO work_sessions (id, room_id, agent_id, owner, title, status, budget_usd, spent_at_start, created_at) "
                      "VALUES ('se_race', 'rm_race', ?, 'user:u_ann', 'race', 'active', 0.5, 0, ?)", (agent_id, now()))


def test_a_named_session_starting_right_after_payer_selection_gets_no_call(m, monkeypatch):
    _, a = _mind(m)
    original, calls = m.hive.payer_for, []

    def then_start(agent, key_owner=None):   # the r2 ordering: payer chosen, then a named person's session starts
        result = original(agent, key_owner)
        calls.append(result)
        if len(calls) == 1:
            _named_session(m, a["id"])
        return result
    monkeypatch.setattr(m.hive, "payer_for", then_start)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert calls[0] == ("hive", False) and original(m.hive.agent(a["id"]))[0] == "user:u_ann"
    assert r.status_code == 409 and r.json()["error"]["code"] in ("session_changed", "payer_changed")
    assert m.vendor.posts == [] and _states(m) == []


def test_a_payer_change_the_sessions_do_not_show_is_refused(m, monkeypatch):
    _, a = _mind(m)
    original, calls = m.hive.payer_for, []

    def flips(agent, key_owner=None):        # e.g. an Ask turn opening: the payer moves while the sessions stay the same
        calls.append(1)
        return original(agent, key_owner) if len(calls) == 1 else ("user:u_ann", False)
    monkeypatch.setattr(m.hive, "payer_for", flips)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 409 and r.json()["error"]["code"] == "payer_changed"
    assert m.vendor.posts == [] and _states(m) == []


def test_a_session_cannot_end_while_its_call_is_dispatched(m):
    from hive.core.hive import HiveError
    from hive.core.visibility import Viewer
    _, a = _mind(m)
    s = m.post("/api/sessions", json={"mind": a["id"], "title": "garden", "budget_usd": 0.5}).json()
    seen, vendor = [], m.vendor

    async def ending_mid_call(request):     # the close lands while the reservation is dispatched
        try:
            m.hive.sessions.end(Viewer("user:operator", True), s["id"])
            seen.append("ended")
        except HiveError as exc:
            seen.append(exc.code)
        return await vendor(request)
    m.app.state.gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(ending_mid_call), trust_env=False)
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200
    assert seen == ["liabilities_open"] and len(vendor.posts) == 1
    assert m.post(f"/api/sessions/{s['id']}/end").status_code == 200        # settled: now it may end


def test_a_session_cannot_end_while_its_mind_runs(m):
    _, a = _mind(m)
    s = m.post("/api/sessions", json={"mind": a["id"], "title": "garden", "budget_usd": 0.5}).json()
    m.post(f"/api/agents/{a['id']}/start")
    r = m.post(f"/api/sessions/{s['id']}/end")
    assert r.status_code == 409 and r.json()["error"]["code"] == "mind_running"
    m.post(f"/api/agents/{a['id']}/stop")
    assert m.post(f"/api/sessions/{s['id']}/end").status_code == 200


def test_session_end_waits_for_open_liabilities(m):
    _, a = _mind(m, budget=0.07)
    s = m.post("/api/sessions", json={"mind": a["id"], "title": "garden", "budget_usd": 0.07}).json()
    _pin(m, timeout_seconds=1)
    m.vendor.delay = 3
    rid = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).json()["error"]["reservation"]
    r = m.post(f"/api/sessions/{s['id']}/end")
    assert r.status_code == 409 and r.json()["error"]["code"] == "liabilities_open" and r.json()["error"]["reservations"] == [rid]
    m.post(f"/api/budgets/reservations/{rid}/resolve", json={"action": "release", "reason": "provider shows no charge"})
    assert m.post(f"/api/sessions/{s['id']}/end").status_code == 200


# ---- no secret anywhere ---------------------------------------------------------------------------------------------

def test_no_secret_in_logs_responses_or_records(m, caplog, capsys):
    caplog.set_level(logging.DEBUG)
    _, a = _mind(m, budget=1.0)
    texts = [m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).text,
             m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).text]
    m.vendor.status, m.vendor.raw = 401, json.dumps({"error": {"message": "bad key"}})
    texts.append(m.post("/llm/v1/media", json=_req("op-err-000001"), headers=agent_headers(a)).text)
    m.vendor.status, m.vendor.raw, m.vendor.delay = 200, None, 3
    _pin(m, timeout_seconds=1)
    texts.append(m.post("/llm/v1/media", json=_req("op-slow-00001"), headers=agent_headers(a)).text)
    texts += [m.get("/api/budgets/reservations").text, m.get(f"/api/agents/{a['id']}").text]
    assert all(m.vendor.posts) and all(p["auth"] == f"Bearer {SECRET}" for p in m.vendor.posts)   # it did reach the vendor
    out = capsys.readouterr()
    dump = json.dumps([[dict(r) for r in m.hive.db.all(f"SELECT * FROM {t['name']}")]
                       for t in m.hive.db.all("SELECT name FROM sqlite_master WHERE type='table'")], default=str)
    for text in texts + [caplog.text, out.out, out.err, dump]:
        assert SECRET not in text


def test_image_headers_are_read_without_decoding():
    assert image_info(png(10, 7)) == ("image/png", 10, 7)
    assert image_info(b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x07\x00\x0a" + b"\x00" * 16) == ("image/jpeg", 10, 7)
    assert image_info(b"not an image") is None


def test_the_mind_skill_uses_the_hive_route_and_never_the_vendor(monkeypatch):
    import importlib.util
    import io
    import urllib.request
    path = pathlib.Path(__file__).resolve().parents[2] / "modules" / "media_imagegen" / "src" / "imagegen.py"
    spec = importlib.util.spec_from_file_location("imagegen_under_test", path)
    imagegen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(imagegen)
    monkeypatch.setenv("HIVE_LLM_URL", "http://127.0.0.1:8700/llm/v1")
    monkeypatch.setenv("HIVE_LLM_TOKEN", "mind-token")
    monkeypatch.setenv("XAI_API_KEY", "xai-should-not-be-used")
    seen = []

    def urlopen(req, timeout=None):
        seen.append((req.full_url, req.headers.get("Authorization"), json.loads(req.data)))
        return io.BytesIO(json.dumps({"operation_id": "auto-x", "asset": {"sha256": "ab" * 32, "width": 64, "height": 64}}).encode())
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    out = imagegen.generate_image_quality("a garden")
    assert out == "IMAGE-GENERATED sha256=" + "ab" * 32 + " 64x64 operation=auto-x artifact-ready"
    imagegen.generate_image_quality("a garden")                              # a retry sends the same request: no fresh id
    imagegen.generate_image("op=attempt-0002 a garden")                       # a deliberate new attempt names its id
    imagegen.generate_image("a garden", operation_id="attempt-0003")
    (url, auth, first), (_, _, retry), (_, _, named), (_, _, explicit) = seen
    assert url == "http://127.0.0.1:8700/llm/v1/media" and auth == "Bearer mind-token"
    assert first == retry == {"op": "image.generate-quality", "prompt": "a garden"}
    assert named == {"op": "image.generate", "prompt": "a garden", "operation_id": "attempt-0002"}
    assert explicit == {"op": "image.generate", "prompt": "a garden", "operation_id": "attempt-0003"}


# ---- r6: bounded full decode -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind", sorted(BROKEN))
def test_a_broken_output_is_billed_but_never_stored(m, kind):
    _, a = _mind(m)
    m.vendor.image = BROKEN[kind]
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["code"] == "output_refused"
    assert r.json()["error"]["refusal"] == "output_undecodable" and r.json()["error"]["state"] == "settled"
    assert m.hive.db.all("SELECT * FROM assets") == [] and len(m.hive.db.all("SELECT * FROM usage")) == 1
    again = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))                # replay: no second call
    assert again.status_code == 409 and again.json()["error"]["code"] == "output_refused" and len(m.vendor.posts) == 1


@pytest.mark.parametrize("kind", sorted(BROKEN))
def test_a_broken_reference_is_refused_before_any_spend(m, kind):
    _, a = _mind(m)
    ref = m.post("/api/agent/assets", content=BROKEN[kind], headers={**agent_headers(a), "content-type": "image/png"}).json()
    r = m.post("/llm/v1/media", json=_req(references=[{"sha256": ref["sha256"]}]), headers=agent_headers(a))
    assert r.status_code == 415 and r.json()["error"]["code"] == "reference_undecodable"
    assert m.vendor.posts == [] and _states(m) == []


def test_a_decompression_bomb_is_never_decoded(m, monkeypatch):
    from PIL import Image
    bomb = png(4000, 4000)                                    # 16 MP of one colour: a few KB on the wire
    assert len(bomb) < 200_000
    opened, real_open = [], Image.open
    monkeypatch.setattr(Image, "open", lambda *args, **kw: (opened.append(1), real_open(*args, **kw))[1])
    _, a = _mind(m)
    m.vendor.image = bomb                                     # as an output: over the exact 64x64 geometry
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.json()["error"]["refusal"] == "output_dimensions" and m.hive.db.all("SELECT * FROM assets") == []
    _pin(m, max_reference_pixels=1_000_000)                   # as a reference: over the pinned pixel cap
    ref = m.post("/api/agent/assets", content=bomb, headers={**agent_headers(a), "content-type": "image/png"}).json()
    r = m.post("/llm/v1/media", json=_req("op-bomb-00001", references=[{"sha256": ref["sha256"]}]), headers=agent_headers(a))
    assert r.status_code == 413 and r.json()["error"]["code"] == "reference_dimensions" and len(m.vendor.posts) == 1
    assert opened == []                                       # refused on the capped header: no decoder ever opened it


def test_decoded_dimensions_must_match_the_header(m, monkeypatch):
    import hive.core.media as media
    real = media.image_info
    monkeypatch.setattr(media, "image_info", lambda data: ("image/png", 64, 64) if real(data) == ("image/png", 32, 32) else real(data))
    _, a = _mind(m)
    m.vendor.image = png(32, 32)                              # its header is reported as 64x64; the decoder says 32x32
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.json()["error"]["refusal"] == "output_undecodable" and m.hive.db.all("SELECT * FROM assets") == []
    ref = m.post("/api/agent/assets", content=png(32, 32), headers={**agent_headers(a), "content-type": "image/png"}).json()
    r = m.post("/llm/v1/media", json=_req("op-mism-00001", references=[{"sha256": ref["sha256"]}]), headers=agent_headers(a))
    assert r.status_code == 415 and r.json()["error"]["code"] == "reference_undecodable" and len(m.vendor.posts) == 1


def test_no_decoder_means_nothing_is_spent(m, monkeypatch):
    import hive.core.media as media

    def missing():
        raise ImportError("No module named 'PIL'")
    monkeypatch.setattr(media, "_pillow", missing)
    _, a = _mind(m)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_decoder_unavailable"
    assert m.vendor.posts == [] and _states(m) == []


def test_a_real_jpeg_and_webp_decode_fully():
    import io
    from PIL import Image
    from hive.core.media import Undecodable, decode_image
    for fmt, mime in (("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
        buf = io.BytesIO()
        Image.new("RGB", (40, 30), (200, 10, 10)).save(buf, fmt)
        data = buf.getvalue()
        assert decode_image(data, 64, 64, 4096) == (mime, 40, 30)
        with pytest.raises(Undecodable):
            decode_image(data[: len(data) // 2], 64, 64, 4096)


# ---- r6: n=1 must be documented by the endpoint ---------------------------------------------------------------------

@pytest.mark.parametrize("n_spec", [None, {"type": "range", "min": 2, "max": 4}, {"type": "enum", "values": ["2"]},
                                    {"type": "boolean"}])
def test_an_endpoint_that_does_not_document_n_1_is_refused(m, n_spec):
    _, a = _mind(m)
    supported = {k: v for k, v in ENDPOINT["supported_parameters"].items() if k != "n"}
    if n_spec is not None:
        supported["n"] = n_spec
    _pin(m, endpoint={**ENDPOINT, "supported_parameters": supported})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_pin_invalid" and "n=1" in r.json()["error"]["message"]
    assert m.vendor.posts == [] and _states(m) == []


def test_an_enum_documenting_n_1_is_admitted(m):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "supported_parameters": {**ENDPOINT["supported_parameters"], "n": {"type": "enum", "values": ["1"]}}})
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200


# ---- r7: container completeness, strict range bounds ----------------------------------------------------------------

def _iend_at(data):
    return data.rindex(b"IEND") - 4


def _idat_crc_at(data):
    i = data.index(b"IDAT") - 4
    return i + 12 + struct.unpack(">I", data[i:i + 4])[0] - 4


def _midfile_bad_crc(data):
    at = _idat_crc_at(data)
    return data[:at] + bytes(b ^ 0xFF for b in data[at:at + 4]) + data[at + 4:]


def _jpeg_webp():
    import io
    from PIL import Image
    out = {}
    for fmt in ("JPEG", "WEBP"):
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), (10, 120, 30)).save(buf, fmt)
        out[fmt] = buf.getvalue()
    return out


TRUNCATIONS = {
    "png_iend_removed": lambda: png()[:_iend_at(png())],
    "png_iend_partial": lambda: png()[:_iend_at(png()) + 6],
    "png_idat_crc_and_iend_cut": lambda: png()[:_idat_crc_at(png())],
    "png_bad_crc_midfile": lambda: _midfile_bad_crc(png()),
    "png_trailing_bytes": lambda: png() + b"\x00",
    "jpeg_without_eoi": lambda: _jpeg_webp()["JPEG"][:-2],
    "webp_short_riff": lambda: (lambda d: d[:4] + struct.pack("<I", struct.unpack("<I", d[4:8])[0] - 2) + d[8:])(_jpeg_webp()["WEBP"]),
    "webp_chunk_cut": lambda: (lambda d: d[:4] + struct.pack("<I", len(d) - 8 - 10) + d[8:-10])(_jpeg_webp()["WEBP"]),
}


@pytest.mark.parametrize("kind", sorted(TRUNCATIONS))
def test_an_incomplete_container_is_refused(kind):
    from hive.core.media import Undecodable, decode_image
    data = TRUNCATIONS[kind]()
    with pytest.raises(Undecodable) as caught:
        decode_image(data, 64, 64, 4096)
    assert caught.value.reason in ("incomplete", "corrupt")


def test_whole_png_jpeg_and_webp_pass_the_container_check():
    from hive.core.media import decode_image
    both = _jpeg_webp()
    assert decode_image(png(), 64, 64, 4096) == ("image/png", 64, 64)
    assert decode_image(both["JPEG"], 64, 64, 4096) == ("image/jpeg", 64, 64)
    assert decode_image(both["WEBP"], 64, 64, 4096) == ("image/webp", 64, 64)


@pytest.mark.parametrize("kind", ["png_iend_removed", "png_iend_partial", "png_idat_crc_and_iend_cut", "png_bad_crc_midfile"])
def test_a_truncated_png_output_is_billed_but_never_stored(m, kind):
    _, a = _mind(m)
    m.vendor.image = TRUNCATIONS[kind]()
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["refusal"] == "output_undecodable"
    assert r.json()["error"]["state"] == "settled" and m.hive.db.all("SELECT * FROM assets") == []


@pytest.mark.parametrize("kind", ["png_iend_removed", "png_idat_crc_and_iend_cut", "jpeg_without_eoi", "webp_short_riff"])
def test_a_truncated_reference_is_refused_before_any_spend(m, kind):
    _, a = _mind(m)
    data = TRUNCATIONS[kind]()
    mime = "image/png" if kind.startswith("png") else "image/jpeg" if kind.startswith("jpeg") else "image/webp"
    ref = m.post("/api/agent/assets", content=data, headers={**agent_headers(a), "content-type": mime}).json()
    r = m.post("/llm/v1/media", json=_req(references=[{"sha256": ref["sha256"]}]), headers=agent_headers(a))
    assert r.status_code == 415 and r.json()["error"]["code"] == "reference_undecodable"
    assert m.vendor.posts == [] and _states(m) == []


@pytest.mark.parametrize("n_spec", [{"type": "range"}, {"type": "range", "min": 1}, {"type": "range", "max": 4},
                                    {"type": "range", "min": 1, "max": float("inf")}, {"type": "range", "min": "1", "max": 4}])
def test_an_n_range_without_explicit_bounds_is_refused(m, n_spec):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "supported_parameters": {**ENDPOINT["supported_parameters"], "n": n_spec}})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_pin_invalid"
    assert m.vendor.posts == [] and _states(m) == []


def test_an_input_references_range_without_bounds_is_refused(m):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "supported_parameters": {**ENDPOINT["supported_parameters"], "input_references": {"type": "range", "min": 0}}})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_pin_invalid" and m.vendor.posts == []


# ---- r8: every supported parameter is validated, used or not --------------------------------------------------------

@pytest.mark.parametrize("name,spec,extra", [
    ("resolution", {"type": "range", "min": 1}, {}),                                   # unused control, missing max
    ("quality", {"type": "enum", "values": []}, {"quality": []}),                      # empty enum, no quality pinned
    ("input_references", {"type": "range", "min": 0}, {"max_references": 0}),          # references disabled
    ("seed", {"type": "range", "min": 10, "max": 1}, {}),                              # min > max
    ("style", {"type": "enum", "values": [{"nested": 1}]}, {}),                        # non-scalar enum value
    ("watermark", {"type": "boolean", "values": ["yes"]}, {}),                         # a boolean with values
    ("mode", {"type": "string"}, {}),                                                  # unknown type
    ("other", "range", {}),                                                            # not a record
])
def test_every_supported_parameter_must_be_well_formed(m, name, spec, extra):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "supported_parameters": {**ENDPOINT["supported_parameters"], name: spec}}, **extra)
    if extra.get("quality") == []:
        m.hive.settings.providers["openrouter"].media["image.generate"]["quality"] = []
    r = m.post("/llm/v1/media", json={k: v for k, v in _req().items()}, headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_pin_invalid" and name in r.json()["error"]["message"]
    assert m.vendor.posts == [] and _states(m) == []


def test_well_formed_unused_parameters_are_admitted(m):
    _, a = _mind(m)
    _pin(m, endpoint={**ENDPOINT, "supported_parameters": {**ENDPOINT["supported_parameters"],
                                                           "seed": {"type": "boolean"}, "steps": {"type": "range", "min": 1, "max": 50},
                                                           "style": {"type": "enum", "values": ["a", "b"]}}})
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200


# ---- media r2 (PLATFORM_MEDIA_PIN_R1 stand-in FIX-FIRST: four P1s) -------------------------------------------------

def _design_jpeg():
    """Design's reproducer fixture (onboarding_jpeg_completeness_r1_20261017): a synthetic
    128x128 RGB pattern at quality 90, and the same file with only 25/50/75 % of its scan kept, then terminated."""
    import io
    from PIL import Image
    image = Image.new("RGB", (128, 128))
    image.putdata([((x * 13 + y * 3) % 256, (x * 5 + y * 11) % 256, (x * 7 + y * 17) % 256) for y in range(128) for x in range(128)])
    stream = io.BytesIO()
    image.save(stream, format="JPEG", quality=90)
    whole = stream.getvalue()
    marker = whole.index(b"\xff\xda")
    start = marker + 2 + int.from_bytes(whole[marker + 2:marker + 4], "big")
    end = len(whole) - 2
    cut = {f: whole[:start + int((end - start) * f)] + b"\xff\xd9" for f in (0.25, 0.5, 0.75)}
    return whole, cut


def test_design_jpeg_reproducer_complete_accepted_truncated_refused():
    """P1-4, bound from Design's reproduction: Pillow fills these three; the host must refuse them."""
    from hive.core.media import Undecodable, decode_image
    whole, cut = _design_jpeg()
    assert len(whole) == 11448                                   # the same fixture Design measured
    assert decode_image(whole, 128, 128, 128 * 128) == ("image/jpeg", 128, 128)
    for fraction, data in cut.items():
        with pytest.raises(Undecodable) as caught:
            decode_image(data, 128, 128, 128 * 128)
        assert caught.value.reason == "incomplete", fraction


def _encode(fmt="JPEG", size=(96, 80), **kw):
    import io
    from PIL import Image
    image = Image.new("RGB", size)
    image.putdata([((x * 29 + y * 7) % 256, (x * 3 + y * 19) % 256, (x * y) % 256) for y in range(size[1]) for x in range(size[0])])
    buf = io.BytesIO()
    image.save(buf, fmt, **kw)
    return buf.getvalue()


@pytest.mark.parametrize("kw", [{}, {"progressive": True}, {"optimize": True}, {"subsampling": 0}, {"subsampling": 2},
                                {"restart_marker_blocks": 3}, {"progressive": True, "restart_marker_rows": 1}, {"quality": 100}])
def test_jpeg_variants_whole_accepted_and_every_cut_refused(kw):
    """Baseline, progressive, optimized tables, chroma subsampling and restart intervals: whole files pass; a scan cut
    anywhere and closed with EOI is refused, and so is a progressive file cut before a band's first scan. (r2.1: a cut
    that drops only refinement scans leaves a complete encoding at a higher Al; test_jpeg_complete.py covers it.)"""
    from hive.core.media import Undecodable, decode_image
    data = _encode(**kw)
    assert decode_image(data, 96, 80, 96 * 80) == ("image/jpeg", 96, 80)
    first = data.index(b"\xff\xda")
    for at in range(first + 12, len(data) - 2, max(1, (len(data) - first) // 40)):
        with pytest.raises(Undecodable):
            decode_image(data[:at] + b"\xff\xd9", 96, 80, 96 * 80)
    if kw.get("progressive"):
        firsts = [i for i in range(len(data) - 10) if data[i:i + 2] == b"\xff\xda" and data[i + 4] == 1
                  and data[i + 9] >> 4 == 0 and data[i + 7] > 0]      # single-component first AC scans (Ah = 0)
        with pytest.raises(Undecodable):                            # all but the last first scan: a band never coded
            decode_image(data[:firsts[-1]] + b"\xff\xd9", 96, 80, 96 * 80)


def test_grey_and_cmyk_jpegs_are_still_supported():
    import io
    from PIL import Image
    from hive.core.media import decode_image
    for mode in ("L", "CMYK"):
        buf = io.BytesIO()
        Image.new(mode, (40, 24), 90).save(buf, "JPEG")
        assert decode_image(buf.getvalue(), 64, 64, 4096) == ("image/jpeg", 40, 24)


def _jpeg_pin(m, w=128, h=128):
    """A pin with no output_format, so the vendor's JPEG is a valid output type (as the planned Seedream pin)."""
    endpoint = {**ENDPOINT, "supported_parameters": {k: v for k, v in ENDPOINT["supported_parameters"].items() if k != "output_format"}}
    endpoint["supported_parameters"]["size"] = {"type": "enum", "values": [f"{w}x{h}"]}
    _pin(m, endpoint=endpoint, geometry={f"{w}x{h}": {"width": w, "height": h, "controls": {"size": f"{w}x{h}"}}})


def test_a_truncated_jpeg_output_is_billed_refused_and_a_whole_one_is_stored(m):
    _, a = _mind(m)
    _jpeg_pin(m)
    whole, cut = _design_jpeg()
    m.vendor.image = cut[0.5]
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 502 and r.json()["error"]["refusal"] == "output_undecodable"
    assert r.json()["error"]["billing"]["state"] == "billed_refused" and m.hive.db.all("SELECT * FROM assets") == []
    m.vendor.image = whole
    ok = m.post("/llm/v1/media", json=_req("op-whole-jpeg-1"), headers=agent_headers(a))
    assert ok.status_code == 200 and ok.json()["asset"]["mime"] == "image/jpeg" and ok.json()["outcome"] == "accepted"


# P1-1: no accepted asset without validation; a real charge is recorded honestly as billed_refused

def test_the_output_is_validated_before_usage_is_recorded(m, monkeypatch):
    _, a = _mind(m)
    order, validate, record = [], MediaRoute._validate, m.hive.record_usage
    monkeypatch.setattr(MediaRoute, "_validate", staticmethod(lambda *args: (order.append("validate"), validate(*args))[1]))
    monkeypatch.setattr(m.hive, "record_usage", lambda *args, **kw: (order.append("usage"), record(*args, **kw))[1])
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200
    assert order == ["validate", "usage"]


def test_billed_refused_is_recorded_and_shown_plainly(m):
    _, a = _mind(m)
    m.vendor.image = png(64, 32)                                  # the vendor's geometry is not the pin's
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    err = r.json()["error"]
    assert r.status_code == 502 and err["code"] == "output_refused" and err["refusal"] == "output_dimensions"
    assert err["billing"] == {"state": "billed_refused", "held_usd": 0.04, "actual_usd": 0.035, "origin": "provider-usage-cost"}
    assert err["asset"] is None and "billed $0.0350" in err["message"] and "no asset" in err["message"]
    # the charge is not hidden: usage, spend and the reservation all carry it
    (usage,) = m.hive.db.all("SELECT * FROM usage")
    assert usage["cost_usd"] == 0.035 and m.hive.agent(a["id"])["spent_usd"] == pytest.approx(0.035) and _states(m) == ["settled"]
    # to the mind's people (its last error) and to admins (the results list)
    assert "image refused after the provider charged $0.0350" in m.hive.db.one("SELECT last_error FROM agents WHERE id = ?", (a["id"],))["last_error"]
    (row,) = m.get("/api/media/results", params={"billing": "billed_refused"}).json()
    assert row["refusal"] == "output_dimensions" and row["asset_sha256"] is None and row["agent_id"] == a["id"]
    # a replay states it too, with no second call
    again = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert again.status_code == 409 and again.json()["error"]["billing"]["state"] == "billed_refused" and len(m.vendor.posts) == 1


def test_the_reservation_safety_is_unchanged_for_refusals(m):
    _, a = _mind(m, budget=0.07)                                  # room for one $0.04 worst case
    m.vendor.image, m.vendor.cost = png(64, 32), 0.04
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 502
    r = m.post("/llm/v1/media", json=_req("op-second-0001"), headers=agent_headers(a))
    assert r.status_code == 402 and len(m.vendor.posts) == 1      # the recorded charge counts against the cap


def test_two_billed_refusals_in_a_row_open_the_breaker_until_an_admin_resets_it(m):
    _, a = _mind(m)
    m.vendor.image = png(64, 32)
    for i in range(2):
        r = m.post("/llm/v1/media", json=_req(f"op-refused-{i:04d}"), headers=agent_headers(a))
        assert r.json()["error"]["billing"]["state"] == "billed_refused"
    assert "paused" in r.json()["error"]["message"] and r.json()["error"]["breaker"]["tripped_at"]
    m.vendor.image = png()
    blocked = m.post("/llm/v1/media", json=_req("op-blocked-0001"), headers=agent_headers(a))
    assert blocked.status_code == 423 and blocked.json()["error"]["code"] == "media_breaker_open"
    assert len(m.vendor.posts) == 2 and len(_states(m)) == 2      # no call, no reservation
    q = m.post("/llm/v1/media", json=_req("op-blocked-0002", op="image.generate-quality"), headers=agent_headers(a))
    assert q.status_code == 423                                   # per mind, every op
    _, b = _mind(m)                                               # another mind is unaffected
    assert m.post("/llm/v1/media", json=_req("op-other-0001"), headers=agent_headers(b)).status_code == 200
    (row,) = m.get("/api/media/breakers").json()
    assert row["agent_id"] == a["id"] and "2 billed_refused" in row["reason"]
    assert m.post(f"/api/media/breakers/{a['id']}/reset", json={}).status_code == 400          # a reason is required
    assert m.post(f"/api/media/breakers/{a['id']}/reset", json={"reason": "pin corrected"}).status_code == 200
    assert m.post("/llm/v1/media", json=_req("op-after-reset1"), headers=agent_headers(a)).status_code == 200


def test_an_accepted_image_ends_a_run_of_refusals(m):
    _, a = _mind(m)
    for i, image in enumerate((png(64, 32), png(), png(64, 32))):
        m.vendor.image = image
        m.post("/llm/v1/media", json=_req(f"op-mixed-{i:04d}"), headers=agent_headers(a))
    assert m.post("/llm/v1/media", json=_req("op-mixed-next"), headers=agent_headers(a)).status_code == 502   # not 423


def test_the_breaker_threshold_is_configurable(m):
    _, a = _mind(m)
    m.hive.settings.media_breaker_refusals = 1
    m.vendor.image = png(64, 32)
    m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert m.post("/llm/v1/media", json=_req("op-next-00001"), headers=agent_headers(a)).status_code == 423


# P1-2: the reservation is not a ceiling; an overrun is recorded in full, flagged and trips the breaker

def test_a_vendor_overcharge_is_recorded_flagged_and_stops_repetition(m):
    _, a = _mind(m)
    m.vendor.cost = 0.5
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 200 and r.json()["billing"]["actual_usd"] == 0.5 and r.json()["asset"]   # the image is fine
    assert r.json()["breaker"]["tripped_at"] and "vendor charged $0.5000 against $0.0400" in r.json()["breaker"]["reason"]
    assert m.hive.db.one("SELECT cost_usd FROM usage")["cost_usd"] == 0.5                             # recorded in full
    (over,) = m.get("/api/budgets/overruns").json()
    assert over["actual"] == 500_000 and over["maximum"] == 40_000
    m.vendor.cost = 0.035
    blocked = m.post("/llm/v1/media", json=_req("op-again-00001"), headers=agent_headers(a))
    assert blocked.status_code == 423 and len(m.vendor.posts) == 1


def test_an_overrun_found_when_a_person_resolves_an_unknown_also_trips(m):
    _, a = _mind(m, budget=1.0)
    _pin(m, timeout_seconds=1)
    m.vendor.delay = 3
    rid = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).json()["error"]["reservation"]
    m.vendor.delay = 0
    done = m.post(f"/api/budgets/reservations/{rid}/resolve",
                  json={"action": "settle", "actual_usd": 0.3, "reason": "provider activity shows $0.30"})
    assert done.status_code == 200
    assert m.post("/llm/v1/media", json=_req("op-after-00001"), headers=agent_headers(a)).status_code == 423


# P1-3: activation is scoped by a host allowlist, default nobody

def test_a_mind_not_on_the_allowlist_is_refused_before_any_spend(m):
    _, a = _mind(m, allow=False)
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 403 and r.json()["error"]["code"] == "media_not_allowed"
    assert m.vendor.posts == [] and _states(m) == []


def test_the_allowlist_is_per_op_and_may_name_a_swarm(m):
    swarm, a = _mind(m, allow=False)
    m.hive.settings.media_allow["image.generate"] = [f"swarm:{swarm['id']}"]
    assert m.post("/llm/v1/media", json=_req(), headers=agent_headers(a)).status_code == 200
    q = m.post("/llm/v1/media", json=_req("op-quality-0001", op="image.generate-quality"), headers=agent_headers(a))
    assert q.status_code == 403 and q.json()["error"]["code"] == "media_not_allowed" and len(m.vendor.posts) == 1


def test_the_default_allowlist_admits_nobody(monkeypatch, tmp_path):
    from hive.core.config import _media_allow
    monkeypatch.delenv("HIVE_MEDIA_ALLOW", raising=False)
    assert load_settings(data_dir=tmp_path / "d").media_allow == {}
    for raw, expected in [("not json", {}), ('["agent:a_0123abcd"]', {}),
                          ('{"image.generate": ["*", "a_0123abcd", "agent:a_0123abcd", "swarm:s_89abcdef", 7]}',
                           {"image.generate": ["agent:a_0123abcd", "swarm:s_89abcdef"]})]:
        monkeypatch.setenv("HIVE_MEDIA_ALLOW", raw)
        assert _media_allow() == expected


# admission guard: the pin sends exact geometry controls, never leaving a size to the vendor

SEED_LIKE = {**ENDPOINT, "supported_parameters": {
    "resolution": {"type": "enum", "values": ["1K", "2K", "4K"]},
    "aspect_ratio": {"type": "enum", "values": ["1:1", "16:9", "auto"]},
    "n": {"type": "range", "min": 1, "max": 10}, "input_references": {"type": "range", "min": 0, "max": 14}}}


@pytest.mark.parametrize("controls,why", [
    ({"resolution": "2K"}, "aspect_ratio documented by the endpoint but not pinned"),
    ({"resolution": "2K", "aspect_ratio": "auto"}, "auto"),
    ({"resolution": "2K", "aspect_ratio": "16:9"}, "not the pinned 64:64"),
])
def test_geometry_the_vendor_could_choose_is_refused_at_admission(m, controls, why):
    _, a = _mind(m)
    _pin(m, endpoint=SEED_LIKE, quality=[], geometry={"g": {"width": 64, "height": 64, "controls": controls}})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "media_pin_invalid" and why in r.json()["error"]["message"]
    assert m.vendor.posts == [] and _states(m) == []


def test_a_size_control_must_name_the_pinned_pixels(m):
    _, a = _mind(m)
    _pin(m, geometry={"64x64": {"width": 64, "height": 64, "controls": {"size": "64x32"}}})
    r = m.post("/llm/v1/media", json=_req(), headers=agent_headers(a))
    assert r.status_code == 503 and "not the pinned 64x64" in r.json()["error"]["message"] and m.vendor.posts == []


def test_a_seedream_shaped_pin_sends_exactly_its_controls(m):
    _, a = _mind(m)
    _pin(m, endpoint=SEED_LIKE, quality=[], max_references=0,
         geometry={"64x64": {"width": 64, "height": 64, "controls": {"resolution": "2K", "aspect_ratio": "1:1"}}})
    r = m.post("/llm/v1/media", json={"op": "image.generate", "prompt": "a quiet garden"}, headers=agent_headers(a))
    assert r.status_code == 200, r.text
    assert m.vendor.posts[0]["body"] == {"model": "mock-author/mock-image", "prompt": "a quiet garden", "n": 1,
                                         "resolution": "2K", "aspect_ratio": "1:1",
                                         "provider": {"only": ["mock-seed"], "allow_fallbacks": False}}
