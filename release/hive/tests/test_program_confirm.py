"""Host confirm for app acts (Platform/Surface agreement 2026-10-05, PROGRAMS.md §9d): describe().actions[].confirm,
the person's single-use confirm token, and its enforcement on POST /api/programs/{id}/act."""
import base64
import hashlib
import json

from hive.tests.test_core_api import agent_headers, client, make_swarm_and_agents  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

APP = """
GOT = []

def describe():
    return {"contract": "0.2", "kinds": [{"id": "k", "label": "K", "role": "claim"}], "relations": [],
            "actions": [{"id": "send", "label": "Send", "applies_to": ["k"], "confirm": True},
                        {"id": "plain", "label": "Plain", "applies_to": ["k"], "confirm": False},
                        {"id": "bare", "label": "Bare", "applies_to": ["k"]},
                        {"id": "save", "label": "Save", "applies_to": ["k"], "person_activity": True}]}

def view(ctx, focus, stage):
    return {"revision": "r1", "items": [{"id": "i1", "kind": "k", "label": "i"}]}

def act(ctx, action, items, params):
    GOT.append((action, dict(params), dict(ctx.command or {}), (ctx.actor or {}).get("recovery")))
    return {"status": "done", "detail": {"n": len(GOT)}}
"""


def payload_of(body):
    """The documented payload (§9d): the normalized items, params and base_revision, plus the file's
    {name, mime, size, sha256} when one is sent."""
    payload = {"items": body.get("items") or [], "params": body.get("params") or {}, "base_revision": body.get("base_revision")}
    if body.get("file"):
        f, data = body["file"], base64.b64decode(body["file"]["content_base64"])
        payload["file"] = {"name": f["name"], "mime": f["mime"], "size": f["size"], "sha256": "sha256:" + hashlib.sha256(data).hexdigest()}
    return payload


def payload_digest(body):
    """sha256 of canonical JSON (sorted keys, no spaces, UTF-8 as is) of payload_of(body)."""
    payload = payload_of(body)
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def mint(client, headers, program, body, **over):
    req = {"swarm_id": body["swarm_id"], "action": body["action"], "payload": payload_of(body),
           "payload_digest": payload_digest(body), **over}
    return client.post(f"/api/programs/{program}/confirm", headers=headers, json=req)


def confirmed(client, headers, program, body):
    """The body with a fresh confirm token, as the host sends it after the person confirms."""
    r = mint(client, headers, program, body)
    assert r.status_code == 200, r.text
    return dict(body, confirm_token=r.json()["confirm_token"])


def mount(client, tmp_path, monkeypatch, source=APP, pid="confirmer"):
    folder = tmp_path / pid
    folder.mkdir(parents=True)
    (folder / "plugin.json").write_text(json.dumps({"id": pid, "name": pid, "capabilities": []}))
    (folder / "program.py").write_text(source)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload").raise_for_status()
    sw = client.post("/api/swarms", json={"name": "Confirm", "visibility": "public"}).json()["id"]
    return sw, client.app.state.hive.programs.programs[pid]


def code(r):
    return r.status_code, (r.json().get("error") or {}).get("code")


def test_confirm_is_validated_at_load(client, tmp_path, monkeypatch):
    for bad, needle in (('"confirm": "yes"', "confirm is true or false"), ('"confirm": None', "confirm is true or false"),
                        ('"confirm": False, "person_activity": True', "always confirmed")):
        source = APP.replace('"confirm": True}', bad + "}")
        _, entry = mount(client, tmp_path / bad.replace('"', "").replace(":", "").replace(",", "").replace(" ", "_"), monkeypatch, source)
        assert needle in (entry["error"] or ""), (bad, entry["error"])


def test_the_effective_confirm_reaches_the_browser_on_describe(client, tmp_path, monkeypatch):
    mount(client, tmp_path, monkeypatch)
    actions = {a["id"]: a["confirm"] for a in client.get("/api/programs/confirmer").json()["describe"]["actions"]}
    assert actions == {"send": True, "plain": False, "bare": False, "save": True}


