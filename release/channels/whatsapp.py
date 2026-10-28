import json
import mimetypes
import os
import pathlib
import re
import subprocess
import time
import urllib.parse
import urllib.error
import urllib.request

_proc = None
_port = 3055
_target_jid = ""
_primary_jid = ""
_prefix = ""
_bridge_dir = pathlib.Path(__file__).resolve().parent / "whatsapp_bridge"
_last_events = []


def _url(path):
    return f"http://127.0.0.1:{_port}{path}"


def _json_request(method, path, payload=None, timeout=10):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_url(path), data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", errors="ignore"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(body) if body else {}
        except Exception:
            payload = {"error": body or str(exc)}
        payload.setdefault("ok", False)
        payload.setdefault("error", "HTTP %s: %s" % (exc.code, payload.get("error") or exc.reason))
        return payload


def _bridge_alive():
    try:
        payload = _json_request("GET", "/health", timeout=2)
        return bool(payload.get("ok"))
    except Exception:
        return False


def _message_jid(jid):
    return str(jid or "").strip().split("::", 1)[0]


def _jid_digits(jid):
    return re.sub(r"[^0-9]+", "", _message_jid(jid).split("@", 1)[0])


def _jid_domain(jid):
    value = _message_jid(jid)
    return value.split("@", 1)[1] if "@" in value else ""


_LEADING_JID_RE = re.compile(r"^\s*([0-9A-Za-z._:-]+@(?:lid|g\.us|s\.whatsapp\.net)(?:::[0-9A-Za-z._:-]+)?)\s+")


def _guard_primary_route_body(text, command_name):
    match = _LEADING_JID_RE.match(str(text or ""))
    if not match:
        return ""
    jid = match.group(1)
    return (
        f"MESSAGE-NOT-DELIVERED WHATSAPP-JID-IN-MESSAGE-BODY command={command_name} "
        f"jid={jid} send-whatsapp takes message only; do not include a jid in the body. "
        "For explicit routing use: send-whatsapp-to jid message."
    )


def _known_reply_jids():
    known = set()
    if _primary_jid:
        known.add(_message_jid(_primary_jid))
    if _target_jid:
        known.add(_message_jid(_target_jid))
    for path in ("/inbox", "/chats"):
        try:
            payload = _json_request("GET", path, timeout=5)
        except Exception:
            continue
        if payload.get("primaryJid"):
            known.add(_message_jid(payload.get("primaryJid")))
        for item in (payload.get("inbox") or payload.get("chats") or []):
            if item.get("jid"):
                known.add(_message_jid(item.get("jid")))
    return known


def _current_primary_jid():
    if _primary_jid:
        return _message_jid(_primary_jid)
    try:
        payload = _json_request("GET", "/inbox", timeout=5)
        if payload.get("primaryJid"):
            return _message_jid(payload.get("primaryJid"))
    except Exception:
        pass
    return ""


def _validate_reply_jid(jid):
    safe_jid = _message_jid(jid)
    if not safe_jid:
        return "", "WHATSAPP-UNKNOWN-CHAT empty-jid"
    current_primary = _current_primary_jid()
    primary_digits = _jid_digits(current_primary)
    if primary_digits and _jid_digits(safe_jid) == primary_digits and _jid_domain(safe_jid) != _jid_domain(current_primary):
        return "", (
            f"WHATSAPP-STALE-PRIMARY-ALIAS jid={safe_jid} current_primary={current_primary} "
            "use send for the current primary route or set-whatsapp-primary after inspecting the live inbox"
        )
    known = _known_reply_jids()
    if safe_jid in known:
        return safe_jid, ""
    visible = ",".join(sorted(known)[:12]) or "none"
    return "", f"WHATSAPP-UNKNOWN-CHAT jid={safe_jid} known={visible} use whatsapp-inbox or read-whatsapp-chat before replying"


