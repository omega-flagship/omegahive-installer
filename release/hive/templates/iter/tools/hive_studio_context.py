import importlib.util
import json
import urllib.parse
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Studio maker: read your session context first in every step (session ss_..., the step's execution_id ex_..., "
               "after_dir = last direction seq you read or empty). Returns the step, the piece, the person's directions "
               "and the expected parent as JSON.")


def run(session_id, execution_id="", after_dir=""):
    query = {k: str(v) for k, v in (("execution_id", execution_id), ("after_dir", after_dir)) if str(v or "").strip()}
    path = f"/api/agent/studio-sessions/{urllib.parse.quote(str(session_id), safe='')}/context"
    if query:
        path += "?" + urllib.parse.urlencode(query)
    data, error = _hive.call("GET", path)
    return error or json.dumps(data, separators=(",", ":"), ensure_ascii=False)
