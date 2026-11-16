"""Members' own-key one-step setup (Jon 11-05: members' minds run on their own key; adding it is ONE friendly step).

The host's part: own_key_needed carries what the step needs (OwnHive.key_setup: the provider, its name, whether the
person already has their one monthly total, and the figure to suggest when not), from Studio setup and from the
personal mind's key check alike. The page's two calls (POST /api/keys, then PUT /api/me/key-limits/self, on a hive
without the mind gateway; features/ownKey/addOwnKey.ts) then make the very next setup admit on HER key, never a hive
key. Invented keys, synthetic people, disposable hives; no network (the provider check is stubbed).
"""
import pytest

from hive.tests.test_ask_intents import ORIGIN, a, held, release, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import KEY, MIA, err, s  # noqa: F401  (fixtures)
from hive.tests.test_studio_session_r7 import ANN_KEY, BOB, maker_of, personal_world, setup, tables

SECRET = "sk-or-mia-invented-0001"


@pytest.fixture()
def p(s, monkeypatch):
    x = personal_world(s, monkeypatch)
    del x.hive.keyring.ring["keys"][KEY]                                 # Mia has no key of her own
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)               # as both live hives: month_usd is ignored

    async def verify(name, key):                                         # the provider's check, stubbed (no network)
        return {"label": "OpenRouter key"}
    x.hive.providers.verify = verify
    return x


def no_total(x):
    x.hive.db.execute("UPDATE key_limits SET revoked_at = '2026-01-01T00:00:00+00:00' WHERE owner = ? AND grantee = 'self'",
                      (MIA,))


def test_own_key_needed_says_what_the_one_step_needs(p):
    r = setup(p)
    assert (r.status_code, err(r)["code"]) == (402, "own_key_needed")
    e = err(r)
    assert (e["provider"], e["provider_label"], e["has_total"], e["suggested_month_usd"]) == ("openrouter", "OpenRouter", True, None)
    no_total(p)
    e = err(setup(p))
    assert (e["has_total"], e["suggested_month_usd"]) == (False, 50.0), "no total yet: the member default is suggested"


def test_the_pages_two_calls_then_setup_admits_on_her_own_key_never_a_hive_key(p):
    hive, c = p.hive, p.client
    no_total(p)
    before = tables(hive)
    assert setup(p).status_code == 402 and tables(hive) == before and maker_of(p) is None
    added = c.post("/api/keys", headers=p.mg, json={"provider": "openrouter", "key": SECRET, "month_usd": 40})
    assert added.status_code == 200, added.text
    body = added.json()
    assert "monthly_total_applied" not in body, "a hive without the mind gateway ignores month_usd: the page must PUT"
    assert hive.ownhive.total_row(MIA) is None
    assert c.put("/api/me/key-limits/self", headers=p.mg, json={"key_id": "*", "month_usd": 40}).status_code == 200
    r = setup(p)
    assert r.status_code == 200, r.text
    maker = maker_of(p)
    key_id = __import__("json").loads(maker["options"])["key"]
    assert key_id == body["id"] and hive.keyring.ring["keys"][key_id]["owner"] == MIA, "her key, the one just added"
    assert key_id != ANN_KEY and not key_id.startswith("env:") and hive.ownhive.key_person(key_id) == MIA
    assert hive.keyring.ring["defaults"]["openrouter"] == ANN_KEY, "adding hers changed no one else's default"
    assert float(hive.ownhive.total_row(MIA)["month_usd"]) == 40.0


def test_the_key_saved_without_its_limit_makes_her_maker_on_her_key_and_nothing_else_pays(p):
    """The sheet's partial state ("key saved; set your monthly limit to continue"): the maker is hers, on her key; the
    missing total is what admission refuses next (monthly_total_required, the sheet's limit-only state), never a fallback."""
    hive, c = p.hive, p.client
    no_total(p)
    assert c.post("/api/keys", headers=p.mg, json={"provider": "openrouter", "key": SECRET}).status_code == 200
    r = setup(p)
    assert r.status_code == 200, r.text
    maker = r.json()["maker"]
    assert maker["own_key"] is True and hive.ownhive.key_person(maker["key_id"]) == MIA
    assert hive.ownhive.total_row(MIA) is None
    assert hive.ownhive.key_setup(MIA, "openrouter")["has_total"] is False


def test_the_personal_minds_key_check_carries_the_same_step(p):
    from hive.core.hive import HiveError
    hive = p.hive
    mind = {"id": "a_00000001", "model": "openrouter/test/maker", "owner": MIA, "personal_of": MIA}
    with pytest.raises(HiveError) as e:
        hive.ownhive.person_key_check(mind, ANN_KEY, user=MIA)          # Ann's key, the provider default, for Mia
    assert e.value.code == "own_key_needed"
    d = e.value.details
    assert (d["provider"], d["provider_label"], d["has_total"]) == ("openrouter", "OpenRouter", True)


# ---- R3 (sol on b7de1e5b): the total written only over the one shown; the exact-key duplicate; the host's suggestion ----

