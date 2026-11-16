"""Purpose: a mind's word to its person's stage (hive/core/stage.py, POST /api/agent/stage): a Show, Recall or Compare
reaches only the person the mind's Ask turn answers, or whose own chat with it the mind is answering, as one frame
naming each item with its kind, never another member, an admin or the operator; people waiting in two chats see
nothing; each item must be one that person may see; a turn answering nobody is refused with its reason; a page whose socket dropped reads what it missed; and where the conductor answers the Ask, the mind it speaks
as says the same through its tools, by the same rule, finding a creation the page lists by its title, or from any page
by the title the person gave it, two or more with that title named back and none shown. INVENTED people, minds and
titles."""
from hive.core import policy
from hive.tests.test_ask import ask, drain, token_of, world
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)


def _art(w, kind="image", title="Harbour at dusk"):
    return w["hive"].collab.create_artifact(w["hive"].db.one("SELECT * FROM agents WHERE id = ?", (w["coord"]["id"],)),
                                            {"kind": kind, "title": title})["id"]


def _say(client, w, say, *items):
    return client.post("/api/agent/stage", headers=agent_headers(w["coord"]), json={"say": say, "items": list(items)})


def _socket(client, w, who):
    return client.websocket_connect(f"/api/events?token={token_of(w[who]) if who != 'op' else client.operator_token}")


def _stage_frames(frames):
    return [f for f in frames if f.get("type") == "stage.said"]


def test_a_minds_show_reaches_only_the_person_it_is_answering(client):
    w = world(client)
    photo = _art(w)
    ask(client, w["ann"], "op-stage-show-01", context={"swarm_id": w["swarm"]["id"]})
    with _socket(client, w, "ann") as ann_ws, _socket(client, w, "jon") as jon_ws, _socket(client, w, "bob") as bob_ws, \
            _socket(client, w, "op") as op_ws:
        for ws in (ann_ws, jon_ws, bob_ws, op_ws):
            assert ws.receive_json()["type"] == "hello"
        r = _say(client, w, "show", photo)
        assert r.status_code == 200, r.text
        assert r.json()["said"] == "show" and r.json()["items"] == [photo]
        ann, jon, bob, op = (_stage_frames(drain(ws)) for ws in (ann_ws, jon_ws, bob_ws, op_ws))
    # one frame, naming the item with its kind, so the page arranges it in that event
    assert len(ann) == 1
    assert ann[0]["say"] == "show" and ann[0]["agent_id"] == w["coord"]["id"]
    assert ann[0]["items"] == [{"key": photo, "source": "artifact", "stored": "image"}]
    # an admin, another member and the operator never see it
    assert jon == [] and bob == [] and op == []


def test_where_the_conductor_answers_the_ask_the_mind_it_speaks_as_shows_its_asker_alone(client, monkeypatch):
    # a default hive's Ask is the conductor's (conductor.py): its show, recall and compare are the stage's one rule
    from hive.tests.test_ask_conductor import Script, call, closed, script, tool_results, wait
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    hive = w["hive"]
    photo, words = _art(w), _art(w, "note", "What I wrote about it")
    hidden = client.post("/api/swarms", json={"name": "Private"}).json()
    other = client.post("/api/agents", json={"name": "Elsewhere", "swarm_id": hidden["id"]}).json()
    unseen = hive.collab.create_artifact(hive.db.one("SELECT * FROM agents WHERE id = ?", (other["id"],)),
                                         {"kind": "image", "title": "Not hers"})["id"]
    s = script(client, Script([call("show", item=photo), call("compare", this=photo, that=unseen), call("recall", item=words, also=photo)],
                              [call("compare", this=photo, that=words)], "Here they are, one over the other."))
    with _socket(client, w, "ann") as ann_ws, _socket(client, w, "jon") as jon_ws, _socket(client, w, "bob") as bob_ws:
        for ws in (ann_ws, jon_ws, bob_ws):
            assert ws.receive_json()["type"] == "hello"
        assert ask(client, w["ann"], "op-stage-cond-01", context={"swarm_id": w["swarm"]["id"]}).status_code == 202
        wait(hive, "op-stage-cond-01", closed)
        ann, jon, bob = (_stage_frames(drain(ws)) for ws in (ann_ws, jon_ws, bob_ws))
    # the statements are the mind's whose voice answers her, each one frame to her alone
    speaker = hive.personal.speaker("user:u_ann", hive.db.one("SELECT * FROM agents WHERE id = ?", (w["coord"]["id"],)), True)
    assert [(f["say"], [i["key"] for i in f["items"]], f["agent_id"]) for f in ann] == \
        [("show", [photo], speaker["id"]), ("compare", [photo, words], speaker["id"])]
    assert jon == [] and bob == []
    # the model hears what was said, an item she cannot see as not there, and a malformed call as invalid
    results = tool_results(s.bodies[2])
    assert [r["ok"] for r in results] == [True, False, False, True]
    assert results[0]["items"] == [photo] and results[1]["reason"] == "not_found" and results[2] == {"ok": False, "reason": "invalid"}
    assert {"show", "recall", "compare"} <= {t["function"]["name"] for t in s.bodies[0]["tools"]}


