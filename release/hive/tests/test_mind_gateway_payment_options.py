"""First Light (sol on 0f88cf5d): the personal mind's browser route pays exactly as its page says. The mind gateway
resolves its key from the mind's payment options (Gateway.payment_options: the assigned key and its lock), the same
ones Budgets.settlement reads, so an owner's assigned, locked key is used and stays locked on that route too. Invented
keys, synthetic people, disposable hives; no network.
"""
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1c import call, code, gw, mint, open_turn  # noqa: F401  (fixture)

KEY = "k_0000a11a"


def lock_her_key(hive, mind_id):
    hive.keyring.ring["keys"][KEY] = {"id": KEY, "provider": "fakepaid", "label": "Ann's", "owner": "user:u_ann",
                                      "secret": "sk-fakepaid-ann", "created_at": 0}
    hive.ownhive._write_limit("user:u_ann", "*", "self", 10.0, None, "owner", "", "user:u_ann")   # her own monthly total
    hive.db.execute("UPDATE agents SET options = ? WHERE id = ?", ('{"key": "%s", "key_locked": true}' % KEY, mind_id))


def test_an_assigned_locked_own_key_is_what_the_browser_call_pays_with_and_what_the_page_says(gw):
    client, hive, mine = gw["client"], gw["hive"], gw["mine"]
    lock_her_key(hive, mine["id"])
    stored = hive._agent_row(mine["id"])
    s = hive.personal.settlement(stored, stored["model"])
    assert (s["key_id"], s["payer"], s["own_key"], s["bounded"]) == (KEY, "user:u_ann", True, True)
    assert client.get("/api/me/mind", headers=gw["ann"]).json()["mind"]["paid_by"] == "you, on your own key"
    seen = []
    real_chat = gw["fake"].chat
    async def chat(agent, body):                 # what the gateway's own chat resolves its key from (Gateway.paying_key)
        seen.append(client.app.state.gateway.paying_key(agent, "fakepaid")[0])
        return await real_chat(agent, body)
    client.app.state.gateway.chat = chat
    admitted, real_check = [], hive.check_budget
    def check(agent, paid=False, estimate=0.0, key_id=None, payer=None, own_key=False, *a, **k):
        admitted.append((key_id, payer, own_key))
        return real_check(agent, paid, estimate, key_id, payer, own_key, *a, **k)
    hive.check_budget = check
    try:
        r = call(client, mint(client, gw["ann"]), open_turn(client, gw["ann"], "op-pay-0001"))
    finally:
        del hive.check_budget
    assert r.status_code == 200, r.text
    assert admitted == [(KEY, "user:u_ann", True)], "admitted on her key, as hers, under her own total"
    assert seen == [KEY], "and sent on it, not on the hive's"


def test_a_locked_key_that_is_gone_refuses_the_browser_call_instead_of_falling_back_to_the_hive(gw):
    client, hive, mine = gw["client"], gw["hive"], gw["mine"]
    lock_her_key(hive, mine["id"])
    del hive.keyring.ring["keys"][KEY]
    stored = hive._agent_row(mine["id"])
    assert hive.personal.settlement(stored, stored["model"])["reason"] == "key_unavailable"
    r = call(client, mint(client, gw["ann"]), open_turn(client, gw["ann"], "op-pay-0002"))
    assert (r.status_code, code(r)) == (402, "key_unavailable"), r.text
    assert gw["fake"].bodies == [] and hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 0



import pytest  # noqa: E402


@pytest.mark.parametrize("when", ["after_preflight", "at_send"])
def test_a_locked_key_deleted_mid_admission_is_never_replaced_by_the_hives(gw, monkeypatch, when):
    """Dot on 1781eb52: her locked key goes while the call is being admitted. After the preflight, the reservation
    rereads her monthly total on that key and refuses; at the send, the key is resolved again from the same payment
    options and refused (key_unavailable). Either way nothing is sent or spent, and never on the hive's key.
    NOTE: Gateway.chat is replaced here by a stand-in that does only the real chat's first step (Gateway.paying_key on
    the agent it is given) and then the fixture's fake model; the real chat's network send is not exercised."""
    from hive.core.gateway import GatewayError
    client, hive, mine = gw["client"], gw["hive"], gw["mine"]
    lock_her_key(hive, mine["id"])
    gateway = client.app.state.gateway
    gone = lambda: hive.keyring.ring["keys"].pop(KEY, None)   # noqa: E731
    sent, resolved = [], []
    if when == "after_preflight":
        real_check = hive.check_budget

        def check_then_delete(*a, **k):
            out = real_check(*a, **k)
            gone()
            return out
        monkeypatch.setattr(hive, "check_budget", check_then_delete)
    real_chat = gw["fake"].chat

    async def chat(agent, body):                          # the real Gateway.chat's first step: resolve the paying key
        if when == "at_send":
            gone()
        try:
            resolved.append(gateway.paying_key(agent, "fakepaid")[0])
        except GatewayError as exc:
            resolved.append(exc.code)
            raise
        sent.append(1)
        return await real_chat(agent, body)
    gateway.chat = chat
    r = call(client, mint(client, gw["ann"]), open_turn(client, gw["ann"], "op-pay-" + ("0003" if when == "at_send" else "0004")))
    assert r.status_code >= 400 and sent == [] and gw["fake"].bodies == [], (resolved, r.status_code, r.text)
    assert resolved == ([] if when == "after_preflight" else ["key_unavailable"]), resolved
    if when == "after_preflight":
        assert (r.status_code, r.json()["error"]["limit"]["reason"]) == (402, "monthly_total_required")
    assert hive.db.one("SELECT COUNT(*) AS n FROM usage")["n"] == 0
    assert hive.db.one("SELECT COUNT(*) AS n FROM cost_reservations WHERE state IN ('reserved', 'dispatched')")["n"] == 0
