"""r16 (module-state viewers): an app view or read that names a mind is refused as not found unless the person may see
that mind (R13); the app is never called with a mind the person cannot see, and unknown ids look the same."""
import json
import textwrap

from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_visibility import person

PROGRAM = textwrap.dedent('''
    CALLS = []

    def describe():
        return {"contract": "0.2", "kinds": [{"id": "m", "label": "M", "role": "claim"}], "relations": [],
                "actions": [{"id": "note", "label": "Note", "applies_to": ["m"]},
                            {"id": "send", "label": "Send", "applies_to": ["m"], "confirm": True}],
                "reads": [{"id": "state", "label": "State"}, {"id": "minds", "label": "Minds"},
                          {"id": "lookup", "label": "Lookup"}]}

    def view(ctx, focus, stage):
        CALLS.append(("view", focus))
        return {"revision": "r1", "items": [{"id": "x", "kind": "m", "label": str(focus)}]}

    async def act(ctx, action, items, params):
        CALLS.append(("act", action))
        return {"status": "done"}

    def read(ctx, query, params):
        CALLS.append(("read", query))
        if query == "minds":
            return {"minds": [a["id"] for a in ctx.agents()]}
        if query == "lookup":
            return {"mind": ctx.mind(params.get("id"))}
        return {"items": [{"id": "x", "kind": "m", "label": query}]}
''')


def setup(client, tmp_path, monkeypatch):
    folder = tmp_path / "modules"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "modules", "name": "Modules", "capabilities": ["commons:read"]}))
    (folder / "program.py").write_text(PROGRAM)
    monkeypatch.setenv("HIVE_PLUGIN_DIRS", str(folder))
    client.post("/api/programs/reload")
    ann, bob = person(client, "u_ann"), person(client, "u_bob")
    open_sw = client.post("/api/swarms", headers=ann, json={"name": "Open", "visibility": "public"}).json()
    seen = client.post("/api/agents", headers=ann, json={"name": "Seen", "swarm_id": open_sw["id"], "visibility": "public"}).json()
    hidden = client.post("/api/agents", headers=ann, json={"name": "Hidden", "swarm_id": open_sw["id"]}).json()   # private
    mod = client.app.state.hive.programs._ready("modules")["module"]
    setup.ann = ann
    return open_sw, seen, hidden, bob, mod


def view(client, headers, swarm, focus):
    return client.post("/api/programs/modules/view", headers=headers, json={"swarm_id": swarm["id"], "focus": focus})


def test_a_view_naming_an_unseen_mind_is_not_found_and_the_app_never_runs(client, tmp_path, monkeypatch):
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    mod.CALLS.clear()
    ok = view(client, bob, sw, f"mind:{seen['id']}:temporal")
    assert ok.status_code == 200 and mod.CALLS == [("view", f"mind:{seen['id']}:temporal")]
    for focus in (f"mind:{hidden['id']}:temporal", f"agent:{hidden['id']}", "mind:a_doesnotexist:self",
                  f"mind:{seen['id']}:x mind:{hidden['id']}:x"):
        mod.CALLS.clear()
        r = view(client, bob, sw, focus)
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found" and mod.CALLS == [], focus
    # the same answer for a hidden mind and an unknown one: existence is not revealed
    a = view(client, bob, sw, f"mind:{hidden['id']}:self").json()
    b = view(client, bob, sw, "mind:a_doesnotexist:self").json()
    assert a == b


def test_reads_are_checked_the_same_way(client, tmp_path, monkeypatch):
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    mod.CALLS.clear()
    r = client.post("/api/programs/modules/read", headers=bob, json={"swarm_id": sw["id"], "query": "state",
                                                                    "params": {"focus": f"mind:{hidden['id']}:energy"}})
    assert r.status_code == 404 and mod.CALLS == []