def test_the_ask_on_the_artifacts_page_finds_a_creation_by_its_title_and_shows_it(client, monkeypatch):
    # on v0.31, asked "Show me the picture called Harbour at dusk." on the Artifacts page, the conductor answered that
    # the page listed no creations; the page now lists each by id, and the hive names each from its own data
    import json
    from hive.tests.test_ask_conductor import Script, call, closed, script, wait
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    hive = w["hive"]
    photo, plan = _art(w), _art(w, "plan", "Walk by the river")
    hidden = client.post("/api/swarms", json={"name": "Private"}).json()
    other = client.post("/api/agents", json={"name": "Elsewhere", "swarm_id": hidden["id"]}).json()
    unseen = hive.collab.create_artifact(hive.db.one("SELECT * FROM agents WHERE id = ?", (other["id"],)),
                                         {"kind": "image", "title": "Not hers"})["id"]
    s = script(client, Script([call("show", item=photo)], "It is on your screen."))
    view = {"refs": [{"kind": "artifact", "ref": key} for key in (photo, plan, unseen)]}
    with _socket(client, w, "ann") as ann_ws:
        assert ann_ws.receive_json()["type"] == "hello"
        assert ask(client, w["ann"], "op-stage-title-01", text="Show me the picture called Harbour at dusk.",
                   context={"swarm_id": w["swarm"]["id"], "route": "artifacts", "view": view}).status_code == 202
        wait(hive, "op-stage-title-01", closed)
        ann = _stage_frames(drain(ann_ws))
    # the model reads each creation the page lists by its title and id, and nothing she cannot see
    first = json.dumps(s.bodies[0])
    assert all(word in first for word in ("Harbour at dusk", photo, "Walk by the river", plan))
    assert "Not hers" not in first and unseen not in first
    assert [(f["say"], [i["key"] for i in f["items"]]) for f in ann] == [("show", [photo])]


def _ask_from_home(client, w, op, steps):
    """One Ask turn from the home page, whose view lists no creation, with the conductor's model scripted: the stage
    frames Ann's page got, and the tool results the model was given after each call."""
    from hive.tests.test_ask_conductor import Script, closed, script, tool_results, wait
    s = script(client, Script(*steps))
    with _socket(client, w, "ann") as ann_ws:
        assert ann_ws.receive_json()["type"] == "hello"
        assert ask(client, w["ann"], op, text="Show me the picture called Harbour at dusk.",
                   context={"swarm_id": w["swarm"]["id"]}).status_code == 202
        wait(w["hive"], op, closed)
        frames = _stage_frames(drain(ann_ws))
    return [(f["say"], [i["key"] for i in f["items"]]) for f in frames], [tool_results(b)[-1] for b in s.bodies[1:]]


