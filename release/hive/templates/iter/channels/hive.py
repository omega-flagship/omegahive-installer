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
CONVERSATION = Path(".hive_conversation")   # the conversation of the last messages handed to the mind
WAITING = Path(".hive_waiting")             # present while that conversation waits for the mind's answer

# Reply binding (mind-chat-identity r2): each person talks to a mind in their own conversation, so a reply goes to the
# conversation of the messages it answers, never to whichever arrived last. receive() hands over one conversation at
# a time, stopping before a message from another one, and while a person's conversation waits for an answer it hands
# over nothing from any other (the inbox keeps it for a later cycle). send() answers the conversation it was handed.
# The hive's own notes (sender hive:...) wait for no answer, so they never hold anyone else back.


def receive():
    after = int(SEQ.read_text() or 0) if SEQ.exists() else 0
    result, error = _hive.call("GET", f"/api/agent/inbox?after={after}")
    if error or not result or not result.get("messages"):
        return ""
    held = CONVERSATION.read_text().strip() if WAITING.exists() and CONVERSATION.exists() else None
    conversation, lines, people = held, [], False
    for message in result["messages"]:
        try:
            envelope = json.loads(message["text"])
        except ValueError:
            envelope = {"text": message["text"]}
        this = str(envelope.get("conversation_id") or "")
        if conversation is None:
            conversation = this
        elif this != conversation:
            break                                  # another conversation: a later cycle, once this one is answered
        sender = str(envelope.get("sender", "unknown"))
        people = people or not sender.startswith("hive:")
        lines.append(f"{sender}: {envelope.get('text', '')}")
        after = max(after, int(message["seq"]))
    SEQ.write_text(str(after))
    if lines:
        CONVERSATION.write_text(conversation or "")
        if people:
            WAITING.write_text("1")
    return "\n".join(lines)


def send(content):
    payload = {"text": str(content)}
    conversation = CONVERSATION.read_text().strip() if CONVERSATION.exists() else ""
    if conversation:
        payload["conversation_id"] = conversation
    _hive.call("POST", "/api/agent/messages", payload)
    WAITING.unlink(missing_ok=True)
