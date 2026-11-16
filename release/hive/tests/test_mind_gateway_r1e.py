"""Personal-mind gateway r1e: the gateway's outcomes as advisory NAL evidence (the mindgateway commons).

Plan: PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN.md §2.7 (r1, r1.1, r1.2) and T-EV. Synthetic
people, PeTTa evaluation for the commons, no network and no provider calls. Each test fails on r1ab (dcfb952d); the
review request records each one's fail-before.
"""
import io
import json
import pathlib
import time
import tokenize

import pytest

from hive.core.db import now
from hive.core.hive import HiveError
from hive.core.visibility import Viewer
from hive.spaces import sexpr
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1 import (BROWSER, KA, PAT, add_key, ask, done_post, refusal, total, turn,  # noqa: F401
                                            world)
from hive.tests.test_visibility import person

CORE = pathlib.Path(__file__).resolve().parents[1] / "core"
COMMONS = "mindgateway"


def ev():
    from hive.core import mindgateway_evidence
    return mindgateway_evidence


def rows(hive):
    if not hive.db.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mindgateway_evidence'"):
        return []
    return hive.db.all("SELECT * FROM mindgateway_evidence ORDER BY n")


def belief(hive, statement):
    return hive.spaces.belief(COMMONS, statement)


@pytest.fixture()
def gw(client, monkeypatch):  # noqa: F811
    """HIVE_MIND_GATEWAY=1, conductor off; Ann (a member) with her personal mind (asleep), Jon an admin, Pat a member
    with an own key KA."""
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "0")
    w = world(client)
    hive = w["hive"]
    w["mine"] = hive._agent_row(hive.personal.ensure("user:u_ann")["id"])
    w["pat"] = person(client, PAT)
    add_key(hive, KA, f"user:{PAT}")
    w["pats"] = hive._agent_row(hive.personal.ensure(f"user:{PAT}")["id"])
    w["client"] = client
    rebuild(hive)
    clear_commons(hive)
    return w


def rebuild(hive):
    """The commons as a hive built under the current flag builds it: the shared client fixture's hive was built before
    the test set the flag, and the commons reads the flag once, at construction (r1de.3)."""
    from hive.core.mindgateway_evidence import MindGatewayEvidence
    hive.mindgateway = MindGatewayEvidence(hive)
    return hive.mindgateway


def clear_commons(hive):
    """The PeTTa interpreter is one per process (spaces/service.py), so &commons_mindgateway outlives a test's hive: each
    test starts with it empty, as a fresh hive's would be."""
    hive.spaces.run(f"!(collapse (match &commons_{COMMONS} $x (remove-atom &commons_{COMMONS} $x)))")
    assert hive.spaces.beliefs(COMMONS) == []


def closed_turn(gw, op, word):
    """A browser turn of Ann's, closed by her browser with this /done word; returns the turn row."""
    client = gw["client"]
    assert ask(client, gw["ann"], op, **BROWSER).status_code == 202
    assert done_post(client, gw["ann"], op, word).status_code == 200
    return turn(gw["hive"], op)


def ids_of(gw, *turns):
    """Every id and name that must never appear in an atom or an evidence row."""
    out = {"u_ann", "u_jon", "u_bob", PAT, gw["mine"]["id"], gw["mine"]["name"], gw["pats"]["id"], gw["swarm"]["id"],
           gw["coord"]["id"], gw["mine"]["swarm_id"]}
    for t in turns:
        out |= {t["id"], t["operation_id"], t["thread_id"]}
    return {str(x) for x in out if x}


# ---- T-EV1: a closed browser turn is evidence, with no person, mind, turn or words in it ------------------------------

