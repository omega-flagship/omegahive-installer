"""Shared HTTP helper for the hive channel and tools (Iter loads files, not packages)."""

import json
import os
import urllib.error
import urllib.request


def call(method, path, payload=None, timeout=4):
    base = os.environ.get("HIVE_API_URL", "").rstrip("/")
    token = os.environ.get("HIVE_TOKEN", "")
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(base + path, data=data, method=method,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode()), None
    except urllib.error.HTTPError as exc:
        try:
            error = json.loads(exc.read().decode()).get("error", {})
            return None, f"HIVE-ERROR {error.get('code', exc.code)}: {error.get('message', '')}"
        except ValueError:
            return None, f"HIVE-ERROR {exc.code}"
    except OSError as exc:
        return None, f"HIVE-UNREACHABLE {exc}"
