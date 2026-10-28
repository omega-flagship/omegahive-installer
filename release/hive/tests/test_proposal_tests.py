"""Linkage slice 4: the host side of the proposal-test plane (linkage spec r3.6 §b; settlement wire answers OPEN-18).

The proposal_test purpose branch of POST /api/agent/code/capability (b.1/b.2), its live status through the real
GET /api/services/capabilities/{id} (c.1/c.2), the service-authenticated preparation binding (b.5), run and time holds
(b.6) and the settlement and hold wire (b.6.1). Each test names the §E acceptance row(s) it covers (B, P, W ids).
Synthetic only: fake supervisor, mock models, a fake Code service row; no Code process, no provider calls, no spawn."""
import concurrent.futures
import datetime
import hashlib
import json
import re
import secrets
import threading

import pytest

from hive.core.db import now
from hive.core.hive import HiveError
from hive.core.minds import canonical, sha
from hive.core.proposal_tests import ProposalTests
from hive.core.services import ACTIONS, DELEGATED_ACTIONS, PROPOSAL_TEST_ACTIONS, ServiceError
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import accepted, enabled, person, service, spawn, w  # noqa: F401  (fixture)

WS = "ws_" + "a1" * 16
FORK = "ws_" + "b2" * 16
SCOPE_DIGEST = "sha256:" + "cd" * 32
SUGGESTION = "suggestion_" + "0f" * 16
P_DIGEST = "sha256:" + "ee" * 32
H_DIGEST = "sha256:" + "dd" * 32
TREE = "sha256:" + "77" * 32
TEST_TREE = "sha256:" + "88" * 32
PREP = "sha256:" + "99" * 32
ARGV = "sha256:" + "aa" * 32
ARGV_PREFIXES = [["python", "-m", "pytest"]]
CAP = "/api/agent/code/capability"
CLAIM_KEYS = {"id", "iss", "aud", "actor", "kind", "task_id", "swarm_id", "repository_id", "actions", "paths", "argv_prefixes",
              "iat", "exp", "max_runs", "max_runtime_seconds", "member_hash", "grant_id", "proposal_test"}
MS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")


def origin(w, **over):
    return {"task_id": w.task["id"], "repository_id": "synthetic", "workspace_id": WS, "scope_id": "scope_1",
            "scope_digest": SCOPE_DIGEST, "generation": 1} | over


def proposal(pid=SUGGESTION, digest=P_DIGEST):
    return {"proposal_id": pid, "proposal_digest": digest, "normalized_hunks_digest": H_DIGEST}


def create_body(rq, op="op-ptest-0001", **over):
    inner = {"operation_id": op, "request_id": rq["request_id"], "proposal": proposal(), "parent": {"generation": 1, "tree_digest": TREE}}
    inner.update(over)
    return {"service": "omegacode", "proposal_test": inner}


@pytest.fixture()
def pw(w, monkeypatch):
    monkeypatch.setattr(type(w.hive.code), "_loaded_release_mismatch", lambda self: None)   # no Code LaunchAgent in tests
    w.svc = service(w)
    w.service = w.hive.db.one("SELECT * FROM services WHERE id = 'svc_code'")
    w.hive.settings.proposal_test_claims = True
    w.hive.settings.proposal_test_argv_prefixes = ARGV_PREFIXES
    w.rq = accepted(w, origin=origin(w))
    return w


def other_service(w):
    token = secrets.token_urlsafe(24)
    w.hive.db.insert("services", {"id": "svc_other", "name": "othersvc", "version": "1", "address": "http://127.0.0.1:8725",
                                  "contract": "other/1", "surfaces": "[]", "capabilities": "[]",
                                  "token_hash": hashlib.sha256(token.encode()).hexdigest(), "capability_secret": "s2",
                                  "registered_at": now()})
    return {"Authorization": f"Bearer {token}"}


def error(out):
    return out.json()["error"]


def create(w, rq=None, agent=None, **over):
    return w.client.post(CAP, headers=agent_headers(agent or w.ctl), json=create_body(rq or w.rq, **over))


def created(w, **over):
    out = create(w, **over)
    assert out.status_code == 200, out.text
    return out.json()["claims"]


def reissue(w, test_id, stage=None, agent=None):
    inner = {"test_id": test_id} | ({"stage": stage} if stage else {})
    return w.client.post(CAP, headers=agent_headers(agent or w.ctl), json={"service": "omegacode", "proposal_test": inner})


def bind_body(claims, **over):
    pt = claims["proposal_test"]
    body = {"capability_id": claims["id"], "operation_id": "op-bind-0001", "fork_workspace_id": FORK,
            "proposal": dict(pt["proposal"]), "parent": dict(pt["parent"]), "test_tree_digest": TEST_TREE,
            "preparation_digest": PREP}
    body.update(over)
    return body


def bind(w, test_id, body, headers=None):
    return w.client.post(f"/api/services/proposal-tests/{test_id}/preparation", headers=headers or w.svc, json=body)


def status(w, cap_id, headers=None):
    out = w.client.get(f"/api/services/capabilities/{cap_id}", headers=headers or w.svc)
    assert out.status_code == 200, out.text
    return out.json()


def prepared(w, **over):
    """create -> bind -> re-issue run: (test_id, run claims)."""
    claims = created(w, **over)
    test_id = claims["proposal_test"]["test_id"]
    assert bind(w, test_id, bind_body(claims)).status_code == 201
    run = reissue(w, test_id)
    assert run.status_code == 200, run.text
    return test_id, run.json()["claims"]


def admit(w, test_id, cap_id, key="launch-0001", seconds=100, headers=None, **over):
    body = {"capability_id": cap_id, "launch_key": key, "argv_digest": ARGV, "runtime_seconds": seconds} | over
    return w.client.post(f"/api/services/proposal-tests/{test_id}/holds", headers=headers or w.svc, json=body)


def admitted(w, test_id, cap_id, key="launch-0001", seconds=100):
    out = admit(w, test_id, cap_id, key, seconds)
    assert out.status_code == 201, out.text
    return out.json()["hold_id"]


def sb(outcome="completed", run_id="run_A", seconds=37, provenance="executor_measured", stopped=True,
       observed_at="2026-10-06T12:00:00.123Z", state="ended", rev=3, receipt=None):
    return {"outcome": outcome, "run_id": run_id, "runtime": {"seconds": seconds, "provenance": provenance},
            "cleanup": {"descendants_stopped": stopped, "observed_at": observed_at},
            "evidence": {"launch_record_state": state, "launch_record_rev": rev}, "receipt_digest": receipt}


def unknown(i=0, run_id=None):
    return sb("unknown", run_id, None, "unknown", False, None, "spawning" if run_id is None else "running", i)


def settle(w, test_id, hold_id, body, raw=None, headers=None):
    return w.client.post(f"/api/services/proposal-tests/{test_id}/holds/{hold_id}/settle", headers=headers or w.svc,
                         content=raw if raw is not None else json.dumps(body), )


def snapshot(w, test_id, hold_id):
    out = w.client.get(f"/api/services/proposal-tests/{test_id}/holds/{hold_id}", headers=w.svc)
    assert out.status_code == 200, out.text
    assert out.content == canonical(out.json()).encode()
    return out.json()


def by_key(w, test_id, key):
    out = w.client.get(f"/api/services/proposal-tests/{test_id}/holds", headers=w.svc, params={"launch_key": key})
    assert out.status_code == 200, out.text
    return out


def held(w):
    return {t: w.hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in
            ("capabilities", "mind_operations", "proposal_tests", "proposal_test_holds", "hold_observations")}


def rows(w, hold_id):
    return w.hive.db.all("SELECT * FROM hold_observations WHERE hold_id = ? ORDER BY seq", (hold_id,))


def past(**delta):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(**delta)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---- a reader of the b.6.1 wire, as Code's rule states it (checks a-l, rules 1-3) -----------------------------------

ALLOWED = {("dispatched", "unknown"), ("dispatched", "settled"), ("dispatched", "released"), ("unknown", "unknown"),
           ("unknown", "settled")}


def snapshot_valid(snap):
    hold, obs = snap["hold"], snap["observations"]
    n = len(obs)
    ints = ("runtime_seconds_max", "charged_seconds", "overrun_seconds", "observation_count")
    if any(type(hold[k]) is not int for k in ints) or any(type(o["seq"]) is not int for o in obs):
        return False                                                                          # l
    if [o["seq"] for o in obs] != list(range(1, n + 1)) or n != hold["observation_count"] or n > 16:
        return False                                                                          # a, b
    if (n == 0 and hold["state"] != "dispatched") or (n and obs[0]["state_before"] != "dispatched"):
        return False                                                                          # c
    if any(obs[i]["state_before"] != obs[i - 1]["state_after"] for i in range(1, n)) or (n and obs[-1]["state_after"] != hold["state"]):
        return False                                                                          # d
    if any((o["state_before"], o["state_after"]) not in ALLOWED for o in obs):
        return False                                                                          # e
    terminal = [i for i, o in enumerate(obs) if o["state_after"] in ("settled", "released")]
    if len(terminal) > 1 or (terminal and terminal[0] != n - 1) or sum(o["state_after"] == "unknown" for o in obs) > 15:
        return False                                                                          # f
    digests = [o["body_digest"] for o in obs]
    if len(set(digests)) != n or any(o["body_digest"] != sha(canonical(o["body"])) for o in obs):
        return False                                                                          # g
    try:
        for o in obs:
            ProposalTests._settle_body(ProposalTests.__new__(ProposalTests), o["body"])       # h
    except HiveError:
        return False
    first = next((i for i, o in enumerate(obs) if o["body"]["run_id"] is not None), None)    # i
    if first is None:
        if hold["run_id"] is not None:
            return False
    elif hold["run_id"] is None or obs[first]["body"]["run_id"] != hold["run_id"] \
            or any(o["body"]["run_id"] != hold["run_id"] for o in obs[first:]):
        return False
    combo = (hold["state"], hold["cleanup"], hold["accounting"])                             # j
    mx, ch, ov = hold["runtime_seconds_max"], hold["charged_seconds"], hold["overrun_seconds"]
    if combo in (("dispatched", "unobserved", "reserved_max"), ("unknown", "unobserved", "reserved_max"),
                 ("settled", "observed", "reserved_max")):
        if (ch, ov) != (mx, 0):
            return False
    elif combo[:2] == ("settled", "observed") and combo[2] in ("executor_measured", "wall_clock_bound"):
        last = obs[-1]["body"]["runtime"]
        if last["provenance"] != combo[2] or ch != last["seconds"] or ch < 1 or ov != max(0, ch - mx):
            return False
    elif combo == ("released", "observed", "none"):
        if (ch, ov) != (0, 0):
            return False
    else:
        return False
    stamps = [o["received_at"] for o in obs]                                                  # k
    if not all(isinstance(s, str) and MS.fullmatch(s) for s in stamps + [hold["created_at"]]) or stamps != sorted(stamps):
        return False
    if (hold["settled_at"] is not None) != (hold["state"] in ("settled", "released")) or \
            (hold["settled_at"] is not None and not MS.fullmatch(hold["settled_at"])):
        return False
    return True


