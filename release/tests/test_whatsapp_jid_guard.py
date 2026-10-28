import importlib.util
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
WHATSAPP = ROOT / "modules" / "channel_whatsapp" / "src" / "whatsapp.py"


def load_whatsapp_module():
    spec = importlib.util.spec_from_file_location("whatsapp_module_under_test", WHATSAPP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WhatsAppJidGuardTest(unittest.TestCase):
    def test_primary_route_rejects_leading_jid_in_body(self):
        whatsapp = load_whatsapp_module()
        result = whatsapp._guard_primary_route_body("sampleuser@lid hello", "send-whatsapp")
        self.assertIn("MESSAGE-NOT-DELIVERED", result)
        self.assertIn("WHATSAPP-JID-IN-MESSAGE-BODY", result)
        self.assertIn("send-whatsapp-to jid message", result)

    def test_primary_route_allows_normal_message(self):
        whatsapp = load_whatsapp_module()
        result = whatsapp._guard_primary_route_body("hello sampleuser@lid is only discussed", "send-whatsapp")
        self.assertEqual(result, "")

    def test_primary_route_rejects_message_id_prefix(self):
        whatsapp = load_whatsapp_module()
        result = whatsapp._guard_primary_route_body("sampleuser@lid::3BABCDEF hello", "send-whatsapp")
        self.assertIn("MESSAGE-NOT-DELIVERED", result)
        self.assertIn("sampleuser@lid::3BABCDEF", result)

    def test_explicit_send_rejects_stale_primary_alias(self):
        whatsapp = load_whatsapp_module()
        with mock.patch.object(whatsapp, "_current_primary_jid", return_value="1000@lid"):
            safe_jid, error = whatsapp._validate_reply_jid("1000@s.whatsapp.net")
        self.assertEqual(safe_jid, "")
        self.assertIn("WHATSAPP-STALE-PRIMARY-ALIAS", error)
        self.assertIn("current_primary=1000@lid", error)

    def test_explicit_send_rejects_route_label_as_jid(self):
        whatsapp = load_whatsapp_module()
        with mock.patch.object(whatsapp, "_current_primary_jid", return_value="1000@lid"):
            safe_jid, error = whatsapp._validate_reply_jid("WHATSAPP:1000@lid")
        self.assertEqual(safe_jid, "")
        self.assertIn("WHATSAPP-UNKNOWN-CHAT", error)

    def test_send_to_chat_fails_before_network_for_bad_route(self):
        whatsapp = load_whatsapp_module()
        with mock.patch.object(whatsapp, "_current_primary_jid", return_value="1000@lid"):
            with mock.patch.object(whatsapp, "_json_request") as json_request:
                result = whatsapp.send_to_chat("1000@s.whatsapp.net", "hello")
        self.assertIn("WHATSAPP-SEND-TO-CHAT-FAILED", result)
        self.assertIn("WHATSAPP-STALE-PRIMARY-ALIAS", result)
        json_request.assert_not_called()

    def test_bridge_rejects_prefixed_and_stale_targets(self):
        bridge = ROOT / "modules" / "channel_whatsapp" / "src" / "whatsapp_bridge" / "bridge.mjs"
        source = bridge.read_text(encoding="utf-8")
        self.assertIn("if (/^[A-Za-z_]+:/.test(raw)) return ''", source)
        self.assertIn("function stalePrimaryAliasError", source)
        self.assertIn("WHATSAPP-STALE-PRIMARY-ALIAS", source)

    def test_whatsapp_cards_warn_about_route_authority_and_stale_aliases(self):
        affordance = (ROOT / "modules" / "channel_whatsapp" / "affordance.metta").read_text(encoding="utf-8")
        catalog = (ROOT / "modules" / "channel_whatsapp" / "catalog.metta").read_text(encoding="utf-8")
        source = affordance + "\n" + catalog
        for expected in [
            "current primary route",
            "WHATSAPP:",
            "raw known/current jid",
            "WHATSAPP-STALE-PRIMARY-ALIAS",
            "inspect the returned success/failure",
            "use status/inbox as route authority",
        ]:
            self.assertIn(expected, source)


if __name__ == "__main__":
    unittest.main()
