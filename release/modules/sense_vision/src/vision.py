"""Purpose: the vision sense: describe an image a mind received, captured, fetched or made with OpenRouter's vision
model, and log each observation in the mind's memory folder; images only, and only from that memory folder or the files
folder its fetched hive assets land in, so minds sharing one checkout never observe each other's media."""
import base64
import json
import os
import pathlib
import stat
import time
import urllib.error
import urllib.request

# Under the mind's working directory, the folder the hive saves the assets a mind fetches into
# (modules/hive/src/hive_commons.py FILES_DIR).
FILES_DIR = "files"
# The most a sense reads of one file, checked before a byte is read: the hive's own cap on a file a mind moves
# (modules/hive/src/hive_commons.py MAX_ASSET_BYTES, HIVE_ASSET_MAX_BYTES's default).
MAX_BYTES = 100 * 1024 * 1024

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


def memory_dir():
    """The mind's memory folder, where its received, captured and generated media and this sense's log live:
    OMEGACLAW_MEMORY_DIR when a hive runs the mind (each mind's own, hive/supervisor/workspace.py), else the memory
    folder of the checkout this file runs from (the nearest folder above it holding modules/), as channel_hive reads it.
    It is the path as named, never resolved: a mind could put a link in its place, and _open_root opens it without
    following one."""
    here = pathlib.Path(__file__).resolve()
    checkout = next((folder for folder in here.parents if (folder / "modules").is_dir()), here.parents[1])
    return pathlib.Path(os.path.abspath(os.environ.get("OMEGACLAW_MEMORY_DIR") or checkout / "memory"))


def _candidate_files():
    inbox = memory_dir() / "inbox"
    if not inbox.exists():
        return []
    exts = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    return sorted(
        [path for path in inbox.rglob("*") if path.is_file() and path.suffix.lower() in exts],
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
    """Where a mind's own files can be, as paths named, never resolved: its memory folder, where the channels, the
    webcam and the generators write them, and the files folder under its working directory, where the hive saves the
    assets it fetches. A mind writes its own folder, so either could be a link it put there to any folder it can read;
    _open_root opens each without following one (omega-flagship/omegahive#249 review). Never the checkout or the rest
    of the working directory, which minds can share."""
    return [memory_dir(), pathlib.Path(os.getcwd()) / FILES_DIR]


def _open_root(root):
    """A descriptor for the folder root, reached without following a link anywhere a mind could have put one: from its
    working directory, its own folder, one name at a time with O_NOFOLLOW when root lies under it, else by its name
    with O_NOFOLLOW on the last, the one part of such a path a mind writes. The vision and audio senses keep this
    function word for word."""
    cloexec = getattr(os, "O_CLOEXEC", 0)
    folder_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | cloexec
    rel = os.path.relpath(root, os.getcwd())
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return os.open(root, folder_flags)
    folder = os.open(os.curdir, os.O_RDONLY | os.O_DIRECTORY | cloexec)
    try:
        for part in pathlib.PurePath(rel).parts:
            if part != os.curdir:
                inner = os.open(part, folder_flags, dir_fd=folder)
                os.close(folder)
                folder = inner
    except BaseException:
        os.close(folder)
        raise
    return folder


def _open_inside(path, roots):
    """A file descriptor for path, opened only when it is a regular file under one of roots. The path is placed against
    each root as named (os.path.abspath, never resolved) or as the root's real folder, then opened from the root's
    descriptor (_open_root) one name at a time with O_NOFOLLOW, as the standard library's shutil.rmtree walks against a
    link swapped in mid-walk: a link anywhere from the mind's own folder down, put there before the open or during it,
    fails to open instead of reaching outside. A FIFO or device, a file with a second hard link (its other name could
    be anywhere) and one over MAX_BYTES are refused unread. The vision and audio senses keep this function word for
    word. Cost: one open per folder between the mind's folder and the file."""
    given = os.path.abspath(os.path.expanduser(str(path)))
    rel = None
    for root in roots:
        for form in (str(root), os.path.realpath(root)):
            candidate = os.path.relpath(given, form)
            if candidate not in (os.curdir, os.pardir) and not candidate.startswith(os.pardir + os.sep):
                rel = candidate
                break
        if rel is not None:
            break
    if rel is None:
        raise PermissionError(f"only files in this mind's memory folder or its files folder can be observed: {path}")
    *folders, name = pathlib.PurePath(rel).parts
    nofollow = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        folder = _open_root(root)
    except OSError as exc:
        raise PermissionError(f"{path} can't be opened without following a link ({exc.strerror}), so it is not read") from exc
    try:
        for part in folders:
            inner = os.open(part, nofollow | os.O_DIRECTORY, dir_fd=folder)
            os.close(folder)
            folder = inner
        opened = os.open(name, nofollow | os.O_NONBLOCK, dir_fd=folder)
    except OSError as exc:
        raise PermissionError(f"{path} can't be opened without following a link ({exc.strerror}), so it is not read") from exc
    finally:
        os.close(folder)
    info = os.fstat(opened)
    reason = ("not a regular file" if not stat.S_ISREG(info.st_mode) else
              "a file with a second name elsewhere (a hard link)" if info.st_nlink != 1 else
              f"over {MAX_BYTES // (1024 * 1024)} MB" if info.st_size > MAX_BYTES else None)
    if reason:
        os.close(opened)
        raise PermissionError(f"{reason}: {path}")
    return opened


def _image_bytes(path):
    """(bytes, mime) of an image under one of _observable_roots, read through _open_inside's descriptor. Anything else
    is refused before a byte is sent, so a mind can't send the vision provider a file it can merely read, such as a
    key, the hive's data or another mind's media."""
    with os.fdopen(_open_inside(path, _observable_roots()), "rb") as handle:
        data = handle.read()
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


def _observation_log():
    return memory_dir() / "media_observations.jsonl"


def _append_observation(record):
    log = _observation_log()
    log.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        **record,
    }
    with log.open("a", encoding="utf-8") as handle:
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
    log = _observation_log()
    if not log.exists():
        return "MEDIA-OBSERVATIONS none"
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    return "MEDIA-OBSERVATIONS " + " | ".join(lines)
