import importlib.util
from pathlib import Path

_kit = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("_hive", _kit / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)
_spec = importlib.util.spec_from_file_location("_hive_channel", _kit / "channels" / "hive.py")
_channel = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_channel)

DESCRIPTION = ("The one way to build software here (an app, page, game, tool, script or any change to code): say what "
               "to build in the asker's words and the hive offers it to your person in Create, whose code minds build "
               "it under its safeguards. Never write the code yourself.")


def run(sentence):
    payload = {"sentence": str(sentence).strip()}
    conversation = _channel.reply_conversation()   # the person send() would answer gets the offer
    if conversation:
        payload["conversation_id"] = conversation
    result, error = _hive.call("POST", "/api/agent/create", payload)
    return error or (f"HIVE-CREATE-OFFERED {result['id']}: your person can start it in Create from your chat, and "
                     "nothing is built until they do.")
