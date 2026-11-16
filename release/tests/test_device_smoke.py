#!/usr/bin/env python3
"""Dry smoke tests for the agent's device organs.

These checks are read-only or local-only. They must not send messages, change
house state, publish/unpublish artifacts, or alter live inbox read state.
"""

import json
import pathlib
import re
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = ROOT.parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "channels"))

import energy  # noqa: E402
import home  # noqa: E402
import router  # noqa: E402
import whatsapp  # noqa: E402


def configured_whatsapp_port(default=3055):
    run_file = OMEGACLAW_ROOT / "run.metta"
    try:
        text = run_file.read_text(encoding="utf-8")
    except Exception:
        return default
    match = re.search(r"\(=\s+\(WA_PORT\)\s+([0-9]+)\)", text)
    return int(match.group(1)) if match else default


class WhatsAppBridgeDryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        whatsapp._port = configured_whatsapp_port()

    def test_bridge_health_endpoint_shape(self):
        status = whatsapp.status()
        if status.startswith("WHATSAPP-STATUS-FAILED"):
            self.skipTest(status)
        payload = json.loads(status)
        self.assertTrue(payload.get("ok"))
        self.assertIn("connected", payload)
        self.assertIn("primaryJid", payload)
        self.assertIn("queue", payload)

    def test_inbox_summary_shape_is_read_only(self):
        inbox = whatsapp.inbox()
        if inbox.startswith("WHATSAPP-INBOX-FAILED"):
            self.skipTest(inbox)
        self.assertTrue(
            inbox == "WHATSAPP-INBOX-EMPTY" or inbox.startswith("PRIMARY "),
            inbox,
        )

    def test_whatsapp_reusable_defaults_are_deployment_neutral(self):
        wrapper = (ROOT / "channels" / "whatsapp.py").read_text(encoding="utf-8")
        bridge = (ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs").read_text(encoding="utf-8")
        self.assertIn('_prefix = ""', wrapper)
        self.assertIn('def start_whatsapp(target_jid="", port=3055, prefix="", primary_jid="")', wrapper)
        self.assertNotIn("auth_" + "omega", wrapper)
        self.assertIn(": ''", bridge)
        self.assertNotIn(": 'the agent" + "- '", bridge)

    def test_whatsapp_bridge_normalizes_message_ids_to_chat_jids(self):
        bridge = (ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs").read_text(encoding="utf-8")
        self.assertIn("function normalizeJid(value)", bridge)
        self.assertIn("@(lid|g\\.us|s\\.whatsapp\\.net|broadcast|newsletter)", bridge)
        self.assertIn("messageKeyMatch[1]", bridge)

    def test_rich_text_decode_reports_errors_without_sending(self):
        text, error = router._decode_rich_text("TGluZTE6IG9rCkxpbmUy")
        self.assertEqual(error, "")
        self.assertEqual(text, "Line1: ok\nLine2")
        text, error = router._decode_rich_text("not-base64!")
        self.assertIsNone(text)
        self.assertIn("RICH-TEXT-DECODE-FAILED", error)

    def test_reply_to_chat_composes_send_then_mark_read_without_magic_send(self):
        calls = []
        original = whatsapp._json_request
        original_primary = whatsapp._primary_jid
        whatsapp._primary_jid = "123@lid"

        def fake_request(method, path, payload=None, timeout=10):
            calls.append((method, path, payload))
            if path == "/send":
                return {
                    "ok": True,
                    "handled": {
                        "changed": 0,
                        "readReceipts": {"attempted": 0, "sent": 0},
                        "note": "send-does-not-mark-inbound-read-use-mark-whatsapp-read",
                    },
                }
            if path == "/chat-state":
                return {
                    "ok": True,
                    "jid": payload["jid"],
                    "changed": 2,
                    "readReceipts": {"attempted": 2, "sent": 2},
                }
            raise AssertionError(path)

        try:
            whatsapp._json_request = fake_request
            result = whatsapp.reply_to_chat("123@lid", "hello")
        finally:
            whatsapp._json_request = original
            whatsapp._primary_jid = original_primary

        self.assertIn("WHATSAPP-REPLY-TO-CHAT-SUCCESS", result)
        self.assertIn("WHATSAPP-SEND-TO-CHAT-SUCCESS", result)
        self.assertIn("WHATSAPP-MARK-READ-SUCCESS", result)
        self.assertIn(("POST", "/send", {"text": "hello", "to": "123@lid"}), calls)
        self.assertIn(("POST", "/chat-state", {"jid": "123@lid", "state": "read", "scope": "all"}), calls)

    def test_reply_file_to_chat_composes_send_file_then_mark_read(self):
        calls = []
        original = whatsapp._json_request

        def fake_request(method, path, payload=None, timeout=10):
            calls.append((method, path, payload))
            if path == "/send-file":
                return {"ok": True, "handled": {"changed": 0}}
            if path == "/chat-state":
                return {
                    "ok": True,
                    "jid": payload["jid"],
                    "changed": 1,
                    "readReceipts": {"attempted": 1, "sent": 1},
                }
            raise AssertionError(path)

        try:
            whatsapp._json_request = fake_request
            result = whatsapp.reply_file_to_chat("123@lid", "/tmp/frame.png", "frame")
        finally:
            whatsapp._json_request = original

        self.assertIn("WHATSAPP-REPLY-FILE-TO-CHAT", result)
        self.assertIn("WHATSAPP-SEND-FILE-TO-CHAT-SUCCESS", result)
        self.assertIn("WHATSAPP-MARK-READ-SUCCESS", result)
        self.assertEqual(calls[0][0:2], ("POST", "/send-file"))
        self.assertEqual(calls[0][2]["to"], "123@lid")
        self.assertEqual(calls[0][2]["path"], "/tmp/frame.png")
        self.assertEqual(calls[0][2]["caption"], "frame")
        self.assertEqual(calls[1], ("POST", "/chat-state", {"jid": "123@lid", "state": "read", "scope": "all"}))

    def test_reply_to_chat_does_not_mark_read_when_send_fails(self):
        calls = []
        original = whatsapp._json_request
        original_primary = whatsapp._primary_jid
        whatsapp._primary_jid = "123@lid"

        def fake_request(method, path, payload=None, timeout=10):
            calls.append((method, path, payload))
            if path == "/send":
                return {"ok": False, "error": "not connected"}
            return {"ok": True, "inbox": [], "chats": []}

        try:
            whatsapp._json_request = fake_request
            result = whatsapp.reply_to_chat("123@lid", "hello")
        finally:
            whatsapp._json_request = original
            whatsapp._primary_jid = original_primary

        self.assertIn("WHATSAPP-REPLY-TO-CHAT-FAILED", result)
        self.assertIn(("POST", "/send", {"text": "hello", "to": "123@lid"}), calls)
        self.assertNotIn(("POST", "/chat-state", {"jid": "123@lid", "state": "read", "scope": "all"}), calls)

    def test_non_primary_media_notices_include_saved_path(self):
        bridge = ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs"
        text = bridge.read_text(encoding="utf-8")
        self.assertIn(
            "WHATSAPP_INBOX_NOTICE${noticeMeta(item)}: new ${kind.replace('Message', '')}",
            text,
        )
        self.assertIn("unread=${unread} saved at ${saved}${caption}", text)

    def test_whatsapp_read_state_separates_seen_from_handled(self):
        bridge = ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs"
        text = bridge.read_text(encoding="utf-8")
        chat_messages_handler = re.search(
            r"if \(req\.method === 'GET' && url\.pathname === '/chat-messages'\) \{(?P<body>.*?)\n    \}",
            text,
            re.S,
        )
        self.assertIsNotNone(chat_messages_handler)
        body = chat_messages_handler.group("body")
        self.assertIn("const STATE_RANK = { unread: 0, delivered: 1, seen: 2, read: 3 }", text)
        self.assertIn("markChatState(jid, 'seen', 'all')", body)
        self.assertNotIn("markChatState(jid, 'read', 'all')", body)
        self.assertIn("async function markOutboundHandled(jid)", text)
        self.assertIn("send-does-not-mark-inbound-read-use-mark-whatsapp-read", text)
        self.assertNotIn("const handled = await markOutboundHandled(to)", text)
        self.assertIn("async function sendReadReceiptsFor", text)
        self.assertIn("await sock.readMessages(keys)", text)
        self.assertIn("readReceipts", text)

    def test_whatsapp_delivered_messages_remain_pending_until_read(self):
        bridge = ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs"
        text = bridge.read_text(encoding="utf-8")
        self.assertIn("item.unread + item.delivered", text)
        self.assertIn("item.state === 'unread' || item.state === 'delivered'", text)
        self.assertIn("pending=${pending.length}", text)
        self.assertNotIn("const summaries = inboxSummary().filter(item => item.unread > 0)", text)

    def test_whatsapp_primary_messages_mark_read_when_injected(self):
        bridge = ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs"
        text = bridge.read_text(encoding="utf-8")
        self.assertIn("async function applyDeliveryState(delivery)", text)
        self.assertIn("if (delivery.state === 'read') await sendReadReceiptsFor", text)
        self.assertIn("await Promise.all(entries.map(async entry =>", text)
        self.assertIn("WHATSAPP_PRIMARY${noticeMeta(item)}", text)
        self.assertIn("state: 'read'", text)

    def test_whatsapp_advanced_actions_are_trace_backed_and_guarded(self):
        bridge = (ROOT / "modules" / "channel_whatsapp" / "src" / "whatsapp_bridge" / "bridge.mjs").read_text(encoding="utf-8")
        adapter = (ROOT / "modules" / "channel_whatsapp" / "src" / "whatsapp.py").read_text(encoding="utf-8")
        channels = (ROOT / "modules" / "channel_whatsapp" / "skills.metta").read_text(encoding="utf-8")
        self.assertIn("let messageRefs = new Map()", bridge)
        self.assertIn("function traceEvent(event)", bridge)
        self.assertIn("entry.waKey?.id === safeId", bridge)
        self.assertIn("url.pathname === '/reply-to-message'", bridge)
        self.assertIn("url.pathname === '/react'", bridge)
        self.assertIn("url.pathname === '/edit'", bridge)
        self.assertIn("url.pathname === '/delete'", bridge)
        self.assertIn("WHATSAPP-EDIT-NOT-OWN-MESSAGE", bridge)
        self.assertIn("WHATSAPP-DELETE-NOT-OWN-MESSAGE", bridge)
        self.assertIn("sock.ev.on('messages.reaction'", bridge)
        self.assertIn("const key = event?.key || event?.reaction?.key", bridge)
        self.assertIn("sock.ev.on('messages.update'", bridge)
        self.assertIn("sock.ev.on('messages.delete'", bridge)
        self.assertIn("primaryOperatorRoute", bridge)
        self.assertIn("def reply_to_message", adapter)
        self.assertIn("def send_primary_operator", adapter)
        self.assertIn("(= (send-primary-operator $msg)", channels)

    def test_reply_to_message_composes_quote_then_mark_read(self):
        calls = []
        original_request = whatsapp._json_request
        original_primary = whatsapp._primary_jid
        whatsapp._primary_jid = "123@lid"

        def fake_request(method, path, payload=None, timeout=10):
            calls.append((method, path, payload))
            if path == "/reply-to-message":
                return {"ok": True, "messageId": "123@lid::reply-id", "quotedMessageId": payload["messageId"]}
            if path == "/chat-state":
                return {"ok": True, "jid": payload["jid"], "changed": 1, "readReceipts": {"attempted": 1, "sent": 1}}
            return {"ok": True, "inbox": [], "chats": []}

        try:
            whatsapp._json_request = fake_request
            result = whatsapp.reply_to_message("123@lid", "123@lid::msg-id", "quoted hello")
        finally:
            whatsapp._json_request = original_request
            whatsapp._primary_jid = original_primary

        self.assertIn("WHATSAPP-REPLY-TO-MESSAGE-SUCCESS", result)
        self.assertIn(("POST", "/reply-to-message", {"to": "123@lid", "messageId": "123@lid::msg-id", "text": "quoted hello"}), calls)
        self.assertIn(("POST", "/chat-state", {"jid": "123@lid", "state": "read", "scope": "all"}), calls)

    def test_react_edit_delete_adapters_call_guarded_endpoints(self):
        calls = []
        original_request = whatsapp._json_request
        original_primary = whatsapp._primary_jid
        whatsapp._primary_jid = "123@lid"

        def fake_request(method, path, payload=None, timeout=10):
            calls.append((method, path, payload))
            if path == "/react":
                return {"ok": True, "messageId": payload["messageId"], "emoji": payload["emoji"]}
            if path == "/edit":
                return {"ok": True, "messageId": payload["messageId"]}
            if path == "/delete":
                return {"ok": True, "messageId": payload["messageId"]}
            return {"ok": True, "inbox": [], "chats": []}

        try:
            whatsapp._json_request = fake_request
            react = whatsapp.react_message("123@lid", "123@lid::msg-id", "OK")
            unreact = whatsapp.unreact_message("123@lid", "123@lid::msg-id")
            edit = whatsapp.edit_message("123@lid::own-id", "updated")
            delete = whatsapp.delete_message("123@lid::own-id")
        finally:
            whatsapp._json_request = original_request
            whatsapp._primary_jid = original_primary

        self.assertIn("WHATSAPP-REACT-SUCCESS", react)
        self.assertIn("WHATSAPP-REACT-SUCCESS", unreact)
        self.assertIn("WHATSAPP-EDIT-SUCCESS", edit)
        self.assertIn("WHATSAPP-DELETE-SUCCESS", delete)
        self.assertIn(("POST", "/edit", {"messageId": "123@lid::own-id", "text": "updated"}), calls)
        self.assertIn(("POST", "/delete", {"messageId": "123@lid::own-id"}), calls)


class HouseDryTests(unittest.TestCase):
    def test_area_entities_resolves_natural_room_aliases(self):
        def fake_template(template):
            if 'area_entities("living_room")' in template:
                return ["light.tv_main", "light.fire_main"]
            return []

        with mock.patch.object(home, "_areas", return_value=[{"id": "living_room", "name": "Living Room"}]), \
             mock.patch.object(home, "_template", side_effect=fake_template):
            for alias in ("Living", "living", "Living Room", "living_room", "living-room"):
                with self.subTest(alias=alias):
                    self.assertEqual(home._area_entities(alias), ["light.tv_main", "light.fire_main"])

    def test_observe_house_returns_compact_state_or_config_error(self):
        result = home.observe_house()
        self.assertIsInstance(result, str)
        self.assertTrue(
            result.startswith("HOUSE-OBSERVATION")
            or result.startswith("HOUSE-OBSERVATION-FAILED"),
            result[:240],
        )

    def test_house_affordances_are_observable_without_acting(self):
        result = home.observe_house_affordances()
        self.assertIsInstance(result, str)
        self.assertTrue(
            result.startswith("HOUSE-AFFORDANCES")
            or result.startswith("HOUSE-AFFORDANCES-FAILED"),
            result[:240],
        )
        if result.startswith("HOUSE-AFFORDANCES "):
            self.assertIn("affordances", result)


class EnergyDryTests(unittest.TestCase):
    def test_energy_status_and_last_call_are_parseable_strings(self):
        status = energy.energy_status()
        self.assertTrue(status.startswith("ENERGY-STATUS"), status)
        self.assertIn("daily_target=", status)
        self.assertIn("spent_today=", status)
        last = energy.cost_last_call()
        if last != "NO-COST-CALLS":
            payload = json.loads(last)
            self.assertIn("cost_usd", payload)
            self.assertIn("model", payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
