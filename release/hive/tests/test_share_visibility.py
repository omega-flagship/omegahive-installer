"""Surface audit 37 (2026-10-05): a person sees, reads the log of and revokes only shares they could see anyway."""
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person


def share_between(client, swarm_id, status="active", minds="public"):
    from hive.core.db import new_id, now
    hive = client.app.state.hive
    a = hive.create_agent("Owner", "omega", swarm_id, "mock/echo", "", None, 0, None, None)
    b = hive.create_agent("Grantee", "omega", swarm_id, "mock/echo", "", None, 0, None, None)
    for m in (a, b):                                   # minds are private by default; the test chooses
        hive.db.execute("UPDATE agents SET visibility = ? WHERE id = ?", (minds, m["id"]))
    sid = new_id("sh")
    hive.db.insert("shares", {"id": sid, "kind": "space", "swarm_id": swarm_id, "owner_id": a["id"], "grantee_id": b["id"],
                              "space": "s", "minutes": 10, "reason": "", "status": status, "initiated_by": "owner",
                              "created_at": now()})
    return sid


def test_a_member_never_lists_reads_or_revokes_a_share_in_a_swarm_they_cannot_see(client):
    private = client.post("/api/swarms", json={"name": "Private", "visibility": "private"}).json()["id"]
    public = client.post("/api/swarms", json={"name": "Open", "visibility": "public"}).json()["id"]
    hidden, seen = share_between(client, private), share_between(client, public)
    ana = person(client, "u_ana", "member")
    ids = {s["id"] for s in client.get("/api/shares", headers=ana).json()}
    assert seen in ids and hidden not in ids
    owner = client.app.state.hive.db.one("SELECT owner_id FROM shares WHERE id = ?", (hidden,))["owner_id"]
    assert hidden not in {s["id"] for s in client.get(f"/api/shares?agent_id={owner}", headers=ana).json()}
    assert client.get(f"/api/shares/{hidden}/reads", headers=ana).status_code == 404
    assert client.post(f"/api/shares/{hidden}/revoke", headers=ana).status_code == 404
    assert client.app.state.hive.db.one("SELECT status FROM shares WHERE id = ?", (hidden,))["status"] == "active"
    assert client.get(f"/api/shares/{seen}/reads", headers=ana).status_code == 200
    private_minds = share_between(client, public, minds="private")       # a public swarm does not expose private minds
    assert private_minds not in {s["id"] for s in client.get("/api/shares", headers=ana).json()}
    assert client.post(f"/api/shares/{private_minds}/revoke", headers=ana).status_code == 404


def test_revoking_records_who_did_it(client):
    public = client.post("/api/swarms", json={"name": "Open2", "visibility": "public"}).json()["id"]
    sid = share_between(client, public)
    ana = person(client, "u_ana2", "member")
    r = client.post(f"/api/shares/{sid}/revoke", headers=ana)
    assert r.status_code == 200 and r.json()["revoked_by"] == "user:u_ana2"
    admin_sid = share_between(client, public)
    assert client.post(f"/api/shares/{admin_sid}/revoke").json()["revoked_by"] == "user:operator"


def test_the_hive_s_own_revocations_and_old_rows_are_attributed(client):
    """Kimi hotfix #2, #5: system revokes say 'hive'; rows revoked before revoked_by existed say 'unknown'."""
    import asyncio
    from hive.core.shares import Shares
    hive = client.app.state.hive
    public = client.post("/api/swarms", json={"name": "Open3", "visibility": "public"}).json()["id"]
    sid = share_between(client, public)
    assert asyncio.run(hive.shares.revoke(sid))["revoked_by"] == "hive"          # the goal/connection path
    old = share_between(client, public, status="revoked")
    hive.db.execute("UPDATE shares SET revoked_by = NULL WHERE id = ?", (old,))
    Shares(hive)                                                                  # the start-up migration
    assert hive.db.one("SELECT revoked_by FROM shares WHERE id = ?", (old,))["revoked_by"] == "unknown"


def test_a_read_log_names_only_readers_the_person_may_see(client):
    """Kimi hotfix, sharpest finding: the container was guarded, its contents were not."""
    from hive.core.db import now
    hive = client.app.state.hive
    public = client.post("/api/swarms", json={"name": "Open4", "visibility": "public"}).json()["id"]
    private = client.post("/api/swarms", json={"name": "Hidden4", "visibility": "private"}).json()["id"]
    sid = share_between(client, public)
    secret = hive.create_agent("Secret", "omega", private, "mock/echo", "", None, 0, None, None)
    grantee = hive.db.one("SELECT grantee_id FROM shares WHERE id = ?", (sid,))["grantee_id"]
    for reader in (grantee, secret["id"]):
        hive.db.insert("share_reads", {"share_id": sid, "reader_id": reader, "q": "*", "returned": 1, "created_at": now()})
    ana = person(client, "u_ana5", "member")
    readers = {r["reader_id"] for r in client.get(f"/api/shares/{sid}/reads", headers=ana).json()}
    assert readers == {grantee}
    assert {r["reader_id"] for r in client.get(f"/api/shares/{sid}/reads").json()} == {grantee, secret["id"]}


