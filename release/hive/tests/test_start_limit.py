# Purpose: tests of the starting limit: a fresh install's first key brings a hive month cap, unless an operator's
# setting limits the hive.
"""The starting limit (Jon 2026-11-09): on a fresh install the first key an admin or the owner adds brings a month limit
(HIVE_START_LIMIT_MONTH_USD, $50 by default, 0 = off), so the first paid call is admitted and still bounded.

Gateway off (Mac and the Linux kit): a hive month total, set through the Limits page's own write (Budgets.set), only
while the hive has none, decided and written in one transaction. Gateway on: the owner's all-keys total, through the
month_usd path (check_total, write_total last, only if unchanged). Never for a member, never over a limit that exists.
Synthetic people, invented keys, disposable hives; no network (the provider check is stubbed).
"""
import pytest

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1 import _total, _verify_stub, money, money_gw  # noqa: F401  (fixtures)


def _post(client, headers, key, **extra):
    return client.post("/api/keys", headers=headers, json={"provider": "openrouter", "key": key, **extra})


def _zero_mind(m):
    """An ordinary mind with no cap of its own (budget_usd 0), as a fresh install's minds are."""
    client, hive = m["client"], m["hive"]
    sw = client.post("/api/swarms", headers=m["owner"], json={"name": "Fresh"}).json()
    a = client.post("/api/agents", headers=m["owner"], json={"name": "Nova", "kind": "omega", "swarm_id": sw["id"],
                                                             "model": "openrouter/test/nova"}).json()
    row = hive._agent_row(a["id"])
    assert float(row["budget_usd"] or 0) == 0
    return row


def _hive_month(hive):
    row = hive.db.one("SELECT * FROM budgets WHERE scope = 'hive' AND period = 'month'")
    return None if row is None else float(row["limit_usd"])