def start_whatsapp(target_jid="", port=3055, prefix="", primary_jid=""):
    global _proc, _port, _target_jid, _prefix, _primary_jid
    _target_jid = str(target_jid or "").strip()
    _primary_jid = str(primary_jid or "").strip()
    _prefix = str(prefix or "")
    try:
        _port = int(port)
    except Exception:
        _port = 3055

    # Reuse an already-linked bridge on the requested port. This lets the
    # standard OmegaClaw run command coexist with a bridge started for QR
    # setup or manual testing.
    if _bridge_alive():
        if _primary_jid:
            try:
                _json_request("POST", "/primary", {"jid": _primary_jid}, timeout=3)
            except Exception:
                pass
        return _proc or "WHATSAPP-BRIDGE-EXISTING"

    env = os.environ.copy()
    env["OMEGACLAW_WA_PORT"] = str(_port)
    env.setdefault("OMEGACLAW_WA_AUTH_DIR", str(_bridge_dir / "auth"))
    env.setdefault("OMEGACLAW_WA_EXPECT_SELF_NAME", "")
    env.setdefault("OMEGACLAW_WA_FORBID_SELF_NAMES", "")
    env["OMEGACLAW_WA_TARGET_JID"] = _target_jid
    env["OMEGACLAW_WA_PRIMARY_JID"] = _primary_jid
    env["OMEGACLAW_WA_PREFIX"] = _prefix
    env.setdefault("OMEGACLAW_WA_INCLUDE_OWN", "0")
    env.setdefault("NODE_NO_WARNINGS", "1")
    _proc = subprocess.Popen(
        ["node", "bridge.mjs"],
        cwd=str(_bridge_dir),
        env=env,
        stdout=None,
        stderr=None,
    )
    return _proc


def stop_whatsapp():
    global _proc
    if _proc and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(timeout=5)
        except Exception:
            _proc.kill()
    _proc = None


def getLastMessage():
    global _last_events
    try:
        payload = _json_request("GET", "/messages", timeout=3)
        _last_events = payload.get("events") or []
        return " | ".join(payload.get("messages") or [])
    except Exception:
        _last_events = []
        return ""


def getLastEvents():
    return list(_last_events)


def send_message(text):
    guard = _guard_primary_route_body(text, "send-whatsapp")
    if guard:
        return guard
    try:
        payload = _json_request("POST", "/send", {"text": str(text or ""), "to": _target_jid}, timeout=15)
        if payload.get("ok"):
            return f"WHATSAPP-SEND-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-SEND-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-SEND-FAILED {exc}"


def send_primary(text):
    guard = _guard_primary_route_body(text, "send-primary-operator")
    if guard:
        return guard
    try:
        payload = _json_request("POST", "/send", {"text": str(text or ""), "to": _primary_jid}, timeout=15)
        if payload.get("ok"):
            return f"WHATSAPP-PRIMARY-SEND-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-PRIMARY-SEND-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-PRIMARY-SEND-FAILED {exc}"


def send_primary_operator(text):
    return send_primary(text)


def send_mention(phone, text):
    try:
        payload = _json_request(
            "POST",
            "/send-mention",
            {"phone": str(phone or ""), "text": str(text or ""), "to": _target_jid},
            timeout=15,
        )
        if payload.get("ok"):
            return f"WHATSAPP-MENTION-SEND-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-MENTION-SEND-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-MENTION-SEND-FAILED {exc}"


def send_mention_to_chat(jid, phone, text):
    try:
        payload = _json_request(
            "POST",
            "/send-mention",
            {"phone": str(phone or ""), "text": str(text or ""), "to": str(jid or "")},
            timeout=15,
        )
        if payload.get("ok"):
            return f"WHATSAPP-MENTION-TO-CHAT-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-MENTION-TO-CHAT-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-MENTION-TO-CHAT-FAILED {exc}"


def send_file(path, caption=""):
    file_path = pathlib.Path(str(path)).expanduser()
    mimetype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    try:
        payload = _json_request(
            "POST",
            "/send-file",
            {"path": str(file_path), "caption": str(caption or ""), "mimetype": mimetype, "to": _target_jid},
            timeout=90,
        )
        if payload.get("ok"):
            return f"WHATSAPP-SEND-FILE-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-SEND-FILE-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-SEND-FILE-FAILED {exc}"


def send_file_to_chat(jid, path, caption=""):
    file_path = pathlib.Path(str(path)).expanduser()
    mimetype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    try:
        payload = _json_request(
            "POST",
            "/send-file",
            {
                "path": str(file_path),
                "caption": str(caption or ""),
                "mimetype": mimetype,
                "to": str(jid or ""),
            },
            timeout=90,
        )
        if payload.get("ok"):
            return f"WHATSAPP-SEND-FILE-TO-CHAT-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-SEND-FILE-TO-CHAT-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-SEND-FILE-TO-CHAT-FAILED {exc}"


def reply_file_to_chat(jid, path, caption=""):
    send_result = send_file_to_chat(jid, path, caption)
    read_result = mark_read(jid)
    return f"WHATSAPP-REPLY-FILE-TO-CHAT {send_result} read={read_result}"


