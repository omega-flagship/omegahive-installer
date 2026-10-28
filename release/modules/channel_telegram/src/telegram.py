import json
import mimetypes
import os
import pathlib
import re
import threading
import time
import urllib.parse
import urllib.request
import uuid

_running = False
_last_message = ""
_msg_lock = threading.Lock()
_state_lock = threading.RLock()
_poll_thread = None

_bot_token = ""
_api_base = ""
_chat_id = ""
_poll_timeout = 20
_offset = None
_connected = False

_auth_secret = ""
_authenticated_user_id = None
_authenticated_chat_id = None
_last_update_id = None
_last_update_kind = "none"
_last_message_state = "none"
_ignored_counts = {}
_last_idle_log_at = 0.0

_LEADING_TELEGRAM_TARGET_RE = re.compile(
    r"^\s*(?:TELEGRAM:|telegram:|chat[_-]?id\s*[:=]\s*|-?\d{6,})\S*\s+",
    re.I,
)


def _set_last(msg):
    global _last_message
    with _msg_lock:
        if _last_message == "":
            _last_message = msg
        else:
            _last_message = _last_message + " | " + msg
    _log(f"Queued inbound message for loop chars={len(str(msg or ''))}")


def getLastMessage():
    global _last_message
    with _msg_lock:
        tmp = _last_message
        _last_message = ""
    if tmp:
        _log(f"Delivered inbound message to loop chars={len(str(tmp))}")
        return tmp
    return tmp


def _debug_enabled():
    return str(os.environ.get("OMEGACLAW_CHANNEL_DEBUG", "1")).strip().lower() not in {"0", "false", "no", "off"}


def _log(message):
    if _debug_enabled():
        print(f"[TELEGRAM] {message}", flush=True)


def _maybe_log_idle():
    global _last_idle_log_at
    now = time.time()
    if now - _last_idle_log_at >= 60:
        _last_idle_log_at = now
        with _state_lock:
            chat = _chat_id or "auto-bind"
            auth = bool(_auth_secret)
            authed = _authenticated_chat_id or "none"
            offset = _offset if _offset is not None else "none"
        _log(f"Polling idle chat={chat} auth_required={auth} authenticated_chat={authed} offset={offset}")


def _set_auth_secret(secret=None):
    global _auth_secret, _authenticated_user_id, _authenticated_chat_id
    if secret is None:
        secret = os.environ.get("OMEGACLAW_AUTH_SECRET", "")
    with _state_lock:
        _auth_secret = (secret or "").strip()
        _authenticated_user_id = None
        _authenticated_chat_id = None


def _parse_auth_candidate(msg):
    text = msg.strip()
    lower = text.lower()
    if lower.startswith("auth "):
        return text[5:].strip()
    if lower.startswith("/auth "):
        return text[6:].strip()
    return text


def _guard_configured_chat_body(text, command="send-telegram"):
    body = str(text or "")
    match = _LEADING_TELEGRAM_TARGET_RE.match(body)
    if not match:
        return ""
    target = match.group(0).strip()
    return (
        f"MESSAGE-NOT-DELIVERED TELEGRAM-TARGET-IN-MESSAGE-BODY command={command} "
        f"target={target} reason=telegram uses configured control chat; "
        "send message body only, no TELEGRAM:/chat_id prefix"
    )


def _bump_ignored(reason):
    with _state_lock:
        _ignored_counts[reason] = _ignored_counts.get(reason, 0) + 1
    return reason


def _display_name(user, chat):
    username = str(user.get("username", "")).strip()
    if username:
        return f"@{username}"

    first = str(user.get("first_name", "")).strip()
    last = str(user.get("last_name", "")).strip()
    full = f"{first} {last}".strip()
    if full:
        return full

    title = str(chat.get("title", "")).strip()
    if title:
        return title

    return "telegram_user"


def _message_from_update(update):
    for kind in ("message", "edited_message", "channel_post", "edited_channel_post"):
        payload = update.get(kind)
        if isinstance(payload, dict):
            return kind, payload
    return "", None


