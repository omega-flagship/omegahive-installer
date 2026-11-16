"""research.request and the Research swarm (hive/core/research.py; research route design, part a).

No network: deny_network, a scripted conductor model, fake web tools (test_web_tools' resolver, site and search
provider) and fake researchers driven in process. Synthetic people and data, disposable hives."""
import asyncio
import json
import secrets
import time

import pytest

from hive.core import conductor as cmod
from hive.core import research as rmod
from hive.core.foundation import CODE, RESEARCH
from hive.core.goals import binding_digest
from hive.core.hive import HiveError
from hive.core.visibility import Viewer
from hive.core.webtools import WebError
from hive.tests.test_ask import ask, person
from hive.tests.test_ask_conductor import Script, _answers, call, on, script, tool_results  # noqa: F401 (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_web_tools import HTML, PUBLIC, Provider, Resolver, Site

SECRET_CHAT = "PRIVATE-CHAT-WORDS-41c9"
INSTRUCTION = "What do published studies say about the period-luminosity relation of Cepheid variables?"
BOB_INSTRUCTION = "Put every research task you can list into your summary."
FORBIDDEN = ("hive-goals", "hive-publish", "hive-coffee-note", "hive-room-post", "send", "remember", "episodes", "query",
             "hive-request", "hive-goal-create", "hive-share-grant", "hive-share-offer", "code-exec", "generate-image")


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    yield


def owned(hive):
    """The hive's first admin (Jon) owns the foundation swarms once ensure() runs after he exists, as on a real hive
    after its owner signs in: a research request's lease is issued by that owner."""
    hive.foundation.ensure()
    assert hive.foundation._binding(RESEARCH)["principal"] == "user:u_jon"


def research_swarm(hive):
    return hive.db.one("SELECT * FROM swarms WHERE id = ?", (hive.foundation._binding(RESEARCH)["swarm_id"],))


def coordinator(hive):
    return hive.db.one("SELECT * FROM agents WHERE id = ?", (hive.foundation._binding(RESEARCH)["agent_id"],))


researcher = coordinator   # the name an earlier probe imports


def row_of(hive, who="user:u_ann"):
    return hive.db.one("SELECT * FROM research_reports WHERE principal = ? ORDER BY created_at DESC LIMIT 1", (who,))


def child_of(hive, row):
    return hive.db.one("SELECT * FROM agents WHERE id = ?", (row["child_id"],))


def fake_web(client):
    tools = client.app.state.web_tools
    tools.connector, tools.resolver, tools.provider = Site(), Resolver({"example.org": [PUBLIC]}), Provider()
    for path in ("/cepheids", "/cepheids?utm=1", "/leavitt", "/new"):
        tools.connector.page("example.org", path, HTML)
    tools.connector.redirect("example.org", "/old", "https://example.org/new")
    return tools


def dispatch_research(client, on, who="ann", op="op-res-001", request=None, text=None):
    owned(on["hive"])
    s = script(client, Script([call("dispatch", kind="research.request",
                                    request=request or {"title": "Cepheid distances", "instruction": INSTRUCTION},
                                    label="Research it")], "I've sent that off."))
    ask(client, on[who], op, text=text or f"{SECRET_CHAT} can you look into Cepheids for me?", context=on["ctx"])
    fs, said = _answers(on["hive"], op)
    return s, fs, said


def report(cite_a, cite_b):
    return {"summary": "Cepheids pulse with a period tied to their luminosity.",
            "sections": [{"heading": "The relation", "claims": [
                {"text": "Brighter Cepheids pulse more slowly.", "citations": [cite_a] if cite_a else []},
                {"text": "The relation was found in 1908.", "citations": [cite_b] if cite_b else []}]}],
            "open_questions": ["How large is the metallicity effect?"]}


def run(coro):
    return asyncio.run(coro)


def agent(hive, agent_id):
    return hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,))


def fetch(client, hive, mind_id, url):
    return run(client.app.state.web_tools.fetch(agent(hive, mind_id), {"url": url}))


def _claim_and_fetch(client, hive, goal_id, urls, row=None):
    """The request's own researcher claims its task and fetches urls."""
    fake_web(client)
    row = row or hive.db.one("SELECT * FROM research_reports WHERE goal_id = ?", (goal_id,))
    mind = child_of(hive, row)
    hive.goals.claim(mind, goal_id)
    return mind, [fetch(client, hive, mind["id"], u) for u in urls]


def _finish(hive, mind, goal_id, data):
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (goal_id,))
    return run(hive.goals.result(agent(hive, mind["id"]), goal_id, "done", "Report ready",
                                 {"proposal": data, "binding_digest": binding_digest(json.loads(goal["binding"]))}))


def token_for(hive, mind_id):
    """A known credential for an in-process researcher (its real one went to its workspace)."""
    token = secrets.token_urlsafe(24)
    hive.rotate_token(mind_id, agent(hive, mind_id).get("token_epoch") or 0, token)
    return {"Authorization": f"Bearer {token}"}


def two_requests(client, on):
    dispatch_research(client, on, who="ann", op="op-res-ann",
                      request={"title": "Ann private", "instruction": "ANN-SECRET-QUESTION about Cepheids"})
    dispatch_research(client, on, who="jon", op="op-res-jon",
                      request={"title": "Jon question", "instruction": BOB_INSTRUCTION})
    return row_of(on["hive"], "user:u_ann"), row_of(on["hive"], "user:u_jon")


# ---- provisioning ------------------------------------------------------------------------------------------------------

def test_ensure_provisions_the_research_swarm_its_researcher_template_and_offer_idempotently(client):
    hive = client.app.state.hive
    b = hive.foundation._binding(RESEARCH)
    assert b is not None, "a fresh hive has its Research swarm at startup"
    swarm, mind = research_swarm(hive), coordinator(hive)
    assert swarm["name"] == "Research" and swarm["visibility"] == "private" and swarm["coordinator_id"] == mind["id"]
    assert mind["kind"] == "omega" and mind["driver"] == "local" and mind["status"] == "asleep"
    # the coordinator owns the swarm and never researches: no role, no research guidance
    assert mind["role_id"] is None and mind["persona"] == rmod.COORDINATOR_PERSONA
    role = hive.research.role()
    assert role["name"] == rmod.ROLE_NAME and json.loads(role["rules"]) == rmod.ROLE_RULES
    # no swarm-service offer: research arrives only through a person's ask (ask_intents.KINDS + the binding)
    assert hive.collab.services(swarm["id"]) == []
    template = hive.minds.templates[rmod.TEMPLATE]
    assert template["teams"] == [swarm["id"]] and template["role_id"] == role["id"] and template["harness"] == "native"
    assert template["max_allocation_usd"] == rmod.budget_usd()

    def snapshot():
        return (hive.db.all("SELECT * FROM person_minds WHERE purpose = ?", (RESEARCH,)),
                hive.db.all("SELECT id FROM swarms WHERE name = 'Research'"),
                hive.db.all("SELECT id FROM roles WHERE name = ?", (rmod.ROLE_NAME,)),
                hive.db.all("SELECT id FROM agents WHERE swarm_id = ?", (swarm["id"],)))
    before = snapshot()
    out = hive.foundation.ensure()
    assert out["research_swarm"] == swarm["id"] and out["research_coordinator"] == mind["id"]
    person(client, "u_newcomer")
    out = hive.foundation.ensure("user:u_newcomer")   # a new person: the same swarm, nothing made twice
    assert out["research_swarm"] == swarm["id"] and snapshot()[1:] == before[1:]
    assert len(snapshot()[0]) == 1


