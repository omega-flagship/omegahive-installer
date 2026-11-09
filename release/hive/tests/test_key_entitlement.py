"""keyview R10 (sol and Dot on 26e22ed0): "can pay" decides availability, "can see" decides key details.

A provider is connected, configured and listed in /api/models for a caller exactly when the gateway would admit a call by
their own mind on it (app.pay_route: Gateway.paying_key with OwnHive.own_key_for, Hive.payer_for, person_key_check,
use_check), whether or not they may see the key that pays. Readiness and the OpenRouter catalogue's fetch state describe
the hive's default paying route, so they are kept only for a caller who pays by it. Model and path fields of a refusal
keep their segments (typed projection). A private key added by someone else changes nothing anyone else is shown.
The world (test_key_visibility.p): Mia and Bob are members; Ann's personal key is the OpenRouter default; Mia and Bob
hold their own OpenRouter keys. OpenAI starts with no key at all. Invented keys, synthetic people, no network.
"""
import pytest

from hive.core import keyview
from hive.core.hive import token_hash
from hive.core.db import now

from hive.tests.test_ask_intents import ORIGIN, a, drain, held, release, token_of, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_key_visibility import openrouter, p  # noqa: F401  (fixture)
from hive.tests.test_mind_control import person, w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import MIA, add_key, s  # noqa: F401  (fixtures)
from hive.tests.test_studio_session_r7 import ANN_KEY, BOB

ANN = "user:u_ann"
ANN_OPENAI = "k_0000a0a2"
BOB_OPENAI = "k_0000b0b3"
MIA_OPENAI = "k_0000a003"
REFUSALS = ("own_key_needed", "no_key_grant", "own_key_required", "no_key", "key_unavailable")


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    """No network, ever (conftest deny_network)."""


def session_for(hive, principal):
    """Headers for an existing person (a fresh sign-in session)."""
    token = "t-" + principal.replace(":", "-") + "-r10"
    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso", "principal": principal})
    return {"Authorization": f"Bearer {token}", **ORIGIN}


def provider(c, name, headers=None):
    return next(v for v in c.get("/api/providers", headers=headers).json() if v["name"] == name)


def models(c, name, headers=None):
    return [m["id"] for m in c.get("/api/models", headers=headers).json() if m["provider"] == name]


def openai_default(p, key_id, owner, monkeypatch):
    add_key(p.hive, key_id, owner, provider="openai")
    p.hive.keyring.ring["defaults"]["openai"] = key_id
    p.hive.keyring._apply_defaults()
    monkeypatch.setitem(p.hive.keyring.provider("openai").prices, "gpt-5.4", {"in": 1, "out": 2})


def settles(p, who, model="openai/gpt-5.4"):
    """How a call by `who`'s own mind would settle, by the call path's own read-only lookups (Budgets.settlement)."""
    return p.hive.budgets.settlement({"id": "", "name": "probe", "owner": who}, model, turn_bound=False)


def test_a_member_granted_anns_private_default_key_sees_it_connected_with_models_and_can_pay(p, monkeypatch):
    """sol P1: entitlement, not visibility. Ann's private OpenAI key is the default; Mia holds a grant on it."""
    c = p.client
    ann = session_for(p.hive, ANN)
    openai_default(p, ANN_OPENAI, ANN, monkeypatch)
    before = provider(c, "openai", p.mg)
    assert (before["connected"], before["configured"], models(c, "openai", p.mg)) == (False, False, [])
    assert settles(p, MIA)["reason"] in REFUSALS                          # truthful: today she cannot pay with it
    r = c.post("/api/me/key-limits/grants", headers=ann, json={"grantee": MIA, "key_id": ANN_OPENAI, "month_usd": 5})
    assert r.status_code == 200, r.text
    after = provider(c, "openai", p.mg)
    assert (after["connected"], after["configured"]) == (True, True)
    assert models(c, "openai", p.mg) == ["openai/gpt-6.1", "openai/gpt-5.4"]
    pay = settles(p, MIA)
    assert pay["reason"] not in REFUSALS and pay["key_id"] == ANN_OPENAI, pay   # and the call path agrees: she can pay
    # can see: still nothing of Ann's key itself
    assert (after["key_hint"], after["account"], after["source"], after["keys"]) == ("", None, None, 0)
    assert ANN_OPENAI not in c.get("/api/providers/openai", headers=p.mg).text
    # Bob holds no grant: nothing changes for him
    bob = provider(c, "openai", p.bob)
    assert (bob["connected"], models(c, "openai", p.bob)) == (False, [])
    assert settles(p, BOB)["reason"] in REFUSALS