def test_T_EV1_a_closed_turn_records_its_outcome_with_no_ids(gw):
    hive, model = gw["hive"], gw["mine"]["model"]
    m = ev()
    a = closed_turn(gw, "op-ev1-0001", "answered")
    b = closed_turn(gw, "op-ev1-0002", "spend_cap")
    got = [(r["statement"], r["f"]) for r in rows(hive)]
    assert got == [(m.within_cap_statement(model, gw["hive"].model_catalog()), 1.0), (m.complete_statement(model, gw["hive"].model_catalog()), 1.0),
                   (m.within_cap_statement(model, gw["hive"].model_catalog()), 0.0), (m.complete_statement(model, gw["hive"].model_catalog()), 0.0),
                   (m.refused_statement("spend_cap"), 1.0)]
    # the atoms: parsed, in &commons_mindgateway, stamped ev:hive-mindgateway:<n> at confidence 0.5 per observation
    atoms = {x["statement"]: x for x in hive.spaces.beliefs(COMMONS)}
    assert set(atoms) == {sexpr.render(sexpr.parse(s)) for s, _ in got}
    stamps = sorted(s for x in atoms.values() for s in x["stamp"])
    assert stamps == sorted(f"ev:hive-mindgateway:{r['n']}" for r in rows(hive))
    assert belief(hive, m.refused_statement("spend_cap"))["tv"] == {"f": 1.0, "c": pytest.approx(0.5)}
    # nothing identifying: not in the statements, the atoms' text, or the table's sources
    text = json.dumps([dict(r) for r in rows(hive)]) + json.dumps(hive.spaces.beliefs(COMMONS))
    for ident in ids_of(gw, a, b):
        assert ident not in text, ident
    assert all(r["source"].split(":")[0] in ("within", "complete", "cap") and len(r["source"].split(":")[1]) == 32
               for r in rows(hive))
    assert "private" not in text and "what changed" not in text


@pytest.mark.parametrize("word,within,complete,cap", [("answered", 1.0, 1.0, None), ("incomplete", 1.0, 0.0, None),
                                                      ("failed", 1.0, 0.0, None), ("stopped", 1.0, 0.0, None),
                                                      ("spend_cap", 0.0, 0.0, "spend_cap")])
def test_T_EV1_each_close_word_maps_to_its_observations(gw, word, within, complete, cap):
    m = ev()
    closed_turn(gw, "op-ev1-word", word)
    got = {r["statement"]: r["f"] for r in rows(gw["hive"])}
    model = gw["mine"]["model"]
    want = {m.within_cap_statement(model, gw["hive"].model_catalog()): within, m.complete_statement(model, gw["hive"].model_catalog()): complete}
    if cap:
        want[m.refused_statement(cap)] = 1.0
    assert got == want


def test_T_EV1_cap_hits_at_close_time_cap_and_call_cap(gw):
    hive, m = gw["hive"], ev()
    client = gw["client"]
    assert ask(client, gw["ann"], "op-ev1-time", **BROWSER).status_code == 202
    hive.ask.expire(turn(hive, "op-ev1-time")["deadline"] + 1)                       # the absolute deadline: time_cap
    assert ask(client, gw["ann"], "op-ev1-call", **BROWSER).status_code == 202
    hive.ask._close(turn(hive, "op-ev1-call")["id"], "refused", "call_cap")       # the gateway's 51st call (r1c)
    got = [(r["statement"], r["f"]) for r in rows(hive)]
    model = gw["mine"]["model"]
    assert got == [(m.within_cap_statement(model, gw["hive"].model_catalog()), 0.0), (m.complete_statement(model, gw["hive"].model_catalog()), 0.0),   # r1e.1: time_cap is a cap
                   (m.refused_statement("time_cap"), 1.0),
                   (m.within_cap_statement(model, gw["hive"].model_catalog()), 0.0), (m.complete_statement(model, gw["hive"].model_catalog()), 0.0),
                   (m.refused_statement("call_cap"), 1.0)]


# ---- T-EV2: the atoms revise as the governance commons' do (lib_hive, k = 1) ---------------------------------------

def test_T_EV2_observations_revise_in_the_commons(gw):
    hive, m = gw["hive"], ev()
    model = gw["mine"]["model"]
    for i in range(3):
        closed_turn(gw, f"op-ev2-{i:04d}", "answered")
    tv = belief(hive, m.within_cap_statement(model, gw["hive"].model_catalog()))["tv"]
    assert tv["f"] == 1.0 and tv["c"] == pytest.approx(0.75)                        # three observations: 3/(3+1)
    closed_turn(gw, "op-ev2-0003", "spend_cap")
    tv = belief(hive, m.within_cap_statement(model, gw["hive"].model_catalog()))["tv"]
    assert tv["f"] == pytest.approx(0.75) and tv["c"] == pytest.approx(0.8)           # 3 of 4, c = 4/5
    assert belief(hive, m.complete_statement(model, gw["hive"].model_catalog()))["tv"]["f"] == pytest.approx(0.75)
    assert len(belief(hive, m.within_cap_statement(model, gw["hive"].model_catalog()))["sources"]) >= 1


