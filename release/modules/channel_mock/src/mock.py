import os
import json
import pathlib
import time
import uuid

import Autotests.mock.comm as comm

_client = None
_mode = "file"
_memory_dir = None
_queue_file = None
_chat_file = None
_state_file = None


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _ensure_files():
    global _memory_dir, _queue_file, _chat_file, _state_file
    if _memory_dir is None:
        root = pathlib.Path(__file__).resolve().parents[3]
        _memory_dir = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", root / "memory"))
        _queue_file = _memory_dir / "mock_channel_queue.jsonl"
        _chat_file = _memory_dir / "mock_channel_chat.jsonl"
        _state_file = _memory_dir / "mock_channel_state.json"
    _memory_dir.mkdir(parents=True, exist_ok=True)


def _append_jsonl(path, record):
    _ensure_files()
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _read_jsonl(path):
    _ensure_files()
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            records.append(json.loads(line))
        except Exception:
            continue
    return records


def _load_state():
    _ensure_files()
    if not _state_file.exists():
        return {"last_seen": 0}
    try:
        state = json.loads(_state_file.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    return {"last_seen": int(state.get("last_seen", 0) or 0)}


def _save_state(state):
    _ensure_files()
    tmp = _state_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(_state_file)


def enqueue_user_message(text, author="mock-user"):
    _ensure_files()
    cleaned = str(text or "").strip()
    if not cleaned:
        return "MOCK-ENQUEUE-FAILED empty-message"
    record = {
        "id": uuid.uuid4().hex[:12],
        "at": _now(),
        "from": str(author or "mock-user"),
        "direction": "inbound",
        "text": cleaned,
    }
    _append_jsonl(_chat_file, record)
    _append_jsonl(_queue_file, record)
    return "MOCK-ENQUEUE-SUCCESS"


def recent_messages():
    return _read_jsonl(_chat_file)

def getLastMessage():
    global _client
    if _mode == "rpc":
        return _client.getLastMessage()
    _ensure_files()
    state = _load_state()
    queue = _read_jsonl(_queue_file)
    index = int(state.get("last_seen", 0) or 0)
    if index >= len(queue):
        return ""
    message = queue[index]
    state["last_seen"] = index + 1
    _save_state(state)
    sender = message.get("from") or "mock-user"
    text = str(message.get("text") or "").replace("\n", "\\n")
    return f"{sender}: {text}"

def start_mock():
    global _client, _mode
    server_ip = os.environ.get("TEST_SERVER_IP")
    if server_ip:
        _mode = "rpc"
        _client = comm.CommMockClient((server_ip, comm.COMM_MOCK_PORT))
    else:
        _mode = "file"
        _ensure_files()
        _client = None
    return f"MOCK-CHANNEL-READY mode={_mode}"

def send_message(text):
    global _client
    if _mode == "rpc":
        return _client.send_message(text)
    _ensure_files()
    record = {
        "id": uuid.uuid4().hex[:12],
        "at": _now(),
        "from": "agent",
        "direction": "outbound",
        "text": str(text or ""),
    }
    _append_jsonl(_chat_file, record)
    return "MOCK-SEND-SUCCESS"
