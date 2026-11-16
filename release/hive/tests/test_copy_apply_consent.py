"""copy-apply consent r1 (PLATFORM_SURFACE_VIBE_r3_STANDIN_VERDICT P1 #1): the controller's copy_apply capability is issued
only against the request's own person's single-use consent for that exact proposal.

Words -> mind proposal -> plain summary -> the person accepts. The UI button is not the guarantee: the host refuses the
capability itself without a live consent. Synthetic only: fake supervisor, mock models; no provider calls, no Code."""
import pytest

from hive.tests.test_copy_apply_claims import (CAP, ORIGIN, SUGGESTION, SUGGESTION_DIGEST, body, consent, cw, error, issue,  # noqa: F401
                                               request, status, written)
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)

OTHER_DIGEST = "dd" * 32


def raw(w, rq, **over):
    return issue(w, rq, consented=False, **over)


def consents(w):
    return w.hive.db.all("SELECT * FROM copy_apply_consents ORDER BY created_at, rowid")


# ---- the defect: no consent, no capability ----------------------------------------------------------------------

def test_with_claims_on_a_controller_gets_no_copy_apply_capability_without_consent(cw):
    rq = request(cw)
    before = written(cw.hive)
    out = raw(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "consent_required", out.text
    assert error(out)["reason"] == "no_consent"
    assert written(cw.hive) == before                       # no capability, no binding, no recorded operation


def test_happy_path_accept_then_capability_exactly_once(cw):
    rq = request(cw)
    out = consent(cw, rq)
    assert out.status_code == 200, out.text
    view = out.json()
    assert view["decision"] == "accept" and view["principal"] == "user:u_jon" and view["controller_id"] == cw.ctl["id"]
    assert (view["request_id"], view["suggestion_id"], view["suggestion_digest"]) == (rq["request_id"], SUGGESTION, SUGGESTION_DIGEST)
    assert view["consent_id"].startswith("cns_") and view["expires_in"] == 600 and view["expires_at"].endswith("Z")
    first = raw(cw, rq)
    assert first.status_code == 200, first.text
    row = consents(cw)[0]
    assert row["spent_at"] and row["capability_id"] == first.json()["claims"]["id"]
    assert status(cw, first.json()["claims"]["id"])["active"] is True
    second = raw(cw, rq, op="op-capply-0002")                # a second issue under the spent consent
    assert second.status_code == 403 and error(second)["code"] == "consent_required"


# ---- who may consent ------------------------------------------------------------------------------------------

def test_consent_from_another_person_or_the_operator_is_refused(cw):
    rq = request(cw)
    for who in (cw.ann, cw.mia):                              # another admin; a member
        out = consent(cw, rq, who=who)
        assert out.status_code == 403 and error(out)["code"] == "not_request_person", out.text
    operator = cw.client.post(f"/api/requests/{rq['request_id']}/proposals/{SUGGESTION}/accept", headers=ORIGIN,
                              json={"suggestion_digest": SUGGESTION_DIGEST})     # the hive password session
    assert operator.status_code == 403 and error(operator)["code"] == "person_required"
    no_origin = cw.client.post(f"/api/requests/{rq['request_id']}/proposals/{SUGGESTION}/accept", headers=cw.jon,
                               json={"suggestion_digest": SUGGESTION_DIGEST})
    assert no_origin.status_code == 403 and error(no_origin)["code"] == "origin_required"
    assert consents(cw) == []
    out = raw(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "consent_required"


def test_a_consent_names_the_requests_controller_and_no_other_mind_spends_it(cw):
    rq = request(cw)
    assert consent(cw, rq).status_code == 200
    cw.client.patch(f"/api/swarms/{cw.team['id']}", json={"coordinator_id": cw.helper["id"]})
    cw.hive.db.execute("UPDATE mind_leases SET controller_id = ? WHERE id = ?", (cw.helper["id"], rq["lease_id"]))
    out = raw(cw, rq, agent=cw.helper)                       # the new controller holds no consent of its own
    assert out.status_code == 409 and error(out)["code"] == "consent_stale", out.text


@pytest.mark.parametrize("path,payload,code", [
    (f"/proposals/{SUGGESTION}/accept", {"suggestion_digest": "sha256:" + SUGGESTION_DIGEST}, "bad_request"),
    (f"/proposals/{SUGGESTION}/accept", {"suggestion_digest": SUGGESTION_DIGEST, "extra": 1}, "bad_request"),
    (f"/proposals/{SUGGESTION}/accept", {}, "bad_request"),
    ("/proposals/suggestion_nope/accept", {"suggestion_digest": SUGGESTION_DIGEST}, "bad_request"),
    (f"/proposals/{SUGGESTION}/apply", {"suggestion_digest": SUGGESTION_DIGEST}, "not_found"),
])
def test_consent_body_is_closed_and_exact(cw, path, payload, code):
    rq = request(cw)
    out = cw.client.post(f"/api/requests/{rq['request_id']}" + path, headers={**cw.jon, **ORIGIN}, json=payload)
    assert error(out)["code"] == code, out.text
    assert consents(cw) == []


def test_consent_for_a_missing_request_or_a_closed_one(cw):
    out = consent(cw, {"request_id": "rq_missing"})
    assert out.status_code == 404
    rq = request(cw)
    cw.client.post(f"/api/requests/{rq['request_id']}/cancel", headers=cw.jon)
    out = consent(cw, rq)
    assert out.status_code == 409 and error(out)["code"] == "request_closed"


# ---- single use, staleness, expiry ------------------------------------------------------------------------------

def test_consent_is_single_use(cw):
    rq = request(cw)
    consent(cw, rq)
    assert raw(cw, rq).status_code == 200
    other = "suggestion_" + "1a" * 16                        # even for another proposal, the spent consent is not reused
    out = raw(cw, rq, op="op-capply-0003", proposal={"suggestion_id": other, "suggestion_digest": SUGGESTION_DIGEST})
    assert out.status_code == 403 and error(out)["code"] == "consent_required"
    cw.hive.db.execute("DELETE FROM copy_apply_bindings")    # with no binding left in the way, still no second issue
    out = raw(cw, rq, op="op-capply-0004")
    assert out.status_code == 403 and error(out)["code"] == "consent_required"


def test_a_digest_change_after_consent_refuses_stale(cw):
    rq = request(cw)
    consent(cw, rq)                                          # accepted the proposal at SUGGESTION_DIGEST
    before = written(cw.hive)
    out = raw(cw, rq, proposal={"suggestion_id": SUGGESTION, "suggestion_digest": OTHER_DIGEST})
    assert out.status_code == 409 and error(out)["code"] == "consent_stale", out.text
    assert written(cw.hive) == before and consents(cw)[0]["spent_at"] is None
    consent(cw, rq, suggestion_digest=OTHER_DIGEST)          # accepting the changed proposal anew admits it ...
    assert raw(cw, rq, proposal={"suggestion_id": SUGGESTION, "suggestion_digest": OTHER_DIGEST}).status_code == 200
    out = raw(cw, rq, op="op-capply-0002")                   # ... and voided the accept of the old digest
    assert out.status_code == 403 and error(out)["code"] == "consent_required"
    assert consents(cw)[0]["voided_at"] is not None


def test_a_request_binding_change_after_consent_refuses_stale(cw):
    rq = request(cw)
    consent(cw, rq)
    cw.hive.db.execute("UPDATE copy_apply_consents SET binding_digest = ?", ("sha256:" + "00" * 32,))   # given for another binding
    out = raw(cw, rq)
    assert out.status_code == 409 and error(out)["code"] == "consent_stale"


def test_an_expired_consent_is_refused(cw):
    rq = request(cw)
    consent(cw, rq)
    cw.hive.db.execute("UPDATE copy_apply_consents SET expires_at = expires_at - 601")
    out = raw(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "consent_required"
    assert consents(cw)[0]["spent_at"] is None


def test_a_replay_reissues_only_inside_the_spent_consents_life(cw):
    rq = request(cw)
    consent(cw, rq)
    first = raw(cw, rq).json()
    again = raw(cw, rq)                                      # the same operation, response lost: one live capability
    assert again.status_code == 200 and status(cw, first["claims"]["id"])["reason"] == "revoked"
    assert consents(cw)[0]["capability_id"] == again.json()["claims"]["id"]
    cw.hive.db.execute("UPDATE copy_apply_consents SET expires_at = expires_at - 601")
    late = raw(cw, rq)
    assert late.status_code == 403 and error(late)["code"] == "consent_required"
    consent(cw, rq)                                          # a fresh accept lets the same operation re-issue
    assert raw(cw, rq).status_code == 200


def test_a_refused_issue_after_consent_does_not_spend_it(cw):
    rq = request(cw)
    consent(cw, rq)
    cw.hive.db.execute("UPDATE goals SET status = 'done' WHERE id = ?", (cw.task["id"],))
    assert error(raw(cw, rq))["code"] == "task_closed"
    cw.hive.db.execute("UPDATE goals SET status = 'open' WHERE id = ?", (cw.task["id"],))
    assert raw(cw, rq).status_code == 200


# ---- decline -------------------------------------------------------------------------------------------------

def test_a_decline_voids_consent_and_withdraws_an_issued_capability_until_accepted_anew(cw):
    rq = request(cw)
    consent(cw, rq)
    out = consent(cw, rq, decision="decline")
    assert out.status_code == 200 and out.json()["decision"] == "decline" and "consent_id" not in out.json()
    refused = raw(cw, rq)
    assert refused.status_code == 403 and error(refused)["code"] == "consent_required" and error(refused)["reason"] == "declined"
    consent(cw, rq)
    issued = raw(cw, rq)
    assert issued.status_code == 200
    consent(cw, rq, decision="decline")                      # declined after issue: that capability is withdrawn
    assert status(cw, issued.json()["claims"]["id"])["reason"] == "revoked"
    replay = raw(cw, rq)                                     # and the spent consent no longer re-issues
    assert replay.status_code == 403 and error(replay)["code"] == "consent_required"


def test_only_the_requests_person_declines(cw):
    rq = request(cw)
    consent(cw, rq)
    out = consent(cw, rq, decision="decline", who=cw.ann)
    assert out.status_code == 403 and error(out)["code"] == "not_request_person"
    assert raw(cw, rq).status_code == 200


def test_the_claims_switch_is_still_the_outer_off_switch(cw):
    rq = request(cw)
    consent(cw, rq)
    cw.hive.settings.copy_apply_claims = False
    out = cw.client.post(CAP, headers=agent_headers(cw.ctl), json=body(rq))
    assert out.status_code == 503 and error(out)["code"] == "copy_apply_off"
    assert consents(cw)[0]["spent_at"] is None



# ---- r2: the stand-in's consent r1 P2 (expiry at the spend instant) ----------------------------------------------

def expire_during_issue(w, monkeypatch):
    """The consent's deadline passes while the capability is being issued: after the consent was selected as live,
    before the conditional spend."""
    original = w.hive.services.issue

    def crossing(*args, **kwargs):
        out = original(*args, **kwargs)
        w.hive.db.execute("UPDATE copy_apply_consents SET expires_at = ? WHERE decision = 'accept'",
                          (__import__("time").time() - 0.001,))
        return out
    monkeypatch.setattr(w.hive.services, "issue", crossing)


def test_a_consent_that_expires_during_the_initial_issue_refuses_and_rolls_back(cw, monkeypatch):
    rq = request(cw)
    consent(cw, rq)
    before = written(cw.hive)
    expire_during_issue(cw, monkeypatch)
    out = raw(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "consent_required", out.text
    assert written(cw.hive) == before                       # no capability, binding or operation record survives
    row = consents(cw)[0]
    assert row["spent_at"] is None and row["capability_id"] is None


def test_a_consent_that_expires_during_a_replay_refuses_and_keeps_the_earlier_capability(cw, monkeypatch):
    rq = request(cw)
    consent(cw, rq)
    first = raw(cw, rq).json()
    before = written(cw.hive)
    expire_during_issue(cw, monkeypatch)
    out = raw(cw, rq)                                        # the same operation, replayed across the deadline
    assert out.status_code == 403 and error(out)["code"] == "consent_required", out.text
    assert written(cw.hive) == before
    assert consents(cw)[0]["capability_id"] == first["claims"]["id"]
    assert status(cw, first["claims"]["id"])["active"] is True   # the replay's revocation rolled back with it


# ---- r2: the capability names the consent that authorised it -----------------------------------------------------

def test_the_capability_names_the_consent_it_spent_beside_the_closed_binding(cw):
    rq = request(cw)
    view = consent(cw, rq).json()
    out = raw(cw, rq).json()
    claims = out["claims"]
    assert claims["copy_apply_consent"] == {"consent_id": view["consent_id"], "accepted_at": view["created_at"]}
    assert "consent_id" not in claims["copy_apply"]          # Code's binding validator keeps that set closed
    assert status(cw, claims["id"])["claims"] == claims       # Code compares the live status claims byte for byte
    again = raw(cw, rq).json()                               # a replay under the same consent names the same consent
    assert again["claims"]["copy_apply_consent"] == claims["copy_apply_consent"]
    cw.hive.db.execute("UPDATE copy_apply_consents SET expires_at = expires_at - 601")
    fresh = consent(cw, rq).json()
    renewed = raw(cw, rq).json()                             # a replay under a fresh accept names the fresh one
    assert renewed["claims"]["copy_apply_consent"]["consent_id"] == fresh["consent_id"] != view["consent_id"]


def test_services_issue_pairs_copy_apply_with_its_consent_claim(cw):
    import datetime
    common = dict(actor=cw.ctl["id"], kind="agent", task_id=cw.task["id"], swarm_id=cw.origin["id"], repository_id="synthetic",
                  member_token="t", grant_id=cw.grant["id"], max_runs=0, max_runtime_seconds=0,
                  exp=int(datetime.datetime.now().timestamp()) + 60)
    good = {"consent_id": "cns_" + "ab" * 16, "accepted_at": "2026-10-09T00:00:00.000Z"}
    for extra in ({"copy_apply": {"purpose": "workspace-copy-apply"}},                         # no consent claim
                  {"copy_apply": {"purpose": "workspace-copy-apply"}, "copy_apply_consent": good | {"more": "x"}},
                  {"copy_apply": {"purpose": "workspace-copy-apply"}, "copy_apply_consent": {"consent_id": ""} | {"accepted_at": "a"}}):
        with pytest.raises(Exception) as refused:
            cw.hive.services.issue("svc_code", actions=["proposal-apply"], **common, **extra)
        assert refused.value.code == "bad_purpose", extra
    with pytest.raises(Exception) as refused:                                                  # a consent claim alone
        cw.hive.services.issue("svc_code", actions=["read"], actor="user:u_jon", kind="human", task_id=cw.task["id"],
                               swarm_id=cw.origin["id"], repository_id="synthetic", grant_id=cw.grant["id"], copy_apply_consent=good)
    assert refused.value.code == "bad_purpose"


# ---- r3: the stand-in's consent r2 P1 (replacing or withdrawing a consent withdraws what it issued) ---------------

def restarted(w):
    """A restarted hive over the same data directory (same database), with the copy_apply switch on as before."""
    import pathlib

    from fastapi.testclient import TestClient

    from hive.core.app import create_app
    from hive.core.config import load_settings
    from hive.tests.test_core_api import FakeSupervisor
    settings = load_settings(data_dir=pathlib.Path(w.hive.settings.data_dir), admin_password="pw", petta_path=w.hive.settings.petta_path)
    settings.copy_apply_claims = True
    return TestClient(create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0))


def status_on(client, w, cap_id):
    out = client.get(f"/api/services/capabilities/{cap_id}", headers=w.svc)
    assert out.status_code == 200, out.text
    return out.json()


@pytest.mark.parametrize("second_digest", [SUGGESTION_DIGEST, OTHER_DIGEST], ids=["same-digest", "other-digest"])
def test_a_new_accept_revokes_the_capability_issued_under_the_old_consent(cw, second_digest):
    rq = request(cw)
    a = consent(cw, rq).json()
    first = raw(cw, rq)
    assert first.status_code == 200 and status(cw, first.json()["claims"]["id"])["active"] is True
    b = consent(cw, rq, suggestion_digest=second_digest).json()          # the person accepts again: B replaces A
    st = status(cw, first.json()["claims"]["id"])
    assert st["active"] is False and st["reason"] == "revoked", st     # A's capability is withdrawn with A
    rows = {r["id"]: r for r in consents(cw)}
    assert rows[a["consent_id"]]["voided_at"] is not None and rows[b["consent_id"]]["voided_at"] is None
    if second_digest == SUGGESTION_DIGEST:                              # the controller spends B for its operation
        again = raw(cw, rq)
        assert again.status_code == 200, again.text
        assert again.json()["claims"]["copy_apply_consent"]["consent_id"] == b["consent_id"]
        assert status(cw, again.json()["claims"]["id"])["active"] is True
        assert status(cw, first.json()["claims"]["id"])["active"] is False


def test_a_decline_after_a_replacement_withdraws_every_capability_under_the_proposal(cw):
    rq = request(cw)
    consent(cw, rq)
    first = raw(cw, rq).json()
    consent(cw, rq)
    second = raw(cw, rq).json()                                         # the same operation under the newer accept
    consent(cw, rq, decision="decline")
    for cap in (first, second):
        assert status(cw, cap["claims"]["id"])["active"] is False
    assert all(r["voided_at"] is not None for r in consents(cw) if r["decision"] == "accept")
    replay = raw(cw, rq)
    assert replay.status_code == 403 and error(replay)["code"] == "consent_required" and error(replay)["reason"] == "declined"


@pytest.mark.parametrize("legacy", ["newer-accept", "decline", "voided", "missing"])
def test_every_use_rechecks_the_consent_even_when_a_revocation_was_missed(cw, legacy):
    """A database written before r3 can hold a capability whose consent was replaced or withdrawn without revoking it
    (or a capability naming a consent that does not exist): its live status refuses it, without relying on revocation."""
    rq = request(cw)
    a = consent(cw, rq).json()
    cap = raw(cw, rq).json()["claims"]
    assert status(cw, cap["id"])["active"] is True
    row = consents(cw)[0]
    if legacy in ("newer-accept", "decline"):                           # recorded the r2 way: no void, no revocation
        cw.hive.db.insert("copy_apply_consents", dict(row) | {"id": "cns_" + "9a" * 16, "decision": legacy.split("-")[-1],
                                                              "created_at": now_stamp(), "spent_at": None, "spent_by": None,
                                                              "capability_id": None, "voided_at": None})
    elif legacy == "voided":
        cw.hive.db.execute("UPDATE copy_apply_consents SET voided_at = 1 WHERE id = ?", (a["consent_id"],))
    else:
        cw.hive.db.execute("DELETE FROM copy_apply_consents WHERE id = ?", (a["consent_id"],))
    st = status(cw, cap["id"])
    assert st["active"] is False and st["reason"] == "consent_withdrawn", st
    assert st["copy_apply_status"] == {"request_open": True, "lease_live": True, "controller_current": True}


def now_stamp():
    from hive.core.db import now
    return now()


def test_replacement_and_withdrawal_hold_across_a_restart_and_a_replay(cw):
    rq = request(cw)
    consent(cw, rq)
    a_cap = raw(cw, rq).json()["claims"]["id"]
    b = consent(cw, rq).json()                                          # B replaces A, then the hive restarts
    with restarted(cw) as again:
        assert status_on(again, cw, a_cap)["active"] is False
        replay = again.post(CAP, headers=agent_headers(cw.ctl), json=body(rq))   # the A operation, replayed after restart
        assert replay.status_code == 200, replay.text
        b_cap = replay.json()["claims"]
        assert b_cap["copy_apply_consent"]["consent_id"] == b["consent_id"]
        assert status_on(again, cw, a_cap)["active"] is False and status_on(again, cw, b_cap["id"])["active"] is True
        out = again.post(f"/api/requests/{rq['request_id']}/proposals/{SUGGESTION}/decline", headers={**cw.jon, **ORIGIN},
                         json={"suggestion_digest": SUGGESTION_DIGEST})
        assert out.status_code == 200, out.text
    with restarted(cw) as again:                                        # withdrawn, and still withdrawn after a restart
        for cap in (a_cap, b_cap["id"]):
            assert status_on(again, cw, cap)["active"] is False
        replay = again.post(CAP, headers=agent_headers(cw.ctl), json=body(rq))
        assert replay.status_code == 403 and error(replay)["code"] == "consent_required"


def test_a_pre_r3_replacement_is_refused_after_a_restart(cw):
    """The r2 shape: A spent, B accepted for the same digest, A neither voided nor revoked. After a restart A's
    capability is refused at use, and replaying A's operation spends B, never revives A."""
    rq = request(cw)
    consent(cw, rq)
    a_cap = raw(cw, rq).json()["claims"]["id"]
    row = consents(cw)[0]
    cw.hive.db.insert("copy_apply_consents", dict(row) | {"id": "cns_" + "9b" * 16, "created_at": now_stamp(), "spent_at": None,
                                                          "spent_by": None, "capability_id": None, "voided_at": None})
    with restarted(cw) as again:
        st = status_on(again, cw, a_cap)
        assert st["active"] is False and st["reason"] == "consent_withdrawn", st


# ---- OI-4: the capability never outlives the consent window (Code consent-reference r1 audit) -------------------

def test_the_capability_expires_no_later_than_the_consent_it_spent(cw):
    rq = request(cw)
    consent(cw, rq)
    cw.hive.db.execute("UPDATE copy_apply_consents SET expires_at = ? WHERE decision = 'accept'",
                       (__import__("time").time() + 100,))
    out = raw(cw, rq)
    assert out.status_code == 200, out.text
    claims = out.json()["claims"]
    assert claims["exp"] <= int(consents(cw)[0]["expires_at"])
    assert claims["exp"] - claims["iat"] <= 100


def test_a_consent_with_under_a_second_left_issues_nothing(cw):
    rq = request(cw)
    consent(cw, rq)
    before = written(cw.hive)
    cw.hive.db.execute("UPDATE copy_apply_consents SET expires_at = ? WHERE decision = 'accept'",
                       (float(int(__import__("time").time())) + 0.5,))
    out = raw(cw, rq)
    assert out.status_code == 403 and error(out)["code"] == "consent_required", out.text
    assert written(cw.hive) == before
    assert consents(cw)[0]["spent_at"] is None