def acknowledged(body, snap):
    """Rules 1-3 (r3.6 history-relative run association), only on a valid snapshot."""
    if not snapshot_valid(snap):
        return False
    hold, obs = snap["hold"], snap["observations"]
    match = next((o for o in obs if o["body_digest"] == sha(canonical(body)) and canonical(o["body"]) == canonical(body)), None)
    if match is None:
        return False
    if body["run_id"] is not None:
        if body["run_id"] != hold["run_id"]:
            return False
    elif hold["run_id"] is not None:
        first = next((o for o in obs if o["body"]["run_id"] is not None), None)
        if first is None or not match["seq"] < first["seq"] or first["body"]["run_id"] != hold["run_id"]:
            return False
    return obs[-1]["state_after"] == hold["state"]


# ---- off by default (B9) ----------------------------------------------------------------------------------------

def test_B9_off_by_default_refuses_before_anything_is_written_and_delegated_is_unaffected(w, monkeypatch):
    monkeypatch.setattr(type(w.hive.code), "_loaded_release_mismatch", lambda self: None)
    service(w)
    assert w.hive.settings.proposal_test_claims is False
    rq = accepted(w, origin=origin(w))
    before = held(w)
    out = w.client.post(CAP, headers=agent_headers(w.ctl), json=create_body(rq))
    assert out.status_code == 503 and error(out)["code"] == "proposal_tests_off"
    assert held(w) == before
    w.hive.settings.proposal_test_claims = True           # switched on but no operator argv prefixes: still off
    out = w.client.post(CAP, headers=agent_headers(w.ctl), json=create_body(rq))
    assert out.status_code == 503 and error(out)["code"] == "proposal_tests_off" and held(w) == before
    w.hive.settings.proposal_test_claims = False
    enabled(w)                                             # delegated issuance is unaffected by the switch
    child = spawn(w, rq["request_id"]).json()["child_id"]
    out = w.client.post(CAP, headers={"Authorization": f"Bearer {w.tokens[child]}"}, json={"delegated": True})
    assert out.status_code == 200, out.text


def test_B9_the_switch_and_argv_prefixes_come_from_the_launcher_environment(monkeypatch, tmp_path):
    from hive.core.config import load_settings
    for value, expected in (("on", True), ("1", False), ("true", False), ("", False)):
        monkeypatch.setenv("HIVE_PROPOSAL_TEST_CLAIMS", value)
        assert load_settings(data_dir=tmp_path).proposal_test_claims is expected, value
    for raw, expected in (('[["python", "-m", "pytest"]]', [["python", "-m", "pytest"]]), ("[[]]", []), ('["python"]', []),
                          ("nope", []), ("", [])):
        monkeypatch.setenv("HIVE_PROPOSAL_TEST_ARGV_PREFIXES", raw)
        assert load_settings(data_dir=tmp_path).proposal_test_argv_prefixes == expected, raw


# ---- b.1/b.2 issuance and claims ----------------------------------------------------------------------------------

def test_B1_B20_create_bind_reissue_claims(pw):
    claims = created(pw)
    assert set(claims) == CLAIM_KEYS
    assert (claims["iss"], claims["aud"], claims["actor"], claims["kind"]) == ("hive", "svc_code", pw.ctl["id"], "agent")
    assert (claims["task_id"], claims["swarm_id"], claims["repository_id"]) == (pw.task["id"], pw.origin["id"], "synthetic")
    assert claims["actions"] == ["proposal-test"] and claims["paths"] == [] and claims["argv_prefixes"] == ARGV_PREFIXES
    assert claims["max_runs"] == 0 and claims["max_runtime_seconds"] == 600 and claims["grant_id"] == pw.grant["id"]
    assert claims["member_hash"] == hashlib.sha256(pw.ctl["token"].encode()).hexdigest()
    pt = claims["proposal_test"]
    lease = pw.hive.db.one("SELECT * FROM mind_leases WHERE id = ?", (pw.rq["lease_id"],))
    until = datetime.datetime.fromisoformat(lease["until"].replace("Z", "+00:00")).timestamp()
    assert 0 < claims["exp"] - claims["iat"] <= 900 and claims["exp"] <= until
    assert re.fullmatch(r"pt_[0-9a-f]{24}", pt["test_id"])
    assert pt == {"purpose": "proposal-test", "stage": "prepare", "test_id": pt["test_id"], "request_id": pw.rq["request_id"],
                  "lease_id": pw.rq["lease_id"], "controller_id": pw.ctl["id"], "execution_goal": pw.rq["receiving_goal"],
                  "issuer": "user:u_quinn", "origin_scope": {"scope_id": "scope_1", "scope_digest": SCOPE_DIGEST, "generation": 1},
                  "proposal": proposal(), "parent": {"workspace_id": WS, "generation": 1, "tree_digest": TREE},
                  "fork": {"workspace_id": None, "preparation_digest": None},
                  "allowance": {"until": lease["until"], "per_launch_max_runtime_seconds": 600,
                                "test": {"runs_remaining": 4, "runtime_seconds_remaining": 600},
                                "request": {"runs_remaining": 8, "runtime_seconds_remaining": 1800},
                                "usd": {"metered": False, "status": "unknown", "advisory_remaining_usd": None}}}   # B20
    assert pt["allowance"]["usd"]["advisory_remaining_usd"] is None and not [v for v in pt["allowance"]["usd"].values() if type(v) is float]
    assert bind(pw, pt["test_id"], bind_body(claims)).status_code == 201
    run = reissue(pw, pt["test_id"]).json()["claims"]
    assert run["proposal_test"]["stage"] == "run" and run["grant_id"] == pw.grant["id"]
    assert run["proposal_test"]["fork"] == {"workspace_id": FORK, "preparation_digest": PREP}
    st = status(pw, run["id"])
    assert st["active"] is True and st["reason"] is None and st["stage"] == "run" and st["claims"] == run
    assert st["lease"] == {"lease_id": pw.rq["lease_id"], "state": "active", "until": lease["until"]}
    assert st["test"] == {"test_id": pt["test_id"], "state": "open", "ended_reason": None,
                          "bound_fork": {"workspace_id": FORK, "preparation_digest": PREP}, "admission_closed": None}
    assert st["origin"] == {"grant": "active", "task": "open", "request": "open"}
    cols = {r["name"] for r in pw.hive.db.all("PRAGMA table_info(proposal_test_holds)")}
    assert not [c for c in cols if "usd" in c]                                                # B20: no admission uses USD


def test_B1_exp_is_the_lease_end_when_that_comes_first(pw):
    until = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=120)
    pw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?",
                       (until.isoformat(timespec="milliseconds").replace("+00:00", "Z"), pw.rq["lease_id"]))
    claims = created(pw)
    assert claims["exp"] == int(until.timestamp())
    assert claims["proposal_test"]["allowance"]["per_launch_max_runtime_seconds"] <= 120


def test_B2_a_child_is_never_the_controller_and_purposes_are_exclusive(pw):
    enabled(pw)
    child = spawn(pw, pw.rq["request_id"]).json()["child_id"]
    out = pw.client.post(CAP, headers={"Authorization": f"Bearer {pw.tokens[child]}"}, json=create_body(pw.rq))
    assert out.status_code == 403 and error(out)["code"] == "not_controller" and error(out)["reason"] == "delegated_child"
    out = pw.client.post(CAP, headers={"Authorization": f"Bearer {pw.tokens[child]}"},
                         json={"delegated": True, "proposal_test": create_body(pw.rq)["proposal_test"]})
    assert out.status_code == 400 and error(out)["code"] == "purpose_exclusive"


def test_B3_another_teams_coordinator_or_a_non_controller(pw):
    for agent in (pw.fctl, pw.helper):
        before = held(pw)
        out = create(pw, agent=agent)
        assert out.status_code == 403 and error(out)["code"] == "not_controller", out.text
        assert held(pw) == before


def test_B4_generic_actions_are_refused_at_issue(pw):
    for actions in (["read"], ["workspace"], ["edit"], ["run"], ["cancel"], ["proposal-test", "read"]):
        out = pw.client.post(CAP, headers=agent_headers(pw.ctl), json=create_body(pw.rq) | {"actions": actions})
        assert out.status_code == 400 and error(out)["code"] == "bad_actions", actions
    out = pw.client.post(CAP, headers=agent_headers(pw.ctl), json=create_body(pw.rq) | {"delegated": True})
    assert out.status_code == 400 and error(out)["code"] == "purpose_exclusive"
    assert "proposal-test" not in ACTIONS | DELEGATED_ACTIONS and PROPOSAL_TEST_ACTIONS == {"proposal-test"}
    from hive.core.code import HUMAN_ACTIONS
    assert "proposal-test" not in HUMAN_ACTIONS
    services = pw.hive.services
    with pytest.raises(ServiceError) as caught:   # Services.issue refuses generic actions on a proposal_test claim
        services.issue("svc_code", actor=pw.ctl["id"], kind="agent", task_id=pw.task["id"], swarm_id=None, repository_id="r",
                       actions=["read"], argv_prefixes=ARGV_PREFIXES, max_runs=0, max_runtime_seconds=600,
                       member_token=pw.ctl["token"], grant_id=pw.grant["id"], proposal_test={"stage": "run"}, exp=10 ** 10)
    assert caught.value.code == "bad_actions"
    with pytest.raises(ServiceError) as caught:   # and an ordinary capability can never carry "proposal-test"
        services.issue("svc_code", actor=pw.ctl["id"], kind="agent", task_id=pw.task["id"], swarm_id=None, repository_id="r",
                       actions=["proposal-test"], member_token=pw.ctl["token"])
    assert caught.value.code == "bad_actions"
    with pytest.raises(ServiceError) as caught:   # never an ordinary run grant
        services.issue("svc_code", actor=pw.ctl["id"], kind="agent", task_id=pw.task["id"], swarm_id=None, repository_id="r",
                       actions=["proposal-test"], argv_prefixes=ARGV_PREFIXES, max_runs=1, max_runtime_seconds=600,
                       member_token=pw.ctl["token"], grant_id=pw.grant["id"], proposal_test={"stage": "run"}, exp=10 ** 10)
    assert caught.value.code == "bad_purpose"