def test_a_page_is_filled_with_visible_shares(client):
    """Kimi hotfix #3: hidden shares never shorten a person's page or push visible ones off it."""
    from hive.core.visibility import Viewer
    hive = client.app.state.hive
    private = client.post("/api/swarms", json={"name": "Crowd", "visibility": "private"}).json()["id"]
    public = client.post("/api/swarms", json={"name": "Open5", "visibility": "public"}).json()["id"]
    visible = share_between(client, public)
    for _ in range(3):                                   # newer, hidden shares crowd the top of the list
        share_between(client, private)
    assert [s["id"] for s in hive.shares.list(limit=2, viewer=Viewer("user:u_ana6", False))] == [visible]
    assert hive.shares.list(viewer=None) == []            # no viewer sees nothing (Kimi hotfix #4)


def test_share_events_follow_the_same_rule_as_the_list(client):
    """OmegaReview hotfix event leak: share.updated reached members who could not see its minds."""
    import json as _json
    from hive.core.visibility import Viewer
    hive = client.app.state.hive
    public = client.post("/api/swarms", json={"name": "EvPub", "visibility": "public"}).json()["id"]
    hidden_swarm = client.post("/api/swarms", json={"name": "EvHid", "visibility": "private"}).json()["id"]
    member, admin = Viewer("user:u_ev", False), Viewer("user:operator", True)
    frame = lambda sid: _json.dumps({"type": "share.updated", "share": hive.shares.view(hive.shares.get(sid))})
    shown = share_between(client, public)
    private_minds = share_between(client, public, minds="private")
    in_hidden = share_between(client, hidden_swarm)
    owner_private = share_between(client, public)
    hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = (SELECT owner_id FROM shares WHERE id = ?)", (owner_private,))
    grantee_private = share_between(client, public)
    hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = (SELECT grantee_id FROM shares WHERE id = ?)", (grantee_private,))
    deleted = share_between(client, public)
    hive.db.execute("UPDATE agents SET deleted = 1 WHERE id = (SELECT owner_id FROM shares WHERE id = ?)", (deleted,))
    listed = {s["id"] for s in hive.shares.list(viewer=member, limit=500)}
    for sid in (shown, private_minds, in_hidden, owner_private, grantee_private, deleted):
        assert hive.visibility.event_visible(member, frame(sid)) == (sid in listed), sid
        assert hive.visibility.event_visible(admin, frame(sid))
    assert shown in listed and not ({private_minds, in_hidden, owner_private, grantee_private, deleted} & listed)
    assert not hive.visibility.event_visible(member, _json.dumps({"type": "share.updated", "share": {"id": "sh_missing"}}))
    assert not hive.visibility.event_visible(member, _json.dumps({"type": "share.updated"}))


def test_hive_share_notices_reach_only_people_who_may_see_the_share(client):
    """Kimi hotfix-shares r3: '[SHARE-…]' messages to a mind went to every member who could see that mind."""
    import asyncio
    import json as _json
    from hive.core.visibility import Viewer
    hive = client.app.state.hive
    public = client.post("/api/swarms", json={"name": "NotePub", "visibility": "public"}).json()["id"]
    hidden = share_between(client, public)
    hive.db.execute("UPDATE agents SET visibility = 'private' WHERE id = (SELECT owner_id FROM shares WHERE id = ?)", (hidden,))
    grantee = hive.db.one("SELECT grantee_id FROM shares WHERE id = ?", (hidden,))["grantee_id"]   # still public
    asyncio.run(hive.shares._tell(grantee, f"[SHARE-REQUEST {hidden}] someone asks to read 'journal'", hidden, "share_requested"))
    note = hive.messages(grantee)[-1]
    member, admin = Viewer("user:u_note", False), Viewer("user:operator", True)
    frame = _json.dumps({"type": "message", "message": note})
    assert not hive.visibility.event_visible(member, frame)                       # live
    assert hive.visibility.filter_items(member, [note]) == []                     # listed
    assert hive.visibility.event_visible(admin, frame)
    ana = person(client, "u_note2", "member")
    texts = [m["text"] for m in client.get(f"/api/agents/{grantee}/messages", headers=ana).json()]
    assert not any("SHARE-REQUEST" in t for t in texts)
    hive.db.execute("UPDATE agents SET visibility = 'public' WHERE id = (SELECT owner_id FROM shares WHERE id = ?)", (hidden,))
    assert hive.visibility.event_visible(member, frame)                           # a visible share's notice still flows
