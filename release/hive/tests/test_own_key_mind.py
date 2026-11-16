"""Purpose: a person's own mind thinks with a key the person added themselves, never with someone else's, and an Ask whose
mind has no model to think with says so in plain words instead of answering "Done." (a Lisbon tester, 10 November: her
own mind answered a README request with only "Done."). Invented keys only.

- Ann's own mind is made on the demonstration model when the hive has no key the host pays for.
- A key Ann owns (added under You & your keys) moves her mind onto the conductor's model at her next read or Ask, paid by
  her on her own key. An Ask turn runs on it under its own turn and thread caps; her page says her monthly limit is
  still to set, which her mind's own gateway calls wait for.
- A key Bob owns never moves Ann's mind (the host never spends one person's key on another person's mind).
- A turn on the demonstration model the host set ends with error mind_not_connected and makes no model call, unless only
  the person's monthly total keeps their mind off the hive's own key (an admin has no member default): then it ends as
  that route's call would, asking for the monthly limit, and once a month rule holds them the mind moves there.
"""
import json

from hive.core.conductor import ERROR_SAY
from hive.core.config import Provider
from hive.core.db import now
from hive.core.model_route import held, is_demo
from hive.tests.test_ask import ask, world
from hive.tests.test_ask_conductor import Script, call, closed, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_gateway_r1 import total
from hive.tests.test_personal_mind_r3 import _live


def _hive(client, monkeypatch):
    """The conductor on, its model priced, and no key the host pays for: Ann's own mind starts on the demonstration model."""
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "fakepaid/x")
    w = world(client)
    hive = w["hive"]
    hive.settings.providers["fakepaid"] = Provider("fakepaid", "http://127.0.0.1:9", prices={"*": {"in": 1, "out": 1}})
    w["mine"] = hive.personal.ensure("user:u_ann")
    return w


def _key(hive, key_id, owner, default=True):
    """A fakepaid key owned by `owner`, as POST /api/keys stores one (owner: the signer); `default`: also the provider's
    default, as an admin's own key on a one-person hive is."""
    hive.keyring.ring["keys"][key_id] = {"id": key_id, "provider": "fakepaid", "label": key_id, "owner": owner,
                                        "secret": f"sk-{key_id}-invented", "created_at": 1.0}
    if default:
        hive.keyring.ring["defaults"]["fakepaid"] = key_id
        hive.keyring._apply_defaults()


def _done(fs):
    return next(f for f in fs if f["phase"] == "done")


def _paying_keys(hive):
    """The key each conductor call was reserved on: the reservation's own record (a scripted call's usage row has none)."""
    return {json.loads(r["metadata"]).get("key") for r in hive.db.all("SELECT metadata FROM cost_reservation_details")}