def list_chats():
    try:
        payload = _json_request("GET", "/chats", timeout=15)
        chats = payload.get("chats") or []
        if not chats:
            return "WHATSAPP-CHATS-EMPTY"
        return "\n".join(f"{c.get('jid')} {c.get('name')} {'primary' if c.get('jid') == _primary_jid else ''}".strip() for c in chats)
    except Exception as exc:
        return f"WHATSAPP-CHATS-FAILED {exc}"


def inbox():
    try:
        payload = _json_request("GET", "/inbox", timeout=15)
        items = payload.get("inbox") or []
        if not items:
            return "WHATSAPP-INBOX-EMPTY"
        lines = [f"PRIMARY {payload.get('primaryJid') or 'none'}"]
        for item in items:
            marker = " PRIMARY" if item.get("primary") else ""
            lines.append(
                f"{item.get('jid')} {item.get('name')} unread={item.get('unread')} seen={item.get('seen', 0)} delivered={item.get('delivered', 0)} last_from={item.get('lastFrom')} kind={item.get('lastKind')}{marker}"
            )
        return "\n".join(lines)
    except Exception as exc:
        return f"WHATSAPP-INBOX-FAILED {exc}"


DEFAULT_CHAT_LIMIT = 20
FULL_CHAT_LIMIT = 100


def _read_chat_view(jid, limit=DEFAULT_CHAT_LIMIT, expanded=False):
    try:
        safe_jid = str(jid or "").strip()
        safe_limit = max(1, min(int(limit), FULL_CHAT_LIMIT))
        query = urllib.parse.urlencode({"jid": safe_jid, "limit": safe_limit})
        payload = _json_request("GET", f"/chat-messages?{query}", timeout=15)
        messages = payload.get("messages") or []
        if not messages:
            return "WHATSAPP-CHAT-EMPTY"
        visible_messages = [str(m or "") for m in messages]
        header = [
            f"WHATSAPP_CHAT jid={safe_jid}",
            f"VIEW: {'expanded-explicit' if expanded else 'bounded-current'} exact_visible_messages=true limit={safe_limit} raw_trace_preserved=memory/whatsapp_inbox_*.jsonl",
            f"REPLY_HERE: reply-whatsapp-to \"{safe_jid}\" \"message\"",
            f"SEND_WITHOUT_MARKING_READ: send-whatsapp-to \"{safe_jid}\" \"message\"",
            f"TAG_IN_THIS_CHAT: send-whatsapp-mention-to \"{safe_jid}\" \"phone\" \"message\"",
            f"QUOTE_REPLY: reply-whatsapp-to-message \"{safe_jid}\" \"message-id\" \"message\"",
            f"REACT: react-whatsapp-message \"{safe_jid}\" \"message-id\" \"emoji\"",
            f"DEEPER_CONTEXT_IF_NEEDED: read-whatsapp-chat-full \"{safe_jid}\"",
            "ROUTING_LESSON: destination chat jid decides where a WhatsApp message goes; phone mention only tags a person inside that destination.",
        ]
        return "\n".join(header + visible_messages)
    except Exception as exc:
        return f"WHATSAPP-CHAT-FAILED {exc}"


def read_chat(jid, limit=DEFAULT_CHAT_LIMIT):
    return _read_chat_view(jid, limit=limit, expanded=False)


def read_chat_full(jid):
    return _read_chat_view(jid, limit=FULL_CHAT_LIMIT, expanded=True)


def mark_read(jid):
    try:
        payload = _json_request("POST", "/chat-state", {"jid": str(jid or ""), "state": "read", "scope": "all"}, timeout=15)
        if payload.get("ok"):
            return f"WHATSAPP-MARK-READ-SUCCESS jid={payload.get('jid')} changed={payload.get('changed')} read_receipts={payload.get('readReceipts')}"
        return f"WHATSAPP-MARK-READ-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-MARK-READ-FAILED {exc}"


def mark_unread(jid):
    try:
        payload = _json_request("POST", "/chat-state", {"jid": str(jid or ""), "state": "unread", "scope": "latest"}, timeout=15)
        if payload.get("ok"):
            return f"WHATSAPP-MARK-UNREAD-SUCCESS jid={payload.get('jid')} changed={payload.get('changed')}"
        return f"WHATSAPP-MARK-UNREAD-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-MARK-UNREAD-FAILED {exc}"


