"""Gateway gate A: the browser mind's freshness checkpoint (browser-Iter plan r7.7 §8.3 rules 2-3, §11;
hive/core/mind_checkpoint.py). GET/PUT/DELETE /api/me/mind/checkpoint.

Synthetic people and digests only: no network, no provider, no memory content.
"""
import json
import threading

import pytest

from hive.core import mind_checkpoint as ckmod
from hive.tests.test_ask import world
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

ORIGIN = {"Origin": "http://127.0.0.1:8700"}
PATH = "/api/me/mind/checkpoint"
D1, D2, D3 = "a" * 64, "b" * 64, "c" * 64


@pytest.fixture()
def ck(client, monkeypatch):  # noqa: F811
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    w = world(client)
    w["client"] = client
    w["mine"] = w["hive"].personal.ensure("user:u_ann")
    return w


def get(client, who):  # noqa: F811
    return client.get(PATH, headers=who)


def put(client, who, match, digest=D1, version=1, **extra):  # noqa: F811
    headers = {**who, **ORIGIN}
    if match is not None:
        headers["If-Match"] = match
    return client.put(PATH, headers=headers, json={"headDigest": digest, "keyVersion": version, **extra})


def reset(client, who, match):  # noqa: F811
    headers = {**who, **ORIGIN}
    if match is not None:
        headers["If-Match"] = match
    return client.delete(PATH, headers=headers)


def code(r):
    return r.json().get("error", {}).get("code") if r.status_code >= 400 else None


def rows(hive):
    if hive.db.one("SELECT name FROM sqlite_master WHERE name = 'mind_checkpoints'") is None:
        return []
    return hive.db.all("SELECT * FROM mind_checkpoints ORDER BY principal")


# ---- the head: read, advance by one, ETag ------------------------------------------------------------------------------

def test_gatea_ck_a_first_read_is_seq_0_and_each_write_advances_by_exactly_one(ck):
    client = ck["client"]
    r = get(client, ck["ann"])
    assert r.status_code == 200 and r.headers["etag"] == '"0"' and r.headers["cache-control"] == "no-store"
    assert r.json() == {"seq": 0, "headDigest": None, "keyVersion": None, "pendingFrom": None, "revoked": False, "updated": None}
    r = put(client, ck["ann"], '"0"')
    assert r.status_code == 200 and r.headers["etag"] == '"1"'
    out = r.json()
    assert (out["seq"], out["headDigest"], out["keyVersion"], out["revoked"]) == (1, D1, 1, False) and out["updated"]
    r = put(client, ck["ann"], '"1"', D2, 2, seq=2)                      # a seq in the body must be the next one
    assert r.status_code == 200 and r.json()["seq"] == 2 and r.json()["headDigest"] == D2
    assert get(client, ck["ann"]).json() == r.json() and get(client, ck["ann"]).headers["etag"] == '"2"'


