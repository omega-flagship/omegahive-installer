"""Motivations phase 1, Correction 1: regressions for Review FIX-FIRST B1 (creation authority inside the insert
transaction) and R1 (cursor key), and Kimi FIX-FIRST F1 (mind create needs operation_id), F2 (declined; semantics pinned),
F3 (one replay semantics), F4 (structural links_version CAS) and F5 (readable_ids pre-filter). Synthetic data only."""
import asyncio
import os
import pathlib
import types

import pytest

from hive.core import motivations as motivations_module
from hive.core.motivations import Motivations
from hive.core.visibility import Viewer
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_motivation_links import capture, code, linked, links, row
from hive.tests.test_motivations import goal, motivation, ok, world


def count(hive, title):
    return hive.db.one("SELECT COUNT(*) AS n FROM motivations WHERE title = ?", (title,))["n"]


def before_insert(monkeypatch, hive, effect):
    """Run `effect` between the route's start and the insert, at the exact point Review's probe interleaves."""
    m, original = hive.motivations, hive.motivations._insert

    def interleaved(row, parent, creator):
        effect()
        return original(row, parent, creator)
    monkeypatch.setattr(m, "_insert", interleaved)


# ---- Review B1: person and team creation authority is judged inside the insert transaction ----------------------------

def test_review_probe_team_creation_rechecks_current_owner_at_insert(client, monkeypatch):
    """Review's probe (.runtime/omegareview-motivations-0d97c65/hive/tests/review_motivation_create_authority.py), as a test."""
    w = world(client); m = w['hive'].motivations; original = m._insert

    def transfer_before_insert(row, parent, may_read):
        w['hive'].db.execute('UPDATE swarms SET owner=? WHERE id=?', ('user:u_p2', w['t1']))
        return original(row, parent, may_read)
    monkeypatch.setattr(m, '_insert', transfer_before_insert)
    response = client.post('/api/motivations', headers=w['p1'], json={'title': 'STALE-OWNER-CREATE', 'owner': 'swarm:' + w['t1']})
    assert response.status_code in (403, 404), response.text
    assert not w['hive'].db.one("SELECT id FROM motivations WHERE title='STALE-OWNER-CREATE'")