def set_primary(jid):
    global _primary_jid
    try:
        aliases = []
        if _primary_jid and _primary_jid != str(jid or "").strip():
            aliases.append(_primary_jid)
        payload = _json_request("POST", "/primary", {"jid": str(jid or ""), "aliases": aliases}, timeout=15)
        if payload.get("ok"):
            _primary_jid = payload.get("primaryJid") or str(jid or "")
            return f"WHATSAPP-PRIMARY-SET {_primary_jid}"
        return f"WHATSAPP-PRIMARY-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-PRIMARY-FAILED {exc}"


def send_to_chat(jid, text):
    safe_jid, error = _validate_reply_jid(jid)
    if error:
        return f"WHATSAPP-SEND-TO-CHAT-FAILED {error}"
    try:
        payload = _json_request("POST", "/send", {"text": str(text or ""), "to": safe_jid}, timeout=15)
        if payload.get("ok"):
            return f"WHATSAPP-SEND-TO-CHAT-SUCCESS handled={payload.get('handled')}"
        return f"WHATSAPP-SEND-TO-CHAT-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-SEND-TO-CHAT-FAILED {exc}"


def reply_to_chat(jid, text):
    """Send a deliberate reply gesture, then mark that chat handled/read."""
    safe_jid, error = _validate_reply_jid(jid)
    if error:
        return f"WHATSAPP-REPLY-TO-CHAT-FAILED {error}"
    send_result = send_to_chat(safe_jid, text)
    if not send_result.startswith("WHATSAPP-SEND-TO-CHAT-SUCCESS"):
        return f"WHATSAPP-REPLY-TO-CHAT-FAILED send={send_result}"
    read_result = mark_read(safe_jid)
    return f"WHATSAPP-REPLY-TO-CHAT-SUCCESS send={send_result} read={read_result}"


def reply_to_message(jid, message_id, text):
    """Send a deliberate quoted reply gesture, then mark that chat handled/read."""
    safe_jid, error = _validate_reply_jid(jid)
    if error:
        return f"WHATSAPP-REPLY-TO-MESSAGE-FAILED {error}"
    try:
        payload = _json_request(
            "POST",
            "/reply-to-message",
            {"to": safe_jid, "messageId": str(message_id or ""), "text": str(text or "")},
            timeout=15,
        )
        if not payload.get("ok"):
            return f"WHATSAPP-REPLY-TO-MESSAGE-FAILED {payload.get('error')}"
        read_result = mark_read(safe_jid)
        return f"WHATSAPP-REPLY-TO-MESSAGE-SUCCESS message_id={payload.get('messageId')} quoted={payload.get('quotedMessageId')} read={read_result}"
    except Exception as exc:
        return f"WHATSAPP-REPLY-TO-MESSAGE-FAILED {exc}"


def react_message(jid, message_id, emoji):
    safe_jid, error = _validate_reply_jid(jid)
    if error:
        return f"WHATSAPP-REACT-FAILED {error}"
    try:
        payload = _json_request(
            "POST",
            "/react",
            {"to": safe_jid, "messageId": str(message_id or ""), "emoji": str(emoji or "")},
            timeout=15,
        )
        if payload.get("ok"):
            return f"WHATSAPP-REACT-SUCCESS message_id={payload.get('messageId')} emoji={payload.get('emoji')}"
        return f"WHATSAPP-REACT-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-REACT-FAILED {exc}"


def unreact_message(jid, message_id):
    return react_message(jid, message_id, "")


def edit_message(message_id, text):
    try:
        payload = _json_request(
            "POST",
            "/edit",
            {"messageId": str(message_id or ""), "text": str(text or "")},
            timeout=15,
        )
        if payload.get("ok"):
            return f"WHATSAPP-EDIT-SUCCESS message_id={payload.get('messageId')}"
        return f"WHATSAPP-EDIT-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-EDIT-FAILED {exc}"


def delete_message(message_id):
    try:
        payload = _json_request(
            "POST",
            "/delete",
            {"messageId": str(message_id or "")},
            timeout=15,
        )
        if payload.get("ok"):
            return f"WHATSAPP-DELETE-SUCCESS message_id={payload.get('messageId')}"
        return f"WHATSAPP-DELETE-FAILED {payload.get('error')}"
    except Exception as exc:
        return f"WHATSAPP-DELETE-FAILED {exc}"


def status():
    try:
        payload = _json_request("GET", "/health", timeout=3)
        return json.dumps(payload, sort_keys=True)
    except Exception as exc:
        return f"WHATSAPP-STATUS-FAILED {exc}"
