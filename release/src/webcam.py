import base64
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

import vision


ROOT = pathlib.Path(__file__).resolve().parents[1]
INBOX = ROOT / "memory" / "inbox" / "webcam"
TRACE_LOG = ROOT / "memory" / "webcam_observations.jsonl"

DEFAULT_URL = os.environ.get("OMEGA_WEBCAM_URL", "").strip()
DEFAULT_CAMERA = os.environ.get("OMEGA_WEBCAM_CAMERA", "BRIO")
TOKEN = os.environ.get("OMEGA_WEBCAM_TOKEN", "").strip()


def _append_trace(record):
    TRACE_LOG.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        **record,
    }
    with TRACE_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _request_json(path, query=None, timeout=20):
    if not DEFAULT_URL:
        raise RuntimeError("webcam URL is not configured; set OMEGA_WEBCAM_URL")
    query = dict(query or {})
    if TOKEN:
        query["token"] = TOKEN
    url = DEFAULT_URL.rstrip("/") + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"User-Agent": "OmegaClaw-Webcam/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body[:500]}")
    return json.loads(body)


def webcam_status():
    try:
        data = _request_json("/status", timeout=5)
        return "WEBCAM-STATUS " + json.dumps(data, ensure_ascii=False)
    except Exception as exc:
        return f"WEBCAM-STATUS-FAILED {exc}"


def capture_webcam(camera=""):
    camera = str(camera or "").strip() or DEFAULT_CAMERA
    try:
        data = _request_json("/capture", {"camera": camera}, timeout=25)
        if not data.get("ok"):
            _append_trace({"kind": "webcam_capture_failed", "camera": camera, "error": data.get("error", data)})
            return f"WEBCAM-CAPTURE-FAILED {data.get('error', data)}"
        payload = data.get("image_base64") or data.get("image_b64")
        raw = base64.b64decode(payload, validate=True)
        INBOX.mkdir(parents=True, exist_ok=True)
        filename = f"webcam_{int(time.time())}.jpg"
        target = INBOX / filename
        target.write_bytes(raw)
        record = {
            "kind": "webcam_capture",
            "camera": data.get("camera", camera),
            "image": str(target),
            "bytes": len(raw),
            "source_time": data.get("time", ""),
            "retention": "transient-inbox",
        }
        _append_trace(record)
        return "WEBCAM-CAPTURE " + json.dumps(record, ensure_ascii=False)
    except Exception as exc:
        _append_trace({"kind": "webcam_capture_failed", "camera": camera, "error": str(exc)})
        return f"WEBCAM-CAPTURE-FAILED {exc}"


def inspect_webcam(question=""):
    capture_result = capture_webcam(DEFAULT_CAMERA)
    if not capture_result.startswith("WEBCAM-CAPTURE "):
        return capture_result
    try:
        record = json.loads(capture_result[len("WEBCAM-CAPTURE "):])
        image_path = record["image"]
        observation = vision.inspect_image(image_path, question or "Describe the current webcam frame cautiously. Mark uncertainty.")
        _append_trace({
            "kind": "webcam_inspection",
            "image": image_path,
            "question": str(question or ""),
            "vision_result": observation[:2000],
        })
        return "WEBCAM-INSPECTION " + observation
    except Exception as exc:
        _append_trace({"kind": "webcam_inspection_failed", "capture_result": capture_result, "error": str(exc)})
        return f"WEBCAM-INSPECTION-FAILED {exc}"


def recent_webcam_observations(limit=10):
    try:
        limit = max(1, min(int(limit), 50))
    except Exception:
        limit = 10
    if not TRACE_LOG.exists():
        return "WEBCAM-OBSERVATIONS none"
    lines = TRACE_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    return "WEBCAM-OBSERVATIONS " + " | ".join(lines)
