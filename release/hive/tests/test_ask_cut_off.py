"""Purpose: an Ask step whose answer stops at the model's output limit is asked again with more room, never run or shown
half written.

Invented lives only: Ann (user:u_ann, the test world's person) and her own mind. On a v0.33 test build (17 Nov) a make
body cut at the 1024-token limit reached the conductor as arguments that did not parse, was refused as invalid, and the
mind tried again in the same room, five times. The provider marks such an answer finish_reason length:
- a cut step runs none of its calls and shows none of its words; it is asked again with twice the room, and a whole
  answer then runs;
- the room doubles while answers keep stopping at it, and the next step starts at the small room again;
- the turn's own limits still end it, so a model that never finishes cannot run up calls or money unbounded.
"""
from hive.core import conductor as cmod
from hive.tests.test_ask import ask
from hive.tests.test_ask_conductor import Script, call, closed, script, wait
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_personal_mind_ask import _on

FULL = "Here is your tip calculator: put in the bill and the tip, and it shows each person's share."
# what a provider sends when the answer reached max_tokens inside a tool call's arguments: JSON that ends mid-string
HALF = {"id": "call_say_half", "type": "function", "function": {"name": "say", "arguments": '{"text": "Here is your tip calcu'}}


class CutScript(Script):
    """Answers as Script does, and marks the answers at the given call indices as stopped at the output limit."""

    def __init__(self, *steps, cut=(), **kw):
        super().__init__(*steps, **kw)
        self.cut = set(cut)

    async def chat(self, agent, body):
        response, usage = await super().chat(agent, body)
        response["choices"][0]["finish_reason"] = "length" if len(self.bodies) - 1 in self.cut else "stop"
        return response, usage


def _turn(client, monkeypatch, op, s):
    w = _on(client, monkeypatch)
    hive = w["hive"]
    script(client, s)
    published, publish = [], hive.ask._publish
    monkeypatch.setattr(hive.ask, "_publish", lambda fs: (published.extend(f for f in fs if f), publish(fs))[1])
    r = ask(client, w["ann"], op, text="Make me a tip calculator.")
    assert r.status_code == 202, r.text
    wait(hive, op, closed)
    mine = [f for f in published if f.get("turn_id") == r.json()["turn_id"]]
    answers = [f for f in mine if f.get("phase") == "answer"]
    return ([f["text"] for f in answers if f.get("delta")], [f["text"] for f in answers if not f.get("delta")],
            [f.get("outcome") for f in mine if f.get("phase") == "done"])


def test_a_cut_off_step_is_asked_again_with_twice_the_room_and_runs_whole(client, monkeypatch):
    s = CutScript([HALF], [call("say", text=FULL, done=True)], cut=[0])
    said, whole, done = _turn(client, monkeypatch, "op-cut-01", s)
    assert [b["max_tokens"] for b in s.bodies] == [cmod.MAX_TOKENS, 2 * cmod.MAX_TOKENS]
    # the half-written say reached neither the person nor the model's history
    assert said == [FULL] and whole == [FULL] and done == ["complete"]
    assert not any(m.get("tool_calls") for m in s.bodies[1]["messages"])


def test_the_room_doubles_while_answers_stop_at_it_and_the_next_step_starts_small(client, monkeypatch):
    s = CutScript([HALF], [HALF], [call("say", text=FULL)], "", cut=[0, 1])
    said, whole, done = _turn(client, monkeypatch, "op-cut-02", s)
    assert [b["max_tokens"] for b in s.bodies] == [cmod.MAX_TOKENS, 2 * cmod.MAX_TOKENS, 4 * cmod.MAX_TOKENS, cmod.MAX_TOKENS]
    assert said == [FULL] and whole == [FULL] and done == ["complete"]


def test_the_turns_own_limits_end_a_model_that_never_finishes(client, monkeypatch):
    s = CutScript([HALF], cut=range(cmod.MAX_MODEL_CALLS + 1), repeat_last=True)
    said, whole, done = _turn(client, monkeypatch, "op-cut-03", s)
    assert len(s.bodies) <= cmod.MAX_MODEL_CALLS
    assert said == [] and done and done[0] != "complete"   # a limit's own words end it; nothing half written was said
