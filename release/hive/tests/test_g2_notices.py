"""G2: person notices with a hive-enforced daily budget.

Only a mind in the person's own app space (P14 context or P2 app swarm) reaches them; the person's cap and quiet hours
hold notices, which then arrive as one digest and are never dropped; reminders are free; urgent is unavailable until a
home link exists; text is bounded plain text; the frame read is admitted like every P1 op and shows only this person's
notices from this app's own context. Synthetic only: invented people, apps and minds, no provider call."""
import datetime
import json
import os

import pytest

from hive.core.notices import MAX_BYTES, MIND_PER_HOUR, URGENT_KINDS
from hive.core.visibility import Viewer
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_key_owner_oi13 import MODEL, w  # noqa: F401  (fixture)
from hive.tests.test_p14_ready_on_install import ANN_P, BOB_P, CY_P, SOLO, opened, x  # noqa: F401  (fixture)

UTC = datetime.timezone.utc
NOON = datetime.datetime(2026, 10, 27, 12, 0, tzinfo=UTC)


def at(n, moment):
    n.hive.notices.clock = lambda: moment


def mind_in(n, headers, swarm_id, name="Watcher"):
    r = n.client.post("/api/agents", headers=headers, json={"name": name, "kind": "omega", "swarm_id": swarm_id,
                                                            "model": MODEL})
    assert r.status_code == 200, r.text
    return r.json()


def send(n, mind, text="The parcel came.", **extra):
    return n.client.post("/api/agent/notices", headers={"Authorization": f"Bearer {mind['token']}"},
                         json={"text": text, **extra})