def test_gateway_off_first_key_sets_a_50_hive_total_and_a_zero_mind_is_then_admitted(money, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    mind = _zero_mind(money)
    assert hive.budgets.paid_without_cap(mind) is False, "before: no total, so a $0 mind's paid call is refused"
    r = _post(client, money["owner"], "sk-or-start-first")
    assert r.status_code == 200, r.text
    assert r.json()["starting_limit"] == {"usd": 50.0, "scope": "hive"}
    assert "monthly_total_applied" not in r.json()
    assert _hive_month(hive) == 50.0 and hive.budgets.hive_cap()["limit_usd"] == 50.0
    assert hive.budgets.paid_without_cap(mind) is True
    # the Limits page shows it as a set total, and lists the setting as a server setting
    limits = client.get("/api/budgets/limits", headers=money["owner"]).json()
    assert limits["hive"]["cap"]["limit_usd"] == 50.0 and limits["hive"]["cap"]["source"] == "set"
    named = {s["name"]: s for s in limits["server_settings"]}
    assert named["HIVE_START_LIMIT_MONTH_USD"]["value"] == 50.0 and named["HIVE_START_LIMIT_MONTH_USD"]["applies"] is False
    # the second key changes nothing: a total exists
    r = _post(client, money["owner"], "sk-or-start-second")
    assert r.status_code == 200 and "starting_limit" not in r.json() and _hive_month(hive) == 50.0


def test_gateway_off_an_existing_total_is_untouched(money, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    hive.budgets.set("hive", "day", 2.0)                                     # a day rule is a hive cap too
    r = _post(client, money["owner"], "sk-or-start-existing")
    assert r.status_code == 200 and "starting_limit" not in r.json()
    assert _hive_month(hive) is None and (hive.budgets.hive_cap()["period"], hive.budgets.hive_cap()["limit_usd"]) == ("day", 2.0)


def test_setting_zero_sets_nothing_and_the_setting_reads_as_server_settings(money, monkeypatch):
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    hive.settings.start_limit_month_usd = 0.0
    hive.settings.budget_env = {**(hive.settings.budget_env or {}), "HIVE_START_LIMIT_MONTH_USD": "0"}
    named = {s["name"]: s for s in hive.budgets.server_settings()}
    assert (named["HIVE_START_LIMIT_MONTH_USD"]["set"], named["HIVE_START_LIMIT_MONTH_USD"]["applies"]) == (True, False)
    r = _post(client, money["owner"], "sk-or-start-zero")
    assert r.status_code == 200 and "starting_limit" not in r.json()
    assert hive.budgets.hive_cap() is None


def test_a_member_key_sets_nothing(money, money_gw, monkeypatch):
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    for gw in ("", "1"):
        monkeypatch.setenv("HIVE_MIND_GATEWAY", gw)
        r = _post(client, money["pat"], f"sk-or-start-member-{gw or 'off'}")
        assert r.status_code == 200 and "starting_limit" not in r.json(), r.text
        assert hive.budgets.hive_cap() is None and _total(hive, money["P"]) is None


def test_gateway_off_a_total_set_between_read_and_write_stands(money, monkeypatch):
    """The check and the write are one transaction: a total that lands first is seen there, never overwritten."""
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    real = hive.budgets.hive_cap
    state = {"n": 0}

    def racing(rules=None):
        # the first look (from anywhere before the transaction) sees none; then someone sets $7 on the Limits page
        state["n"] += 1
        if state["n"] == 1 and real(rules) is None:
            hive.budgets.set("hive", "month", 7.0, "set by a person meanwhile")
        return real(None)
    monkeypatch.setattr(hive.budgets, "hive_cap", racing)
    r = _post(client, money["owner"], "sk-or-start-race")
    assert r.status_code == 200 and "starting_limit" not in r.json(), r.text
    assert _hive_month(hive) == 7.0


def test_seed_start_total_decides_inside_its_transaction(money):
    hive = money["hive"]
    with hive.db.transaction():
        hive.budgets.set("hive", "month", 9.0)
        assert hive.budgets.seed_start_total() is None                       # nested: the open write is seen
    assert _hive_month(hive) == 9.0
    hive.db.execute("DELETE FROM budgets WHERE scope = 'hive'")
    assert hive.budgets.seed_start_total()["limit_usd"] == 50.0 and hive.budgets.seed_start_total() is None


def test_gateway_on_no_own_total_sets_it_through_write_total(money_gw, monkeypatch):
    client, hive, O = money_gw["client"], money_gw["hive"], money_gw["O"]
    _verify_stub(hive, [])
    calls = []
    real = hive.ownhive.write_total

    def spy(viewer, month, seen=None):
        calls.append((month, seen is not None))
        return real(viewer, month, seen)
    monkeypatch.setattr(hive.ownhive, "write_total", spy)
    assert _total(hive, O) is None
    r = _post(client, money_gw["owner"], "sk-or-start-own")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["starting_limit"] == {"usd": 50.0, "scope": "own"}
    assert "monthly_total_applied" not in body and "monthly_total_usd" not in body, "the request named no month_usd"
    assert _total(hive, O) == 50.0
    assert calls == [(50.0, False), (50.0, True)], "the month_usd path: a first look, then the write last"
    assert hive.budgets.hive_cap() is None, "gateway on: the owner's own total, not a hive total"
    r = _post(client, money_gw["owner"], "sk-or-start-own-2")
    assert r.status_code == 200 and "starting_limit" not in r.json() and _total(hive, O) == 50.0


def test_gateway_on_an_own_total_set_meanwhile_stands(money_gw, monkeypatch):
    client, hive, O = money_gw["client"], money_gw["hive"], money_gw["O"]
    _verify_stub(hive, [])
    real = hive.ownhive.write_total

    def racing(viewer, month, seen=None):
        if seen is not None:                                                 # just before the write last: someone sets $8
            hive.ownhive._write_limit(O, "*", "self", 8.0, None, "owner", "", O)
        return real(viewer, month, seen)
    monkeypatch.setattr(hive.ownhive, "write_total", racing)
    r = _post(client, money_gw["owner"], "sk-or-start-own-race")
    assert r.status_code == 200 and "starting_limit" not in r.json(), r.text
    assert _total(hive, O) == 8.0


@pytest.mark.parametrize("gw", ["", "1"])
def test_a_request_with_month_usd_behaves_as_before(money, monkeypatch, gw):
    monkeypatch.setenv("HIVE_MIND_GATEWAY", gw)
    client, hive, O = money["client"], money["hive"], money["O"]
    _verify_stub(hive, [])
    r = _post(client, money["owner"], "sk-or-start-month", month_usd=12)
    assert r.status_code == 200, r.text
    body = r.json()
    if gw:
        assert body["monthly_total_applied"] is True and body["monthly_total_usd"] == 12.0 and _total(hive, O) == 12.0
        assert "starting_limit" not in body and hive.budgets.hive_cap() is None
    else:   # gateway off: month_usd ignored as before; the starting hive total is always the setting
        assert "monthly_total_applied" not in body and _total(hive, O) is None
        assert body["starting_limit"] == {"usd": 50.0, "scope": "hive"}


def test_an_unreadable_setting_refuses_the_start(monkeypatch, tmp_path):
    # T-215: was the default with a warning; now, like every key of config.KEYS, a malformed value refuses (exit 78)
    from hive.core.config import SettingsRefused, load_settings
    monkeypatch.delenv("HIVE_CONFIG_FILE", raising=False)
    for raw, want in (("", 50.0), ("0", 0.0), ("25.5", 25.5), ("1000000", 1_000_000.0)):
        monkeypatch.setenv("HIVE_START_LIMIT_MONTH_USD", raw)   # "" is unset: hive/config.json's 50
        assert load_settings(data_dir=tmp_path).start_limit_month_usd == want, raw
    for raw in ("abc", "-3", "nan", "2e6"):
        monkeypatch.setenv("HIVE_START_LIMIT_MONTH_USD", raw)
        with pytest.raises(SettingsRefused, match=f"HIVE_START_LIMIT_MONTH_USD={raw!r} in the environment is not"):
            load_settings(data_dir=tmp_path)


# ---- never over an operator's cap; the admin's own month_usd (coordinator, 2026-11-09) --------------------------------

def _until_total_names():
    """The settings server_settings marks as limiting a hive only while it has no total, read from a disposable hive."""
    import pathlib
    import tempfile
    from hive.core.config import load_settings
    from hive.core.hive import Hive
    from hive.tests.test_core_api import PETTA
    h = Hive(load_settings(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="hive-test-")), admin_password="pw",
                           petta_path=PETTA))
    return [x["name"] for x in h.budgets.server_settings() if x.get("until_total")]


