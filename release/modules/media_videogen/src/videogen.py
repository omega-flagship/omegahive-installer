"""Purpose: the video generator: make a video from a prompt with xAI's video API, wait for it, and keep it in the
mind's memory folder under outbox/videos."""
import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.request

START_ENDPOINT = os.environ.get("XAI_VIDEO_ENDPOINT", "https://api.x.ai/v1/videos/generations")
STATUS_ENDPOINT = os.environ.get("XAI_VIDEO_STATUS_ENDPOINT", "https://api.x.ai/v1/videos/{request_id}")
DEFAULT_MODEL = os.environ.get("XAI_VIDEO_MODEL", "grok-imagine-video")
DEFAULT_DURATION = int(os.environ.get("XAI_VIDEO_DURATION", "5"))
DEFAULT_ASPECT_RATIO = os.environ.get("XAI_VIDEO_ASPECT_RATIO", "16:9")
DEFAULT_RESOLUTION = os.environ.get("XAI_VIDEO_RESOLUTION", "480p")
POLL_INTERVAL = int(os.environ.get("XAI_VIDEO_POLL_INTERVAL", "5"))
POLL_TIMEOUT = int(os.environ.get("XAI_VIDEO_POLL_TIMEOUT", "600"))


def _api_key():
    key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    if not key:
        return ""
    return key.strip()


def _slug(text):
    words = re.findall(r"[A-Za-z0-9]+", str(text or "").lower())[:8]
    return "_".join(words) or "video"


def memory_dir():
    """The mind's memory folder, where the videos it makes are kept: OMEGACLAW_MEMORY_DIR when a hive runs the mind,
    else the memory folder of the checkout this file runs from (the nearest folder above it holding modules/)."""
    here = pathlib.Path(__file__).resolve()
    checkout = next((folder for folder in here.parents if (folder / "modules").is_dir()), here.parents[1])
    return pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR") or checkout / "memory").resolve()


def _write_bytes(prompt, video_bytes):
    outbox = memory_dir() / "outbox"
    (outbox / "videos").mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time())}_{_slug(prompt)}.mp4"
    target = outbox / "videos" / filename
    target.write_bytes(video_bytes)
    artifact_id = "outbox:" + target.relative_to(outbox).as_posix()
    return f"VIDEO-GENERATED path={target} artifact_id={artifact_id}"


def _download(prompt, url):
    req = urllib.request.Request(url, headers={"User-Agent": "OmegaClaw/1.0"})
    with urllib.request.urlopen(req, timeout=300) as response:
        return _write_bytes(prompt, response.read())


def _json_request(url, key, payload=None, method="GET", timeout=120):
    data = None
    headers = {"Authorization": f"Bearer {key}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _start_generation(prompt, key, model, duration, aspect_ratio, resolution):
    payload = {
        "model": model,
        "prompt": str(prompt or ""),
        "duration": int(duration),
        "aspect_ratio": str(aspect_ratio),
        "resolution": str(resolution),
    }
    body = _json_request(START_ENDPOINT, key, payload=payload, method="POST", timeout=180)
    request_id = body.get("request_id")
    if not request_id:
        return "", f"VIDEO-GENERATION-FAILED no request_id returned: {body}"
    return request_id, ""


def _poll_generation(request_id, key):
    deadline = time.time() + POLL_TIMEOUT
    url = STATUS_ENDPOINT.format(request_id=request_id)
    last_status = ""
    while time.time() < deadline:
        body = _json_request(url, key, timeout=120)
        status = str(body.get("status") or "").lower()
        last_status = status or repr(body)[:300]
        if status == "done":
            video = body.get("video") or {}
            video_url = video.get("url")
            if not video_url:
                return "", f"VIDEO-GENERATION-FAILED done without video url: {body}"
            return video_url, ""
        if status in {"failed", "expired"}:
            return "", f"VIDEO-GENERATION-FAILED request {status}: {body}"
        time.sleep(POLL_INTERVAL)
    return "", f"VIDEO-GENERATION-FAILED timed out waiting for {request_id}; last status {last_status}"


def _request(prompt, model, duration=DEFAULT_DURATION, aspect_ratio=DEFAULT_ASPECT_RATIO, resolution=DEFAULT_RESOLUTION):
    key = _api_key()
    if not key:
        return "VIDEO-GENERATION-FAILED missing XAI_API_KEY"
    try:
        request_id, error = _start_generation(prompt, key, model, duration, aspect_ratio, resolution)
        if error:
            return error
        video_url, error = _poll_generation(request_id, key)
        if error:
            return error
        return _download(prompt, video_url)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return f"VIDEO-GENERATION-FAILED HTTP {exc.code}: {detail}"
    except Exception as exc:
        return f"VIDEO-GENERATION-FAILED {exc}"


def generate_video(prompt):
    return _request(prompt, DEFAULT_MODEL)


def validate_video_config():
    if not _api_key():
        return "VIDEO-CONFIG-FAILED missing XAI_API_KEY"
    return f"VIDEO-CONFIG-OK model {DEFAULT_MODEL} endpoint {START_ENDPOINT}"