def test_the_ask_shows_a_creation_by_the_title_the_person_gave_from_any_page(client, monkeypatch):
    # on v0.31, asked on the home page to show the picture called Harbour at dusk, the conductor had no id there and
    # went to Files, which holds no creations: its show takes the title the person gave
    from hive.core import conductor as cmod
    from hive.tests.test_ask_conductor import call
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    hive = w["hive"]
    photo, notes = _art(w), _art(w, "note", "Notes on the harbour")
    hidden = client.post("/api/swarms", json={"name": "Private"}).json()
    other = client.post("/api/agents", json={"name": "Elsewhere", "swarm_id": hidden["id"]}).json()
    # one she cannot see with the very same title, never counted, so hers is the one that has it
    hive.collab.create_artifact(hive.db.one("SELECT * FROM agents WHERE id = ?", (other["id"],)),
                                {"kind": "image", "title": "Harbour at dusk"})
    shown, results = _ask_from_home(client, w, "op-stage-anywhere-01", [
        [call("show", item="  harbour AT dusk ")], [call("show", item="harbour")], [call("show", item="Lighthouse")], "Done."])
    assert shown == [("show", [photo])]
    found, several, none = results[:3]
    assert found["ok"] and found["items"] == [photo]
    # no title is "harbour", and two of hers hold it: both named back, and nothing more shown
    assert several["ok"] is False and several["reason"] == "ambiguous" and several["next"] == cmod.TITLE_ASK_NEXT
    assert {(m["id"], m["name"], m["stored"]) for m in several["matches"]} == \
        {(photo, "Harbour at dusk", "image"), (notes, "Notes on the harbour", "note")}
    assert none == {"ok": False, "reason": "not_found", "title": "Lighthouse", "next": cmod.TITLE_NONE_NEXT}
    # the model is told it may give a title
    assert "title" in next(t for t in cmod.tools() if t["function"]["name"] == "show")["function"]["parameters"][
        "properties"]["item"]["description"]


def test_two_creations_with_one_title_are_named_back_and_neither_is_shown(client, monkeypatch):
    # on v0.31 a pick the person never made showed Lighthouse for Harbour at dusk: a title two of her creations share is
    # never taken as one of them, so each is named back with what tells them apart and she is asked which
    from hive.core import conductor as cmod
    from hive.tests.test_ask_conductor import call
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    first, second = _art(w), _art(w, "plan", "Harbour at dusk")
    # made in one sitting, as the three on v0.31 rc4 were: an hour and five minutes apart, on the hive's own clock
    import datetime
    from hive.core.db import stamp_of

    def ago(minutes):
        return stamp_of(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes))
    w["hive"].db.execute("UPDATE artifacts SET created_at = ? WHERE id = ?", (ago(65), first))
    w["hive"].db.execute("UPDATE artifacts SET created_at = ? WHERE id = ?", (ago(5), second))
    shown, results = _ask_from_home(client, w, "op-stage-twice-01", [[call("show", item="Harbour at dusk")],
                                                                     [call("compare", this="Harbour at dusk", that=first)],
                                                                     "Which one do you mean?"])
    assert shown == []
    for r in results[:2]:
        assert r["ok"] is False and r["reason"] == "ambiguous" and r["title"] == "Harbour at dusk"
        # newest first, each told apart by what it is and how long ago it was made
        assert [(m["id"], m["stored"], m["made"]) for m in r["matches"]] == \
            [(second, "plan", "5 minutes ago"), (first, "image", "1 hour ago")]
        assert all(m["name"] == "Harbour at dusk" for m in r["matches"])
        assert r["next"] == cmod.TITLE_ASK_NEXT and "ask the person which one" in r["next"]


