"""Code proposal payloads keep their exact text through the SkillSignature parser.

code-propose hunks and code-test-prepare preparation JSON are declared `multiline`, so line breaks and JSON escapes
(\\n, \\t) reach the Code module byte for byte. Other rest-text commands keep their one-line collapsing.
Found by Mesto (PhysixSNET/omegahive#38)."""
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hive" / "runtime" / "extensions"))  # the parser moved from src/ with the #49 port

import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402

SIGNATURES = ROOT / "modules" / "code" / "signatures.metta"


def _args(rendered):
    """Decode the quoted string arguments of one rendered ((head "a" "b" ...)) call."""
    body = rendered.strip()
    assert body.startswith("((") and body.endswith("))"), body
    head, rest = parser._signature_consume_token(body[2:-2])
    out = []
    while rest:
        assert rest.startswith('"'), rest
        token, rest = parser._signature_consume_token(rest)
        out.append(token)
    return head, out


class CodeSignatureExactTextTest(unittest.TestCase):
    def setUp(self):
        parser.reload_signature_commands(SIGNATURES)

    def tearDown(self):
        parser.reload_signature_commands()

    def test_declared_types(self):
        self.assertEqual(parser.SIGNATURE_COMMANDS["code-propose"][-1], ("multiline", "hunks-json"))
        self.assertEqual(parser.SIGNATURE_COMMANDS["code-test-prepare"][-1], ("multiline", "preparation-json"))

    def test_multiline_hunk_with_json_escapes_round_trips_byte_for_byte(self):
        hunks = ('[{"path":"calc.py","replacement":"def add(a, b):\\n    return a + b\\n","before_digest":"' + "0" * 64
                 + '"},\n{"path":"notes.txt","replacement":"tab\\there\\r\\nend \\"q\\" \\\\ back\\n"}]')
        for raw in ("code-propose ws_1 op_invented_1 " + hunks, "code-propose ws_1 op_invented_1 " + hunks + "\n"):
            rendered = parser.signature_balance_parentheses(raw)
            self.assertEqual(metta.test_metta_expression(rendered), "METTA-SYNTAX-OK", rendered)
            head, args = _args(rendered)
            self.assertEqual((head, args[:2]), ("code-propose", ["ws_1", "op_invented_1"]))
            self.assertEqual(args[2], hunks)
            self.assertEqual(args[2].encode("utf-8"), hunks.encode("utf-8"))
            decoded = json.loads(args[2])
            self.assertEqual(decoded[0]["replacement"], "def add(a, b):\n    return a + b\n")
            self.assertEqual(decoded[1]["replacement"], 'tab\there\r\nend "q" \\ back\n')

    def test_one_line_hunk_keeps_its_escapes(self):
        hunks = '[{"path":"a.py","replacement":"x = 1\\ny = 2\\n"}]'
        for raw in ("code-propose ws_1 op_invented_1 " + hunks, "(code-propose ws_1 op_invented_1 " + hunks + ")"):
            _, args = _args(parser.signature_balance_parentheses(raw))
            self.assertEqual(args[2], hunks)

    def test_test_prepare_json_and_simple_form_are_exact(self):
        prep = '{"proposal":{"proposal_id":"suggestion_' + "ab" * 16 + '"},\n"note":"a\\nb"}'
        _, args = _args(parser.signature_balance_parentheses("code-test-prepare rq_1 prep-calc-1 " + prep))
        self.assertEqual(args, ["rq_1", "prep-calc-1", prep])
        simple = "suggestion_" + "ab" * 16
        _, args = _args(parser.signature_balance_parentheses("code-test-prepare rq_1 prep-calc-1 " + simple))
        self.assertEqual(args, ["rq_1", "prep-calc-1", simple])

    def test_other_rest_text_commands_still_collapse_to_one_line(self):
        _, args = _args(parser.signature_balance_parentheses("code-retrieve find\nthe adder\\nplease"))
        self.assertEqual(args, ["find the adder please"])
        _, args = _args(parser.signature_balance_parentheses("code-test-run pt_1 run-calc-1 {\"a\":\n1}"))
        self.assertEqual(args[2], '{"a": 1}')


if __name__ == "__main__":
    unittest.main()