def test_the_blocking_settings_are_derived_and_cover_the_known_seeds():
    # the one seed left: the team default and the instruction ceiling are retired (config.RETIRED_ENV)
    assert set(_until_total_names()) == {"HIVE_BUDGET_USD"}


@pytest.mark.parametrize("name", ["HIVE_SWARM_MONTHLY_USD", "HIVE_PERSON_REQUEST_CEILING_USD"])
def test_a_retired_setting_never_blocks_the_starting_limit(money, monkeypatch, name):
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    hive.settings.budget_env = {**(hive.settings.budget_env or {}), name: "5"}
    assert hive.budgets.start_blocked_by() == []
    r = _post(client, money["owner"], f"sk-or-start-retired-{name.lower()}")
    assert r.status_code == 200 and r.json()["starting_limit"] == {"usd": 50.0, "scope": "hive"}, r.text


@pytest.mark.parametrize("name", ["HIVE_BUDGET_USD"])
def test_an_operators_setting_that_limits_a_hive_without_a_total_blocks_the_starting_limit(money, monkeypatch, name):
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    attr = {"HIVE_BUDGET_USD": "hive_budget_usd"}.get(name, name[len("HIVE_"):].lower())   # the Settings field
    setattr(hive.settings, attr, 5.0)
    hive.settings.budget_env = {**(hive.settings.budget_env or {}), name: "5"}
    assert hive.budgets.start_blocked_by() == [name]
    r = _post(client, money["owner"], f"sk-or-start-blocked-{attr}")
    assert r.status_code == 200 and "starting_limit" not in r.json(), r.text
    assert hive.budgets.hive_cap() is None, f"{name} stays the limit in force"
    # set to 0 (none): nothing to replace, so the starting limit is set
    setattr(hive.settings, attr, 0.0)
    hive.settings.budget_env[name] = "0"
    assert hive.budgets.start_blocked_by() == []
    r = _post(client, money["owner"], f"sk-or-start-zeroed-{attr}")
    assert r.status_code == 200 and r.json()["starting_limit"] == {"usd": 50.0, "scope": "hive"}