def test_a_confirm_action_needs_a_token_and_a_valid_one_works_once(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    quinn = person(client, "u_quinn", "member")
    body = {"swarm_id": sw, "action": "send", "items": ["i1"], "params": {"to": "Zoë"}}
    act = lambda b, who=quinn: client.post("/api/programs/confirmer/act", headers=who, json=b)
    assert code(act(body)) == (403, "confirm_required")
    good = confirmed(client, quinn, "confirmer", body)
    assert act(good).status_code == 200
    assert code(act(good)) == (403, "confirm_invalid")                        # single use
    got = entry["module"].GOT
    assert len(got) == 1 and "confirm_token" not in json.dumps(got)           # the app never sees the token


def test_a_token_binds_action_payload_person_session_and_time(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    quinn, ann = person(client, "u_quinn", "member"), person(client, "u_ann", "member")
    hive = client.app.state.hive
    quinn2 = {"Authorization": "Bearer second"}                                 # Quinn in a second session
    from hive.core.hive import token_hash
    from hive.core.db import now
    hive.db.insert("sessions", {"token_hash": token_hash("second"), "created_at": now(), "kind": "sso", "principal": "user:u_quinn"})
    body = {"swarm_id": sw, "action": "send", "items": ["i1"], "params": {"n": 1}}
    act = lambda b, who=quinn: client.post("/api/programs/confirmer/act", headers=who, json=b)
    tok = lambda: confirmed(client, quinn, "confirmer", body)["confirm_token"]
    assert code(act(dict(body, action="save", idempotency_key="k1", confirm_token=tok()))) == (403, "confirm_invalid")
    assert code(act(dict(body, params={"n": 2}, confirm_token=tok()))) == (403, "confirm_invalid")
    assert code(act(dict(body, items=[], confirm_token=tok()))) == (403, "confirm_invalid")
    assert code(act(dict(body, base_revision="r0", confirm_token=tok()))) == (403, "confirm_invalid")
    assert code(act(dict(body, confirm_token=tok()), who=ann)) == (403, "confirm_invalid")
    assert code(act(dict(body, confirm_token=tok()), who=quinn2)) == (403, "confirm_invalid")
    other = client.post("/api/swarms", json={"name": "Other", "visibility": "public"}).json()["id"]
    assert code(act(dict(body, swarm_id=other, confirm_token=tok()))) == (403, "confirm_invalid")
    assert code(act(dict(body, confirm_token="hct_made-up"))) == (403, "confirm_invalid")
    expired = tok()
    hive.db.execute("UPDATE confirm_tokens SET expires_at = expires_at - 121")
    assert code(act(dict(body, confirm_token=expired))) == (403, "confirm_invalid")
    assert entry["module"].GOT == []
    assert act(dict(body, confirm_token=tok())).status_code == 200            # the same act, properly confirmed


def test_actions_without_confirm_need_no_token(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    for action in ("plain", "bare"):
        r = client.post("/api/programs/confirmer/act", json={"swarm_id": sw, "action": action, "items": ["i1"], "params": {}})
        assert r.status_code == 200, r.text
    assert code(mint(client, {}, "confirmer", {"swarm_id": sw, "action": "plain"})) == (400, "confirm_not_needed")


def test_person_activity_is_always_confirmed_and_a_retry_of_the_same_intent_may_reuse_its_token(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    quinn = person(client, "u_quinn", "member")
    act = lambda b: client.post("/api/programs/confirmer/act", headers=quinn, json=b)
    body = {"swarm_id": sw, "action": "save", "items": ["i1"], "params": {"t": "x"}, "idempotency_key": "intent-1"}
    assert code(act(body)) == (403, "confirm_required")
    good = confirmed(client, quinn, "confirmer", body)
    assert act(good).status_code == 200
    again = act(good)                                                         # the answer was lost; the host retries
    assert again.status_code == 200 and entry["module"].GOT[-1][3] is True   # a recovery: no second effect
    assert code(act(dict(good, idempotency_key="intent-2"))) == (403, "confirm_invalid")   # never another intent
    assert len(entry["module"].GOT) == 2


def test_only_a_person_session_mints(client, tmp_path, monkeypatch):
    sw, _ = mount(client, tmp_path, monkeypatch)
    _, (mind, _b) = make_swarm_and_agents(client)
    body = {"swarm_id": sw, "action": "send", "items": [], "params": {}}
    assert mint(client, agent_headers(mind), "confirmer", body).status_code == 401
    assert mint(client, {"Authorization": "Bearer nobody"}, "confirmer", body).status_code == 401
    # person_activity needs a named person, as on the act route: the local operator password cannot mint for it
    assert code(mint(client, {}, "confirmer", dict(body, action="save"))) == (403, "person_required")
    assert code(mint(client, {}, "confirmer", body, payload_digest="sha256:XYZ")) == (400, "bad_request")
    assert code(mint(client, {}, "confirmer", body, extra=1)) == (400, "bad_request")
    assert code(mint(client, {}, "confirmer", dict(body, action="nope"))) == (400, "bad_request")
    r = mint(client, {}, "confirmer", body)
    assert r.status_code == 200 and set(r.json()) == {"confirm_token", "expires_at", "expires_in"}
    assert r.json()["confirm_token"].startswith("hct_") and r.json()["expires_in"] == 120
    stored = json.dumps([dict(x) for x in client.app.state.hive.db.all("SELECT * FROM confirm_tokens")])
    assert r.json()["confirm_token"] not in stored                            # the hive keeps only its hash


def test_a_private_swarm_is_not_mintable_by_who_cannot_see_it(client, tmp_path, monkeypatch):
    _, _ = mount(client, tmp_path, monkeypatch)
    ann, bob = person(client, "u_ann", "member"), person(client, "u_bob", "member")
    private = client.post("/api/swarms", headers=ann, json={"name": "Ann's"}).json()["id"]
    body = {"swarm_id": private, "action": "send", "items": [], "params": {}}
    assert mint(client, ann, "confirmer", body).status_code == 200
    assert mint(client, bob, "confirmer", body).status_code == 404               # existence is not revealed


VECTORS = json.loads((__import__("pathlib").Path(__file__).parent / "fixtures" / "confirm_digest_vectors.json").read_text("utf-8"))


def test_the_shared_digest_vectors_hold_and_the_refused_values_are_refused():
    """Surface asserts the same file in JS: one canonical form on both sides, or no token at all."""
    from hive.core.program_actions import confirmable, digest
    assert len(VECTORS["vectors"]) >= 11 and len(VECTORS["refused"]) >= 9
    canon = "\n".join(v["canonical"] for v in VECTORS["vectors"])
    for escaped in ('"\\b\\f"', '"a\\"b\\\\c"', '"\\u0007"', '"\\u001f"'):   # Kimi r2 #1: shorthands and lowercase \u00xx
        assert escaped in canon, escaped
    for v in VECTORS["vectors"]:
        assert confirmable(v["payload"]), v["name"]
        assert json.dumps(v["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=False) == v["canonical"], v["name"]
        assert digest(v["payload"]) == v["digest"], v["name"]
    for v in VECTORS["refused"]:
        assert not confirmable(json.loads(v["payload_json"])), v["name"]


def test_mint_and_act_refuse_values_outside_the_digest_domain(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    hdr = {"content-type": "application/json"}
    for v in VECTORS["refused"]:
        req = '{"swarm_id":"%s","action":"send","payload":%s,"payload_digest":"sha256:%s"}' % (sw, v["payload_json"], "0" * 64)
        r = client.post("/api/programs/confirmer/confirm", headers=hdr, content=req.encode())
        assert code(r) == (400, "confirm_unsupported_value"), (v["name"], r.text)
        act = '{"swarm_id":"%s","action":"send","items":[],"params":%s,"confirm_token":"hct_x"}' % (
            sw, json.dumps(json.loads(v["payload_json"])["params"]) if "NaN" not in v["payload_json"] and "Infinity" not in v["payload_json"]
            else v["payload_json"].split('"params":')[1].rsplit(',"base_revision"', 1)[0])
        r = client.post("/api/programs/confirmer/act", headers=hdr, content=act.encode())
        assert code(r) == (400, "confirm_unsupported_value"), (v["name"], r.text)
    assert entry["module"].GOT == []
    # an action without confirm is unaffected: decimals still reach the app there
    assert client.post("/api/programs/confirmer/act", json={"swarm_id": sw, "action": "plain", "items": [], "params": {"x": 1.5}}).status_code == 200


def test_mint_refuses_a_digest_the_hive_does_not_compute(client, tmp_path, monkeypatch):
    sw, _ = mount(client, tmp_path, monkeypatch)
    body = {"swarm_id": sw, "action": "send", "items": ["i1"], "params": {"a": 1}}
    assert code(mint(client, {}, "confirmer", body, payload_digest="sha256:" + "0" * 64)) == (400, "confirm_digest_mismatch")
    assert code(mint(client, {}, "confirmer", body, payload={"items": [], "params": {}})) == (400, "confirm_digest_mismatch")
    assert code(mint(client, {}, "confirmer", body, payload=[])) == (400, "bad_request")
    assert code(mint(client, {}, "confirmer", body, payload={**payload_of(body), "extra": 1})) == (400, "bad_request")


FAILS_AFTER_EFFECT = APP.replace('return {"status": "done", "detail": {"n": len(GOT)}}', 'raise RuntimeError("lost answer after effect")')


def test_a_failed_intent_is_never_rerun_under_its_spent_token(client, tmp_path, monkeypatch):
    """Review B1 (d556a5b): effect, then an exception, then the identical retry with the spent token, before and after
    expiry: no second delivery. Another attempt needs a fresh confirm from the person."""
    sw, entry = mount(client, tmp_path, monkeypatch, FAILS_AFTER_EFFECT)
    quinn = person(client, "u_quinn", "member")
    act = lambda b: client.post("/api/programs/confirmer/act", headers=quinn, json=b)
    body = {"swarm_id": sw, "action": "save", "items": ["i1"], "params": {}, "idempotency_key": "same-intent"}
    good = confirmed(client, quinn, "confirmer", body)
    assert act(good).status_code == 500 and len(entry["module"].GOT) == 1
    assert client.app.state.hive.db.one("SELECT status FROM program_actions WHERE idempotency_key = 'same-intent'")["status"] == "failed"
    assert code(act(good)) == (403, "confirm_invalid")                        # before expiry
    client.app.state.hive.db.execute("UPDATE confirm_tokens SET expires_at = expires_at - 121")
    assert code(act(good)) == (403, "confirm_invalid")                        # after expiry
    assert len(entry["module"].GOT) == 1
    assert act(confirmed(client, quinn, "confirmer", body)).status_code == 500  # a new explicit confirm may try again
    assert len(entry["module"].GOT) == 2 and entry["module"].GOT[-1][3] is not True


def test_the_review_probe_scenario(client, tmp_path, monkeypatch):
    """Review's probe (receipts-local/omegareview-confirm-d556a5b/review-probe.py), verbatim in effect."""
    sw, entry = mount(client, tmp_path, monkeypatch, FAILS_AFTER_EFFECT)
    who = person(client, "u_quinn", "member")
    good = confirmed(client, who, "confirmer", {"swarm_id": sw, "action": "save", "items": ["i1"], "params": {}, "idempotency_key": "same-intent"})
    assert client.post("/api/programs/confirmer/act", headers=who, json=good).status_code == 500
    client.app.state.hive.db.execute("UPDATE confirm_tokens SET expires_at = expires_at - 121")
    client.post("/api/programs/confirmer/act", headers=who, json=good)
    assert len(entry["module"].GOT) == 1


def test_a_done_intent_recovers_under_its_spent_token_even_after_expiry_and_nothing_else_does(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    quinn = person(client, "u_quinn", "member")
    act = lambda b: client.post("/api/programs/confirmer/act", headers=quinn, json=b)
    body = {"swarm_id": sw, "action": "save", "items": ["i1"], "params": {"t": 1}, "idempotency_key": "k-done"}
    good = confirmed(client, quinn, "confirmer", body)
    first = act(good)
    assert first.status_code == 200
    client.app.state.hive.db.execute("UPDATE confirm_tokens SET expires_at = expires_at - 121")
    again = act(good)                                                         # lost response, retried late
    assert again.status_code == 200 and entry["module"].GOT[-1][3] is True      # a recovery: the app returns its record
    assert code(act(dict(good, idempotency_key="k-other"))) == (403, "confirm_invalid")          # changed key
    assert code(act(dict(good, params={"t": 2}))) == (409, "idempotency_conflict")                # changed binding, same key
    assert code(act(dict(good, idempotency_key="k-other", params={"t": 2}))) == (403, "confirm_invalid")
    assert [g[3] for g in entry["module"].GOT] == [None, True]                # one effect, one recovery


def test_concurrent_presentations_of_one_token_spend_it_once(client, tmp_path, monkeypatch):
    import threading
    sw, _ = mount(client, tmp_path, monkeypatch)
    quinn = person(client, "u_quinn", "member")
    hive = client.app.state.hive
    body = {"swarm_id": sw, "action": "send", "items": [], "params": {}}
    token = confirmed(client, quinn, "confirmer", body)["confirm_token"]
    session = hive.db.one("SELECT token_hash FROM sessions WHERE principal = 'user:u_quinn'")["token_hash"]
    actor = {"principal": "user:u_quinn"}
    wins, gate = [], threading.Barrier(8)

    def go(i):
        gate.wait()
        try:
            hive.program_actions._take_confirm(actor, session, "confirmer", sw, "send", payload_of(body), token, intent=f"pa_{i}")
            wins.append(i)
        except Exception as exc:
            assert getattr(exc, "code", None) == "confirm_invalid" or "confirm_invalid" in str(exc)
    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(wins) == 1


def test_mint_normalizes_the_payload_exactly_as_the_act_does(client, tmp_path, monkeypatch):
    """Kimi r2 #3: a host that sends null or leaves a field out digests the normalized form, and the act redeems it."""
    sw, entry = mount(client, tmp_path, monkeypatch)
    normalized = {"items": [], "params": {}, "base_revision": None}
    want = "sha256:" + hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    for raw in ({"items": None, "params": None, "base_revision": None, "file": None}, {}, {"params": None}):
        r = client.post("/api/programs/confirmer/confirm", json={"swarm_id": sw, "action": "send", "payload": raw, "payload_digest": want})
        assert r.status_code == 200, (raw, r.text)
        act = client.post("/api/programs/confirmer/act", json={"swarm_id": sw, "action": "send", "items": None, "params": None,
                                                               "confirm_token": r.json()["confirm_token"]})
        assert act.status_code == 200, (raw, act.text)
    assert len(entry["module"].GOT) == 3


def test_one_size_limit_for_a_confirmed_payload_at_mint_and_at_act(client, tmp_path, monkeypatch):
    """Kimi r2 #2: 2 MB canonical at both routes, so no token is minted for an act the act route would refuse."""
    from hive.core.program_actions import CONFIRM_MAX_BYTES
    sw, entry = mount(client, tmp_path, monkeypatch)
    overhead = len('{"base_revision":null,"items":[],"params":{"s":""}}')
    fits = {"swarm_id": sw, "action": "send", "items": [], "params": {"s": "x" * (CONFIRM_MAX_BYTES - overhead)}}
    over = dict(fits, params={"s": "x" * (CONFIRM_MAX_BYTES - overhead + 1)})
    assert code(mint(client, {}, "confirmer", over)) == (413, "confirm_payload_too_large")
    assert code(client.post("/api/programs/confirmer/act", json=dict(over, confirm_token="hct_x"))) == (413, "confirm_payload_too_large")
    assert client.post("/api/programs/confirmer/act", json=confirmed(client, {}, "confirmer", fits)).status_code == 200
    assert len(entry["module"].GOT) == 1
    # actions without confirm keep the act route's own cap
    assert client.post("/api/programs/confirmer/act", json=dict(over, action="plain")).status_code == 200


def test_a_rerun_after_failure_tells_the_program_the_prior_try_failed(client, tmp_path, monkeypatch):
    """Kimi r2 #4: ctx.command.prior_failed only on the re-delivery of a failed intent under a fresh confirm."""
    sw, entry = mount(client, tmp_path, monkeypatch, FAILS_AFTER_EFFECT)
    quinn = person(client, "u_quinn", "member")
    body = {"swarm_id": sw, "action": "save", "items": ["i1"], "params": {}, "idempotency_key": "pf"}
    client.post("/api/programs/confirmer/act", headers=quinn, json=confirmed(client, quinn, "confirmer", body))
    client.post("/api/programs/confirmer/act", headers=quinn, json=confirmed(client, quinn, "confirmer", body))
    (_, _, first, _), (_, _, second, _) = entry["module"].GOT
    assert "prior_failed" not in first and second["prior_failed"] is True and second["record_id"] == first["record_id"]


def test_a_recovery_never_says_prior_failed(client, tmp_path, monkeypatch):
    sw, entry = mount(client, tmp_path, monkeypatch)
    quinn = person(client, "u_quinn", "member")
    good = confirmed(client, quinn, "confirmer", {"swarm_id": sw, "action": "save", "items": ["i1"], "params": {}, "idempotency_key": "rc"})
    client.post("/api/programs/confirmer/act", headers=quinn, json=good)
    client.post("/api/programs/confirmer/act", headers=quinn, json=good)
    assert [("prior_failed" in g[2], g[3]) for g in entry["module"].GOT] == [(False, None), (False, True)]
