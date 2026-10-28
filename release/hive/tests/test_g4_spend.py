"""G4: a person's own daily spend, read from the existing usage rows.

Only rows billed to the caller, grouped by day in the person's time zone, split own keys vs hive-paid, by mind and by
app context; bounded days; never another person's spend; the frame read is P1-admitted and names only totals and this
app's share. Synthetic only: invented people, apps, keys and usage rows, no provider call."""
import datetime

import pytest

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_g2_notices import frame, frame_op, mind_in, settings
from hive.tests.test_key_owner_oi13 import K_BOB, w  # noqa: F401  (fixture)
from hive.tests.test_p14_ready_on_install import ANN_P, BOB_P, SOLO, opened, x  # noqa: F401  (fixture)

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 10, 27, 15, 0, tzinfo=UTC)


def spent(s, agent, payer, usd, when, key_id=None):
    s.hive.db.insert("usage", {"agent_id": agent["id"], "model": "mock/echo", "prompt_tokens": 1, "completion_tokens": 1,
                               "cost_usd": usd, "created_at": when.isoformat().replace("+00:00", "Z"), "key_id": key_id,
                               "swarm_id": agent.get("swarm_id"), "payer": payer})


def spend(s, headers, days=None):
    return s.client.get("/api/me/spend" + (f"?days={days}" if days is not None else ""), headers=headers)


@pytest.fixture()
def s(x):
    x.hive.me_spend.clock = lambda: NOW
    x.space = opened(x, SOLO, x.bob)["swarm_id"]
    x.helper = mind_in(x, x.bob, x.space)
    spent(x, x.helper, BOB_P, 0.02, NOW - datetime.timedelta(hours=1), key_id=K_BOB)   # today, own key, in the app
    spent(x, x.bob_mind, BOB_P, 0.05, NOW - datetime.timedelta(days=1))                # yesterday, hive-paid, elsewhere
    spent(x, x.ann_mind, ANN_P, 9.00, NOW - datetime.timedelta(hours=2))               # Ann's own: never Bob's
    spent(x, x.ann_mind, "user:u_someone", 7.00, NOW - datetime.timedelta(hours=2))
    return x


def test_a_person_reads_only_their_own_spend_per_day(s):
    r = spend(s, s.bob, 3)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["principal"] == BOB_P and out["tz"] == "UTC"
    assert [d["date"] for d in out["days"]] == ["2026-10-25", "2026-10-26", "2026-10-27"]
    today, yesterday = out["days"][2], out["days"][1]
    assert (today["total_usd"], today["own_keys_usd"], today["hive_paid_usd"]) == (0.02, 0.02, 0.0)
    assert (yesterday["total_usd"], yesterday["own_keys_usd"], yesterday["hive_paid_usd"]) == (0.05, 0.0, 0.05)
    assert out["days"][0]["total_usd"] == 0.0                                  # quiet days are shown, not skipped
    assert out["total_usd"] == 0.07
    assert today["by_app"] == {SOLO: 0.02} and yesterday["by_app"] == {"other": 0.05}
    assert [m["name"] for m in today["by_mind"]] == ["Watcher"]


def test_never_another_persons_spend_and_admins_get_no_wider_view_here(s):
    ann = spend(s, s.ann, 3).json()
    assert ann["principal"] == ANN_P and ann["total_usd"] == 9.0               # the admin's own, not everyone's
    assert spend(s, s.cy, 3).json()["total_usd"] == 0.0
    forged = s.client.get(f"/api/me/spend?days=3&principal={BOB_P}", headers=s.cy).json()
    assert forged["principal"] != BOB_P and forged["total_usd"] == 0.0         # a selector in the request is ignored
    assert s.client.get("/api/me/spend", headers={"Authorization": f"Bearer {s.helper['token']}"}).status_code == 401


@pytest.mark.parametrize("days", ["0", "32", "-1", "x"])
def test_days_are_bounded(s, days):
    assert spend(s, s.bob, days).status_code == 400


def test_the_default_and_the_maximum(s):
    assert len(spend(s, s.bob).json()["days"]) == 7
    assert len(spend(s, s.bob, 31).json()["days"]) == 31


def test_days_follow_the_persons_time_zone(s):
    late = datetime.datetime(2026, 10, 27, 2, 0, tzinfo=UTC)                   # 22:00 on the 26th in New York
    spent(s, s.helper, BOB_P, 0.10, late)
    assert settings(s, s.bob, tz="America/New_York").status_code == 200
    out = spend(s, s.bob, 2).json()
    assert out["tz"] == "America/New_York"
    by_date = {d["date"]: d["total_usd"] for d in out["days"]}
    assert by_date == {"2026-10-26": 0.15, "2026-10-27": 0.02}


def test_the_frame_read_gives_totals_and_this_apps_share_only(s):
    h, g = frame(s, s.bob)
    r = frame_op(s, h, g, {"op": "spend", "days": 2})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["total_usd"] == 0.07 and out["this_app_usd"] == 0.02
    assert out["days"][-1] == {"date": "2026-10-27", "total_usd": 0.02, "this_app_usd": 0.02}
    assert "by_mind" not in r.text and "other" not in r.text and ANN_P not in r.text


def test_only_a_current_person_reads_spend(s):
    from hive.tests.test_visibility import person
    assert s.client.get("/api/me/spend").status_code == 403                    # the operator password session
    family = person(s.client, "fam_robin")                                      # a session that is not a u_ person
    assert s.client.get("/api/me/spend", headers=family).status_code == 403
    s.hive.db.execute("UPDATE people SET disabled = 1 WHERE id = ?", (BOB_P[5:],))
    assert spend(s, s.bob).status_code in (401, 403)
