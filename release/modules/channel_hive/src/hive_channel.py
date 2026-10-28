"""OmegaDots Hive channel: this agent's connection to the hive agent hub.

The WebSocket lives in a separate daemon process (``python hive_channel.py
--daemon``).  Under janus, Python threads inside the agent only run while
Prolog is in a py-call, so an in-process socket would stall whenever the loop
sleeps: no keepalives, no reconnects, no inbound messages.  The daemon talks
to the agent through files in ``$OMEGACLAW_MEMORY_DIR/hive/``:

  inbox.jsonl     daemon appends {"seq", "text"}; agent reads past its admission cursor
  admission.json  agent: {offset, admitted, archived, inflight, conflicts, archived_repeats}
                  (inbox.offset is the legacy cursor it migrates from)
  outbox.jsonl    agent appends agent_message frames; daemon sends past outbox.offset
  state.json      daemon: last_seen_seq (survives restarts, so resume after a
                  sleep/wake replays only what the agent has not seen)
  status.json     daemon: connected, counters
  daemon.pid

Wire protocol (same frames as upstream singnet/Omega channels/wschat.py):

  hub -> agent   {"type": "user_message", "seq": <int>, "text": <str>}
                 {"type": "ack", ...} / {"type": "error", "code", "message"}
  agent -> hub   {"type": "resume", "last_seen_seq": <int|null>}  (every connect)
                 {"type": "agent_message", "client_seq": <hex>, "text": <str>,
                  "conversation_id": <str, optional>}

Hive extension: a user_message ``text`` may be a JSON envelope
``{"hive": 1, "sender", "conversation_id", "text", ...}``.  The agent sees it
as a CHANNEL_EVENT block, and replies carry that conversation_id.

Mind control (r2.12 §3): an envelope may carry ``mind_prompt {child_id, rev,
mode}``, a controller's prompt revision for this child.

- Identity (Code's reviewed guard e964764e): a prompt envelope is admitted only
  when it parses and names this process's own HIVE_AGENT_ID (set by the
  supervisor).  Malformed, foreign or unbound prompt envelopes stay in the raw
  inbox but never become native input or an ACK.
- Admission (one commit point): admission.json holds the inbox cursor, the
  admitted (child, rev, body digest) set and the in-flight batch, written
  together atomically before getLastMessage returns.  A failed write raises
  and advances nothing, so the same records are read again.  The batch a
  process received is committed by that same process's next call (it came back
  for more); after a restart the uncommitted batch is handed out again, so
  input lost between return and use is redelivered (at least once, marked
  ``redelivered=1``).  A corrupt admission.json refuses to read (fail closed,
  shown by status()), never guesses a cursor.
- ACK: the daemon sends the child's own ``{"type": "prompt_ack", child_id,
  rev}`` from admission.json only, so an ACK means the revision is durably
  retained for this mind's turns, never websocket receipt.  The hub answers
  ``status``: acknowledged or duplicate (confirmed, never re-sent) or refused
  (recorded in refused.json, retried only after a reconnect).
- A revision seen again with the same body is not admitted twice; with a
  different body it is refused (conflicts in admission.json), not published.
- Retention (Review B5): ``admitted`` keeps the body digest of at most
  ADMITTED_KEEP revisions.  Older revisions are compacted, never forgotten:
  their numbers move into ``archived`` ({child: [[lo, hi], ...]} merged
  ranges), so any later copy of them, identical or altered, is refused for
  good (recorded under ``archived_repeats``; the body can no longer be compared).
  Only a revision the hub has confirmed (confirmed.json) and that is not in the
  in-flight batch is ever compacted, so pending ACKs and in-flight custody stay.
  The range record does not depend on arrival order.
- Order: prompts are returned in hub sequence order, which is the host's
  revision order; the mode is passed on, not applied.

Studio steps (J3 host R6, open item OI-10): the host sends a maker
``{"type": "studio_step", "session_id", "step", "epoch", "delivery_id",
"execution_id"}`` when it admits a step.  It is never a ``messages`` row, so
it has no seq, is never replayed by ``resume`` and never moves
last_seen_seq.  The daemon checks its shape, keeps one inbox record per
(session, step, epoch, delivery_id) (studio_seen.json survives restarts) and
the agent reads it as one ``event=studio_step`` CHANNEL_EVENT naming the
session, step and execution_id.  Only that frame type makes the event: a
message whose text looks like a step is an ordinary message.  Nothing is sent
back; the step counts as read when the maker's context call names its
execution_id.  The inbox cursor's at-least-once rule applies (a batch handed
to a process that ended comes back marked ``redelivered=1``).
"""

