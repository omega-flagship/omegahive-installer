#!/usr/bin/env python3
"""Core smoke corpus for the SkillSignature command syntax membrane."""

import pathlib
import re
import sys
import base64
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))
import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402
from module_loader_test_utils import enabled_module_loader  # noqa: E402


class CoreSyntaxSmokeCorpusTests(unittest.TestCase):
    def assert_metta_ok(self, expression):
        self.assertEqual(metta.test_metta_expression(expression), "METTA-SYNTAX-OK")

    def assert_parse(self, raw, expected):
        actual = parser.signature_balance_parentheses(raw)
        self.assertEqual(actual, expected)
        self.assert_metta_ok(actual)

    def test_core_rest_text_and_shell_cases(self):
        cases = {
            "send dinner is ready: plates are out": '((send "dinner is ready: plates are out"))',
            'remember user said "test carefully" before changing syntax': '((remember "user said \\"test carefully\\" before changing syntax"))',
            'remember "user said test carefully before changing syntax"': '((remember "user said test carefully before changing syntax"))',
            'pin "WARM | testing quoted rest args | next replay"': '((pin "WARM | testing quoted rest args | next replay"))',
            'send "Line one_newline_Line two: still same send"': '((send "Line one Line two: still same send"))',
            'shell "grep -n PAGE_MEMBER_HINTS src/webhost.py"': '((shell "grep -n PAGE_MEMBER_HINTS src/webhost.py"))',
            "send Dinner (pasta) is ready": '((send "Dinner (pasta) is ready"))',
            "shell find memory/web -maxdepth 2 -type f": '((shell "find memory/web -maxdepth 2 -type f"))',
            "remember UI preference: warm | simple | private": '((remember "UI preference: warm | simple | private"))',
            "- testing phase 1": '((pin "- testing phase 1"))',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assert_parse(raw, expected)

    def test_blank_lines_survive_unquoted_multiline_rest_text_lowering(self):
        with enabled_module_loader(parser, "channel_whatsapp"):
            parsed = parser.signature_balance_parentheses(
                "reply-whatsapp-to 523@test First paragraph\n\nSecond paragraph"
            )

            self.assertIn('((reply-whatsapp-to-base64 "523@test"', parsed)
            payload = re.search(r'"([A-Za-z0-9+/=]+)"\)\)$', parsed).group(1)
            self.assertEqual(
                base64.b64decode(payload).decode("utf-8"),
                "First paragraph\n\nSecond paragraph",
            )
            self.assert_metta_ok(parsed)

    def test_fail_closed_and_typed_core_cases(self):
        unknown = parser.signature_balance_parentheses("turn-off Living")
        self.assertIn("ignored unknown command head turn-off", unknown)
        self.assertIn('query-skill-space \\"topic\\"', unknown)
        self.assertIn(
            '(syntax-error "sleep-for" "seconds must be number',
            parser.signature_balance_parentheses("sleep-for soon no"),
        )
        self.assertIn(
            "recover: use bare numeric values",
            parser.signature_balance_parentheses("sleep-for soon no"),
        )
        self.assertIn(
            "card: beliefs-about domain relation - inspect exact belief relation",
            parser.signature_balance_parentheses("beliefs-about Tessa"),
        )
        self.assertIn(
            "run beliefs-for domain if relation is unknown",
            parser.signature_balance_parentheses("beliefs-about Tessa"),
        )
        self.assertIn(
            '(syntax-error "space-find" "unknown space nowhere; known spaces:',
            parser.signature_balance_parentheses("space-find nowhere (A $x)"),
        )
        self.assertIn(
            'use registered space names in skill commands, not raw &handles',
            parser.signature_balance_parentheses("space-find &beliefs (Belief $d $r $v $t $s)"),
        )
        self.assertIn(
            'try beliefs',
            parser.signature_balance_parentheses("space-find &beliefs (Belief $d $r $v $t $s)"),
        )

    def test_file_memory_and_reasoning_cases(self):
        cases = {
            'write-file /tmp/test.txt "<html><body>Hi: ok</body></html>"': '((write-file-base64 "/tmp/test.txt" "PGh0bWw+PGJvZHk+SGk6IG9rPC9ib2R5PjwvaHRtbD4="))',
            'append-file /tmp/test.txt "line one"': '((append-file-base64 "/tmp/test.txt" "bGluZSBvbmU="))',
            'space-transform persistent (PersistentNote "agent" $note $conf) events (Event "agent" "merged" "ok" "0.9") cleanup duplicate notes': '((space-transform "persistent" "(PersistentNote \\"agent\\" $note $conf)" "events" "(Event \\"agent\\" \\"merged\\" \\"ok\\" \\"0.9\\")" "cleanup duplicate notes"))',
            'space-transform events | (EventNote $S $K $V) | persistent | (PersistentNote $S $K $V 0.5) | test-if-space-transform-parser-fixed-now': '((space-transform "events" "(EventNote $S $K $V)" "persistent" "(PersistentNote $S $K $V 0.5)" "test-if-space-transform-parser-fixed-now"))',
            'space-merge-atoms persistent (PersistentNote "agent" $note $conf) (PersistentNote "agent" "merged" "0.9") merge duplicate notes': '((space-merge-atoms "persistent" "(PersistentNote \\"agent\\" $note $conf)" "(PersistentNote \\"agent\\" \\"merged\\" \\"0.9\\")" "merge duplicate notes"))',
            'persistent-merge-atoms (PersistentFact "Omega" "diagnostic-phase" "in-progress" "0.9") (PersistentFact "Omega" "diagnostic-phase" "in-progress" "0.9") exact duplicate': '((persistent-merge-atoms "(PersistentFact \\"Omega\\" \\"diagnostic-phase\\" \\"in-progress\\" \\"0.9\\")" "(PersistentFact \\"Omega\\" \\"diagnostic-phase\\" \\"in-progress\\" \\"0.9\\")" "exact duplicate"))',
            'retire-persistent-expression (PersistentNote "agent" "test: colon ok" "0.8") stale duplicate': '((retire-persistent-expression "(PersistentNote \\"agent\\" \\"test: colon ok\\" \\"0.8\\")" "stale duplicate"))',
            'retire-persistent-expression "(PersistentNote "agent" "test: colon ok" "0.8")" stale duplicate': '((retire-persistent-expression "(PersistentNote \\"agent\\" \\"test: colon ok\\" \\"0.8\\")" "stale duplicate"))',
            'persistent-cleanup-candidates': '((persistent-cleanup-candidates 50))',
            'persistent-cleanup-candidates 12': '((persistent-cleanup-candidates 12))',
            'persistent-cleanup-propose pc-123 merge-duplicate exact duplicate review': '((persistent-cleanup-propose "pc-123" "merge-duplicate" "exact duplicate review"))',
            'persistent-cleanup-commit pp-123': '((persistent-cleanup-commit "pp-123"))',
            'cleanup-proposals': '((cleanup-proposals))',
            'agenda-complete cleanup-test duplicate merged': '((agenda-complete "cleanup-test" "duplicate merged"))',
            'belief-derived Omega autonomy relational 0.84 0.8': '((belief-derived "Omega autonomy relational 0.84 0.8"))',
            'beliefs-for Omega': '((beliefs-for "Omega"))',
            'events-recent': '((events-recent))',
            'space-examples-default persistent': '((space-examples-default "persistent"))',
            'assimilate-world audio | obs123 | Person | preference | warm updates | 0.9': '((assimilate-world "audio | obs123 | Person | preference | warm updates | 0.9"))',
            'metta get-atoms &persistent': '((metta "(get-atoms &persistent)"))',
            'metta "(add-atom &persistent (PersistentNote "agent" "x" "0.8"))"': '((metta "(add-atom &persistent (PersistentNote \\"agent\\" \\"x\\" \\"0.8\\"))"))',
            'belief-revision-candidate "TestPerson lunch-preference example-preference 0.7 0.6"': '((belief-revision-candidate "TestPerson" "lunch-preference" "example-preference" 0.7 0.6))',
            'complete-reboot-check user requested restart after conversation calibration training session day one': '((complete-reboot-check "user requested restart after conversation calibration training session day one"))',
            'complete-reboot-check': '((complete-reboot-check))',
            'restart-self refresh loop after code update': '((restart-self "refresh loop after code update"))',
            'reboot-self User requested full embodied reboot before diagnostics': '((reboot-self "User requested full embodied reboot before diagnostics"))',
            'space-examples persistent (PersistentNote "agent" $topic $note $conf)': '((space-examples "persistent" "(PersistentNote \\"agent\\" $topic $note $conf)" 5))',
            'space-examples persistent (PersistentNote "agent" $topic $note $conf) 7': '((space-examples "persistent" "(PersistentNote \\"agent\\" $topic $note $conf)" 7))',
            'space-registry': '((space-registry))',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw[:80]):
                self.assert_parse(raw, expected)
        self.assertIn(
            '(syntax-error "space-transform" "missing closing parenthesis',
            parser.signature_balance_parentheses('space-transform persistent (PersistentNote "agent" $note events (Event "agent" "bad" "0.9") cleanup'),
        )
        self.assertIn(
            '(syntax-error "metta" "METTA-SYNTAX-ERROR unbalanced parentheses',
            parser.signature_balance_parentheses('metta "(add-atom &persistent (PersistentNote \\"agent\\" \\"x\\" \\"0.8\\")"'),
        )

    def test_narration_boundaries_for_core_commands(self):
        parsed = parser.signature_balance_parentheses("Narration before command.\nenergy-status")
        self.assertIn("ignored unknown command head Narration", parsed)
        self.assertIn('query-skill-space \\"topic\\"', parsed)
        self.assertIn("(energy-status)", parsed)
        parsed = parser.signature_balance_parentheses("Narration should not execute energy-status next")
        self.assertIn("ignored unknown command head Narration", parsed)
        self.assertNotIn("(energy-status)", parsed)
        cases = {
            "send Please type: energy-status": '((send "Please type: energy-status"))',
            "- energy-status": '((pin "- energy-status"))',
            "No tool calls needed - genuine silence.": '((wait "No tool calls needed - genuine silence."))',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(parser.signature_balance_parentheses(raw), expected)
        parsed = parser.signature_balance_parentheses("energy-status then tell him")
        self.assertIn('(syntax-error "energy-status" "unexpected trailing text: then tell him', parsed)
        self.assertIn("recover: quote text args", parsed)

    def test_wrapped_llm_command_forms(self):
        cases = {
            '(send "hello: there")': '((send "hello: there"))',
            '((send "hello: there"))': '((send "hello: there"))',
            '((send "Status is steady and present.") (remember "Fresh human message = open conversation / reply debt.") (pin "Fresh human message = answer first"))': '((send "Status is steady and present.") (remember "Fresh human message = open conversation / reply debt.") (pin "Fresh human message = answer first"))',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assert_parse(raw, expected)

    def test_signature_declarations_cover_current_command_surface(self):
        source = (ROOT / "src" / "helper_command_parser.py").read_text(encoding="utf-8")
        signature_text = "\n".join(path.read_text(encoding="utf-8") for path in parser.signature_declaration_paths())
        declared = set(
            re.match(r"\(SkillSignature\s+([^\s()]+)", line).group(1)
            for line in signature_text.splitlines()
            if re.match(r"\(SkillSignature\s+([^\s()]+)", line)
        )
        declared_spaces = set(
            re.match(r"\(SignatureSpace\s+([^\s()]+)", line).group(1)
            for line in signature_text.splitlines()
            if re.match(r"\(SignatureSpace\s+([^\s()]+)", line)
        )
        declared_no_action_heads = set(
            re.match(r"\(SignatureNoActionHead\s+([^\s()]+)\)", line).group(1)
            for line in signature_text.splitlines()
            if re.match(r"\(SignatureNoActionHead\s+([^\s()]+)\)", line)
        )
        declared_recovery_hints = set(
            re.match(r"\(SignatureRecoveryHint\s+([^\s()]+)\s+", line).group(1)
            for line in signature_text.splitlines()
            if re.match(r"\(SignatureRecoveryHint\s+([^\s()]+)\s+", line)
        )
        shorthand_commands = set(
            re.match(r"\(SignatureShorthand\s+([^\s()]+)\s+", line).group(1)
            for line in signature_text.splitlines()
            if re.match(r"\(SignatureShorthand\s+([^\s()]+)\s+", line)
        )
        declared_prose_fallbacks = [
            re.match(r"\(SignatureProseFallback\s+([^\s()]+)\)", line).group(1)
            for line in signature_text.splitlines()
            if re.match(r"\(SignatureProseFallback\s+([^\s()]+)\)", line)
        ]
        self.assertEqual(set(parser.SIGNATURE_COMMANDS), declared)
        self.assertEqual(set(parser.SIGNATURE_KNOWN_SPACES), declared_spaces)
        self.assertEqual(set(parser.SIGNATURE_NO_ACTION_HEADS), declared_no_action_heads)
        self.assertEqual(set(parser.SIGNATURE_RECOVERY_HINTS), declared_recovery_hints)
        self.assertEqual(declared_prose_fallbacks, [parser.SIGNATURE_PROSE_FALLBACK])
        self.assertEqual(parser.signature_prose_fallback_from(), "send-control-base64")
        self.assertIn("space-transform", shorthand_commands)
        self.assertNotIn("known_cmds =", source)
        self.assertNotIn("SIGNATURE_COMMANDS = {", source)
        self.assertNotIn('cmd == "space-transform"', source)
        self.assertNotIn("SIGNATURE_NO_ACTION_HEADS = {", source)
        self.assertNotIn('"write-file": "write-file-base64"', source)
        self.assertEqual(parser.signature_lowerings_from()["write-file"], "write-file-base64")

    def test_active_signature_declarations_have_no_collisions(self):
        seen_commands = {}
        seen_spaces = {}
        seen_lowerings = {}
        seen_prose_fallback = []
        duplicate_commands = []
        duplicate_spaces = []
        duplicate_lowerings = []

        for path in parser.signature_declaration_paths():
            for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                line = raw.split(";", 1)[0].strip()
                command = re.match(r"\(SkillSignature\s+([^\s()]+)", line)
                space = re.match(r"\(SignatureSpace\s+([^\s()]+)\)", line)
                lowering = re.match(r"\(SignatureLowering\s+([^\s()]+)\s+([^\s()]+)\)", line)
                prose_fallback = re.match(r"\(SignatureProseFallback\s+([^\s()]+)\)", line)
                if command:
                    key = command.group(1)
                    if key in seen_commands:
                        duplicate_commands.append((key, seen_commands[key], f"{path}:{line_number}"))
                    seen_commands[key] = f"{path}:{line_number}"
                if space:
                    key = space.group(1)
                    if key in seen_spaces:
                        duplicate_spaces.append((key, seen_spaces[key], f"{path}:{line_number}"))
                    seen_spaces[key] = f"{path}:{line_number}"
                if lowering:
                    key = lowering.group(1)
                    if key in seen_lowerings:
                        duplicate_lowerings.append((key, seen_lowerings[key], f"{path}:{line_number}"))
                    seen_lowerings[key] = f"{path}:{line_number}"
                if prose_fallback:
                    seen_prose_fallback.append(f"{path}:{line_number}")

        self.assertEqual(duplicate_commands, [])
        self.assertEqual(duplicate_spaces, [])
        self.assertEqual(duplicate_lowerings, [])
        self.assertLessEqual(len(seen_prose_fallback), 1)

    def test_declarations_are_organ_local(self):
        signature_paths = {path.name for path in parser.signature_declaration_paths()}
        catalog_paths = {path.name for path in parser.skill_catalog_declaration_paths()}
        for name in {
            "skill_signatures.metta", "skill_signatures_core.metta", "skill_signatures_memory.metta",
            "skill_signatures_reasoning.metta",
        }:
            self.assertIn(name, signature_paths)
        for name in {
            "skill_catalog.metta", "skill_catalog_core.metta", "skill_catalog_memory.metta",
            "skill_catalog_reasoning.metta",
        }:
            self.assertIn(name, catalog_paths)
        self.assertIn("Core:", parser.skill_catalog())
        self.assertIn("Memory spaces:", parser.skill_catalog())
        self.assertIn("Reasoning:", parser.skill_catalog())

    def test_new_signature_file_adds_command_and_space_without_python_edit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "skill_signatures.metta"
            path.write_text(
                '(SignatureSpace dream)\n'
                '(SkillSignature test-live-organ (Arg space target) (Arg number score) (Arg rest-text note))\n',
                encoding="utf-8",
            )
            commands = parser.signature_commands_from(path)
            spaces = parser.signature_spaces_from(path)
            self.assertEqual(commands["test-live-organ"], (("space", "target"), ("number", "score"), ("rest-text", "note")))
            self.assertEqual(spaces, {"dream"})
            self.assertEqual(
                metta._split_collapsed_space_transform_args(
                    'dream (DreamNote $x) events (EventNote "dream" $x) migrate dream note',
                    spaces | {"events"},
                ),
                ["dream", "(DreamNote $x)", "events", '(EventNote "dream" $x)', "migrate dream note"],
            )

            tabby = pathlib.Path(tmpdir) / "skill_signatures_tabbed.metta"
            tabby.write_text('(SkillSignature\ttabby (Arg text value))\n(SignatureSpace\ttabspace)\n', encoding="utf-8")
            self.assertEqual(parser.signature_commands_from(tabby)["tabby"], (("text", "value"),))
            self.assertEqual(parser.signature_spaces_from(tabby), {"tabspace"})
            self.assertEqual(parser.signature_no_action_heads_from(tabby), set())
            self.assertEqual(parser.signature_recovery_hints_from(tabby), {})
            self.assertEqual(parser.signature_shorthands_from(tabby), {})

            fallback = {"tabby": (("rest-text", "old"),)}
            self.assertEqual(parser._load_signature_commands(tabby, fallback=fallback)["tabby"], (("text", "value"),))

    def test_module_declarations_follow_loader_not_folder_presence(self):
        old_root = parser.MODULE_DECLARATIONS_ROOT
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                modules = pathlib.Path(tmpdir) / "modules"
                enabled = modules / "enabled"
                disabled = modules / "disabled"
                enabled.mkdir(parents=True)
                disabled.mkdir()
                (modules / "loader.metta").write_text(
                    '!(import! &self (library OmegaClaw-Core ./modules/enabled/entry.metta))\n',
                    encoding="utf-8",
                )
                (enabled / "entry.metta").write_text(
                    '!(import! &self (library OmegaClaw-Core ./modules/enabled/skills.metta))\n',
                    encoding="utf-8",
                )
                (enabled / "signatures.metta").write_text(
                    "(SkillSignature enabled-skill (Arg rest-text note))\n",
                    encoding="utf-8",
                )
                (enabled / "catalog.metta").write_text(
                    '(SkillCatalog "Enabled module: enabled-skill note")\n',
                    encoding="utf-8",
                )
                (enabled / "affordance.metta").write_text(
                    '!(add-atom &skills (Skill "enabled-skill"))\n'
                    '!(add-atom &skills (SkillTopic "enabled-skill" "enabled"))\n'
                    '!(add-atom &skills (SkillTrigger "enabled-skill" "mentions-word:enabled" 0.7 "enabled module trigger"))\n',
                    encoding="utf-8",
                )
                (disabled / "signatures.metta").write_text(
                    "(SkillSignature disabled-skill (Arg rest-text note))\n",
                    encoding="utf-8",
                )
                (disabled / "catalog.metta").write_text(
                    '(SkillCatalog "Disabled module: disabled-skill note")\n',
                    encoding="utf-8",
                )

                parser.MODULE_DECLARATIONS_ROOT = modules
                signature_text = "\n".join(path.read_text(encoding="utf-8") for path in parser.signature_declaration_paths())
                catalog_text = parser.skill_catalog()

                self.assertIn("enabled-skill", signature_text)
                self.assertNotIn("disabled-skill", signature_text)
                self.assertIn("Enabled module:", catalog_text)
                self.assertNotIn("Disabled module:", catalog_text)
        finally:
            parser.MODULE_DECLARATIONS_ROOT = old_root

    def test_malformed_signature_declarations_fail_fast(self):
        bad_cases = [
            ("command", '(SkillSignature broken (Arg text))\n', parser.signature_commands_from),
            ("argtype", '(SkillSignature broken (Arg surprise name))\n', parser.signature_commands_from),
            ("space", '(SignatureSpace)\n', parser.signature_spaces_from),
            ("lowering", '(SignatureLowering write-file)\n', parser.signature_lowerings_from),
            ("no-action", '(SignatureNoActionHead)\n', parser.signature_no_action_heads_from),
            ("recovery", '(SignatureRecoveryHint)\n', parser.signature_recovery_hints_from),
            ("shorthand-mode", '(SignatureShorthand test weird (Field text value))\n', parser.signature_shorthands_from),
            ("shorthand-field", '(SignatureShorthand test pipe (Field surprise value))\n', parser.signature_shorthands_from),
            ("duplicate-command", '(SkillSignature same)\n(SkillSignature same)\n', parser.signature_commands_from),
            ("bad-command-prefix", '(SkillSignatureBroken same)\n', parser.signature_commands_from),
        ]
        for label, text, loader in bad_cases:
            with self.subTest(label=label):
                with tempfile.TemporaryDirectory() as tmpdir:
                    path = pathlib.Path(tmpdir) / "skill_signatures.metta"
                    path.write_text(text, encoding="utf-8")
                    with self.assertRaises(parser.SignatureParseError):
                        loader(path)



if __name__ == "__main__":
    unittest.main(verbosity=2)
