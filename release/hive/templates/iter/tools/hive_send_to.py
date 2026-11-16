import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Answer one hive conversation by its id (the [conversation ...] mark on a message you got), when it is not "
               "the latest one: send(channel=\"hive\") answers the latest.")


def run(conversation_id, content):
    conversation_id = str(conversation_id).strip()
    if not conversation_id or conversation_id == "none":
        return "HIVE-ERROR bad_request: give the conversation id from the [conversation ...] mark"
    result, error = _hive.call("POST", "/api/agent/messages", {"text": str(content), "conversation_id": conversation_id})
    return error or f"sent to {conversation_id}"