@pytest.mark.parametrize("over", [
    {"parent": {"workspace_id": WS, "generation": 1, "tree_digest": TREE}},       # B5: caller-supplied parent workspace
    {"fork_workspace_id": FORK},                                                 # B5
    {"proposal": proposal(pid="suggestion_" + "0F" * 16)},                       # B10
    {"proposal": proposal(pid="suggestion_short")},                              # B10
    {"proposal": proposal(digest="ee" * 32)},                                    # bare digest: the sha256: domain is required
    {"proposal": {"proposal_id": SUGGESTION, "proposal_digest": P_DIGEST}},
    {"parent": {"generation": 0, "tree_digest": TREE}},
    {"parent": {"generation": True, "tree_digest": TREE}},
    {"operation_id": "short"},
    {"request_id": "nope"},
])
def test_B5_B10_body_values_match_their_patterns_and_refusals_write_nothing(pw, over):
    before = held(pw)
    out = create(pw, **over)
    assert out.status_code == 400 and error(out)["code"] == "bad_request", out.text
    assert held(pw) == before


def test_B5_the_parent_is_the_requests_origin_and_a_non_code_origin_is_refused(pw):
    assert created(pw)["proposal_test"]["parent"]["workspace_id"] == WS
    rq = accepted(pw, operation_id="op-request-2", origin=origin(pw, workspace_id="ws_1"))   # not a ws_<32 hex> scope
    out = create(pw, rq=rq, op="op-ptest-0002")
    assert out.status_code == 409 and error(out)["code"] == "origin_invalid"


def test_B6_replacement_ends_the_older_test_and_issuing_on_it_is_test_ended(pw):
    old = created(pw)
    old_id = old["proposal_test"]["test_id"]
    new = created(pw, op="op-ptest-0002", proposal=proposal(digest="sha256:" + "e1" * 32))
    row = pw.hive.db.one("SELECT * FROM proposal_tests WHERE id = ?", (old_id,))
    assert row["ended_reason"] == "replaced" and row["ended_at"]
    out = reissue(pw, old_id)
    assert out.status_code == 409 and error(out)["code"] == "test_ended"
    st = status(pw, old["id"])
    assert st["active"] is False and st["reason"] == "test_ended" and st["lease"]["state"] == "replaced"
    assert st["test"]["state"] == "ended" and st["test"]["ended_reason"] == "replaced"
    assert status(pw, new["id"])["active"] is True


def test_B7_a_ninth_open_test_is_test_limit(pw):
    for i in range(8):
        created(pw, op=f"op-ptest-{i:04d}", proposal=proposal(pid=f"suggestion_{i:032x}"))
    before = held(pw)
    out = create(pw, op="op-ptest-0009", proposal=proposal(pid=f"suggestion_{9:032x}"))
    assert out.status_code == 409 and error(out)["code"] == "test_limit" and held(pw) == before


def test_B8_creation_replay_returns_the_same_test_and_a_different_payload_conflicts(pw):
    first = created(pw)
    again = created(pw)
    assert again["proposal_test"]["test_id"] == first["proposal_test"]["test_id"] and again["id"] != first["id"]
    assert pw.hive.db.one("SELECT COUNT(*) AS n FROM proposal_tests")["n"] == 1
    out = create(pw, parent={"generation": 2, "tree_digest": TREE})
    assert out.status_code == 409 and error(out)["code"] == "operation_conflict"


def test_P6_P7_prepare_claims_are_null_forked_and_a_bound_test_reissues_run(pw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    again = reissue(pw, test_id).json()["claims"]                       # unbound default: prepare
    assert again["proposal_test"]["stage"] == "prepare" and again["proposal_test"]["fork"] == {"workspace_id": None, "preparation_digest": None}
    out = reissue(pw, test_id, "run")
    assert out.status_code == 409 and error(out)["code"] == "not_bound"
    assert bind(pw, test_id, bind_body(claims)).status_code == 201
    for cap in (claims, again):                                          # P6: never fork_mismatch/stage_mismatch for prepare
        st = status(pw, cap["id"])
        assert st["active"] is True and st["reason"] is None and st["claims"]["proposal_test"]["fork"]["workspace_id"] is None
        assert st["test"]["bound_fork"] == {"workspace_id": FORK, "preparation_digest": PREP}
    run = reissue(pw, test_id).json()["claims"]                          # P7
    assert run["proposal_test"]["stage"] == "run" and run["proposal_test"]["fork"] == {"workspace_id": FORK, "preparation_digest": PREP}
    out = reissue(pw, test_id, "prepare")
    assert out.status_code == 409 and error(out)["code"] == "already_bound"
    assert error(out)["bound_fork"] == {"workspace_id": FORK, "preparation_digest": PREP}
    for body in ({"test_id": test_id, "fork_workspace_id": FORK}, {"test_id": test_id, "stage": "other"}, {"test_id": "pt_x"}):
        out = pw.client.post(CAP, headers=agent_headers(pw.ctl), json={"service": "omegacode", "proposal_test": body})
        assert out.status_code == 400, body


# ---- b.5 preparation binding -----------------------------------------------------------------------------------------

def test_B11_bind_authentication_digest_replay_and_fork(pw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    body = bind_body(claims)
    assert bind(pw, test_id, body, headers=agent_headers(pw.ctl)).status_code == 401
    out = pw.client.post(f"/api/services/proposal-tests/{test_id}/preparation", params={"token": "x"}, json=body)
    assert out.status_code == 401                                        # the hive's operator session is not a service token
    out = bind(pw, test_id, body, headers=other_service(pw))
    assert out.status_code == 403 and error(out)["code"] == "service_mismatch"
    out = bind(pw, test_id, bind_body(claims, proposal=proposal(digest="sha256:" + "e1" * 32)))
    assert out.status_code == 409 and error(out)["code"] == "fork_mismatch"
    assert pw.hive.db.one("SELECT preparation FROM proposal_tests WHERE id = ?", (test_id,))["preparation"] is None
    first = bind(pw, test_id, body)
    assert first.status_code == 201 and first.content == canonical(first.json()).encode()
    answer = first.json()
    assert set(answer) == {"test_id", "fork_workspace_id", "test_tree_digest", "preparation_digest", "bound_at"}
    assert MS.fullmatch(answer["bound_at"])
    shuffled = json.dumps(dict(reversed(list(body.items()))), indent=2)
    again = pw.client.post(f"/api/services/proposal-tests/{test_id}/preparation", headers=pw.svc, content=shuffled)
    assert again.status_code == 201 and again.content == first.content
    out = bind(pw, test_id, bind_body(claims, operation_id="op-bind-0002", fork_workspace_id="ws_" + "c3" * 16))
    assert out.status_code == 409 and error(out)["code"] == "fork_mismatch"
    out = bind(pw, test_id, bind_body(claims, fork_workspace_id="ws_bad"))
    assert out.status_code == 400


def test_B12_P4_a_first_bind_after_withdrawal_binds_nothing(pw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    pw.client.post(f"/api/requests/{pw.rq['request_id']}/cancel", headers=pw.quinn)
    out = bind(pw, test_id, bind_body(claims))
    assert out.status_code == 403 and error(out)["code"] == "capability_withdrawn" and error(out)["reason"] == "request_closed"
    assert pw.hive.db.one("SELECT preparation FROM proposal_tests WHERE id = ?", (test_id,))["preparation"] is None


@pytest.mark.parametrize("withdraw", ["cancel", "lease_expired", "capability_expired", "revoked"])
def test_P2_a_committed_bind_replays_byte_for_byte_after_any_withdrawal(pw, withdraw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    first = bind(pw, test_id, bind_body(claims))
    assert first.status_code == 201
    if withdraw == "cancel":
        pw.client.post(f"/api/requests/{pw.rq['request_id']}/cancel", headers=pw.quinn)
    elif withdraw == "lease_expired":
        pw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), pw.rq["lease_id"]))
    elif withdraw == "capability_expired":
        pw.hive.db.execute("UPDATE capabilities SET expires_at = 1 WHERE id = ?", (claims["id"],))
    else:
        assert pw.client.delete(f"/api/services/capabilities/{claims['id']}").status_code == 200
    assert status(pw, claims["id"])["active"] is False
    before = held(pw)
    again = bind(pw, test_id, bind_body(claims))
    assert again.status_code == 201 and again.content == first.content and held(pw) == before


@pytest.mark.parametrize("field,value", [
    ("fork_workspace_id", "ws_" + "c3" * 16), ("proposal", proposal(digest="sha256:" + "e1" * 32)),
    ("proposal", {"proposal_id": SUGGESTION, "proposal_digest": P_DIGEST, "normalized_hunks_digest": "sha256:" + "d1" * 32}),
    ("preparation_digest", "sha256:" + "91" * 32), ("test_tree_digest", "sha256:" + "81" * 32),
    ("parent", {"workspace_id": WS, "generation": 2, "tree_digest": TREE}), ("capability_id", None)])
def test_P3_an_altered_bind_is_refused_and_changes_nothing(pw, field, value):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    assert bind(pw, test_id, bind_body(claims)).status_code == 201
    if field == "capability_id":
        value = reissue(pw, test_id, "result").json()["claims"]["id"]        # another capability of this same test
    row = pw.hive.db.one("SELECT * FROM proposal_tests WHERE id = ?", (test_id,))
    same_op = bind(pw, test_id, bind_body(claims, **{field: value}))
    assert same_op.status_code == 409 and error(same_op)["code"] == "operation_conflict", same_op.text
    other_op = bind(pw, test_id, bind_body(claims, operation_id="op-bind-0009", **{field: value}))
    assert other_op.status_code == 409 and error(other_op)["code"] == "fork_mismatch", other_op.text
    assert pw.hive.db.one("SELECT * FROM proposal_tests WHERE id = ?", (test_id,)) == row


def test_P9_replay_with_another_services_token_or_another_tests_capability(pw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    first = bind(pw, test_id, bind_body(claims))
    out = bind(pw, test_id, bind_body(claims), headers=other_service(pw))
    assert out.status_code == 403 and error(out)["code"] == "service_mismatch" and FORK not in out.text
    other = created(pw, op="op-ptest-0002", proposal=proposal(pid="suggestion_" + "1a" * 16))
    out = bind(pw, test_id, bind_body(claims, capability_id=other["id"]))
    assert out.status_code == 403 and error(out)["code"] == "service_mismatch" and first.json()["bound_at"] not in out.text


# ---- c.2 status of prepare/run/result claims (B13, B45, B46, B50, P5) ---------------------------------------------------

def test_P5_a_run_claim_whose_fork_differs_from_the_bound_fork_is_fork_mismatch(pw):
    test_id, run = prepared(pw)
    for fork in ({"workspace_id": "ws_" + "c3" * 16, "preparation_digest": PREP}, {"workspace_id": FORK, "preparation_digest": "sha256:" + "91" * 32}):
        forged = dict(run, proposal_test=dict(run["proposal_test"], fork=fork))
        pw.hive.db.execute("UPDATE capabilities SET claims = ? WHERE id = ?", (canonical(forged), run["id"]))
        st = status(pw, run["id"])
        assert st["active"] is False and st["reason"] == "fork_mismatch"


def test_B13_B45_a_result_claim_survives_origin_losses_but_reaches_no_hold(pw):
    test_id, run = prepared(pw)
    result = reissue(pw, test_id, "result").json()["claims"]
    pt = result["proposal_test"]
    assert result["grant_id"] is None and pt["origin_grant_id"] == pw.grant["id"] and pt["stage"] == "result"
    assert pt["fork"] == {"workspace_id": FORK, "preparation_digest": PREP} and 0 < result["exp"] - result["iat"] <= 900
    pw.hive.services.revoke_grant(pw.task["id"], pw.grant["id"])                 # the real revocation sweep
    pw.hive.db.execute("UPDATE goals SET status = 'done' WHERE id = ?", (pw.task["id"],))
    pw.client.post(f"/api/requests/{pw.rq['request_id']}/cancel", headers=pw.quinn)
    pw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), pw.rq["lease_id"]))
    st = status(pw, result["id"])
    assert st["active"] is True and st["reason"] is None and st["stage"] == "result"
    assert st["origin"] == {"grant": "withdrawn", "task": "closed", "request": "closed"} and st["lease"]["state"] == "revoked"
    assert pw.hive.db.one("SELECT revoked_at FROM capabilities WHERE id = ?", (result["id"],))["revoked_at"] is None
    assert status(pw, run["id"])["reason"] == "revoked"                          # the run claim carried the grant: revoked
    again = reissue(pw, test_id, "result")                                       # B13: still issued after the lease lapsed
    assert again.status_code == 200, again.text
    out = admit(pw, test_id, result["id"])                                       # B13: a result claim never admits a hold
    assert out.status_code == 403 and error(out)["code"] == "capability_withdrawn" and error(out)["reason"] == "not_run_stage"
    out = bind(pw, test_id, bind_body(result))          # not the retained original (another capability id): refused
    assert out.status_code == 409 and error(out)["code"] == "operation_conflict"


