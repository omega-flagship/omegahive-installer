"""J3 host R8.4: an E7 refresh between the maker's context read and its publish no longer makes the read stale.

Live on the cloud walk: the maker read its context, the person's frame re-uploaded the unchanged piece as an E7 refresh
(same body_sha256, scene_ref and edit_generation; seq bumps), and the maker's valid omega-maker-revision-2 proposal was
refused 409 stale_piece_read although the person had changed nothing. R8.4: at publish, the read is stale only if the
piece is missing or its CONTENT (body_sha256, scene_ref, edit_generation) differs from the read's recorded tuple
(studio_steps.piece_read). A real edit still refuses with the same stale_piece_read error and fields.

Places that compare seq and are deliberately left alone (seq order matters there): put_piece upload numbering, the
outcome custody floor (the cited ack's seq >= piece_read_seq), ack retention, and the S3.5 admission check
(piece_upload_seq / outcome_at). Done carries no piece check. The custody floor is covered below for the same pair of
cases (refresh-only, and a real edit). Synthetic only: temporary data directories, the R3 fake driver, invented keys."""
import json

from hive.tests.test_studio_session_r3 import (body, context, done, in_step, outcome, publish, r3,  # noqa: F401
                                               started, step_row, upload)
from hive.tests.test_ask_intents import a  # noqa: F401  (fixture)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import err, s  # noqa: F401

REVISION_2 = json.dumps({"schema": "omega-maker-revision-2", "items": [
    {"op": "add-text", "text": "Hello"}, {"op": "add-shape", "shape": "circle"}]})


def refresh(x, sid, m, seq):
    """The frame re-observes the unchanged piece (seq 1's bytes at generation 1): an E7 refresh."""
    r = upload(x, sid, m, seq, gen=1, text=body(1, 1))
    assert r.status_code == 200 and r.json()["refresh"] is True, r.text
    return r.json()


def edit(x, sid, m, seq, gen):
    r = upload(x, sid, m, seq, gen=gen, text=f"hand edit {gen}")
    assert r.status_code == 200 and r.json()["refresh"] is False, r.text
    return r.json()


def stale(response, read_seq, latest_seq):
    assert response.status_code == 409, response.text
    e = err(response)
    assert e["code"] == "stale_piece_read" and e["message"] == "The piece changed since your context read."
    details = e.get("details") or e
    assert (details["read_seq"], details["latest_seq"]) == (read_seq, latest_seq)


# ---- (a)-(d): the publish fence ------------------------------------------------------------------------------------------

def test_R84_a_read_then_a_refresh_with_the_same_bytes_then_publish_succeeds(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    assert step_row(r3, sid, 1)["piece_read_seq"] == 1
    refresh(r3, sid, m, 2)
    r = publish(r3, session, step["execution_id"], text=REVISION_2)
    assert r.status_code == 200, r.text
    assert step_row(r3, sid, 1)["proposal_n"] == r.json()["n"] == 1
    assert step_row(r3, sid, 1)["piece_read_seq"] == 1                    # the read itself is unchanged


def test_R84_a2_several_refreshes_since_the_read_still_publish(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    for seq in (2, 3, 4):
        refresh(r3, sid, m, seq)
    assert publish(r3, session, step["execution_id"], text=REVISION_2).status_code == 200


def test_R84_b_read_then_a_real_edit_then_publish_is_refused_stale_piece_read(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    edit(r3, sid, m, 2, gen=2)
    stale(publish(r3, session, step["execution_id"], text=REVISION_2), 1, 2)
    assert step_row(r3, sid, 1)["proposal_n"] is None


def test_R84_c_read_then_a_refresh_then_a_real_edit_then_publish_is_refused(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    refresh(r3, sid, m, 2)
    edit(r3, sid, m, 3, gen=2)
    stale(publish(r3, session, step["execution_id"], text=REVISION_2), 1, 3)
    assert step_row(r3, sid, 1)["proposal_n"] is None


def test_R84_c2_a_real_edit_then_a_refresh_of_the_edited_art_is_still_stale_until_re_read(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    edit(r3, sid, m, 2, gen=2)
    again = upload(r3, sid, m, 3, gen=2, text="hand edit 2")          # a refresh, but of art the maker never read
    assert again.json()["refresh"] is True
    stale(publish(r3, session, step["execution_id"], text=REVISION_2), 1, 3)
    c = context(r3, sid, step["execution_id"]).json()                 # G5a: the re-read takes in the edit
    assert c["piece"]["seq"] == 3 and step_row(r3, sid, 1)["piece_read_seq"] == 3
    assert publish(r3, session, step["execution_id"], text=REVISION_2).status_code == 200


def test_R84_d_no_read_then_publish_is_refused_as_before(r3):
    session, sid, m, ack, step = started(r3)
    stale(publish(r3, session, step["execution_id"], text=REVISION_2), None, 1)
    refresh(r3, sid, m, 2)                                             # a refresh never stands in for a read
    stale(publish(r3, session, step["execution_id"], text=REVISION_2), None, 2)
    assert step_row(r3, sid, 1)["proposal_n"] is None


# ---- (e): the outcome custody floor, deliberately unchanged, for the same pair of cases --------------------------------

def _published(x):
    session, sid, m, ack, step = started(x)
    in_step(x, sid, step)
    refresh(x, sid, m, 2)
    pub = publish(x, session, step["execution_id"], text=REVISION_2)
    assert pub.status_code == 200, pub.text
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": pub.json()["n"], "digest": pub.json()["digest"]}
    assert done(x, sid, 1, step["execution_id"], more=False).status_code == 200
    return session, sid, m, ack, step, prop


def test_R84_e_after_a_refresh_the_outcome_records_with_the_refreshed_or_edited_upload(r3):
    session, sid, m, ack, step, prop = _published(r3)
    after = edit(r3, sid, m, 3, gen=2)                                 # the applied art
    r = outcome(r3, sid, 1, m, prop, after)
    assert r.status_code == 200, r.text
    assert step_row(r3, sid, 1)["piece_upload_seq"] == 3


def test_R84_e_refused_outcome_may_cite_the_refresh_and_an_upload_older_than_the_read_is_still_refused(r3):
    session, sid, m, ack, step = started(r3)
    in_step(r3, sid, step)
    cite = refresh(r3, sid, m, 2)
    again = context(r3, sid, step["execution_id"]).json()             # a re-read after the refresh moves the read to 2
    assert again["piece"]["seq"] == 2 and step_row(r3, sid, 1)["piece_read_seq"] == 2
    pub = publish(r3, session, step["execution_id"], text=REVISION_2).json()
    prop = {"artifact_id": session["proposal_artifact_id"], "revision": pub["n"], "digest": pub["digest"]}
    assert done(r3, sid, 1, step["execution_id"], more=False).status_code == 200
    # seq order still matters for custody: with the read at seq 2, the seq-1 upload (same content) is not proof
    assert err(outcome(r3, sid, 1, m, prop, ack, result="refused", reason="x"))["code"] == "piece_custody_missing"
    r = outcome(r3, sid, 1, m, prop, cite, result="refused", reason="x")   # the refresh itself is
    assert r.status_code == 200, r.text