def test_a_fresh_hive_without_the_research_swarm_gets_it_on_the_next_ensure(client):
    hive = client.app.state.hive
    b = hive.foundation._binding(RESEARCH)
    hive.db.execute("DELETE FROM person_minds WHERE purpose = ?", (RESEARCH,))
    hive.db.execute("UPDATE swarms SET name = 'Research (old)' WHERE id = ?", (b["swarm_id"],))
    hive.foundation.ensure()
    fresh = hive.foundation._binding(RESEARCH)
    assert fresh["swarm_id"] != b["swarm_id"] and research_swarm(hive)["name"] == "Research"


def test_a_taken_researcher_role_name_means_no_research_swarm_and_code_and_studio_upkeep_go_on(client):
    """P2-4: Research is provisioned last, on its own; its failure never stops Code, Review or Studio upkeep."""
    hive = client.app.state.hive
    hive.db.execute("DELETE FROM foundation_roles WHERE purpose = ?", (rmod.ROLE_PURPOSE,))
    hive.db.execute("UPDATE roles SET name = 'Retired researcher' WHERE name = ?", (rmod.ROLE_NAME,))
    hive.roles.create({"name": rmod.ROLE_NAME, "summary": "a person's own role", "prompt": "A person's own role.", "rules": [],
                       "mandate": None, "media": []})
    out = hive.foundation.ensure()
    assert out["research_swarm"] is None and out["code_team"] == hive.foundation._binding(CODE)["swarm_id"]
    assert out["review_team"] and isinstance(out["studio"], list)
    assert hive.db.one("SELECT COUNT(*) AS n FROM roles WHERE name = ?", (rmod.ROLE_NAME,))["n"] == 1


def test_an_archived_research_swarm_means_no_research_and_code_upkeep_goes_on(client, on):
    hive = on["hive"]
    owned(hive)
    hive.db.execute("UPDATE swarms SET archived_at = ? WHERE id = ?", ("2026-11-10T00:00:00.000Z", research_swarm(hive)["id"]))
    out = hive.foundation.ensure()
    assert out["research_swarm"] is None and out["code_team"]
    script(client, Script([call("dispatch", kind="research.request",
                                    request={"title": "x", "instruction": "y?"})], "ok"))
    ask(client, on["ann"], "op-res-archived", context=on["ctx"])
    _fs, said = _answers(hive, "op-res-archived")
    assert said == [cmod.DISPATCH_REFUSED_SAY["no_research_swarm"]] and not hive.db.one("SELECT 1 FROM research_reports")


# ---- the dispatch schema -----------------------------------------------------------------------------------------------

def test_the_dispatch_tool_schema_is_generated_from_the_validators_table():
    tool = next(t for t in cmod.tools() if t["function"]["name"] == "dispatch")["function"]["parameters"]
    assert "research.request" in tool["properties"]["kind"]["enum"] and "code.test" not in tool["properties"]["kind"]["enum"]
    props = tool["properties"]["request"]["properties"]
    assert set(props) == set(rmod.REQUEST_FIELDS) == {"title", "instruction"}   # P2-1: no swarm field
    for name, field in rmod.REQUEST_FIELDS.items():
        assert props[name]["maxLength"] == field["max"] and props[name]["description"] == field["about"]
    assert rmod.request_help() in tool["properties"]["request"]["description"]


def test_a_swarm_field_is_refused_and_research_goes_to_the_bound_swarm_never_one_by_name(client, on):
    """P2-1: another swarm named "Research" that offers research is never chosen; the bound swarm is."""
    hive = on["hive"]
    other = hive.create_swarm("Research")
    hive.collab.set_services(other["id"], ["research"], "user:u_ann")
    s, _fs, said = dispatch_research(client, on, op="op-res-swarm",
                                     request={"title": "x", "instruction": "y?", "swarm": "Research"})
    assert said == [cmod.DISPATCH_REFUSED_SAY["bad_request"]] and tool_results(s.bodies[1])[0]["detail"] == "bad_fields"
    dispatch_research(client, on, op="op-res-bound")
    assert row_of(hive)["swarm_id"] == research_swarm(hive)["id"] != other["id"]


# ---- dispatch: intent-only; a fresh researcher per request ---------------------------------------------------------------

def test_a_members_mind_dispatches_research_and_a_fresh_researcher_gets_only_that_task(client, on):
    hive = on["hive"]
    s, fs, said = dispatch_research(client, on)
    assert said == []
    d = [f for f in fs if f["phase"] == "dispatched"]
    swarm, ctl = research_swarm(hive), coordinator(hive)
    assert len(d) == 1 and d[0]["intent_kind"] == "research.request" and d[0]["to"] == {"kind": "swarm", "ref": swarm["id"], "name": "Research"}
    result = tool_results(s.bodies[1])[0]
    assert result["ok"] is True and result["state"] == "linked" and result["next"] == cmod.DISPATCH_SENT_NEXT
    intent = hive.db.one("SELECT * FROM ask_intents WHERE id = ?", (d[0]["intent_id"],))
    assert intent["state"] == "linked" and intent["principal"] == "user:u_ann"
    req = hive.db.one("SELECT * FROM requests WHERE id = ?", (intent["request_id"],))
    turn = hive.db.one("SELECT * FROM ask_turns WHERE operation_id = 'op-res-001'")
    assert (req["kind"], req["from_principal"], req["to_swarm"], req["from_swarm"]) == ("research", "user:u_ann", swarm["id"], turn["swarm_id"])
    row = row_of(hive)
    child = child_of(hive, row)
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (req["receiving_goal"],))
    binding = json.loads(goal["binding"])
    assert child and child["id"] != ctl["id"] and child["swarm_id"] == swarm["id"] and child["role_id"] == hive.research.role()["id"]
    assert goal["assignee"] == child["id"] and goal["status"] == "open" and goal["deadline_at"]
    assert goal["title"] == "Cepheid distances" and goal["detail"] == INSTRUCTION
    assert binding["result_schema"] == rmod.REPORT_SCHEMA and binding["review"] == "none" and binding["kind"] == "research"
    kid = hive.db.one("SELECT * FROM mind_children WHERE id = ?", (child["id"],))
    assert kid["template_id"] == rmod.TEMPLATE and kid["request_id"] == req["id"] and kid["controller_id"] == ctl["id"]
    # the brief is the fresh researcher's first prompt; nothing reaches the coordinator, and no chat reaches either
    prompts = hive.db.all("SELECT * FROM mind_prompts WHERE child_id = ?", (child["id"],))
    assert len(prompts) == 1 and goal["id"] in prompts[0]["text"] and f"hive-goal-get {goal['id']}" in prompts[0]["text"]
    assert INSTRUCTION not in prompts[0]["text"] and "Cepheid distances" not in prompts[0]["text"]   # read via the task
    assert not hive.db.all("SELECT 1 FROM messages WHERE agent_id = ?", (ctl["id"],))
    stored = json.dumps(hive.db.all("SELECT * FROM goals WHERE swarm_id = ?", (swarm["id"],))) + json.dumps(
        hive.db.all("SELECT * FROM messages WHERE agent_id IN (?, ?)", (ctl["id"], child["id"]))) + json.dumps(req)
    assert SECRET_CHAT not in stored
    view = client.get(f"/api/ask/intents/{intent['id']}", headers=on["ann"]).json()
    assert view["state"] == "linked" and view["title"] == "Cepheid distances" and view["instruction"] == INSTRUCTION