def test_a_guest_on_the_hives_public_key_terms_sees_it_connected_with_models_and_can_pay(p, monkeypatch):
    """sol P1: a guest pays on the owner's public hive-key terms (use_check), with a key they may never see."""
    c, hive = p.client, p.hive
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-openai-invented-0001")
    monkeypatch.setitem(hive.keyring.provider("openai").prices, "gpt-5.4", {"in": 1, "out": 2})
    guest = person(hive, "u_gus", role="member")
    hive.db.execute("UPDATE people SET access = 'guest' WHERE id = 'u_gus'")
    shut = provider(c, "openai", guest)
    assert (shut["connected"], models(c, "openai", guest)) == (False, [])        # private hive: no terms, no grant
    assert settles(p, "user:u_gus")["reason"] in REFUSALS
    r = c.put("/api/hive/own", headers=session_for(hive, hive.ownhive.owner()),
              json={"visibility": "public", "pays": "hive-key", "visitor_month_usd": 1})
    assert r.status_code == 200, r.text
    open_ = provider(c, "openai", guest)
    assert (open_["connected"], open_["configured"]) == (True, True)
    assert models(c, "openai", guest) == ["openai/gpt-6.1", "openai/gpt-5.4"]
    pay = settles(p, "user:u_gus")
    assert pay["reason"] not in REFUSALS and pay["key_id"] == "env:openai", pay
    assert (open_["key_hint"], open_["source"], open_["keys"]) == ("", None, 0)   # a guest never sees the hive's key


def test_bobs_private_default_readiness_never_describes_mias_own_key(p, monkeypatch):
    """sol P1: readiness is the default route's evidence; Mia pays with her own key, so hers is unverified."""
    c, hive = p.client, p.hive
    openai_default(p, BOB_OPENAI, BOB, monkeypatch)
    add_key(hive, MIA_OPENAI, MIA, provider="openai")
    hive.keyring._record_answer(("openai", "openai/gpt-5.4", hive.keyring._answer_config("openai")), True)
    assert c.get("/api/providers/openai").json()["readiness"] == "answered"           # the admin: the default answered
    assert provider(c, "openai", p.bob)["readiness"] == "answered"                      # Bob pays by that route
    mine = provider(c, "openai", p.mg)
    assert mine["connected"] is True and mine["source"] == "stored"                    # her own key pays, and she sees it
    assert (mine["readiness"], mine["answer_ready"]) == ("unverified", False)
    hive.keyring._record_answer(("openai", "openai/gpt-5.4", hive.keyring._answer_config("openai")), False)
    assert (provider(c, "openai", p.mg)["readiness"], provider(c, "openai", p.bob)["readiness"]) == \
        ("unverified", "not_answering")                                                 # Bob's failures never reach her