def test_how_long_ago_a_creation_was_made_reads_the_same_in_every_zone():
    from hive.core.stage import made_ago
    at = "2026-11-15T16:07:00.000Z"   # 03:07 AEDT on the 16th, when rc4 named three pictures as made on the 15th
    ages = {0: "just now", 59: "just now", 60: "1 minute ago", 119: "1 minute ago", 3599: "59 minutes ago",
            3600: "1 hour ago", 2 * 86400 - 1: "47 hours ago", 2 * 86400: "2 days ago", 30 * 86400: "30 days ago"}
    import datetime
    from hive.core.db import parse_stamp, stamp_of
    for seconds, words in ages.items():
        assert made_ago(stamp_of(parse_stamp(at) - datetime.timedelta(seconds=seconds)), at) == words, seconds
    # one moment written in any zone is one age; a stamp after the clock (clocks apart) is just now; no stamp, no age
    assert made_ago("2026-11-16T01:30:00+11:00", at) == made_ago("2026-11-15T14:30:00Z", at) == "1 hour ago"
    assert made_ago("2026-11-15T16:07:30.000Z", at) == "just now"
    assert made_ago("not a stamp", at) is None and made_ago(None, at) is None


def test_a_title_is_matched_as_a_person_might_say_it_and_only_among_what_they_see(client):
    from hive.core import conductor as cmod
    w = world(client)
    hive = w["hive"]
    photo, notes = _art(w), _art(w, "note", "Notes on the harbour")
    hidden = client.post("/api/swarms", json={"name": "Private"}).json()
    other = client.post("/api/agents", json={"name": "Elsewhere", "swarm_id": hidden["id"]}).json()
    hive.collab.create_artifact(hive.db.one("SELECT * FROM agents WHERE id = ?", (other["id"],)),
                                {"kind": "image", "title": "Lighthouse"})

    def titled(title):
        return [m["id"] for m in hive.stage.titled(title, "user:u_ann")]
    # quotes, width, case and spacing aside, a whole title first; else every title holding it
    assert titled('"Harbour at dusk"') == [photo] == titled("ＨＡＲＢＯＵＲ  at\tdusk")
    assert set(titled("HARBOUR")) == {photo, notes}
    # what she cannot see is never found, and an empty title names nothing
    assert titled("Lighthouse") == [] and titled(" “” ") == []
    # two or more: the newest ten named, the rest counted
    many = cmod.Conductor._title_unresolved("Untitled", [{"id": f"ar_{n}"} for n in range(cmod.TITLE_MATCHES + 3)])
    assert len(many["matches"]) == cmod.TITLE_MATCHES and many["more"] == 3 and many["reason"] == "ambiguous"


# a tip calculator as a mind writes one (modules/hive/catalog.metta's view help): one screen, its parts in order
TIP_VIEW = ('(Screen tip "Tip")\n(Part tip 10 header ((title "Tip") (body "Split the bill")))\n'
            '(Part tip 20 fields ((items ((field number "Bill" bill ((step 0.01)))))))\n(Start bill "")')
# what the model wrote into the note on v0.31 once its hand-over of the build was refused
CODE_ANSWER = "Here's a tip calculator you can use:\n\n```html\n<!doctype html>\n<html><body>Tip</body></html>\n```\n\nEnjoy!"


def _build_turn(client, w, op, steps):
    """One Ask turn from the home page asking to build a tip calculator, the conductor's model scripted: the stage frames
    Ann's page got, the model's tool results after each call, and the answer she was given."""
    from hive.tests.test_ask_conductor import Script, closed, script, tool_results, wait
    s = script(client, Script(*steps))
    with _socket(client, w, "ann") as ann_ws:
        assert ann_ws.receive_json()["type"] == "hello"
        assert ask(client, w["ann"], op, text="Please build a tip calculator app",
                   context={"swarm_id": w["swarm"]["id"]}).status_code == 202
        fs = wait(w["hive"], op, closed)
        frames = _stage_frames(drain(ann_ws))
    answer = [f for f in fs if f["phase"] == "answer" and not f.get("delta")][-1]["text"]
    return [(f["say"], [i["key"] for i in f["items"]]) for f in frames], [tool_results(b)[-1] for b in s.bodies[1:]], answer


