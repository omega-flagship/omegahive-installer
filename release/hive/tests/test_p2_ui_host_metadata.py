"""Focused P2-UI backend SOURCE tests; execution is a separate Root admission.

The tests import from the repository-root hive package, matching peer suites.
Fixtures are invented manifests and in-memory records, never installed apps or keys.
"""

import copy
import hashlib
import inspect
import json
import pathlib
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from hive.core.person_swarms import PersonSwarms
from hive.core.program_actions import ProgramActions
from hive.core.programs import Programs


class Refusal(RuntimeError):
    def __init__(self, status, code, message, _details=None, **details):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, {**(_details or {}), **details}


def template(name="Pinned helper"):
    return {"minds": [{"slot": "helper", "name": name, "model": "fixture/model", "budget_usd": 2}], "rules": []}


class PinnedManifestMetadataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = pathlib.Path(self.tmp.name) / "fixture-app"
        self.folder.mkdir()
        (self.folder / "module.py").write_text("FIXTURE = True\n")
        self.manifest = {"id": "fixture-app", "name": "Pinned app", "capabilities": ["person_swarm"],
                         "swarm_templates": {"personal": template()}}
        self.programs = Programs.__new__(Programs)
        self.programs.disabled = set()
        self.entry = {"id": "fixture-app", "name": "Loaded app", "version": "1", "description": "",
                      "icon": "spark", "capabilities": ["person_swarm"], "source": "fixture", "error": None,
                      "path": str(self.folder), "swarm_templates": {"forged": template("Forged helper")}}
        self.programs.programs = {"fixture-app": self.entry}
        self.programs._ready = lambda _program_id: self.entry
        self.repin()

    def repin(self):
        (self.folder / "plugin.json").write_text(json.dumps(self.manifest))
        digest = Programs.source_digest(self.folder)
        self.pin = {"release": str(self.folder), "digest": digest,
                    "files": {"plugin.json": hashlib.sha256((self.folder / "plugin.json").read_bytes()).hexdigest()}}
        self.programs.pins = {"fixture-app": self.pin}
        self.entry["digest"] = digest

    def test_detail_uses_pinned_manifest_not_mutable_loaded_context(self):
        self.entry["capabilities"] = []
        self.entry["swarm_templates"] = {"attacker": template("Not pinned")}
        out = self.programs.detail("fixture-app")["person_swarm"]
        self.assertEqual(out["template_ids"], ["personal"])
        self.assertEqual(out["release_digest"], self.pin["digest"])
        self.assertEqual(set(out["template_digests"]), {"personal"})
        verified = self.programs.verified_person_swarm_template("fixture-app", "personal")
        self.assertEqual(verified["program_name"], "Pinned app")
        self.assertEqual(verified["template"]["minds"][0]["name"], "Pinned helper")
        self.assertEqual(out["template_digests"]["personal"], verified["template"]["digest"])

    def test_returned_metadata_and_display_are_fresh_copies(self):
        first = self.programs._person_swarm_metadata("fixture-app")
        first["template_ids"].append("not-real")
        first["template_digests"]["personal"] = "not-a-digest"
        display = self.programs.verified_person_swarm_template("fixture-app", "personal")
        display["template"]["minds"][0]["name"] = "Caller mutation"
        again = self.programs._person_swarm_metadata("fixture-app")
        self.assertEqual(again["template_ids"], ["personal"])
        self.assertNotEqual(again["template_digests"]["personal"], "not-a-digest")
        self.assertEqual(self.programs.verified_person_swarm_template("fixture-app", "personal")["template"]["minds"][0]["name"],
                         "Pinned helper")

    def test_zero_and_multiple_templates_are_reported_without_selecting_one(self):
        self.manifest["swarm_templates"] = {}
        self.repin()
        self.assertEqual(self.programs._person_swarm_metadata("fixture-app")["template_ids"], [])
        self.manifest["swarm_templates"] = {"zeta": template(), "alpha": template()}
        self.repin()
        self.assertEqual(self.programs._person_swarm_metadata("fixture-app")["template_ids"], ["alpha", "zeta"])

    def test_unpinned_unready_or_wrong_manifest_cannot_supply_trigger_metadata(self):
        self.programs.pins = {}
        self.assertIsNone(self.programs._person_swarm_metadata("fixture-app"))
        self.repin()
        self.programs._ready = lambda _program_id: (_ for _ in ()).throw(Refusal(409, "program_disabled", "disabled"))
        self.assertIsNone(self.programs._person_swarm_metadata("fixture-app"))
        self.programs._ready = lambda _program_id: self.entry
        self.manifest["id"] = "another-app"
        self.repin()
        self.assertIsNone(self.programs._person_swarm_metadata("fixture-app"))

    def test_mutable_entry_cannot_invent_capability_or_template(self):
        self.manifest["capabilities"] = []
        self.manifest["swarm_templates"] = {}
        self.repin()
        self.entry["capabilities"] = ["person_swarm"]
        self.assertIsNone(self.programs._person_swarm_metadata("fixture-app"))

    def test_changed_or_malformed_pinned_manifest_fails_closed(self):
        (self.folder / "plugin.json").write_text(json.dumps({**self.manifest, "name": "Changed"}))
        self.assertIsNone(self.programs._person_swarm_metadata("fixture-app"))
        self.manifest["swarm_templates"] = {"personal": {"minds": [], "rules": []}}
        self.repin()
        self.assertIsNone(self.programs._person_swarm_metadata("fixture-app"))

    def test_public_digest_signature_and_input_set_are_unchanged(self):
        signature = inspect.signature(Programs.source_digest)
        self.assertEqual(list(signature.parameters), ["folder", "ui_lock_bytes"])
        self.assertEqual(signature.parameters["ui_lock_bytes"].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIsNone(signature.parameters["ui_lock_bytes"].default)
        raw, captured = Programs._captured_manifest_digest(self.folder)
        self.assertEqual(raw, (self.folder / "plugin.json").read_bytes())
        self.assertEqual(captured, Programs.source_digest(self.folder))
        (self.folder / "ui").mkdir()
        (self.folder / "ui" / "bundle.lock.json").write_text('{"fixture":true}')
        self.assertEqual(Programs._captured_manifest_digest(self.folder)[1], Programs.source_digest(self.folder))

    def test_captured_digest_hashes_the_manifest_bytes_it_parses(self):
        expected = self.pin["digest"]
        original_read = pathlib.Path.read_bytes
        swapped = False

        def read_bytes(path):
            nonlocal swapped
            if path == self.folder / "module.py" and not swapped:
                swapped = True
                (self.folder / "plugin.json").write_text(json.dumps({**self.manifest, "name": "Moved after capture"}))
            return original_read(path)

        with patch.object(pathlib.Path, "read_bytes", read_bytes):
            raw, captured = Programs._captured_manifest_digest(self.folder)
        self.assertEqual(json.loads(raw)["name"], "Pinned app")
        self.assertEqual(captured, expected)
        self.assertNotEqual(Programs.source_digest(self.folder), expected)


class CardReadDB:
    def __init__(self, consent):
        self.consent = consent

    def one(self, sql, _args=()):
        if self.consent is None:
            return None
        if sql.startswith("SELECT granted_at, withdrawn_at"):
            return {key: self.consent[key] for key in ("granted_at", "withdrawn_at")}
        return dict(self.consent)

    def execute(self, *_args, **_kwargs):
        raise AssertionError("a card read must not write")


class CardFreshnessAndDisplayTests(unittest.TestCase):
    def setUp(self):
        self.current = {"template_digest": "pinned-template-digest", "key_id": "key-fixture", "month_usd": 10,
                        "granted_at": "grant-1", "withdrawn_at": None}
        self.db = CardReadDB(self.current)
        self.programs = SimpleNamespace(pins={}, _authority=lambda _pid: {"at": "authority-1"})
        self.service = PersonSwarms.__new__(PersonSwarms)
        self.service.hive = SimpleNamespace(db=self.db, programs=self.programs, error=Refusal)
        self.t = {"digest": "pinned-template-digest", "minds": [{"slot": "helper", "name": "Helper", "persona": "",
                  "model": "fixture/model", "budget_usd": 2.0}], "rules": []}
        self.loaded = {"name": "Loaded name"}
        self.service.template = lambda _pid, _tid: (self.loaded, self.t)
        self.service._own_key = lambda _principal, _providers: "key-fixture"
        self.total = 10
        self.service._month_total = lambda _principal: self.total

    def card(self):
        return self.service.card("user:u_fixture", "fixture-app", "personal")

    def test_advisory_current_bit_keeps_all_five_bound_values_unchanged(self):
        card = self.card()
        self.assertTrue(card["consent_current"])
        self.assertEqual({k: card[k] for k in ("template_digest", "key_id", "month_usd", "consent_revision", "authority_revision")},
                         {"template_digest": "pinned-template-digest", "key_id": "key-fixture", "month_usd": 10,
                          "consent_revision": {"granted_at": "grant-1", "withdrawn_at": None}, "authority_revision": "authority-1"})

    def test_numeric_total_change_is_stale_for_setup_but_not_runtime_revocation(self):
        self.total = 20
        self.assertFalse(self.card()["consent_current"])
        self.assertEqual(self.service._runtime_consent("user:u_fixture", "fixture-app", "personal", self.t), self.current)
        self.assertIsNone(self.service._live_consent("user:u_fixture", "fixture-app", "personal", self.t))

    def test_missing_withdrawn_wrong_template_and_wrong_key_are_not_current(self):
        for change in (None, {"withdrawn_at": "withdraw-2"}, {"template_digest": "another"}, {"key_id": "another"}):
            with self.subTest(change=change):
                self.db.consent = None if change is None else {**self.current, **change}
                self.assertFalse(self.card()["consent_current"])
        self.db.consent = self.current
        self.total = None
        self.assertFalse(self.card()["consent_current"])

    def test_declared_pin_card_uses_verified_manifest_display_not_cached_minds(self):
        self.programs.pins = {"fixture-app": {"declared": True}}
        pinned = copy.deepcopy(self.t)
        pinned["minds"][0]["name"] = "Pinned helper"
        self.programs.verified_person_swarm_template = lambda _pid, _tid: {"program_name": "Pinned name", "template": pinned}
        self.t["minds"][0]["name"] = "Forged cached helper"
        self.loaded["name"] = "Forged cached name"
        card = self.card()
        self.assertEqual(card["program_name"], "Pinned name")
        self.assertEqual(card["minds"][0]["name"], "Pinned helper")
        self.assertEqual(card["template_digest"], "pinned-template-digest")

    def test_bad_declared_pin_fails_closed_while_legacy_unpinned_read_stays_compatible(self):
        self.assertEqual(self.card()["program_name"], "Loaded name")
        self.programs.pins = {"fixture-app": {"declared": True}}
        self.programs.verified_person_swarm_template = lambda _pid, _tid: None
        with self.assertRaises(Refusal) as error:
            self.card()
        self.assertEqual(error.exception.code, "app_integrity")


class ActionDB:
    def __init__(self):
        self.rows = {}

    def one(self, sql, args=()):
        if "WHERE id = ?" in sql:
            return self.rows.get(args[0])
        if "WHERE principal=?" in sql:
            return next((r for r in self.rows.values() if (r["principal"], r["program"], r["idempotency_key"]) == tuple(args)), None)
        return None

    def insert(self, table, row):
        assert table == "program_actions"
        self.rows[row["id"]] = dict(row)

    def update(self, table, row_id, values):
        assert table == "program_actions"
        self.rows[row_id].update(values)


class HostHeldActNoticeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = ActionDB()
        self.calls = []
        self.notices = []
        self.actor = {"principal": "user:u_fixture", "kind": "person", "id": "u_fixture", "name": "Fixture",
                      "role": "member", "local_operator": False}
        self.hive = SimpleNamespace(db=self.db, error=Refusal, swarm=lambda sid: {"id": sid},
                                    app_attachments=SimpleNamespace(required=lambda _entry: False),
                                    events=SimpleNamespace(publish=lambda *_args, **_kwargs: None))

        def ensure(principal, program_id, template_id):
            self.calls.append((principal, program_id, template_id))
            return {"status": "consent_required", "card": {"must_not_reach_app": True}}

        self.hive.person_swarms = SimpleNamespace(ensure=ensure, require_current=lambda _id: None)
        self.programs = Programs.__new__(Programs)
        self.programs.hive = self.hive
        self.hive.programs = self.programs
        self.entry = {"id": "fixture-app", "name": "Fixture", "capabilities": ["person_swarm"],
                      "describe": {"actions": [{"id": "setup", "person_activity": True}]}}
        self.programs._ready = lambda _pid: self.entry
        self.actions = ProgramActions.__new__(ProgramActions)
        self.actions.hive, self.actions.db = self.hive, self.db
        self.actions._person_file = lambda *_args: None
        self.actions._take_confirm = lambda *_args, **_kwargs: None
        self.actions._confirmable = lambda *_args: None
        self.hive.program_actions = self.actions

    async def act(self, fn, key="fixture-intent"):
        self.entry["module"] = SimpleNamespace(act=fn)
        data = {"action": "setup", "items": [], "params": {}, "idempotency_key": key}
        return await self.actions.person_act(self.actor, "fixture-app", "swarm-fixture", data,
                                             session_hash="session-fixture",
                                             _on_person_swarm_consent_required=lambda: self.notices.append(True))

    async def test_app_json_and_mutable_context_flags_cannot_mint_notice(self):
        result = {"status": "refused", "reason": "consent_required", "consent_required": True}

        async def app(ctx, _action, _items, _params):
            ctx.consent_required = True
            ctx._on_person_swarm_consent_required = lambda: self.notices.append("forged")
            return result

        self.assertEqual(await self.act(app), result)
        self.assertEqual(self.notices, [])
        self.assertEqual(self.calls, [])

    async def test_actual_live_ensure_mints_one_notice_without_changing_result_body(self):
        result = {"status": "refused", "message": "The app will need consent."}

        async def app(ctx, _action, _items, _params):
            self.assertEqual(ctx.ensure_person_swarm("personal"), {"status": "consent_required"})
            self.assertEqual(ctx.ensure_person_swarm("personal"), {"status": "consent_required"})
            return result

        self.assertEqual(await self.act(app), result)
        self.assertEqual(self.notices, [True])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(json.loads(next(iter(self.db.rows.values()))["result"]), result)

    async def test_mutable_context_actor_and_command_do_not_change_host_notice_identity(self):
        async def app(ctx, _action, _items, _params):
            ctx.actor = {"kind": "person", "principal": "user:u_other"}
            ctx.command = {"record_id": "forged", "idempotency_key": "forged", "params_digest": "forged"}
            ctx.ensure_person_swarm("personal")
            return {"status": "refused"}

        await self.act(app)
        self.assertEqual(self.calls, [("user:u_fixture", "fixture-app", "personal")])
        self.assertEqual(self.notices, [True])

    async def test_recovery_of_recorded_app_body_does_not_replay_the_notice(self):
        result = {"status": "refused", "reason": "consent_required"}

        async def app(ctx, _action, _items, _params):
            if ctx.actor.get("recovery"):
                return ctx.command["recorded_result"]
            ctx.ensure_person_swarm("personal")
            return result

        await self.act(app)
        self.notices.clear()
        self.assertEqual(await self.act(app), result)
        self.assertEqual(self.notices, [])
        self.assertEqual(len(self.calls), 1)

    async def test_no_notice_when_ensure_returns_ready(self):
        self.hive.person_swarms.ensure = lambda *_args: {"status": "ready", "swarm_id": "private", "minds": {"helper": "mind"}}

        async def app(ctx, _action, _items, _params):
            self.assertEqual(ctx.ensure_person_swarm("personal")["status"], "ready")
            return {"status": "done", "message": "A normal app result"}

        out = await self.act(app)
        self.assertEqual(out, {"status": "done", "message": "A normal app result"})
        self.assertEqual(self.notices, [])


if __name__ == "__main__":
    unittest.main()
