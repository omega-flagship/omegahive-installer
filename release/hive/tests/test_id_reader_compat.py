"""Reader-first compatibility: existing IDs and future128-bit IDs keep the same authority checks."""
import json
from types import SimpleNamespace

import pytest

from hive.core import budgets, config, cost_reservations, db, me_decisions, ownhive, studio_sessions
from hive.core.evolve_seed import inspect_pair
from hive.core.providers import clean_options
from hive.core.hive import HiveError
from hive.tests.test_core_api import client  # noqa: F401
from hive.tests.test_visibility import person


READERS = [
    (budgets.SCOPE, "agent:a_", ""), (budgets.SCOPE, "swarm:s_", ""),
    (budgets.SCOPE, "person:u_", ""), (budgets.SCOPE, "key:k_", ""),
    (cost_reservations.SUBJECT, "agent:a_", ":month"),
    (cost_reservations.SUBJECT, "swarm:s_", ":day"),
    (cost_reservations.SUBJECT, "person:u_", ":total"),
    (cost_reservations.SUBJECT, "key:k_", ":hard-total"),
    (config.MEDIA_ALLOW_ENTRY, "agent:a_", ""), (config.MEDIA_ALLOW_ENTRY, "swarm:s_", ""),
    (me_decisions.KEY, "k_", ""), (ownhive.LIMIT_ID, "kl_", ""),
    (ownhive.KEY_ID, "k_", ""), (ownhive.HOLD_KEY, "k_", ""),
    (studio_sessions.AGENT_ID, "a_", ""), (studio_sessions.SWARM_ID, "s_", ""),
    (studio_sessions.KEY_ID, "k_", ""),
]


BAD_SUFFIXES = (["a" * n for n in [7, *range(9, 32), 33]]
    + [char * width for width in (8, 32) for char in ("g", "A", "١", "ａ")]
    + ["a" * width + tail for width in (8, 32) for tail in ("\n", "\r", "\t", " ", "\n\n")]
    + [" " + "a" * width for width in (8, 32)])


@pytest.mark.parametrize("reader,prefix,suffix", READERS)
@pytest.mark.parametrize("digits,accepted", [("a" * 8, True), ("a" * 32, True), *[(value, False) for value in BAD_SUFFIXES]])
def test_only_legacy_or_full_new_ids_cross_the_existing_reader(reader, prefix, suffix, digits, accepted):
    assert bool(reader.fullmatch(prefix + digits + suffix)) is accepted


@pytest.mark.parametrize("width", [8, 32])
def test_media_configuration_and_provider_options_keep_the_exact_ids(monkeypatch, width):
    agent, swarm, key = (prefix + "a" * width for prefix in ("a_", "s_", "k_"))
    allowed = ["agent:" + agent, "swarm:" + swarm]
    monkeypatch.setenv("HIVE_MEDIA_ALLOW", json.dumps({"image": allowed + ["agent:a_" + "a" * 16]}))
    assert config._media_allow() == {"image": allowed}
    assert clean_options({"key": key})["key"] == key
    with pytest.raises(ValueError):
        clean_options({"key": "k_" + "a" * 16})


@pytest.mark.parametrize("width", [8, 32])
def test_native_pair_metadata_keeps_source_and_budget_guards(width):
    swarm = "s_" + "a" * width
    agents = [dict(id="a_" + char * width, kind=kind, driver=driver, status="stopped", visibility="private", swarm_id=swarm)
              for char, kind, driver in [("b", "omega", "local"), ("c", "iter", "docker")]]
    rules = [dict(scope="swarm:" + swarm, period="day", limit_usd=10),
             *[dict(scope="agent:" + a["id"], period="total", limit_usd=.5) for a in agents]]
    pins = {a["id"]: "d" * 64 for a in agents}
    assert inspect_pair(swarm, agents, rules, pins)["status"] == "metadata-qualified"
    assert inspect_pair(swarm, agents, rules, {})["status"] == "held"


