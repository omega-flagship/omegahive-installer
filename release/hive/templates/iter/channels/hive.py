"""Hive channel for Iter: polls the hive's HTTP inbox and replies over HTTP.

Iter calls receive() every cycle in a short-lived subprocess, so this keeps no
connection; the last seen sequence number is kept in .hive_seq.
"""

import importlib.util
import json
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

SEQ = Path(".hive_seq")
CONVERSATION = Path(".hive_conversation")   # the conversation of the latest message handed to the mind
WAITING = Path(".hive_waiting")             # the old hold (below); removed where an earlier kit left it

# Reply binding: a reply goes to a conversation the mind was handed, never to whichever arrived meanwhile. receive()
# hands over every new message at once, each line marked with its conversation ("[conversation r_...]") when there
# is more than one, and nothing is ever held back: a conversation the mind does not answer (often another mind's
# "thanks") must never block the others (the owner, 2026-11-11; the old one-conversation-at-a-time hold did). send()
# answers the conversation of the latest message handed over; hive_send_to answers any other by its id.
# The hive's own notes (sender hive:...) are shown too and need no answer. (Ported from flagship #75, 9c393205.)


def _ask_earlier(envelope):
    """What the person said in the Ask that this mind has not heard, which their own-chat message carries (ask_earlier),
    as lines before it: the mind answers with it in the same cycle, so no model call is added."""
    asked = envelope.get("ask_earlier")
    if not isinstance(asked, list) or not asked:
        return ""
    lines = [f"- {a}" for a in asked[:8] if isinstance(a, str)]
    return "Earlier, in the Ask (oldest first; already answered there, so context, not new requests):\n" + "\n".join(lines) + "\n"


def receive():
    WAITING.unlink(missing_ok=True)
    after = int(SEQ.read_text() or 0) if SEQ.exists() else 0
    result, error = _hive.call("GET", f"/api/agent/inbox?after={after}")
    if error or not result or not result.get("messages"):
        return ""
    entries = []
    for message in result["messages"]:
        try:
            envelope = json.loads(message["text"])
        except ValueError:
            envelope = {"text": message["text"]}
        sender = str(envelope.get("sender", "unknown"))
        who = f"{envelope['sender_name']} ({sender})" if envelope.get("sender_name") else sender
        entries.append((str(envelope.get("conversation_id") or ""), _ask_earlier(envelope) + f"{who}: {envelope.get('text', '')}"))
        after = max(after, int(message["seq"]))
    SEQ.write_text(str(after))
    if not entries:
        return ""
    latest = entries[-1][0]
    CONVERSATION.write_text(latest)
    if len({c for c, _ in entries}) == 1:
        return "\n".join(line for _, line in entries)
    lines = [f"[conversation {c or 'none'}] {line}" for c, line in entries]
    lines.append(f"(send answers conversation {latest or 'none'}; answer another with hive_send_to)")
    return "\n".join(lines)


def reply_conversation():
    """The conversation send() answers: the latest one handed to the mind, or "" before any (tools/hive_create too)."""
    return CONVERSATION.read_text().strip() if CONVERSATION.exists() else ""


def send(content):
    payload = {"text": str(content)}
    conversation = reply_conversation()
    if conversation:
        payload["conversation_id"] = conversation
    _hive.call("POST", "/api/agent/messages", payload)