def test_the_ask_makes_what_the_person_asks_for_and_shows_it(client, monkeypatch):
    # on v0.31 the Ask bar had no way to make anything: asked to build a tip calculator it handed the build over, was
    # refused and wrote out the app's code; make saves it as the mind's creation, the way the mind's own create does
    from hive.tests.test_ask_conductor import call
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    hive = w["hive"]
    shown, results, answer = _build_turn(client, w, "op-make-01", [
        [call("make", kind="view", title="Tip calculator", body=TIP_VIEW)], "Your tip calculator is on your screen."])
    made = results[0]
    assert made["ok"] and made["shown"] and made["kind"] == "view" and made["title"] == "Tip calculator"
    art = hive.db.one("SELECT * FROM artifacts WHERE id = ?", (made["id"],))
    speaker = hive.personal.speaker("user:u_ann", hive.db.one("SELECT * FROM agents WHERE id = ?", (w["coord"]["id"],)), True)
    # saved as the mind she hears, with its text as revision 1, and on her screen in the same turn
    assert art["kind"] == "view" and art["created_by"] == f"agent:{speaker['id']}"
    assert hive.db.one("SELECT body FROM artifact_revisions WHERE artifact_id = ? AND n = 1", (made["id"],))["body"] == TIP_VIEW
    assert shown == [("show", [made["id"]])]
    assert answer == "Your tip calculator is on your screen."


def test_a_view_that_cannot_be_drawn_is_refused_and_its_code_never_reaches_the_person(client, monkeypatch):
    from hive.core import conductor as cmod
    from hive.tests.test_ask_conductor import call
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    before = w["hive"].db.one("SELECT COUNT(*) AS n FROM artifacts")["n"]
    shown, results, answer = _build_turn(client, w, "op-make-02", [
        [call("make", kind="view", title="Tip calculator", body='(Screen tip "Tip"')], CODE_ANSWER])
    refused = results[0]
    # the hive's own view check says what to fix, nothing is saved, and nothing is shown
    assert refused["ok"] is False and refused["reason"] == "bad_view" and "never closed" in refused["message"]
    assert refused["next"] == cmod.MAKE_REFUSED_NEXT
    assert w["hive"].db.one("SELECT COUNT(*) AS n FROM artifacts")["n"] == before and shown == []
    # the code the model then wrote never reaches her: its words stay, and she is told once why the code is gone
    assert "```" not in answer and "doctype" not in answer
    assert answer == "Here's a tip calculator you can use:\n\nEnjoy!\n\n" + cmod.CODE_KEPT_OUT


def test_a_make_with_no_fields_is_refused_on_a_warning_line_and_the_next_make_shows(client, monkeypatch, caplog):
    # on a v0.31 build with the real model, a make first came with no kind, title or body; only the probe saw it
    import logging
    from hive.core import conductor as cmod
    from hive.tests.test_ask_conductor import call
    caplog.set_level(logging.INFO, logger="hive")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)
    shown, results, answer = _build_turn(client, w, "op-make-04", [
        [call("make")], [call("make", kind="view", title="Tip calculator", body=TIP_VIEW)], "It is on your screen."])
    assert results[0] == {"ok": False, "reason": "invalid", "next": cmod.MAKE_REFUSED_NEXT}
    assert results[1]["ok"] and shown == [("show", [results[1]["id"]])] and answer == "It is on your screen."
    line = next(r for r in caplog.records if "make refused for op-make-04" in r.getMessage())
    assert line.levelname == "WARNING" and line.getMessage().endswith("(invalid); fields []")


