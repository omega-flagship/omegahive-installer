import importlib.util
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
TELEGRAM = ROOT / "modules" / "channel_telegram" / "src" / "telegram.py"


def load_telegram_module():
    spec = importlib.util.spec_from_file_location("telegram_module_under_test", TELEGRAM)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TelegramSendGuardTest(unittest.TestCase):
    def test_send_rejects_route_label_in_body(self):
        telegram = load_telegram_module()
        result = telegram._guard_configured_chat_body("TELEGRAM:control hello", "send-telegram")
        self.assertIn("MESSAGE-NOT-DELIVERED", result)
        self.assertIn("TELEGRAM-TARGET-IN-MESSAGE-BODY", result)

    def test_send_rejects_chat_id_prefix_in_body(self):
        telegram = load_telegram_module()
        result = telegram._guard_configured_chat_body("chat_id=100000 hello", "send-telegram")
        self.assertIn("MESSAGE-NOT-DELIVERED", result)
        self.assertIn("chat_id=100000", result)

    def test_send_allows_normal_message_with_number_later(self):
        telegram = load_telegram_module()
        result = telegram._guard_configured_chat_body("hello about 100000 things", "send-telegram")
        self.assertEqual(result, "")

    def test_send_fails_before_network_for_body_target(self):
        telegram = load_telegram_module()
        telegram._connected = True
        telegram._chat_id = "configured-chat"
        with mock.patch.object(telegram, "_api_call") as api_call:
            result = telegram.send_message("TELEGRAM:configured-chat hello")
        self.assertIn("MESSAGE-NOT-DELIVERED", result)
        self.assertIn("TELEGRAM-TARGET-IN-MESSAGE-BODY", result)
        api_call.assert_not_called()

    def test_send_returns_success_status(self):
        telegram = load_telegram_module()
        telegram._connected = True
        telegram._chat_id = "configured-chat"
        with mock.patch.object(telegram, "_api_call", return_value={}):
            result = telegram.send_message("hello")
        self.assertEqual(result, "TELEGRAM-SEND-SUCCESS chunks=1")

    def test_start_preserves_pending_updates_when_auth_required(self):
        telegram = load_telegram_module()
        fake_thread = mock.Mock()
        with mock.patch.object(telegram, "_initialize_offset") as initialize_offset, \
             mock.patch.object(telegram.threading, "Thread", return_value=fake_thread):
            telegram.start_telegram("token", "", 1, auth_secret="secret")
        initialize_offset.assert_not_called()
        fake_thread.start.assert_called_once()
        self.assertEqual(telegram._auth_secret, "secret")

    def test_start_skips_stale_updates_when_auth_not_required(self):
        telegram = load_telegram_module()
        fake_thread = mock.Mock()
        with mock.patch.object(telegram, "_initialize_offset") as initialize_offset, \
             mock.patch.object(telegram.threading, "Thread", return_value=fake_thread):
            telegram.start_telegram("token", "", 1, auth_secret="")
        initialize_offset.assert_called_once()
        fake_thread.start.assert_called_once()

    def test_channel_post_auth_can_bind_by_chat_id_without_user(self):
        telegram = load_telegram_module()
        telegram._set_auth_secret("secret")
        result = telegram._is_allowed_message("-100123", "", "/auth secret", is_channel_post=True)
        self.assertEqual(result, "auth_bound")
        self.assertEqual(telegram._chat_id, "-100123")
        self.assertEqual(telegram._authenticated_chat_id, "-100123")
        self.assertEqual(telegram._authenticated_user_id, "-100123")
        self.assertEqual(
            telegram._is_allowed_message("-100123", "", "hello", is_channel_post=True),
            "allow",
        )

    def test_update_extractor_accepts_channel_posts(self):
        telegram = load_telegram_module()
        kind, message = telegram._message_from_update({"channel_post": {"text": "hello"}})
        self.assertEqual(kind, "channel_post")
        self.assertEqual(message["text"], "hello")
        kind, message = telegram._message_from_update({"edited_channel_post": {"text": "edited"}})
        self.assertEqual(kind, "edited_channel_post")
        self.assertEqual(message["text"], "edited")

    def test_status_exposes_bind_and_ignored_state(self):
        telegram = load_telegram_module()
        telegram._set_auth_secret("secret")
        state = telegram._is_allowed_message("chat-a", "user-a", "wrong")
        self.assertEqual(state, "ignore:auth-required")
        status = telegram.status()
        self.assertIn("TELEGRAM-STATUS", status)
        self.assertIn("auth_required=True", status)
        self.assertIn("ignored=auth-required:1", status)

    def test_terminal_log_can_be_disabled(self):
        telegram = load_telegram_module()
        with mock.patch.dict("os.environ", {"OMEGACLAW_CHANNEL_DEBUG": "0"}), \
             mock.patch("builtins.print") as printer:
            telegram._log("diagnostic")
        printer.assert_not_called()

    def test_terminal_log_does_not_require_message_body(self):
        telegram = load_telegram_module()
        with mock.patch.dict("os.environ", {"OMEGACLAW_CHANNEL_DEBUG": "1"}), \
             mock.patch("builtins.print") as printer:
            telegram._log("Accepted update id=1 kind=message chat=chat-a has_text=True")
        args, kwargs = printer.call_args
        self.assertIn("[TELEGRAM] Accepted update", args[0])
        self.assertNotIn("secret text", args[0])
        self.assertTrue(kwargs.get("flush"))

    def test_telegram_cards_warn_about_configured_route_and_send_results(self):
        affordance = (ROOT / "modules" / "channel_telegram" / "affordance.metta").read_text(encoding="utf-8")
        catalog = (ROOT / "modules" / "channel_telegram" / "catalog.metta").read_text(encoding="utf-8")
        source = affordance + "\n" + catalog
        for expected in [
            "configured Telegram control chat",
            "TELEGRAM:/chat_id/target prefix",
            "TELEGRAM-TARGET-IN-MESSAGE-BODY",
            "routing is config/auth state",
            "inspect the returned success/failure",
            "telegram-status",
        ]:
            self.assertIn(expected, source)


if __name__ == "__main__":
    unittest.main()