def test_the_owner_and_admins_see_their_minds(client, tmp_path, monkeypatch):
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    ann = person(client, "u_ann2")   # an unrelated member still cannot see Ann's private mind
    assert view(client, ann, sw, f"mind:{hidden['id']}:self").status_code == 404
    assert view(client, client.headers, sw, f"mind:{hidden['id']}:self").status_code == 200   # the operator is an admin


# ---- r16.1: review fixes (stand-in r16 FIX-FIRST #1-#4, Kimi r16 FIX-FIRST #1-#3) ----------------------------------

def read(client, headers, swarm, params, query="state"):
    return client.post("/api/programs/modules/read", headers=headers, json={"swarm_id": swarm["id"], "query": query,
                                                                           "params": params})


def test_a_reference_after_a_control_character_in_params_is_still_checked(client, tmp_path, monkeypatch):
    """stand-in r16 #1: params were scanned as json.dumps text, where a newline became `\\n` and hid the next name."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    h = hidden["id"]
    for params in ({"focus": f"\nmind:{h}:temporal"}, {"focus": f"\tagent:{h}"}, {"focus": f"\rmind:{h}"},
                   {"nested": [{"deep": f"x\nmind:{h}"}]}, {f"\nmind:{h}": 1}):
        mod.CALLS.clear()
        r = read(client, bob, sw, params)
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found" and mod.CALLS == [], params


def spellings(agent_id):
    up = agent_id.upper()
    return [f"mind%3A{agent_id}", f"agent%3a{agent_id}", f"MIND:{agent_id}", f"Mind:{agent_id}", f"mind: {agent_id}",
            f"mind:\t{agent_id}", f"mind :{agent_id}", f"mind:{up}", f"%6Dind:{agent_id}", f"mind:%61{agent_id[1:]}",
            "\\u006dind:" + agent_id, f"mind\uff1a{agent_id}", f"mi\u200bnd:{agent_id}", f"mind&#58;{agent_id}",
            f"mind:+{agent_id}", json.dumps(json.dumps({"focus": f"MIND:{agent_id}"}))]


def test_other_spellings_of_an_unseen_mind_are_not_found_and_the_app_never_runs(client, tmp_path, monkeypatch):
    """stand-in r16 #2, Kimi r16 #2 and #3: percent-encoding, case, space at the colon, escapes, Unicode forms."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    unknown = view(client, bob, sw, "mind:a_00000000").json()
    for focus in spellings(hidden["id"]):
        mod.CALLS.clear()
        r = view(client, bob, sw, focus)
        assert r.status_code == 404 and r.json() == unknown and mod.CALLS == [], focus
        r = read(client, bob, sw, {"focus": focus})
        assert r.status_code == 404 and r.json() == unknown and mod.CALLS == [], focus


def test_a_seen_mind_is_only_handed_to_the_app_in_the_one_supported_spelling(client, tmp_path, monkeypatch):
    """stand-in r16 #2: one canonical parser; another spelling is refused before dispatch, even for a mind one sees."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    for focus in spellings(seen["id"]):
        mod.CALLS.clear()
        r = view(client, bob, sw, focus)
        assert r.status_code == 400 and r.json()["error"]["code"] == "mind_reference_spelling" and mod.CALLS == [], focus
    mod.CALLS.clear()
    assert view(client, bob, sw, f"\nmind:{seen['id']}:temporal").status_code == 200 and mod.CALLS


def test_acts_are_checked_the_same_way(client, tmp_path, monkeypatch):
    """Kimi r16 #1: an act hands the same params to the same app; it was only swarm-checked."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    url = "/api/programs/modules/act"
    for body in ({"action": "note", "items": [], "params": {"focus": f"mind:{hidden['id']}:energy"}},
                 {"action": "note", "items": [f"agent:{hidden['id']}"], "params": {}},
                 {"action": "note", "items": [], "params": {"focus": f"MIND%3A{hidden['id']}"}},
                 {"action": "note", "items": [], "params": {"focus": "mind:a_00000000"}}):
        mod.CALLS.clear()
        r = client.post(url, headers=bob, json={"swarm_id": sw["id"], **body})
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found" and mod.CALLS == [], body
    mod.CALLS.clear()
    ok = client.post(url, headers=bob, json={"swarm_id": sw["id"], "action": "note", "items": [],
                                             "params": {"focus": f"mind:{seen['id']}"}})
    assert ok.status_code == 200 and mod.CALLS == [("act", "note")], ok.text


