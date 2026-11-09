#!/usr/bin/env python3
"""Regression checks for Omega's current cognitive surface.

These tests are intentionally small and local. They protect the places where
recent live work has been fragile without turning OmegaClaw into a heavy test
framework or generic agent wrapper.
"""

import base64
from contextlib import contextmanager
import importlib
import os
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = ROOT.parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "channels"))

import helper  # noqa: E402


@contextmanager
def enabled_module_loader(*module_names):
    previous = os.environ.get("OMEGACLAW_MODULE_LOADER")
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "modules-loader.metta"
        path.write_text(
            "\n".join(
                f"!(import! &self (library OmegaClaw-Core ./modules/{name}/entry.metta))"
                for name in module_names
            )
            + "\n",
            encoding="utf-8",
        )
        os.environ["OMEGACLAW_MODULE_LOADER"] = str(path)
        helper.reload_signature_commands()
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop("OMEGACLAW_MODULE_LOADER", None)
            else:
                os.environ["OMEGACLAW_MODULE_LOADER"] = previous
            helper.reload_signature_commands()


def skill_implementation_source():
    files = [ROOT / "src" / "skills.metta"]
    files.extend(sorted((ROOT / "src").glob("skills_*.metta")))
    files.extend(sorted((ROOT / "modules").glob("*/skills.metta")))
    return "\n".join(path.read_text(encoding="utf-8") for path in files)


def signature_declaration_source():
    files = sorted((ROOT / "src").glob("skill_signatures*.metta"))
    files.extend(sorted((ROOT / "modules").glob("*/signatures.metta")))
    return "\n".join(path.read_text(encoding="utf-8") for path in files)


def skill_catalog_source():
    files = sorted((ROOT / "src").glob("skill_catalog*.metta"))
    files.extend(sorted((ROOT / "modules").glob("*/catalog.metta")))
    return "\n".join(path.read_text(encoding="utf-8") for path in files)


def metta_balance_errors(text):
    errors = []
    depth = 0
    in_quote = False
    escaped = False
    for index, char in enumerate(text):
        if in_quote:
            if char == '"' and not escaped:
                in_quote = False
            escaped = char == "\\" and not escaped
            if char != "\\":
                escaped = False
            continue
        if char == '"':
            in_quote = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                errors.append(f"extra close paren at offset {index}")
                break
    if in_quote:
        errors.append("unterminated string")
    if depth:
        errors.append(f"unbalanced paren depth {depth}")
    return errors