@pytest.mark.parametrize("width", [8, 32])
def test_real_api_budget_key_and_studio_readers_keep_legacy_rows_and_new_ids(client, monkeypatch, width):
    # Production always writes32hex. Historical fixtures explicitly select legacy identities; never intercept CSPRNG.
    from hive.core import hive as writer
    assert len(db.new_id("probe").split("_")[1]) == 32
    original = writer.new_id
    with monkeypatch.context() as legacy_writer:
        legacy_writer.setattr(writer, "new_id", lambda prefix: "s_01234567" if prefix == "s" else original(prefix))
        legacy = client.post("/api/swarms", json={"name": "Retained legacy"}).json()
    assert legacy["id"] == "s_01234567"
    if width == 8:
        monkeypatch.setattr(writer, "new_id", lambda prefix: f"{prefix}_{db.secrets.token_hex(4)}" if prefix in ("a", "s") else original(prefix))
    assert len(db.new_id("probe").split("_")[1]) == 32  # fixture override never changes the production generator
    hive = client.app.state.hive
    # The retained row has an opaque existing identity; creating other entities must never rewrite it.
    owner_id = "u_" + "e" * width
    owner = person(client, owner_id, role="admin")
    key = "k_" + "f" * width
    hive.keyring.ring["keys"][key] = dict(id=key, provider="openrouter", label="Invented key", owner="user:" + owner_id,
                                         secret="invented-test-only", created_at=0)
    swarm = client.post("/api/swarms", headers=owner, json={"name": "New home"}).json()
    response = client.post("/api/agents", headers=owner, json={"name": "Maker", "swarm_id": swarm["id"], "model": "openrouter/test/maker", "options": {"key": key}})
    assert response.status_code == 200, response.text
    agent = response.json()
    assert len(agent["id"][2:]) == width
    scope = "agent:" + agent["id"]
    response = client.post("/api/budgets", json={"scope": scope, "period": "month", "limit_usd": 1})
    assert response.status_code == 200, response.text
    reservations = cost_reservations.Reservations(hive.db)
    reservations.reserve("invented-hold", {}, .25, lambda: [(scope + ":month", 1, 0)])
    assert reservations.pending(scope + ":day") == 250000  # same subject, newly selected period
    limit = client.put("/api/me/key-limits/self", headers=owner, json={"key_id": key, "month_usd": 1})
    assert limit.status_code == 200, limit.text
    revoked = client.delete("/api/me/key-limits/" + limit.json()["id"], headers=owner)
    assert revoked.status_code == 200, revoked.text
    projection = me_decisions.MeDecisions(hive, lambda _: None)
    assert projection._key_authority(key) == ("user:" + owner_id, "user:" + owner_id)
    request = dict(swarm_id=swarm["id"], maker_id=agent["id"], program_id="invented", app_pin={"id": "invented", "version": "1", "digest": "sha256:" + "a" * 64},
                   title="Invented", detail="", piece={"scene_id": "scene", "source_ref": None}, key_id=key, model=agent["model"], role_id=None,
                   tools=[], max_steps=12, window_minutes=60, consent_digest="sha256:" + "b" * 64)
    assert hive.studio.clean_request(request)["maker_id"] == agent["id"]
    assert hive.swarm(legacy["id"])["name"] == "Retained legacy"


def test_real_budget_subject_key_option_and_media_validators_refuse_every_noncanonical_suffix(client, monkeypatch):
    hive = client.app.state.hive
    for suffix in BAD_SUFFIXES:
        scope = "person:u_" + suffix
        response = client.post("/api/budgets", json={"scope": scope, "period": "month", "limit_usd": 1})
        assert response.status_code == 400, (repr(suffix), response.text)
        assert not hive.db.one("SELECT 1 FROM budgets WHERE scope = ?", (scope,))
        assert cost_reservations.subject_of("agent:a_" + suffix + ":month") is None
        with pytest.raises(ValueError):
            clean_options({"key": "k_" + suffix})
        monkeypatch.setenv("HIVE_MEDIA_ALLOW", json.dumps({"image": ["agent:a_" + suffix]}))
        assert config._media_allow() == {"image": []}
    for width in (8, 32):
        for tail in ("\n", "\r", "\t", " ", "\n\n"):
            assert cost_reservations.subject_of("agent:a_" + "a" * width + ":month" + tail) is None


def test_actual_own_key_and_hold_readers_refuse_recorded_keys_with_invalid_ids(client):
    hive = client.app.state.hive
    owner_id = "u_12345678"
    owner = person(client, owner_id, role="admin")
    for suffix in BAD_SUFFIXES:
        key = "k_" + suffix
        hive.keyring.ring["keys"][key] = dict(id=key, owner="user:" + owner_id, provider="openrouter", secret="invented-only")
        with pytest.raises(HiveError) as error:
            hive.ownhive._check_key("user:" + owner_id, key)
        assert error.value.status == 400, repr(suffix)
        assert hive.ownhive._hold_subjects(json.dumps({"payer": "user:" + owner_id, "key": key})) == ["*"]
    good = client.put("/api/me/key-limits/self", headers=owner, json={"month_usd": 1}).json()
    previous_id = good["id"]
    for suffix in BAD_SUFFIXES:
        bad_id = "kl_" + suffix
        hive.db.execute("UPDATE key_limits SET id = ? WHERE id = ?", (bad_id, previous_id))
        with pytest.raises(HiveError) as error:
            hive.ownhive.revoke_limit(SimpleNamespace(principal="user:" + owner_id), bad_id)
        assert error.value.status == 404, repr(suffix)
        assert hive.db.one("SELECT revoked_at FROM key_limits WHERE id = ?", (bad_id,))["revoked_at"] is None
        previous_id = bad_id
    hive.db.execute("UPDATE key_limits SET id = ? WHERE id = ?", (good["id"], previous_id))
    assert client.delete("/api/me/key-limits/" + good["id"], headers=owner).status_code == 200
