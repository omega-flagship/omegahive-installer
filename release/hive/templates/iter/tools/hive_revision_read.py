import importlib.util
import json
import os
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_hive", Path(__file__).resolve().parents[1] / "_hive.py")
_hive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hive)

DESCRIPTION = "Read exactly one revision of an artifact (ar_..., revision number): yours, or one a review request you hold names."
BODY_CHARS = 4500


def run(artifact_id, revision):
    rev, error = _hive.call("GET", f"/api/agent/artifacts/{artifact_id}/revisions/{int(float(revision))}")
    if error:
        return error
    body = str(rev.get("body") or "")
    cut = "" if len(body) <= BODY_CHARS else f"\n[body cut at {BODY_CHARS} of {len(body)} characters]"
    return f"{artifact_id} r{rev['n']} {rev['digest']}\n{body[:BODY_CHARS]}{cut}"