def test_B13_a_result_claim_for_a_non_controller_is_refused(pw):
    test_id, _ = prepared(pw)
    out = reissue(pw, test_id, "result", agent=pw.helper)
    assert out.status_code == 403 and error(out)["code"] == "not_controller"
    out = reissue(pw, test_id, "result", agent=pw.fctl)
    assert out.status_code == 403 and error(out)["code"] == "not_controller"


@pytest.mark.parametrize("cause,reason", [("delete", "revoked"), ("expire", "expired"), ("controller", "not_controller"),
                                          ("child", "delegated_child")])
def test_B46_a_result_claim_is_inactive_for_its_own_end_or_its_controller(pw, cause, reason):
    test_id, _ = prepared(pw)
    result = reissue(pw, test_id, "result").json()["claims"]
    if cause == "delete":
        assert pw.client.delete(f"/api/services/capabilities/{result['id']}").status_code == 200
    elif cause == "expire":
        pw.hive.db.execute("UPDATE capabilities SET expires_at = 1 WHERE id = ?", (result["id"],))
    elif cause == "controller":
        pw.client.patch(f"/api/swarms/{pw.team['id']}", json={"coordinator_id": pw.helper["id"]})
    else:
        pw.hive.db.insert("mind_children", {"id": pw.ctl["id"], "seq": 999, "controller_id": "x", "team_id": pw.team["id"],
                                            "request_id": pw.rq["request_id"], "lease_id": pw.rq["lease_id"], "template_id": "native-a",
                                            "model_id": "mock/echo", "lifecycle_mode": "ongoing", "lifecycle_limits": None,
                                            "state": "running", "prompt_rev": 1, "created_at": now(), "updated_at": now()})
    st = status(pw, result["id"])
    assert st["active"] is False and st["reason"] == reason


def test_B46_a_result_claim_ends_with_the_tests_seven_day_window(pw):
    test_id, _ = prepared(pw)
    result = reissue(pw, test_id, "result").json()["claims"]
    pw.hive.db.execute("UPDATE proposal_tests SET ended_at = ?, ended_reason = 'replaced' WHERE id = ?", (past(days=6), test_id))
    assert status(pw, result["id"])["active"] is True
    pw.hive.db.execute("UPDATE proposal_tests SET ended_at = ? WHERE id = ?", (past(days=8), test_id))
    assert status(pw, result["id"])["reason"] == "test_ended"
    out = reissue(pw, test_id, "result")
    assert out.status_code == 409 and error(out)["code"] == "test_ended"


def test_B50_the_generic_checks_still_apply_outside_the_result_stage(pw):
    test_id, run = prepared(pw)
    plain = pw.hive.services.issue("svc_code", actor="user:u_quinn", kind="human", task_id=pw.task["id"], swarm_id=pw.origin["id"],
                                   repository_id="synthetic", actions=["read"], grant_id=pw.grant["id"])["claims"]
    pw.hive.db.execute("UPDATE goal_grants SET expires_at = 1 WHERE id = ?", (pw.grant["id"],))
    assert status(pw, run["id"])["reason"] == "grant_withdrawn" and status(pw, plain["id"])["reason"] == "grant_withdrawn"
    pw.hive.db.execute("UPDATE goal_grants SET expires_at = 9e12 WHERE id = ?", (pw.grant["id"],))
    pw.hive.db.execute("UPDATE goals SET status = 'done' WHERE id = ?", (pw.task["id"],))
    assert status(pw, run["id"])["reason"] == "task_closed" and status(pw, plain["id"])["reason"] == "task_closed"
    pw.hive.db.execute("UPDATE goals SET status = 'claimed' WHERE id = ?", (pw.task["id"],))
    pw.hive.services.revoke_grant(pw.task["id"], pw.grant["id"])
    assert status(pw, run["id"])["reason"] == "revoked" and status(pw, plain["id"])["reason"] == "revoked"


@pytest.mark.parametrize("cause,reason", [
    (lambda w: w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn), "request_closed"),
    (lambda w: w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), w.rq["lease_id"])), "lease_expired"),
    (lambda w: w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'"), "lease_revoked"),
    (lambda w: w.client.patch(f"/api/swarms/{w.team['id']}", json={"coordinator_id": w.helper["id"]}), "not_controller"),
])
def test_run_claim_status_follows_the_lease_request_and_controller(pw, cause, reason):
    test_id, run = prepared(pw)
    cause(pw)
    st = status(pw, run["id"])
    assert st["active"] is False and st["reason"] == reason


# ---- b.6 admission ----------------------------------------------------------------------------------------------------

def test_admission_answer_and_service_ownership(pw):
    test_id, run = prepared(pw)
    out = admit(pw, test_id, run["id"], headers=agent_headers(pw.ctl))
    assert out.status_code == 401
    out = admit(pw, test_id, run["id"], headers=other_service(pw))
    assert out.status_code == 403 and error(out)["code"] == "service_mismatch"
    out = admit(pw, test_id, run["id"], seconds=True)
    assert out.status_code == 400
    out = admit(pw, test_id, run["id"], seconds=601)
    assert out.status_code == 400
    out = admit(pw, test_id, run["id"], key="short")
    assert out.status_code == 400
    out = admit(pw, test_id, run["id"])
    assert out.status_code == 201 and out.content == canonical(out.json()).encode()
    answer = out.json()
    assert set(answer) == {"hold_id", "launch_key", "state", "runtime_seconds", "allowance"}
    assert re.fullmatch(r"ph_[0-9a-f]{24}", answer["hold_id"]) and answer["state"] == "dispatched" and answer["runtime_seconds"] == 100
    assert answer["allowance"]["test"] == {"runs_remaining": 3, "runtime_seconds_remaining": 500}
    assert answer["allowance"]["request"] == {"runs_remaining": 7, "runtime_seconds_remaining": 1700}
    out = admit(pw, test_id, run["id"], argv_digest="sha256:" + "ab" * 32)     # same key, another body
    assert out.status_code == 409 and error(out)["code"] == "operation_conflict"
    prepare = created(pw, op="op-ptest-0002", proposal=proposal(pid="suggestion_" + "1a" * 16))
    out = admit(pw, prepare["proposal_test"]["test_id"], prepare["id"])
    assert out.status_code == 403 and error(out)["reason"] == "not_run_stage"
    big = pw.client.post(f"/api/services/proposal-tests/{test_id}/holds", headers=pw.svc,
                         content=json.dumps({"capability_id": run["id"], "pad": "x" * 17000}))
    assert big.status_code == 413