def test_a_refused_hand_over_is_said_in_its_kinds_words_and_never_ends_as_code(client, monkeypatch, caplog):
    # Haley's turn on v0.31: the build was handed over as a kind the hive refused with a code that had no words, so she
    # heard the bare fallback, and then the model wrote out about 100 lines of HTML
    import logging
    from hive.core import conductor as cmod
    from hive.core.hive import HiveError
    from hive.tests.test_ask_conductor import call
    caplog.set_level(logging.INFO, logger="hive")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR", "1")
    monkeypatch.setenv("HIVE_ASK_CONDUCTOR_MODEL", "mock/conductor")
    w = world(client)

    class Intents:
        def record(self, viewer, operation_id, body):
            raise HiveError(404, "not_available", "That isn't available.")
    w["hive"].ask.conductor.intents = Intents()
    _shown, results, answer = _build_turn(client, w, "op-make-03", [
        [call("dispatch", kind="studio.session", request={"title": "Tip calculator"})], CODE_ANSWER])
    words = cmod.DISPATCH_REFUSED_SAY["not_available"]
    assert results[0]["reason"] == "not_available" and results[0]["said_to_person"] == words
    assert words != cmod.DISPATCH_REFUSED_FALLBACK and words in answer
    assert "```" not in answer and "doctype" not in answer and answer.endswith(cmod.CODE_KEPT_OUT)
    # one WARNING line, which an install's hive.log keeps, says which kind was refused, with what code, and the fields
    line = next(r for r in caplog.records if "dispatch studio.session refused" in r.getMessage())
    assert line.levelname == "WARNING" and line.getMessage().endswith("(not_available); request fields ['title']")


def test_a_persons_own_mind_shows_them_what_it_made_from_its_own_chat(client, monkeypatch):
    # on v0.31 a person asked their own mind in its own chat, no Ask turn, to make a picture and show it on their screen;
    # the mind's hive-show skill (modules/hive skills.metta) calls hive_commons.stage_show, here through this hive
    import importlib.util
    import pathlib
    from hive.core.hive import token_hash
    spec = importlib.util.spec_from_file_location(
        "hive_commons_stage", pathlib.Path(__file__).resolve().parents[2] / "modules" / "hive" / "src" / "hive_commons.py")
    hc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hc)
    w = world(client)
    hive = w["hive"]
    mine = hive._agent_row(hive.personal.ensure("user:u_ann")["id"])
    hive.db.execute("UPDATE agents SET token_hash = ? WHERE id = ?", (token_hash("tok_annsownmind01"), mine["id"]))
    photo = hive.collab.create_artifact(mine, {"kind": "image", "title": "Harbour at dusk"})["id"]

    def as_her_mind(method, path, payload=None):
        r = client.request(method, path, headers={"Authorization": "Bearer tok_annsownmind01"}, json=payload)
        return (r.json(), None) if r.status_code < 400 else (None, f"HIVE-ERROR {r.json()['error']['code']}: {r.json()['error']['message']}")
    monkeypatch.setattr(hc, "_call", as_her_mind)
    with _socket(client, w, "ann") as ann_ws, _socket(client, w, "jon") as jon_ws, _socket(client, w, "bob") as bob_ws:
        for ws in (ann_ws, jon_ws, bob_ws):
            assert ws.receive_json()["type"] == "hello"
        assert hc.stage_show(photo) == f"HIVE-STAGE show {photo}: on the screen of the person you are answering"
        # something she cannot see comes back as the hive's refusal, never as shown
        assert hc.stage_show("ar_" + "0" * 32).startswith("HIVE-ERROR not_found:")
        ann, jon, bob = (_stage_frames(drain(ws)) for ws in (ann_ws, jon_ws, bob_ws))
    # it reaches her, the one person whose mind it is, and nobody else, an admin included
    assert [(f["say"], [i["key"] for i in f["items"]], f["agent_id"]) for f in ann] == [("show", [photo], mine["id"])]
    assert jon == [] and bob == []