def test_the_total_is_written_only_over_the_one_she_was_shown(p):
    c = p.client
    no_total(p)
    put = lambda body: c.put("/api/me/key-limits/self", headers=p.mg, json={"key_id": "*", **body})   # noqa: E731
    r = put({"month_usd": 8})                                                      # someone (her other tab) sets $8
    assert r.status_code == 200
    r = put({"month_usd": 50, "expected_month_usd": None})                         # the sheet was shown "none set"
    assert (r.status_code, err(r)["code"], err(r)["monthly_total_usd"]) == (409, "limit_changed", 8.0)
    assert float(p.hive.ownhive.total_row(MIA)["month_usd"]) == 8.0, "theirs stands"
    r = put({"month_usd": 50, "expected_month_usd": 9})
    assert (r.status_code, err(r)["code"]) == (409, "limit_changed")
    assert put({"month_usd": 50, "expected_month_usd": 8}).status_code == 200      # her fresh consent over the $8 shown
    assert float(p.hive.ownhive.total_row(MIA)["month_usd"]) == 50.0
    no_total(p)
    assert put({"month_usd": 20, "expected_month_usd": None}).status_code == 200   # none set, as shown
    r = c.put("/api/me/key-limits/self", headers=p.mg, json={"key_id": ANN_KEY, "month_usd": 5, "expected_month_usd": None})
    assert r.status_code == 400, "expected_month_usd is for the all-keys total only"
    assert c.put("/api/me/key-limits/self", headers=p.mg, json={"key_id": "*", "month_usd": 30}).status_code == 200, \
        "without it: as before"


def test_a_duplicate_of_her_own_exact_key_says_so_without_the_secret_and_nobody_elses_does(p):
    c = p.client
    first = c.post("/api/keys", headers=p.mg, json={"provider": "openrouter", "key": SECRET})
    assert first.status_code == 200
    again = c.post("/api/keys", headers=p.mg, json={"provider": "openrouter", "key": SECRET})
    e = err(again)
    assert (again.status_code, e["code"], e.get("own"), e.get("key_id")) == (409, "duplicate_key", True, first.json()["id"])
    assert SECRET not in again.text
    bob = c.post("/api/keys", headers=p.bob, json={"provider": "openrouter", "key": SECRET})
    assert bob.status_code == 200 and bob.json()["id"] != first.json()["id"], "per owner: Bob's own row, no duplicate"
    assert SECRET not in bob.text


def test_no_oracle_a_secret_another_member_holds_is_answered_exactly_as_one_nobody_holds(p):
    """sol on 46f13f98 (P1): Ann sending a secret Bob already stores learns nothing from it. Same status, same body shape,
    the same one provider check, and her own row; Bob's row is untouched and nobody's money moves to anyone else's key."""
    hive, c = p.hive, p.client
    checked = []

    async def verify(name, key):
        checked.append(name)
        return {"label": "OpenRouter key"}
    hive.providers.verify = verify
    held = "sk-or-held-by-bob-invented-01"
    nobody = "sk-or-held-by-nobody-invented-02"
    bobs = c.post("/api/keys", headers=p.bob, json={"provider": "openrouter", "key": held})
    assert bobs.status_code == 200
    checked.clear()
    a = c.post("/api/keys", headers=p.mg, json={"provider": "openrouter", "key": held})
    b = c.post("/api/keys", headers=p.mg, json={"provider": "openrouter", "key": nobody})
    assert (a.status_code, b.status_code) == (200, 200) and checked == ["openrouter", "openrouter"]
    assert set(a.json()) == set(b.json())
    assert a.json()["label"] == b.json()["label"] == "OpenRouter key", "never Bob's label"
    ann_row = hive.keyring.ring["keys"][a.json()["id"]]
    assert ann_row["owner"] == MIA and a.json()["id"] != bobs.json()["id"]
    assert hive.keyring.ring["keys"][bobs.json()["id"]]["owner"] == BOB and hive.keyring.ring["keys"][bobs.json()["id"]]["secret"] == held
    # her paying key is her own row: the maker resolves to a key she owns, never Bob's
    hive.db.execute("UPDATE key_limits SET revoked_at = NULL WHERE owner = ?", (MIA,))
    r = setup(p)
    assert r.status_code == 200, r.text
    assert hive.ownhive.key_person(r.json()["maker"]["key_id"]) == MIA
    assert r.json()["maker"]["key_id"] != bobs.json()["id"]


def test_the_key_limits_read_carries_the_hosts_suggestion(p):
    body = p.client.get("/api/me/key-limits", headers=p.mg).json()
    assert body["suggested_month_usd"] == 50.0


def test_refreshing_a_key_is_only_for_keys_the_caller_is_shown_and_the_rest_is_one_404(p, monkeypatch):
    """sol on 7b40fdfe (P2): POST /api/keys/{id}/refresh described any key to anyone signed in. Now only a key GET
    /api/keys shows the caller may be refreshed; another person's key and a made-up id answer the same 404, before any
    lookup or provider call. Its owner and an admin still can."""
    from hive.tests.test_studio_session_r7 import BOB_KEY
    hive, c = p.hive, p.client
    refreshed = []

    async def refresh(key_id):
        refreshed.append(key_id)
    monkeypatch.setattr(hive.providers, "refresh_account", refresh)
    bobs = c.post(f"/api/keys/{BOB_KEY}/refresh", headers=p.mg)
    madeup = c.post("/api/keys/k_0000dead/refresh", headers=p.mg)
    assert (bobs.status_code, madeup.status_code) == (404, 404)
    assert bobs.json() == madeup.json() == {"error": {"code": "not_found", "message": "no such key"}}
    assert refreshed == [] and "Bob" not in bobs.text and BOB_KEY not in bobs.text
    own = c.post(f"/api/keys/{BOB_KEY}/refresh", headers=p.bob)
    assert own.status_code == 200 and own.json()["id"] == BOB_KEY
    admin = c.post(f"/api/keys/{BOB_KEY}/refresh")                                  # the operator: an admin
    assert admin.status_code == 200 and refreshed == [BOB_KEY, BOB_KEY]