def test_admission_needs_a_bound_test_with_a_run_claim(pw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    out = admit(pw, test_id, claims["id"])
    assert out.status_code == 403 and error(out)["reason"] == "not_run_stage"
    assert pw.hive.db.one("SELECT COUNT(*) AS n FROM proposal_test_holds")["n"] == 0


def test_B14_B15_runs_are_counted_per_test_across_tokens(pw):
    test_id, a = prepared(pw)
    for i in range(3):
        admitted(pw, test_id, a["id"], key=f"launch-a-{i:04d}")
    b = reissue(pw, test_id).json()["claims"]                                    # B15: token B after holds under A
    assert b["proposal_test"]["allowance"]["test"] == {"runs_remaining": 1, "runtime_seconds_remaining": 300}
    admitted(pw, test_id, b["id"], key="launch-b-0004")
    for cap in (a, b):                                                           # A is not replenished by B
        before = held(pw)
        out = admit(pw, test_id, cap["id"], key=f"launch-x-{cap['id']}")
        assert out.status_code == 409 and error(out)["code"] == "allowance_exhausted" and held(pw) == before
        assert error(out)["allowance"]["test"]["runs_remaining"] == 0


def test_B14_seconds_are_bounded_per_launch_by_what_remains(pw):
    test_id, run = prepared(pw)
    admitted(pw, test_id, run["id"], key="launch-0001", seconds=550)
    out = admit(pw, test_id, run["id"], key="launch-0002", seconds=51)
    assert out.status_code == 409 and error(out)["allowance"]["per_launch_max_runtime_seconds"] == 50
    admitted(pw, test_id, run["id"], key="launch-0003", seconds=50)


def test_B16_the_request_total_never_exceeds_8_runs_or_1800_seconds(pw):
    t1, r1 = prepared(pw)
    for i in range(4):
        admitted(pw, t1, r1["id"], key=f"launch-1-{i:04d}", seconds=150)
    t2, r2 = prepared(pw, op="op-ptest-0002", proposal=proposal(digest="sha256:" + "e1" * 32))      # replaces T1
    assert pw.hive.db.one("SELECT ended_reason FROM proposal_tests WHERE id = ?", (t1,))["ended_reason"] == "replaced"
    for i in range(4):
        admitted(pw, t2, r2["id"], key=f"launch-2-{i:04d}", seconds=150)
    t3, r3 = prepared(pw, op="op-ptest-0003", proposal=proposal(pid="suggestion_" + "1a" * 16))
    assert r3["proposal_test"]["allowance"]["request"] == {"runs_remaining": 0, "runtime_seconds_remaining": 600}
    out = admit(pw, t3, r3["id"], key="launch-3-0001", seconds=1)
    assert out.status_code == 409 and error(out)["code"] == "allowance_exhausted"
    total = pw.hive.db.one("SELECT COUNT(*) AS n, SUM(charged_seconds) AS s FROM proposal_test_holds WHERE request_id = ?",
                           (pw.rq["request_id"],))
    assert total["n"] == 8 and total["s"] <= 1800


def test_B17_ten_parallel_admissions_on_one_test_admit_exactly_four(pw):
    test_id, run = prepared(pw)
    barrier = threading.Barrier(10)

    def one(i):
        barrier.wait()
        try:
            return pw.hive.proposal_tests.admit(pw.service, test_id, {"capability_id": run["id"], "launch_key": f"launch-p-{i:04d}",
                                                                      "argv_digest": ARGV, "runtime_seconds": 100})[0]
        except HiveError as exc:
            return exc.code

    with concurrent.futures.ThreadPoolExecutor(10) as pool:
        results = list(pool.map(one, range(10)))
    assert results.count(201) == 4 and results.count("allowance_exhausted") == 6
    assert pw.hive.db.one("SELECT COUNT(*) AS n FROM proposal_test_holds")["n"] == 4


def test_B18_a_reissue_racing_an_admission_changes_neither(pw):
    test_id, run = prepared(pw)
    barrier = threading.Barrier(2)
    body = {"capability_id": run["id"], "launch_key": "launch-race-01", "argv_digest": ARGV, "runtime_seconds": 100}

    def hold():
        barrier.wait()
        return pw.hive.proposal_tests.admit(pw.service, test_id, body)

    def again():
        barrier.wait()
        return pw.hive.proposal_tests.issue(pw.ctl, pw.ctl["token"], {"service": "omegacode", "proposal_test": {"test_id": test_id}})

    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        h, r = pool.submit(hold), pool.submit(again)
        status_code, recorded = h.result()
        issued = r.result()
    assert status_code == 201 and issued["claims"]["proposal_test"]["stage"] == "run"
    assert pw.hive.proposal_tests.admit(pw.service, test_id, body) == (201, recorded)
    assert pw.hive.db.one("SELECT COUNT(*) AS n FROM proposal_test_holds")["n"] == 1


def test_B19_holds_survive_a_hive_restart_with_no_sweep(pw):
    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.core.cost_reservations import Reservations
    from hive.tests.test_core_api import PETTA, FakeSupervisor
    test_id, run = prepared(pw)
    hold_id = admitted(pw, test_id, run["id"])
    before = pw.hive.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (hold_id,))
    with pw.hive.db.transaction() as tx:                      # the combined startup recovery's reservations step
        Reservations.recover_startup(tx)
    settings = load_settings(data_dir=pw.hive.settings.data_dir, admin_password="pw", petta_path=PETTA)
    app = create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
    hive2 = app.state.hive
    assert hive2.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (hold_id,)) == before
    assert hive2.proposal_tests._used("test_id", test_id) == (1, 100)
    assert before["state"] == "dispatched"


# ---- b.6 settle schema and charging (B31-B38, B44) ------------------------------------------------------------------

@pytest.fixture()
def one_hold(pw):
    test_id, run = prepared(pw)
    pw.test_id, pw.run = test_id, run
    pw.hold_id = admitted(pw, test_id, run["id"], seconds=100)
    return pw


@pytest.mark.parametrize("change", [
    lambda b: b["runtime"].update(seconds=True), lambda b: b["runtime"].update(seconds=False),
    lambda b: b["runtime"].update(seconds=-1), lambda b: b["runtime"].update(seconds=1.5),
    lambda b: b["runtime"].update(seconds="37"), lambda b: b["runtime"].update(provenance="unknown"),   # B31
    lambda b: b["runtime"].update(seconds=86401), lambda b: b.update(extra=1), lambda b: b.pop("receipt_digest"),
    lambda b: b["runtime"].update(provenance="measured"), lambda b: b["runtime"].update(provenance="none"),   # W9
    lambda b: b.update(outcome="done"), lambda b: b.update(run_id="nope"), lambda b: b.update(run_id=None),
    lambda b: b["cleanup"].update(observed_at=None), lambda b: b["cleanup"].update(descendants_stopped=1),
    lambda b: b["evidence"].update(launch_record_rev=True), lambda b: b["evidence"].update(launch_record_state="gone"),
    lambda b: b.update(receipt_digest="ab" * 32),
    lambda b: b["cleanup"].update(observed_at="2026-10-06T12:00:00.1234567Z"),                         # W19
    lambda b: b["cleanup"].update(observed_at="2026-10-06T12:00:00.123+00:00"),                        # W19
])
def test_B31_W9_W19_strict_settle_schema_refuses_and_records_nothing(one_hold, change):
    body = sb()
    change(body)
    out = settle(one_hold, one_hold.test_id, one_hold.hold_id, body)
    assert out.status_code == 400 and error(out)["code"] == "bad_request", out.text
    assert rows(one_hold, one_hold.hold_id) == []


def test_B32_a_known_zero_duration_of_a_spawned_run_is_refused(one_hold):
    for provenance in ("executor_measured", "wall_clock_bound"):
        out = settle(one_hold, one_hold.test_id, one_hold.hold_id, sb(seconds=0, provenance=provenance))
        assert out.status_code == 400 and error(out)["code"] == "bad_request"


def test_B44_B34_a_spawned_run_with_unknown_duration_charges_the_maximum(one_hold):
    out = settle(one_hold, one_hold.test_id, one_hold.hold_id, sb("withdrawn", seconds=None, provenance="unknown"))
    assert out.status_code == 200, out.text
    hold = out.json()["hold"]
    assert (hold["state"], hold["cleanup"], hold["accounting"], hold["charged_seconds"], hold["overrun_seconds"]) == \
        ("settled", "observed", "reserved_max", 100, 0)
    assert snapshot_valid(snapshot(one_hold, one_hold.test_id, one_hold.hold_id))


def test_B35_unknown_then_measured_settles_and_further_bodies_are_hold_settled(one_hold):
    t, h = one_hold.test_id, one_hold.hold_id
    first = settle(one_hold, t, h, unknown(1, "run_A"))
    assert first.json()["hold"]["state"] == "unknown" and first.json()["hold"]["charged_seconds"] == 100
    second = settle(one_hold, t, h, sb(seconds=40))
    assert second.json()["hold"]["state"] == "settled" and second.json()["hold"]["charged_seconds"] == 40
    out = settle(one_hold, t, h, sb(seconds=41))
    assert out.status_code == 409 and error(out)["code"] == "hold_settled" and error(out)["hold"] == second.json()["hold"]
    assert len(rows(one_hold, h)) == 2                                                    # W4: nothing appended


def test_B36_W21_once_a_run_binds_every_new_body_carries_it(one_hold):
    t, h = one_hold.test_id, one_hold.hold_id
    assert settle(one_hold, t, h, unknown(1, "run_X")).status_code == 200
    for body in (unknown(2, None), unknown(3, "run_Y"), sb(run_id="run_Y"),
                 sb("not_started", None, None, "unknown", True, state="never_spawning")):
        out = settle(one_hold, t, h, body)
        assert out.status_code == 409 and error(out)["code"] == "run_mismatch", body
    assert len(rows(one_hold, h)) == 1


def test_B37_W11_not_started_needs_never_spawning_and_releases(one_hold):
    t, h = one_hold.test_id, one_hold.hold_id
    out = settle(one_hold, t, h, sb("not_started", None, None, "unknown", False, None, state="spawning"))
    assert out.status_code == 400 and error(out)["code"] == "not_started_unproven"
    out = settle(one_hold, t, h, sb("not_started", "run_A", None, "unknown", False, None, state="never_spawning"))
    assert out.status_code == 400 and error(out)["code"] == "bad_request"
    out = settle(one_hold, t, h, sb("not_started", None, None, "unknown", False, None, state="never_spawning"))
    assert out.status_code == 200
    hold = out.json()["hold"]
    assert (hold["state"], hold["cleanup"], hold["accounting"], hold["charged_seconds"], hold["overrun_seconds"]) == \
        ("released", "observed", "none", 0, 0)
    assert MS.fullmatch(hold["settled_at"])
    assert one_hold.hive.proposal_tests._used("test_id", t) == (0, 0)                     # a released hold frees its run


def test_not_started_after_an_unknown_is_unproven(one_hold):
    t, h = one_hold.test_id, one_hold.hold_id
    assert settle(one_hold, t, h, unknown(1)).status_code == 200
    out = settle(one_hold, t, h, sb("not_started", None, None, "unknown", False, None, state="never_spawning"))
    assert out.status_code == 400 and error(out)["code"] == "not_started_unproven"