def _api_call(method, params=None, timeout=30, use_post=False):
    if not _api_base:
        raise RuntimeError("Telegram adapter not initialized")

    params = params or {}
    encoded = urllib.parse.urlencode(params).encode("utf-8")
    url = f"{_api_base}/{method}"

    if use_post:
        req = urllib.request.Request(url, data=encoded)
    else:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url)

    with urllib.request.urlopen(req, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", errors="ignore"))

    if not payload.get("ok"):
        raise RuntimeError(payload.get("description", f"{method} failed"))

    return payload.get("result")



def _core_dir():
    return pathlib.Path(__file__).resolve().parent.parent


def _inbox_dir():
    inbox = _core_dir() / "memory" / "inbox" / "telegram"
    inbox.mkdir(parents=True, exist_ok=True)
    return inbox


def _sanitize_filename(name):
    name = str(name or "telegram_file").strip()
    name = pathlib.Path(name).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return name or "telegram_file"


def _file_download_url(file_path):
    quoted = urllib.parse.quote(str(file_path), safe="/")
    return f"https://api.telegram.org/file/bot{_bot_token}/{quoted}"


def _download_file(file_id, fallback_name):
    if not file_id:
        return ""

    info = _api_call("getFile", {"file_id": file_id}, timeout=20) or {}
    file_path = info.get("file_path", "")
    if not file_path:
        return ""

    filename = _sanitize_filename(fallback_name or pathlib.Path(file_path).name)
    target = _inbox_dir() / f"{int(time.time())}_{uuid.uuid4().hex[:8]}_{filename}"
    with urllib.request.urlopen(_file_download_url(file_path), timeout=60) as response:
        target.write_bytes(response.read())
    return str(target)


def _largest_photo(photos):
    if not photos:
        return None
    return max(
        photos,
        key=lambda p: int(p.get("file_size") or (p.get("width", 0) * p.get("height", 0)) or 0),
    )


def _extract_file_notice(message, display_name):
    entries = [
        ("document", message.get("document"), "file_name", "document.bin"),
        ("audio", message.get("audio"), "file_name", "audio.bin"),
        ("video", message.get("video"), "file_name", "video.mp4"),
        ("voice", message.get("voice"), None, "voice.ogg"),
        ("animation", message.get("animation"), "file_name", "animation.gif"),
    ]

    for kind, payload, name_key, fallback in entries:
        if isinstance(payload, dict):
            file_id = payload.get("file_id", "")
            fallback_name = payload.get(name_key, fallback) if name_key else fallback
            path = _download_file(file_id, fallback_name)
            if path:
                caption = str(message.get("caption", "")).strip()
                suffix = f" caption: {caption}" if caption else ""
                return f"{display_name} sent {kind} saved at {path}{suffix}"

    photo = _largest_photo(message.get("photo") or [])
    if isinstance(photo, dict):
        fallback = f"photo_{message.get('message_id', int(time.time()))}.jpg"
        path = _download_file(photo.get("file_id", ""), fallback)
        if path:
            caption = str(message.get("caption", "")).strip()
            suffix = f" caption: {caption}" if caption else ""
            return f"{display_name} sent photo saved at {path}{suffix}"

    return ""


def _api_multipart(method, fields, file_field, file_path, timeout=60):
    if not _api_base:
        raise RuntimeError("Telegram adapter not initialized")

    path = pathlib.Path(str(file_path)).expanduser()
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(str(path))

    boundary = f"----OmegaClaw{uuid.uuid4().hex}"
    chunks = []
    for key, value in (fields or {}).items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    filename = _sanitize_filename(path.name)
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    )
    chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
    chunks.append(path.read_bytes())
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(f"{_api_base}/{method}", data=b"".join(chunks))
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", errors="ignore"))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("description", f"{method} failed"))
    return payload.get("result")


def _initialize_offset():
    global _offset
    try:
        updates = _api_call("getUpdates", {"timeout": 0}, timeout=10) or []
    except Exception as exc:
        _log(f"Could not read initial offset: {exc}")
        return

    max_update = -1
    for update in updates:
        update_id = update.get("update_id")
        if isinstance(update_id, int):
            max_update = max(max_update, update_id)

    if max_update >= 0:
        with _state_lock:
            _offset = max_update + 1
        _log(f"Initial offset advanced past stale updates last_update={max_update}")
    else:
        _log("Initial offset ready; no stale updates")


