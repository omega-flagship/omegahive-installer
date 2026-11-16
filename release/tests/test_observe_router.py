#!/usr/bin/env python3
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import observation  # noqa: E402


class ObserveRouterTests(unittest.TestCase):
    def module(self, **functions):
        return types.SimpleNamespace(**functions)

    def test_gameboy_routes_to_gameboy_observe(self):
        fake = self.module(gb_observe=lambda: "GB")
        with patch.dict(sys.modules, {"gameboy": fake}):
            self.assertEqual(observation.observe("gameboy"), "GB")
            self.assertEqual(observation.observe("pokemon yellow"), "GB")

    def test_house_room_device_routes(self):
        calls = []
        fake = self.module(
            observe_house=lambda: calls.append(("house",)) or "HOUSE",
            observe_house_full=lambda: calls.append(("full",)) or "FULL",
            observe_room=lambda room: calls.append(("room", room)) or f"ROOM:{room}",
            observe_device=lambda device: calls.append(("device", device)) or f"DEVICE:{device}",
            observe_house_affordances=lambda: calls.append(("affordances",)) or "AFFORDANCES",
        )
        with patch.dict(sys.modules, {"home": fake}):
            self.assertEqual(observation.observe("house"), "HOUSE")
            self.assertEqual(observation.observe("house full"), "FULL")
            self.assertEqual(observation.observe("room Living Room"), "ROOM:Living Room")
            self.assertEqual(observation.observe("device light.living"), "DEVICE:light.living")
            self.assertEqual(observation.observe("affordances"), "AFFORDANCES")
        self.assertIn(("room", "Living Room"), calls)
        self.assertIn(("device", "light.living"), calls)

    def test_health_and_channel_routes(self):
        glucose = self.module(observe_glucose=lambda person: f"GLUCOSE:{person}")
        whatsapp = self.module(inbox=lambda: "INBOX")
        with patch.dict(sys.modules, {"glucose": glucose, "whatsapp": whatsapp}):
            self.assertEqual(observation.observe("glucose Patient"), "GLUCOSE:Patient")
            self.assertIn("OBSERVE-UNKNOWN-TARGET", observation.observe("blood sugar"))
            self.assertEqual(observation.observe("whatsapp"), "INBOX")

    def test_webcam_image_audio_routes(self):
        webcam = self.module(inspect_webcam=lambda question: "WEBCAM:" + question[:12])
        vision = self.module(observe_image=lambda image_id: f"IMAGE:{image_id}")
        audio = self.module(observe_audio=lambda audio_id: f"AUDIO:{audio_id}")
        with patch.dict(sys.modules, {"webcam": webcam, "vision": vision, "audio": audio}):
            self.assertTrue(observation.observe("webcam").startswith("WEBCAM:"))
            self.assertEqual(observation.observe("image img-123"), "IMAGE:img-123")
            self.assertEqual(observation.observe("audio aud-123"), "AUDIO:aud-123")

    def test_unknown_target_fails_closed(self):
        result = observation.observe("something mysterious")
        self.assertIn("OBSERVE-UNKNOWN-TARGET", result)
        self.assertIn("observe gameboy", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
