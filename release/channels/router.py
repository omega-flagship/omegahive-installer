import base64

import telegram
import whatsapp
import glucose
import web_control

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


def receive():
    global _last_inbound_channel
    items = []
    channels = []
    try:
        msg = telegram.getLastMessage()
        if msg:
            items.append(f"TELEGRAM_CONTROL: {msg}")
            channels.append("control")
    except Exception as exc:
        items.append(f"TELEGRAM_CONTROL_ERROR: {exc}")
    try:
        msg = whatsapp.getLastMessage()
        if msg:
            items.append(f"WHATSAPP: {msg}")
            if "WHATSAPP_PRIMARY" in msg:
                channels.append("whatsapp_primary")
    except Exception as exc:
        items.append(f"WHATSAPP_ERROR: {exc}")
    try:
        msg = glucose.pending_glucose_rings()
        if msg:
            items.append(f"GLUCOSE_APP: {msg}")
            channels.append("glucose_app")
    except Exception as exc:
        items.append(f"GLUCOSE_APP_ERROR: {exc}")
    try:
        msg = web_control.get_last_message()
        if msg:
            items.append(f"WEB_CONTROL: {msg}")
            channels.append("web_control")
    except Exception as exc:
        items.append(f"WEB_CONTROL_ERROR: {exc}")
    if channels:
        _last_inbound_channel = "control" if "control" in channels else channels[-1]
    return " | ".join(items)


def send_control(text):
    if _last_inbound_channel == "web_control":
        return web_control.send_message(text)
    if _last_inbound_channel == "whatsapp_primary":
        return whatsapp.send_primary(text)
    return telegram.send_message(text)


def send_control_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(send_control(text) or "CONTROL-RICH-SEND-SUCCESS", text)


def send_web_control(text):
    return web_control.send_message(text)


def send_web_control_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(web_control.send_message(text), text)


def send_telegram(text):
    return telegram.send_message(text)


def send_telegram_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(telegram.send_message(text) or "TELEGRAM-RICH-SEND-SUCCESS", text)


def send_family(text):
    return whatsapp.send_message(text)


def send_primary_operator(text):
    return whatsapp.send_primary_operator(text)


def send_primary_operator_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(whatsapp.send_primary_operator(text), text)


def send_family_base64(payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(whatsapp.send_message(text), text)


def send_family_mention(phone, text):
    return whatsapp.send_mention(phone, text)


def send_chat_base64(jid, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(whatsapp.send_to_chat(jid, text), text)


def reply_chat_base64(jid, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(whatsapp.reply_to_chat(jid, text), text)


def reply_to_message_base64(jid, message_id, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(whatsapp.reply_to_message(jid, message_id, text), text)


def edit_message_base64(message_id, payload):
    text, error = _decode_rich_text(payload)
    if error:
        return error
    return _rich_result(whatsapp.edit_message(message_id, text), text)


def send_chat_mention(jid, phone, text):
    return whatsapp.send_mention_to_chat(jid, phone, text)


def send_control_file(path, caption=""):
    if _last_inbound_channel == "whatsapp_primary":
        return whatsapp.send_file(path, caption)
    return telegram.send_file(path, caption)


def send_family_file(path, caption=""):
    return whatsapp.send_file(path, caption)


def send_chat_file(jid, path, caption=""):
    return whatsapp.send_file_to_chat(jid, path, caption)


def reply_chat_file(jid, path, caption=""):
    return whatsapp.reply_file_to_chat(jid, path, caption)
