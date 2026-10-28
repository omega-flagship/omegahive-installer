import base64
import importlib.util
import pathlib
import re
import sys

_CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
_ADAPTER_MODULES = {
    "telegram": "channel_telegram",
    "whatsapp": "channel_whatsapp",
    "glucose": "health_glucose",
    "web_control": "channel_web_control",
}
_ADAPTER_CACHE = {}


def _is_local_adapter(module, name):
    path = getattr(module, "__file__", "")
    if not path:
        return True
    try:
        resolved = pathlib.Path(path).resolve()
    except Exception:
        return False
    return resolved == (_CORE_ROOT / "modules" / _ADAPTER_MODULES[name] / "src" / f"{name}.py").resolve()


def _adapter(name):
    cached = _ADAPTER_CACHE.get(name)
    if cached is not None:
        return cached

    existing = sys.modules.get(name)
    if existing is not None and _is_local_adapter(existing, name):
        _ADAPTER_CACHE[name] = existing
        return existing

    module_path = _CORE_ROOT / "modules" / _ADAPTER_MODULES[name] / "src" / f"{name}.py"
    if not module_path.exists():
        raise ModuleNotFoundError(f"OmegaClaw channel adapter not found: {module_path}")

    spec = importlib.util.spec_from_file_location(name, module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    _ADAPTER_CACHE[name] = module
    return module

_last_inbound_channel = "control"


def _decode_rich_text(payload):
    try:
        raw = base64.b64decode(str(payload or "").strip(), validate=True)
        text = raw.decode("utf-8")
    except Exception as exc:
        return None, f"RICH-TEXT-DECODE-FAILED {type(exc).__name__}: {exc}"
    if not text.strip():
        return None, "RICH-TEXT-DECODE-FAILED empty"
    return text, ""


def _rich_result(result, text):
    advisory = ""
    if len(text) > 4000:
        advisory = f" advisory=long-message-consider-page-artifact-next-time chars={len(text)}"
    return f"{result}{advisory}"


def _event_block(*lines):
    return "\n".join(line for line in lines if line)


def _control_event(channel, text, message_id="unavailable"):
    return {
        "event": "message",
        "channel": channel,
        "route": "control",
        "conversation_id": "current-control-route",
        "message_id": message_id,
        "sender": "control-user",
        "text": str(text or ""),
        "reply_affordance": "send message",
    }


def _split_whatsapp_notice(notice):
    text = str(notice or "").strip()
    if not text.startswith("WHATSAPP_"):
        return "", {}, text
    head, sep, body = text.partition(": ")
    tokens = head.split()
    kind = tokens[0] if tokens else ""
    meta = {}
    for token in tokens[1:]:
        if "=" in token:
            key, value = token.split("=", 1)
            meta[key] = value
    return kind, meta, body if sep else ""


def _message_id_available(value):
    return "available" if str(value or "").strip() else "unknown"


def _event_value(event, key, default=""):
    if not isinstance(event, dict):
        return default
    value = event.get(key, default)
    return default if value is None else str(value)


def _event_route(event):
    route = _event_value(event, "route", "inspect")
    if route in ("primary", "primary-operator", "control"):
        return route
    if route in ("explicit", "explicit-chat", "secondary"):
        return "explicit-chat"
    return route or "inspect"


def _reply_affordance(channel, route, event):
    explicit = _event_value(event, "reply_affordance")
    if explicit:
        return explicit
    if route in ("primary", "primary-operator", "control"):
        return "send message"
    if channel == "whatsapp" and route == "explicit-chat":
        return "send-whatsapp-to conversation_id message"
    return "inspect channel-specific skill card"


def normalize_channel_event(event):
    if not isinstance(event, dict):
        return ""
    channel = _event_value(event, "channel", "unknown").lower()
    route = _event_route(event)
    conversation_id = _event_value(event, "conversation_id")
    show_conversation_id = bool(conversation_id and route == "explicit-chat")
    return _event_block(
        "CHANNEL_EVENT",
        f"event={_event_value(event, 'event', 'message')}",
        f"channel={channel}",
        f"route={route}",
        f"conversation_id={conversation_id}" if show_conversation_id else "",
        f"message_id={_message_id_available(_event_value(event, 'message_id'))}",
        f"sender={_event_value(event, 'sender', 'unknown')}",
        f"chat={_event_value(event, 'chat')}" if _event_value(event, "chat") else "",
        f"unread={_event_value(event, 'unread')}" if _event_value(event, "unread") else "",
        f"emoji={_event_value(event, 'emoji')}" if _event_value(event, "emoji") else "",
        f"text={_event_value(event, 'text')}",
        f"reply_affordance={_reply_affordance(channel, route, event)}",
        f"explicit_reply_affordance={_event_value(event, 'explicit_reply_affordance')}" if _event_value(event, "explicit_reply_affordance") else "",
    )


def _whatsapp_secondary_sender(body):
    match = re.match(r"new \S+ from (?P<sender>.*?)(?: in (?P<chat>.*?))?\s+jid=(?P<jid>\S+)\s+unread=(?P<unread>\d+)(?P<tail>.*)$", body)
    if not match:
        return "", "", "", ""
    return (
        match.group("sender").strip(),
        match.group("chat") or "",
        match.group("jid").strip(),
        match.group("unread").strip(),
    )


def _normalize_whatsapp_notice(notice):
    kind, meta, body = _split_whatsapp_notice(notice)
    if kind == "WHATSAPP_PRIMARY":
        sender, sep, text = body.partition(": ")
        if not sep:
            sender = "primary-operator"
            text = body
        return _event_block(
            "CHANNEL_EVENT",
            "compatibility=legacy-notice-parser",
            "event=message",
            "channel=whatsapp",
            "route=primary-operator",
            f"message_id={_message_id_available(meta.get('id'))}",
            f"sender={sender.strip() or 'primary-operator'}",
            f"text={text}",
            "reply_affordance=send message",
            "explicit_reply_affordance=reply-whatsapp-to-message conversation_id message_id message",
        )
    if kind == "WHATSAPP_INBOX_NOTICE":
        sender, chat, jid, unread = _whatsapp_secondary_sender(body)
        return _event_block(
            "CHANNEL_EVENT",
            "compatibility=legacy-notice-parser",
            "event=message-notice",
            "channel=whatsapp",
            "route=explicit-chat",
            f"conversation_id={jid or 'unknown'}",
            f"message_id={_message_id_available(meta.get('id'))}",
            f"sender={sender or 'unknown'}",
            f"chat={chat.strip()}" if chat else "",
            f"unread={unread}" if unread else "",
            "text=<inspect-chat-for-current-text>",
            "reply_affordance=send-whatsapp-to conversation_id message",
            "explicit_reply_affordance=reply-whatsapp-to-message conversation_id message_id message",
        )
    if kind == "WHATSAPP_PRIMARY_REACTION":
        return _event_block(
            "CHANNEL_EVENT",
            "compatibility=legacy-notice-parser",
            "event=reaction",
            "channel=whatsapp",
            "route=primary-operator",
            f"message_id={_message_id_available(meta.get('id'))}",
            f"emoji={meta.get('emoji', 'unknown')}",
            "reply_affordance=send message",
        )
    if kind == "WHATSAPP_PRIMARY_EDIT":
        _, sep, text = body.partition(": ")
        return _event_block(
            "CHANNEL_EVENT",
            "compatibility=legacy-notice-parser",
            "event=edit",
            "channel=whatsapp",
            "route=primary-operator",
            f"message_id={_message_id_available(meta.get('id'))}",
            f"text={text if sep else body}",
            "reply_affordance=send message",
        )
    if kind == "WHATSAPP_PRIMARY_DELETE":
        return _event_block(
            "CHANNEL_EVENT",
            "compatibility=legacy-notice-parser",
            "event=delete",
            "channel=whatsapp",
            "route=primary-operator",
            f"message_id={_message_id_available(meta.get('id'))}",
            "reply_affordance=send message",
        )
    return _event_block(
        "CHANNEL_EVENT",
        "compatibility=legacy-notice-parser",
        "channel=whatsapp",
        "route=inspect",
        f"raw_notice={str(notice or '').strip()}",
        "reply_affordance=inspect whatsapp-status or whatsapp-inbox",
    )


def normalize_channel_notice(channel, notice):
    if isinstance(notice, dict):
        event = dict(notice)
        event.setdefault("channel", channel)
        return normalize_channel_event(event)
    channel = str(channel or "").strip().lower()
    text = str(notice or "").strip()
    if not text:
        return ""
    if channel == "whatsapp":
        return _normalize_whatsapp_notice(text)
    if channel == "telegram":
        return normalize_channel_event(_control_event("telegram", text))
    if channel == "mattermost":
        return normalize_channel_event(_control_event("mattermost", text, "available-if-provided"))
    return _event_block(
        "CHANNEL_EVENT",
        f"channel={channel or 'unknown'}",
        "route=inspect",
        f"text={text}",
        "reply_affordance=inspect channel-specific skill card",
    )


def receive():
    global _last_inbound_channel
    items = []
    channels = []
    try:
        msg = _adapter("telegram").getLastMessage()
        if msg:
            items.append(normalize_channel_notice("telegram", msg))
            channels.append("control")
    except Exception as exc:
        items.append(f"TELEGRAM_CONTROL_ERROR: {exc}")
    try:
        msg = _adapter("whatsapp").getLastMessage()
        if msg:
            events = []
            try:
                events = _adapter("whatsapp").getLastEvents()
            except Exception:
                events = []
            if events:
                items.extend(normalize_channel_notice("whatsapp", event) for event in events)
            else:
                items.append(normalize_channel_notice("whatsapp", msg))
            if "WHATSAPP_PRIMARY" in msg or any(_event_route(event) == "primary-operator" for event in events if isinstance(event, dict)):
                channels.append("whatsapp_primary")
    except Exception as exc:
        items.append(f"WHATSAPP_ERROR: {exc}")
    try:
        msg = _adapter("glucose").pending_glucose_rings()
        if msg:
            items.append(normalize_channel_event({
                "event": "notice",
                "channel": "glucose",
                "route": "control",
                "conversation_id": "current-control-route",
                "message_id": "unavailable",
                "sender": "glucose-watch",
                "text": msg,
                "reply_affordance": "inspect glucose skill card",
            }))
            channels.append("glucose_app")
    except Exception as exc:
        items.append(f"GLUCOSE_APP_ERROR: {exc}")
    try:
        msg = _adapter("web_control").get_last_message()
        if msg:
            items.append(normalize_channel_event(_control_event("web_control", msg)))
            channels.append("web_control")
    except Exception as exc:
        items.append(f"WEB_CONTROL_ERROR: {exc}")
    if channels:
        _last_inbound_channel = "control" if "control" in channels else channels[-1]
    return " | ".join(items)


def send_control(text):
    if _last_inbound_channel == "web_control":
        return _adapter("web_control").send_message(text)
    if _last_inbound_channel == "whatsapp_primary":
        return _adapter("whatsapp").send_primary(text)
    return _adapter("telegram").send_message(text)


def send_control_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(send_control(text) or "CONTROL-RICH-SEND-SUCCESS", text)


def send_web_control(text):
    return _adapter("web_control").send_message(text)


def send_web_control_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("web_control").send_message(text), text)