class HelperSurfaceTests(unittest.TestCase):
    def assert_metta_ok(self, atom):
        self.assertEqual(helper.test_metta_expression(atom), "METTA-SYNTAX-OK")

    def test_structured_memory_atom_builders_emit_parseable_metta(self):
        cases = [
            helper.persistent_fact_atom("Omega prefers rich-send 0.9"),
            helper.persistent_note_atom("omega-formatting use-base64-for-newlines 0.9"),
            helper.persistent_rule_atom("pin-focused | requires | attention-status-check | 0.9"),
            helper.world_fact_atom("Jon primary-human Omega 0.95"),
            helper.belief_claim_atom("omega attention-mode pin-is-not-body 0.95 0.9"),
            helper.agenda_goal_atom("cleanup-tests active high protect-fragile-surfaces"),
            helper.event_note_atom("tests regression surface-added 0.9"),
            helper.assimilation_event_atom(
                "audio | obs123 | profile-data | TestPerson shared preference | 0.95"
            ),
            helper.assimilation_world_atom(
                "audio | obs123 | TestPerson | preference | warm-light | 0.95"
            ),
            helper.assimilation_belief_atom(
                "audio | obs123 | test-profile | preference | warm-light | 0.95 | 0.9"
            ),
            helper.assimilation_persistent_atom(
                "audio | obs123 | family-health | exact health facts need immediate assimilation | 0.95"
            ),
            helper.space_transform_spec_atom(
                'persistent | (PersistentNote "omega" $note $conf) | events | (Event "omega" "memory-merged" "summary" "0.9") | merge duplicate omega notes'
            ),
        ]
        for atom in cases:
            with self.subTest(atom=atom):
                self.assertNotIn("Error", atom)
                self.assert_metta_ok(atom)

    def test_cleanup_ids_are_stable_and_symbolic(self):
        expr = '(PersistentNote "omega" "duplicate lesson" "0.8")'
        candidate = helper.cleanup_candidate_id(expr)
        proposal = helper.cleanup_proposal_id(candidate, "merge-duplicate", "exact duplicate")
        self.assertRegex(candidate, r"^pc-[0-9a-f]{16}$")
        self.assertRegex(proposal, r"^pp-[0-9a-f]{16}$")
        self.assertEqual(candidate, helper.cleanup_candidate_id(expr))
        self.assertIn("PersistentNote", helper.cleanup_preview(expr))

    def test_event_note_rejects_prose_without_numeric_confidence(self):
        atom = helper.event_note_atom(
            "Living Ecology exploration completed 2026-05-22 mapped room affordances"
        )
        self.assertIn("EventNoteError", atom)
        self.assertIn("confidence must be numeric", atom)
        self.assert_metta_ok(atom)

    def test_structured_memory_numeric_contracts_reject_words(self):
        cases = [
            helper.persistent_fact_atom("Omega learned wait-skill high"),
            helper.persistent_note_atom("syntax use-test-metta high"),
            helper.persistent_rule_atom("pin-focused | requires | attention-status-check | high"),
            helper.world_fact_atom("Jon primary-human Omega likely"),
            helper.belief_claim_atom("omega attention-mode pin-is-working-memory often 0.9"),
            helper.belief_claim_atom("omega attention-mode pin-is-working-memory 0.95 sure"),
            helper.assimilation_event_atom(
                "audio | obs123 | profile-data | TestPerson shared preference | sure"
            ),
            helper.assimilation_world_atom(
                "audio | obs123 | TestPerson | preference | warm-light | likely"
            ),
            helper.assimilation_persistent_atom(
                "audio | obs123 | family-health | exact health facts need immediate assimilation | sure"
            ),
        ]
        for atom in cases:
            with self.subTest(atom=atom):
                self.assertIn("Error", atom)
                self.assertIn("numeric", atom)
                self.assert_metta_ok(atom)

    def test_structured_atom_membrane_escapes_control_characters(self):
        atom = helper.assimilation_event_atom(
            'audio | obs"123 | profile-data | line one:\nline two\tquoted "ok" | 0.95'
        )
        self.assertIn('\\"123', atom)
        self.assertIn("\\n", atom)
        self.assertIn("\\t", atom)
        self.assertIn('\\"ok\\"', atom)
        self.assertNotIn("\nline two", atom)
        self.assert_metta_ok(atom)

        quoted = helper._signature_quote('line one:\nline two\tquoted "ok"')
        self.assertIn("\\n", quoted)
        self.assertIn("\\t", quoted)
        self.assertIn('\\"ok\\"', quoted)
        self.assertNotIn("\nline two", quoted)
        self.assert_metta_ok(f"(TestQuote {quoted})")

    def test_attention_membrane_uses_same_control_character_escaping(self):
        import attention_ledger

        quoted = attention_ledger._metta_string('line one:\nline two\t"ok"')
        self.assertIn("\\n", quoted)
        self.assertIn("\\t", quoted)
        self.assertIn('\\"ok\\"', quoted)
        self.assertNotIn("\nline two", quoted)
        self.assert_metta_ok(f"(AttentionQuote {quoted})")

    def test_invalid_structured_inputs_return_visible_error_atoms(self):
        self.assertIn("PersistentFactError", helper.persistent_fact_atom("too-short"))
        self.assertIn("BeliefClaimError", helper.belief_claim_atom("too short"))
        self.assertIn(
            "AgendaGoalError",
            helper.agenda_goal_atom("task invalid-status high do-work"),
        )
        self.assertIn(
            "AgendaGoalError",
            helper.agenda_goal_atom("task active bananas do-work"),
        )
        self.assertIn(
            "SpaceTransformSpecError",
            helper.space_transform_spec_atom(
                'persistent | (PersistentNote "omega" $note | events | (Event "omega" "summary" "merged" "0.9") | malformed'
            ),
        )

    def test_episode_time_normalization_accepts_forgiving_formats(self):
        self.assertEqual(
            helper.normalize_episode_time("2026-05-18 15:53"),
            "2026-05-18 15:53:00",
        )
        self.assertEqual(
            helper.normalize_episode_time("2026-05-18"),
            "2026-05-18 00:00:00",
        )
        self.assertIsNone(helper.normalize_episode_time("not-a-time"))

    def test_episode_timestamp_extraction_survives_helper_split(self):
        ts = helper.extract_timestamp('("2026-05-22 12:34:56" ((wait "ok")))')
        self.assertEqual(ts.strftime("%Y-%m-%d %H:%M:%S"), "2026-05-22 12:34:56")

    def test_command_normalizer_preserves_rich_send_arguments(self):
        with enabled_module_loader("channel_router", "channel_whatsapp"):
            payload = base64.b64encode(b"Line one: ok\nLine two: still ok").decode("ascii")
            output = helper.balance_parentheses(f"send-whatsapp-base64 {payload}")
            self.assertEqual(output, f'((send-whatsapp-base64 "{payload}"))')

    def test_command_normalizer_recovers_valid_command_from_preamble(self):
        with enabled_module_loader("channel_router", "channel_telegram"):
            output = helper.balance_parentheses('Thinking first\nsend-telegram "hello: there"')
            self.assertIn('(send-telegram "hello: there")', output)
            self.assertTrue(output.startswith("("))

    def test_command_normalizer_accepts_cycle_body_affordances(self):
        self.assertEqual(helper.balance_parentheses("cycle-status"), "((cycle-status))")
        self.assertEqual(
            helper.balance_parentheses("start-cycle-practice phase-two"),
            '((start-cycle-practice "phase-two"))',
        )

    def test_command_normalizer_accepts_nars_and_assimilation_organs(self):
        kb = '((Sentence ((--> TestPerson smokes) (stv 1.0 0.9)) (1)))'
        self.assertEqual(
            helper.balance_parentheses(f'nars-query "{kb}" "(--> TestPerson smokes)"'),
            f'((nars-query "{kb}" "(--> TestPerson smokes)"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                "assimilate-world audio | obs123 | TestPerson | preference | warm-light | 0.95"
            ),
            '((assimilate-world "audio | obs123 | TestPerson | preference | warm-light | 0.95"))',
        )
        self.assertEqual(
            helper.balance_parentheses("send-control OS channel seen: routed reply"),
            '((send-control "OS channel seen: routed reply"))',
        )
        self.assertEqual(
            helper.balance_parentheses("send-web-control OS channel seen: explicit web reply"),
            '((send-web-control "OS channel seen: explicit web reply"))',
        )
        self.assertEqual(
            helper.balance_parentheses("send-web-control-base64 T1MgY2hhbm5lbCBzZWVu"),
            '((send-web-control-base64 "T1MgY2hhbm5lbCBzZWVu"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                'nal-step "((--> TestPerson teacher) (stv 0.9 0.7))" "((--> teacher helper) (stv 0.8 0.8))"'
            ),
            '((nal-step "((--> TestPerson teacher) (stv 0.9 0.7))" "((--> teacher helper) (stv 0.8 0.8))"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                'pln-step "((Implication (Inheritance Pingu (IntSet Feathered)) (Inheritance Pingu Bird)) (stv 1.0 0.9))" "((Inheritance Pingu (IntSet Feathered)) (stv 1.0 0.9))"'
            ),
            '((pln-step "((Implication (Inheritance Pingu (IntSet Feathered)) (Inheritance Pingu Bird)) (stv 1.0 0.9))" "((Inheritance Pingu (IntSet Feathered)) (stv 1.0 0.9))"))',
        )
        self.assertEqual(
            helper.balance_parentheses('truth-expectation 0.7 0.8'),
            "((truth-expectation 0.7 0.8))",
        )
        self.assertEqual(helper.balance_parentheses("body-status"), "((body-status))")
        self.assertEqual(
            helper.balance_parentheses("video-config-status"),
            "((video-config-status))",
        )
        self.assertEqual(
            helper.balance_parentheses("agenda-by-name cleanup-tests"),
            '((agenda-by-name "cleanup-tests"))',
        )
        self.assertEqual(
            helper.balance_parentheses("agenda-retire cleanup-tests duplicate old goal"),
            '((agenda-retire "cleanup-tests" "duplicate old goal"))',
        )
        self.assertEqual(
            helper.balance_parentheses('space-count world "(Relation $a $b $c $d $e)"'),
            '((space-count "world" "(Relation $a $b $c $d $e)"))',
        )
        self.assertEqual(
            helper.balance_parentheses('space-examples persistent "(PersistentNote $topic $note $conf)" 5'),
            '((space-examples "persistent" "(PersistentNote $topic $note $conf)" 5))',
        )
        self.assertEqual(
            helper.balance_parentheses('space-examples persistent "(PersistentNote" $topic $note $conf) 5'),
            '((space-examples "persistent" "(PersistentNote $topic $note $conf)" 5))',
        )
        self.assertEqual(
            helper.balance_parentheses('space-examples persistent "(PersistentNote" omega $topic $note $conf) 5'),
            '((space-examples "persistent" "(PersistentNote omega $topic $note $conf)" 5))',
        )
        self.assertEqual(
            helper.balance_parentheses('space-examples persistent "(PersistentFact" $subj $rel $obj $conf) 5'),
            '((space-examples "persistent" "(PersistentFact $subj $rel $obj $conf)" 5))',
        )
        self.assertEqual(
            helper.balance_parentheses('space-examples persistent "\'(PersistentNote $topic $note $conf)\'" 5'),
            '((space-examples "persistent" "(PersistentNote $topic $note $conf)" 5))',
        )
        self.assertEqual(helper.balance_parentheses("space-pressure"), "((space-pressure))")
        self.assertEqual(helper.balance_parentheses("persistent-review"), "((persistent-review))")
        self.assertEqual(
            helper.balance_parentheses(
                'space-transform persistent | (PersistentNote "omega" $note $conf) | events | (Event "omega" "memory-merged" "summary" "0.9") | merge duplicate omega notes'
            ),
            '((space-transform "persistent" "(PersistentNote \\"omega\\" $note $conf)" "events" "(Event \\"omega\\" \\"memory-merged\\" \\"summary\\" \\"0.9\\")" "merge duplicate omega notes"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                "space-transform persistent | (PersistentObservation test $trace $kind $note $conf) | events | (Event \"omega\" \"test-debris-cleaned\" \"assimilate-persistent-test-moved\" \"0.9\") | remove-test-debris-from-persistent"
            ),
            '((space-transform "persistent" "(PersistentObservation test $trace $kind $note $conf)" "events" "(Event \\"omega\\" \\"test-debris-cleaned\\" \\"assimilate-persistent-test-moved\\" \\"0.9\\")" "remove-test-debris-from-persistent"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                'space-transform "persistent" "(PersistentNote omega phase1-search-practice $note $conf)" "events" "(EventNote omega practice-debris-consolidated search-practice-lessons-moved-to-remember 0.9)" "practice-debris-cleanup"'
            ),
            '((space-transform "persistent" "(PersistentNote omega phase1-search-practice $note $conf)" "events" "(EventNote omega practice-debris-consolidated search-practice-lessons-moved-to-remember 0.9)" "practice-debris-cleanup"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                r'space-transform \"persistent\" \"(PersistentObservation test $trace $kind $note $conf)\" \"events\" \"(EventNote omega test-debris-cleaned assimilate-test-moved 0.9)\" \"remove-test-debris\"'
            ),
            '((space-transform "persistent" "(PersistentObservation test $trace $kind $note $conf)" "events" "(EventNote omega test-debris-cleaned assimilate-test-moved 0.9)" "remove-test-debris"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                'space-transform "persistent (PersistentNote omega phase1-search-practice $note $conf) events (EventNote omega practice-debris-archived search-practice-lessons-moved 0.9) practice-debris-cleanup"'
            ),
            '((space-transform "persistent" "(PersistentNote omega phase1-search-practice $note $conf)" "events" "(EventNote omega practice-debris-archived search-practice-lessons-moved 0.9)" "practice-debris-cleanup"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                r'space-transform \"persistent (PersistentObservation test $trace $kind $note $conf) events (EventNote omega test-debris-cleaned assimilate-test-moved 0.9) remove-test-debris\"'
            ),
            '((space-transform "persistent" "(PersistentObservation test $trace $kind $note $conf)" "events" "(EventNote omega test-debris-cleaned assimilate-test-moved 0.9)" "remove-test-debris"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                'space-transform persistent (PersistentObservation test $trace $kind $note $conf) events (EventNote omega test-debris-cleaned assimilate-test-moved 0.9) remove-test-debris-from-persistent'
            ),
            '((space-transform "persistent" "(PersistentObservation test $trace $kind $note $conf)" "events" "(EventNote omega test-debris-cleaned assimilate-test-moved 0.9)" "remove-test-debris-from-persistent"))',
        )
        self.assertEqual(
            helper.balance_parentheses(
                'retire-persistent-expression "(PersistentNote \\"omega\\" \\"test: colon ok\\" \\"0.8\\")" stale duplicate'
            ),
            '((retire-persistent-expression "(PersistentNote \\"omega\\" \\"test: colon ok\\" \\"0.8\\")" "stale duplicate"))',
        )
        malformed_retire = helper.balance_parentheses(
            'retire-persistent-expression "(PersistentFact" "omega practicing clean-skills true 1.0) stale-practice-session"'
        )
        self.assertIn('(syntax-error "retire-persistent-expression"', malformed_retire)
        malformed_nal = helper.balance_parentheses(
            'nal-step "((-->" "omega learning) (stv 1.0 0.9)) ((==> (--> omega learning) (--> omega growing)) (stv 0.8 0.9))"'
        )
        self.assertIn('(syntax-error "nal-step"', malformed_nal)

    def test_command_normalizer_known_live_syntax_problem_examples(self):
        with enabled_module_loader("assume", "channel_router", "channel_whatsapp"):
            cases = {
                "send-whatsapp Great - send-file works! And here is how I will use &persistent and promote/demote:":
                    '((send-whatsapp "Great - send-file works! And here is how I will use &persistent and promote/demote:"))',
                "pin Cycle 44: I will avoid newline in pin\nand keep this as one line":
                    '((pin "Cycle 44: I will avoid newline in pin and keep this as one line"))',
                'write-file notes/test.txt "Heading: ok\n- item: ok"':
                    '((write-file-base64 "notes/test.txt" "SGVhZGluZzogb2sKLSBpdGVtOiBvaw=="))',
                "episodes-at 2026-05-18 08:00":
                    '((episodes-at "2026-05-18 08:00"))',
                "send-whatsapp-to 12345@lid Dinner is ready: please tell Resident\nSecond line":
                    '((send-whatsapp-to-base64 "12345@lid" "RGlubmVyIGlzIHJlYWR5OiBwbGVhc2UgdGVsbCBSZXNpZGVudApTZWNvbmQgbGluZQ=="))',
                "reply-whatsapp-to 12345@lid Dinner is ready: please tell Resident\nSecond line":
                    '((reply-whatsapp-to-base64 "12345@lid" "RGlubmVyIGlzIHJlYWR5OiBwbGVhc2UgdGVsbCBSZXNpZGVudApTZWNvbmQgbGluZQ=="))',
                "send-whatsapp-mention-to 111@g.us 440000000000 Dinner ready: @Resident":
                    '((send-whatsapp-mention-to "111@g.us" "440000000000" "Dinner ready: @Resident"))',
                "assimilate-persistent whatsapp | msg:abc:123 | family-update | Resident said: dinner is ready; tell another-resident | 0.95":
                    '((assimilate-persistent "whatsapp | msg:abc:123 | family-update | Resident said: dinner is ready; tell another-resident | 0.95"))',
                "assume-demo-load SmartHabitatDemoSpace smart-habitat movie-evening":
                    '((assume-demo-load "SmartHabitatDemoSpace" "smart-habitat" "movie-evening"))',
                "assume-demo-predict SmartHabitatDemoSpace smart-habitat movie-evening":
                    '((assume-demo-predict "SmartHabitatDemoSpace" "smart-habitat" "movie-evening"))',
                "assume-demo-audit SmartHabitatDemoSpace smart-habitat movie-evening dim-cinema-scene":
                    '((assume-demo-audit "SmartHabitatDemoSpace" "smart-habitat" "movie-evening" "dim-cinema-scene"))',
                'assume-demo-learn SmartHabitatDemoSpace smart-habitat movie-evening {"dim-cinema-scene": 0.2}':
                    '((assume-demo-learn "SmartHabitatDemoSpace" "smart-habitat" "movie-evening" "{\\"dim-cinema-scene\\": 0.2}"))',
                "assume-import-demo SmartHabitatDemoSpace":
                    '((assume-import-demo "SmartHabitatDemoSpace"))',
            }
            for raw, expected in cases.items():
                with self.subTest(raw=raw):
                    normalized = helper.balance_parentheses(raw)
                    self.assertEqual(normalized, expected)
                    self.assert_metta_ok(normalized)


