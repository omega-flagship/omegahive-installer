import importlib.util
import json
import re
import urllib.parse
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = ("Studio maker: publish this step's one proposal to the session's proposal artifact (ar_...). body is the exact "
               "omega-maker-revision-2 JSON text; its items[].op_id (1-16, distinct, new in this session) are sent beside it, "
               "unchanged. execution_id is the step's; parent is the context's parent (empty for none).")
OP_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}")   # the host's shape (L6 wire contract)
MAX_OPS = 16


def _op_ids(body):
    """The op ids exactly as the body's items carry them, in order; never minted or rewritten. None when not 1-16 distinct."""
    try:
        items = json.loads(body).get("items")
    except (ValueError, AttributeError):
        return None
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_OPS:
        return None
    ops = [item.get("op_id") if isinstance(item, dict) else None for item in items]
    if not all(isinstance(op, str) and OP_ID.fullmatch(op) for op in ops) or len(set(ops)) != len(ops):
        return None
    return ops


def run(artifact_id, body, execution_id, parent=""):
    body = str(body)
    ops = _op_ids(body)
    if ops is None:
        return "REFUSED: body must be omega-maker-revision-2 JSON whose items carry 1-16 distinct op_id strings; nothing sent"
    text = str(parent).strip() if parent is not None else ""
    payload = {"body": body, "parent": None if text in ("", "None", "null") else int(float(text)),
               "execution_id": str(execution_id), "op_ids": ops}
    data, error = _hive.call("POST", f"/api/agent/artifacts/{urllib.parse.quote(str(artifact_id), safe='')}/revisions",
                             payload)
    return error or f"published {data.get('artifact_id')} r{data.get('revision', data.get('n'))} {data.get('digest')} op_ids={','.join(ops)}"