def test_a_private_openrouter_key_never_resets_the_shared_catalogue(p, monkeypatch):
    """sol P1: adding a private, non-default key used to zero fetched_at for everyone (and force an upstream fetch)."""
    c, hive = p.client, p.hive
    hive.keyring.catalog = {"models": [{"id": "x/y", "name": "Y"}], "fetched_at": 1_800_000_000.0, "error": None}

    async def verified(name, secret):
        return {"label": "invented"}
    monkeypatch.setattr(hive.keyring, "verify", verified)
    r = c.post("/api/keys", headers=p.bob, json={"provider": "openrouter", "key": "sk-bob-second-invented-0002",
                                                 "default": False})
    assert r.status_code in (200, 201), r.text
    assert hive.keyring.catalog["fetched_at"] == 1_800_000_000.0
    admin = openrouter(c.get("/api/providers").json())["catalog"]
    assert admin == {"count": 1, "fetched_at": 1_800_000_000.0, "error": None}
    # Mia pays OpenRouter with her own key, not the default the catalogue was fetched with: count only
    assert openrouter(c.get("/api/providers", headers=p.mg).json())["catalog"] == \
        {"count": 1, "fetched_at": None, "error": None}


def test_an_empty_environment_secret_is_no_key_for_anyone(p, monkeypatch):
    """Kimi on 26e22ed0: an env var holding only blanks pays for nothing, so it is neither counted nor connected."""
    monkeypatch.setenv("OPENAI_API_KEY", "   ")
    for headers in (p.mg, p.bob):
        seen = provider(p.client, "openai", headers)
        assert (seen["keys"], seen["connected"], models(p.client, "openai", headers)) == (0, False, [])


def test_model_and_path_fields_keep_their_segments_and_prose_does_not():
    """sol P2: typed projection. A model id or a path keeps its names; a key:<id> scope or a person in it still goes."""
    no = lambda key: False   # noqa: E731
    out = keyview.redact_error({"error": {"code": "unknown_model", "model": "openai/k_deadbeef",
                                          "path": "/models/k_deadbeef/config.json",
                                          "models": ["openai/k_deadbeef", "k_deadbeef"],
                                          "message": "openai/k_deadbeef is not here",
                                          "file": "/x/user:u_bob/key:k_deadbeef/y"}}, no, MIA)["error"]
    assert out == {"code": "unknown_model", "model": "openai/k_deadbeef", "path": "/models/k_deadbeef/config.json",
                   "models": ["openai/k_deadbeef", "a key"], "message": "openai/a key is not here",
                   "file": "/x/someone/key/y"}


def test_the_catalogue_route_shows_and_fetches_by_the_default_route_only(p, monkeypatch):
    """sol P1 on 4a542223: /api/providers/openrouter/catalog gave everyone the default route's fetch state, and refresh=1
    fetched with the default credential for anyone. Ann pays by the default (her key); Mia and Bob by their own."""
    c, hive = p.client, p.hive
    fetches = []
    stale = {"models": [{"id": "x/y", "name": "Y"}], "fetched_at": 0.0, "error": "could not fetch the OpenRouter catalogue"}
    hive.keyring.catalog = dict(stale)

    async def fetch(refresh=False):
        fetches.append(refresh)
        return {**hive.keyring.catalog, "fetched_at": 1_800_000_000.0, "error": None}
    monkeypatch.setattr(hive.keyring, "models", fetch)
    for who in (p.mg, p.bob):                                      # off the default route: the cache as it is, no fetch
        read = c.get("/api/providers/openrouter/catalog", headers=who)
        assert read.status_code == 200 and read.json() == {"models": stale["models"], "fetched_at": None, "error": None,
                                                            "can_refresh": False}
        refused = c.get("/api/providers/openrouter/catalog?refresh=1", headers=who)
        assert (refused.status_code, refused.json()["error"]["code"]) == (403, "refresh_not_allowed")
    assert fetches == []
    ann = session_for(hive, ANN)                                    # on it: the owner of the default key, and an admin
    fresh = c.get("/api/providers/openrouter/catalog?refresh=1", headers=ann).json()
    assert (fresh["fetched_at"], fresh["can_refresh"]) == (1_800_000_000.0, True)
    assert c.get("/api/providers/openrouter/catalog").status_code == 200
    assert fetches == [True, False]