def test_B38_W12_overrun_charges_actual_and_closes_the_test(pw):
    test_id, run = prepared(pw)
    hold_id = admitted(pw, test_id, run["id"], key="launch-0001", seconds=600)
    out = settle(pw, test_id, hold_id, sb(seconds=700))
    hold = out.json()["hold"]
    assert hold["charged_seconds"] == 700 and hold["overrun_seconds"] == 100 and hold["accounting"] == "executor_measured"
    assert pw.hive.db.one("SELECT admission_closed FROM proposal_tests WHERE id = ?", (test_id,))["admission_closed"] == "overrun"
    assert status(pw, run["id"])["test"]["admission_closed"] == "overrun"
    out = admit(pw, test_id, run["id"], key="launch-0002", seconds=1)
    assert out.status_code == 409 and error(out)["code"] == "admission_closed"
    t2, r2 = prepared(pw, op="op-ptest-0002", proposal=proposal(pid="suggestion_" + "1a" * 16))
    assert r2["proposal_test"]["allowance"]["request"]["runtime_seconds_remaining"] == 1800 - 700
    assert snapshot_valid(snapshot(pw, test_id, hold_id))


# ---- b.6 replay after withdrawal and recovery (B39-B41, B28, B29) -----------------------------------------------------

@pytest.mark.parametrize("withdraw", [
    lambda w: w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn),
    lambda w: w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), w.rq["lease_id"])),
    lambda w: w.hive.services.revoke_grant(w.task["id"], w.grant["id"]),
])
def test_B39_B40_B28_admission_replay_after_withdrawal_and_no_new_key(one_hold, withdraw):
    w = one_hold
    first = admit(w, w.test_id, w.run["id"], key="launch-0002")
    assert first.status_code == 201
    used = w.hive.proposal_tests._used("request_id", w.rq["request_id"])
    withdraw(w)
    assert status(w, w.run["id"])["active"] is False
    before = held(w)
    again = admit(w, w.test_id, w.run["id"], key="launch-0002")                          # B39 / B28: an acknowledgement only
    assert again.status_code == 201 and again.content == first.content and held(w) == before
    assert w.hive.proposal_tests._used("request_id", w.rq["request_id"]) == used
    out = admit(w, w.test_id, w.run["id"], key="launch-0003")                             # B40
    assert out.status_code == 403 and error(out)["code"] == "capability_withdrawn" and held(w) == before


def test_B41_B29_lost_hold_id_recovered_by_key_then_released(one_hold):
    w = one_hold
    w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn)        # the withdrawal comes after the commit
    found = by_key(w, w.test_id, "launch-0001").json()
    assert found["hold"]["hold_id"] == w.hold_id and found["observations"] == []
    replay = admit(w, w.test_id, w.run["id"], key="launch-0001")
    assert replay.status_code == 201 and replay.json()["hold_id"] == w.hold_id
    out = settle(w, w.test_id, w.hold_id, sb("not_started", None, None, "unknown", False, None, state="never_spawning", rev=7))
    assert out.status_code == 200 and out.json()["hold"]["state"] == "released"
    again = admit(w, w.test_id, w.run["id"], key="launch-0001")                          # B29: a replayed 201 changes nothing
    assert again.content == replay.content
    assert snapshot(w, w.test_id, w.hold_id)["hold"]["state"] == "released"
    assert w.hive.db.one("SELECT COUNT(*) AS n FROM proposal_test_holds")["n"] == 1


# ---- b.6.1 the settlement and hold wire (W1-W21) -----------------------------------------------------------------------

def test_W1_W2_envelope_bytes_and_byte_identical_replay(one_hold):
    w = one_hold
    body = sb()
    out = settle(w, w.test_id, w.hold_id, body)
    assert out.status_code == 200 and out.headers["content-type"].startswith("application/json")
    assert out.content == canonical(out.json()).encode()
    hold, obs = out.json()["hold"], out.json()["observation"]
    assert set(hold) == {"hold_id", "test_id", "request_id", "launch_key", "argv_digest", "runtime_seconds_max", "state", "run_id",
                         "cleanup", "accounting", "charged_seconds", "overrun_seconds", "observation_count", "created_at", "settled_at"}
    assert (hold["state"], hold["accounting"], hold["charged_seconds"], hold["overrun_seconds"]) == ("settled", "executor_measured", 37, 0)
    assert type(hold["charged_seconds"]) is int and hold["run_id"] == "run_A"
    assert (obs["seq"], obs["state_before"], obs["state_after"], obs["body"]) == (1, "dispatched", "settled", body)
    assert obs["body_digest"] == sha(canonical(body))
    raw = json.dumps({k: body[k] for k in reversed(list(body))}, indent=3)
    again = settle(w, w.test_id, w.hold_id, None, raw=raw)
    assert again.status_code == 200 and again.content == out.content and len(rows(w, w.hold_id)) == 1


def test_W3_W6_W7_unknown_then_settled_replay_returns_the_original_bytes(one_hold):
    w = one_hold
    first_body = unknown(1, "run_A")
    first = settle(w, w.test_id, w.hold_id, first_body)
    second = settle(w, w.test_id, w.hold_id, sb("withdrawn", seconds=None, provenance="unknown"))
    assert first.json()["hold"]["state"] == "unknown"
    h2 = second.json()["hold"]
    assert (h2["state"], h2["accounting"], h2["charged_seconds"]) == ("settled", "reserved_max", 100)
    replay = settle(w, w.test_id, w.hold_id, first_body)
    assert replay.content == first.content and replay.json()["hold"]["state"] == "unknown"
    snap = snapshot(w, w.test_id, w.hold_id)                                               # W6
    assert [o["seq"] for o in snap["observations"]] == [1, 2] and snap["observations"][0]["state_after"] == "unknown"
    assert snap["hold"]["state"] == snap["observations"][1]["state_after"] == "settled" and snap["hold"] == h2
    assert snapshot_valid(snap) and acknowledged(first_body, snap)                          # W8 (host snapshot side)
    keyed = by_key(w, w.test_id, "launch-0001")                                            # W7
    assert keyed.json() == snap
    none = by_key(w, w.test_id, "launch-never-01")
    assert none.content == b'{"hold":null,"observations":[]}'
    bad = w.client.get(f"/api/services/proposal-tests/{w.test_id}/holds", headers=w.svc, params={"launch_key": "short"})
    assert bad.status_code == 400
    assert w.client.get(f"/api/services/proposal-tests/{w.test_id}/holds/ph_{'0' * 24}", headers=w.svc).status_code == 404
    assert w.client.get(f"/api/services/proposal-tests/{w.test_id}/holds/{w.hold_id}", headers=other_service(w)).status_code == 403


def test_W5_W13_W14_W15_fifteen_non_terminal_then_the_reserved_terminal_slot(one_hold):
    w = one_hold
    bodies, answers = [unknown(i) for i in range(15)], []
    for body in bodies:
        out = settle(w, w.test_id, w.hold_id, body)
        assert out.status_code == 200
        answers.append(out.content)
    stored = rows(w, w.hold_id)
    out = settle(w, w.test_id, w.hold_id, unknown(99))                                     # W5: the 16th non-terminal
    assert out.status_code == 409 and error(out)["code"] == "observation_limit" and error(out)["terminal_slot_reserved"] is True
    assert error(out)["hold"]["observation_count"] == 15 and rows(w, w.hold_id) == stored
    for body, answer in zip(bodies, answers):                                              # W14 at the limit
        assert settle(w, w.test_id, w.hold_id, body).content == answer
    assert rows(w, w.hold_id) == stored
    final_body = sb("withdrawn", "run_A", None, "unknown", True)
    final = settle(w, w.test_id, w.hold_id, final_body)                                     # W13
    assert final.status_code == 200
    obs, hold = final.json()["observation"], final.json()["hold"]
    assert (obs["seq"], obs["state_before"], obs["state_after"]) == (16, "unknown", "settled")
    assert (hold["accounting"], hold["charged_seconds"], hold["observation_count"]) == ("reserved_max", 100, 16)
    stored = rows(w, w.hold_id)
    for body, answer in zip(bodies + [final_body], answers + [final.content]):            # W14 after the terminal, W15
        assert settle(w, w.test_id, w.hold_id, body).content == answer
    assert rows(w, w.hold_id) == stored and len(stored) == 16
    assert snapshot_valid(snapshot(w, w.test_id, w.hold_id))


def test_W14_observations_are_insert_only(one_hold):
    w = one_hold
    settle(w, w.test_id, w.hold_id, unknown(1))
    for sql in ("UPDATE hold_observations SET response = 'x'", "DELETE FROM hold_observations",
                "DELETE FROM proposal_test_holds", "UPDATE proposal_test_holds SET admission_response = 'x'"):
        with pytest.raises(Exception, match="insert-only|never"):
            w.hive.db.execute(sql)
    settle(w, w.test_id, w.hold_id, unknown(2, "run_A"))
    with pytest.raises(Exception, match="immutable"):
        w.hive.db.execute("UPDATE proposal_test_holds SET run_id = 'run_B'")


def test_W16_two_different_terminal_bodies_concurrently(one_hold):
    w = one_hold
    barrier = threading.Barrier(2)

    def one(body):
        barrier.wait()
        try:
            return w.hive.proposal_tests.settle(w.service, w.test_id, w.hold_id, body)
        except HiveError as exc:
            return exc.code

    a, b = sb(seconds=30), sb(seconds=31)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(one, (a, b)))
    winners = [r for r in results if isinstance(r, tuple)]
    assert len(winners) == 1 and results.count("hold_settled") == 1
    stored = rows(w, w.hold_id)
    assert len(stored) == 1 and stored[0]["response"].encode() == winners[0][1]
    hold = snapshot(w, w.test_id, w.hold_id)["hold"]
    assert hold["charged_seconds"] == json.loads(winners[0][1])["hold"]["charged_seconds"]


def test_W17_two_identical_terminal_bodies_concurrently(one_hold):
    w = one_hold
    barrier = threading.Barrier(2)

    def one(_):
        barrier.wait()
        return w.hive.proposal_tests.settle(w.service, w.test_id, w.hold_id, sb())

    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(one, range(2)))
    assert results[0] == results[1] and len(rows(w, w.hold_id)) == 1


def test_W18_a_fault_after_the_insert_persists_nothing(one_hold):
    w = one_hold
    before = w.hive.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (w.hold_id,))

    def boom(step):
        raise RuntimeError(f"fault at {step}")

    w.hive.proposal_tests.fault = boom
    with pytest.raises(RuntimeError):
        w.hive.proposal_tests.settle(w.service, w.test_id, w.hold_id, sb(seconds=700))
    assert rows(w, w.hold_id) == [] and w.hive.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (w.hold_id,)) == before
    assert w.hive.db.one("SELECT admission_closed FROM proposal_tests WHERE id = ?", (w.test_id,))["admission_closed"] is None
    w.hive.proposal_tests.fault = lambda step: None
    out = settle(w, w.test_id, w.hold_id, sb())
    assert out.status_code == 200 and out.json()["observation"]["seq"] == 1