# ---- T-EV3: the source is a hash of the id, so a retried record is a no-op -----------------------------------------

def test_T_EV3_a_retried_record_is_a_no_op(gw):
    hive, m = gw["hive"], ev()
    t = closed_turn(gw, "op-ev3-0001", "answered")
    before = [dict(r) for r in rows(hive)]
    hive.mindgateway.turn_closed(t["id"], gw["mine"]["model"], "complete")             # the same close recorded again
    assert done_post(gw["client"], gw["ann"], "op-ev3-0001", "answered").status_code == 200   # a repeated /done
    assert [dict(r) for r in rows(hive)] == before
    assert belief(hive, m.within_cap_statement(gw["mine"]["model"], gw["hive"].model_catalog()))["tv"]["c"] == pytest.approx(0.5)
    hive.mindgateway.call_refused("call-1", "call_cap")
    hive.mindgateway.call_refused("call-1", "call_cap")
    hive.mindgateway.call_reported("res-1", gw["mine"]["model"], True)
    hive.mindgateway.call_reported("res-1", gw["mine"]["model"], True)
    assert len(rows(hive)) == len(before) + 2
    assert rows(hive)[-1]["source"] == m.hashed("usage", "res-1") and "res-1" not in rows(hive)[-1]["source"]


# ---- T-EV4: turn-bound refusals by kind; the own-key bound refusal; nothing for any other caller --------------------

def test_T_EV4_turn_bound_refusals_are_recorded_by_kind_only(gw):
    hive, m = gw["hive"], ev()
    P, mine = f"user:{PAT}", gw["pats"]
    e = refusal(hive.check_budget, mine, True, 0.05, KA, P, True, turn_bound=True, evidence_id="call-a")
    assert e.details["reason"] == "monthly_total_required"                          # the own-key bound refusal
    refusal(hive.check_budget, mine, True, 0.05, KA, P, True, turn_bound=True, evidence_id="call-a")   # a retry
    total(hive, P, 0.01)                                                           # a total too small for the call
    e = refusal(hive.check_budget, mine, True, 0.05, KA, P, True, turn_bound=True, evidence_id="call-b")
    assert e.code == "spend_limit" and e.details["scope"].startswith("keyuse:")
    got = [(r["statement"], r["f"]) for r in rows(hive)]
    assert got == [(m.refused_statement("monthly_total_required"), 1.0), (m.refused_statement("own_key_limit"), 1.0)]
    text = json.dumps([dict(r) for r in rows(hive)]) + json.dumps(hive.spaces.beliefs(COMMONS))
    assert PAT not in text and mine["id"] not in text and "keyuse" not in text and "call-a" not in text
    # an unknown kind is "other", never the raw word
    assert m.refused_statement("person:u_1b1b1b1b") == "(--> (x other browser-turn) refused)"
    # no evidence id: each refusal is one observation (a nonce), still no id
    refusal(hive.check_budget, mine, True, 0.05, KA, P, True, turn_bound=True)
    assert len(rows(hive)) == 3


def test_T_EV4_callers_that_are_not_turn_bound_record_nothing(gw):
    """Control (passes on r1ab too): no caller but the gateway's turn-bound one writes evidence."""
    hive = gw["hive"]
    P, mine = f"user:{PAT}", gw["pats"]
    assert refusal(hive.check_budget, mine, True, 0.05, KA, P, True).code == "no_budget"
    hive.check_budget(mine, True, 0.05, None, P, False)                              # admitted: nothing either
    assert rows(hive) == [] and hive.spaces.beliefs(COMMONS) == []
    assert ask(gw["client"], gw["ann"], "op-ev4-ord", context={"swarm_id": gw["swarm"]["id"]}).status_code == 202
    hive.ask.stop(Viewer("user:u_ann", False), "op-ev4-ord")
    assert rows(hive) == []                                                        # an ordinary turn is not the gateway's


# ---- T-EV5: the flag off records nothing and creates nothing ---------------------------------------------------------

