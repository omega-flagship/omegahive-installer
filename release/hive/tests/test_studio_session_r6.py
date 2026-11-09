"""J3 host round R6: a real Studio maker receives and acts on an admitted step (open items OI-10, OI-11).

- OI-10: the hub channel (modules/channel_hive/src/hive_channel.py) turns the host's studio_step frame into one Studio event
  the maker runtime reads (getLastMessage); before R6 deliver() dropped it, so every step ended timed_out_unread.
- OI-11: the three maker calls (context, publish with op_ids, done) as MCP tools for hub (omega-kind) makers, on the
  same handlers as the REST maker routes and the request's captured epoch; Iter-template and other non-hub makers are
  refused at admission (maker_kind_unsupported).
- The end-to-end test drives one whole step with Studio on: admitted, the frame delivered over the hub into the real
  channel daemon, the maker reads it, calls context, publish and done through /mcp, the person's outcome is recorded, Stop.
Synthetic only: temporary directories, the R3 fake process driver, stand-in hub sockets, invented keys, no provider call."""
import importlib.util
import json
import os
import pathlib

import pytest

import hive.tests.test_studio_session_r3 as R3
from hive.tests.test_studio_session_r3 import (context, drive, maker_headers, mount, open_session, outcome, publish,  # noqa: F401
                                               r3, ses_row, started, step_row, token_now, upload)
from hive.tests.test_studio_session_r3_handoff import control, stopped_and_released, wait_for  # noqa: F401
from hive.tests.test_ask_intents import a, held, release, turn  # noqa: F401  (fixtures)
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_mind_control import w  # noqa: F401  (fixture)
from hive.tests.test_studio_session_g1 import counts, err, record, s, submit  # noqa: F401

CHANNEL = pathlib.Path(__file__).resolve().parents[2] / "modules" / "channel_hive" / "src" / "hive_channel.py"
SID, EX, DL = "ss_" + "a" * 24, "ex_" + "1" * 24, "dl_" + "2" * 24