def send_telegram(text):
    return _adapter("telegram").send_message(text)


def send_telegram_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("telegram").send_message(text) or "TELEGRAM-RICH-SEND-SUCCESS", text)


def send_family(text):
    return _adapter("whatsapp").send_message(text)


def send_primary_operator(text):
    return _adapter("whatsapp").send_primary_operator(text)


def send_primary_operator_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("whatsapp").send_primary_operator(text), text)


def send_family_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("whatsapp").send_message(text), text)


def send_family_mention(phone, text):
    return _adapter("whatsapp").send_mention(phone, text)


def send_chat_base64(jid, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("whatsapp").send_to_chat(jid, text), text)


def reply_chat_base64(jid, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("whatsapp").reply_to_chat(jid, text), text)


def reply_to_message_base64(jid, message_id, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("whatsapp").reply_to_message(jid, message_id, text), text)


def edit_message_base64(message_id, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(_adapter("whatsapp").edit_message(message_id, text), text)


def send_chat_mention(jid, phone, text):
    return _adapter("whatsapp").send_mention_to_chat(jid, phone, text)


def send_control_file(path, caption=""):
    if _last_inbound_channel == "whatsapp_primary":
        return _adapter("whatsapp").send_file(path, caption)
    return _adapter("telegram").send_file(path, caption)


def send_family_file(path, caption=""):
    return _adapter("whatsapp").send_file(path, caption)


def send_chat_file(jid, path, caption=""):
    return _adapter("whatsapp").send_file_to_chat(jid, path, caption)


def reply_chat_file(jid, path, caption=""):
    return _adapter("whatsapp").reply_file_to_chat(jid, path, caption)