def test_a_key_the_person_added_moves_their_own_mind_and_its_turns_use_it(client, monkeypatch):
    w = _hive(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    assert is_demo(mine["model"]) and held(hive.db, mine["id"]) == mine["model"], "made on the demonstration model, by the host"
    _key(hive, "k_ann_own", "user:u_ann")
    view = client.get("/api/me/mind", headers=w["ann"]).json()["mind"]          # her next read picks it up
    assert view["model"] == "fakepaid/x" and held(hive.db, mine["id"]) == "fakepaid/x", "moved by the host, still its record"
    assert view["paid_by"] == "you, on your own key, once you set your monthly limit"
    s = script(client, Script([call("say", text="Hi Ann.")], "I'm here.", cost=0.004))
    live = _live(hive)   # a personal turn's words reach only her connection, never the stored frames (P2 r3)
    r = ask(client, w["ann"], "op-own-key-001", text="hello")
    assert r.status_code == 202 and r.json()["conductor"] == {"model": "fakepaid/x"}, r.text
    fs = wait(hive, "op-own-key-001", closed)
    assert _done(fs)["outcome"] == "complete", "an Ask turn is held by its own turn and thread caps"
    whole = [f["text"] for f in live if f.get("phase") == "answer" and not f.get("delta")]
    assert len(whole) == 1 and "I'm here." in whole[0] and "Done." not in whole[0], whole
    assert {b["model"] for b in s.bodies} == {"fakepaid/x"} and _paying_keys(hive) == {"k_ann_own"}
    usage = hive.db.all("SELECT agent_id, payer FROM usage")
    assert usage and {(u["agent_id"], u["payer"]) for u in usage} == {(mine["id"], "user:u_ann")}
    total(hive, "user:u_ann", 5.0)                                               # she sets it under You & your keys
    assert client.get("/api/me/mind", headers=w["ann"]).json()["mind"]["paid_by"] == "you, on your own key"


def test_a_members_own_key_moves_her_mind_when_the_default_is_another_persons(client, monkeypatch):
    w = _hive(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    _key(hive, "k_bob_own", "user:u_bob")                                      # the hive's default is Bob's own key
    _key(hive, "k_ann_own", "user:u_ann", default=False)                       # Ann adds hers under You & your keys
    total(hive, "user:u_ann", 5.0)
    view = client.get("/api/me/mind", headers=w["ann"]).json()["mind"]
    assert view["model"] == "fakepaid/x" and view["paid_by"] == "you, on your own key", view
    s = script(client, Script([call("say", text="Hi Ann.")], "I'm here.", cost=0.004))
    r = ask(client, w["ann"], "op-own-key-006", text="hello")
    assert r.status_code == 202, r.text
    assert _done(wait(hive, "op-own-key-006", closed))["outcome"] == "complete" and s.bodies
    assert _paying_keys(hive) == {"k_ann_own"}, "hers, never Bob's"


def test_an_ask_picks_up_a_key_added_since_the_page_read_the_mind(client, monkeypatch):
    w = _hive(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    _key(hive, "k_ann_own", "user:u_ann")
    total(hive, "user:u_ann", 5.0)
    assert is_demo(hive.agent(mine["id"])["model"]), "no read since the key: still the demonstration model"
    script(client, Script([call("say", text="Hi Ann.")], "I'm here.", cost=0.004))
    r = ask(client, w["ann"], "op-own-key-003", text="hello")
    assert r.status_code == 202 and r.json()["conductor"] == {"model": "fakepaid/x"}, r.text
    assert _done(wait(hive, "op-own-key-003", closed))["outcome"] == "complete"
    assert hive.agent(mine["id"])["model"] == "fakepaid/x"


def test_another_persons_key_never_moves_her_mind_and_her_ask_says_it_is_not_connected(client, monkeypatch):
    w = _hive(client, monkeypatch)
    hive, mine = w["hive"], w["mine"]
    _key(hive, "k_bob_own", "user:u_bob")                                      # the hive's default, but Bob's own key
    assert is_demo(client.get("/api/me/mind", headers=w["ann"]).json()["mind"]["model"])
    s = script(client, Script("never", "never", repeat_last=True))
    r = ask(client, w["ann"], "op-own-key-004", text="hello")
    assert r.status_code == 202, r.text
    done = _done(wait(hive, "op-own-key-004", closed))
    assert done["outcome"] == "error" and done["error"] == "mind_not_connected", done
    assert s.bodies == [] and hive.db.all("SELECT * FROM usage") == [], "no model call, nothing spent"
    assert is_demo(hive.agent(mine["id"])["model"])


def test_a_mind_with_no_key_at_all_says_so_instead_of_done(client, monkeypatch):
    w = _hive(client, monkeypatch)
    hive = w["hive"]
    s = script(client, Script("never", "never", repeat_last=True))
    live = _live(hive)
    r = ask(client, w["ann"], "op-own-key-005", text="please add a README")
    assert r.status_code == 202, r.text
    done = _done(wait(hive, "op-own-key-005", closed))
    assert done["outcome"] == "error" and done["error"] == "mind_not_connected", done
    assert s.bodies == []
    whole = [f["text"] for f in live if f.get("phase") == "answer" and not f.get("delta")]
    assert whole == [ERROR_SAY["mind_not_connected"]] and "You & your keys" in whole[0], whole   # never "Done."


def test_an_admins_mind_on_the_hives_own_key_asks_for_a_monthly_limit_then_moves_there(client, monkeypatch):
    w = _hive(client, monkeypatch)
    hive = w["hive"]
    hive.settings.providers["fakepaid"].stored_key = "sk-fakepaid-invented"   # the hive's own key: no person owns it
    jons = hive.personal.ensure("user:u_jon")
    assert is_demo(jons["model"]) and held(hive.db, jons["id"]) == jons["model"], "an admin has no member default"
    s = script(client, Script("never", "never", repeat_last=True))
    r = ask(client, w["jon"], "op-own-key-007", text="hello")
    assert r.status_code == 202 and r.json()["acting_as"]["mind_id"] == jons["id"], r.text
    done = _done(wait(hive, "op-own-key-007", closed, principal="user:u_jon"))
    assert done["outcome"] == "spend_cap" and done["limit"] == {"kind": "member_allowance", "current_usd": None,
                                                                 "limit_usd": None, "estimate_usd": None,
                                                                 "reason": "monthly_total_required"}, done
    assert s.bodies == [] and hive.db.all("SELECT * FROM usage") == [], "no model call, nothing spent"
    hive.db.insert("budgets", {"id": "b_u_jon_own_key_mind", "scope": "person:u_jon", "period": "month", "limit_usd": 5.0,
                               "note": "", "created_at": now()})                # an admin sets Jon's month rule
    s = script(client, Script([call("say", text="Hi Jon.")], "I'm here.", cost=0.004))
    r = ask(client, w["jon"], "op-own-key-008", text="hello again")
    assert r.status_code == 202 and r.json()["conductor"] == {"model": "fakepaid/x"}, r.text
    assert _done(wait(hive, "op-own-key-008", closed, principal="user:u_jon"))["outcome"] == "complete" and s.bodies