def test_each_request_gets_its_own_researcher_and_none_sees_another_persons_task(client, on):
    """P1: no shared researcher. Jon's researcher (asked to copy every task it can list) lists, reads, claims and
    finishes only its own task; Ann's question never reaches it, over the host's own routes too."""
    hive = on["hive"]
    ann, jon = two_requests(client, on)
    a, j = child_of(hive, ann), child_of(hive, jon)
    assert a["id"] != j["id"]
    goals = hive.goals.list(research_swarm(hive)["id"])
    assert [g["id"] for g in hive.research.visible_goals(j, goals)] == [jon["goal_id"]]
    for call_ in (lambda: hive.goals.claim(j, ann["goal_id"]), lambda: hive.goals.for_agent(j, ann["goal_id"]),
                  lambda: hive.goals.heartbeat(j, ann["goal_id"]),
                  lambda: run(hive.goals.result(j, ann["goal_id"], "done", "x", {})),
                  lambda: hive.goals.claim(coordinator(hive), ann["goal_id"])):
        with pytest.raises(HiveError) as e:
            call_()
        assert e.value.code == "not_assigned"
    with pytest.raises(HiveError):
        run(hive.goals.create(j["swarm_id"], "a new task", created_by=f"agent:{j['id']}"))
    # the REST agent routes a researcher could reach: its own task only
    headers = token_for(hive, j["id"])
    listed = client.get("/api/agent/goals?status=", headers=headers).json()
    assert [g["id"] for g in listed] == [jon["goal_id"]] and "ANN-SECRET" not in json.dumps(listed)
    assert client.get(f"/api/agent/goals/{ann['goal_id']}", headers=headers).status_code == 403
    assert client.post(f"/api/agent/goals/{ann['goal_id']}/claim", headers=headers).status_code == 403
    assert client.get(f"/api/agent/goals/{jon['goal_id']}", headers=headers).status_code == 200
    jon_texts = json.dumps(hive.db.all("SELECT * FROM messages WHERE agent_id = ?", (j["id"],))) + json.dumps(
        hive.db.all("SELECT * FROM mind_prompts WHERE child_id = ?", (j["id"],)))
    assert "ANN-SECRET" not in jon_texts


