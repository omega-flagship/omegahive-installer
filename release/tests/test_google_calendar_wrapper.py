"""New Calendar facade regressions; synthetic replies and a fake HTTP-call seam only."""
import importlib.util
import json
import pathlib
import tomllib
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE = ROOT / "modules" / "hive"


def load_commons():
    spec = importlib.util.spec_from_file_location("google_calendar_wrapper_test", MODULE / "src" / "hive_commons.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def query(**updates):
    return {"time_min": "2026-10-26T00:00:00Z", "time_max": "2026-10-27T00:00:00Z", **updates}


def reply(**updates):
    return {"op": "calendar.read", "events": [
        {"title": "Synthetic planning", "start": "2026-10-26T10:00:00Z", "end": "2026-10-26T10:30:00Z", "busy": False},
    ], "truncated": False, **updates}


class GoogleCalendarWrapperTests(unittest.TestCase):
    def setUp(self):
        self.commons = load_commons()

    def call(self, body, result=None, error=None):
        result = reply() if result is None else result
        with patch.object(self.commons, "_call", return_value=(result, error)) as upstream:
            answer = self.commons.calendar_read(json.dumps(body))
        return answer, upstream

    def test_omitted_op_and_limit_become_one_fixed_read_for_this_mind(self):
        answer, upstream = self.call(query())
        upstream.assert_called_once_with("POST", "/api/agent/connectors/google/operations", {
            **query(), "op": "calendar.read", "limit": 20,
        })
        self.assertEqual(json.loads(answer.removeprefix("HIVE-CALENDAR ")), reply())
        self.assertIs(json.loads(answer.removeprefix("HIVE-CALENDAR "))["events"][0]["busy"], False)

    def test_explicit_calendar_read_preserves_timestamp_offsets_and_limit(self):
        body = query(op="calendar.read", time_min="2026-10-26T01:00:00+01:00", limit=1)
        answer, upstream = self.call(body)
        self.assertTrue(answer.startswith("HIVE-CALENDAR "))
        upstream.assert_called_once_with("POST", "/api/agent/connectors/google/operations", body)

    def test_metta_quoted_json_is_supported_without_changing_authority(self):
        text = '"' + json.dumps(query()).replace('"', '\\"') + '"'
        with patch.object(self.commons, "_call", return_value=(reply(), None)) as upstream:
            answer = self.commons.calendar_read(text)
        self.assertTrue(answer.startswith("HIVE-CALENDAR "))
        self.assertEqual(upstream.call_args.args[2], {**query(), "op": "calendar.read", "limit": 20})

    def test_wrong_operations_and_caller_authority_are_refused_before_http(self):
        for body in [query(op="calendar.write"), query(op="gmail.read"), query(op=None),
                     query(principal="user:other"), query(agent_id="a_other"), query(owner="user:other"),
                     query(calendar_id="other"), query(access_token="synthetic-secret")]:
            with self.subTest(body=body), patch.object(self.commons, "_call") as upstream:
                answer = self.commons.calendar_read(json.dumps(body))
                self.assertEqual(answer, self.commons._CALENDAR_BAD_QUERY)
                self.assertNotIn("synthetic-secret", answer)
                upstream.assert_not_called()

    def test_malformed_duplicate_nonfinite_and_nonobject_json_are_refused(self):
        for raw in ["{", "[]", "null", "42", '"calendar.read"',
                    '{"time_min":"2026-10-26T00:00:00Z","time_min":"2026-10-25T00:00:00Z"}',
                    '{"time_min":NaN}', '{"limit":Infinity}', '{"limit":-Infinity}',
                    '{"time_min":"' + "x" * 4096 + '"}']:
            with self.subTest(raw=raw[:80]), patch.object(self.commons, "_call") as upstream:
                self.assertEqual(self.commons.calendar_read(raw), self.commons._CALENDAR_BAD_QUERY)
                upstream.assert_not_called()

    def test_query_requires_real_timezone_aware_ordered_bounded_timestamps(self):
        for updates in [{"time_min": "2026-10-26T00:00:00"}, {"time_min": "2026-02-30T00:00:00Z"},
                        {"time_min": "2026-10-26T00:00:00+00:99"}, {"time_min": 123},
                        {"time_max": "2026-10-26T01:00:00+01:00"},
                        {"time_max": "2026-10-25T00:00:00Z"},
                        {"time_max": "2026-11-27T00:00:00Z"}]:
            with self.subTest(updates=updates), patch.object(self.commons, "_call") as upstream:
                self.assertEqual(self.commons.calendar_read(json.dumps(query(**updates))), self.commons._CALENDAR_BAD_QUERY)
                upstream.assert_not_called()

    def test_limit_is_an_integer_including_hard_boundaries_not_boolean_or_float(self):
        for limit in [False, True, 0, -1, 101, 1.0, "20", None]:
            with self.subTest(limit=limit), patch.object(self.commons, "_call") as upstream:
                self.assertEqual(self.commons.calendar_read(json.dumps(query(limit=limit))), self.commons._CALENDAR_BAD_QUERY)
                upstream.assert_not_called()
        for limit in [1, 100]:
            with self.subTest(limit=limit):
                answer, upstream = self.call(query(limit=limit, time_max="2026-11-26T00:00:00Z"))
                self.assertTrue(answer.startswith("HIVE-CALENDAR "))
                self.assertEqual(upstream.call_args.args[2]["limit"], limit)

    def test_transport_or_refusal_error_never_echoes_host_details(self):
        answer, upstream = self.call(query(), error="HIVE-ERROR google_failure: refresh_token=synthetic-secret")
        self.assertIn("google_calendar_unavailable", answer)
        self.assertNotIn("refresh_token", answer)
        self.assertNotIn("synthetic-secret", answer)
        upstream.assert_called_once()

    def test_only_closed_minimal_calendar_reply_reaches_the_mind(self):
        invalid = [reply(refresh_token="synthetic-secret"), reply(op="calendar.write"), reply(truncated=1),
                   reply(events={}), reply(events=[{**reply()["events"][0], "description": "synthetic-secret"}]),
                   reply(events=[{**reply()["events"][0], "attendees": ["synthetic-secret"]}]),
                   reply(events=[{**reply()["events"][0], "title": "x" * 201}]),
                   reply(events=[{**reply()["events"][0], "busy": 0}]),
                   reply(events=[{**reply()["events"][0], "start": ""}]),
                   reply(events=[{**reply()["events"][0], "end": "x" * 129}]),
                   reply(events=[reply()["events"][0]] * 21)]
        for value in invalid:
            with self.subTest(value=value):
                answer, _ = self.call(query(), result=value)
                self.assertEqual(answer, self.commons._CALENDAR_BAD_REPLY)
                self.assertNotIn("synthetic-secret", answer)

    def test_date_only_all_day_times_and_explicit_truncation_are_preserved(self):
        value = reply(events=[{"title": "Synthetic all day", "start": "2026-10-26", "end": "2026-10-27", "busy": True}], truncated=True)
        answer, _ = self.call(query(), result=value)
        self.assertEqual(json.loads(answer.removeprefix("HIVE-CALENDAR ")), value)

    def test_semicolon_and_literal_membrane_character_round_trip_without_metta_comments(self):
        value = reply(events=[{**reply()["events"][0], "title": "Planning; literal ⁏ retained"}])
        answer, upstream = self.call(query(), result=value)
        self.assertIn("calendar_read", self.commons.SKILLS)
        self.assertNotIn(";", answer)
        self.assertIn(self.commons.SEMI, answer)
        self.assertIn(self.commons.LIT, answer)
        decoded = self.commons.decode(answer)
        self.assertEqual(json.loads(decoded.removeprefix("HIVE-CALENDAR ")), value)
        upstream.assert_called_once_with("POST", "/api/agent/connectors/google/operations", {
            **query(), "op": "calendar.read", "limit": 20,
        })

    def test_large_valid_reply_is_refused_whole_instead_of_silently_cut(self):
        event = {**reply()["events"][0], "title": "x" * 200}
        answer, upstream = self.call(query(limit=100), result=reply(events=[event] * 100))
        self.assertIn("HIVE-ERROR too_large:", answer)
        self.assertNotIn("HIVE-CALENDAR", answer)
        upstream.assert_called_once()

    def test_calendar_read_is_not_local_allow_and_policy_unavailability_fails_closed(self):
        self.assertNotIn("calendar-read", self.commons.LOCAL_ALLOW)
        with patch.object(self.commons, "_call", return_value=(None, "synthetic policy offline")) as upstream:
            answer = self.commons.authorize('(calendar-read {"time_min":"2026-10-26T00:00:00Z"})')
        self.assertIn("HIVE-GATE-UNAVAILABLE", answer)
        self.assertNotEqual(answer, True)
        self.assertEqual(upstream.call_args.args[:2], ("POST", "/api/agent/authorize"))

    def test_skill_registration_is_consistent(self):
        manifest = tomllib.loads((MODULE / "module.toml").read_text())
        self.assertIn("skill:calendar-read", manifest["provides"])
        self.assertIn("(Provides omegaclaw.hive.commons (Skill calendar-read))", (MODULE / "entry.metta").read_text())
        self.assertIn("(SkillSignature calendar-read (Arg rest-text json))", (MODULE / "signatures.metta").read_text())
        self.assertIn("(calendar-read $json) (py-call (hive_commons.calendar_read $json))", (MODULE / "skills.metta").read_text())
        help_text = (MODULE / "catalog.metta").read_text()
        self.assertIn('(SkillHelp "calendar-read"', help_text)
        self.assertIn("Read-only: no event creation, edits or invitations", help_text)


if __name__ == "__main__":
    unittest.main()