def test_a_models_upstreams_are_fetched_by_the_default_route_only(p, monkeypatch):
    """sol P1 on 81359cdf: /api/providers/openrouter/endpoints/... fetched with the default credential for anyone (a cache
    miss, a stale entry, refresh=1) and answered with that key's outcome. Off the default route: the cache, as it is."""
    c, hive = p.client, p.hive
    fetches = []
    hive.keyring.endpoints.clear()
    hive.keyring.endpoints["x/old"] = (0.0, [{"name": "Old", "provider": "Old", "tag": "old/fp8"}])   # long stale

    async def fetch(model_id, refresh=False):
        fetches.append((model_id, refresh))
        raise __import__("hive.core.providers", fromlist=["ProviderError"]).ProviderError(
            502, "provider_error", "OpenRouter answered 401 (bad_key)")
    monkeypatch.setattr(hive.keyring, "model_endpoints", fetch)
    for who in (p.mg, p.bob):
        miss = c.get("/api/providers/openrouter/endpoints/x/new", headers=who)
        assert miss.status_code == 200 and miss.json() == {"model": "x/new", "endpoints": [], "known": False,
                                                           "can_refresh": False}
        stale = c.get("/api/providers/openrouter/endpoints/x/old", headers=who).json()
        assert (stale["endpoints"][0]["tag"], stale["known"]) == ("old/fp8", True)
        refused = c.get("/api/providers/openrouter/endpoints/x/old?refresh=1", headers=who)
        assert (refused.status_code, refused.json()["error"]["code"]) == (403, "refresh_not_allowed")
        assert "401" not in miss.text + refused.text
    assert fetches == []                                            # no fetch with the default credential for them
    ann = session_for(hive, ANN)                                    # on the default route: fetches, and sees its outcome
    out = c.get("/api/providers/openrouter/endpoints/x/new?refresh=1", headers=ann)
    assert out.status_code == 502 and "401" in out.text
    assert fetches == [("x/new", True)]


def test_the_default_accounts_refresh_is_caused_only_from_its_paying_route(p, monkeypatch):
    """sol P2 on d15396ca: GET /api/providers/{name} refreshed the default key's account (a verify with that credential)
    for anyone who could SEE the key. Mia, here a member who joined after H1 (access 'member'), sees the hive's
    environment key but cannot pay with it (a private hive, no grant): she reads the status, and causes no verify. Ann,
    whose key is the default, and an admin do."""
    c, hive = p.client, p.hive
    hive.db.execute("UPDATE people SET access = 'member' WHERE id = 'u_mia'")
    assert c.get("/api/providers/openrouter", headers=p.mg).status_code == 200 and p.refreshed == []
    assert c.get("/api/providers/openrouter", headers=session_for(hive, ANN)).status_code == 200
    assert p.refreshed == [ANN_KEY]
    p.refreshed.clear()
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-env-invented-0043")
    hive.keyring.ring["defaults"].pop("openrouter", None)
    hive.keyring._apply_defaults()
    seen = c.get("/api/providers/openrouter", headers=p.mg).json()
    assert seen["key_hint"] == "…0043" and seen["connected"] is False   # she may see it, and may not pay with it
    assert p.refreshed == []
    c.get("/api/providers/openrouter")                                  # the admin
    assert p.refreshed == ["env:openrouter"]


def test_no_refusal_code_or_kind_anywhere_in_the_hive_has_the_shape_of_an_id():
    """Kimi on 26e22ed0 (sol's open note): codes, kinds and reasons are pinned at their emitters, not only redacted at the
    boundary: every literal code a refusal is built with in hive/** is a word, never a key id or a person."""
    import ast
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[1]
    codes = set()
    for path in root.rglob("*.py"):
        if "tests" in path.parts:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None) or ""
            if not (name.endswith("Error") or name in ("_error", "_Stop", "refuse", "_refuse")):
                continue
            for arg in list(node.args[:3]) + [k.value for k in node.keywords if k.arg in ("code", "kind", "reason")]:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value and " " not in arg.value:
                    codes.add(arg.value)
    assert len(codes) > 100, len(codes)                             # the walk found the hive's refusals
    shaped = sorted(c for c in codes if keyview.IDENTITY.search(c))
    assert shaped == [], shaped
