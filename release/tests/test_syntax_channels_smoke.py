#!/usr/bin/env python3
import pathlib
import sys
import unittest
import base64

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))
import helper  # noqa: E402
from module_loader_test_utils import enabled_module_loader  # noqa: E402


class ChannelSyntaxSmokeTests(unittest.TestCase):
    def assert_metta_ok(self, expression):
        self.assertEqual(helper.test_metta_expression(expression), "METTA-SYNTAX-OK")

    def assert_parse(self, raw, expected):
        actual = helper.signature_balance_parentheses(raw)
        self.assertEqual(actual, expected)
        self.assert_metta_ok(actual)

    def test_channel_syntax_examples(self):
        cases = {
            "send-whatsapp dinner is ready: plates are out": '((send-whatsapp "dinner is ready: plates are out"))',
            "send-whatsapp Dinner (pasta) is ready": '((send-whatsapp "Dinner (pasta) is ready"))',
            "send-whatsapp-to 12345@lid hello: from agent": '((send-whatsapp-to "12345@lid" "hello: from agent"))',
            "reply-whatsapp-to 12345@lid hello: from agent": '((reply-whatsapp-to "12345@lid" "hello: from agent"))',
            "reply-whatsapp-to-message 12345@lid 12345@lid::abc123 hello: specific message": '((reply-whatsapp-to-message "12345@lid" "12345@lid::abc123" "hello: specific message"))',
            "react-whatsapp-message 12345@lid 12345@lid::abc123 thanks": '((react-whatsapp-message "12345@lid" "12345@lid::abc123" "thanks"))',
            "unreact-whatsapp-message 12345@lid 12345@lid::abc123": '((unreact-whatsapp-message "12345@lid" "12345@lid::abc123"))',
            "edit-whatsapp-message 12345@lid::own123 corrected: text": '((edit-whatsapp-message "12345@lid::own123" "corrected: text"))',
            "delete-whatsapp-message 12345@lid::own123": '((delete-whatsapp-message "12345@lid::own123"))',
            "send-primary-operator urgent: please check loop": '((send-primary-operator "urgent: please check loop"))',
            "send-file-caption /tmp/frame.png here is the frame: live": '((send-file-caption "/tmp/frame.png" "here is the frame: live"))',
            "send-whatsapp-file-to 12345@lid /tmp/frame.png": '((send-whatsapp-file-to "12345@lid" "/tmp/frame.png"))',
            "reply-whatsapp-file-to 12345@lid /tmp/frame.png": '((reply-whatsapp-file-to "12345@lid" "/tmp/frame.png"))',
            "reply-whatsapp-file-caption-to 12345@lid /tmp/frame.png here is the frame: live": '((reply-whatsapp-file-caption-to "12345@lid" "/tmp/frame.png" "here is the frame: live"))',
            "send-whatsapp-base64 RGlubmVyIGlzIHJlYWR5OgotIHBsYXRlcyBvdXQ=": '((send-whatsapp-base64 "RGlubmVyIGlzIHJlYWR5OgotIHBsYXRlcyBvdXQ="))',
            "reply-whatsapp-to 12345@lid Dinner is ready:\n- plates are out": '((reply-whatsapp-to-base64 "12345@lid" "RGlubmVyIGlzIHJlYWR5OgotIHBsYXRlcyBhcmUgb3V0"))',
            "reply-whatsapp-to-message 12345@lid 12345@lid::abc123 Dinner is ready:\n- plates are out": '((reply-whatsapp-to-message-base64 "12345@lid" "12345@lid::abc123" "RGlubmVyIGlzIHJlYWR5OgotIHBsYXRlcyBhcmUgb3V0"))',
            "edit-whatsapp-message 12345@lid::own123 Corrected:\n- line": '((edit-whatsapp-message-base64 "12345@lid::own123" "Q29ycmVjdGVkOgotIGxpbmU="))',
            "mark-whatsapp-read 12345@lid": '((mark-whatsapp-read "12345@lid"))',
            "web-search OpenCog Hyperon": '((web-search "OpenCog Hyperon"))',
            "web-search OpenCog Hyperon\nsend done": '((web-search "OpenCog Hyperon") (send "done"))',
            "send-whatsapp-to 123@lid Done: tracker rebuilt\nremember privacy lesson: General only contains non-private items": '((send-whatsapp-to "123@lid" "Done: tracker rebuilt") (remember "privacy lesson: General only contains non-private items"))',
            "Hey Jon!\n\nThis is a clean primary-channel reply.\n\n1. It can breathe.\n2. It stays one send.": '((send-control-base64 "SGV5IEpvbiEKClRoaXMgaXMgYSBjbGVhbiBwcmltYXJ5LWNoYW5uZWwgcmVwbHkuCgoxLiBJdCBjYW4gYnJlYXRoZS4KMi4gSXQgc3RheXMgb25lIHNlbmQu"))',
            '(send-whatsapp "hello: there")': '((send-whatsapp "hello: there"))',
            'send-whatsapp """\nDinner is ready:\n- plates out\n- glucose checked\n"""': '((send-whatsapp-base64 "RGlubmVyIGlzIHJlYWR5OgotIHBsYXRlcyBvdXQKLSBnbHVjb3NlIGNoZWNrZWQ="))',
        }
        with enabled_module_loader(
            helper,
            "channel_router",
            "channel_web_control",
            "channel_whatsapp",
            "web_search",
        ):
            for raw, expected in cases.items():
                with self.subTest(raw=raw[:80]):
                    self.assert_parse(raw, expected)

    def test_split_base64_channel_payload_rejoins_and_invalid_utf8_fails_closed(self):
        raw_payload = "Thank you, Jon. 🛉\n\nSecond paragraph."
        payload = base64.b64encode(raw_payload.encode("utf-8")).decode("ascii")
        split_payload = payload[:20] + "\n" + payload[20:]

        with enabled_module_loader(helper, "channel_whatsapp"):
            parsed = helper.signature_balance_parentheses(f"reply-whatsapp-to-base64 12345@lid {split_payload}")

            self.assertEqual(parsed, f'((reply-whatsapp-to-base64 "12345@lid" "{payload}"))')
            bad = helper.signature_balance_parentheses("reply-whatsapp-to-base64 12345@lid ////")
            self.assertIn("base64 payload must decode as utf-8", bad)

    def test_channel_catalog_help(self):
        with enabled_module_loader(helper, "channel_whatsapp"):
            self.assertIn("send-whatsapp", helper.skill_help("channels"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
