"""Portability checks for the local mock channel RPC harness."""

import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_rpc():
    path = ROOT / "Autotests" / "mock" / "rpc.py"
    spec = importlib.util.spec_from_file_location("_omegaclaw_mock_rpc", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_mock_channel():
    path = ROOT / "modules" / "channel_mock" / "src" / "mock.py"
    spec = importlib.util.spec_from_file_location("_omegaclaw_channel_mock", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class MockRpcPortabilityTests(unittest.TestCase):
    def test_pollrdhup_falls_back_to_pollhup_on_macos(self):
        rpc = load_rpc()

        with mock.patch.object(rpc.select, "POLLRDHUP", rpc.select.POLLHUP, create=True):
            self.assertEqual(rpc.pollrdhup_flag(), rpc.select.POLLHUP)

    def test_mock_channel_file_mode_round_trips_without_rpc_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": tmp}, clear=True):
                channel = load_mock_channel()

                self.assertEqual(channel.start_mock(), "MOCK-CHANNEL-READY mode=file")
                self.assertEqual(channel.enqueue_user_message("hello", "tester"), "MOCK-ENQUEUE-SUCCESS")
                self.assertEqual(channel.getLastMessage(), "tester: hello")
                self.assertEqual(channel.getLastMessage(), "")
                self.assertEqual(channel.send_message("reply"), "MOCK-SEND-SUCCESS")
                self.assertTrue(any(record["text"] == "reply" for record in channel.recent_messages()))


if __name__ == "__main__":
    unittest.main()
