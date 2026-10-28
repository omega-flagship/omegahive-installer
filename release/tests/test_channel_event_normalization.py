import importlib.util
import pathlib
import sys
import types
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
ROUTER = ROOT / "modules" / "channel_router" / "src" / "router.py"


def load_router_module():
    for name in ("telegram", "whatsapp", "glucose", "web_control"):
        module = types.ModuleType(name)
        module.getLastMessage = lambda: ""
        module.getLastEvents = lambda: []
        module.pending_glucose_rings = lambda: ""
        module.get_last_message = lambda: ""
        module.send_message = lambda text: text
        module.send_primary = lambda text: text
        module.send_primary_operator = lambda text: text
        sys.modules[name] = module
    spec = importlib.util.spec_from_file_location("channel_router_under_test", ROUTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_router_module_without_stubs():
    for name in ("telegram", "whatsapp", "glucose", "web_control"):
        sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location("channel_router_import_under_test", ROUTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ChannelEventNormalizationTest(unittest.TestCase):
    def setUp(self):
        self.router = load_router_module()

    def test_structured_primary_event_is_preferred_over_notice_parsing(self):
        view = self.router.normalize_channel_event(
            {
                "event": "message",
                "channel": "whatsapp",
                "route": "primary-operator",
                "conversation_id": "sampleuser@lid",
                "message_id": "sampleuser@lid::3BABC",
                "sender": "Primary Operator",
                "text": "hello from the primary route",
            }
        )

        self.assertIn("channel=whatsapp", view)
        self.assertIn("route=primary-operator", view)
        self.assertIn("sender=Primary Operator", view)
        self.assertIn("text=hello from the primary route", view)
        self.assertIn("reply_affordance=send message", view)
        self.assertNotIn("sampleuser@lid", view)

    def test_router_loads_local_adapters_without_ambient_python_path(self):
        router = load_router_module_without_stubs()
        telegram = router._adapter("telegram")

        self.assertIn("modules/channel_telegram/src/telegram.py", str(pathlib.Path(telegram.__file__)))

    def test_structured_secondary_event_exposes_conversation_id(self):
        view = self.router.normalize_channel_event(
            {
                "event": "message-notice",
                "channel": "whatsapp",
                "route": "explicit-chat",
                "conversation_id": "secondary@lid",
                "message_id": "secondary@lid::3BDEF",
                "sender": "Secondary Contact",
                "text": "<inspect-chat-for-current-text>",
            }
        )

        self.assertIn("route=explicit-chat", view)
        self.assertIn("conversation_id=secondary@lid", view)
        self.assertIn("reply_affordance=send-whatsapp-to conversation_id message", view)

    def test_primary_whatsapp_hides_route_handle_but_keeps_human_text(self):
        view = self.router.normalize_channel_notice(
            "whatsapp",
            "WHATSAPP_PRIMARY id=sampleuser@lid::3BABC at=2026-05-28T15:02:29.894Z: Primary Operator: why did you write WHATSAPP_PRIMARY ?",
        )

        self.assertIn("channel=whatsapp", view)
        self.assertIn("compatibility=legacy-notice-parser", view)
        self.assertIn("route=primary-operator", view)
        self.assertIn("sender=Primary Operator", view)
        self.assertIn("text=why did you write WHATSAPP_PRIMARY ?", view)
        self.assertIn("reply_affordance=send message", view)
        self.assertNotIn("sampleuser@lid", view)
        self.assertNotIn("WHATSAPP_PRIMARY id=", view)

    def test_secondary_whatsapp_exposes_explicit_route_as_metadata(self):
        view = self.router.normalize_channel_notice(
            "whatsapp",
            "WHATSAPP_INBOX_NOTICE id=secondary@lid::3BDEF at=2026-05-28T15:02:29.894Z: new message from Secondary Contact jid=secondary@lid unread=1",
        )

        self.assertIn("route=explicit-chat", view)
        self.assertIn("conversation_id=secondary@lid", view)
        self.assertIn("sender=Secondary Contact", view)
        self.assertIn("text=<inspect-chat-for-current-text>", view)
        self.assertIn("reply_affordance=send-whatsapp-to conversation_id message", view)
        self.assertNotIn("jid=secondary@lid", view)

    def test_primary_whatsapp_reaction_and_edit_do_not_leak_jid(self):
        reaction = self.router.normalize_channel_notice(
            "whatsapp",
            "WHATSAPP_PRIMARY_REACTION id=sampleuser@lid::3BABC emoji=ok jid=sampleuser@lid",
        )
        edit = self.router.normalize_channel_notice(
            "whatsapp",
            "WHATSAPP_PRIMARY_EDIT id=sampleuser@lid::3BABC jid=sampleuser@lid: corrected text",
        )

        self.assertIn("event=reaction", reaction)
        self.assertIn("emoji=ok", reaction)
        self.assertNotIn("sampleuser@lid", reaction)
        self.assertIn("event=edit", edit)
        self.assertIn("text=corrected text", edit)
        self.assertNotIn("sampleuser@lid", edit)

    def test_non_whatsapp_channels_use_same_shape(self):
        telegram = self.router.normalize_channel_notice("telegram", "Operator: hello via Telegram")
        mattermost = self.router.normalize_channel_notice("mattermost", "Researcher: hello from Mattermost")

        self.assertIn("CHANNEL_EVENT", telegram)
        self.assertIn("channel=telegram", telegram)
        self.assertIn("reply_affordance=send message", telegram)
        self.assertIn("CHANNEL_EVENT", mattermost)
        self.assertIn("channel=mattermost", mattermost)
        self.assertIn("reply_affordance=send message", mattermost)

    def test_router_owned_channels_are_structured_events(self):
        web = self.router.normalize_channel_event(self.router._control_event("web_control", "button clicked"))
        glucose = self.router.normalize_channel_event(
            {
                "event": "notice",
                "channel": "glucose",
                "route": "control",
                "conversation_id": "current-control-route",
                "message_id": "unavailable",
                "sender": "glucose-watch",
                "text": "watch threshold crossed",
                "reply_affordance": "inspect glucose skill card",
            }
        )

        self.assertIn("channel=web_control", web)
        self.assertIn("reply_affordance=send message", web)
        self.assertIn("channel=glucose", glucose)
        self.assertIn("reply_affordance=inspect glucose skill card", glucose)

    def test_receive_uses_normalized_view_and_preserves_primary_route(self):
        sys.modules["whatsapp"].getLastMessage = lambda: (
            "WHATSAPP_PRIMARY id=sampleuser@lid::3BABC at=2026-05-28T15:02:29.894Z: Primary Operator: hello"
        )
        sys.modules["whatsapp"].getLastEvents = lambda: [
            {
                "event": "message",
                "channel": "whatsapp",
                "route": "primary-operator",
                "conversation_id": "sampleuser@lid",
                "message_id": "sampleuser@lid::3BABC",
                "sender": "Primary Operator",
                "text": "hello",
            }
        ]
        sys.modules["whatsapp"].send_primary = lambda text: f"primary:{text}"

        view = self.router.receive()
        result = self.router.send_control("reply body only")

        self.assertIn("CHANNEL_EVENT", view)
        self.assertIn("route=primary-operator", view)
        self.assertIn("text=hello", view)
        self.assertNotIn("sampleuser@lid", view)
        self.assertNotIn("WHATSAPP_PRIMARY", view)
        self.assertEqual(result, "primary:reply body only")

    def test_channel_event_contract_is_visible_in_affordance_atoms(self):
        affordance = (ROOT / "modules" / "channel_router" / "affordance.metta").read_text()

        self.assertIn("ChannelEventContract", affordance)
        self.assertIn("ChannelEventField \"text\"", affordance)
        self.assertIn("ChannelEventPolicy \"legacy-parser\"", affordance)
        self.assertIn("transport ids are metadata, not message text", affordance)


if __name__ == "__main__":
    unittest.main()