def test_confirms_are_checked_the_same_way(client, tmp_path, monkeypatch):
    """Kimi r16 #1: no confirm token is minted for an act that names a mind the person cannot see."""
    from hive.tests.test_program_confirm import payload_digest, payload_of
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    body = {"swarm_id": sw["id"], "action": "send", "items": [], "params": {"focus": f"mind:{hidden['id']}:self"}}
    r = client.post("/api/programs/modules/confirm", headers=bob, json={
        "swarm_id": sw["id"], "action": "send", "payload": payload_of(body), "payload_digest": payload_digest(body)})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", r.text
    body["params"] = {"focus": f"mind:{seen['id']}:self"}
    r = client.post("/api/programs/modules/confirm", headers=bob, json={
        "swarm_id": sw["id"], "action": "send", "payload": payload_of(body), "payload_digest": payload_digest(body)})
    assert r.status_code == 200, r.text


def test_apps_resolve_minds_only_within_what_the_person_sees(client, tmp_path, monkeypatch):
    """stand-in r16 #3: the prefix scan alone is convention; the app's own mind reads (ctx.agents, ctx.mind) apply the
    person's visibility, so a bare id or any other form an app resolves still cannot reach an unseen mind."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    ann = setup.ann
    assert read(client, bob, sw, {}, "minds").json()["result"]["minds"] == [seen["id"]]
    assert sorted(read(client, ann, sw, {}, "minds").json()["result"]["minds"]) == sorted([seen["id"], hidden["id"]])
    assert read(client, bob, sw, {"id": seen["id"]}, "lookup").json()["result"]["mind"]["id"] == seen["id"]
    hid = read(client, bob, sw, {"id": hidden["id"]}, "lookup")
    nope = read(client, bob, sw, {"id": "a_00000000"}, "lookup")
    assert hid.status_code == nope.status_code == 404 and hid.json() == nope.json()
    assert read(client, ann, sw, {"id": hidden["id"]}, "lookup").json()["result"]["mind"]["id"] == hidden["id"]


def test_owner_success_and_admin_unknown_or_deleted(client, tmp_path, monkeypatch):
    """stand-in r16 #4: coverage for the owner's own private mind and for an admin naming an unknown or deleted mind."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    ann = setup.ann
    mod.CALLS.clear()
    r = view(client, ann, sw, f"mind:{hidden['id']}:self")
    assert r.status_code == 200 and mod.CALLS == [("view", f"mind:{hidden['id']}:self")]
    gone = client.post("/api/agents", headers=ann, json={"name": "Gone", "swarm_id": sw["id"]}).json()
    assert client.delete(f"/api/agents/{gone['id']}", headers=ann).status_code in (200, 204)
    admin = client.headers
    unknown = view(client, admin, sw, "mind:a_00000000:self")
    for focus in ("mind:a_00000000:self", f"mind:{gone['id']}:self"):
        mod.CALLS.clear()
        r = view(client, admin, sw, focus)
        assert r.status_code == 404 and r.json() == unknown.json() and mod.CALLS == [], focus
        r = read(client, admin, sw, {"focus": focus})
        assert r.status_code == 404 and mod.CALLS == [], focus
    assert view(client, bob, sw, f"mind:{gone['id']}:self").json() == view(client, bob, sw, f"mind:{hidden['id']}:self").json()


# ---- r16.1 round 2: one bounded scan budget that fails closed (stand-in r16.1 FIX-FIRST #1, #2) -------------------