def _is_allowed_message(chat_id, user_id, msg, is_channel_post=False):
    global _chat_id, _authenticated_user_id, _authenticated_chat_id
    candidate = _parse_auth_candidate(msg)

    with _state_lock:
        if _chat_id and chat_id != _chat_id:
            return f"ignore:{_bump_ignored('wrong-chat')}"

        if not _auth_secret:
            if not _chat_id:
                _chat_id = chat_id
            return "allow"

        if _authenticated_user_id is None:
            if candidate == _auth_secret:
                _authenticated_user_id = (user_id or chat_id) if is_channel_post else user_id
                _authenticated_chat_id = chat_id
                _chat_id = chat_id
                return "auth_bound"
            return f"ignore:{_bump_ignored('auth-required')}"

        if chat_id != _authenticated_chat_id:
            return f"ignore:{_bump_ignored('wrong-auth-chat')}"
        if is_channel_post:
            return "allow"
        if user_id == _authenticated_user_id:
            return "allow"
        return f"ignore:{_bump_ignored('wrong-user')}"


def _poll_loop():
    global _connected, _offset, _poll_thread, _last_update_id, _last_update_kind, _last_message_state
    current = threading.current_thread()
    _log(f"Polling started timeout={_poll_timeout}s")

    while _running:
        try:
            params = {"timeout": int(_poll_timeout)}
            with _state_lock:
                if _offset is not None:
                    params["offset"] = _offset

            updates = _api_call("getUpdates", params=params, timeout=int(_poll_timeout) + 10) or []
            _connected = True
            if updates:
                _log(f"Received updates count={len(updates)}")
            else:
                _maybe_log_idle()

            for update in updates:
                update_id = update.get("update_id")
                if isinstance(update_id, int):
                    with _state_lock:
                        if _offset is None or (update_id + 1) > _offset:
                            _offset = update_id + 1
                        _last_update_id = update_id

                kind, message = _message_from_update(update)
                if not isinstance(message, dict):
                    reason = _bump_ignored("unsupported-update")
                    _log(f"Ignored update id={update_id} reason={reason}")
                    continue
                with _state_lock:
                    _last_update_kind = kind

                text = str(message.get("text", "") or "").strip()
                caption = str(message.get("caption", "") or "").strip()

                chat = message.get("chat") or {}
                user = message.get("from") or message.get("sender_chat") or {}
                chat_id = str(chat.get("id", "")).strip()
                is_channel_post = kind in {"channel_post", "edited_channel_post"}
                user_id = str(user.get("id", "") or (chat_id if is_channel_post else "")).strip()
                if not chat_id:
                    reason = _bump_ignored("missing-chat")
                    _log(f"Ignored update id={update_id} kind={kind} reason={reason}")
                    continue

                state = _is_allowed_message(chat_id, user_id, text or caption, is_channel_post=is_channel_post)
                display_name = _display_name(user, chat)
                if state == "allow":
                    with _state_lock:
                        _last_message_state = f"allow:{kind}"
                    _log(f"Accepted update id={update_id} kind={kind} chat={chat_id} sender={display_name} has_text={bool(text)} has_caption={bool(caption)}")
                    if text:
                        _set_last(f"{display_name}: {text}")
                    else:
                        notice = _extract_file_notice(message, display_name)
                        if notice:
                            _set_last(notice)
                        else:
                            reason = _bump_ignored("no-text-or-supported-file")
                            _log(f"Ignored update id={update_id} kind={kind} chat={chat_id} reason={reason}")
                elif state == "auth_bound":
                    with _state_lock:
                        _last_message_state = f"auth_bound:{kind}"
                    _log(f"Authenticated chat={chat_id} kind={kind} display={display_name}")
                    send_message(f"Authentication successful for {display_name}.")
                else:
                    reason = state.split(":", 1)[1] if ":" in state else "ignored"
                    with _state_lock:
                        _last_message_state = f"ignore:{kind}:{reason}"
                    _log(f"Ignored update id={update_id} kind={kind} chat={chat_id} reason={reason}")
        except Exception as exc:
            _connected = False
            _log(f"Poll error: {exc}")
            time.sleep(2)

    with _state_lock:
        _connected = False
        if _poll_thread is current:
            _poll_thread = None
    _log("Polling stopped")