def test_the_researcher_role_denies_everything_but_web_and_its_own_task_and_a_persons_deny_wins(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    child = child_of(hive, row_of(hive))
    for skill in sorted(rmod.CHILD_SKILLS):
        assert hive.policy.decide(child, skill)[0] == "allow", skill
    for skill in FORBIDDEN:
        assert hive.policy.decide(child, skill)[0] == "deny", skill
    ordinary = hive.db.one("SELECT * FROM agents WHERE id = ?", (on["worker"]["id"],))
    assert hive.policy.decide(ordinary, "hive-goals")[0] == "allow"   # only the researcher is refused
    # its role rules are host rules on a spawned research child: not on the ordinary Policy listing
    assert not [r for r in hive.policy.rules() if r["scope"] == f"agent:{child['id']}"]
    hosted = [r for r in hive.policy.infrastructure_rules() if r["scope"] == f"agent:{child['id']}"]
    assert hosted and all(r["infrastructure"]["kind"] == "foundation_research_child" for r in hosted)
    # a person's deny still wins, at hive or swarm scope
    hive.policy.add_rule("hive", "web-fetch", "deny", note="no web reading here", publish=False)
    assert hive.policy.decide(child, "web-fetch")[0] == "deny"
    hive.policy.add_rule(f"swarm:{child['swarm_id']}", "web-*", "ask", note="ask first", publish=False)
    assert hive.policy.decide(child, "web-search")[0] == "ask"


def test_one_research_per_turn_and_at_most_three_running_per_person(client, on):
    hive = on["hive"]
    owned(hive)
    s = script(client, Script([call("dispatch", kind="research.request", request={"title": "One", "instruction": "First?"}),
                               call("dispatch", kind="research.request", request={"title": "Two", "instruction": "Second?"})],
                              "Done."))
    ask(client, on["ann"], "op-res-twice", context=on["ctx"])
    fs, said = _answers(hive, "op-res-twice")
    results = tool_results(s.bodies[1])
    assert results[0]["ok"] is True and results[1]["reason"] == "research_turn_used"
    assert said == [cmod.DISPATCH_REFUSED_SAY["research_turn_used"]]
    for n in (2, 3):
        dispatch_research(client, on, op=f"op-res-more-{n}")
    _s, _fs, said = dispatch_research(client, on, op="op-res-more-4")
    assert said == [cmod.DISPATCH_REFUSED_SAY["research_busy"]]
    assert hive.db.one("SELECT COUNT(*) AS n FROM research_reports WHERE principal = 'user:u_ann'")["n"] == 3


# ---- budgets: a reservation per request -----------------------------------------------------------------------------------

def _person_rule(hive, period, limit):
    # the test person's id is not the shape the Limits route accepts, so the rule is written directly
    hive.db.insert("budgets", {"id": f"b_research_ann_{period}", "scope": "person:u_ann", "period": period,
                               "limit_usd": limit, "note": "", "created_at": "2026-11-01T00:00:00.000Z"})


def test_each_researcher_holds_the_requests_reservation_as_its_hard_cap(client, on):
    """P2-2: the request's budget is the researcher's allocation (reserved from the request root) and its own cap: its
    web calls stop there."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    req = hive.db.one("SELECT * FROM requests WHERE id = ?", (row["request_id"],))
    child = child_of(hive, row)
    res = hive.db.one("SELECT * FROM mind_reservations WHERE child_id = ?", (child["id"],))
    assert req["limit_usd"] == req["allocated_usd"] == rmod.budget_usd() == res["allocated_usd"] == child["budget_usd"]
    fake_web(client)
    hive.db.execute("UPDATE agents SET spent_usd = budget_usd WHERE id = ?", (child["id"],))
    with pytest.raises(WebError) as e:
        fetch(client, hive, child["id"], "https://example.org/cepheids")
    assert e.value.code == "budget_exhausted"


def test_a_month_allowance_counts_the_reservations_of_running_research(client, on):
    hive = on["hive"]
    _person_rule(hive, "month", 0.40)
    _s, _fs, said = dispatch_research(client, on, op="op-res-a1")
    assert said == []
    s, fs, said = dispatch_research(client, on, op="op-res-a2")   # 0.25 reserved + 0.25 > 0.40
    assert said == [cmod.DISPATCH_REFUSED_SAY["member_allowance"]]
    result = tool_results(s.bodies[1])[0]
    assert result["ok"] is False and result["reason"] == "spend_limit" and result["detail"] == "member_allowance"
    assert hive.db.one("SELECT COUNT(*) AS n FROM research_reports")["n"] == 1


def test_a_day_rule_counts_too(client, on):
    """P3-5: a person's day (or total) rule refuses as their month allowance does."""
    hive = on["hive"]
    _person_rule(hive, "day", 0.10)
    _s, _fs, said = dispatch_research(client, on, op="op-res-day")
    assert said == [cmod.DISPATCH_REFUSED_SAY["member_allowance"]]
    assert not hive.db.one("SELECT 1 FROM research_reports")
    assert hive.db.one("SELECT state FROM ask_intents WHERE kind = 'research.request'")["state"] == "refused"


def test_the_research_swarms_month_cap_counts_reservations_and_refuses(client, on, monkeypatch):
    """P2-2: a month cap across requests, not the coordinator's lifetime: two running requests can't overdraw it."""
    hive = on["hive"]
    monkeypatch.setenv("HIVE_RESEARCH_MONTH_USD", "0.30")
    assert dispatch_research(client, on, op="op-res-m1")[2] == []
    _s, _fs, said = dispatch_research(client, on, who="jon", op="op-res-m2")
    assert said == [cmod.DISPATCH_REFUSED_SAY["research_budget"]]
    assert hive.db.one("SELECT COUNT(*) AS n FROM research_reports")["n"] == 1


def test_a_researcher_that_cannot_be_started_fails_the_task_and_the_asker_hears_it(client, on, monkeypatch):
    hive = on["hive"]

    async def refused(*a, **k):
        raise HiveError(403, "spawn_disabled", "off")
    monkeypatch.setattr(hive.minds, "spawn", refused)
    dispatch_research(client, on)
    row = row_of(hive)
    assert row["state"] == "failed" and row["child_id"] is None
    assert hive.db.one("SELECT status FROM goals WHERE id = ?", (row["goal_id"],))["status"] == "failed"


# ---- the report reaches the asker; the researcher is retired ----------------------------------------------------------------

def _retired(hive, row):
    child = child_of(hive, row)
    kid = hive.db.one("SELECT * FROM mind_children WHERE id = ?", (child["id"],))
    lease = hive.db.one("SELECT * FROM mind_leases WHERE id = ?", (row["lease_id"],))
    res = hive.db.one("SELECT * FROM mind_reservations WHERE child_id = ?", (child["id"],))
    rules = hive.db.all("SELECT * FROM policy_rules WHERE scope = ?", (f"agent:{child['id']}",))
    return child["deleted"] == 1 and kid["state"] == "retired" and lease["ended_at"] and res["released_at"] and not rules


def test_a_researcher_finishes_with_a_cited_report_it_reaches_the_askers_thread_and_the_researcher_is_retired(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids"])
    page = fetched[0]
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": page["fetched_at"],
                                                "title": page["title"]},
                                               {"url": "https://example.org/never-fetched", "fetched_at": page["fetched_at"]}))
    out = client.get(f"/api/research/{row['request_id']}", headers=on["ann"])
    assert out.status_code == 200, out.text
    seen = out.json()
    assert seen["state"] == "done" and seen["by"]["mind_id"] == mind["id"]
    claims = seen["report"]["sections"][0]["claims"]
    assert seen["report"]["checks"] == {"claims": 2, "cited": 1, "uncited": 1, "path_matched": 0}
    assert claims[0]["cited"] is True and claims[0]["citations"][0]["match"] == "exact" and claims[0]["citations"][0]["verified"]
    assert claims[0]["citations"][0]["fetched_at"] == page["fetched_at"] and claims[0]["citations"][0]["audited_at"]
    assert claims[1]["cited"] is False and claims[1]["citations"][0]["match"] is None   # flagged: never fetched
    t = hive.db.one("SELECT id FROM ask_turns WHERE operation_id = 'op-res-001'")
    frames = [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ? ORDER BY seq", (t["id"],))]
    research = [f for f in frames if f["phase"] == "research"]
    assert len(research) == 1 and research[0]["state"] == "done" and research[0]["request_id"] == row["request_id"]
    assert research[0]["research"]["report"]["checks"]["cited"] == 1 and research[0]["principal"] == "user:u_ann"
    assert _retired(hive, row)
    hive.research.deliver(row["goal_id"])   # delivered once: a repeated event changes nothing
    assert len([1 for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (t["id"],))
                if json.loads(r["frame"])["phase"] == "research"]) == 1


