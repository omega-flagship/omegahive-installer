import json
import os
import pathlib
import time
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", ROOT / "memory"))
QUEUE_FILE = MEMORY_DIR / "web_control_queue.jsonl"
CHAT_FILE = MEMORY_DIR / "web_control_chat.jsonl"
STATE_FILE = MEMORY_DIR / "web_control_state.json"


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _ensure_memory():
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)


def _append_jsonl(path, record):
    _ensure_memory()
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _read_jsonl(path, limit=None):
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if limit:
        lines = lines[-int(limit):]
    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except Exception:
            continue
    return records


def _load_state():
    if not STATE_FILE.exists():
        return {"last_seen": 0}
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    return {"last_seen": int(state.get("last_seen", 0) or 0)}


def _save_state(state):
    _ensure_memory()
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(STATE_FILE)


def _trim(text, limit=2400):
    cleaned = str(text or "").replace("\r\n", "\n").strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit] + f" ... [trimmed {len(cleaned) - limit} chars]"


def enqueue_user_message(text, author="web"):
    cleaned = _trim(text)
    if not cleaned:
        return {"ok": False, "error": "empty-message"}
    record = {
        "id": uuid.uuid4().hex[:12],
        "at": _now(),
        "from": str(author or "web"),
        "direction": "inbound",
        "text": cleaned,
    }
    _append_jsonl(CHAT_FILE, record)
    _append_jsonl(QUEUE_FILE, record)
    return {"ok": True, "message": record}


def get_last_message():
    state = _load_state()
    queue = _read_jsonl(QUEUE_FILE)
    index = int(state.get("last_seen", 0) or 0)
    if index >= len(queue):
        return ""
    message = queue[index]
    state["last_seen"] = index + 1
    _save_state(state)
    sender = message.get("from") or "web"
    text = _trim(message.get("text") or "", limit=2200).replace("\n", "\\n")
    return f"id={message.get('id')} at={message.get('at')} from={sender}: {text}"


def send_message(text):
    cleaned = _trim(text, limit=6000)
    if not cleaned:
        return "WEB-CONTROL-SEND-FAILED empty-message"
    record = {
        "id": uuid.uuid4().hex[:12],
        "at": _now(),
        "from": "agent",
        "direction": "outbound",
        "text": cleaned,
    }
    _append_jsonl(CHAT_FILE, record)
    return "WEB-CONTROL-SEND-SUCCESS"


def recent_messages(limit=80):
    try:
        count = max(1, min(300, int(limit)))
    except Exception:
        count = 80
    return _read_jsonl(CHAT_FILE, limit=count)


def web_control_status():
    queue = _read_jsonl(QUEUE_FILE)
    state = _load_state()
    return (
        f"WEB-CONTROL queue={len(queue)} seen={state.get('last_seen', 0)} "
        f"chat={len(_read_jsonl(CHAT_FILE))}"
    )
