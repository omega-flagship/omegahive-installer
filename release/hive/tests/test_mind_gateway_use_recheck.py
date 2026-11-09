"""Gateway on the money port (r2): the personal-mind gateway's reservation reads the calling person's use of the key again
(cost_reservations.host_use_check), as chat, embeddings, media and the Ask conductor do (money port r1.2).

A mind token is minted and the preflight (Hive.check_budget) passes; the person is then disabled before the reservation.
The call is refused 402 inside the reservation's transaction: nothing reserved, no Idempotency-Key record, no provider
call, and the turn closes on the spend limit. Deterministic: the change is made right after the real preflight returns.
Synthetic people, disposable hives; no network.
"""
import pytest

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1c import call, code, gw, mint, open_turn  # noqa: F401  (fixture)


def after_preflight(monkeypatch, hive, change):
    """Run `change` once, right after the call's real preflight (Hive.check_budget) has passed."""
    real, done = hive.check_budget, []

    def checked(*args, **kwargs):
        out = real(*args, **kwargs)
        if not done:
            done.append(1)
            change()
        return out
    monkeypatch.setattr(hive, "check_budget", checked)
    return done


@pytest.mark.parametrize("keyed", [False, True])
def test_a_person_disabled_after_preflight_is_refused_with_nothing_reserved_or_sent(gw, monkeypatch, keyed):
    client, hive = gw["client"], gw["hive"]
    token = mint(client, gw["ann"])
    turn = open_turn(client, gw["ann"], "op-urc-000" + ("1" if keyed else "2"))
    done = after_preflight(monkeypatch, hive,
                           lambda: hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_ann'"))
    r = call(client, token, turn, extra={"Idempotency-Key": "urc-key-1"} if keyed else None)
    assert done, "the preflight passed and the person was disabled after it"
    assert (r.status_code, code(r)) == (402, "spend_limit"), r.text
    assert r.json()["error"]["limit"]["kind"] == "no_key_grant"                         # the use check, not a cap
    assert hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations")["n"] == 0          # nothing reserved
    assert gw["fake"].bodies == []                                                        # no provider call
    assert hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 0                       # nothing spent
    if hive.db.one("SELECT name FROM sqlite_master WHERE name = 'mind_idem'") is not None:
        assert hive.db.one("SELECT COUNT(*) AS n FROM mind_idem")["n"] == 0               # the key's record rolled back
    assert keyed is False or hive.db.one("SELECT name FROM sqlite_master WHERE name = 'mind_idem'") is not None
    assert hive.db.one("SELECT state FROM ask_turns WHERE id = ?", (turn,))["state"] != "browser"   # closed host-side


def test_control_the_same_call_without_the_change_is_answered(gw):
    client = gw["client"]
    token = mint(client, gw["ann"])
    r = call(client, token, open_turn(client, gw["ann"], "op-urc-0003"))
    assert r.status_code == 200, r.text
    assert len(gw["fake"].bodies) == 1