def load_channel():
    spec = importlib.util.spec_from_file_location("hive_channel_r6", CHANNEL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def ch(tmp_path, monkeypatch):
    """The real channel module: its daemon object (no socket; frames are handed to deliver as the session loop does) and
    its agent-side reader, over a temporary memory directory."""
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setenv("HIVE_AGENT_ID", "a_maker")
    module = load_channel()
    folder = module.channel_dir()
    module.daemon = module._Daemon(folder, "ws://127.0.0.1:1/agent-hub", "t", 0)
    module.folder = folder
    return module


def step_frame(n=1, epoch=2, sid=SID, ex=EX, dl=DL):
    return {"type": "studio_step", "session_id": sid, "step": n, "epoch": epoch, "delivery_id": dl, "execution_id": ex}


def fields(block):
    return dict(line.split("=", 1) for line in block.split("\n")[1:] if "=" in line)


# ---- OI-10: the hub channel delivers studio_step ------------------------------------------------------------------------

def test_OI10_a_studio_step_frame_becomes_one_studio_event_the_maker_reads(ch):
    ch.daemon.deliver(step_frame())
    block = ch.getLastMessage()
    assert block.startswith("CHANNEL_EVENT\n"), block
    f = fields(block)
    assert (f["event"], f["channel"], f["route"], f["sender"]) == ("studio_step", "hive", "studio", "hive")
    assert (f["studio_session_id"], f["studio_step"], f["studio_execution_id"], f["studio_epoch"],
            f["studio_delivery_id"]) == (SID, "1", EX, "2", DL)
    assert "hive_studio_context" in f["text"] and "hive_studio_publish" in f["text"] and "hive_studio_done" in f["text"]
    assert ch.getLastMessage() == ""                                   # read once
    assert ch._pending == []                                           # no conversation waits for a chat reply


def test_OI10_a_studio_step_never_moves_the_replay_cursor_and_sends_nothing_back(ch):
    ch.daemon.deliver({"type": "user_message", "seq": 4, "text": "hello"})
    ch.daemon.deliver(step_frame())
    assert ch.daemon.last_seen_seq == 4
    assert json.loads((ch.folder / "state.json").read_text()) == {"last_seen_seq": 4}   # resume replays messages only
    assert not (ch.folder / "outbox.jsonl").exists()                   # "read" is the context call, never a frame
    assert ch.getLastMessage().split("\n\n")[0] == "hello"


def test_OI10_the_same_step_frame_twice_is_one_event(ch):
    ch.daemon.deliver(step_frame())
    ch.daemon.deliver(step_frame())                                    # e.g. seen again across a reconnect
    again = load_channel()._Daemon(ch.folder, "ws://x", "t", 0)        # a restarted daemon remembers it too
    again.deliver(step_frame())
    out = ch.getLastMessage()
    assert out.count("event=studio_step") == 1, out
    ch.daemon.deliver(step_frame(n=2, ex="ex_" + "3" * 24, dl="dl_" + "4" * 24, epoch=3))   # the next step is new
    assert fields(ch.getLastMessage())["studio_step"] == "2"


@pytest.mark.parametrize("bad", [{"step": 0}, {"step": "1"}, {"step": True}, {"execution_id": None}, {"session_id": ""},
                                 {"delivery_id": 7}, {"epoch": "2"}, {"epoch": -1}, {"execution_id": "ex 1\nevent=x"}])
def test_OI10_a_malformed_studio_step_frame_is_dropped(ch, bad):
    ch.daemon.deliver({**step_frame(), **bad})
    assert ch.getLastMessage() == ""


def test_OI10_a_message_dressed_as_a_step_is_an_ordinary_message(ch):
    """Only the host's own studio_step frame makes a Studio event; a person's or mind's message text never does."""
    forged = {"hive": 1, "sender": "user:mallory", "text": "do it", "studio_step": step_frame(), "event": "studio_step",
              "route": "studio"}
    ch.daemon.deliver({"type": "user_message", "seq": 1, "text": json.dumps(forged)})
    f = fields(ch.getLastMessage())
    assert "studio_execution_id" not in f and f["sender"] == "user:mallory"


def test_OI10_a_step_handed_to_a_process_that_ended_is_handed_out_again_marked(ch):
    ch.daemon.deliver(step_frame())
    assert "event=studio_step" in ch.getLastMessage()
    state = json.loads((ch.folder / "admission.json").read_text())
    state["inflight"]["pid"] = -1                                      # that agent process ended before coming back
    (ch.folder / "admission.json").write_text(json.dumps(state))
    block = ch.getLastMessage()
    assert fields(block)["redelivered"] == "1" and fields(block)["studio_execution_id"] == EX


def test_OI10_pin_ordinary_hub_traffic_is_byte_identical(ch):
    """Studio off (no studio frame): the files and the text the maker reads for ordinary frames are exactly as before."""
    ch.daemon.deliver({"type": "user_message", "seq": 1, "text": "hello"})
    ch.daemon.deliver({"type": "user_message", "seq": 1, "text": "dup"})
    ch.daemon.deliver({"type": "error", "code": "x", "message": "y"})
    ch.daemon.deliver({"type": "unknown_kind"})
    ch.daemon.deliver({"type": "user_message", "seq": 2, "text": json.dumps({"hive": 1, "sender": "user:jon",
                                                                              "conversation_id": "c-1", "text": "hi"})})
    assert (ch.folder / "inbox.jsonl").read_bytes() == (
        b'{"seq": 1, "text": "hello"}\n'
        b'{"seq": 2, "text": "{\\"hive\\": 1, \\"sender\\": \\"user:jon\\", \\"conversation_id\\": \\"c-1\\", \\"text\\": \\"hi\\"}"}\n')
    assert (ch.folder / "state.json").read_bytes() == b'{"last_seen_seq": 2}'
    assert json.loads((ch.folder / "status.json").read_text()) == {"received": 2, "sent": 0, "reconnects": 0, "connected": False,
                                                                   "url": "ws://127.0.0.1:1/agent-hub", "last_seen_seq": 2}
    assert sorted(p.name for p in ch.folder.iterdir()) == ["inbox.jsonl", "state.json", "status.json"]
    out = ch.getLastMessage()
    assert out == ("hello\n\nCHANNEL_EVENT\nevent=message\nchannel=hive\nroute=primary\nconversation_id=c-1\n"
                   "sender=user:jon\ntext=hi\nexplicit_reply_affordance=send-hive-to c-1 message")


# ---- OI-11: maker tools on the MCP surface; non-hub makers refused at admission ----------------------------------------

STUDIO_TOOLS = ("hive_studio_context", "hive_studio_publish", "hive_studio_done")


def mcp(x, name, args, token=None):
    r = x.client.post("/mcp", headers={"Authorization": f"Bearer {token or token_now(x)}"},
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
    assert r.status_code == 200, r.text
    return r.json()


def mcp_ok(x, name, args, token=None):
    out = mcp(x, name, args, token)
    assert "result" in out, out
    return out["result"]["structuredContent"]


def mcp_code(out):
    return out["error"]["data"]["code"]


def tools_list(x, token):
    r = x.client.post("/mcp", headers={"Authorization": f"Bearer {token}"},
                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    return r.json()["result"]["tools"]


def test_OI11_pin_with_studio_off_the_mcp_surface_is_unchanged(s, monkeypatch):
    from hive.core import mcp as M
    monkeypatch.setattr(s.hive.studio, "enabled", False)
    listed = tools_list(s, s.maker["token"])
    assert listed == M.TOOLS and not {t["name"] for t in listed} & set(STUDIO_TOOLS)
    unknown = mcp(s, "hive_nope", {}, s.maker["token"])
    for name in STUDIO_TOOLS:
        out = mcp(s, name, {"session_id": SID}, s.maker["token"])
        assert out["error"] == {**unknown["error"], "message": f"no tool {name}",
                                "data": {**unknown["error"]["data"], "message": f"no tool {name}"}}
        assert mcp_code(out) == "unknown_tool"


def test_OI11_with_studio_on_the_three_maker_tools_are_listed(s):
    names = [t["name"] for t in tools_list(s, s.maker["token"])]
    assert names[-3:] == list(STUDIO_TOOLS)


def test_OI11_mcp_publish_refuses_a_body_without_1_to_16_distinct_op_ids_and_writes_nothing(r3):
    session, sid, m, ack, step = started(r3)
    mcp_ok(r3, "hive_studio_context", {"session_id": sid, "execution_id": step["execution_id"]})
    art = session["proposal_artifact_id"]
    before = r3.hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?", (art,))["n"]
    for items in ([], [{"op_id": "a"}, {"op_id": "a"}], [{"op_id": f"op-{i}"} for i in range(17)], [{"op_id": 3}],
                  [{"x": 1}], [{"op_id": "bad id"}]):
        out = mcp(r3, "hive_studio_publish", {"artifact_id": art, "execution_id": step["execution_id"], "parent": None,
                                              "body": json.dumps({"schema": "omega-maker-revision-2", "items": items})})
        assert mcp_code(out) == "op_ids_invalid", out
    assert mcp_code(mcp(r3, "hive_studio_publish", {"artifact_id": art, "execution_id": step["execution_id"],
                                                    "body": "not json"})) == "op_ids_invalid"
    assert r3.hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id = ?", (art,))["n"] == before
    assert step_row(r3, sid, 1)["proposal_n"] is None


def test_OI11_mcp_op_ids_match_the_iter_tool_exactly(monkeypatch):
    """One rule for both transports: the op ids are the body's items' op_id strings, in order, never minted."""
    from hive.core import mcp as M
    spec = importlib.util.spec_from_file_location(
        "r6_pub", pathlib.Path(__file__).resolve().parents[1] / "templates" / "iter" / "tools" / "hive_studio_publish.py")
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    cases = [[{"op_id": "op-b"}, {"op_id": "op-a"}], [], [{"op_id": "a"}, {"op_id": "a"}], [{"op_id": "x" * 80}],
             [{"op_id": "x" * 81}], [{"op_id": "_lead"}], [{"op_id": "a:b.c-d_e"}], [{"op_id": f"o{i}"} for i in range(16)],
             [{"op_id": f"o{i}"} for i in range(17)], [{"op_id": None}], "nope"]
    for items in cases:
        body = json.dumps({"items": items})
        assert M.studio_op_ids(body) == tool._op_ids(body), items
    assert M.studio_op_ids("[]") is None and tool._op_ids("[]") is None


def test_OI11_mcp_maker_calls_use_the_requests_captured_epoch(r3):
    """G2: an MCP call keeps the epoch its request authenticated with; the tool never re-reads the agent row."""
    hive = r3.hive
    session, sid, m, ack, step = started(r3)
    mcp_ok(r3, "hive_studio_context", {"session_id": sid, "execution_id": step["execution_id"]})
    captured = hive.db.one("SELECT * FROM agents WHERE id = ?", (r3.maker["id"],))
    stale = dict(captured, token_epoch=captured["token_epoch"] - 1)          # authenticated on the previous epoch
    import asyncio
    out = asyncio.run(hive.harnesses.handle(stale, {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {
        "name": "hive_studio_publish", "arguments": {"artifact_id": session["proposal_artifact_id"],
                                                     "execution_id": step["execution_id"], "parent": None,
                                                     "body": json.dumps({"items": [{"op_id": "op-stale"}]})}}}))
    assert mcp_code(out) in ("execution_retired", "studio_fenced"), out
    assert step_row(r3, sid, 1)["proposal_n"] is None


def test_OI11_another_mind_gets_nothing_from_the_maker_tools(r3):
    session, sid, m, ack, step = started(r3)
    other = r3.client.post("/api/agents", json={"name": "Other", "swarm_id": r3.home["id"]}).json()
    out = mcp(r3, "hive_studio_context", {"session_id": sid, "execution_id": step["execution_id"]}, other["token"])
    assert "error" in out and out["error"]["data"]["http_status"] in (403, 404), out
    assert step_row(r3, sid, 1)["read_at"] is None


@pytest.mark.parametrize("kind", ["iter", "module"])
def test_OI11_a_maker_without_a_hub_channel_is_refused_at_admission_and_nothing_is_created(s, kind):
    hive = s.hive
    hive.db.execute("UPDATE agents SET kind = ? WHERE id = ?", (kind, s.maker["id"]))
    before = counts(hive)
    r = submit(s, record(s).json()["intent_id"])
    assert (r.status_code, err(r).get("code"), err(r).get("kind")) == (409, "maker_kind_unsupported", kind), r.text
    after = counts(hive)
    assert after["studio_sessions"] == before["studio_sessions"] and after["goals"] == before["goals"]
    assert after["artifacts"] == before["artifacts"]


def test_OI11_an_omega_maker_is_admitted_as_before(s):
    assert hive_kind(s) == "omega"
    r = submit(s, record(s).json()["intent_id"])
    assert r.status_code == 201, r.text


def hive_kind(x):
    return x.hive.db.one("SELECT kind FROM agents WHERE id = ?", (x.maker["id"],))["kind"]


# ---- the whole step, end to end (gaps 1-2 closed) ----------------------------------------------------------------------

class ChannelHub(R3.Hub):
    """The maker's hub socket, wired to the real channel daemon: what the host sends over it is what deliver() gets."""
    daemon = None

    async def send_text(self, text):
        await super().send_text(text)
        if ChannelHub.daemon is not None:
            ChannelHub.daemon.deliver(json.loads(text))


def test_R6_end_to_end_one_step_over_the_hub_channel_and_the_mcp_maker_tools(r3, ch, monkeypatch):
    hive = r3.hive
    assert hive_kind(r3) == "omega"
    ChannelHub.daemon = ch.daemon
    monkeypatch.setattr(R3, "Hub", ChannelHub)                       # every hub connection from here is the channel's
    try:
        # 1. session admitted; the person's frame mounted and the piece uploaded; the handoff admits step 1
        session = open_session(r3)
        sid = session["session_id"]
        m = mount(r3, sid, session["stream_id"]).json()
        ack = upload(r3, sid, m, 1).json()
        drive(r3)
        step = step_row(r3, sid, 1)
        assert step is not None and step["state"] == "admitted", ses_row(r3, sid)["state_reason"]
        assert wait_for(lambda: step_row(r3, sid, 1)["delivered_at"] is not None)
        # 2. the step frame arrived over the hub; the maker runtime reads it from its channel
        events = [b for b in ch.getLastMessage().split("\n\n") if "event=studio_step" in b]
        assert len(events) == 1, events
        f = fields(events[0])
        assert (f["studio_session_id"], f["studio_step"], f["studio_execution_id"]) == (sid, "1", step["execution_id"])
        assert step_row(r3, sid, 1)["read_at"] is None                 # delivered, not yet read
        # 3. the maker, on its own current token, calls context, then publish (op ids in the body), then done
        token = token_now(r3)
        seen = mcp_ok(r3, "hive_studio_context", {"session_id": f["studio_session_id"],
                                                  "execution_id": f["studio_execution_id"]}, token)
        assert seen["preview"] is False and seen["step"]["n"] == 1 and seen["piece"]["seq"] == 1
        assert step_row(r3, sid, 1)["read_at"] is not None              # read is acknowledged by the context call
        body = json.dumps({"schema": "omega-maker-revision-2", "items": [{"op_id": "op-e2e-1", "set": {"fill": "#f80"}},
                                                                          {"op_id": "op-e2e-2"}]})
        pub = mcp_ok(r3, "hive_studio_publish", {"artifact_id": seen["proposal_artifact_id"], "body": body,
                                                 "execution_id": f["studio_execution_id"], "parent": seen["parent"]}, token)
        assert pub["op_ids"] == ["op-e2e-1", "op-e2e-2"]
        row = step_row(r3, sid, 1)
        assert row["proposal_n"] == pub["revision"] and json.loads(row["op_ids"]) == ["op-e2e-1", "op-e2e-2"]
        stored = hive.db.one("SELECT body FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                             (seen["proposal_artifact_id"], pub["revision"]))["body"]
        assert stored == body                                           # byte for byte
        fin = mcp_ok(r3, "hive_studio_done", {"session_id": sid, "n": 1, "execution_id": f["studio_execution_id"],
                                              "more": False}, token)
        assert fin["state"] == "finished" and step_row(r3, sid, 1)["state"] == "finished"
        # 4. the person's frame reports the outcome; it is recorded against the step
        prop = {"artifact_id": seen["proposal_artifact_id"], "revision": pub["revision"], "digest": pub["digest"]}
        r = outcome(r3, sid, 1, m, prop, ack)
        assert r.status_code == 200, r.text
        assert r.json()["execution_id"] == step["execution_id"]
        assert step_row(r3, sid, 1)["outcome"] == "applied"
        # 5. Stop: the session ends and the maker is released, asleep, on a fresh unfenced epoch
        assert control(r3, sid, "stop").status_code == 200
        stopped_and_released(r3, sid)
        assert ses_row(r3, sid)["state"] in ("stopped", "ended")
    finally:
        ChannelHub.daemon = None


# ---- R6.1: the omega maker's native skills (modules/hive_studio), loaded only while Studio is on ----------------------------
# PeTTa is not run here: the MeTTa skills are one py-call each into the bridge (modules/hive_studio/src/hive_studio.py), so the
# end-to-end test drives that bridge directly, over the real REST maker routes, with the execution's own HIVE_WS_TOKEN.

ROOT = pathlib.Path(__file__).resolve().parents[2]
STUDIO_MODULE = ROOT / "modules" / "hive_studio"
SKILLS = ("hive-studio-context", "hive-studio-publish", "hive-studio-done")


def load_bridge():
    spec = importlib.util.spec_from_file_location("hive_studio_r61", STUDIO_MODULE / "src" / "hive_studio.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_parser():
    import sys
    if str(ROOT / "src") not in sys.path:
        sys.path.insert(0, str(ROOT / "src"))
    import helper_command_parser
    return helper_command_parser


def recorded(monkeypatch, bridge, answer=None):
    calls = []

    def call(method, path, payload=None):
        calls.append((method, path, payload))
        return (answer if answer is not None else {}), None
    monkeypatch.setattr(bridge, "_call", call)
    return calls


def metta_depth_errors(text):
    """The depth/structure lint: strings and comments skipped; never below 0; every top-level form ends at depth 0 and
    every '(=' definition and declaration starts at depth 0."""
    errors, depth, i, line = [], 0, 0, 1
    while i < len(text):
        c = text[i]
        if c == ";":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        if c == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif c == "\n":
            line += 1
        elif c == "(":
            if depth == 0 and not text.startswith(("(", "!("), i - (1 if i and text[i - 1] == "!" else 0)):
                errors.append(f"line {line}: odd top-level form")
            if depth > 0 and text.startswith("(= (", i):
                errors.append(f"line {line}: definition nested at depth {depth}")
            depth += 1
        elif c == ")":
            depth -= 1
            if depth < 0:
                errors.append(f"line {line}: depth below 0")
                depth = 0
        i += 1
    if depth:
        errors.append(f"depth {depth} at end")
    return errors


def test_R61_the_module_declares_exactly_the_three_skills_and_passes_the_depth_lint():
    files = {p.name: p.read_text() for p in STUDIO_MODULE.glob("*.metta")}
    assert set(files) == {"entry.metta", "skills.metta", "signatures.metta", "catalog.metta", "affordance.metta"}
    for name, text in files.items():
        assert metta_depth_errors(text) == [], (name, metta_depth_errors(text))
    import re
    assert sorted(re.findall(r"^\(SkillSignature (\S+)", files["signatures.metta"], re.M)) == sorted(SKILLS)
    assert sorted(re.findall(r"^\(= \((hive-studio-[a-z]+)", files["skills.metta"], re.M)) == sorted(SKILLS)
    assert sorted(re.findall(r"\(Skill (hive-studio-[a-z]+)\)", files["entry.metta"])) == sorted(SKILLS)
    toml = (STUDIO_MODULE / "module.toml").read_text()
    assert 'default_enabled = false' in toml and all(f'"skill:{s}"' in toml for s in SKILLS)
    assert "hive_studio" not in (ROOT / "modules" / "loader.metta").read_text()      # never in the default loader


def test_R61_pin_with_studio_off_the_omega_skill_surface_is_unchanged(monkeypatch):
    """Without the per-mind switch the parser's declaration files, commands and module set never include the module."""
    parser = load_parser()
    monkeypatch.delenv("OMEGACLAW_EXTRA_MODULES", raising=False)
    monkeypatch.delenv("OMEGACLAW_MODULE_LOADER", raising=False)
    for name in ("signatures.metta", "catalog.metta", "affordance.metta"):
        assert not any("hive_studio" in str(p) for p in parser._module_declaration_paths(name)), name
    parser.reload_signature_commands()
    off = dict(parser.SIGNATURE_COMMANDS)
    assert not any(str(k).startswith("hive-studio-") for k in off)
    monkeypatch.setenv("OMEGACLAW_EXTRA_MODULES", "hive_studio")
    try:
        parser.reload_signature_commands()
        on = dict(parser.SIGNATURE_COMMANDS)
    finally:
        monkeypatch.delenv("OMEGACLAW_EXTRA_MODULES")
        parser.reload_signature_commands()
    assert sorted(k for k in on if str(k).startswith("hive-studio-")) == sorted(SKILLS)
    assert {k: v for k, v in on.items() if k not in SKILLS} == off                   # nothing else moves
    monkeypatch.setenv("OMEGACLAW_EXTRA_MODULES", "../hive,nope,hive")               # only real, plain, unloaded dirs
    assert not any("/hive/" in str(p) or "nope" in str(p) for p in parser._module_declaration_paths("signatures.metta")
                   if "hive_studio" in str(p) or "nope" in str(p))


def test_R61_bridge_publish_sends_the_body_byte_for_byte_with_the_bodys_op_ids_beside_it(monkeypatch):
    bridge = load_bridge()
    calls = recorded(monkeypatch, bridge, {"artifact_id": "ar_x", "n": 3, "digest": "sha256:" + "a" * 64})
    body = '{"schema":"omega-maker-revision-2",  "items":[{"op_id":"op-b","x":1},{"op_id":"op-a"}]}\n'
    out = bridge.publish("ar_x", EX, "2", body)
    assert calls == [("POST", "/api/agent/artifacts/ar_x/revisions",
                      {"body": body, "parent": 2, "execution_id": EX, "op_ids": ["op-b", "op-a"]})]
    assert out.startswith("HIVE-STUDIO-PUBLISHED ar_x r3 ") and "op_ids=op-b,op-a" in out
    calls.clear()
    bridge.publish("ar_x", EX, "none", body)
    assert calls[0][2]["parent"] is None


def test_R61_bridge_publish_refuses_bad_op_ids_and_sends_nothing(monkeypatch):
    from hive.core import mcp as M
    bridge = load_bridge()
    calls = recorded(monkeypatch, bridge)
    for items in ([], [{"op_id": "a"}, {"op_id": "a"}], [{"op_id": f"op-{i}"} for i in range(17)], [{"op_id": 3}],
                  [{"x": 1}], [{"op_id": "bad id"}], "nope"):
        body = json.dumps({"items": items})
        assert bridge.publish("ar_x", EX, "", body).startswith("HIVE-ERROR op_ids_invalid"), items
        assert bridge.op_ids(body) == M.studio_op_ids(body)
    assert bridge.publish("ar_x", EX, "", "not json").startswith("HIVE-ERROR op_ids_invalid") and calls == []
    for items in ([{"op_id": "x" * 80}], [{"op_id": "a:b.c-d_e"}], [{"op_id": f"o{i}"} for i in range(16)]):
        body = json.dumps({"items": items})
        assert bridge.op_ids(body) == M.studio_op_ids(body) is not None


def test_R61_bridge_context_and_done_call_the_maker_routes(monkeypatch):
    bridge = load_bridge()
    calls = recorded(monkeypatch, bridge, {"state": "active", "preview": False})
    out = bridge.context(SID, EX)
    assert calls == [("GET", f"/api/agent/studio-sessions/{SID}/context?execution_id={EX}", None)]
    assert json.loads(out) == {"state": "active", "preview": False}
    calls = recorded(monkeypatch, bridge, {"n": 2, "state": "finished", "more": False})
    assert bridge.done(SID, "2", EX, "false") == "HIVE-STUDIO-DONE step 2 finished more=False"
    assert calls == [("POST", f"/api/agent/studio-sessions/{SID}/steps/2/done", {"more": False, "execution_id": EX})]
    calls.clear()
    assert bridge.done(SID, "2", EX, "maybe").startswith("HIVE-ERROR bad_request") and calls == []


def test_R61_the_bridge_authenticates_with_the_executions_own_token(monkeypatch):
    bridge = load_bridge()
    seen = []

    class Answer:
        def __init__(self):
            self.body = b'{"n": 1, "state": "finished", "more": true}'

        def read(self):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False
    monkeypatch.setenv("HIVE_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HIVE_WS_TOKEN", "tok-of-this-execution")
    monkeypatch.setattr(bridge, "_open", lambda request, timeout: seen.append(request) or Answer())
    bridge.done(SID, "1", EX, "true")
    assert seen[0].get_header("Authorization") == "Bearer tok-of-this-execution"
    assert seen[0].full_url == f"http://127.0.0.1:9/api/agent/studio-sessions/{SID}/steps/1/done"


def test_R61_the_studio_skills_are_reviewed_hive_skills(s):
    mind = s.hive.db.one("SELECT * FROM agents WHERE id = ?", (s.maker["id"],))
    for skill in SKILLS:
        assert s.hive.policy.decide(mind, skill)[0] == "allow", skill


def started_with(x, monkeypatch):
    """Capture what the real Supervisor.start hands the driver."""
    envs = []
    real = x.driver.start
    monkeypatch.setattr(x.driver, "start", lambda agent, env: (envs.append(dict(env)), real(agent, env))[1])
    return envs


def test_R61_with_studio_on_an_omega_mind_starts_with_the_studio_module(r3, monkeypatch):
    from hive.supervisor.workspace import RUN_METTA
    run = r3.workspace.path(r3.maker["id"]) / "run.metta"
    run.write_text(RUN_METTA)
    envs = started_with(r3, monkeypatch)
    r3.sup.start(r3.maker["id"])
    assert envs[-1]["OMEGACLAW_EXTRA_MODULES"] == "hive_studio"
    text = run.read_text()
    line = "!(import! &self (library OmegaClaw-Core ./modules/hive_studio/entry.metta))"
    assert text.count(line) == 1 and text.index(line) < text.index("!(omegaclaw)")
    r3.sup.start(r3.maker["id"])
    assert run.read_text() == text                                         # idempotent


def test_R61_pin_with_studio_off_a_start_is_unchanged_and_an_earlier_switch_is_removed(r3, monkeypatch):
    from hive.supervisor.workspace import RUN_METTA
    run = r3.workspace.path(r3.maker["id"]) / "run.metta"
    run.write_text(RUN_METTA)
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    envs = started_with(r3, monkeypatch)
    r3.sup.start(r3.maker["id"])
    assert "OMEGACLAW_EXTRA_MODULES" not in envs[-1] and run.read_bytes() == RUN_METTA.encode()
    monkeypatch.setattr(r3.hive.studio, "enabled", True)
    r3.sup.start(r3.maker["id"])
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    r3.sup.start(r3.maker["id"])                                           # Studio switched off again: gone again
    assert "OMEGACLAW_EXTRA_MODULES" not in envs[-1] and run.read_bytes() == RUN_METTA.encode()


def test_R61_an_iter_or_module_mind_never_gets_the_studio_module(r3, monkeypatch):
    other = r3.client.post("/api/agents", json={"name": "Iterish", "swarm_id": r3.home["id"]}).json()
    r3.hive.db.execute("UPDATE agents SET kind = 'iter' WHERE id = ?", (other["id"],))
    envs = started_with(r3, monkeypatch)
    r3.driver.known.add(other["id"])
    r3.sup.start(other["id"])
    assert "OMEGACLAW_EXTRA_MODULES" not in envs[-1]


def test_R61_end_to_end_one_step_over_the_hub_channel_and_the_native_omega_skills(r3, ch, monkeypatch):
    """The omega path: the frame over the hub into the channel, then context, publish and done through the native skills'
    REST bridge (PeTTa itself is not run in tests), on the token the restarted execution was given, then outcome, Stop."""
    hive = r3.hive
    bridge = load_bridge()
    sent = []

    def via_host(request, timeout):
        path = request.full_url.split("http://hive.test", 1)[1]
        sent.append(request.get_header("Authorization"))
        data = json.loads(request.data) if request.data else None
        r = r3.client.request(request.get_method(), path, headers={"Authorization": request.get_header("Authorization")},
                              json=data)
        if r.status_code >= 400:
            import io
            import urllib.error
            raise urllib.error.HTTPError(request.full_url, r.status_code, "x", {}, io.BytesIO(r.content))

        class Answer:
            def read(self):
                return r.content

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        return Answer()
    monkeypatch.setattr(bridge, "_open", via_host)
    ChannelHub.daemon = ch.daemon
    monkeypatch.setattr(R3, "Hub", ChannelHub)
    try:
        session = open_session(r3)
        sid = session["session_id"]
        m = mount(r3, sid, session["stream_id"]).json()
        ack = upload(r3, sid, m, 1).json()
        drive(r3)
        step = step_row(r3, sid, 1)
        assert step is not None and step["state"] == "admitted", ses_row(r3, sid)["state_reason"]
        assert wait_for(lambda: step_row(r3, sid, 1)["delivered_at"] is not None)
        events = [b for b in ch.getLastMessage().split("\n\n") if "event=studio_step" in b]
        assert len(events) == 1, events
        f = fields(events[0])
        assert "hive-studio-context" in f["text"]                         # the event names the native skills too
        # the restarted execution's environment (Supervisor env: HIVE_WS_TOKEN = its workspace token)
        monkeypatch.setenv("HIVE_API_URL", "http://hive.test")
        monkeypatch.setenv("HIVE_WS_TOKEN", token_now(r3))
        seen = json.loads(bridge.context(f["studio_session_id"], f["studio_execution_id"]))
        assert seen["preview"] is False and seen["step"]["n"] == 1 and step_row(r3, sid, 1)["read_at"] is not None
        body = '{"schema": "omega-maker-revision-2", "items": [{"op_id": "op-omega-1", "set": {"fill": "#0af"}}]}'
        out = bridge.publish(seen["proposal_artifact_id"], f["studio_execution_id"],
                             "none" if seen["parent"] is None else str(seen["parent"]), body)
        assert out.startswith("HIVE-STUDIO-PUBLISHED"), out
        row = step_row(r3, sid, 1)
        assert json.loads(row["op_ids"]) == ["op-omega-1"]
        rev = hive.db.one("SELECT body, digest FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                          (seen["proposal_artifact_id"], row["proposal_n"]))
        assert rev["body"] == body                                         # byte for byte
        assert bridge.done(sid, "1", f["studio_execution_id"], "false") == "HIVE-STUDIO-DONE step 1 finished more=False"
        assert set(sent) == {f"Bearer {token_now(r3)}"}
        prop = {"artifact_id": seen["proposal_artifact_id"], "revision": row["proposal_n"], "digest": rev["digest"]}
        r = outcome(r3, sid, 1, m, prop, ack)
        assert r.status_code == 200, r.text
        assert step_row(r3, sid, 1)["outcome"] == "applied"
        assert control(r3, sid, "stop").status_code == 200
        stopped_and_released(r3, sid)
    finally:
        ChannelHub.daemon = None


# ---- R6.2 (stand-in R6.0 FIX-FIRST #1-#3; Kimi R6.0 #1, #4, #5 and sharpest point) ------------------------------------------

def test_R62_pin_the_whole_studio_off_start_environment_even_when_the_hive_process_carries_the_switch(r3, monkeypatch):
    """Stand-in #1: OMEGACLAW_EXTRA_MODULES is the supervisor's per-mind switch; a value in the hive's own environment
    never reaches a mind (mind_environment drops it) and the supervisor sets it only for an omega mind with Studio on."""
    from hive.supervisor.sandbox import mind_environment
    monkeypatch.setenv("OMEGACLAW_EXTRA_MODULES", "hive_studio")
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    envs = started_with(r3, monkeypatch)
    r3.sup.start(r3.maker["id"])
    assert envs[-1] == {"HIVE_TOKEN": token_now(r3)}                      # exactly Supervisor.env, nothing added
    child = mind_environment(dict(os.environ), dict(envs[-1], TMPDIR="/tmp/x"))   # what LocalDriver hands the process
    assert "OMEGACLAW_EXTRA_MODULES" not in child
    monkeypatch.setenv("OMEGACLAW_KEEP_ME", "1")                         # other OMEGACLAW_* pass through as before
    assert mind_environment(dict(os.environ), {})["OMEGACLAW_KEEP_ME"] == "1"
    monkeypatch.setattr(r3.hive.studio, "enabled", True)
    monkeypatch.setenv("OMEGACLAW_EXTRA_MODULES", "something_else")
    r3.sup.start(r3.maker["id"])
    assert mind_environment(dict(os.environ), envs[-1])["OMEGACLAW_EXTRA_MODULES"] == "hive_studio"


def test_R62_an_ordinary_mind_never_gets_the_switch_from_its_own_env_source(r3, monkeypatch):
    other = r3.client.post("/api/agents", json={"name": "Plain", "swarm_id": r3.home["id"]}).json()
    r3.hive.db.execute("UPDATE agents SET kind = 'module' WHERE id = ?", (other["id"],))
    monkeypatch.setattr(r3.sup, "env", lambda agent: {"HIVE_TOKEN": "t", "OMEGACLAW_EXTRA_MODULES": "hive_studio"})
    envs = started_with(r3, monkeypatch)
    r3.driver.known.add(other["id"])
    r3.sup.start(other["id"])
    assert envs[-1] == {"HIVE_TOKEN": "t"}                               # the supervisor owns it for every mind


def test_R62_a_crash_between_the_inbox_record_and_the_seen_key_still_gives_one_record(ch, monkeypatch):
    real = ch._write_json

    def crash(path, value):
        if str(path).endswith("studio_seen.json"):
            raise OSError("power cut")
        return real(path, value)
    monkeypatch.setattr(ch, "_write_json", crash)
    with pytest.raises(OSError):
        ch.daemon.deliver(step_frame())
    monkeypatch.setattr(ch, "_write_json", real)
    again = ch._Daemon(ch.folder, "ws://x", "t", 0)                     # the restarted daemon, the same frame again
    again.deliver(step_frame())
    out = ch.getLastMessage()
    assert out.count("event=studio_step") == 1, out
    assert json.loads((ch.folder / "studio_seen.json").read_text()) == [[SID, 1, 2, DL]]   # repaired
    again.deliver(step_frame())
    assert ch.getLastMessage() == ""


def test_R62_a_redelivered_step_says_its_cycle_may_already_have_started(ch):
    ch.daemon.deliver(step_frame())
    first = fields(ch.getLastMessage())
    assert "studio_already_started" not in first
    state = json.loads((ch.folder / "admission.json").read_text())
    state["inflight"]["pid"] = -1
    (ch.folder / "admission.json").write_text(json.dumps(state))
    f = fields(ch.getLastMessage())
    assert f["redelivered"] == "1" and f["studio_already_started"] == "possible"


def _crash_in_flight(ch):
    state = json.loads((ch.folder / "admission.json").read_text())
    state["inflight"]["pid"] = -1                                        # the process that read it ended
    (ch.folder / "admission.json").write_text(json.dumps(state))


def _omega_session(r3, ch, monkeypatch):
    bridge = load_bridge()

    def via_host(request, timeout):
        path = request.full_url.split("http://hive.test", 1)[1]
        data = json.loads(request.data) if request.data else None
        r = r3.client.request(request.get_method(), path, headers={"Authorization": request.get_header("Authorization")},
                              json=data)
        if r.status_code >= 400:
            import io
            import urllib.error
            raise urllib.error.HTTPError(request.full_url, r.status_code, "x", {}, io.BytesIO(r.content))

        class Answer:
            def read(self):
                return r.content

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        return Answer()
    monkeypatch.setattr(bridge, "_open", via_host)
    ChannelHub.daemon = ch.daemon
    monkeypatch.setattr(R3, "Hub", ChannelHub)
    session = open_session(r3)
    sid = session["session_id"]
    m = mount(r3, sid, session["stream_id"]).json()
    ack = upload(r3, sid, m, 1).json()
    drive(r3)
    assert wait_for(lambda: (step_row(r3, sid, 1) or {}).get("delivered_at") is not None)
    monkeypatch.setenv("HIVE_API_URL", "http://hive.test")
    monkeypatch.setenv("HIVE_WS_TOKEN", token_now(r3))
    return bridge, session, sid, m, ack


@pytest.mark.parametrize("published_before_crash", [False, True])
def test_R62_after_a_crash_in_flight_the_redelivered_step_is_not_killed_by_publish(r3, ch, monkeypatch,
                                                                                    published_before_crash):
    """Kimi's sharpest point: read step, context, (publish), crash in flight, redelivered read, publish: the step goes on."""
    try:
        bridge, session, sid, m, ack = _omega_session(r3, ch, monkeypatch)
        f = fields(ch.getLastMessage())
        ex = f["studio_execution_id"]
        seen = json.loads(bridge.context(sid, ex))
        body = '{"schema":"omega-maker-revision-2","items":[{"op_id":"op-redo-1"}]}'
        parent = "none" if seen["parent"] is None else str(seen["parent"])
        if published_before_crash:
            assert bridge.publish(seen["proposal_artifact_id"], ex, parent, body).startswith("HIVE-STUDIO-PUBLISHED ")
        _crash_in_flight(ch)
        again = fields(ch.getLastMessage())                                # the next process
        assert again["redelivered"] == "1" and again["studio_already_started"] == "possible"
        second = json.loads(bridge.context(sid, again["studio_execution_id"]))
        assert second["already_started"] is True and second["preview"] is False
        out = bridge.publish(seen["proposal_artifact_id"], ex, parent, body)
        assert out.startswith("HIVE-STUDIO-PUBLISHED"), out
        row = step_row(r3, sid, 1)
        assert row["state"] == "admitted" and row["proposal_n"] is not None
        assert (f"r{row['proposal_n']} " in out) and (("already" in out) == published_before_crash)
        assert bridge.done(sid, "1", ex, "false").startswith("HIVE-STUDIO-DONE step 1 finished")
        digest = r3.hive.db.one("SELECT digest FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                                (seen["proposal_artifact_id"], row["proposal_n"]))["digest"]
        prop = {"artifact_id": seen["proposal_artifact_id"], "revision": row["proposal_n"], "digest": digest}
        assert outcome(r3, sid, 1, m, prop, ack).status_code == 200
    finally:
        ChannelHub.daemon = None


def test_R62_the_mcp_publish_answers_the_existing_proposal_for_the_same_execution(r3):
    session, sid, m, ack, step = started(r3)
    mcp_ok(r3, "hive_studio_context", {"session_id": sid, "execution_id": step["execution_id"]})
    args = {"artifact_id": session["proposal_artifact_id"], "execution_id": step["execution_id"], "parent": None,
            "body": json.dumps({"items": [{"op_id": "op-m-1"}]})}
    first = mcp_ok(r3, "hive_studio_publish", args)
    again = mcp_ok(r3, "hive_studio_publish", dict(args, body=json.dumps({"items": [{"op_id": "op-m-2"}]})))
    assert again["already_published"] is True and again["revision"] == first["revision"]
    assert again["digest"] == first["digest"] and again["op_ids"] == ["op-m-1"]      # the proposal that counts
    assert "already_published" not in first and step_row(r3, sid, 1)["state"] == "admitted"
    assert mcp_code(mcp(r3, "hive_studio_publish", dict(args, execution_id="ex_" + "0" * 24))) == "execution_retired"


def test_R62_the_studio_import_is_exactly_the_loader_form_the_parser_reads(tmp_path):
    from hive.supervisor.workspace import STUDIO_IMPORT, STUDIO_MODULE
    assert STUDIO_IMPORT == f"!(import! &self (library OmegaClaw-Core ./modules/{STUDIO_MODULE}/entry.metta))"
    loader = tmp_path / "loader.metta"
    loader.write_text(STUDIO_IMPORT + "\n")
    assert load_parser()._enabled_module_names(loader) == [STUDIO_MODULE]
    assert (STUDIO_MODULE_DIR := ROOT / "modules" / STUDIO_MODULE / "entry.metta").exists(), STUDIO_MODULE_DIR
    from hive.supervisor.drivers import Supervisor
    assert Supervisor.STUDIO_MODULE == STUDIO_MODULE


@pytest.mark.parametrize("on", [True, False])
def test_R62_a_hand_edited_studio_import_fails_loudly_and_is_never_re_added(r3, monkeypatch, on):
    from hive.supervisor.workspace import RUN_METTA
    run = r3.workspace.path(r3.maker["id"]) / "run.metta"
    edited = RUN_METTA.replace("!(omegaclaw)", "!(import! &self (library OmegaClaw-Core  ./modules/hive_studio/entry.metta))"
                               "\n!(omegaclaw)")
    run.write_text(edited)
    monkeypatch.setattr(r3.hive.studio, "enabled", on)
    with pytest.raises(Exception) as e:
        r3.sup.start(r3.maker["id"])
    assert "hive_studio" in str(e.value)
    assert run.read_text() == edited                                    # untouched: not re-added, not half-removed


def test_R62_switching_studio_on_reaches_a_running_maker_at_its_step_handoff_start(r3, monkeypatch):
    """Stand-in #3: the switch applies at a mind's next start (a running mind is not restarted for it). A maker always
    takes a step on a fresh start: every step's handoff stops and starts it, so the step runs with the module loaded."""
    from hive.supervisor.workspace import RUN_METTA, STUDIO_IMPORT
    run = r3.workspace.path(r3.maker["id"]) / "run.metta"
    run.write_text(RUN_METTA)
    monkeypatch.setattr(r3.hive.studio, "enabled", False)
    envs = started_with(r3, monkeypatch)
    r3.sup.start(r3.maker["id"])
    assert "OMEGACLAW_EXTRA_MODULES" not in envs[-1] and STUDIO_IMPORT not in run.read_text()
    monkeypatch.setattr(r3.hive.studio, "enabled", True)                 # switched on while the maker runs
    assert STUDIO_IMPORT not in run.read_text() and len(envs) == 1      # nothing happens to the running process
    session, sid, m, ack, step = started(r3)                            # the step's handoff: verified stop, then start
    assert envs[-1]["OMEGACLAW_EXTRA_MODULES"] == "hive_studio" and STUDIO_IMPORT in run.read_text()
    assert ("stop", r3.maker["id"]) in r3.driver.calls