from __future__ import annotations

import json
import os
import pathlib
import random
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

POLL_SECONDS = 0.1
ADMITTED_KEEP = 1000
PROMPT_MODES = ("queued", "steer")
STUDIO_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
STUDIO_SEEN_KEEP = 1000


# ---- shared file layout ------------------------------------------------------

def channel_dir(memory_dir=None) -> pathlib.Path:
    base = memory_dir or os.environ.get("OMEGACLAW_MEMORY_DIR") or (
        pathlib.Path(__file__).resolve().parents[3] / "memory"
    )
    path = pathlib.Path(base) / "hive"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_json(path, default):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path, value):
    tmp = pathlib.Path(f"{path}.tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path, value):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")


def _pid_alive(pid):
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return False
    try:
        # Reap the daemon if it is our exited child; a zombie still answers kill(0).
        if os.waitpid(pid, os.WNOHANG)[0] == pid:
            return False
    except ChildProcessError:
        pass
    except OSError:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# ---- agent side (called from MeTTa via py-call) ---------------------------------

def _python_executable():
    # Embedded in SWI-Prolog via janus, sys.executable is the swipl binary.
    configured = os.environ.get("HIVE_PYTHON")
    if configured:
        return configured
    if pathlib.Path(sys.executable).name.startswith("python"):
        return sys.executable
    return shutil.which("python3") or shutil.which("python") or "python3"


# Reply binding (mind-chat-identity r2). Each person talks to a mind in their own conversation, so a reply must go to
# the conversation of the message it answers, never to whichever one arrived last. ``_pending`` holds, in arrival
# order, the conversations this mind received and has not answered; a plain ``send`` answers the only one waiting and
# is refused (fail closed, nothing sent) when more than one is waiting: then the mind names it with
# ``send-hive-to conversation_id message`` (each event's explicit_reply_affordance carries its id). With none waiting, a
# plain send continues the conversation it last spoke in. Never "last received" across different conversations.
_pending: list = []
_current = ""
_seen: set = set()


