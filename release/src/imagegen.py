import base64
import json
import os
import pathlib
import re
import time
import urllib.request

OUTBOX = pathlib.Path(__file__).resolve().parents[1] / "memory" / "outbox" / "images"
OUTBOX_ROOT = pathlib.Path(__file__).resolve().parents[1] / "memory" / "outbox"
ENDPOINT = os.environ.get("XAI_IMAGE_ENDPOINT", "https://api.x.ai/v1/images/generations")
DEFAULT_MODEL = os.environ.get("XAI_IMAGE_MODEL", "grok-imagine-image")
QUALITY_MODEL = os.environ.get("XAI_IMAGE_QUALITY_MODEL", "grok-imagine-image-quality")


def _api_key():
    key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    if not key:
        return ""
    return key.strip()


def _slug(text):
    words = re.findall(r"[A-Za-z0-9]+", str(text or "").lower())[:8]
    return "_".join(words) or "image"


def _write_bytes(prompt, image_bytes):
    OUTBOX.mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time())}_{_slug(prompt)}.jpg"
    target = OUTBOX / filename
    target.write_bytes(image_bytes)
    artifact_id = "outbox:" + target.relative_to(OUTBOX_ROOT).as_posix()
    return f"IMAGE-GENERATED path={target} artifact_id={artifact_id}"


def _download(prompt, url):
    req = urllib.request.Request(url, headers={"User-Agent": "OmegaClaw/1.0"})
    with urllib.request.urlopen(req, timeout=120) as response:
        return _write_bytes(prompt, response.read())


def _request(prompt, model):
    key = _api_key()
    if not key:
        return "IMAGE-GENERATION-FAILED missing XAI_API_KEY"
    payload = {
        "model": model,
        "prompt": str(prompt or ""),
        "response_format": "b64_json",
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=data,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8", errors="replace"))
        item = (body.get("data") or [{}])[0]
        if item.get("b64_json"):
            image_bytes = base64.b64decode(item["b64_json"])
            return _write_bytes(prompt, image_bytes)
        if item.get("url"):
            return _download(prompt, item["url"])
        return "IMAGE-GENERATION-FAILED no image returned"
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return f"IMAGE-GENERATION-FAILED HTTP {exc.code}: {detail}"
    except Exception as exc:
        return f"IMAGE-GENERATION-FAILED {exc}"


def generate_image(prompt):
    return _request(prompt, DEFAULT_MODEL)


def generate_image_quality(prompt):
    return _request(prompt, QUALITY_MODEL)
