"""Personal minds P1 r2: the stand-in's three High findings on 308727d, each with a fail-before test.

1. A held copy's content leaves no copy in the database files once it is acknowledged, expired or dropped.
2. fit() always ends and always fits, whatever the words (U+0001 escapes to 6 bytes; the old loop never shrank words).
3. The private-app fence reads the page's raw route and program with the conductor's canonical names, for every turn.
"""
import json
import secrets
import threading

from hive.core import personal_inbox as inboxmod
from hive.tests.test_ask import ask, reply, world
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


def _files(hive):
    """Every byte of the hive's database files and the held copies' own, with their WAL and shared-memory files."""
    d = hive.settings.data_dir
    names = [n + s for n in ("hive.db", inboxmod.DB_NAME) for s in ("", "-wal", "-shm", "-journal")]
    return b"".join((d / n).read_bytes() for n in names if (d / n).exists())


def _hold(hive, sw, marker, n=1):
    return [hive.personal_inbox.hold({"id": f"at_r2{secrets.token_hex(6)}", "principal": "user:u_ann", "swarm_id": sw,
                                      "mind_id": "a_coord", "text": f"words {marker} {i}", "context_resolved": "{}"},
                                     f"answer {marker} {i} " + "x" * 3000) for i in range(n)]


def test_an_acknowledged_expired_or_dropped_copy_leaves_nothing_in_the_database_files(client):
    w = world(client)
    hive, sw = w["hive"], w["swarm"]["id"]
    hive.personal.ensure("user:u_ann")
    # acknowledged
    marker = "ACKMARK" + secrets.token_hex(8)
    item = _hold(hive, sw, marker)[0]
    assert marker.encode() in _files(hive)
    assert client.post("/api/me/mind/inbox/ack", headers=w["ann"], json={"ids": [item]}).json() == {"deleted": 1}
    assert marker.encode() not in _files(hive)
    # expired (the reconcile loop's sweep, and every read and write)
    marker = "EXPMARK" + secrets.token_hex(8)
    _hold(hive, sw, marker, 3)
    hive.personal_inbox.db.execute("UPDATE personal_inbox SET created_at = '2026-01-01T00:00:00.000Z'")
    assert hive.personal_inbox.sweep() == 3
    assert marker.encode() not in _files(hive)
    # dropped by the per-person bound (the oldest first)
    marker = "DROPMARK" + secrets.token_hex(8)
    _hold(hive, sw, marker, 1)
    _hold(hive, sw, "filler", inboxmod.MAX_ITEMS)
    assert hive.personal_inbox.db.one("SELECT COUNT(*) AS n FROM personal_inbox WHERE payload LIKE ?", (f"%{marker}%",))["n"] == 0
    assert marker.encode() not in _files(hive)
    # the connection's own setting is left as it was
    import sqlite3
    default = sqlite3.connect(":memory:").execute("PRAGMA secure_delete").fetchone()[0]   # 1 on some Linux builds
    assert hive.db.one("PRAGMA secure_delete")["secure_delete"] == default       # the hive's own database is unchanged
    assert hive.personal_inbox.db.one("PRAGMA secure_delete")["secure_delete"] == 1


def _fits(words, answer, timeout=5.0):
    out = []
    t = threading.Thread(target=lambda: out.append(inboxmod.fit(words, answer)), daemon=True)
    t.start()
    t.join(timeout)
    assert out, "fit() did not end"
    w, a, cut = out[0]
    payload = json.dumps({"words": w, "answer": a}, ensure_ascii=False).encode("utf-8")
    assert len(payload) <= inboxmod.ITEM_BYTES
    assert len(json.dumps(w, ensure_ascii=False).encode("utf-8")) - 2 <= inboxmod.WORDS_BYTES
    assert words.startswith(w) and answer.startswith(a)
    return w, a, cut


def test_fit_always_ends_and_fits_whatever_the_words():
    w, a, cut = _fits("\x01" * 4000, "")                          # the stand-in's case: 24,027 bytes with an empty answer
    assert cut and len(w) == inboxmod.WORDS_BYTES // 6 and a == ""
    w, a, cut = _fits("\x01" * 4000, "y" * 20000)                  # the words keep their share, the answer the rest
    assert cut and len(a) == inboxmod.ITEM_BYTES - inboxmod._size(w, "")      # the answer fills exactly what is left
    for words, answer in (('"\\' * 2000, "\n" * 8000), ("é😀" * 1500, "ü\t" * 4000), ("short", "fine")):
        _fits(words, answer)
    assert _fits("short", "fine")[2] is False


def test_an_ask_of_escape_heavy_words_is_held_bounded(client):
    w = world(client)
    hive = w["hive"]
    hive.personal.ensure("user:u_ann")
    r = ask(client, w["ann"], "op-r2-esc-001", text="\x01" * 4000, context={"swarm_id": w["swarm"]["id"]})
    assert r.status_code == 202, r.text
    done = threading.Event()
    threading.Thread(target=lambda: (reply(hive, w["coord"], r.json()["turn_id"], "ok"), done.set()), daemon=True).start()
    assert done.wait(10), "the reply hung"
    row = hive.personal_inbox.db.one("SELECT bytes, truncated FROM personal_inbox")
    assert row and row["bytes"] <= inboxmod.ITEM_BYTES and row["truncated"] == 1


def test_a_private_apps_route_is_fenced_on_its_raw_canonical_name_for_every_turn(client):
    w = world(client)
    hive = w["hive"]
    hive.personal.ensure("user:u_ann")
    for i, route in enumerate(("/programs/ATLAS/view", "#/programs/%61tlas/view", "#/programs/%2561tlas/view",
                               "#/programs/ＡＴＬＡＳ/view", "#/programs/Truth", "#/programs/omegatruth/x")):
        op = f"op-r2-priv-{i:03d}"
        r = ask(client, w["ann"], op, context={"swarm_id": w["swarm"]["id"], "route": route})
        assert r.status_code == 202, (route, r.text)
        assert r.json()["context"] == {"private": True}, route        # what the coordinator gets: nothing of the page
        reply(hive, w["coord"], r.json()["turn_id"], "answer")
        assert hive.personal_inbox.db.all("SELECT * FROM personal_inbox") == [], route
    r = ask(client, w["ann"], "op-r2-priv-ok1", context={"swarm_id": w["swarm"]["id"], "route": "#/programs/notes/view"})
    assert "private" not in r.json()["context"] and r.json()["context"]["route"]
    reply(hive, w["coord"], r.json()["turn_id"], "answer")
    assert len(hive.personal_inbox.db.all("SELECT * FROM personal_inbox")) == 1          # an ordinary app's page is still copied