def test_T_EV5_flag_off_records_nothing(gw, monkeypatch):
    hive = gw["hive"]
    assert ask(gw["client"], gw["ann"], "op-ev5-0001", **BROWSER).status_code == 202
    monkeypatch.delenv("HIVE_MIND_GATEWAY")
    rebuild(hive)                                           # a hive built with the flag off
    hive.ask._close(turn(hive, "op-ev5-0001")["id"], "done", "answered")
    refusal(hive.check_budget, gw["pats"], True, 0.05, KA, f"user:{PAT}", True, turn_bound=True)
    hive.mindgateway.call_reported("r", "m/x", True)
    assert hive.db.one("SELECT 1 FROM sqlite_master WHERE name = 'mindgateway_evidence'") is None
    assert hive.spaces.beliefs(COMMONS) == []


@pytest.mark.parametrize("built", ["off", "on"])
def test_r1de3_the_flag_is_read_once_when_the_commons_is_built(gw, monkeypatch, built):
    """Kimi r1de.2 P3 #4: a hive built with the flag off never starts recording when the environment changes later, and
    one built with it on keeps recording as built."""
    hive = gw["hive"]
    if built == "off":
        monkeypatch.delenv("HIVE_MIND_GATEWAY")
        rebuild(hive)
        monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")       # flipped on after the build
    else:
        monkeypatch.setenv("HIVE_MIND_GATEWAY", "0")       # flipped off after the build
    hive.mindgateway.call_reported("r-1", "m/x", True)
    hive.mindgateway.call_refused("c-1", "call_cap")
    assert len(rows(hive)) == (0 if built == "off" else 2)


# ---- T-EV6: a failed record never blocks -----------------------------------------------------------------------------

@pytest.mark.parametrize("where", ["publish", "table"])
def test_T_EV6_a_failed_record_never_blocks(gw, monkeypatch, where):
    hive = gw["hive"]
    events = []
    real = hive.events.publish
    monkeypatch.setattr(hive.events, "publish", lambda kind, **kw: (events.append(kind), real(kind, **kw))[1])

    def boom(*a, **k):
        raise RuntimeError("petta down")
    if where == "publish":
        monkeypatch.setattr(hive.spaces, "publish", boom)
    else:
        monkeypatch.setattr(type(hive.mindgateway), "commons", lambda self: boom())
    t = closed_turn(gw, "op-ev6-0001", "answered")
    assert t["state"] == "done" and t["reason"] == "answered"
    e = refusal(hive.check_budget, gw["pats"], True, 0.05, KA, f"user:{PAT}", True, turn_bound=True)
    assert e.details["reason"] == "monthly_total_required"                          # its own refusal, not the failure
    assert "mindgateway.evidence_failed" in events
    from hive.core.visibility import event_rule
    assert event_rule("mindgateway.evidence_failed") == "admin"


# ---- T-EV-READ: who can read the commons (the plan's unverified point, verified) ---------------------------------------

def test_T_EV_READ_only_admins_read_the_commons(gw):
    hive, client, m = gw["hive"], gw["client"], ev()
    closed_turn(gw, "op-evr-0001", "answered")
    stmt = m.within_cap_statement(gw["mine"]["model"], gw["hive"].model_catalog())
    url = f"/api/swarms/{COMMONS}/beliefs/detail"
    r = client.get(url, headers=gw["jon"], params={"statement": stmt})                 # an admin person
    assert r.status_code == 200 and r.json()["tv"]["f"] == 1.0
    assert client.get(url, params={"statement": stmt}).status_code == 200            # the operator (admin)
    for who in ("ann", "bob", "pat"):                                                # members, the asker included
        r = client.get(url, headers=gw[who], params={"statement": stmt})
        assert r.status_code == 404, who
    for path in ("beliefs", "vocab"):                                                # no swarm row: 404 for everyone
        assert client.get(f"/api/swarms/{COMMONS}/{path}", headers=gw["jon"]).status_code == 404
        assert client.get(f"/api/swarms/{COMMONS}/{path}", headers=gw["ann"]).status_code == 404
    # a mind reads only its own swarm's commons
    with pytest.raises(HiveError) as e:
        hive.agent_belief(gw["coord"]["id"], stmt)
    assert e.value.status == 404
    assert hive.query(gw["coord"]["id"], "(--> $x within-cap)")["results"] == []
    # no swarm can be made with the commons' id (ids are generated)
    assert client.post("/api/swarms", json={"name": COMMONS, "id": COMMONS}).json()["id"] != COMMONS


