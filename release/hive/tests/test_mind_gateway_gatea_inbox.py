"""Gateway gate A: the inbox and its ack (browser-Iter plan r7.7 §11) are the live routes from personal minds P1
(personal_inbox.py, b86cf47f), unchanged. These pin the gate A row's properties on them with the gateway flag on:
the ack is idempotent per id, owner-only, and nothing of another person's is read or removed.

Synthetic held copies only: no network, no provider.
"""
import pytest

from hive.core.db import now
from hive.tests.test_ask import world
from hive.tests.test_core_api import client  # noqa: F401  (fixture)

ORIGIN = {"Origin": "http://127.0.0.1:8700"}


@pytest.fixture()
def inbox(client, monkeypatch):  # noqa: F811
    monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
    w = world(client)
    w["client"] = client
    hive = w["hive"]
    for who in ("u_ann", "u_bob"):
        hive.personal.ensure("user:" + who)

    def hold(principal, n):
        ids = []
        for i in range(n):
            item = f"pi_{principal[-3:]}{i:04d}"
            hive.personal_inbox.db.insert("personal_inbox", {
                "id": item, "principal": principal, "mind_id": hive.personal.mind_row(principal)["id"],
                "turn_id": f"t_{item}", "created_at": now(), "bytes": 30, "payload": '{"words": "w", "answer": "a"}',
                "truncated": 0})
            ids.append(item)
        return ids
    w["hold"] = hold
    return w


def held(hive, principal):
    return [r["id"] for r in hive.personal_inbox.db.all("SELECT id FROM personal_inbox WHERE principal = ? ORDER BY seq",
                                                         (principal,))]


def ack(client, who, ids):  # noqa: F811
    return client.post("/api/me/mind/inbox/ack", headers={**who, **ORIGIN}, json={"ids": ids})


def test_gatea_inbox_ack_is_idempotent_per_id(inbox):
    client, hive = inbox["client"], inbox["hive"]
    a = inbox["hold"]("user:u_ann", 3)
    assert ack(client, inbox["ann"], [a[0], a[0]]).json() == {"deleted": 1}        # the same id twice in one ack
    assert ack(client, inbox["ann"], [a[0]]).json() == {"deleted": 0}              # and again later: nothing more
    assert ack(client, inbox["ann"], [a[0], a[1]]).json() == {"deleted": 1}        # a mixed retry removes only the new one
    assert ack(client, inbox["ann"], []).json() == {"deleted": 0}
    assert held(hive, "user:u_ann") == [a[2]]
    items = client.get("/api/me/mind/inbox", headers=inbox["ann"]).json()["items"]
    assert [i["id"] for i in items] == [a[2]]


def test_gatea_inbox_owner_only_nothing_of_another_person(inbox):
    client, hive = inbox["client"], inbox["hive"]
    a, b = inbox["hold"]("user:u_ann", 2), inbox["hold"]("user:u_bob", 2)
    for other, theirs in ((inbox["bob"], a), (inbox["jon"], a), (inbox["ann"], b)):
        assert ack(client, other, theirs).json() == {"deleted": 0}
    assert held(hive, "user:u_ann") == a and held(hive, "user:u_bob") == b
    assert [i["id"] for i in client.get("/api/me/mind/inbox", headers=inbox["bob"]).json()["items"]] == b
    assert client.get("/api/me/mind/inbox", headers=inbox["jon"]).json()["items"] == []
    assert client.get("/api/me/mind/inbox").status_code == 403                    # the operator: no admin read
    # the cursor is the caller's own: another person's id as `after` starts at their own beginning
    assert [i["id"] for i in client.get(f"/api/me/mind/inbox?after={a[0]}", headers=inbox["bob"]).json()["items"]] == b