def layered(text, n):
    """``text`` percent-encoded ``n`` times, as urllib.parse.quote(safe="") would (the stand-in's reproduction: 60)."""
    for _ in range(n):
        text = text.replace("%", "%25").replace(":", "%3A")
    return text


def amplifier():
    """The stand-in's 104-character reproduction: mixed encodings, three times JSON-wrapped."""
    s = "a_%2525252525252525 &amp;amp;amp;amp;amp;amp; + \\u0061"
    for _ in range(3):
        s = json.dumps({"x": s})
    return s


def test_a_reference_encoded_many_times_is_checked_or_refused_never_passed_on(client, tmp_path, monkeypatch):
    """stand-in r16.1 #2: running out of decoding budget returned nothing found, and the app got the request."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    import urllib.parse
    assert layered("mind:a_deadbeef", 3) == urllib.parse.quote(urllib.parse.quote(urllib.parse.quote("mind:a_deadbeef", safe=""), safe=""), safe="")
    unknown = view(client, bob, sw, "mind:a_00000000").json()
    mod.CALLS.clear()
    r = view(client, bob, sw, layered(f"mind:{hidden['id']}", 60))
    assert r.status_code == 404 and r.json() == unknown and mod.CALLS == []
    for agent in (hidden, seen):
        for n in (400, 3000):
            for send in (lambda f: view(client, bob, sw, f), lambda f: read(client, bob, sw, {"focus": f})):
                mod.CALLS.clear()
                r = send(layered(f"mind:{agent['id']}", n))
                assert r.status_code in (400, 404) and mod.CALLS == [], (agent["name"], n, r.text)
                if r.status_code == 400:
                    assert r.json()["error"]["code"] == "mind_reference_unresolved"


def _timed(fn, limit=2.0):
    import threading
    import time
    out = {}

    def run():
        t = time.perf_counter()
        out["value"] = fn()
        out["seconds"] = time.perf_counter() - t
    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(limit)
    assert "seconds" in out, f"the scan was still running after {limit} s"
    return out["value"], out["seconds"]


def test_no_input_amplifies_the_scan(client, tmp_path, monkeypatch):
    """stand-in r16.1 #1: one request-wide budget; the worst cases finish in under 50 ms and refuse before dispatch."""
    from hive.core.visibility import mind_refs
    for case in (amplifier(), layered("mind:a_deadbeef", 60), layered("mind:a_deadbeef", 3000),
                 [amplifier()] * 50, {amplifier(): amplifier()}):
        _, seconds = _timed(lambda: mind_refs(case))
        best = min([seconds] + [_timed(lambda: mind_refs(case))[1] for _ in range(2)])
        assert best < 0.05, (str(case)[:60], best)
    assert mind_refs(amplifier())[2] is True
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    mod.CALLS.clear()
    r = read(client, bob, sw, {"x": amplifier()})
    assert r.status_code == 400 and r.json()["error"]["code"] == "mind_reference_unresolved" and mod.CALLS == []


def test_ordinary_inputs_are_unaffected(client, tmp_path, monkeypatch):
    """The bounded scan refuses nothing ordinary: text with %, &, + and backslashes, JSON text, many strings, big text."""
    sw, seen, hidden, bob, mod = setup(client, tmp_path, monkeypatch)
    for focus in ("AT&T; mind map", "50% of agents", "Tom & Jerry + friends", "C:\\new\\agent", "q=a_b%20c&r=1",
                  "mind map &copy; 2026", json.dumps({"t": "R&D", "n": "a_x"}), f"mind:{seen['id']}:temporal"):
        mod.CALLS.clear()
        r = view(client, bob, sw, focus)
        assert r.status_code == 200 and mod.CALLS == [("view", focus)], (focus, r.text)
    mod.CALLS.clear()
    many = {"titles": ["Tom & Jerry + friends 50%"] * 2000, "body": "word 5% & more + " * 20000}
    r = read(client, bob, sw, many)
    assert r.status_code == 200 and mod.CALLS == [("read", "state")], r.text