# ---- T-EV-ADV: advisory only. Admission, reservation, payer and routing never read the commons ------------------------

# the evidence module is the only place that may read it; every other mention must be one of these write sites
WRITE_SITES = {("hive.py", "self.mindgateway = MindGatewayEvidence"), ("hive.py", "from .mindgateway_evidence import MindGatewayEvidence"),
               ("hive.py", "from .mindgateway_evidence import refusal_kind"), ("hive.py", "self.mindgateway.call_refused"),
               ("ask.py", "hive.mindgateway.turn_closed"),
               ("mind_gateway.py", "getattr(hive.mindgateway, method)")}   # r1de.2: the gateway's call path (r1c)
READS = ("track_record", "belief", "beliefs", "query", "commons", "_commons", "mindgateway_evidence")


def _code_lines(path):
    """The file's code with comments and strings blanked (docstrings say what they like), line by line."""
    src = path.read_text()
    out = [list(line) for line in src.splitlines()]
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type in (tokenize.COMMENT, tokenize.STRING):
            (r0, c0), (r1, c1) = tok.start, tok.end
            for r in range(r0, r1 + 1):
                line = out[r - 1]
                a = c0 if r == r0 else 0
                b = c1 if r == r1 else len(line)
                for i in range(a, min(b, len(line))):
                    line[i] = " "
    return ["".join(x) for x in out], src.splitlines()


def test_T_EV_ADV_static_scan_no_decision_code_reads_the_commons():
    found = set()
    for path in sorted(CORE.glob("*.py")):
        if path.name in ("mindgateway_evidence.py",):
            continue
        code, raw = _code_lines(path)
        for i, line in enumerate(code):
            if "mindgateway" in line:
                site = next((s for f, s in WRITE_SITES if f == path.name and s in line), None)
                assert site is not None, f"{path.name}:{i + 1}: {raw[i].strip()}"
                found.add((path.name, site))
                tail = line.split("mindgateway", 1)[1]
                assert not any(f".{r}" in tail for r in READS), f"{path.name}:{i + 1} reads the commons"
            # the table and the commons by name: only the evidence module spells them (strings included)
            assert "mindgateway_evidence" not in raw[i] or "import" in raw[i], f"{path.name}:{i + 1}"
            assert "commons_mindgateway" not in raw[i], f"{path.name}:{i + 1}"
    assert found == WRITE_SITES                                                    # every write site, and only those


DECISION_CODE = [("ask.py", "Ask", ("_decide", "_admit", "_route", "browser_turn", "_payer_conflict", "_quota_ok", "submit",
                                    "_validate", "month_remaining", "done")),
                 ("hive.py", "Hive", ("_check_budget", "payer_for")),
                 ("budgets.py", "Budgets", None), ("cost_reservations.py", "Reservations", None),
                 ("cost_reservations.py", None, ("host_budget_snapshot", "host_subjects", "settled_usd")),
                 ("ownhive.py", "OwnHive", None), ("gated_call.py", "GatedCall", None),
                 ("personal.py", None, None), ("sessions.py", "Sessions", None),
                 ("mind_gateway.py", "MindGateway", ("purpose", "turn", "body", "_count_turn", "_remaining", "chat", "_call")),
                 ("mind_idempotency.py", "MindIdempotency", None)]   # gate A r1.1: chat's body moved into _call


def test_T_EV_ADV_admission_reservation_and_payer_functions_never_touch_evidence():
    """Control (passes on r1ab too, and must keep passing): the decision functions never mention any evidence store."""
    import ast
    seen = 0
    for fname, cls, names in DECISION_CODE:
        tree = ast.parse((CORE / fname).read_text())
        scope = tree
        if cls:
            scope = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls)
        for node in ast.walk(scope):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or (names and node.name not in names):
                continue
            seen += 1
            src = ast.unparse(node)
            body = ast.unparse(ast.Module(body=[s for s in node.body if not (isinstance(s, ast.Expr) and
                                                                               isinstance(getattr(s, "value", None), ast.Constant))],
                                          type_ignores=[]))
            for word in ("mindgateway", "governance", "placement.evidence", "_evidence", "track_record", "spaces.belief",
                         "spaces.query"):
                assert word not in body, f"{fname}:{node.name} mentions {word}"
            assert src
    assert seen > 40