def test_W19_body_timestamps_are_kept_verbatim(one_hold):
    w = one_hold
    body = sb(observed_at="2026-10-06T12:00:00.123456Z")
    out = settle(w, w.test_id, w.hold_id, body)
    assert out.json()["observation"]["body"]["cleanup"]["observed_at"] == "2026-10-06T12:00:00.123456Z"
    assert out.json()["observation"]["body_digest"] == sha(canonical(body))
    assert MS.fullmatch(out.json()["observation"]["received_at"])
    snap = snapshot(w, w.test_id, w.hold_id)
    assert snap["observations"][0]["body"]["cleanup"]["observed_at"] == "2026-10-06T12:00:00.123456Z"
    assert settle(w, w.test_id, w.hold_id, body).content == out.content
    whole = sb(observed_at="2026-10-06T12:00:00Z")
    out = settle(w, w.test_id, w.hold_id, whole)                  # a whole-second stamp is an accepted shape: the hold is
    assert out.status_code == 409 and error(out)["code"] == "hold_settled"   # settled, so the new body is refused, not 400


def test_W20_null_run_history_before_the_first_binding(one_hold):
    w = one_hold
    b1 = unknown(1, None)
    first = settle(w, w.test_id, w.hold_id, b1)
    settle(w, w.test_id, w.hold_id, unknown(2, "run_X"))
    settle(w, w.test_id, w.hold_id, sb(run_id="run_X", seconds=20))
    stored = rows(w, w.hold_id)[0]
    replay = settle(w, w.test_id, w.hold_id, b1)
    assert replay.content == first.content and replay.json()["hold"]["run_id"] is None
    snap = snapshot(w, w.test_id, w.hold_id)
    assert snapshot_valid(snap) and acknowledged(b1, snap) and rows(w, w.hold_id)[0] == stored
    assert not acknowledged(unknown(2, "run_Y"), snap)                                      # W22: a forged non-null B


def test_W8_W22_the_reader_refuses_broken_snapshots(one_hold):
    """Host fixtures for Code's reader: the valid snapshot passes, each mutation (one per check a-l) fails."""
    w = one_hold
    settle(w, w.test_id, w.hold_id, unknown(1, None))
    settle(w, w.test_id, w.hold_id, unknown(2, "run_X"))
    settle(w, w.test_id, w.hold_id, sb(run_id="run_X", seconds=20))
    good = snapshot(w, w.test_id, w.hold_id)
    assert snapshot_valid(good) and not acknowledged(sb(seconds=21), good) and not acknowledged(unknown(5, "run_X"), good)

    def broken(change, redigest=True):
        snap = json.loads(json.dumps(good))
        change(snap)
        if redigest:      # a body mutation keeps its digests consistent, so the targeted check (not g) is what fails
            for o in snap["observations"]:
                o["body_digest"] = sha(canonical(o["body"]))
        return snap

    mutations = [
        lambda s: s["observations"][1].update(seq=3),                                       # a
        lambda s: s["observations"].pop(1),                                                  # b (truncated)
        lambda s: s["observations"][0].update(state_before="unknown"),                       # c
        lambda s: s["observations"][1].update(state_before="settled"),                       # d
        lambda s: s["observations"][2].update(state_before="unknown", state_after="released"),   # e
        lambda s: s["observations"][0].update(state_after="settled"),                        # f
        lambda s: s["observations"][1]["body"].update(outcome="done"),                       # h
        lambda s: s["observations"][2]["body"].update(run_id="run_Y"),                       # i (a different run after F)
        lambda s: s["observations"][0]["body"].update(run_id="run_Y"),                       # i (F differs from hold.run_id)
        lambda s: s["hold"].update(run_id=None),                                             # i (F present, hold null)
        lambda s: s["hold"].update(charged_seconds=21),                                      # j
        lambda s: s["observations"][0].update(received_at="2026-10-06T12:00:00.123456Z"),    # k
        lambda s: s["hold"].update(overrun_seconds=False),                                   # l
    ]
    for change in mutations:
        assert not snapshot_valid(broken(change))
    assert not snapshot_valid(broken(lambda s: s["observations"][1].update(body_digest="sha256:" + "0" * 64), redigest=False))
    assert not snapshot_valid(broken(lambda s: s["observations"][1].update(body=s["observations"][0]["body"])))   # g: duplicate
    assert snapshot_valid(broken(lambda s: None))                                            # the copy itself stays valid


def test_W10_hold_views_across_every_state_match_the_accounting_table(pw):
    test_id, run = prepared(pw)
    views = []
    keys = [f"launch-{i:04d}" for i in range(4)]
    holds = [admitted(pw, test_id, run["id"], key=k, seconds=100) for k in keys]
    views.append(snapshot(pw, test_id, holds[0]))                                           # dispatched
    settle(pw, test_id, holds[1], unknown(1))
    views.append(snapshot(pw, test_id, holds[1]))                                           # unknown
    settle(pw, test_id, holds[2], sb("failed", seconds=None, provenance="unknown"))
    views.append(snapshot(pw, test_id, holds[2]))                                           # settled, reserved_max
    settle(pw, test_id, holds[3], sb(provenance="wall_clock_bound", seconds=12))
    views.append(snapshot(pw, test_id, holds[3]))                                           # settled, measured
    t2, r2 = prepared(pw, op="op-ptest-0002", proposal=proposal(pid="suggestion_" + "1a" * 16))
    h5 = admitted(pw, t2, r2["id"], key="launch-0005")
    settle(pw, t2, h5, sb("not_started", None, None, "unknown", False, None, state="never_spawning"))
    views.append(snapshot(pw, t2, h5))                                                      # released
    states = []
    for snap in views:
        assert snapshot_valid(snap), snap
        hold = snap["hold"]
        assert all(type(hold[k]) is int for k in ("runtime_seconds_max", "charged_seconds", "overrun_seconds", "observation_count"))
        states.append((hold["state"], hold["accounting"]))
    assert states == [("dispatched", "reserved_max"), ("unknown", "reserved_max"), ("settled", "reserved_max"),
                      ("settled", "wall_clock_bound"), ("released", "none")]


def test_settle_service_ownership_and_hold_existence(one_hold):
    w = one_hold
    out = settle(w, w.test_id, w.hold_id, sb(), headers=other_service(w))
    assert out.status_code == 403 and error(out)["code"] == "service_mismatch"
    out = settle(w, w.test_id, "ph_" + "0" * 24, sb())
    assert out.status_code == 404 and error(out)["code"] == "not_found"
    out = settle(w, "pt_" + "0" * 24, w.hold_id, sb())
    assert out.status_code == 404
    out = settle(w, w.test_id, w.hold_id, sb(), headers=agent_headers(w.ctl))
    assert out.status_code == 401
    assert rows(w, w.hold_id) == []


# ---- stand-in FIX-FIRST on 0e5e5f5 (STANDIN_LINKAGE_S4_VERDICT_20261007) -------------------------------------------------

def ended(w, test_id):
    row = w.hive.db.one("SELECT ended_at, ended_reason FROM proposal_tests WHERE id = ?", (test_id,))
    return row["ended_reason"] if row["ended_at"] else None


def hold_row(w, hold_id):
    return w.hive.db.one("SELECT * FROM proposal_test_holds WHERE id = ?", (hold_id,))


def test_fix1_request_cancel_ends_the_test_in_the_cancel_transaction_and_keeps_its_holds(one_hold):
    """C9/C10 host side, b.6: the host-owned cause ends the test withdrawn:<reason>; the hold is unchanged."""
    w = one_hold
    before = hold_row(w, w.hold_id)
    w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn)
    assert ended(w, w.test_id) == "withdrawn:request_closed"          # persisted by the hook, before any status call
    assert hold_row(w, w.hold_id) == before
    st = status(w, w.run["id"])
    assert st["active"] is False and st["reason"] == "request_closed" and st["test"]["state"] == "ended"
    assert st["test"]["ended_reason"] == "withdrawn:request_closed"
    out = reissue(w, w.test_id)
    assert out.status_code == 409 and error(out)["code"] == "test_ended"
    out = settle(w, w.test_id, w.hold_id, sb("withdrawn", seconds=12))   # settlement never needs live authority
    assert out.status_code == 200 and out.json()["hold"]["state"] == "settled"


def test_fix1_grant_revoke_ends_the_tests_on_that_grant(one_hold):
    w = one_hold
    w.hive.services.revoke_grant(w.task["id"], w.grant["id"])
    assert ended(w, w.test_id) == "withdrawn:grant_withdrawn"
    assert hold_row(w, w.hold_id)["state"] == "dispatched"


@pytest.mark.parametrize("cause,reason", [
    (lambda w: w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), w.rq["lease_id"])), "lease_expired"),
    (lambda w: w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'"), "lease_revoked"),
    (lambda w: w.hive.db.execute("UPDATE goal_grants SET expires_at = 1 WHERE id = ?", (w.grant["id"],)), "grant_withdrawn"),
    (lambda w: w.client.patch(f"/api/swarms/{w.team['id']}", json={"coordinator_id": w.helper["id"]}), "not_controller"),
])
def test_fix1_lazy_causes_are_persisted_by_the_reconcile_cycle(one_hold, cause, reason):
    import asyncio
    w = one_hold
    cause(w)
    assert ended(w, w.test_id) is None                                  # nothing saw it happen yet
    asyncio.run(w.hive.minds.reconcile())
    assert ended(w, w.test_id) == f"withdrawn:{reason}"
    assert hold_row(w, w.hold_id)["state"] == "dispatched"


@pytest.mark.parametrize("touch", ["status", "reissue", "admission", "bind"])
def test_fix1_a_lazy_withdrawal_is_persisted_even_when_the_touching_call_is_refused(pw, touch):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    if touch == "admission":
        assert bind(pw, test_id, bind_body(claims)).status_code == 201
        run = reissue(pw, test_id).json()["claims"]
    pw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), pw.rq["lease_id"]))
    if touch == "status":
        assert status(pw, claims["id"])["reason"] == "lease_expired"
    elif touch == "reissue":
        assert reissue(pw, test_id).status_code == 409
    elif touch == "admission":
        out = admit(pw, test_id, run["id"], key="launch-late-01")
        assert out.status_code == 403 and error(out)["reason"] == "lease_expired"
    else:
        out = bind(pw, test_id, bind_body(claims))
        assert out.status_code == 403 and error(out)["reason"] == "lease_expired"
    assert ended(pw, test_id) == "withdrawn:lease_expired"