def test_withdrawn_team_ownership_creates_nothing_and_emits_nothing(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    ok(client.put(f"/api/swarms/{w['t1']}/visibility", headers=w["p1"], json={"visibility": "public"}))   # P1 still sees T1 after
    before_insert(monkeypatch, hive, lambda: hive.db.execute("UPDATE swarms SET owner = 'user:u_p2' WHERE id = ?", (w["t1"],)))
    published, restore = capture(hive)
    try:
        r = client.post("/api/motivations", headers=w["p1"], json={"title": "stale owner", "owner": f"swarm:{w['t1']}"})
    finally:
        restore()
    assert r.status_code == 403 and code(r) == "owner_only"              # exactly the first-time refusal for the new owner state
    assert count(hive, "stale owner") == 0 and published == []


def test_withdrawn_swarm_visibility_creates_no_scoped_personal_row(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    narrow = lambda: hive.db.execute("UPDATE swarms SET shared_with = '[\"user:u_p3\"]' WHERE id = ?", (w["t1"],))
    before_insert(monkeypatch, hive, narrow)
    published, restore = capture(hive)
    try:
        r = client.post("/api/motivations", headers=w["p2"], json={"title": "scoped", "swarm_id": w["t1"]})
    finally:
        restore()
    hidden = client.post("/api/motivations", headers=w["p2"], json={"title": "scoped", "swarm_id": "s_00000000"})
    assert r.status_code == 404 and r.json() == hidden.json()            # the same answer as a swarm that never existed
    assert count(hive, "scoped") == 0 and published == []


def test_a_person_removed_before_the_insert_gets_no_admin_made_row(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    before_insert(monkeypatch, hive, lambda: hive.db.execute("DELETE FROM people WHERE id = 'u_p4'"))
    r = client.post("/api/motivations", json={"title": "for p4", "owner": "user:u_p4"})       # the hive password is admin
    assert r.status_code == 400 and code(r) == "bad_scope" and count(hive, "for p4") == 0


def test_unchanged_authority_still_creates_and_admins_and_archive_keep_their_rules(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    before_insert(monkeypatch, hive, lambda: None)                        # positive control: the interleaving point, no change
    published, restore = capture(hive)
    try:
        made = motivation(client, w["p1"], title="still mine", owner=f"swarm:{w['t1']}")
        scoped = motivation(client, w["p2"], title="p2 scoped", swarm_id=w["t1"])
    finally:
        restore()
    assert made["editable"] is True and made["swarm_id"] == w["t1"] and scoped["owner"] == "user:u_p2"
    assert [k for k, _ in published] == ["motivation.updated", "motivation.updated"]
    assert count(hive, "still mine") == 1
    # an admin creates a team row in a swarm it does not own; an admin makes one for a person
    assert ok(client.post("/api/motivations", json={"title": "by admin", "owner": f"swarm:{w['t2']}"}))["owner"] == f"swarm:{w['t2']}"
    assert ok(client.post("/api/motivations", json={"title": "for p4", "owner": "user:u_p4"}))["owner"] == "user:u_p4"
    # the archived-swarm guard still holds when the archive lands just before the insert
    monkeypatch.undo()
    before_insert(monkeypatch, hive, lambda: hive.archive_swarm(w["t1"], "user:operator"))
    r = client.post("/api/motivations", headers=w["p1"], json={"title": "into archive", "owner": f"swarm:{w['t1']}"})
    assert r.status_code == 409 and code(r) == "swarm_archived" and count(hive, "into archive") == 0


def test_a_mind_moved_or_removed_before_the_insert_creates_nothing(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    ada = ok(client.post("/api/agents", json={"name": "Ada", "swarm_id": w["t1"]}))
    t3 = ok(client.post("/api/swarms", json={"name": "T3", "visibility": "public"}))["id"]
    before_insert(monkeypatch, hive, lambda: hive.db.execute("UPDATE agents SET swarm_id = ? WHERE id = ?", (t3, ada["id"])))
    r = client.post("/api/agent/motivations", headers=agent_headers(ada), json={"title": "moved", "operation_id": "ada-moved-0001"})
    assert r.status_code == 409 and count(hive, "moved") == 0
    assert hive.db.one("SELECT COUNT(*) AS n FROM motivation_ops WHERE operation_id = 'ada-moved-0001'")["n"] == 0
    monkeypatch.undo()
    before_insert(monkeypatch, hive, lambda: hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = ?", (ada["id"],)))
    r = client.post("/api/agent/motivations", headers=agent_headers(ada), json={"title": "gone", "operation_id": "ada-gone-0001"})
    assert r.status_code == 401 and count(hive, "gone") == 0


# ---- Kimi F1: every mind create carries an operation_id, so a retry never double-creates --------------------------------

def test_a_mind_create_without_an_operation_id_is_refused_and_a_retry_never_double_creates(client):
    w = world(client)
    hive = w["hive"]
    ada = ok(client.post("/api/agents", json={"name": "Ada", "swarm_id": w["t1"]}))
    a = agent_headers(ada)
    r = client.post("/api/agent/motivations", headers=a, json={"title": "no key"})
    assert r.status_code == 400 and code(r) == "bad_request" and count(hive, "no key") == 0
    body = {"title": "retried", "operation_id": "ada-retry-0001"}
    first = ok(client.post("/api/agent/motivations", headers=a, json=body))["motivation"]
    again = ok(client.post("/api/agent/motivations", headers=a, json=body))
    assert again["replayed"] is True and again["motivation"]["id"] == first["id"] and count(hive, "retried") == 1
    # the MCP tool: the schema requires it and the handler refuses its absence
    from hive.core import mcp
    tool = {t["name"]: t for t in mcp.TOOLS}["hive_motivation_create"]
    assert tool["inputSchema"]["required"] == ["title", "operation_id"]
    member = hive.db.one("SELECT * FROM agents WHERE id = ?", (ada["id"],))
    with pytest.raises(Exception) as exc:
        asyncio.run(hive.harnesses.call(member, "hive_motivation_create", {"title": "mcp no key"}))
    assert getattr(exc.value, "status", None) == 400 and count(hive, "mcp no key") == 0


# ---- Kimi F2 (declined): the create refusals, pinned --------------------------------------------------------------------

def test_create_refusals_hidden_equals_missing_and_a_seen_swarm_says_owner_only(client):
    w = world(client)
    hidden = client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": f"swarm:{w['t2']}"})
    missing = client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": "swarm:s_00000000"})
    assert hidden.status_code == missing.status_code == 404 and hidden.json() == missing.json()
    seen = client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": f"swarm:{w['t1']}"})
    assert seen.status_code == 403 and code(seen) == "owner_only"        # T1 is visible to P2, and so is its owner
    other = client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": "user:u_p1"})
    ghost = client.post("/api/motivations", headers=w["p2"], json={"title": "x", "owner": "user:u_nobody"})
    assert other.json() == ghost.json() and code(other) == "owner_only"  # a person's existence is never revealed


# ---- Kimi F3: one replay semantics: every stored id or the first-time 404 ----------------------------------------------

def test_a_replay_returns_every_stored_id_or_the_first_time_refusal(client):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    m = motivation(client, p1, title="M")
    g, h = goal(client, w["t1"], "g"), goal(client, w["t2"], "h")
    ok(links(client, p1, m["id"], "link", [g["id"]]))
    first = ok(links(client, p1, m["id"], "link", [g["id"], h["id"]], operation_id="replay-op-0001"))
    again = ok(links(client, p1, m["id"], "link", [g["id"], h["id"]], operation_id="replay-op-0001"))
    assert (again["applied"], again["unchanged"]) == (first["applied"], first["unchanged"]) == ([h["id"]], [g["id"]])
    # the source has no partial filter left: a replay never answers with a subset
    assert "keep" not in pathlib.Path(motivations_module.__file__).read_text().split("def _replay")[1].split("def ")[0]


# ---- Kimi F4: the links_version bump is a compare-and-set on what step 1 read ----------------------------------------------

@pytest.mark.parametrize("column", ["links_version", "rev"])
def test_a_change_between_the_check_and_the_write_refuses_the_whole_operation(client, monkeypatch, column):
    w = world(client)
    hive, p1 = w["hive"], w["p1"]
    m = motivation(client, p1, title="M")
    g = goal(client, w["t1"])
    real = hive.motivations._goal_visible

    def bump_then_check(viewer, gid, cache):   # after step 1 read the row, inside the same transaction
        hive.db.execute(f"UPDATE motivations SET {column} = {column} + 1 WHERE id = ?", (m["id"],))
        return real(viewer, gid, cache)
    monkeypatch.setattr(hive.motivations, "_goal_visible", bump_then_check)
    published, restore = capture(hive)
    try:
        r = links(client, p1, m["id"], "link", [g["id"]], operation_id="cas-op-0001")
    finally:
        restore()
    assert r.status_code == 409 and code(r) == "motivation_changed"
    assert linked(hive, m["id"]) == [] and published == []
    assert (row(hive, m["id"])["rev"], row(hive, m["id"])["links_version"]) == (1, 0)          # the bump rolled back with it
    assert hive.db.one("SELECT COUNT(*) AS n FROM motivation_ops WHERE operation_id = 'cas-op-0001'")["n"] == 0


# ---- Kimi F5: R is computed from a SQL superset; rows that cannot be readable are never examined ------------------------

def test_readable_ids_examines_only_candidates_and_matches_the_full_judgement(client, monkeypatch):
    w = world(client)
    hive = w["hive"]
    mine = motivation(client, w["p1"], title="p1 private")
    t2_private = motivation(client, w["p1"], title="t2 private", owner=f"swarm:{w['t2']}", visibility="private")
    shared = motivation(client, w["p1"], title="shared", visibility="shared", shared_with=["user:u_p2"])
    public = motivation(client, w["p1"], title="public", visibility="public")
    t1_team = motivation(client, w["p1"], title="t1 team", owner=f"swarm:{w['t1']}")
    hive.db.execute("UPDATE motivations SET shared_with = 'not json' WHERE id = ?", (mine["id"],))
    m = hive.motivations
    viewers = [Viewer(f"user:{p}", False) for p in ("u_p1", "u_p2", "u_p3", "u_p4")] + [Viewer("user:operator", True)]
    for v in viewers:
        full = {r["id"] for r in hive.db.all("SELECT * FROM motivations") if m.readable(v, r)}
        assert m.readable_ids(v) == full, v.principal
    examined, real = [], m.readable
    monkeypatch.setattr(m, "readable", lambda viewer, r, cache=None: (examined.append(r["id"]), real(viewer, r, cache))[1])
    assert m.readable_ids(Viewer("user:u_p2", False)) == {shared["id"], public["id"], t1_team["id"]}
    assert mine["id"] not in examined and t2_private["id"] not in examined


# ---- Review R1: the cursor key is exactly 32 bytes, never empty or partial -----------------------------------------------

def test_the_cursor_key_is_whole_or_refused(tmp_path, monkeypatch):
    path = tmp_path / "motivations-cursor.key"
    key = Motivations._cursor_key(path)
    assert len(key) == 32 and Motivations._cursor_key(path) == key and oct(path.stat().st_mode)[-3:] == "600"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["motivations-cursor.key"]          # no temporary left behind
    for bad in (b"", b"x" * 31, b"x" * 33):
        path.write_bytes(bad)
        with pytest.raises(RuntimeError):
            Motivations._cursor_key(path)
    # a failed first write leaves no key file at all, so the next start makes a whole one
    fresh = tmp_path / "fresh" / "motivations-cursor.key"
    fresh.parent.mkdir()

    def broken(fd):
        raise OSError("disk full")
    monkeypatch.setattr(os, "fsync", broken)
    with pytest.raises(OSError):
        Motivations._cursor_key(fresh)
    assert list(fresh.parent.iterdir()) == []
    monkeypatch.undo()
    assert len(Motivations._cursor_key(fresh)) == 32
    # overlapping first starts: whoever links second reads the winner's whole key
    racing = tmp_path / "race" / "motivations-cursor.key"
    racing.parent.mkdir()
    real_link = os.link

    def other_start_wins(src, dst):
        if not racing.exists():
            racing.write_bytes(b"w" * 32)
        return real_link(src, dst)
    monkeypatch.setattr(os, "link", other_start_wins)
    assert Motivations._cursor_key(racing) == b"w" * 32
    assert sorted(p.name for p in racing.parent.iterdir()) == ["motivations-cursor.key"]


def test_a_hive_with_a_truncated_cursor_key_does_not_start(client, tmp_path):
    hive = client.app.state.hive
    (tmp_path / "motivations-cursor.key").write_bytes(b"")
    stub = types.SimpleNamespace(db=hive.db, settings=types.SimpleNamespace(data_dir=tmp_path))
    with pytest.raises(RuntimeError):
        Motivations(stub)