@pytest.mark.parametrize("asked", [0, 20, "abc", -1, 2_000_000, True, None])
def test_gateway_off_month_usd_never_sets_the_starting_total(money, monkeypatch, asked):
    """The own-key sheet's month_usd means the person's own keys: never a hive total, and never a $0 one."""
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    client, hive = money["client"], money["hive"]
    _verify_stub(hive, [])
    r = _post(client, money["owner"], "sk-or-start-asked", month_usd=asked)
    assert r.status_code == 200 and r.json()["starting_limit"] == {"usd": 50.0, "scope": "hive"}, r.text
    assert _hive_month(hive) == 50.0


def _start_entry(hive):
    return next(x for x in hive.budgets.server_settings() if x["name"] == "HIVE_START_LIMIT_MONTH_USD")


def test_the_start_settings_entry_names_its_scope_and_is_not_applied_while_blocked(money, monkeypatch):
    hive = money["hive"]
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    e = _start_entry(hive)
    assert e["applies"] is True and "hive cap for a month" in e["effect"]
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    e = _start_entry(hive)
    assert e["applies"] is True and "your own all-keys total" in e["effect"]
    hive.settings.hive_budget_usd = 5.0
    hive.settings.budget_env = {**(hive.settings.budget_env or {}), "HIVE_BUDGET_USD": "5"}
    for gw in ("", "1"):
        monkeypatch.setenv("HIVE_MIND_GATEWAY", gw)
        e = _start_entry(hive)
        assert e["applies"] is False and "HIVE_BUDGET_USD" in e["effect"], gw


def test_gateway_on_an_operators_cap_blocks_the_own_starting_total(money_gw):
    client, hive, O = money_gw["client"], money_gw["hive"], money_gw["O"]
    _verify_stub(hive, [])
    hive.settings.hive_budget_usd = 5.0
    hive.settings.budget_env = {**(hive.settings.budget_env or {}), "HIVE_BUDGET_USD": "5"}
    r = _post(client, money_gw["owner"], "sk-or-start-own-blocked")
    assert r.status_code == 200 and "starting_limit" not in r.json(), r.text
    assert _total(hive, O) is None


def test_gateway_on_a_refused_final_write_keeps_the_key_with_no_starting_limit(money_gw, monkeypatch):
    from hive.core.hive import HiveError
    client, hive, O = money_gw["client"], money_gw["hive"], money_gw["O"]
    _verify_stub(hive, [])
    real = hive.ownhive.write_total

    def refuse_last(viewer, month, seen=None):
        if seen is not None:
            raise HiveError(403, "owner_only", "refused at the last write")
        return real(viewer, month, seen)
    monkeypatch.setattr(hive.ownhive, "write_total", refuse_last)
    r = _post(client, money_gw["owner"], "sk-or-start-own-refused")
    assert r.status_code == 200 and "starting_limit" not in r.json(), r.text
    assert r.json()["id"] in hive.keyring.ring["keys"] and _total(hive, O) is None