# ---- T-EV (plan §5): decisions are identical with 1,000 adverse atoms present -----------------------------------------

def _decisions(gw, tag):
    """Every gateway decision the host makes today, as plain values: admission of a browser turn and of a refused one,
    the turn-bound budget check (none, under, over), the reservation rows, the payer, and a /done close."""
    from hive.core.cost_reservations import host_budget_snapshot, host_subjects
    hive, client = gw["hive"], gw["client"]
    P, pats = f"user:{PAT}", gw["pats"]
    out = {}
    hive.db.execute("DELETE FROM key_limits")
    for label, usd in (("none", None), ("room", 10.0), ("tight", 0.01)):
        if usd is not None:
            hive.db.execute("DELETE FROM key_limits")
            total(hive, P, usd)
        hive.llm_calls.clear()   # the per-minute call ceiling is not what is compared here
        try:
            hive.check_budget(pats, True, 0.05, KA, P, True, turn_bound=True, evidence_id=f"{tag}-{label}")
            out[f"check-{label}"] = "admit"
        except HiveError as e:
            out[f"check-{label}"] = (e.status, e.code, (e.details or {}).get("reason"), (e.details or {}).get("kind"))
        try:
            snap = host_budget_snapshot(hive, pats["id"], KA, P, True, turn_bound=True)
            out[f"rows-{label}"] = sorted((s, round(l, 6), round(sp, 6)) for s, l, sp in snap)
        except ValueError as e:
            out[f"rows-{label}"] = str(e)
        out[f"subjects-{label}"] = sorted(host_subjects(hive, pats["id"], KA, P, True, turn_bound=True))
        out[f"bound-{label}"] = hive.budgets.own_key_bound(pats, P, True, KA, True)
    out["payer"] = hive.payer_for(pats, f"user:{PAT}")
    r = ask(client, gw["ann"], f"op-{tag}-1", **BROWSER)
    out["admit"] = (r.status_code, r.json().get("state"), r.json().get("route"), r.json().get("cap_usd"))
    out["browser_turn"] = hive.ask.browser_turn(Viewer("user:u_ann", False), gw["mine"])
    r = ask(client, gw["ann"], f"op-{tag}-2", **BROWSER)                              # busy: one turn at a time
    out["busy"] = (r.status_code, r.json()["error"]["code"])
    r = ask(client, gw["bob"], f"op-{tag}-3", **BROWSER)                              # no personal mind routed
    out["other"] = (r.status_code, r.json()["error"]["code"])
    d = done_post(client, gw["ann"], f"op-{tag}-1", "spend_cap").json()
    out["done"] = (d["state"], d.get("reason"), d.get("outcome"))
    return out