def start_hive(ws_url="", ws_token=""):
    url = str(ws_url or os.environ.get("HIVE_WS_URL", "")).strip()
    token = str(ws_token or os.environ.get("HIVE_WS_TOKEN", "")).strip()
    if not url:
        return "HIVE-CHANNEL-DISABLED missing HIVE_WS_URL"
    folder = channel_dir()
    pid, owner, launch = _daemon_record(folder)
    if launch == _launch_id() and pid and _pid_alive(pid):
        if owner == os.getpid():
            return f"HIVE-CHANNEL-ALREADY-RUNNING pid={pid}"
        # Left over from a previous agent process of this launch: it is about to exit on its
        # own, so replace it rather than adopt it.
        _terminate(pid)
    # A record from another launch is never adopted or signalled: in a mind's own pid namespace the same pids come
    # back at every launch, so its pid may now be an unrelated process (2026-10-08: the channel answered
    # ALREADY-RUNNING and no cloud mind rejoined after a restart). That daemon exits once its owner is gone.
    env = dict(os.environ, HIVE_WS_URL=url, HIVE_WS_TOKEN=token, HIVE_CHANNEL_DIR=str(folder))
    process = subprocess.Popen(
        [_python_executable(), str(pathlib.Path(__file__).resolve()), "--daemon", str(os.getpid())],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=open(folder / "daemon.log", "a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    _write_json(folder / "daemon.pid", {"pid": process.pid, "owner": os.getpid(), "launch": _launch_id()})
    return f"HIVE-CHANNEL-STARTED {url} pid={process.pid}"


def _launch_id():
    """This mind launch's identity: HIVE_LAUNCH_ID, new at every start (hive/supervisor/drivers.py Supervisor.env).
    Without it (an older host), this agent process, which keeps the old pid-only behaviour."""
    return os.environ.get("HIVE_LAUNCH_ID") or f"pid:{os.getpid()}"


def _daemon_record(folder):
    """(pid, owner, launch) of the recorded daemon. An old record without a launch belongs to no current launch."""
    record = _read_json(folder / "daemon.pid", None)
    if isinstance(record, dict):
        return record.get("pid"), record.get("owner"), record.get("launch")
    return record, None, None


def _terminate(pid, timeout=5.0):
    try:
        os.kill(int(pid), signal.SIGTERM)
    except OSError:
        return
    deadline = time.time() + timeout
    while time.time() < deadline and _pid_alive(pid):
        time.sleep(0.05)


def stop_hive():
    pid, _, launch = _daemon_record(channel_dir())
    if launch == _launch_id() and pid and _pid_alive(pid):   # only this launch's own daemon
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError:
            pass
    return "HIVE-CHANNEL-STOPPED"


def _room_text(envelope):
    """A room message carries which room, who spoke, and a short digest of what this mind missed there (R15)."""
    text = envelope.get("text", "")
    room = envelope.get("room")
    if not isinstance(room, dict):
        return text
    lines = []
    earlier = envelope.get("earlier")
    if isinstance(earlier, list) and earlier:
        lines.append("Earlier in this room:")
        lines += [f"- {e}" for e in earlier[:8]]
    who = envelope.get("sender_name") or envelope.get("sender", "someone")
    notice = envelope.get("notice")
    if isinstance(notice, str) and notice.strip():
        lines.append(f"Note: {notice.strip()[:300]}")    # e.g. the Coffee Room is readable by the whole hive
    lines.append(f"[{room.get('name', 'room')} ({room.get('kind', 'room')})] {who}: {text}")
    return "\n".join(lines)


def _received(conversation):
    """Note a conversation that is now waiting for this mind's answer."""
    _seen.add(conversation)
    if conversation not in _pending:
        _pending.append(conversation)


def _event_text(text):
    """A hive envelope becomes a CHANNEL_EVENT block; plain text passes through."""
    try:
        envelope = json.loads(text)
    except (ValueError, TypeError):
        return text
    if not isinstance(envelope, dict) or envelope.get("hive") != 1:
        return text
    conversation = str(envelope.get("conversation_id") or "")
    if conversation:
        _received(conversation)
    event = {
        "event": envelope.get("event", "message"),
        "channel": "hive",
        "route": envelope.get("route", "primary"),
        "conversation_id": conversation,
        "message_id": envelope.get("message_id", ""),
        "sender": envelope.get("sender", "unknown"),
        "text": _room_text(envelope),
    }
    if conversation:   # the handle to answer this message by, whoever else is waiting
        event["explicit_reply_affordance"] = f"send-hive-to {conversation} message"
    try:
        import router

        block = router.normalize_channel_event(event)
        if block:
            return block
    except Exception:
        pass
    return "\n".join(["CHANNEL_EVENT"] + [f"{k}={v}" for k, v in event.items() if v != ""])


def _mind_prompt(text):
    """(child_id, rev, mode) of a well-formed mind_prompt in a hive envelope, else None (then it is just a message)."""
    try:
        envelope = json.loads(text)
    except (ValueError, TypeError):
        return None
    prompt = envelope.get("mind_prompt") if isinstance(envelope, dict) and envelope.get("hive") == 1 else None
    if not isinstance(prompt, dict):
        return None
    child, rev, mode = prompt.get("child_id"), prompt.get("rev"), prompt.get("mode")
    if not isinstance(child, str) or not child or type(rev) is not int or rev < 1 or mode not in PROMPT_MODES:
        return None
    return child, rev, mode


def _with_prompt(block, prompt):
    lines = block.split("\n")
    return "\n".join(lines[:1] + [f"mind_prompt_rev={prompt[1]}", f"mind_prompt_mode={prompt[2]}"] + lines[1:])


def _has_mind_prompt(text):
    try:
        envelope = json.loads(text)
    except (ValueError, TypeError):
        return False
    return isinstance(envelope, dict) and envelope.get("hive") == 1 and "mind_prompt" in envelope


def _ack_frame(child, rev):
    return {"type": "prompt_ack", "child_id": child, "rev": rev}


class AdmissionCorrupt(RuntimeError):
    pass


def _digest(text):
    import hashlib
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _admission(folder):
    """The agent's admission state; legacy inbox.offset seeds a fresh one. Unreadable state raises (fail closed)."""
    path = folder / "admission.json"
    if not path.exists():
        return {"offset": int(_read_json(folder / "inbox.offset", 0) or 0), "admitted": [], "archived": {},
                "inflight": None, "conflicts": [], "archived_repeats": []}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(state, dict) and type(state["offset"]) is int and state["offset"] >= 0
        assert isinstance(state["admitted"], list) and all(isinstance(a, list) and len(a) == 3 for a in state["admitted"])
        assert state["inflight"] is None or (isinstance(state["inflight"], dict) and isinstance(state["inflight"]["records"], list))
        state.setdefault("conflicts", [])
        state.setdefault("archived", {})
        state.setdefault("archived_repeats", [])
        assert isinstance(state["archived"], dict) and all(
            isinstance(ranges, list) and all(isinstance(r, list) and len(r) == 2 and type(r[0]) is int
                                             and type(r[1]) is int and 1 <= r[0] <= r[1] for r in ranges)
            for ranges in state["archived"].values())
        return state
    except Exception:
        raise AdmissionCorrupt(f"admission state {path} is unreadable; nothing is read until an operator repairs it") from None


def _archived(ranges, rev):
    return any(lo <= rev <= hi for lo, hi in ranges)


def _archive(ranges, rev):
    """Merged, sorted [lo, hi] ranges with rev added."""
    merged = []
    for lo, hi in sorted(ranges + [[rev, rev]]):
        if merged and lo <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return merged


def _compact(state, folder):
    """Move the oldest confirmed, not-in-flight digests beyond ADMITTED_KEEP into the durable range record.

    Nothing is dropped: an unconfirmed revision (its ACK still pending) or one in the in-flight batch stays in
    ``admitted`` however long the list grows, and a compacted revision stays refused through ``archived``."""
    excess = len(state["admitted"]) - ADMITTED_KEEP
    if excess <= 0:
        return
    confirmed = set(_read_json(folder / "confirmed.json", []) or [])
    held = set()
    for record in (state["inflight"] or {}).get("records", []):
        prompt = _mind_prompt(str(record.get("text", "")))
        if prompt:
            held.add((prompt[0], prompt[1]))
    kept = []
    for entry in state["admitted"]:
        child, rev = entry[0], entry[1]
        if excess > 0 and rev in confirmed and (child, rev) not in held:
            state["archived"][child] = _archive(state["archived"].get(child, []), rev)
            excess -= 1
        else:
            kept.append(entry)
    state["admitted"] = kept


def _inbox_after(folder, offset):
    try:
        with open(folder / "inbox.jsonl", "rb") as handle:
            handle.seek(offset)
            data = handle.read()
    except FileNotFoundError:
        return [], offset
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    records = []
    for line in data[: end + 1].splitlines():
        if line.strip():
            try:
                records.append(json.loads(line))
            except ValueError:
                pass
    return records, offset + end + 1


def _block(text, redelivered=False):
    block, prompt = _event_text(text), _mind_prompt(text)
    if prompt:
        block = _with_prompt(block, prompt)
    if redelivered:
        lines = block.split("\n")
        block = "\n".join(lines[:1] + ["redelivered=1"] + lines[1:])
    return block


def _studio_step(frame):
    """The checked fields of a host studio_step frame, or None (a malformed frame is dropped)."""
    if not isinstance(frame, dict):
        return None
    sid, n, epoch, delivery, execution = (frame.get(k) for k in ("session_id", "step", "epoch", "delivery_id", "execution_id"))
    if not all(isinstance(v, str) and STUDIO_ID.fullmatch(v) for v in (sid, delivery, execution)):
        return None
    if type(n) is not int or n < 1 or type(epoch) is not int or epoch < 0:
        return None
    return {"session_id": sid, "step": n, "epoch": epoch, "delivery_id": delivery, "execution_id": execution}


def _studio_block(step, redelivered=False):
    """One Studio step as the maker reads it: a CHANNEL_EVENT naming the session, step and execution, and its three calls."""
    lines = ["CHANNEL_EVENT"] + (["redelivered=1"] if redelivered else []) + [
        "event=studio_step", "channel=hive", "route=studio", f"message_id={step['delivery_id']}", "sender=hive",
        f"studio_session_id={step['session_id']}", f"studio_step={step['step']}",
        f"studio_execution_id={step['execution_id']}", f"studio_epoch={step['epoch']}",
        f"studio_delivery_id={step['delivery_id']}",
    ] + (["studio_already_started=possible"] if redelivered else []) + [
        "text=" + (("A process that ended may already have started this step: call context first; if it answers "
                    "already_started, publish at most the one proposal (a second publish answers the existing one), then "
                    "finish. ") if redelivered else "") +
        (f"Studio step {step['step']} of session {step['session_id']} is yours (execution_id {step['execution_id']}). "
         f"First hive_studio_context session_id={step['session_id']} execution_id={step['execution_id']}; then publish at "
         f"most one proposal with hive_studio_publish (artifact_id and parent from the context, execution_id, the body's "
         f"items each carrying an op_id); then hive_studio_done session_id={step['session_id']} n={step['step']} "
         f"execution_id={step['execution_id']} more=true|false. As skills: hive-studio-context {step['session_id']} "
         f"{step['execution_id']} | hive-studio-publish ar_id {step['execution_id']} parent_or_none {{json}} | "
         f"hive-studio-done {step['session_id']} {step['step']} {step['execution_id']} true|false."),
        "reply_affordance=none: a Studio step is answered by its tools, not by a chat message",
    ]
    return "\n".join(lines)


def _record_block(record, redelivered=False):
    if record.get("kind") == "studio_step":
        step = _studio_step(record.get("studio"))
        return _studio_block(step, redelivered) if step else ""
    return _block(str(record.get("text", "")), redelivered=redelivered)


def getLastMessage():
    folder = channel_dir()
    state = _admission(folder)
    me = os.getpid()
    out = []
    inflight = state["inflight"]
    if inflight and inflight.get("pid") != me:                 # handed to a process that ended before coming back
        out += [b for b in (_record_block(r, redelivered=True) for r in inflight["records"]) if b]
        carried = list(inflight["records"])
    else:
        carried = []                                           # same process came back: its batch was consumed
    records, offset = _inbox_after(folder, state["offset"])
    own = os.environ.get("HIVE_AGENT_ID")
    admitted = {(a[0], a[1]): a[2] for a in state["admitted"]}
    batch = []
    for record in records:
        if record.get("kind") == "studio_step":                # written by this daemon from the host's frame only
            block = _record_block(record)
            if block:
                batch.append(record)
                out.append(block)
            continue
        text = str(record.get("text", ""))
        prompt = _mind_prompt(text)
        if _has_mind_prompt(text) and (prompt is None or not own or prompt[0] != own):
            # Retain the raw inbox record; do not publish or ACK a malformed,
            # foreign or unbound control prompt as ordinary native input.
            continue
        if prompt:
            key, digest = (prompt[0], prompt[1]), _digest(text)
            if key in admitted:
                if admitted[key] != digest:
                    state["conflicts"].append([prompt[0], prompt[1], digest])
                continue                                       # admitted once; never applied twice
            if _archived(state["archived"].get(prompt[0], []), prompt[1]):
                state["archived_repeats"].append([prompt[0], prompt[1], digest])
                continue                                       # compacted, still admitted once: refused for good
            admitted[key] = digest
            state["admitted"].append([prompt[0], prompt[1], digest])
        batch.append(record)
        out.append(_block(text))
    state.update(offset=offset, conflicts=state["conflicts"][-ADMITTED_KEEP:],
                 archived_repeats=state["archived_repeats"][-ADMITTED_KEEP:],
                 inflight={"pid": me, "records": carried + batch} if carried + batch else None)
    _compact(state, folder)
    _write_json(folder / "admission.json", state)              # the one commit point: cursor, admission, in-flight batch
    return "\n\n".join(out)


def _queue(message, conversation):
    global _current
    payload = {"type": "agent_message", "client_seq": uuid.uuid4().hex, "text": message}
    if conversation:
        payload["conversation_id"] = conversation
        if conversation in _pending:
            _pending.remove(conversation)
        _current = conversation
    _append_jsonl(channel_dir() / "outbox.jsonl", payload)
    return "HIVE-MESSAGE-QUEUED"


def send_message(text):
    message = str(text).replace("\\n", "\n").replace("\r", "")
    if not message:
        return ""
    if len(_pending) > 1:
        return ("HIVE-REPLY-AMBIGUOUS nothing was sent: messages from " + str(len(_pending)) + " conversations are waiting ("
                + ", ".join(_pending) + "); answer each with send-hive-to conversation_id message")
    return _queue(message, _pending[0] if _pending else _current)


def send_to(conversation, text):
    """Answer one conversation by its id (shown on each event as explicit_reply_affordance)."""
    conversation = str(conversation or "").strip().strip('"')
    message = str(text).replace("\\n", "\n").replace("\r", "")
    if not message:
        return ""
    if conversation not in _seen:
        return f"HIVE-REPLY-UNKNOWN-CONVERSATION nothing was sent: {conversation or '(none)'} is not a conversation this mind received"
    return _queue(message, conversation)


def status():
    folder = channel_dir()
    state = _read_json(folder / "status.json", {})
    pid, _, launch = _daemon_record(folder)
    pid = pid if launch == _launch_id() else None   # another launch's pid says nothing about this launch's daemon
    try:
        _admission(folder)
        admission = "ok"
    except AdmissionCorrupt:
        admission = "corrupt"
    return (
        f"HIVE-CHANNEL connected={str(bool(state.get('connected'))).lower()} "
        f"daemon={'alive' if pid and _pid_alive(pid) else 'down'} url={state.get('url', '')} "
        f"last_seen_seq={state.get('last_seen_seq')} received={state.get('received', 0)} "
        f"sent={state.get('sent', 0)} reconnects={state.get('reconnects', 0)} admission={admission}"
    )


# ---- daemon side -------------------------------------------------------------------

class _Daemon:
    def __init__(self, folder, url, token, parent_pid):
        self.folder = pathlib.Path(folder)
        self.url = url
        self.token = token
        self.parent_pid = parent_pid
        self.running = True
        self.last_seen_seq = _read_json(self.folder / "state.json", {}).get("last_seen_seq")
        self.stats = {"received": 0, "sent": 0, "reconnects": 0}
        self.connected = False
        self.acked = set()

    def write_status(self):
        _write_json(
            self.folder / "status.json",
            dict(self.stats, connected=self.connected, url=self.url, last_seen_seq=self.last_seen_seq),
        )

    def parent_gone(self):
        return self.parent_pid and not _pid_alive(self.parent_pid)

    def deliver(self, frame):
        kind = frame.get("type")
        if kind == "user_message":
            seq, text = frame.get("seq"), frame.get("text")
            if not isinstance(seq, int) or not isinstance(text, str):
                return
            if self.last_seen_seq is not None and seq <= self.last_seen_seq:
                return
            _append_jsonl(self.folder / "inbox.jsonl", {"seq": seq, "text": text})
            self.last_seen_seq = seq
            _write_json(self.folder / "state.json", {"last_seen_seq": seq})
            self.stats["received"] += 1
            self.write_status()
        elif kind == "prompt_ack":
            # acknowledged or duplicate: the hub has it, never re-sent. refused: kept apart, retried after a reconnect.
            rev, status = frame.get("rev"), frame.get("status") or ("acknowledged" if frame.get("acknowledged") else "refused")
            if type(rev) is int:
                name = "confirmed.json" if status in ("acknowledged", "duplicate") else "refused.json"
                seen = set(_read_json(self.folder / name, []) or [])
                seen.add(rev)
                if name == "confirmed.json":
                    # Keep every confirmation the agent may still need to compact; once a revision has left
                    # admission's digest list its confirmation is no longer read. Never truncated by count, so a
                    # pending revision is not re-ACKed forever and an admitted one is never left uncompactable.
                    try:
                        live = {a[1] for a in _admission(self.folder)["admitted"]}
                        seen = {r for r in seen if r in live} | {rev}
                    except AdmissionCorrupt:
                        pass
                    _write_json(self.folder / name, sorted(seen))
                else:
                    _write_json(self.folder / name, sorted(seen)[-ADMITTED_KEEP:])
        elif kind == "studio_step":
            self.studio_step(frame)
        elif kind == "error":
            print(f"hive error {frame.get('code')}: {frame.get('message')}", flush=True)

    def studio_step(self, frame):
        """OI-10: one inbox record per (session, step, epoch, delivery_id); last_seen_seq and state.json are untouched."""
        step = _studio_step(frame)
        if step is None:
            print("hive studio_step frame dropped: malformed", flush=True)
            return
        path = self.folder / "studio_seen.json"
        seen = _read_json(path, []) or []
        key = [step["session_id"], step["step"], step["epoch"], step["delivery_id"]]
        if key in seen:
            return
        # R6.2: the inbox record is the journal. A crash after the append and before the seen write leaves the record;
        # the same frame presented again finds it there, repairs the seen key and adds nothing (exactly once, never lost).
        if not self._studio_recorded(key):
            _append_jsonl(self.folder / "inbox.jsonl", {"seq": None, "kind": "studio_step", "studio": step})
        _write_json(path, (seen + [key])[-STUDIO_SEEN_KEEP:])
        self.stats["studio_steps"] = self.stats.get("studio_steps", 0) + 1
        self.write_status()

    def _studio_recorded(self, key):
        try:
            data = (self.folder / "inbox.jsonl").read_bytes()
        except FileNotFoundError:
            return False
        if key[3].encode() not in data:                 # the delivery id is unique per step: a cheap pre-filter
            return False
        for line in data.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            step = record.get("studio") if isinstance(record, dict) and record.get("kind") == "studio_step" else None
            if isinstance(step, dict) and [step.get("session_id"), step.get("step"), step.get("epoch"),
                                           step.get("delivery_id")] == key:
                return True
        return False

    def flush_outbox(self, ws):
        """Send queued agent messages; the offset only advances past sent ones."""
        offset_path = self.folder / "outbox.offset"
        offset = int(_read_json(offset_path, 0) or 0)
        try:
            with open(self.folder / "outbox.jsonl", "rb") as handle:
                handle.seek(offset)
                data = handle.read()
        except FileNotFoundError:
            return
        for line in data.splitlines(keepends=True):
            if not line.endswith(b"\n"):
                break
            if line.strip():
                ws.send(line.decode("utf-8").strip())
                self.stats["sent"] += 1
            offset += len(line)
            _write_json(offset_path, offset)
            self.write_status()

    def send_acks(self, ws):
        """ACK each admitted revision (admission.json) the hub has not confirmed, once per connection."""
        try:
            admitted = _admission(self.folder)["admitted"]
        except AdmissionCorrupt:
            return
        confirmed = set(_read_json(self.folder / "confirmed.json", []) or [])
        for child, rev, _digest_ in admitted:
            if rev not in confirmed and (child, rev) not in self.acked:
                ws.send(json.dumps(_ack_frame(child, rev)))
                self.acked.add((child, rev))

    def session(self):
        from websockets.sync.client import connect

        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        with connect(self.url, additional_headers=headers, open_timeout=15,
                     ping_interval=20, ping_timeout=20, max_size=64 * 1024) as ws:
            self.connected = True
            ws.send(json.dumps({"type": "resume", "last_seen_seq": self.last_seen_seq}))
            self.acked = set()                                # a new connection: unconfirmed acks go again
            self.write_status()
            while self.running and not self.parent_gone():
                self.flush_outbox(ws)
                self.send_acks(ws)
                try:
                    raw = ws.recv(timeout=POLL_SECONDS)
                except TimeoutError:
                    continue
                try:
                    frame = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(frame, dict):
                    self.deliver(frame)

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "running", False))
        backoff = 1.0
        self.write_status()
        while self.running and not self.parent_gone():
            try:
                self.session()
                backoff = 1.0
            except Exception as exc:
                print(f"hive connection error: {exc}", flush=True)
            self.connected = False
            self.write_status()
            if not self.running or self.parent_gone():
                break
            self.stats["reconnects"] += 1
            delay = min(backoff, 30.0) * (1.0 + random.uniform(0.0, 0.2))
            end = time.time() + delay
            while time.time() < end and self.running and not self.parent_gone():
                time.sleep(POLL_SECONDS)
            backoff = min(backoff * 2.0, 30.0)
        self.write_status()


def _daemon_main(argv):
    parent = int(argv[0]) if argv and argv[0].isdigit() else 0
    folder = os.environ.get("HIVE_CHANNEL_DIR") or str(channel_dir())
    _Daemon(folder, os.environ.get("HIVE_WS_URL", ""), os.environ.get("HIVE_WS_TOKEN", ""), parent).run()


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--daemon":
    _daemon_main(sys.argv[2:])
