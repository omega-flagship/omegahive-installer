"""Gateway on the money port (composed r2): POST /api/keys with month_usd runs every check set_limit makes on the
person's all-keys total BEFORE anything is written (r1ab.4: never a key stored and then refused).

The recorded owner who is not acting as owner (demoted) is refused '*' by the money port's ruling 3 (on the recorded
owner, '*' spans the hive's keys). That refusal now comes from check_total, before the key is stored or a total written.
Dot's ruling (composed r2, item 1): that 403 stays; for the recorded owner '*' is owner authority, and everyone else's
'*' total is already a pure self-limit. No schema change.
Synthetic people, disposable hives; no network.
"""
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1 import OWNER, _total, _verify_stub, money, money_gw  # noqa: F401  (fixture)
from hive.tests.test_own_hive import _sign_in_again, code


def _demote_owner(client, hive):
    assert hive.ownhive.owner() == f"user:{OWNER}"                          # recorded before the demotion
    assert client.patch(f"/api/people/{OWNER}", json={"role": "member"}).status_code == 200
    return _sign_in_again(client, OWNER)


def _state(hive):
    return (dict(hive.keyring.ring["keys"]), dict(hive.keyring.ring.get("defaults") or {}),
            hive.db.one("SELECT COUNT(*) AS n FROM key_limits")["n"])


def test_a_demoted_owners_total_is_refused_before_any_key_is_stored(money_gw):
    # Dot's ruling (composed r2, item 1): for a demoted RECORDED owner '*' governs the hive's keys and hive minds: owner authority, not a self-limit
    client, hive = money_gw["client"], money_gw["hive"]
    _verify_stub(hive, [])
    demoted = _demote_owner(client, hive)
    before = _state(hive)
    for month, default in ((5, None), (5, False), (0.5, None)):             # a first total, non-default, lower
        body = {"provider": "openrouter", "key": f"sk-or-demoted-{month}-{default}", "month_usd": month}
        if default is not None:
            body["default"] = default
        r = client.post("/api/keys", headers=demoted, json=body)
        assert (r.status_code, code(r)) == (403, "owner_only"), r.text
        assert _state(hive) == before                                        # nothing stored, nothing switched
    # the same total over an existing one (a narrowing would be written first): refused first too
    hive.ownhive._write_limit(f"user:{OWNER}", "*", "self", 10.0, None, "owner", "", f"user:{OWNER}")
    before = _state(hive)
    r = client.post("/api/keys", headers=demoted, json={"provider": "openrouter", "key": "sk-or-demoted-low", "month_usd": 2})
    assert (r.status_code, code(r)) == (403, "owner_only") and _state(hive) == before and _total(hive, f"user:{OWNER}") == 10.0


def test_a_demoted_owner_still_adds_a_key_without_a_total_and_never_limits_env_keys(money_gw):
    client, hive = money_gw["client"], money_gw["hive"]
    _verify_stub(hive, [])
    demoted = _demote_owner(client, hive)
    r = client.post("/api/keys", headers=demoted, json={"provider": "openrouter", "key": "sk-or-demoted-plain"})
    assert r.status_code == 200, r.text                                      # no month_usd: as before
    n = hive.db.one("SELECT COUNT(*) AS n FROM key_limits")["n"]
    r = client.put("/api/me/key-limits/self", headers=demoted, json={"key_id": "env:openrouter", "month_usd": 3})
    assert (r.status_code, code(r)) == (403, "owner_only")
    assert hive.db.one("SELECT COUNT(*) AS n FROM key_limits")["n"] == n


def test_a_members_own_total_and_the_acting_owners_total_still_work(money_gw):
    client, hive, P = money_gw["client"], money_gw["hive"], money_gw["P"]
    _verify_stub(hive, [])
    for headers, who, month in ((money_gw["pat"], P, 4), (money_gw["owner"], f"user:{OWNER}", 6)):
        r = client.post("/api/keys", headers=headers, json={"provider": "openrouter", "key": f"sk-or-{month}", "month_usd": month})
        assert r.status_code == 200 and r.json()["monthly_total_applied"] is True, r.text
        assert _total(hive, who) == month
        r = client.post("/api/keys", headers=headers, json={"provider": "openrouter", "key": f"sk-or-{month}-up", "month_usd": month + 1})
        assert r.status_code == 200 and _total(hive, who) == month + 1                         # raised
        r = client.post("/api/keys", headers=headers, json={"provider": "openrouter", "key": f"sk-or-{month}-dn", "month_usd": 1})
        assert r.status_code == 200 and _total(hive, who) == 1                                 # lowered