def test_a_team_minds_show_reaches_the_person_whose_own_chat_it_is_answering(client):
    # rc3: a member asked a team swarm's mind in its own chat, no Ask turn, to make a picture and show it, and the stage
    # refused it as answering nobody; the person is found as the mind's hive channel binds a plain reply
    w = world(client)
    hive, cid = w["hive"], w["coord"]["id"]
    photo = _art(w)
    # the mind's current execution began before the chats, as a supervised mind's start records it (Ask.note_boundary)
    assert hive.ask.note_boundary(cid, "stub:started") is not None

    def chat(who, text):
        r = client.post(f"/api/agents/{cid}/messages", headers=w[who], json={"text": text})
        assert r.status_code == 200, r.text

    def answer(who, text="Here it is."):
        hive.record_agent_message(cid, {"text": text, "conversation_id": hive.person_conversation(cid, f"user:u_{who}")})

    def show():
        with _socket(client, w, "ann") as ann_ws, _socket(client, w, "jon") as jon_ws, _socket(client, w, "bob") as bob_ws:
            for ws in (ann_ws, jon_ws, bob_ws):
                assert ws.receive_json()["type"] == "hello"
            r = _say(client, w, "show", photo)
            seen = {who: [f["items"][0]["key"] for f in _stage_frames(drain(ws))] for who, ws in
                    (("ann", ann_ws), ("jon", jon_ws), ("bob", bob_ws))}
        return r, seen

    # Ann's message waits for the mind: its show reaches her alone
    chat("ann", "make me a picture of the harbour and show it to me")
    r, seen = show()
    assert r.status_code == 200, r.text
    assert seen == {"ann": [photo], "jon": [], "bob": []}
    # it answered her first and showed after: her chat is still the one it is answering
    answer("ann")
    r, seen = show()
    assert r.status_code == 200 and seen == {"ann": [photo], "jon": [], "bob": []}
    # Jon (an admin, who sees the swarm) asks too, and Ann asks again: two people wait, so it shows nobody
    chat("jon", "and show me the harbour too")
    chat("ann", "one more please")
    r, seen = show()
    assert r.status_code == 409 and r.json()["error"]["code"] == "no_single_person"
    assert seen == {"ann": [], "jon": [], "bob": []}
    # once it has answered Ann, Jon is the one person waiting
    answer("ann")
    r, seen = show()
    assert r.status_code == 200 and seen == {"ann": [], "jon": [photo], "bob": []}
    # a new execution: the chat it last spoke in before it began is not what it answers now
    answer("jon")
    assert hive.ask.note_boundary(cid, "stub:after-the-chats") is not None
    r = _say(client, w, "show", photo)
    assert r.status_code == 403 and r.json()["error"]["code"] == "no_person"
    assert "own chat" in r.json()["error"]["message"]


def test_with_no_start_record_only_a_waiting_persons_chat_is_answered(client):
    # a mind with no record of when its execution began: the chat it last spoke in may be from before it, so once it
    # has answered nobody is waiting and it shows to nobody, while a person still waiting is the one it answers
    w = world(client)
    hive, cid = w["hive"], w["coord"]["id"]
    photo = _art(w)
    assert hive.db.one("SELECT COUNT(*) AS n FROM ask_boundaries WHERE agent_id = ?", (cid,))["n"] == 0
    assert client.post(f"/api/agents/{cid}/messages", headers=w["ann"], json={"text": "show me the harbour"}).status_code == 200
    r = _say(client, w, "show", photo)
    assert r.status_code == 200 and r.json()["items"] == [photo]
    hive.record_agent_message(cid, {"text": "Here it is.", "conversation_id": hive.person_conversation(cid, "user:u_ann")})
    r = _say(client, w, "show", photo)
    assert r.status_code == 403 and r.json()["error"]["code"] == "no_person"


def test_a_chat_spoken_in_before_a_restart_is_not_answered_even_within_the_same_millisecond(client, monkeypatch):
    # the restart is told by the order the hive wrote the mind's reply and its new execution's boundary, never by their
    # clock stamps: on a loaded host a reply and the next boundary landed in one millisecond and the show reached Jon
    import hive.core.ask as ask_module
    import hive.core.hive as hive_module
    w = world(client)
    hive, cid = w["hive"], w["coord"]["id"]
    photo = _art(w)
    assert client.post(f"/api/agents/{cid}/messages", headers=w["jon"], json={"text": "show me the harbour"}).status_code == 200
    tick = "2026-11-16T08:00:00.000Z"
    monkeypatch.setattr(hive_module, "now", lambda: tick)
    monkeypatch.setattr(ask_module, "now", lambda: tick)
    jons = hive.person_conversation(cid, "user:u_jon")
    hive.record_agent_message(cid, {"text": "Here it is.", "conversation_id": jons})
    assert hive.ask.note_boundary(cid, "stub:same-tick") is not None
    r = _say(client, w, "show", photo)
    assert r.status_code == 403 and r.json()["error"]["code"] == "no_person"
    # in the same millisecond again, it speaks in Jon's chat after the boundary: that chat is what it answers now
    hive.record_agent_message(cid, {"text": "Still here.", "conversation_id": jons})
    assert _say(client, w, "show", photo).status_code == 200


