#!/usr/bin/env python3
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import helper  # noqa: E402
import helper_command_parser  # noqa: E402


class AssumeSyntaxSmokeTests(unittest.TestCase):
    def assert_metta_ok(self, expression):
        self.assertEqual(helper.test_metta_expression(expression), "METTA-SYNTAX-OK")

    def assert_parse(self, raw, expected):
        actual = helper.signature_balance_parentheses(raw)
        self.assertEqual(actual, expected)
        self.assert_metta_ok(actual)

    def test_assume_examples(self):
        cases = {
            "assume-work": "((assume-work))",
            "assume-observe-predict social family-reachout": '((assume-observe-predict "social" "family-reachout"))',
            "assume-situation-status family-care sleep-transition": '((assume-situation-status "family-care" "sleep-transition"))',
            "assume-init-situation family-care sleep-transition resident sleep test: evidence before graph existed": '((assume-init-situation "family-care" "sleep-transition" "resident sleep test: evidence before graph existed"))',
            "assume-add-context-feature family-care sleep-transition house-asleep 0.95 0.85 event": '((assume-add-context-feature "family-care" "sleep-transition" "house-asleep" 0.95 0.85 "event"))',
            'assume-add-context-feature family-care sleep-transition "house asleep" 0.95 0.85 event': '((assume-add-context-feature "family-care" "sleep-transition" "house asleep" 0.95 0.85 "event"))',
            "assume-add-action family-care quiet-listening-mode attention": '((assume-add-action "family-care" "quiet-listening-mode" "attention"))',
            "assume-add-feature-edge family-care house-asleep quiet-listening-mode 0.7 0.7 1": '((assume-add-feature-edge "family-care" "house-asleep" "quiet-listening-mode" 0.7 0.7 1))',
            "assume-review-growth social family-reachout close-family reply-now": '((assume-review-growth "social" "family-reachout" "close-family" "reply-now"))',
            "assume-review-adjustment-detail social family-reachout close-family reply-now": '((assume-review-adjustment-detail "social" "family-reachout" "close-family" "reply-now"))',
            "assume-observe-writeback house movie-night": '((assume-observe-writeback "house" "movie-night"))',
            "assume-review-mutation house movie-night resident-watching-movie yellow-moody-scene": '((assume-review-mutation "house" "movie-night" "resident-watching-movie" "yellow-moody-scene"))',
            "assume-outcome social family-reachout reply-now approved 0.8 resident appreciated timely reply": '((assume-outcome "social" "family-reachout" "reply-now" "approved" 0.8 "resident appreciated timely reply"))',
            "assume-error house movie-night bright-practical-scene rejected 0.4 too bright for film mood": '((assume-error "house" "movie-night" "bright-practical-scene" "rejected" 0.4 "too bright for film mood"))',
            "assume-accept-growth social family-reachout close-family reply-now careful evidence": '((assume-accept-growth "social" "family-reachout" "close-family" "reply-now" "careful evidence"))',
            "assume-accept-adjustment social family-reachout close-family reply-now reviewed evidence": '((assume-accept-adjustment "social" "family-reachout" "close-family" "reply-now" "reviewed evidence"))',
            "assume-trace 5": "((assume-trace 5))",
            "space-find assume (AssumeOutcome $d $s $a $p $note $strength)": '((space-find "assume" "(AssumeOutcome $d $s $a $p $note $strength)"))',
            "space-transform assume | (AssumeOutcome $d $s $a $p $note $strength) | events | (EventNote omega assume $note) | cleanup assume evidence": '((space-transform "assume" "(AssumeOutcome $d $s $a $p $note $strength)" "events" "(EventNote omega assume $note)" "cleanup assume evidence"))',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw[:80]):
                self.assert_parse(raw, expected)

    def _assume_signature_args(self):
        signatures = {}
        source = ROOT / 'modules' / 'assume' / 'signatures.metta'
        for raw in source.read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if not line.startswith('(SkillSignature '):
                continue
            body = line[len('(SkillSignature '):-1]
            name, rest = helper_command_parser._signature_consume_token(body)
            args = []
            while '(Arg ' in rest:
                start = rest.find('(Arg ')
                end = rest.find(')', start)
                parts = rest[start + len('(Arg '):end].split()
                args.append((parts[0], parts[1]))
                rest = rest[end + 1:]
            signatures[name] = args
        return signatures

    def test_assume_affordance_covers_signatures(self):
        quote = chr(34)
        text = (ROOT / 'modules' / 'assume' / 'affordance.metta').read_text(encoding='utf-8')
        self.assertNotIn('(SkillContextHint ', text)
        signatures = self._assume_signature_args()
        self.assertGreaterEqual(len(signatures), 40)
        for skill, args in signatures.items():
            with self.subTest(skill=skill):
                self.assertIn(f'(Skill {quote}{skill}{quote})', text)
                self.assertIn(f'(SkillTopic {quote}{skill}{quote} {quote}assume{quote})', text)
                self.assertIn(f'(SkillCardLine {quote}{skill}{quote} {quote}', text)
                for index, arg in enumerate(args, 1):
                    arg_type, arg_name = arg
                    expected = f'(SkillArg {quote}{skill}{quote} {index} {quote}{arg_type}{quote} {quote}{arg_name}{quote})'
                    self.assertIn(expected, text)

    def test_assume_catalog_help(self):
        self.assertIn("Assume predictive organ", helper.skill_help("assume"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