def mine(n, headers):
    r = n.client.get("/api/me/notices", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def settings(n, headers, **values):
    return n.client.put("/api/me/notices/settings", headers=headers, json=values)


def rows(n, principal=BOB_P):
    return n.hive.db.all("SELECT * FROM notices WHERE principal = ? ORDER BY seq", (principal,))


@pytest.fixture()
def n(x):
    at(x, NOON)
    x.space = opened(x, SOLO, x.bob)["swarm_id"]
    x.watcher = mind_in(x, x.bob, x.space)
    return x


# ---- who may post -----------------------------------------------------------------------------------------------------

def test_a_mind_in_the_persons_own_app_space_reaches_them(n):
    r = send(n, n.watcher)
    assert r.status_code == 200 and r.json()["state"] == "delivered", r.text
    out = mine(n, n.bob)
    assert [(x["text"], x["from"], x["kind"]) for x in out["notices"]] == [("The parcel came.", "Watcher", "notice")]
    assert out["waiting"] == 0


def test_minds_outside_the_persons_own_space_cannot_post(n):
    ordinary = send(n, n.bob_mind)                          # Bob's own mind, but in an ordinary swarm, not an app space
    others = send(n, n.ann_mind)                            # another person's mind
    cy_space = opened(n, SOLO, n.cy)["swarm_id"]
    cy_mind = send(n, mind_in(n, n.cy, cy_space, "Cyra"))   # Cy's own space: reaches Cy, never Bob
    assert (ordinary.status_code, ordinary.json()["error"]["code"]) == (403, "not_your_person")
    assert (others.status_code, others.json()["error"]["code"]) == (403, "not_your_person")
    assert cy_mind.status_code == 200
    assert rows(n) == [] and len(rows(n, CY_P)) == 1
    assert mine(n, n.bob)["notices"] == []


def test_a_space_that_is_no_longer_private_and_owned_refuses(n):
    n.hive.db.execute("UPDATE swarms SET visibility = 'public' WHERE id = ?", (n.space,))
    assert send(n, n.watcher).status_code == 403
    n.hive.db.execute("UPDATE swarms SET visibility = 'private', owner = ? WHERE id = ?", (ANN_P, n.space))
    assert send(n, n.watcher).status_code == 403
    assert rows(n) == [] and rows(n, ANN_P) == []


def test_people_and_apps_have_no_post_route(n):
    for headers in (n.bob, n.ann, {}):                       # a person, an admin, the operator password session
        assert n.client.post("/api/agent/notices", headers=headers, json={"text": "hi"}).status_code == 401
    assert rows(n) == []


def test_each_person_reads_only_their_own(n):
    assert send(n, n.watcher).status_code == 200
    assert mine(n, n.cy)["notices"] == [] and mine(n, n.ann)["notices"] == []   # admins included
    assert n.client.get("/api/me/notices", headers={"Authorization": f"Bearer {n.watcher['token']}"}).status_code == 401
    assert n.client.get("/api/me/notices").status_code == 403                # the operator is not a person


def test_the_live_notice_frame_goes_to_its_person_only(n):
    frame = json.dumps({"type": "notice", "at": "x", "principal": BOB_P, "notice": None, "waiting": 1})
    vis = n.hive.visibility
    assert vis.event_visible(Viewer(BOB_P, False), frame)
    assert not vis.event_visible(Viewer(CY_P, False), frame)
    assert not vis.event_visible(Viewer(ANN_P, True), frame)              # not even an admin
    assert not vis.event_visible(Viewer("user:operator", True), frame)


# ---- the daily budget ---------------------------------------------------------------------------------------------------

def test_over_the_cap_is_held_never_dropped(n):
    assert settings(n, n.bob, quiet_start=None, quiet_end=None).status_code == 200
    states = [send(n, n.watcher, f"note {i}").json() for i in range(5)]
    assert [s["state"] for s in states] == ["delivered"] * 3 + ["held"] * 2       # default cap 3
    assert states[-1]["held"] == "cap"
    out = mine(n, n.bob)
    assert len(out["notices"]) == 3 and out["waiting"] == 2
    assert len(rows(n)) == 5                                                      # nothing dropped


def test_the_cap_counts_across_the_persons_minds(n):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    second = mind_in(n, n.bob, n.space, "Errands")
    assert send(n, n.watcher).json()["state"] == "delivered"
    assert send(n, second).json()["state"] == "held"


def test_a_cap_hold_waits_for_the_next_day_then_comes_as_one_digest(n):
    assert settings(n, n.bob, cap=0, quiet_start=None, quiet_end=None).status_code == 200
    for i in range(3):
        assert send(n, n.watcher, f"waited {i}").json()["state"] == "held"
    n.hive.notices.sweep()
    assert mine(n, n.bob)["waiting"] == 3                                         # the same day: still waiting
    at(n, NOON + datetime.timedelta(days=1))
    n.hive.notices.sweep()
    out = mine(n, n.bob)
    assert out["waiting"] == 0 and len(out["notices"]) == 1
    digest = out["notices"][0]
    assert digest["kind"] == "digest" and digest["text"] == "3 things waited for you."
    assert [i["text"] for i in digest["items"]] == ["waited 0", "waited 1", "waited 2"]
    assert {r["state"] for r in rows(n) if r["kind"] == "notice"} == {"digested"}


def test_quiet_hours_hold_then_one_digest_when_they_end(n):
    assert settings(n, n.bob, tz="Europe/London").status_code == 200              # default quiet 21:00 to 07:00
    night = datetime.datetime(2026, 10, 27, 22, 30, tzinfo=UTC)                   # 22:30 in London (GMT)
    at(n, night)
    assert send(n, n.watcher, "late one").json() == {"id": rows(n)[-1]["id"], "state": "held", "held": "quiet"}
    at(n, night + datetime.timedelta(hours=3))
    assert send(n, n.watcher, "later one").json()["state"] == "held"
    n.hive.notices.sweep()
    assert mine(n, n.bob)["notices"] == []                                        # still quiet: nothing pops up
    at(n, datetime.datetime(2026, 10, 28, 7, 5, tzinfo=UTC))
    out = mine(n, n.bob)                                                          # a read lets a due digest go too
    assert [i["text"] for i in out["notices"][0]["items"]] == ["late one", "later one"] and out["waiting"] == 0


def test_the_person_can_ask_for_what_is_waiting_now(n):
    assert settings(n, n.bob, cap=0).status_code == 200
    send(n, n.watcher, "one")
    r = n.client.post("/api/me/notices/release", headers=n.bob, json={})
    assert r.status_code == 200 and [i["text"] for i in r.json()["digest"]["items"]] == ["one"]
    assert n.client.post("/api/me/notices/release", headers=n.bob, json={}).json() == {"digest": None}
    assert n.client.post("/api/me/notices/release", headers=n.cy, json={}).json() == {"digest": None}


def test_self_set_reminders_do_not_count_against_the_cap(n):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    assert send(n, n.watcher).json()["state"] == "delivered"                      # the cap is used
    assert n.hive.notices.reminder(n.watcher["id"], "Call the plumber")["state"] == "delivered"
    assert n.hive.notices.reminder(n.watcher["id"], "Water the plants")["state"] == "delivered"
    assert send(n, n.watcher).json()["state"] == "held"
    assert settings(n, n.bob, quiet_start="00:00", quiet_end="23:59").status_code == 200
    assert n.hive.notices.reminder(n.watcher["id"], "Late reminder")["state"] == "held"   # quiet hours still hold it


def test_settings_are_the_persons_own_and_bounded(n):
    assert n.client.get("/api/me/notices/settings", headers=n.bob).json()["cap"] == 3
    for bad in ({"cap": 2}, {"cap": "3"}, {"quiet_start": "25:00", "quiet_end": "07:00"}, {"quiet_start": None},
                {"tz": "Mars/Base"}, {"principal": CY_P}):
        assert settings(n, n.bob, **bad).status_code == 400, bad
    assert settings(n, n.bob, cap=8, quiet_start="22:00", quiet_end="06:30", tz="Europe/London").json()["cap"] == 8
    assert n.client.get("/api/me/notices/settings", headers=n.cy).json()["cap"] == 3     # Cy's are untouched
    r = n.client.put("/api/me/notices/settings", headers={"Authorization": f"Bearer {n.watcher['token']}"}, json={"cap": 8})
    assert r.status_code == 401                                                   # no mind can raise the cap


# ---- urgent, size and rate --------------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind", URGENT_KINDS)
def test_urgent_is_unavailable_until_a_home_link_exists(n, kind):
    r = send(n, n.watcher, "Smoke in the kitchen", urgent={"kind": kind, "event": "ev-1"})
    assert (r.status_code, r.json()["error"]["code"]) == (403, "urgent_unavailable")
    assert rows(n) == []


def test_only_the_four_safety_kinds_are_urgent_and_a_verified_one_breaks_through(n, monkeypatch):
    r = send(n, n.watcher, "Package!", urgent={"kind": "delivery", "event": "ev-1"})
    assert r.status_code == 400
    monkeypatch.setattr(n.hive.notices, "home_link_verified", lambda agent, kind, event: True)   # what a home link would do
    assert settings(n, n.bob, cap=0, quiet_start="00:00", quiet_end="23:59").status_code == 200
    r = send(n, n.watcher, "Water leak under the sink", urgent={"kind": "water_leak", "event": "ev-2"})
    assert r.json()["state"] == "delivered"
    assert mine(n, n.bob)["notices"][0]["urgent"] == "water_leak"


def test_size_and_plain_text(n):
    assert send(n, n.watcher, "x" * (MAX_BYTES + 1)).status_code == 413
    assert send(n, n.watcher, "é" * (MAX_BYTES // 2 + 1)).status_code == 413          # bytes, not characters
    assert send(n, n.watcher, "é" * (MAX_BYTES // 2)).status_code == 200
    assert send(n, n.watcher, "bell\x07").status_code == 400
    assert send(n, n.watcher, "   ").status_code == 400
    assert send(n, n.watcher, "hi", html="<b>").status_code == 400
    markup = "<img src=x onerror=alert(1)>"
    assert send(n, n.watcher, markup).status_code == 200
    r = n.client.get("/api/me/notices", headers=n.bob)
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["notices"][0]["text"] == markup                               # stored and served verbatim, as text


def test_a_mind_is_rate_limited_and_the_refusal_is_an_answer(n):
    assert settings(n, n.bob, cap=8, quiet_start=None, quiet_end=None).status_code == 200
    for i in range(MIND_PER_HOUR):
        assert send(n, n.watcher, f"n{i}").status_code == 200
    r = send(n, n.watcher, "one too many")
    assert (r.status_code, r.json()["error"]["code"]) == (429, "rate_limited")
    assert len(rows(n)) == MIND_PER_HOUR                                          # every accepted one is kept
    at(n, NOON + datetime.timedelta(hours=1, seconds=1))
    assert send(n, n.watcher, "next hour").status_code == 200


# ---- the frame read (P1 admission) ----------------------------------------------------------------------------------

def frame(n, headers, slot="slot-g2"):
    origin = "http://127.0.0.1:" + os.environ.get("HIVE_PORT", "8700")
    h = dict(headers, Origin=origin)
    card = n.client.get(f"/api/programs/{SOLO}/ask/consent", headers=h).json()
    if not card["consented"]:
        assert n.client.post(f"/api/programs/{SOLO}/ask/consent", headers=h, json={"card_id": card["card_id"]}).status_code == 200
    r = n.client.post(f"/api/programs/{SOLO}/ask/frames", headers=h,
                      json={"release_digest": card["release_digest"], "frame_slot_id": slot})
    assert r.status_code == 200, r.text
    return h, r.json()["generation_id"]


def frame_op(n, h, generation, body):
    return n.client.post(f"/api/programs/{SOLO}/ask/frames/{generation}/ops", headers=h, json=body)


def test_the_frame_read_shows_only_this_persons_notices_from_this_apps_context(n):
    assert settings(n, n.bob, quiet_start=None, quiet_end=None).status_code == 200
    send(n, n.watcher, "for the app")
    n.hive.notices.reminder(n.bob_mind["id"], "from elsewhere")                    # Bob's, but not from this app's space
    h, g = frame(n, n.bob)
    r = frame_op(n, h, g, {"op": "notices"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert [x["text"] for x in out["notices"]] == ["for the app"] and out["more"] is False
    assert "agent_id" not in out["notices"][0]
    assert frame_op(n, h, g, {"op": "notices", "after": out["cursor"]}).json()["notices"] == []
    opened(n, SOLO, n.cy)
    cy_h, cy_g = frame(n, n.cy, "slot-cy")
    assert frame_op(n, cy_h, cy_g, {"op": "notices"}).json()["notices"] == []
    assert frame_op(n, cy_h, g, {"op": "notices"}).status_code == 404             # not Cy's generation


def test_the_frame_read_needs_current_p1_consent(n):
    h, g = frame(n, n.bob)
    for bad in ({"op": "notices", "after": -1}, {"op": "notices", "principal": CY_P}, {"op": "spend", "days": 32}):
        assert frame_op(n, h, g, bad).status_code == 400, bad
    assert n.client.request("DELETE", f"/api/programs/{SOLO}/ask/consent", headers=h, json={}).status_code == 200
    assert frame_op(n, h, g, {"op": "notices"}).status_code in (403, 404, 409)


# ---- R2: delivery order follows release, not insertion ------------------------------------------------------------------

def frame_all(n, h, g, after=0):
    """Poll the frame read to the end; every page moves the cursor."""
    seen = []
    while True:
        out = frame_op(n, h, g, {"op": "notices", "after": after}).json()
        assert out["cursor"] > after or not out["notices"]
        seen += out["notices"]
        after = out["cursor"]
        if not out["more"]:
            return seen, after


def test_a_frame_cursor_past_a_held_notice_still_sees_it_after_release(n):
    """Stand-in R1 P1 repro: hold at seq 1, deliver and poll seq 2, release, poll after 2."""
    assert settings(n, n.bob, cap=0, quiet_start=None, quiet_end=None).status_code == 200
    assert send(n, n.watcher, "held first").json()["state"] == "held"
    assert n.hive.notices.reminder(n.watcher["id"], "delivered second")["state"] == "delivered"
    h, g = frame(n, n.bob)
    seen, cursor = frame_all(n, h, g)
    assert [x["text"] for x in seen] == ["delivered second"]
    digest = n.client.post("/api/me/notices/release", headers=n.bob, json={}).json()["digest"]
    seen, _ = frame_all(n, h, g, cursor)
    assert [(x["kind"], x["text"]) for x in seen] == [("notice", "held first"), ("digest", "1 thing waited for you.")]
    assert seen[0]["digest_id"] == digest["id"] == seen[1]["id"]


def test_a_new_day_notice_before_reconciliation_comes_after_yesterdays_digest(n):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    assert send(n, n.watcher, "day one").json()["state"] == "delivered"
    assert send(n, n.watcher, "waited overnight").json()["state"] == "held"
    h, g = frame(n, n.bob)
    _, cursor = frame_all(n, h, g)
    person_cursor = mine(n, n.bob)["notices"][0]["seq"]
    at(n, NOON + datetime.timedelta(days=1))                                      # no sweep has run
    assert send(n, n.watcher, "day two").json()["state"] == "delivered"
    seen, _ = frame_all(n, h, g, cursor)
    assert [x["text"] for x in seen] == ["waited overnight", "1 thing waited for you.", "day two"]
    r = n.client.get(f"/api/me/notices?after={person_cursor}", headers=n.bob).json()
    assert [x["kind"] for x in r["notices"]] == ["notice", "digest"]              # newest first; the digest is not missed
    assert [i["text"] for i in r["notices"][1]["items"]] == ["waited overnight"]


def test_a_digest_is_shown_to_the_owning_frame_scoped_to_its_context(n):
    assert settings(n, n.bob, quiet_start="00:00", quiet_end="23:59").status_code == 200
    assert send(n, n.watcher, "for the app").json()["state"] == "held"
    assert n.hive.notices.reminder(n.bob_mind["id"], "from elsewhere")["state"] == "held"
    h, g = frame(n, n.bob)
    digest = n.client.post("/api/me/notices/release", headers=n.bob, json={}).json()["digest"]
    assert len(digest["items"]) == 2                                              # the person sees both
    seen, _ = frame_all(n, h, g)
    assert [(x["kind"], x["text"]) for x in seen] == [("notice", "for the app"), ("digest", "1 thing waited for you.")]
    assert "from elsewhere" not in json.dumps(seen)


def test_the_person_route_never_misses_a_released_item(n):
    assert settings(n, n.bob, cap=0, quiet_start=None, quiet_end=None).status_code == 200
    n.hive.notices.reminder(n.watcher["id"], "seen")
    cursor = mine(n, n.bob)["notices"][0]["seq"]
    send(n, n.watcher, "held a")
    send(n, n.watcher, "held b")
    n.client.post("/api/me/notices/release", headers=n.bob, json={})
    out = n.client.get(f"/api/me/notices?after={cursor}", headers=n.bob).json()
    assert [i["text"] for i in out["notices"][0]["items"]] == ["held a", "held b"] and out["waiting"] == 0
    assert all(i["seq"] > cursor for i in out["notices"][0]["items"])


def test_settings_changes_never_release_todays_cap_holds_unless_a_raised_cap_fits_them(n):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    for text in ("first", "a", "b", "c"):
        send(n, n.watcher, text)
    assert settings(n, n.bob, tz="Europe/London").status_code == 200
    assert settings(n, n.bob, quiet_start="23:00", quiet_end="23:30").status_code == 200
    n.hive.notices.sweep()
    assert mine(n, n.bob)["waiting"] == 3                                         # a settings edit is not a release
    assert settings(n, n.bob, cap=3).status_code == 200                           # 1 used + 3 waiting > 3: they wait
    assert mine(n, n.bob)["waiting"] == 3
    assert settings(n, n.bob, cap=5).status_code == 200                           # now they fit
    assert mine(n, n.bob)["waiting"] == 0
    assert send(n, n.watcher, "d").json()["state"] == "delivered"                 # 5 of 5: they used today's cap
    assert send(n, n.watcher, "e").json()["state"] == "held"


def test_the_frame_read_pages_and_always_moves_its_cursor(n):
    assert settings(n, n.bob, cap=8, quiet_start=None, quiet_end=None).status_code == 200
    second = mind_in(n, n.bob, n.space, "Errands")
    for i in range(25):
        n.hive.notices.reminder((n.watcher if i % 2 else second)["id"], f"{i:02d} " + "x" * 400)
    h, g = frame(n, n.bob)
    seen, _ = frame_all(n, h, g)
    assert [x["text"][:2] for x in seen] == [f"{i:02d}" for i in range(25)]


def test_what_the_person_pulls_now_uses_none_of_todays_cap(n):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    send(n, n.watcher, "first")
    send(n, n.watcher, "waiting")
    n.client.post("/api/me/notices/release", headers=n.bob, json={})
    assert settings(n, n.bob, cap=3).status_code == 200
    assert [send(n, n.watcher, t).json()["state"] for t in ("x", "y", "z")] == ["delivered", "delivered", "held"]


# ---- R3: the delivery migration is atomic and recovers partial rows -----------------------------------------------------

R1_TABLE = """CREATE TABLE notices (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, agent_id TEXT,
  swarm_id TEXT, kind TEXT NOT NULL, urgent TEXT, text TEXT NOT NULL, counted INTEGER NOT NULL, state TEXT NOT NULL,
  held_reason TEXT, day TEXT NOT NULL, digest_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT)"""


def r1_rows(n, space):
    """An R1-shaped table (no delivery column) with delivered, digested, held and digest rows."""
    n.hive.db.execute("DROP TABLE notices")
    n.hive.db.execute(R1_TABLE)
    base = {"principal": BOB_P, "agent_id": n.watcher["id"], "swarm_id": space, "urgent": None, "counted": 1,
            "held_reason": None, "day": "2026-10-27", "created_at": "2026-10-27T12:00:00Z"}
    for i, (kind, state, digest) in enumerate([("notice", "delivered", None), ("notice", "digested", "n_d"),
                                               ("digest", "delivered", None), ("notice", "held", None)], 1):
        n.hive.db.insert("notices", {**base, "id": f"n_{i}" if kind != "digest" else "n_d", "kind": kind,
                                     "text": f"old {i}", "state": state, "digest_id": digest,
                                     "held_reason": "cap" if state == "held" else None,
                                     "delivered_at": None if state == "held" else "2026-10-27T12:00:00Z",
                                     **({"agent_id": None, "swarm_id": None} if kind == "digest" else {})})


def restart(n):
    from hive.core.notices import Notices
    n.hive.notices = Notices(n.hive, clock=n.hive.notices.clock)


def assert_all_visible(n):
    rows = n.hive.db.all("SELECT * FROM notices ORDER BY seq")
    assert [r["delivery"] is None for r in rows] == [r["state"] == "held" for r in rows]
    delivered = [r["delivery"] for r in rows if r["delivery"] is not None]
    assert delivered == sorted(delivered) and len(set(delivered)) == len(delivered)   # posting order, unique
    out = mine(n, n.bob)
    assert [x["text"] for x in out["notices"]] == ["old 3", "old 1"] and out["waiting"] == 1
    assert [i["text"] for i in out["notices"][0]["items"]] == ["old 2"]
    h, g = frame(n, n.bob)
    seen, _ = frame_all(n, h, g)
    assert [x["text"] for x in seen] == ["old 1", "old 2", "1 thing waited for you."]


def test_an_interrupted_migration_rolls_back_and_the_restart_completes_it(n, monkeypatch):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    r1_rows(n, n.space)
    real = n.hive.db.execute

    def fail_after_alter(sql, params=()):
        if sql.startswith("UPDATE notices SET delivery"):
            raise RuntimeError("stopped mid-migration")
        return real(sql, params)
    monkeypatch.setattr(n.hive.db, "execute", fail_after_alter)
    with pytest.raises(RuntimeError):
        restart(n)
    monkeypatch.setattr(n.hive.db, "execute", real)
    assert "delivery" not in {c["name"] for c in n.hive.db.all("PRAGMA table_info(notices)")}   # all or nothing
    restart(n)
    assert_all_visible(n)


def test_a_restart_recovers_rows_left_without_a_delivery_number(n):
    assert settings(n, n.bob, cap=1, quiet_start=None, quiet_end=None).status_code == 200
    r1_rows(n, n.space)
    n.hive.db.execute("ALTER TABLE notices ADD COLUMN delivery INTEGER")   # an old non-atomic start: column, no backfill
    n.hive.db.execute("UPDATE notices SET delivery = 1 WHERE id = 'n_1'")  # and only part of it numbered
    restart(n)
    assert_all_visible(n)
    numbers = n.hive.db.all("SELECT id, delivery FROM notices ORDER BY seq")
    restart(n)                                                             # idempotent: nothing renumbered
    assert n.hive.db.all("SELECT id, delivery FROM notices ORDER BY seq") == numbers
