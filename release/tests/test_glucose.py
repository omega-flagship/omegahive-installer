#!/usr/bin/env python3
"""Local mocked checks for the agent's external glucose app connector."""

import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import glucose  # noqa: E402


class GlucoseConnectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.memory = pathlib.Path(self.tmp.name)
        self.old_paths = (
            glucose.MEMORY,
            glucose.CONFIG_FILE,
            glucose.CACHE_FILE,
            glucose.TRACE_LOG,
            glucose.WATCH_FILE,
        )
        glucose.MEMORY = self.memory
        glucose.CONFIG_FILE = self.memory / "librelinkup.json"
        glucose.CACHE_FILE = self.memory / "librelinkup_cache.json"
        glucose.TRACE_LOG = self.memory / "glucose_observations.jsonl"
        glucose.WATCH_FILE = self.memory / "glucose_watches.json"

    def tearDown(self):
        (
            glucose.MEMORY,
            glucose.CONFIG_FILE,
            glucose.CACHE_FILE,
            glucose.TRACE_LOG,
            glucose.WATCH_FILE,
        ) = self.old_paths
        self.tmp.cleanup()

    def fake_request(self, base, method, path, config, payload=None, token=None, account_id=None, timeout=15):
        if path == "/llu/auth/login":
            return {
                "data": {
                    "user": {"id": "user-123"},
                    "authTicket": {"token": "token-abc", "expires": 4102444800},
                }
            }
        if path == "/llu/connections":
            self.assertEqual(account_id, glucose.hashlib.sha256(b"user-123").hexdigest())
            return {
                "data": [
                    {
                        "id": "connection-1",
                        "patientId": "patient-1",
                        "firstName": "Patient",
                        "lastName": "Example",
                        "uom": 2,
                    }
                ]
            }
        if path == "/llu/connections/patient-1/graph":
            return {
                "data": {
                    "connection": {
                        "patientId": "patient-1",
                        "firstName": "Patient",
                        "lastName": "Example",
                        "uom": 2,
                        "glucoseMeasurement": {
                            "Timestamp": "5/19/2026 12:34:00 AM",
                            "Value": 6.2,
                            "TrendArrow": 3,
                            "GlucoseUnits": 2,
                            "isHigh": False,
                            "isLow": False,
                        },
                    },
                    "graphData": [
                        {
                            "Timestamp": "5/19/2026 12:24:00 AM",
                            "Value": 5.8,
                            "GlucoseUnits": 2,
                        },
                        {
                            "Timestamp": "5/19/2026 12:29:00 AM",
                            "Value": 6.0,
                            "GlucoseUnits": 2,
                        },
                    ],
                }
            }
        raise AssertionError(f"unexpected request {method} {path}")

    @mock.patch.dict(
        "os.environ",
        {
            "LIBRE_LINK_UP_USERNAME": "patient@example.test",
            "LIBRE_LINK_UP_PASSWORD": "secret",
            "LIBRE_LINK_UP_URL": "https://api-eu2.libreview.io",
        },
        clear=False,
    )
    def test_observe_history_and_rings_are_visible_without_actions(self):
        with mock.patch.object(glucose, "_request", side_effect=self.fake_request):
            status = glucose.glucose_app_status()
            self.assertIn("configured=True", status)
            self.assertIn("connections=1", status)

            current = glucose.observe_glucose("Patient")
            self.assertIn('GlucoseObservation "Patient"', current)
            self.assertIn('"mmol/L"', current)
            self.assertIn('"flat"', current)
            self.assertIn("low=false", current)

            history = glucose.glucose_history("Patient", 2)
            self.assertEqual(history.count('GlucoseObservation "Patient"'), 2)

            set_result = glucose.set_glucose_watch("Patient", 4.0, 15.0, 20, "whatsapp", "ring only")
            self.assertIn("GLUCOSE-WATCH-SET", set_result)
            rings = glucose.glucose_rings("Patient")
            self.assertIn("none current=6.2 mmol/L", rings)

    @mock.patch.dict(
        "os.environ",
        {
            "LIBRE_LINK_UP_USERNAME": "patient@example.test",
            "LIBRE_LINK_UP_PASSWORD": "secret",
            "LIBRE_LINK_UP_URL": "https://api-eu2.libreview.io",
        },
        clear=False,
    )
    def test_pending_rings_wake_once_per_exact_reading(self):
        with mock.patch.object(glucose, "_request", side_effect=self.fake_request) as request:
            glucose.set_glucose_watch("Patient", 7.0, 15.0, 20, "loop", "wake the agent only")
            first = glucose.pending_glucose_rings()
            self.assertIn("GLUCOSE_RING person=Patient kind=low value=6.2", first)
            self.assertIn("wake the agent only", first)
            request_count = request.call_count

            second = glucose.pending_glucose_rings()
            self.assertEqual(second, "")
            self.assertEqual(request.call_count, request_count)

    @mock.patch.dict(
        "os.environ",
        {
            "LIBRE_LINK_UP_USERNAME": "patient@example.test",
            "LIBRE_LINK_UP_PASSWORD": "secret",
            "LIBRE_LINK_UP_URL": "https://api-eu2.libreview.io",
        },
        clear=False,
    )
    def test_stale_ring_uses_same_timestamp_seen_too_long(self):
        with mock.patch.object(glucose, "_request", side_effect=self.fake_request):
            glucose.set_glucose_watch("Patient", 4.0, 15.0, 20, "loop", "wake the agent only")
            self.assertEqual(glucose.pending_glucose_rings(), "")
            cache = glucose._read_json(glucose.CACHE_FILE, {})
            cache["seen_measurements"]["Patient"]["first_seen"] = 1
            glucose._write_json(glucose.CACHE_FILE, cache)

            stale = glucose.pending_glucose_rings()
            self.assertIn("GLUCOSE_RING person=Patient kind=stale value=6.2", stale)

    def test_rate_limit_notice_backs_off_without_repeated_network_polls(self):
        glucose.set_glucose_watch("Patient", 4.0, 15.0, 20, "loop", "wake the agent only")
        with mock.patch.object(
            glucose,
            "_current_observation",
            side_effect=RuntimeError("LibreLinkUp HTTP 429: {}"),
        ) as current:
            first = glucose.pending_glucose_rings()
            self.assertIn("GLUCOSE_APP_NOTICE person=Patient kind=rate_limited", first)
            self.assertIn("backoff_until=", first)
            self.assertEqual(current.call_count, 1)

            second = glucose.pending_glucose_rings()
            self.assertEqual(second, "")
            self.assertEqual(current.call_count, 1)

        status = glucose.glucose_watch_status("Patient")
        self.assertIn('"last_error_kind": "rate_limited"', status)
        self.assertIn('"backoff_until"', status)


if __name__ == "__main__":
    unittest.main()