def test_fix1_the_result_window_counts_from_the_withdrawal(one_hold):
    """b.8: result is issued up to 7 days after ended_at; a withdrawn test now has an ended_at."""
    w = one_hold
    w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn)
    assert ended(w, w.test_id) == "withdrawn:request_closed"
    result = reissue(w, w.test_id, "result")
    assert result.status_code == 200, result.text
    result = result.json()["claims"]
    assert status(w, result["id"])["active"] is True
    w.hive.db.execute("UPDATE proposal_tests SET ended_at = ? WHERE id = ? AND ended_at IS NOT NULL",   # 8 days pass after
                      (past(days=8), w.test_id))                                                     # the persisted ending
    assert status(w, result["id"])["reason"] == "test_ended"
    out = reissue(w, w.test_id, "result")
    assert out.status_code == 409 and error(out)["code"] == "test_ended"
    snap = snapshot(w, w.test_id, w.hold_id)                           # the hold still reads, and survives
    assert snap["hold"]["state"] == "dispatched"


def test_fix2_creation_replay_after_lease_replacement_issues_nothing(pw):
    first = created(pw)
    test_id = first["proposal_test"]["test_id"]
    lease = pw.hive.db.one("SELECT * FROM mind_leases WHERE id = ?", (pw.rq["lease_id"],))
    newer = dict(lease, id="ls_newer", created_at="9999-01-01T00:00:00.000Z")
    pw.hive.db.insert("mind_leases", newer)
    before = held(pw)
    out = create(pw)                                                   # the same operation id and body: a replay
    assert out.status_code == 403 and error(out)["code"] == "lease_required"
    after = held(pw)
    assert after["capabilities"] == before["capabilities"] and after["proposal_tests"] == before["proposal_tests"]
    assert ended(pw, test_id) == "withdrawn:lease_replaced"
    assert status(pw, first["id"])["lease"]["state"] == "replaced"


@pytest.mark.parametrize("bad", ["2026-99-99T99:99:99Z", "2026-02-30T00:00:00Z", "2026-10-06T24:00:00Z",
                                 "2026-10-06T12:60:00Z", "2026-12-31T23:59:60Z", "2026-00-10T00:00:00.5Z",
                                 "2025-02-29T00:00:00Z"])
def test_fix3_settle_timestamps_are_real_dates_and_times(one_hold, bad):
    w = one_hold
    out = settle(w, w.test_id, w.hold_id, sb(observed_at=bad))
    assert out.status_code == 400 and error(out)["code"] == "bad_request"
    assert rows(w, w.hold_id) == [] and hold_row(w, w.hold_id)["observation_count"] == 0


def test_fix3_a_valid_timestamp_is_kept_verbatim(one_hold):
    w = one_hold
    out = settle(w, w.test_id, w.hold_id, sb(observed_at="2024-02-29T23:59:59.999999Z"))
    assert out.status_code == 200
    assert out.json()["observation"]["body"]["cleanup"]["observed_at"] == "2024-02-29T23:59:59.999999Z"


# ---- r3: stand-in FIX-FIRST and Kimi label findings on 4972170 ---------------------------------------------------------

CAUSES = {
    "cancel": lambda w: w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn),
    "lease_expiry": lambda w: w.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), w.rq["lease_id"])),
    "demotion": lambda w: w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'"),
    "grant_revoke": lambda w: w.hive.services.revoke_grant(w.task["id"], w.grant["id"]),
    "grant_expiry": lambda w: w.hive.db.execute("UPDATE goal_grants SET expires_at = 1 WHERE id = ?", (w.grant["id"],)),
    "task_close": lambda w: w.hive.goals.update(w.task["id"], {"status": "done"}),
}
STAMPED = {"cancel": "request_closed", "lease_expiry": "lease_expired", "demotion": "lease_revoked",
           "grant_revoke": "grant_withdrawn", "grant_expiry": "grant_withdrawn", "task_close": "task_closed"}


@pytest.mark.parametrize("cause", sorted(CAUSES))
def test_r3_S1_creation_replay_after_a_withdrawal_is_test_ended(pw, cause):
    first = created(pw)
    test_id = first["proposal_test"]["test_id"]
    CAUSES[cause](pw)
    before = held(pw)
    out = create(pw)                                                   # the recorded operation id and body: a replay
    assert out.status_code == 409 and error(out)["code"] == "test_ended", out.text
    assert error(out)["ended_reason"] == f"withdrawn:{STAMPED[cause]}"
    assert held(pw) == before                                          # nothing issued, nothing created


@pytest.mark.parametrize("cause", sorted(CAUSES))
def test_r3_K1_each_cause_stamps_its_own_label(one_hold, cause):
    import asyncio
    w = one_hold
    CAUSES[cause](w)
    asyncio.run(w.hive.minds.reconcile())
    assert ended(w, w.test_id) == f"withdrawn:{STAMPED[cause]}"
    st = status(w, w.run["id"])
    assert st["test"]["ended_reason"] == f"withdrawn:{STAMPED[cause]}"
    assert hold_row(w, w.hold_id)["state"] == "dispatched"


def test_r3_K1_closing_the_origin_task_leaves_the_request_open(one_hold):
    """Why task_closed is reachable: the real goals.update path closes the origin task without closing the request."""
    w = one_hold
    w.hive.goals.update(w.task["id"], {"status": "done"})
    assert w.hive.minds.request_open(w.hive.minds._request(w.rq["request_id"]))
    w.hive.goals.update(w.rq["receiving_goal"], {"status": "done"})    # a finished receiving goal is request_closed
    w2 = w.hive.proposal_tests._withdrawal(w.hive.proposal_tests._test(w.test_id))
    assert w2 == "request_closed"


def test_r3_K2_replacement_is_stamped_before_a_controller_change(pw):
    """No production path creates a second lease for a request (minds.py instruct makes one), so the replacement is a
    fixture row; it carries a different controller, and the replacement is still the stamped cause."""
    first = created(pw)
    test_id = first["proposal_test"]["test_id"]
    pw.client.patch(f"/api/swarms/{pw.team['id']}", json={"coordinator_id": pw.helper["id"]})
    lease = pw.hive.db.one("SELECT * FROM mind_leases WHERE id = ?", (pw.rq["lease_id"],))
    pw.hive.db.insert("mind_leases", dict(lease, id="ls_newer", controller_id=pw.helper["id"], created_at="9999-01-01T00:00:00.000Z"))
    st = status(pw, first["id"])
    assert ended(pw, test_id) == "withdrawn:lease_replaced"
    assert st["reason"] == "lease_replaced" and st["lease"]["state"] == "replaced"


@pytest.mark.parametrize("later", ["demotion", "controller"])
def test_r3_K3_the_persisted_ending_drives_the_status_reason(one_hold, later):
    w = one_hold
    w.client.post(f"/api/requests/{w.rq['request_id']}/cancel", headers=w.quinn)
    assert ended(w, w.test_id) == "withdrawn:request_closed"
    if later == "demotion":
        w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'")
    else:
        w.client.patch(f"/api/swarms/{w.team['id']}", json={"coordinator_id": w.helper["id"]})
    st = status(w, w.run["id"])
    assert st["active"] is False and st["reason"] == "request_closed"
    assert ended(w, w.test_id) == "withdrawn:request_closed"           # never re-stamped


def test_r3_K3_a_demotion_ending_and_its_status_agree(one_hold):
    import asyncio
    w = one_hold
    w.hive.db.execute("UPDATE people SET role = 'member' WHERE id = 'u_quinn'")
    asyncio.run(w.hive.minds.reconcile())
    assert ended(w, w.test_id) == "withdrawn:lease_revoked" and status(w, w.run["id"])["reason"] == "lease_revoked"


def test_r3_K4_the_sweep_before_replay_never_changes_a_recorded_answer(pw):
    claims = created(pw)
    test_id = claims["proposal_test"]["test_id"]
    bound = bind(pw, test_id, bind_body(claims))
    run = reissue(pw, test_id).json()["claims"]
    hold = admit(pw, test_id, run["id"], key="launch-k4-0001")
    pw.hive.db.execute("UPDATE mind_leases SET until = ? WHERE id = ?", (past(minutes=1), pw.rq["lease_id"]))
    again = bind(pw, test_id, bind_body(claims))                      # this call's own sweep stamps the ending first
    assert ended(pw, test_id) == "withdrawn:lease_expired"
    assert again.status_code == 201 and again.content == bound.content
    replay = admit(pw, test_id, run["id"], key="launch-k4-0001")
    assert replay.status_code == 201 and replay.content == hold.content


def test_r3_kimi_a_test_ends_with_the_grant_it_was_created_under(one_hold):
    """Leases are never re-pointed to another grant in production; the fixture re-points one to prove the test is bound
    to its creation grant A: revoking A ends it although the lease now names B."""
    w = one_hold
    b = w.hive.services.grant(w.task["id"], "user:u_quinn", "edit", None, 120, by="user:u_quinn")
    w.hive.db.execute("UPDATE mind_leases SET grant_id = ? WHERE id = ?", (b["id"], w.rq["lease_id"]))
    assert w.hive.db.one("SELECT grant_id FROM proposal_tests WHERE id = ?", (w.test_id,))["grant_id"] == w.grant["id"]
    w.hive.services.revoke_grant(w.task["id"], w.grant["id"])
    assert ended(w, w.test_id) == "withdrawn:grant_withdrawn"
    assert hold_row(w, w.hold_id)["state"] == "dispatched"


def test_r3_kimi_creation_grant_expiry_is_caught_lazily(one_hold):
    import asyncio
    w = one_hold
    b = w.hive.services.grant(w.task["id"], "user:u_quinn", "edit", None, 120, by="user:u_quinn")
    w.hive.db.execute("UPDATE mind_leases SET grant_id = ? WHERE id = ?", (b["id"], w.rq["lease_id"]))
    w.hive.db.execute("UPDATE goal_grants SET expires_at = 1 WHERE id = ?", (w.grant["id"],))
    asyncio.run(w.hive.minds.reconcile())
    assert ended(w, w.test_id) == "withdrawn:grant_withdrawn"