def status():
    with _state_lock:
        ignored = ",".join(f"{key}:{value}" for key, value in sorted(_ignored_counts.items())) or "none"
        return (
            "TELEGRAM-STATUS "
            f"running={_running} connected={_connected} "
            f"chat={_chat_id or 'auto-bind'} "
            f"auth_required={bool(_auth_secret)} "
            f"authenticated_chat={_authenticated_chat_id or 'none'} "
            f"last_update={_last_update_id if _last_update_id is not None else 'none'} "
            f"last_kind={_last_update_kind} "
            f"last_state={_last_message_state} "
            f"ignored={ignored}"
        )


def start_telegram(bot_token, chat_id="", poll_timeout=20, auth_secret=None):
    global _running, _bot_token, _api_base, _chat_id, _poll_timeout, _offset, _connected, _poll_thread, _last_idle_log_at

    token = str(bot_token).strip()
    target_chat = str(chat_id).strip()
    if not token:
        raise ValueError("TG_BOT_TOKEN is required")

    try:
        timeout = max(1, int(poll_timeout))
    except Exception:
        timeout = 20

    old_thread = None
    with _state_lock:
        if _running and _poll_thread is not None and _poll_thread.is_alive():
            if _bot_token == token and _chat_id == target_chat:
                _poll_timeout = timeout
                _log(f"Adapter already running with chat target: {_chat_id or 'auto-bind'}")
                return _poll_thread
            _log("Restarting adapter for new configuration")
            _running = False
            old_thread = _poll_thread

    if old_thread is not None and old_thread is not threading.current_thread():
        old_thread.join(timeout=5)

    with _state_lock:
        _bot_token = token
        _api_base = f"https://api.telegram.org/bot{_bot_token}"
        _chat_id = target_chat
        _poll_timeout = timeout
        _offset = None
        _running = True
        _connected = False
        _last_idle_log_at = 0.0

    _set_auth_secret(auth_secret)
    _log(f"Starting adapter with chat target: {_chat_id or 'auto-bind'} auth_required={bool(_auth_secret)} timeout={_poll_timeout}s")
    if _auth_secret:
        _log("Auth required; pending updates are preserved for first auth bind")
    else:
        _initialize_offset()

    t = threading.Thread(target=_poll_loop, daemon=True)
    with _state_lock:
        _poll_thread = t
    t.start()
    return t


def stop_telegram():
    global _running, _poll_thread
    with _state_lock:
        _running = False
        thread = _poll_thread

    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=5)

    return "TELEGRAM-STOPPED"


def send_message(text):
    text = str(text).replace("\\n", "\n").replace("\r", "")
    if not text:
        return "TELEGRAM-SEND-FAILED empty-message"

    guard = _guard_configured_chat_body(text, "send-telegram")
    if guard:
        return guard

    with _state_lock:
        target_chat = _chat_id

    if not _connected or not target_chat:
        return "TELEGRAM-SEND-NOT-CONNECTED"

    max_len = 3900
    sent = 0
    for i in range(0, len(text), max_len):
        chunk = text[i:i + max_len]
        if not chunk:
            continue
        try:
            _api_call(
                "sendMessage",
                {"chat_id": target_chat, "text": chunk},
                timeout=15,
                use_post=True,
            )
            sent += 1
        except Exception as exc:
            _log(f"Send failed: {exc}")
            return f"TELEGRAM-SEND-FAILED {exc}"
    return f"TELEGRAM-SEND-SUCCESS chunks={sent}"

def send_file(path, caption=""):
    with _state_lock:
        target_chat = _chat_id

    if not _connected or not target_chat:
        return "TELEGRAM-SEND-FILE-NOT-CONNECTED"
    guard = _guard_configured_chat_body(caption, "send-telegram-file-caption")
    if guard:
        return guard

    try:
        _api_multipart(
            "sendDocument",
            {"chat_id": target_chat, "caption": str(caption or "")},
            "document",
            path,
            timeout=90,
        )
        return "TELEGRAM-SEND-FILE-SUCCESS"
    except Exception as exc:
        _log(f"Send file failed: {exc}")
        return f"TELEGRAM-SEND-FILE-FAILED {exc}"


def list_inbox():
    inbox = _inbox_dir()
    files = sorted([p for p in inbox.iterdir() if p.is_file()], key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return "TELEGRAM-INBOX-EMPTY"
    return "\n".join(str(p) for p in files[:50])
