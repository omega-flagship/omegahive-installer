"""Purpose: test that a researcher ends with a report when the spending limits it runs under are close. Each model call
it makes is held to what those limits still allow, and each page it reads is cut to what its next call can carry.
Once only its report fits, it is told to write it. A call the limits refuse even then is sent as asked and holds the
research, as any limit's refusal does, the hold naming the limit to an asker who may see it, and a research that ends
without a report says why in the asker's Ask.

The limit here is the hive's day cap, set for each test under the research tests' month total of $1,000 (their
hive_total fixture), so the day cap is the one a researcher's call meets first. Invented model only,
"invented/researcher" on OpenRouter at $2 in and $10 out per million tokens. Synthetic people and data, disposable
hives, no network."""
import json

import pytest

from hive.core import research as rmod
from hive.core.webtools import WebError, fit_text
from hive.tests.test_ask_conductor import on  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_research_request import (_no_network, agent, child_of, coordinator,  # noqa: F401  (autouse fixtures)
                                              dispatch_research, fake_web, hive_total, row_of, run, token_for)

MODEL = "openrouter/invented/researcher"
ANSWER = ({"id": "r1", "model": "invented/researcher", "choices": [{"message": {"role": "assistant", "content": "ok"}}],
           "usage": {"prompt_tokens": 10, "completion_tokens": 5}},
          {"prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0.0001})


@pytest.fixture
def priced(client, monkeypatch):
    """The invented model's price, for one test only: the providers are shared objects."""
    provider = client.app.state.gateway.providers.get("openrouter")
    monkeypatch.setitem(provider.prices, "invented/researcher", {"in": 2.0, "out": 10.0})


def _researcher(client, on, room_usd=0.25, last=None):
    """A research request's researcher on the priced model, the hive's day capped so that room_usd is left today, its
    last call `last` bytes long."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE agents SET model = ? WHERE id = ?", (MODEL, row["child_id"]))
    hive.budgets.set("hive", "day", hive.budgets.spent("hive", "day") + room_usd)
    if last is not None:
        hive.research.last_call_bytes[row["child_id"]] = last
    return hive, row


def _wire_size(text):
    return len(json.dumps(json.dumps(text, ensure_ascii=False), ensure_ascii=False).encode("utf-8"))


def test_fit_text_keeps_the_longest_start_that_fits_twice_escaped():
    text = 'a "quoted" line\nnext line é' * 50
    for limit in (0, 7, 100, 999, _wire_size(text)):
        kept = fit_text(text, limit)
        assert text.startswith(kept) and _wire_size(kept) <= max(limit, _wire_size(""))
        if kept != text:
            assert _wire_size(text[:len(kept) + 1]) > limit


def test_a_researchers_room_is_what_the_limits_on_its_calls_still_allow(client, on, priced):
    hive, row = _researcher(client, on, room_usd=0.25)
    assert hive.research.room_micros(agent(hive, row["child_id"])) == 250_000


def test_a_researchers_page_is_cut_to_what_its_next_call_can_carry(client, on, priced):
    hive, row = _researcher(client, on, last=100_000)
    tools = fake_web(client)
    words = "Cepheid variables pulse. " * 10_000   # 250,000 characters of page text
    tools.connector.page("example.org", "/long", f"<html><body><p>{words}</p></body></html>".encode())
    mind = child_of(hive, row)
    hive.goals.claim(mind, row["goal_id"])
    room = hive.research.fit_fetch(agent(hive, mind["id"]))
    # $0.25 left, 2048 tokens of output kept for the report, the last call's 100,000 bytes and 2,000 for the framing
    assert room == (250_000 - rmod.REPORT_TOKENS * 10) // 2 - 100_000 - rmod.TOOL_FRAME_BYTES == 12_760
    page = run(tools.fetch(agent(hive, mind["id"]), {"url": "https://example.org/long", "max_chars": 200_000}))
    assert page["truncated"] and page["text"].startswith("Cepheid variables pulse.")
    assert room - 20 <= _wire_size(page["text"]) <= room


def test_a_researcher_whose_limits_leave_room_only_for_its_report_is_told_to_write_it_now(client, on, priced):
    hive, row = _researcher(client, on, last=112_000)   # (250,000 - 20,480) // 2 - 112,000 - 2,000 = 760 bytes
    tools = fake_web(client)
    mind = child_of(hive, row)
    hive.goals.claim(mind, row["goal_id"])
    for tool, data in (("fetch", {"url": "https://example.org/cepheids"}), ("search", {"query": "cepheid distances"})):
        with pytest.raises(WebError) as e:
            run(getattr(tools, tool)(agent(hive, mind["id"]), data))
        assert e.value.code == "research_budget_low"
        assert f"hive-goal-propose {row['goal_id']}" in e.value.message


def test_only_a_researcher_on_a_priced_model_is_held_to_its_limits(client, on, priced):
    hive, row = _researcher(client, on, last=10 ** 9)
    assert hive.research.fit_fetch(coordinator(hive)) is None
    hive.db.execute("UPDATE agents SET model = 'mock/echo' WHERE id = ?", (row["child_id"],))
    assert hive.research.fit_fetch(agent(hive, row["child_id"])) is None


def _chat(client, hive, child_id, prompt_bytes, max_tokens=4096):
    body = {"messages": [{"role": "user", "content": "x" * prompt_bytes}], "max_tokens": max_tokens}
    return client.post("/llm/v1/chat/completions", json=body, headers=token_for(hive, child_id))


def test_a_researchers_call_is_held_to_the_output_room_its_limits_still_allow(client, on, priced):
    hive, row = _researcher(client, on, room_usd=0.08)   # 4096 tokens after a 20,000-byte prompt need $0.081
    sent = []

    async def chat(_agent, body):
        sent.append(dict(body))
        return ANSWER
    client.app.state.gateway.chat = chat
    answered = _chat(client, hive, row["child_id"], 20_000)
    assert answered.status_code == 200, answered.text
    assert rmod.REPORT_TOKENS <= sent[0]["max_tokens"] < 4096
    _paid, worst = client.app.state.gateway.estimate(agent(hive, row["child_id"]), sent[0])
    assert worst <= 0.08
    assert hive.research.last_call_bytes[row["child_id"]] > 20_000
    assert row_of(hive)["state"] == "working"


def test_a_call_its_limits_refuse_even_at_its_reports_room_holds_the_research(client, on, priced):
    hive, row = _researcher(client, on, room_usd=0.01)   # 2048 tokens of output alone cost $0.02

    async def chat(_agent, _body):
        raise AssertionError("a refused call is never sent")
    client.app.state.gateway.chat = chat
    assert _chat(client, hive, row["child_id"], 20_000).status_code == 402
    kept = row_of(hive)
    assert (kept["state"], kept["hold_reason"]) == ("working", "spending_limit")
    assert _held(client, on)[-1] == "hive_day"   # the hive's day cap is everyone's to see


def _held(client, on):
    page = client.get("/api/ask/op-res-001", headers=on["ann"]).json()
    return [f.get("limit") for f in page["events"] if f["phase"] == "research" and f["state"] == "held"]


def test_a_hold_names_the_limit_that_held_it_to_an_asker_who_may_see_it(client, on, priced):
    hive, row = _researcher(client, on)
    for scope, period in (("hive", "day"), ("key:k_someone_else", "month"), (None, None)):
        hive.events.publish("budget.refused", agent_id=row["child_id"], code="spend_limit", count=1,
                            **({"scope": scope, "period": period, "limit_usd": 1.0, "spent_usd": 1.0} if scope else {}))
        hive.research._resume(row["child_id"], ("spending_limit",))   # cleared, so the next refusal holds it anew
    # the hive's day cap is everyone's to see; another person's key limit is theirs; a refusal naming no limit names none
    assert _held(client, on) == ["hive_day", "unseen", None]


def test_research_that_ends_at_its_deadline_says_so_in_the_ask(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE goals SET deadline_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", (row["goal_id"],))
    run(hive.goals.expire())
    page = client.get("/api/ask/op-res-001", headers=on["ann"]).json()
    assert [(f["state"], f.get("reason")) for f in page["events"] if f["phase"] == "research"] == [("failed", "deadline")]