def test_claims_with_no_fetched_source_are_flagged_uncited(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, _ = _claim_and_fetch(client, hive, row["goal_id"], [])
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": "2026-11-10T00:00:00Z"}, None))
    seen = hive.research.get(Viewer("user:u_ann", False), row["request_id"])
    assert seen["report"]["checks"]["cited"] == 0 and seen["report"]["checks"]["uncited"] == 2


def test_only_pages_fetched_after_the_claim_and_only_final_addresses_count(client, on):
    """P3-1: a fetch before the claim, and a redirect hop on the way to a page, are not sources."""
    hive = on["hive"]
    fake_web(client)
    dispatch_research(client, on)
    row = row_of(hive)
    mind = child_of(hive, row)
    fetch(client, hive, mind["id"], "https://example.org/leavitt")          # before its claim
    hive.db.execute("UPDATE web_audit SET at = '2026-01-01T00:00:00.000Z' WHERE agent_id = ?", (mind["id"],))
    hive.goals.claim(mind, row["goal_id"])
    redirected = fetch(client, hive, mind["id"], "https://example.org/old")  # ends on /new
    assert redirected["final_url"] == "https://example.org/new"
    _finish(hive, mind, row["goal_id"], {"summary": "s", "sections": [{"heading": "h", "claims": [
        {"text": "before the claim", "citations": [{"url": "https://example.org/leavitt", "fetched_at": "x"}]},
        {"text": "a hop", "citations": [{"url": "https://example.org/old", "fetched_at": "x"}]},
        {"text": "the page", "citations": [{"url": "https://example.org/new", "fetched_at": redirected["fetched_at"]}]}]}]})
    claims = hive.research.get(Viewer("user:u_ann", False), row["request_id"])["report"]["sections"][0]["claims"]
    assert [c["cited"] for c in claims] == [False, False, True]


def test_a_citation_whose_query_the_audit_dropped_shows_path_matched_not_verified(client, on):
    """P3-2."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids?utm=1"])
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids?utm=1", "fetched_at": fetched[0]["fetched_at"]}, None))
    seen = hive.research.get(Viewer("user:u_ann", False), row["request_id"])["report"]
    c = seen["sections"][0]["claims"][0]["citations"][0]
    assert c["match"] == "path" and c["verified"] is False and seen["checks"]["path_matched"] == 1


def test_a_report_of_the_wrong_shape_is_refused_and_the_task_stays_with_the_researcher(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, _ = _claim_and_fetch(client, hive, row["goal_id"], [])
    with pytest.raises(HiveError) as e:
        _finish(hive, mind, row["goal_id"], {"summary": "no sections"})
    assert e.value.code == "result_invalid"
    assert hive.db.one("SELECT status FROM goals WHERE id = ?", (row["goal_id"],))["status"] == "claimed"
    assert row_of(hive)["state"] == "working" and not child_of(hive, row)["deleted"]


def test_a_cancelled_task_reaches_the_asker_and_retires_its_researcher(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.goals.update(row["goal_id"], {"status": "cancelled"})
    seen = hive.research.get(Viewer("user:u_ann", False), row["request_id"])
    assert seen["state"] == "cancelled" and seen["report"] is None and _retired(hive, row)


def test_a_task_past_its_deadline_fails_and_retires_its_researcher(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE goals SET deadline_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", (row["goal_id"],))
    run(hive.goals.expire())
    assert row_of(hive)["state"] == "failed" and _retired(hive, row)


def test_a_stalled_task_is_unfinished(client, on):
    """P3-3: stalled waits for a person or its deadline; the research is still working and its researcher kept."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.goals.update(row["goal_id"], {"status": "stalled"})
    assert row_of(hive)["state"] == "working" and not child_of(hive, row)["deleted"]


def test_startup_recovery_gives_an_open_request_its_researcher(client, on, monkeypatch):
    """P3-4: admitted, then the process ended before the spawn: recovery spawns the researcher once."""
    hive = on["hive"]

    async def crashed(admitted):
        return None
    monkeypatch.setattr(hive.research, "start", crashed)
    dispatch_research(client, on)
    row = row_of(hive)
    assert row["child_id"] is None
    monkeypatch.undo()
    run(hive.research.recover())
    row = row_of(hive)
    assert row["child_id"] and hive.db.one("SELECT assignee FROM goals WHERE id = ?", (row["goal_id"],))["assignee"] == row["child_id"]
    run(hive.research.recover())   # idempotent: still one researcher
    assert hive.db.one("SELECT COUNT(*) AS n FROM mind_children WHERE request_id = ?", (row["request_id"],))["n"] == 1


# ---- visibility ----------------------------------------------------------------------------------------------------------

def test_only_the_asker_and_admins_see_the_report(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids"])
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": fetched[0]["fetched_at"]}, None))
    rid, swarm = row["request_id"], research_swarm(hive)
    assert client.get(f"/api/research/{rid}", headers=on["ann"]).status_code == 200
    assert client.get(f"/api/research/{rid}", headers=on["jon"]).status_code == 200
    assert client.get(f"/api/research/{rid}", headers=on["bob"]).status_code == 404
    assert client.get("/api/research", headers=on["bob"]).json() == {"research": []}
    assert len(client.get("/api/research", headers=on["ann"]).json()["research"]) == 1
    assert len(client.get("/api/research?all=1", headers=on["jon"]).json()["research"]) == 1
    assert client.get("/api/research?all=1", headers=on["bob"]).json() == {"research": []}
    assert client.get(f"/api/swarms/{swarm['id']}", headers=on["bob"]).status_code == 404
    assert client.get(f"/api/goals/{row['goal_id']}", headers=on["bob"]).status_code == 404
    frame = next(json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events") if json.loads(r["frame"])["phase"] == "research")
    text = json.dumps({"type": "ask", **frame})
    assert hive.visibility.event_visible(Viewer("user:u_ann", False), text)
    assert not hive.visibility.event_visible(Viewer("user:u_bob", False), text)


def test_research_from_a_personal_mind_is_hidden_from_an_admins_default_lists(client, on):
    """P2-3: an admin sees another person's personal research only by explicit audit; the asker still reads it."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.personal.ensure("user:u_ann")
    personal = hive.db.one("SELECT swarm_id FROM agents WHERE personal_of = 'user:u_ann' AND deleted = 0")["swarm_id"]
    goal = hive.db.one("SELECT binding FROM goals WHERE id = ?", (row["goal_id"],))
    hive.db.execute("UPDATE goals SET binding = ? WHERE id = ?",
                    (json.dumps({**json.loads(goal["binding"]), "from_swarm": personal}), row["goal_id"]))
    hive.db.execute("UPDATE research_reports SET from_swarm = ? WHERE request_id = ?", (personal, row["request_id"]))
    sid = research_swarm(hive)["id"]
    assert client.get("/api/research?all=1", headers=on["jon"]).json() == {"research": []}
    assert len(client.get("/api/research?all=1&include=personal", headers=on["jon"]).json()["research"]) == 1
    assert client.get("/api/research?all=1&include=personal", headers=on["ann"]).status_code == 403
    assert len(client.get("/api/research", headers=on["ann"]).json()["research"]) == 1
    assert row["goal_id"] not in [g["id"] for g in client.get(f"/api/swarms/{sid}/goals", headers=on["jon"]).json()]
    assert row["goal_id"] in [g["id"] for g in client.get(f"/api/swarms/{sid}/goals?include=personal", headers=on["jon"]).json()]


def test_a_personal_turn_keeps_its_research_frame_content_free(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE ask_turns SET personal = 1 WHERE id = ?", (row["turn_id"],))
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids"])
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": fetched[0]["fetched_at"]}, None))
    stored = [json.loads(r["frame"]) for r in hive.db.all("SELECT frame FROM ask_events WHERE turn_id = ?", (row["turn_id"],))]
    research = [f for f in stored if f["phase"] == "research"]
    assert len(research) == 1 and research[0]["personal"] is True and "research" not in research[0]
    assert research[0]["request_id"] == row["request_id"] and research[0]["state"] == "done"
    assert "Brighter Cepheids" not in json.dumps(stored)
    assert hive.research.get(Viewer("user:u_ann", False), row["request_id"])["report"]["checks"]["cited"] == 1


def test_research_is_refused_in_plain_words_while_web_tools_are_off(client, on):
    hive = on["hive"]
    hive.settings.web_tools = False
    try:
        _s, fs, said = dispatch_research(client, on, op="op-res-web-off")
    finally:
        hive.settings.web_tools = True
    assert said == [cmod.DISPATCH_REFUSED_SAY["web_off"]] and not hive.db.one("SELECT 1 FROM ask_intents")


# ---- re-review round: live streams, the coordinator, spawn custody, retire timing, recovery -------------------------------

def make_personal(hive, row):
    """As if the research came from Ann's personal mind: its request's from_swarm is her personal swarm."""
    hive.personal.ensure("user:u_ann")
    personal = hive.db.one("SELECT swarm_id FROM agents WHERE personal_of = 'user:u_ann' AND deleted = 0")["swarm_id"]
    goal = hive.db.one("SELECT binding FROM goals WHERE id = ?", (row["goal_id"],))
    hive.db.execute("UPDATE goals SET binding = ? WHERE id = ?",
                    (json.dumps({**json.loads(goal["binding"]), "from_swarm": personal}), row["goal_id"]))
    hive.db.execute("UPDATE research_reports SET from_swarm = ? WHERE request_id = ?", (personal, row["request_id"]))
    return personal


def test_personal_research_never_reaches_an_admins_default_live_view_of_its_researcher(client, on):
    """P2-A: the brief carries no words of the person, and a researcher of personal research is hidden from an admin's
    default view (messages, traces, thinking, its HTTP message read) unless they audit."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    make_personal(hive, row)
    child = row["child_id"]
    message = hive.message_view(hive.db.one("SELECT * FROM messages WHERE agent_id = ?", (child,)))
    assert INSTRUCTION not in json.dumps(message)
    admin, audit = Viewer("user:u_jon", True), Viewer("user:u_jon", True, audit=True)
    for event in ({"type": "message", "message": message}, {"type": "agent.trace", "agent_id": child, "line": "x"},
                  {"type": "agent.thinking", "agent_id": child, "step": "x"}):
        assert not hive.visibility.event_visible(admin, json.dumps(event)), event["type"]
        assert hive.visibility.event_visible(audit, json.dumps(event)), event["type"]
    assert client.get(f"/api/agents/{child}/messages", headers=on["jon"]).status_code == 404
    assert client.get(f"/api/agents/{child}/messages?include=personal", headers=on["jon"]).status_code == 200


def test_the_researcher_of_ordinary_research_stays_in_an_admins_view(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    child = row_of(hive)["child_id"]
    assert hive.visibility.event_visible(Viewer("user:u_jon", True), json.dumps({"type": "agent.trace", "agent_id": child}))
    assert client.get(f"/api/agents/{child}/messages", headers=on["jon"]).status_code == 200


def test_the_coordinator_has_no_skills_sees_no_tasks_and_its_authority_is_the_hosts_alone(client, on):
    """P3-1."""
    hive = on["hive"]
    dispatch_research(client, on)
    row, ctl = row_of(hive), coordinator(hive)
    for skill in ("web-fetch", "hive-goals", "hive-goal-get", "hive-goal-claim", "send", "code-mind-spawn", "skill-help"):
        assert hive.policy.decide(ctl, skill)[0] == "deny", skill
    assert hive.research.visible_goals(ctl, hive.goals.list(ctl["swarm_id"])) == []
    view = hive.agent(ctl["id"])
    for call_ in (lambda: hive.minds.prompt(view, row["child_id"], {"operation_id": "op-prompt-1", "mode": "queued", "text": "hi",
                                                                     "expected_rev": 1}),
                  lambda: hive.minds.control(view, row["child_id"], {"operation_id": "op-ctl-0001", "action": "stop"}),
                  lambda: hive.minds.spawn(view, {"operation_id": "op-spawn-01", "request_id": row["request_id"],
                                                  "team_id": ctl["swarm_id"], "template_id": rmod.TEMPLATE})):
        with pytest.raises(HiveError) as e:
            run(call_())
        assert e.value.code == "host_only"
    with pytest.raises(HiveError) as e:
        hive.minds.templates_for(view, ctl["swarm_id"])
    assert e.value.code == "host_only"
    other = hive.agent(on["worker"]["id"])   # anyone else spawning the researcher template is refused too
    with pytest.raises(HiveError) as e:
        run(hive.minds.spawn(other, {"operation_id": "op-spawn-02", "template_id": rmod.TEMPLATE}))
    assert e.value.code == "host_only"


def test_research_spawn_limits_admit_only_a_research_requests_own_lease(client, on):
    """P3-2: the admin instruction path into the Research swarm, and a lease of any other request, are refused."""
    hive = on["hive"]
    owned(hive)
    sid, cid = research_swarm(hive)["id"], coordinator(hive)["id"]
    with pytest.raises(HiveError) as e:
        hive.minds._foundation_request_limits(sid, cid, {"lease": {}, "budget": {}}, None)
    assert e.value.code == "foundation_limits"
    import datetime
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    with pytest.raises(HiveError) as e:
        hive.minds._foundation_spawn_limits(cid, {"team_id": sid, "allocation_usd": 0.1, "template_id": rmod.TEMPLATE},
                                            {"id": "rq_other", "limit_usd": 0.1},
                                            {"id": "ls_other", "until": until, "max_children": 1,
                                             "template_ids": json.dumps([rmod.TEMPLATE])})
    assert e.value.code == "foundation_limits"


def test_the_researcher_is_retired_after_its_result_call_answers_not_inside_it(client, on):
    """P3-3."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids"])
    goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (row["goal_id"],))

    async def finish():
        await hive.goals.result(agent(hive, mind["id"]), row["goal_id"], "done", "Report ready",
                                {"proposal": report({"url": "https://example.org/cepheids", "fetched_at": fetched[0]["fetched_at"]}, None),
                                 "binding_digest": binding_digest(json.loads(goal["binding"]))})
        alive_at_answer = not agent(hive, mind["id"])["deleted"]
        await asyncio.sleep(0)
        return alive_at_answer
    assert run(finish()) is True
    assert _retired(hive, row)


def test_recovery_retires_a_researcher_whose_retire_a_restart_cut_off(client, on, monkeypatch):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    monkeypatch.setattr(hive.research, "_retire_later", lambda request_id: None)   # the process ended first
    hive.goals.update(row["goal_id"], {"status": "cancelled"})
    assert row_of(hive)["state"] == "cancelled" and not child_of(hive, row)["deleted"]
    monkeypatch.undo()
    run(hive.research.recover())
    assert _retired(hive, row)


def test_personal_research_erases_its_researchers_traces_and_keeps_the_report(client, on):
    """P3-4."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE ask_turns SET personal = 1 WHERE id = ?", (row["turn_id"],))
    memory = hive.settings.agents_dir / row["child_id"] / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    (memory / "notes.metta").write_text("(remembered ANN-PRIVATE)")
    tools = fake_web(client)
    mind = child_of(hive, row)
    hive.goals.claim(mind, row["goal_id"])
    run(tools.search(agent(hive, mind["id"]), {"query": "ANN-PRIVATE cepheid question"}))
    page = fetch(client, hive, mind["id"], "https://example.org/cepheids")
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": page["fetched_at"]}, None))
    assert _retired(hive, row) and not memory.exists()
    assert all(m["text"] == "" for m in hive.db.all("SELECT text FROM messages WHERE agent_id = ?", (mind["id"],)))
    assert all(p["text"] == "" for p in hive.db.all("SELECT text FROM mind_prompts WHERE child_id = ?", (mind["id"],)))
    assert "ANN-PRIVATE" not in json.dumps(hive.db.all("SELECT * FROM web_audit WHERE agent_id = ?", (mind["id"],)))
    assert hive.research.get(Viewer("user:u_ann", False), row["request_id"])["report"]["checks"]["cited"] == 1


def test_recovery_adopts_a_researcher_spawned_just_before_a_crash_and_resends_its_brief(client, on, monkeypatch):
    """P3-5."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE research_reports SET child_id = NULL WHERE request_id = ?", (row["request_id"],))
    hive.db.execute("UPDATE goals SET assignee = NULL WHERE id = ?", (row["goal_id"],))
    sent = []

    async def redeliver(child_id):
        sent.append(child_id)
    monkeypatch.setattr(hive.minds, "_redeliver", redeliver)
    run(hive.research.recover())
    assert row_of(hive)["child_id"] == row["child_id"] and sent == [row["child_id"]]
    assert hive.db.one("SELECT assignee FROM goals WHERE id = ?", (row["goal_id"],))["assignee"] == row["child_id"]
    assert hive.db.one("SELECT COUNT(*) AS n FROM mind_children WHERE request_id = ?", (row["request_id"],))["n"] == 1


def test_a_researcher_can_give_up_on_its_own_task(client, on):
    """P3-6."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind = child_of(hive, row)
    assert hive.policy.decide(mind, "hive-goal-fail")[0] == "allow"
    hive.goals.claim(mind, row["goal_id"])
    run(hive.goals.result(agent(hive, mind["id"]), row["goal_id"], "failed", "nothing reliable found"))
    assert row_of(hive)["state"] == "failed" and _retired(hive, row)


def test_an_address_fetched_with_a_query_is_a_path_match_even_when_cited_without_it(client, on):
    """P3-7: the audit dropped that fetch's query, so the citation cannot be an exact match."""
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    mind, fetched = _claim_and_fetch(client, hive, row["goal_id"], ["https://example.org/cepheids?utm=1"])
    _finish(hive, mind, row["goal_id"], report({"url": "https://example.org/cepheids", "fetched_at": fetched[0]["fetched_at"]}, None))
    c = hive.research.get(Viewer("user:u_ann", False), row["request_id"])["report"]["sections"][0]["claims"][0]["citations"][0]
    assert c["match"] == "path" and c["verified"] is False


def test_research_keeps_working_after_more_than_the_coordinators_cap_was_spent_in_past_months(client, on):
    """P3-8: researchers' past spend rolls into the coordinator's delegated books; its spawn ceiling is the Research
    month cap, not a lifetime $5."""
    hive = on["hive"]
    dispatch_research(client, on, op="op-res-past")
    old = row_of(hive)
    hive.goals.update(old["goal_id"], {"status": "cancelled"})
    assert _retired(hive, old)
    past = "2026-01-15T00:00:00.000Z"
    hive.db.execute("UPDATE agents SET spent_usd = 6.0 WHERE id = ?", (old["child_id"],))
    hive.db.insert("usage", {**{c["name"]: None for c in hive.db.all("PRAGMA table_info(usage)") if c["notnull"] == 0},
                             **_usage_row(hive, old["child_id"], 6.0, past)})
    hive.db.execute("UPDATE research_reports SET created_at = ? WHERE request_id = ?", (past, old["request_id"]))
    _s, _fs, said = dispatch_research(client, on, who="jon", op="op-res-now")
    assert said == [] and row_of(hive, "user:u_jon")["child_id"]


def _usage_row(hive, agent_id, cost, at):
    cols = {c["name"]: c for c in hive.db.all("PRAGMA table_info(usage)")}
    row = {"agent_id": agent_id, "cost_usd": cost, "created_at": at}
    defaults = {"INTEGER": 0, "REAL": 0.0, "TEXT": ""}
    for name, c in cols.items():
        if name not in row and c["notnull"] and c["dflt_value"] is None and not c["pk"]:
            row[name] = defaults.get(c["type"].upper(), "")
    if "id" in cols and cols["id"]["type"].upper() == "TEXT":
        row["id"] = "u_past_" + agent_id[-6:]
    return row


# ---- full-suite round: bare Policy, catalogues, erase depth, by-id reads, erase retry, coordinator cap ------------------

def test_a_policy_built_without_a_hive_still_decides(client):
    """Policy is built bare in some host paths and tests: the research rules then have nothing to apply to."""
    from hive.core.policy import Policy
    policy = Policy.__new__(Policy)
    policy.all_rules = lambda: []
    assert policy._decide({"id": "a_bare", "swarm_id": None}, "web-fetch")[0] == "allow"
    assert policy._decide({"id": "a_bare", "swarm_id": None}, "hive-goals")[0] == "allow"


def test_the_research_swarm_is_never_advertised_or_asked_by_a_cross_swarm_request(client, on):
    hive = on["hive"]
    owned(hive)
    sid = research_swarm(hive)["id"]
    hive.collab.set_services(sid, ["research"], "user:u_jon")   # even a person's offer does not open it
    catalogue = hive.collab.service_catalogue(on["swarm"]["id"])
    worker = hive.db.one("SELECT * FROM agents WHERE id = ?", (on["worker"]["id"],))
    goal = run(hive.goals.create(on["swarm"]["id"], "mine", created_by=f"agent:{worker['id']}"))
    hive.goals.claim(worker, goal["id"])
    with pytest.raises(HiveError) as e:
        run(hive.collab.create_request(worker, {"kind": "research", "to_swarm": sid, "title": "look this up",
                                                "from_goal": goal["id"]}))
    assert e.value.code == "not_offered"
    hive.collab.set_services(sid, [], "user:u_jon")
    hive.foundation.ensure()
    assert hive.collab.services(sid) == []
    assert all(o["provider_swarm"] != sid for o in hive.collab.service_catalogue(on["swarm"]["id"])["offers"])


def _personal_dispatch(client, on):
    hive = on["hive"]
    dispatch_research(client, on)
    row = row_of(hive)
    hive.db.execute("UPDATE ask_turns SET personal = 1 WHERE id = ?", (row["turn_id"],))
    make_personal(hive, row)
    return hive, row_of(hive)


def test_a_hidden_personal_researchers_by_id_reads_are_the_same_404_unless_audited(client, on):
    """R3 P3 (b)."""
    hive, row = _personal_dispatch(client, on)
    child = row["child_id"]
    paths = [f"/api/agents/{child}/traces", f"/api/agents/{child}/traces/archive",
             f"/api/agents/{child}/traces/archive/2026-11-10", f"/api/agents/{child}/logs",
             f"/api/agents/{child}/memory", f"/api/agents/{child}/memory/notes", f"/api/agents/{child}/messages"]
    for path in paths:
        r = client.get(path, headers=on["jon"])
        assert r.status_code == 404 and r.json()["error"]["message"] == "no such mind", path
    for path in paths[:2] + paths[3:5] + paths[6:]:
        assert client.get(path + "?include=personal", headers=on["jon"]).status_code == 200, path


def test_personal_research_erase_reaches_traces_and_the_trace_archive(client, on):
    """R3 P3 (a)."""
    hive, row = _personal_dispatch(client, on)
    child = row["child_id"]
    hive.db.insert("traces", {"agent_id": child, "iteration": 1, "input": "ANN-PRIVATE input", "response": "ANN-PRIVATE said",
                              "commands": "[]", "created_at": "2026-11-09T10:00:00.000Z"})
    hive.archive.archive_traces(child, keep=0)
    day = hive.archive.root / "traces" / child
    hive.db.insert("traces", {"agent_id": child, "iteration": 2, "input": "ANN-PRIVATE again", "response": "ANN-PRIVATE",
                              "commands": "[]", "created_at": now_stamp()})
    assert day.exists() and hive.archive.trace_days(child)
    hive.goals.update(row["goal_id"], {"status": "cancelled"})
    assert "ANN-PRIVATE" not in json.dumps(hive.db.all("SELECT * FROM traces WHERE agent_id = ?", (child,)))
    assert not day.exists() and not hive.archive.trace_days(child)


def now_stamp():
    from hive.core.db import now
    return now()


def test_a_failed_delete_leaves_the_erase_pending_and_retire_finished_completes_it(client, on, monkeypatch):
    """R3 P3 (c)."""
    hive, row = _personal_dispatch(client, on)

    def refused(*a, **k):
        raise HiveError(409, "stop_unverified", "the process could not be confirmed stopped")
    monkeypatch.setattr(hive, "delete_agent", refused)
    hive.goals.update(row["goal_id"], {"status": "cancelled"})
    assert row_of(hive)["erase_pending"] == 1
    assert any(m["text"] for m in hive.db.all("SELECT text FROM messages WHERE agent_id = ?", (row["child_id"],)))
    monkeypatch.undo()
    hive.research.retire_finished()
    assert row_of(hive)["erase_pending"] == 0 and child_of(hive, row)["deleted"]
    assert all(m["text"] == "" for m in hive.db.all("SELECT text FROM messages WHERE agent_id = ?", (row["child_id"],)))


def test_the_coordinators_own_lower_cap_still_bounds_its_month_ceiling(client, on, monkeypatch):
    """R3 P3 (d): min(month cap, budget_usd) when the coordinator has a cap of its own."""
    hive = on["hive"]
    owned(hive)
    ctl = coordinator(hive)
    monkeypatch.setenv("HIVE_RESEARCH_MONTH_USD", "50")
    assert hive.research.controller_month(ctl["id"]) == rmod.CONTROLLER_BUDGET_USD
    hive.db.execute("UPDATE agents SET budget_usd = 1.5 WHERE id = ?", (ctl["id"],))
    assert hive.research.controller_month(ctl["id"]) == 1.5
    hive.db.execute("UPDATE agents SET budget_usd = 0 WHERE id = ?", (ctl["id"],))
    assert hive.research.controller_month(ctl["id"]) == 50


def _settles(predicate, timeout=8.0):
    """True once predicate() holds. A route answers before the foundation's ensure it starts has run (the offer refresh
    runs on the app's loop, hive/core/offer_refresh.py), so a test reads the result after it settles."""
    end = time.time() + timeout
    while time.time() < end and not predicate():
        time.sleep(0.02)
    return predicate()


def _research_from(client, on, who, op):
    """One research request from `who`'s Ask turn with the foundation's swarms bound as the hive left them (no owned()),
    returning the dispatch tool's result."""
    s = script(client, Script([call("dispatch", kind="research.request",
                                    request={"title": "Cepheid distances", "instruction": INSTRUCTION},
                                    label="Research it")], "I've sent that off."))
    ask(client, on[who], op, text="can you look into Cepheids for me?", context=on["ctx"])
    _answers(on["hive"], op)
    return tool_results(s.bodies[1])[0]


def test_research_is_admitted_right_after_the_first_admin_is_made(client, on):
    """A hive whose first admin is made after it started (PATCH /api/people/{id}, the people page) binds its Research
    swarm to that admin at once, so research is admitted with no restart and no sign-in. Before, the swarm stayed bound
    to the operator until the hive restarted, and every hand-over was refused as no_researcher."""
    hive = on["hive"]
    # a hive as installed, with no admin yet: world() inserted Jon as an admin row, so he starts here as a member
    hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_jon'")
    hive.db.execute("DELETE FROM hive_owner")
    hive.foundation.ensure()
    assert hive.foundation._binding(RESEARCH)["principal"] == "user:operator"
    assert client.patch("/api/people/u_jon", json={"role": "admin"}).status_code == 200
    _settles(lambda: hive.foundation._binding(RESEARCH)["principal"] == "user:u_jon")
    result = _research_from(client, on, "ann", "op-res-first-admin")
    assert result["ok"] is True and result["state"] == "linked", result
    assert hive.foundation._binding(RESEARCH)["principal"] == "user:u_jon"


def test_research_follows_an_owner_claim_at_once(client, on):
    """An owner who stops being an admin leaves research waiting for a new owner, and an admin's claim
    (POST /api/hive/own/claim) binds Research to them at once, again with no restart."""
    hive = on["hive"]
    owned(hive)
    kim = person(client, "u_kim", "admin")
    assert client.patch("/api/people/u_jon", json={"role": "member"}).status_code == 200
    assert client.post("/api/hive/own/claim", headers=kim, json={}).status_code == 200
    _settles(lambda: hive.foundation._binding(RESEARCH)["principal"] == "user:u_kim")
    result = _research_from(client, on, "ann", "op-res-claimed")
    assert result["ok"] is True and result["state"] == "linked", result
    assert hive.foundation._binding(RESEARCH)["principal"] == "user:u_kim"