def _flood(hive, n, adverse):
    """n observations straight into the commons and its table (the same record path), adverse or favourable."""
    m = ev()
    gm = hive.mindgateway.commons()
    model = hive._agent_row(hive.personal.ensure("user:u_ann")["id"])["model"]
    kinds = ["monthly_total_required", "own_key_limit", "member_allowance", "call_cap", "spend_cap", "time_cap"]
    for i in range(n):
        which = i % 4
        if which == 0:
            gm.record(f"flood:{adverse}:{i}", m.within_cap_statement(model, hive.model_catalog()), not adverse)
        elif which == 1:
            gm.record(f"flood:{adverse}:{i}", m.complete_statement(model, hive.model_catalog()), not adverse)
        elif which == 2:
            gm.record(f"flood:{adverse}:{i}", m.usage_statement(model, hive.model_catalog()), not adverse)
        else:
            gm.record(f"flood:{adverse}:{i}", m.refused_statement(kinds[(i // 4) % len(kinds)]), adverse)


def test_T_EV_decisions_are_identical_with_1000_adverse_atoms(gw):
    hive, m = gw["hive"], ev()
    model = gw["mine"]["model"]
    base = _decisions(gw, "base")
    start = time.time()
    _flood(hive, 1000, adverse=True)
    assert belief(hive, m.within_cap_statement(model, gw["hive"].model_catalog()))["tv"]["f"] < 0.01             # the commons now says "never"
    assert belief(hive, m.within_cap_statement(model, gw["hive"].model_catalog()))["tv"]["c"] >= 0.99                 # lib_hive caps confidence at 0.99
    for kind in ("monthly_total_required", "own_key_limit", "member_allowance", "call_cap", "spend_cap", "time_cap"):
        tv = belief(hive, m.refused_statement(kind))["tv"]
        assert tv["f"] == 1.0 and tv["c"] > 0.97                                      # ~42 observations each
    flooded = _decisions(gw, "adverse")
    assert flooded == base, {k: (base[k], flooded[k]) for k in base if base[k] != flooded[k]}
    _flood(hive, 400, adverse=False)                                                # and flipped the other way
    assert _decisions(gw, "favour") == base
    assert time.time() - start < 600


# ---- T-EV7 (r1e.1, stand-in P1): only a catalogued model name reaches an atom; anything else is other-model ----------

PRIVATE = ("u_ann", "private-client-diagnosis", "a_1b1b1b1b", "openrouter/private-client-diagnosis", "mock/u_ann",
           "Ann's husband is ill")


@pytest.mark.parametrize("value", PRIVATE)
def test_T_EV7_an_uncatalogued_model_is_other_model(value):
    m = ev()
    assert m.within_cap_statement(value) == "(--> (x other-model browser-turn) within-cap)"
    assert m.complete_statement(value) == "(--> (x other-model browser-turn) complete)"
    assert m.usage_statement(value) == "(--> (x other-model call) usage-reported)"
    assert m.within_cap_statement(value, frozenset({"mock/echo"})) == "(--> (x other-model browser-turn) within-cap)"


def test_T_EV7_a_catalogued_model_keeps_its_name(gw):
    hive, m = gw["hive"], ev()
    catalog = hive.model_catalog()
    assert "mock/echo" in catalog and "anthropic/claude-sonnet-5-5" in catalog      # the configured providers' models
    assert m.within_cap_statement("mock/echo", catalog) == "(--> (x mock_echo browser-turn) within-cap)"
    hive.providers.catalog["models"] = [{"id": "vendor/fetched-model"}]              # the live OpenRouter catalogue
    assert "openrouter/vendor/fetched-model" not in hive.model_catalog()             # r1e.2: fetched ids never name


@pytest.mark.parametrize("value", ["private-client-diagnosis", "u_ann", "mock/u_ann"])
def test_T_EV7_a_mind_edited_to_a_private_model_publishes_other_model(gw, value):
    hive = gw["hive"]
    hive.db.execute("UPDATE agents SET model = ? WHERE id = ?", (value, gw["mine"]["id"]))   # any stored value
    t = closed_turn(gw, "op-ev7-0001", "answered")
    hive.mindgateway.call_reported("res-ev7", value, True)
    statements = [r["statement"] for r in rows(hive)]
    assert statements == ["(--> (x other-model browser-turn) within-cap)", "(--> (x other-model browser-turn) complete)",
                          "(--> (x other-model call) usage-reported)"]
    text = json.dumps([dict(r) for r in rows(hive)]) + json.dumps(hive.spaces.beliefs(COMMONS))
    for ident in ids_of(gw, t) | {value, "private", "diagnosis"}:
        assert ident not in text, ident


# ---- T-EV8 (r1e.2, stand-in P1): a fetched OpenRouter catalogue entry is not a naming source ---------------------------

@pytest.mark.parametrize("fetched", ["vendor/private-client-diagnosis", "vendor/u_ann"])
def test_T_EV8_a_crafted_fetched_catalogue_entry_publishes_other_model(gw, fetched):
    hive = gw["hive"]
    hive.providers.catalog["models"] = [{"id": fetched, "name": fetched}]             # crafted entry in the live catalogue
    value = f"openrouter/{fetched}"                                                 # and a mind stored with that model
    hive.db.execute("UPDATE agents SET model = ? WHERE id = ?", (value, gw["mine"]["id"]))
    t = closed_turn(gw, "op-ev8-0001", "answered")
    hive.mindgateway.call_reported("res-ev8", value, True)
    statements = [r["statement"] for r in rows(hive)]
    assert statements == ["(--> (x other-model browser-turn) within-cap)", "(--> (x other-model browser-turn) complete)",
                          "(--> (x other-model call) usage-reported)"]
    text = json.dumps([dict(r) for r in rows(hive)]) + json.dumps(hive.spaces.beliefs(COMMONS))
    for ident in ids_of(gw, t) | {fetched.split("/")[1], "private", "diagnosis", "vendor"}:
        assert ident not in text, ident
