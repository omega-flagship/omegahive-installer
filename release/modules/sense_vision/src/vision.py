"""Purpose: the vision sense: describe an image a mind received, captured or keeps with OpenRouter's vision model, and
log each observation; images only, and only from the mind's own folders or the hive's checkout."""
import base64
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
INBOX = ROOT / "memory" / "inbox"
OBSERVATION_LOG = ROOT / "memory" / "media_observations.jsonl"

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
VISION_MODEL = os.environ.get("OMEGACLAW_VISION_MODEL", "qwen/qwen3-vl-30b-a3b-instruct")
VISION_PROVIDER = os.environ.get("OMEGACLAW_VISION_PROVIDER", "auto").strip()
OPENROUTER_REFERER = os.environ.get("OMEGACLAW_OPENROUTER_REFERER", "https://omegaclaw.local")
OPENROUTER_TITLE = os.environ.get("OMEGACLAW_OPENROUTER_TITLE", "OmegaClaw Vision Skill")


def _api_key():
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not configured")
    return key


def _candidate_files():
    if not INBOX.exists():
        return []
    exts = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    return sorted(
        [path for path in INBOX.rglob("*") if path.is_file() and path.suffix.lower() in exts],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def _resolve_image(image_id):
    raw = str(image_id or "").strip().strip('"')
    if not raw or raw.lower() in {"latest", "recent"}:
        files = _candidate_files()
        if not files:
            raise FileNotFoundError("no inbox images found")
        return files[0]

    path = pathlib.Path(raw).expanduser()
    if path.is_file():
        return path

    files = _candidate_files()
    matches = [
        item for item in files
        if raw == item.name or raw == item.stem or raw in str(item)
    ]
    if len(matches) == 1:
        return matches[0]
    if matches:
        names = ", ".join(item.name for item in matches[:8])
        raise ValueError(f"ambiguous image id; matches {names}")
    raise FileNotFoundError(f"unknown image id {raw}")


# The formats _candidate_files looks for, by their first bytes: (mime, ((offset, bytes), ...)).
IMAGE_SIGNATURES = (
    ("image/png", ((0, b"\x89PNG\r\n\x1a\n"),)),
    ("image/jpeg", ((0, b"\xff\xd8\xff"),)),
    ("image/gif", ((0, b"GIF87a"),)),
    ("image/gif", ((0, b"GIF89a"),)),
    ("image/webp", ((0, b"RIFF"), (8, b"WEBP"))),
)


def _observable_roots():
    """Where a mind's images can be: the checkout this file runs from (the nearest folder above it holding modules/,
    where channels and senses write memory/inbox/<source>), the mind's own folder and its memory folder."""
    here = pathlib.Path(__file__).resolve()
    checkout = next((folder for folder in here.parents if (folder / "modules").is_dir()), ROOT)
    roots = [checkout, pathlib.Path.cwd().resolve()]
    if os.environ.get("OMEGACLAW_MEMORY_DIR"):
        roots.append(pathlib.Path(os.environ["OMEGACLAW_MEMORY_DIR"]).resolve())
    return roots


def _image_bytes(path):
    """(bytes, mime) of an image under one of _observable_roots. Anything else is refused before a byte is sent, so a
    mind can't send the vision provider a file it can merely read, such as a key, the hive's data or another mind's
    folder. Symlinks are resolved first, as the hive's own file skills do (policy.Policy._outside_folder)."""
    real = pathlib.Path(path).resolve(strict=True)
    if not any(root in real.parents for root in _observable_roots()):
        raise PermissionError(f"only images in this mind's folders or the hive's checkout can be observed: {path}")
    data = real.read_bytes()
    for mime, marks in IMAGE_SIGNATURES:
        if all(data[offset:offset + len(mark)] == mark for offset, mark in marks):
            return data, mime
    raise PermissionError(f"not a PNG, JPEG, GIF or WebP image: {path}")


def _image_data_url(path):
    data, mime = _image_bytes(path)
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _call_vision(path, question):
    payload = {
        "model": VISION_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a visual perception module for OmegaClaw. "
                    "Return concise, grounded observations. Mark uncertainty. "
                    "Do not invent identities, relationships, locations, or private facts."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            str(question or "").strip()
                            or "Describe this image for a persistent family agent. Include visible people, objects, setting, mood, text, and uncertainties."
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": _image_data_url(path)},
                    },
                ],
            },
        ],
        "temperature": 0.2,
        "max_tokens": 700,
    }
    if VISION_PROVIDER and VISION_PROVIDER.lower() != "auto":
        payload["provider"] = {
            "only": [VISION_PROVIDER],
            "allow_fallbacks": False,
        }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OPENROUTER_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": "application/json",
            "HTTP-Referer": OPENROUTER_REFERER,
            "X-Title": OPENROUTER_TITLE,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter HTTP {exc.code}: {detail[:700]}")
    parsed = json.loads(body)
    return parsed["choices"][0]["message"].get("content", "").strip()


def _append_observation(record):
    OBSERVATION_LOG.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        **record,
    }
    with OBSERVATION_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def inspect_image(image_id, question=""):
    try:
        path = _resolve_image(image_id)
        observation = _call_vision(path, question)
        record = {
            "kind": "image_observation",
            "provider": VISION_PROVIDER,
            "model": VISION_MODEL,
            "image": str(path),
            "question": str(question or ""),
            "observation": observation,
        }
        _append_observation(record)
        return "IMAGE-OBSERVATION " + json.dumps(record, ensure_ascii=False)
    except Exception as exc:
        _append_observation({
            "kind": "image_observation_failed",
            "image": str(image_id),
            "question": str(question or ""),
            "error": str(exc),
            "provider": VISION_PROVIDER,
            "model": VISION_MODEL,
        })
        return f"IMAGE-OBSERVATION-FAILED {exc}"


def observe_image(image_id):
    return inspect_image(image_id, "")


def recent_media_observations(limit=10):
    try:
        limit = max(1, min(int(limit), 50))
    except Exception:
        limit = 10
    if not OBSERVATION_LOG.exists():
        return "MEDIA-OBSERVATIONS none"
    lines = OBSERVATION_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    return "MEDIA-OBSERVATIONS " + " | ".join(lines)