def test_compare_names_two_things_and_recall_one(client):
    w = world(client)
    photo, words = _art(w), _art(w, "note", "What I wrote about it")
    ask(client, w["ann"], "op-stage-compare-01", context={"swarm_id": w["swarm"]["id"]})
    assert _say(client, w, "compare", photo, words).json()["items"] == [photo, words]
    assert _say(client, w, "recall", words).status_code == 200
    for bad in (("compare", photo), ("compare", photo, photo), ("show", photo, words), ("recall",), ("wave", photo)):
        r = _say(client, w, *bad)
        assert r.status_code == 400, bad


def test_an_item_the_person_cannot_see_is_answered_as_not_there(client):
    w = world(client)
    ask(client, w["ann"], "op-stage-unseen-01", context={"swarm_id": w["swarm"]["id"]})
    # a swarm Ann is not shown, and a creation in it
    hidden = client.post("/api/swarms", json={"name": "Private"}).json()
    other = client.post("/api/agents", json={"name": "Elsewhere", "swarm_id": hidden["id"]}).json()
    unseen = w["hive"].collab.create_artifact(w["hive"].db.one("SELECT * FROM agents WHERE id = ?", (other["id"],)),
                                              {"kind": "image", "title": "Not hers"})["id"]
    for key in (unseen, "ar_" + "0" * 32, other["id"]):
        r = _say(client, w, "show", key)
        assert r.status_code == 404, key
        assert key in r.json()["error"]["message"] or "not something" in r.json()["error"]["message"]
    assert _say(client, w, "show", "s_notanitem").status_code == 400


def test_a_turn_answering_nobody_shows_nothing_and_says_why(client):
    w = world(client)
    photo = _art(w)
    # no Ask turn, and the mind is not in anyone's own space
    r = _say(client, w, "show", photo)
    assert r.status_code == 403 and r.json()["error"]["code"] == "no_person"


def test_a_page_whose_socket_dropped_reads_what_it_missed_and_only_its_own(client):
    w = world(client)
    photo, words = _art(w), _art(w, "note", "Notes")
    ask(client, w["ann"], "op-stage-missed-01", context={"swarm_id": w["swarm"]["id"]})
    first = _say(client, w, "show", photo).json()["seq"]
    _say(client, w, "recall", words)
    missed = client.get(f"/api/me/stage?after={first}", headers=w["ann"]).json()
    assert [(m["say"], [i["key"] for i in m["items"]]) for m in missed] == [("recall", [words])]
    assert len(client.get("/api/me/stage", headers=w["ann"]).json()) == 2
    assert client.get("/api/me/stage", headers=w["bob"]).json() == []
    assert client.get("/api/me/stage", headers=w["jon"]).json() == []


def test_the_stage_skills_were_reviewed_and_a_person_is_never_asked_for_them(client):
    assert {"hive-show", "hive-recall", "hive-compare"} <= policy.REVIEWED_HIVE_SKILLS
    w = world(client)
    mind = w["hive"].db.one("SELECT * FROM agents WHERE id = ?", (w["coord"]["id"],))
    for skill in ("hive-show", "hive-recall", "hive-compare"):
        assert w["hive"].policy.decide(mind, skill)[0] == "allow", skill
    # and the frame's rule is the person's own, judged before the admin bypass
    from hive.core.visibility import EVENT_RULES
    assert EVENT_RULES["stage.said"] == "person"