def test_gatea_ck_a_stale_head_is_412_with_the_current_head_and_changes_nothing(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"').status_code == 200
    assert put(client, ck["ann"], '"1"', D2).status_code == 200
    before = rows(hive)
    for match in ('"1"', '"0"', '"3"', '"x"', "2", 'W/"2"', "*", '"2", "1"'):   # only the exact strong ETag of the head
        r = put(client, ck["ann"], match, D3)
        assert (r.status_code, code(r)) == (412, "stale_head"), match
        assert r.json()["error"]["head"]["seq"] == 2 and r.json()["error"]["head"]["headDigest"] == D2
    r = put(client, ck["ann"], None, D3)                                   # no If-Match at all
    assert (r.status_code, code(r)) == (428, "if_match_required")
    r = put(client, ck["ann"], '"2"', D3, seq=5)                          # the right head, but not the next seq
    assert (r.status_code, code(r)) == (400, "invalid")
    assert rows(hive) == before


# ---- no ties: two writers on one head, exactly one wins ------------------------------------------------------------------

def test_gatea_ck_two_puts_on_the_same_head_through_the_route_exactly_one_wins(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"').status_code == 200
    gate, out = threading.Barrier(2), {}

    def writer(name, digest):
        gate.wait()
        out[name] = put(client, ck["ann"], '"1"', digest)

    threads = [threading.Thread(target=writer, args=(n, d)) for n, d in (("a", D2), ("b", D3))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(r.status_code for r in out.values()) == [200, 412]
    won = next(r for r in out.values() if r.status_code == 200).json()
    lost = next(r for r in out.values() if r.status_code == 412).json()["error"]["head"]
    assert won["seq"] == 2 and lost == won                                 # the loser is told the winner's head
    assert [(r["seq"], r["head_digest"]) for r in rows(hive)] == [(2, won["headDigest"])]


@pytest.mark.parametrize("first", [False, True])
def test_gatea_ck_many_writers_racing_past_the_pre_read_land_one_head_per_seq(ck, monkeypatch, first):
    """Every writer has read the same head before any of them writes (the barrier holds them after _current): the
    compare-and-set inside the transaction alone decides. first: the race is for seq 1 (the INSERT under the key)."""
    hive = ck["hive"]
    store = hive.mind_checkpoints
    viewer = type("V", (), {"principal": "user:u_ann"})()
    if not first:
        store.put(viewer, {"headDigest": D1, "keyVersion": 1}, 0)
    head = 0 if first else 1
    n = 8
    gate = threading.Barrier(n)
    real = store._current

    def held(principal, mind_id):
        row = real(principal, mind_id)
        gate.wait(10)
        return row

    monkeypatch.setattr(store, "_current", held)
    results = []

    def writer(i):
        try:
            results.append(("ok", store.put(viewer, {"headDigest": f"{i:064x}", "keyVersion": 1}, head)["seq"]))
        except Exception as exc:   # noqa: BLE001
            results.append(("err", getattr(exc, "status", None), getattr(exc, "code", None)))

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    assert sorted(results, key=str) == sorted([("ok", head + 1)] + [("err", 412, "stale_head")] * (n - 1), key=str)
    assert [r["seq"] for r in rows(hive)] == [head + 1]


# ---- owner only -------------------------------------------------------------------------------------------------------

def test_gatea_ck_another_person_never_reads_or_moves_someone_elses_head(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"').status_code == 200
    assert put(client, ck["ann"], '"1"', D2).status_code == 200
    ann = rows(hive)
    for other in (ck["bob"], ck["jon"]):                                   # a member and an admin person: their own row only
        r = get(client, other)
        assert r.json()["seq"] == 0 and D1 not in r.text and D2 not in r.text
        r = put(client, other, '"2"', D3)                                   # Ann's head names nothing of theirs
        assert (r.status_code, code(r)) == (412, "stale_head") and D2 not in r.text
        r = reset(client, other, '"2"')
        assert (r.status_code, code(r)) == (412, "stale_head")
    assert [r for r in rows(hive) if r["principal"] == "user:u_ann"] == ann
    # the operator's password session and no session at all: refused before anything is read
    assert client.get(PATH).status_code == 403
    assert client.get(PATH, headers={"Authorization": ""}).status_code == 401
    assert client.put(PATH, headers={**ORIGIN, "If-Match": '"2"'}, json={"headDigest": D3, "keyVersion": 1}).status_code == 403
    # writes need the hive's exact Origin (§G)
    r = client.put(PATH, headers={**ck["ann"], "Origin": "https://elsewhere.example", "If-Match": '"2"'},
                   json={"headDigest": D3, "keyVersion": 1})
    assert (r.status_code, code(r)) == (403, "origin_refused")
    r = client.put(PATH, headers={**ck["ann"], "If-Match": '"2"'}, json={"headDigest": D3, "keyVersion": 1})
    assert (r.status_code, code(r)) == (403, "origin_required")
    assert [r for r in rows(hive) if r["principal"] == "user:u_ann"] == ann


def test_gatea_ck_the_mind_token_is_not_a_session_here(ck):
    client = ck["client"]
    token = client.post("/api/me/mind/session", headers={**ck["ann"], **ORIGIN}, json={}).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert get(client, auth).status_code == 401
    assert put(client, auth, '"0"').status_code == 401
    assert reset(client, auth, '"0"').status_code == 401


# ---- the reset revokes the head ---------------------------------------------------------------------------------------

def test_gatea_ck_the_persons_reset_revokes_the_head_and_the_next_space_continues_the_seq(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"', pendingFrom={"deviceId": "device-b-0001", "seq": 3}).status_code == 200
    r = reset(client, ck["ann"], '"0"')                                   # a stale reset is refused like a stale write
    assert (r.status_code, code(r)) == (412, "stale_head")
    assert (reset(client, ck["ann"], None).status_code, code(reset(client, ck["ann"], None))) == (428, "if_match_required")
    r = reset(client, ck["ann"], '"1"')
    assert r.status_code == 200 and r.headers["etag"] == '"2"'
    assert {k: v for k, v in r.json().items() if k != "updated"} == \
        {"seq": 2, "headDigest": None, "keyVersion": None, "pendingFrom": None, "revoked": True}
    assert get(client, ck["ann"]).json()["revoked"] is True
    # the old chain's copy can never match again: its head is gone and its seq is behind
    assert put(client, ck["ann"], '"1"', D1).status_code == 412
    r = put(client, ck["ann"], '"2"', D2, 2)                              # the new space's first head, on the revoked one
    assert r.status_code == 200 and (r.json()["seq"], r.json()["revoked"], r.json()["keyVersion"]) == (3, False, 2)
    assert [r["seq"] for r in rows(hive)] == [3]


def test_gatea_ck_a_reset_before_any_checkpoint_still_takes_seq_1(ck):
    client = ck["client"]
    r = reset(client, ck["ann"], '"0"')
    assert r.status_code == 200 and (r.json()["seq"], r.json()["revoked"]) == (1, True)
    assert put(client, ck["ann"], '"1"').json()["seq"] == 2


def test_gatea_ck_a_replaced_personal_mind_revokes_the_old_minds_head(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"').status_code == 200
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (ck["mine"]["id"],))   # an admin deleted it
    r = get(client, ck["ann"])                                              # the person's next request makes another
    assert (r.json()["seq"], r.json()["revoked"], r.json()["headDigest"]) == (2, True, None)
    new = hive.personal.mind_row("user:u_ann")
    assert new["id"] != ck["mine"]["id"] and rows(hive)[0]["mind_id"] == new["id"]
    # a write on the old head after the replacement is stale, and the revocation stands committed
    r = put(client, ck["ann"], '"1"', D2)
    assert (r.status_code, code(r)) == (412, "stale_head") and r.json()["error"]["head"]["revoked"] is True
    assert rows(hive)[0]["seq"] == 2 and rows(hive)[0]["revoked"] == 1


def test_gatea_ck_a_disabled_person_is_refused(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"').status_code == 200
    hive.db.execute("UPDATE people SET disabled = 1 WHERE id = 'u_ann'")
    assert get(client, ck["ann"]).status_code in (401, 403)


# ---- D7: the key version never goes down -------------------------------------------------------------------------------

def test_gatea_ck_d7_a_lower_key_version_is_409_key_rollback_within_a_chain(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"', D1, 2).status_code == 200
    assert put(client, ck["ann"], '"1"', D2, 2).status_code == 200                # equal: non-decreasing
    before = rows(hive)
    r = put(client, ck["ann"], '"2"', D3, 1)
    assert (r.status_code, code(r)) == (409, "key_rollback") and r.json()["error"]["head"]["keyVersion"] == 2
    assert rows(hive) == before
    assert put(client, ck["ann"], '"2"', D3, 3).json()["keyVersion"] == 3
    assert code(put(client, ck["ann"], '"3"', D1, 2)) == "key_rollback"


@pytest.mark.parametrize("how", ["delete", "mind_replaced"])
def test_gatea_ck_d7_after_a_reset_the_first_put_may_take_any_key_version_and_the_new_chain_is_held(ck, how):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"', D1, 5).status_code == 200
    if how == "delete":
        assert reset(client, ck["ann"], '"1"').json()["revoked"] is True
    else:
        hive.db.execute("UPDATE agents SET deleted = 1 WHERE personal_of = 'user:u_ann'")
        assert get(client, ck["ann"]).json()["revoked"] is True
    r = put(client, ck["ann"], '"1"', D2, 1)                                     # a stale device: If-Match stops it first
    assert (r.status_code, code(r)) == (412, "stale_head")
    r = put(client, ck["ann"], '"2"', D2, 1)                                     # the new chain may start lower
    assert r.status_code == 200 and (r.json()["seq"], r.json()["keyVersion"], r.json()["revoked"]) == (3, 1, False)
    assert code(put(client, ck["ann"], '"3"', D3, 1)) is None                    # equal stays fine
    assert code(put(client, ck["ann"], '"4"', D1, 2)) is None
    r = put(client, ck["ann"], '"5"', D2, 1)                                     # and the new chain is held from there
    assert (r.status_code, code(r)) == (409, "key_rollback")


# ---- content-blind ----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("body", [
    {"headDigest": D1, "keyVersion": 1, "text": "I remember the lake"},           # any extra key
    {"headDigest": D1, "keyVersion": 1, "memory": {"atoms": ["x"]}},
    {"headDigest": D1, "keyVersion": 1, "spaceId": "s1"},
    {"headDigest": "I remember the lake" + "0" * 45, "keyVersion": 1},           # a digest that isn't one
    {"headDigest": D1.upper(), "keyVersion": 1},
    {"headDigest": "sha256:" + D1, "keyVersion": 1},
    {"headDigest": D1 + "0", "keyVersion": 1},
    {"headDigest": D1, "keyVersion": "1"},
    {"headDigest": D1, "keyVersion": 0},
    {"headDigest": D1, "keyVersion": True},
    {"headDigest": D1},
    {"keyVersion": 1},
    {"headDigest": D1, "keyVersion": 1, "seq": 0},
    {"headDigest": D1, "keyVersion": 1, "seq": 1.0},
    {"headDigest": D1, "keyVersion": 1, "pendingFrom": {"deviceId": "dev-0001-x", "seq": 5, "note": "hi"}},
    {"headDigest": D1, "keyVersion": 1, "pendingFrom": {"deviceId": "a lake memory", "seq": 5}},
    {"headDigest": D1, "keyVersion": 1, "pendingFrom": {"deviceId": "dev-0001-x", "seq": 1}},  # not newer than the head
    {"headDigest": D1, "keyVersion": 1, "pendingFrom": "dev-0001-x"},
    [D1, 1],
])
def test_gatea_ck_anything_but_the_head_fields_is_refused_and_nothing_is_stored(ck, body):
    client, hive = ck["client"], ck["hive"]
    r = client.put(PATH, headers={**ck["ann"], **ORIGIN, "If-Match": '"0"'}, json=body)
    assert (r.status_code, code(r)) == (400, "invalid"), r.text
    assert rows(hive) == []
    assert "lake" not in json.dumps(rows(hive))


def test_gatea_ck_the_row_holds_the_head_fields_only_and_the_body_is_small(ck):
    client, hive = ck["client"], ck["hive"]
    assert put(client, ck["ann"], '"0"', pendingFrom={"deviceId": "device-a-0001", "seq": 4}).status_code == 200
    assert set(rows(hive)[0]) == {"principal", "mind_id", "seq", "head_digest", "key_version", "pending_device",
                                  "pending_seq", "revoked", "updated_at", "key_floor"}
    r = client.put(PATH, headers={**ck["ann"], **ORIGIN, "If-Match": '"1"'},
                   content=json.dumps({"headDigest": D2, "keyVersion": 1, "x": "y" * 2048}),
                   )
    assert r.status_code in (413, 415)
    r = client.put(PATH, headers={**ck["ann"], **ORIGIN, "If-Match": '"1"', "Content-Type": "application/json"},
                   content=json.dumps({"headDigest": D2, "keyVersion": 1, "x": "y" * 2048}))
    assert (r.status_code, code(r)) == (413, "request_too_large")
    assert rows(hive)[0]["seq"] == 1


def test_gatea_ck_a_pending_announcement_stands_until_a_write_clears_it(ck):
    client = ck["client"]
    pending = {"deviceId": "device-a-0001", "seq": 4}
    assert put(client, ck["ann"], '"0"', pendingFrom=pending).json()["pendingFrom"] == pending
    assert put(client, ck["ann"], '"1"', D2).json()["pendingFrom"] == pending          # absent: kept
    assert put(client, ck["ann"], '"2"', D3).json()["pendingFrom"] == pending          # even at the announced seq - 1
    assert put(client, ck["ann"], '"3"', D1, pendingFrom=None).json()["pendingFrom"] is None


# ---- flag off ---------------------------------------------------------------------------------------------------------

def test_gatea_ck_flag_unset_every_method_is_an_unknown_path_and_no_table_is_made(client, monkeypatch):  # noqa: F811
    monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
    w = world(client)
    for method in ("GET", "PUT", "DELETE"):
        headers = {**w["ann"], **ORIGIN, "If-Match": '"0"'}
        a = client.request(method, PATH, headers=headers, json={"headDigest": D1, "keyVersion": 1})
        b = client.request(method, PATH + "-nosuch", headers=headers, json={"headDigest": D1, "keyVersion": 1})
        assert (a.status_code, a.content) == (b.status_code, b.content), method
        assert a.status_code == 404 and "etag" not in a.headers
    assert w["hive"].db.one("SELECT name FROM sqlite_master WHERE name = 'mind_checkpoints'") is None


def test_gatea_ck_if_match_reads_one_strong_etag_only():
    assert ckmod.if_match(None) is None
    assert ckmod.if_match('"0"') == 0 and ckmod.if_match(' "17" ') == 17
    for bad in ("17", 'W/"17"', "*", '"01"', '"-1"', '"1", "2"', '""', '"1e3"'):
        assert ckmod.if_match(bad) == -1, bad