class ArchitectureSurfaceTests(unittest.TestCase):
    def test_focused_mode_is_an_explicit_body_affordance(self):
        skills = skill_implementation_source()
        self.assertIn("attention-status", skills)
        self.assertIn("set-energy-mode", skills)
        self.assertIn('"focused"', skills)
        self.assertIn("(set-loop-energy 30 20 3 300 $reason)", skills)
        self.assertIn("(set-loop-energy 12 8 3 300 $reason)", skills)
        energy_affordance = (ROOT / "src" / "skill_affordance_energy.metta").read_text(encoding="utf-8")
        prompt = (ROOT / "memory" / "prompt.txt").read_text(encoding="utf-8")
        self.assertIn("warm is the default quiet cognition mode", energy_affordance)
        self.assertIn("asleep means dormant rest-only", energy_affordance)
        self.assertIn("During active human-requested work", prompt)

    def test_cycle_counting_is_a_body_affordance_not_shell_memory(self):
        loop = (ROOT / "src" / "loop.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        self.assertIn("(change-state! &cycle $k)", loop)
        self.assertIn("cycle-status", skills)
        self.assertIn("start-cycle-practice", skills)
        self.assertIn("practiceStartCycle", skills)

    def test_atomspace_limits_are_runtime_body_state_for_pressure_sense(self):
        loop = (ROOT / "src" / "loop.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        self.assertIn("(change-state! &maxPersistentAtomsChars (maxPersistentAtomsChars))", loop)
        self.assertIn("(change-state! &maxAgendaAtomsChars (maxAgendaAtomsChars))", loop)
        self.assertIn('(register-space-limit "persistent" &maxPersistentAtomsChars)', skills)
        self.assertIn('(register-space-limit "agenda" &maxAgendaAtomsChars)', skills)
        self.assertIn("(catch (get-state (car-atom $limits)))", skills)

    def test_structured_space_writes_parse_before_add_atom(self):
        skills = skill_implementation_source()
        self.assertNotIn("(add-atom &persistent (sread $atom))", skills)
        self.assertNotIn("(add-atom &world (sread $atom))", skills)
        self.assertNotIn("(add-atom &beliefs (sread $atom))", skills)
        self.assertNotIn("(add-atom &agenda (sread $atom))", skills)
        self.assertNotIn("(add-atom &events (sread $atom))", skills)
        self.assertIn("($parsed (sread $atom))", skills)
        self.assertIn("(add-atom &agenda $parsed)", skills)
        self.assertNotIn(
            "(progn (add-atom &persistent $parsed)\n        (progn",
            skills,
        )

    def test_persistent_retirement_is_metta_native_exact_atom_roundtrip(self):
        skills = skill_implementation_source()
        self.assertIn("(= (retire-persistent-expression $expr $reason)", skills)
        self.assertIn("(= (attention-retire-candidate $hash $reason)", skills)
        self.assertIn("(AmbiguousHash $hash $found)", skills)
        self.assertIn("(NotRetireCandidate $hash $action $reason)", skills)
        self.assertIn("(= (space-transform $spec)", skills)
        self.assertIn("(= (space-transform $source $patternstr $target $replacementstr $reason)", skills)
        self.assertIn('(add-atom &events (Event "omega" "space-transform" $reason "0.9"))', skills)
        self.assertIn("($atom (sread $expr))", skills)
        self.assertIn("($present (car-atom (collapse (find &persistent $atom))))", skills)
        self.assertIn("(remove-atom &persistent $atom)", skills)
        self.assertIn('(add-atom &events (Event "omega" "persistent-retire" $reason "0.9"))', skills)
        self.assertIn("(= (persistent-review)", skills)
        self.assertIn("(= (persistent-cleanup-candidates $limit)", skills)
        self.assertIn("(= (persistent-cleanup-propose $candidate_id $action $reason)", skills)
        self.assertIn("(= (persistent-cleanup-commit $proposal_id)", skills)
        self.assertIn("(PersistentCleanupCandidate", skills)
        self.assertIn("(PersistentCleanupProposal", skills)
        self.assertIn("(repr (collapse (match &persistent $atom $atom)))", skills)
        self.assertNotIn("You can use: metta (add-atom &persistent sexpression)", skills)

    def test_advertised_python_organs_import_in_runtime_python(self):
        modules = [
            "helper",
            "energy",
            "home",
            "publishing",
            "vision",
            "webcam",
            "audio",
            "glucose",
            "imagegen",
            "videogen",
            "router",
            "telegram",
            "whatsapp",
            "web_control",
        ]
        for module in modules:
            with self.subTest(module=module):
                importlib.import_module(module)

    def test_reasoning_dependency_examples_run_through_helper(self):
        examples = [
            OMEGACLAW_ROOT / "examples" / "nars_direct.metta",
            OMEGACLAW_ROOT / "examples" / "pln_direct.metta",
        ]
        missing = [str(path) for path in examples if not path.exists()]
        if missing:
            self.skipTest(f"OmegaClaw reasoning examples not present: {missing}")
        for path in examples:
            with self.subTest(path=path.name):
                output = helper.run_metta_file(str(path), timeout_seconds=20)
                self.assertNotIn("❌", output)
                self.assertGreaterEqual(output.count("✅"), 3)

    def test_reasoning_organs_are_advertised(self):
        lib = (ROOT / "lib_omegaclaw_core.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        self.assertIn("library lib_nars", lib)
        self.assertIn("library lib_spaces", lib)
        self.assertTrue((ROOT / "src" / "context.metta").exists())
        self.assertIn("context-organ-status", (ROOT / "src" / "context.metta").read_text(encoding="utf-8"))
        self.assertIn("nal-step", skills)
        self.assertIn("pln-step", skills)
        self.assertIn("nars-query", skills)
        self.assertIn("nars-derive", skills)
        self.assertIn("truth-expectation", skills)
        self.assertIn("space-count", skills)
        self.assertIn("space-find", skills)
        self.assertIn("space-examples", skills)
        self.assertIn("space-examples-default", skills)
        self.assertIn("space-atoms", skills)
        self.assertIn("agenda-by-name", skills)
        self.assertIn("agenda-retire", skills)
        self.assertIn("agenda-complete", skills)
        self.assertIn("beliefs-for", skills)
        self.assertIn("belief-derived", skills)
        self.assertIn("events-recent", skills)
        self.assertIn("helper.agenda_goal_name_atom", skills)

    def test_activity_trace_space_is_native_and_bounded(self):
        lib = (ROOT / "lib_omegaclaw_core.metta").read_text(encoding="utf-8")
        loop = (ROOT / "src" / "loop.metta").read_text(encoding="utf-8")
        memory = (ROOT / "src" / "memory.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        signatures = signature_declaration_source()
        helper_source = (ROOT / "src" / "helper_metta.py").read_text(encoding="utf-8")
        self.assertIn("!(bind! &activity (new-space))", lib)
        self.assertIn("!(bind! &cleanup (new-space))", lib)
        self.assertIn(
            '(register-space-persistence "activity" (memory-file "activity.metta") runtime-state)',
            skills,
        )
        self.assertIn(
            '(register-space-persistence "cleanup" (memory-file "cleanup.metta") runtime-state)',
            skills,
        )
        self.assertIn("(load-runtime-spaces-by-role memory)", memory)
        self.assertIn("(configure maxActivityAtomsChars 60000)", loop)
        self.assertIn("(bound-runtime-spaces-by-role memory)", loop)
        self.assertIn("(= (bound-runtime-spaces-by-role $role)", skills)
        self.assertIn('(register-space-limit "activity" &maxActivityAtomsChars)', skills)
        self.assertIn("(save-runtime-spaces-by-role memory)", loop)
        self.assertIn("(= (trace-atom $action $space $atom $reason)", skills)
        self.assertIn("(add-atom &activity (AtomTouch", skills)
        self.assertIn("(= (trace-merge $source $target $result $reason)", skills)
        self.assertIn("(= (activity-traces)", skills)
        self.assertIn("(= (activity-traces)\n   (repr (get-atoms &activity)))", skills)
        self.assertIn("(trace-atom \"write\" \"persistent\" $parsed \"persistent-fact\")", skills)
        self.assertIn('(trace-atom "write" "assume" $atom "assume-situation")', skills)
        self.assertIn('(trace-atom "write" "assume" $atom "assume-outcome")', skills)
        self.assertIn("(trace-atom \"remove\" \"persistent\" $atom $reason)", skills)
        self.assertIn("activity-traces", signatures)
        self.assertIn('"activity"', helper_source)

    def test_modular_skill_files_do_not_leave_body_affordances_as_stubs(self):
        skills = skill_implementation_source()
        memory = (ROOT / "src" / "memory.metta").read_text(encoding="utf-8")
        self.assertIn("(= (current-swipl-pid)\n   (py-call (helper.current_swipl_pid)))", skills)
        self.assertIn("(= (activity-traces)\n   (repr (get-atoms &activity)))", skills)
        self.assertIn("(= (energy-status)\n   (py-call (energy.energy_status)))", skills)
        self.assertIn("(= (set-energy-targets $daily $weekly $monthly $currency)\n   (py-call (energy.set_energy_targets $daily $weekly $monthly $currency)))", skills)
        self.assertIn("(= (house-action-log $count)\n   (py-call (home_assistant.house_action_log $count)))", skills)
        self.assertIn("(= (events-all)\n   (repr (collapse (match &events", skills)
        self.assertIn("(= (persistent-review)\n   (py-str (\"PERSISTENT-REVIEW", skills)
        self.assertIn("(= (cleanup-proposals)", skills)
        self.assertIn("(= (getPrompt)\n   (py-call (helper.context_prompt)))", memory)
        self.assertIn("(= (getHistory)\n   (py-call (helper.context_recent_history_entries (maxHistory) 12)))", memory)

    def test_imported_metta_source_files_are_balanced(self):
        files = [
            ROOT / "lib_omegaclaw.metta",
            ROOT / "lib_omegaclaw_core.metta",
            ROOT / "lib_omegaclaw_body.metta",
            ROOT / "run.metta",
        ]
        files.extend(sorted((ROOT / "src").glob("*.metta")))
        files.extend(sorted((ROOT / "modules").glob("*/*.metta")))
        files.extend(sorted((ROOT / "modules").glob("*/*.metta")))
        failures = {}
        for path in files:
            errors = metta_balance_errors(path.read_text(encoding="utf-8", errors="replace"))
            if errors:
                failures[str(path.relative_to(ROOT))] = errors
        self.assertEqual({}, failures)

    def test_glucose_app_is_external_readable_affordance(self):
        lib = (ROOT / "lib_omegaclaw_core.metta").read_text(encoding="utf-8")
        body = (ROOT / "lib_omegaclaw_body.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        skill_catalog = skill_catalog_source()
        self.assertNotIn("./src/glucose.py", lib)
        self.assertIn("./modules/loader.metta", body)
        self.assertNotIn("./modules/health_glucose/entry.metta", (ROOT / "modules" / "loader.metta").read_text(encoding="utf-8"))
        self.assertIn("glucose-app-status", skills)
        self.assertIn("observe target", skill_catalog)
        self.assertIn("observe-glucose person", skill_catalog)
        self.assertIn("glucose-history person count", skill_catalog)
        self.assertIn("glucose-rings person", skill_catalog)
        self.assertNotIn("insulin", skills.lower())
        with enabled_module_loader("health_glucose", "sense_router"):
            self.assertEqual(helper.balance_parentheses("observe-glucose Patient"), '((observe-glucose "Patient"))')
            self.assertEqual(helper.balance_parentheses("observe gameboy"), '((observe "gameboy"))')
            self.assertEqual(helper.balance_parentheses("glucose-history Patient 12"), '((glucose-history "Patient" 12))')
            self.assertEqual(
                helper.balance_parentheses("set-glucose-watch Patient 4 15 20 whatsapp visible ring only"),
                '((set-glucose-watch "Patient" 4 15 20 "whatsapp" "visible ring only"))',
            )
        self.assertIn("body-status", skills)
        self.assertIn("restart-self", skills)
        self.assertIn("reboot-self", skills)
        self.assertIn("video-config-status", skills)
        self.assertIn("assimilate-event", skills)
        self.assertIn("assimilate-world", skills)
        self.assertIn("assimilate-belief", skills)
        self.assertIn("assimilate-persistent", skills)

    def test_web_control_is_a_channel_not_a_decision_layer(self):
        lib = (ROOT / "lib_omegaclaw_core.metta").read_text(encoding="utf-8")
        body = (ROOT / "lib_omegaclaw_body.metta").read_text(encoding="utf-8")
        channel = (ROOT / "modules" / "channel_web_control" / "src" / "web_control.py").read_text(encoding="utf-8")
        router = (ROOT / "modules" / "channel_router" / "src" / "router.py").read_text(encoding="utf-8")
        self.assertNotIn("./channels/web_control.py", lib)
        self.assertIn("./modules/loader.metta", body)
        self.assertIn("./modules/channel_web_control/entry.metta", (ROOT / "modules" / "loader.metta").read_text(encoding="utf-8"))
        self.assertIn("enqueue_user_message", channel)
        self.assertIn("get_last_message", channel)
        self.assertIn("send_message", channel)
        self.assertIn("WEB-CONTROL-SEND-SUCCESS", channel)
        self.assertIn("CHANNEL_EVENT", router)
        self.assertIn('normalize_channel_event(_control_event("web_control", msg))', router)
        channels = (ROOT / "modules" / "channel_router" / "skills.metta").read_text(encoding="utf-8") + (ROOT / "modules" / "channel_web_control" / "skills.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        skill_catalog = skill_catalog_source()
        init_channels = channels[channels.index("(= (initChannels)"):channels.index(";Receive the latest user message")]
        self.assertIn("(configure commchannel mock)", init_channels)
        self.assertIn("CHANNEL-INIT", init_channels)
        self.assertIn("(configure OMEGACLAW_AUTH_SECRET \"\")", init_channels)
        self.assertIn("(telegram.start_telegram (TG_BOT_TOKEN) (TG_CHAT_ID) (TG_POLL_TIMEOUT) (OMEGACLAW_AUTH_SECRET))", init_channels)
        self.assertIn("CHANNEL-READY telegram", init_channels)
        self.assertIn("(= (send-control $msg)", channels)
        self.assertIn("(= (send-web-control $msg)", channels)
        self.assertIn("router.send_control_base64", channels)
        self.assertIn("router.send_web_control", channels)
        self.assertIn("Web chat is a channel", skill_catalog)
        self.assertNotIn("openai", channel.lower())
        self.assertNotIn("llm", channel.lower())

    def test_runtime_body_state_is_ignored_by_source_control(self):
        ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        required = [
            "channels/whatsapp_bridge/auth*/",
            "channels/whatsapp_bridge/node_modules/",
            "memory/web/terminal.log",
            "memory/*.jsonl",
            "memory/runtime/",
            "memory/*.db",
        ]
        for pattern in required:
            with self.subTest(pattern=pattern):
                self.assertIn(pattern, ignore)

    def test_organ_map_names_self_devices_and_immune_boundary(self):
        doc = (ROOT / "docs" / "reference-omega-organ-map.md").read_text(
            encoding="utf-8"
        )
        for heading in [
            "## Self",
            "## Senses",
            "## Voice",
            "## Hands",
            "## Memory",
            "## Attention",
            "## Body",
            "## Habitat",
            "## Immune System",
            "## Boundary Rule",
        ]:
            with self.subTest(heading=heading):
                self.assertIn(heading, doc)
        self.assertIn("Devices may perceive, normalize, execute, and report", doc)
        self.assertIn("The symbolic self should", doc)

    def test_whatsapp_bridge_exposes_manual_read_state(self):
        bridge = (ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs").read_text(
            encoding="utf-8"
        )
        self.assertIn("async function markOutboundHandled(jid)", bridge)
        self.assertIn("await sendReadReceiptsFor(jid, 'all')", bridge)
        self.assertIn("markChatState(jid, 'read', 'all')", bridge)
        self.assertIn("send-does-not-mark-inbound-read-use-mark-whatsapp-read", bridge)
        self.assertNotIn("const handled = await markOutboundHandled(to)", bridge)

    def test_whatsapp_adapter_exposes_handled_state_and_safe_chat_query(self):
        adapter = (ROOT / "modules" / "channel_whatsapp" / "src" / "whatsapp.py").read_text(encoding="utf-8")
        router = (ROOT / "modules" / "channel_router" / "src" / "router.py").read_text(encoding="utf-8")
        self.assertIn("urllib.parse.urlencode", adapter)
        self.assertIn("handled={payload.get('handled')}", adapter)
        self.assertIn("def reply_to_chat", adapter)
        self.assertIn("send_to_chat(safe_jid, text)", adapter)
        self.assertIn("mark_read(safe_jid)", adapter)
        self.assertIn("def reply_chat_base64", router)
        self.assertIn('_last_inbound_channel == "whatsapp_primary"', router)

    def test_glucose_rings_enter_router_without_auto_send(self):
        router = (ROOT / "modules" / "channel_router" / "src" / "router.py").read_text(encoding="utf-8")
        self.assertIn('"glucose": "health_glucose"', router)
        self.assertIn('_adapter("glucose").pending_glucose_rings()', router)
        self.assertIn("CHANNEL_EVENT", router)
        self.assertIn('"channel": "glucose"', router)
        self.assertIn('"sender": "glucose-watch"', router)
        self.assertIn('"reply_affordance": "inspect glucose skill card"', router)
        self.assertIn('"web_control": "channel_web_control"', router)
        self.assertIn('_adapter("web_control").get_last_message()', router)
        self.assertIn('normalize_channel_event(_control_event("web_control", msg))', router)
        self.assertIn('if _last_inbound_channel == "web_control":', router)
        self.assertNotIn("send_whatsapp", router)

    def test_metta_smoke_runner_refuses_live_memory_by_default(self):
        runner = (ROOT / "tests" / "run_metta_smokes.py").read_text(encoding="utf-8")
        self.assertIn("live-memory-risk", runner)
        self.assertIn("--allow-live-memory", runner)
        self.assertIn("lib_omegaclaw", runner)
        self.assertIn("mutates-persistent", runner)
        self.assertIn('env["OMEGACLAW_RUN_INNER"] = "1"', runner)

        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "run_metta_smokes", ROOT / "tests" / "run_metta_smokes.py"
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)

        attention_smoke = ROOT / "tests" / "attention_ledger_smoke.metta"
        if not attention_smoke.exists():
            self.skipTest(f"OmegaClaw attention smoke not present: {attention_smoke}")

        risky = module.classify(attention_smoke)
        self.assertFalse(risky.isolated)
        self.assertIn("imports-full-runtime", risky.reasons)
        self.assertIn("mutates-persistent", risky.reasons)

        isolated = module.classify(ROOT / "tests" / "assume_fabricd_skill_smoke.metta")
        self.assertTrue(isolated.isolated)

    def test_whatsapp_bridge_auth_material_is_private_by_design(self):
        source = (ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs").read_text(encoding="utf-8")
        self.assertIn("process.umask(0o077)", source)
        self.assertIn("fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })", source)
        self.assertIn("fs.chmodSync(authDir, 0o700)", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
