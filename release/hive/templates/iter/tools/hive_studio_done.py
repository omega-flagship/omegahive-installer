import importlib.util
import urllib.parse
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Studio maker: finish step n of session ss_... with its execution_id; more = true when the piece needs another "
               "step of your own, else false. After this the step makes no more calls.")


def run(session_id, n, execution_id, more="false"):
    flag = more if isinstance(more, bool) else str(more).strip().lower() in ("true", "1", "yes")
    path = f"/api/agent/studio-sessions/{urllib.parse.quote(str(session_id), safe='')}/steps/{int(float(n))}/done"
    data, error = _hive.call("POST", path, {"more": flag, "execution_id": str(execution_id)})
    return error or f"step {data.get('n')} {data.get('state')} more={data.get('more')}"
