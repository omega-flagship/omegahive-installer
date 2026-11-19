"""Purpose: verify hive command signatures preserve documents and parse task history and continuation arguments.

Hive commands that carry a document or JSON keep its exact text (Jon 11-09).

hive-goal-propose was rest-text, so a mind's multi-line result (a Python acceptance check for Create) was collapsed
onto one line and could not even be parsed: every check run exited 1 with no output. Results, reviews, revisions,
artifacts and flow drafts are now `multiline`; titles, reasons and filters still collapse to one line."""
import json
import pathlib
import sys
import unittest

from hive.spaces.sexpr import parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hive" / "runtime" / "extensions"))  # the parser moved from src/ with the #49 port
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import helper_command_parser as parser  # noqa: E402
from test_code_signatures_exact_text import _args  # noqa: E402

SIGNATURES = ROOT / "modules" / "hive" / "signatures.metta"
KEEP = ["hive-goal-done", "hive-goal-propose", "hive-goal-file", "hive-review-complete", "hive-revision", "hive-revision-part",
        "hive-artifact-create", "hive-flow-draft", "hive-flow-revise"]


class HiveSignatureExactTextTest(unittest.TestCase):
    def setUp(self):
        parser.reload_signature_commands(SIGNATURES)

    def tearDown(self):
        parser.reload_signature_commands()

    def test_document_arguments_are_multiline(self):
        for name in KEEP:
            self.assertEqual(parser.SIGNATURE_COMMANDS[name][-1][0], "multiline", name)
        self.assertEqual(parser.SIGNATURE_COMMANDS["hive-goal-create"][-1][0], "rest-text")

    def test_a_proposed_python_file_keeps_its_lines(self):
        check = "import unittest\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertTrue(True)\n"
        payload = json.dumps({"files": {"checks/acceptance_check.py": check}})
        _, args = _args(parser.signature_balance_parentheses("hive-goal-propose g_1 " + payload))
        self.assertEqual(args[0], "g_1")
        self.assertEqual(json.loads(args[1])["files"]["checks/acceptance_check.py"], check)

    def test_a_title_still_collapses(self):
        _, args = _args(parser.signature_balance_parentheses("hive-goal-create g_1 two\nlines"))
        self.assertEqual(args, ["g_1", "two lines"])

    def test_history_and_output_offsets_and_continuation_instructions_parse(self):
        examples = [("hive-goal-history \"tip calculator\" 3", "hive-goal-history", ["tip calculator", 3]),
                    ("hive-goal-output g_1 3000", "hive-goal-output", ["g_1", 3000]),
                    ("hive-goal-continue g_1 finish the chart", "hive-goal-continue", ["g_1", "finish the chart"])]
        for command, expected_head, expected_args in examples:
            head, *args = parse(parser.signature_balance_parentheses(command))[0]
            self.assertEqual((head, args), (expected_head, expected_args))

    # A builder sends each file as its own command, its body ended by a marker line it names, so nothing in the file
    # (quotes, brackets, triple quotes) is read as syntax and a reply cut off at its length keeps the files it finished.
    APP = 'const s = "x(";\n/* """ not an end */\nif (a) { b(\'q\'); }\nEOF_app_jsx = 1;\n    indented();'

    def test_a_file_sent_with_its_own_marker_keeps_every_line(self):
        reply = "hive-goal-file g_1 src/app.js <<'EOF_app_js'\n" + self.APP + "\nEOF_app_js"
        self.assertTrue(parser.signature_raw_batch_complete(reply))
        head, args = _args(parser.signature_balance_parentheses(reply))
        # each line ends with its newline, the file's last line included, as a shell heredoc writes it
        self.assertEqual((head, args), ("hive-goal-file", ["g_1", "src/app.js", self.APP + "\n"]))

    def test_several_file_commands_in_one_reply_are_each_one_command(self):
        reply = ("hive-goal-file g_1 index.html <<'EOF_i'\n<p>\"hi\"</p>\nEOF_i\n"
                 "hive-goal-file g_1 app.js <<'EOF_a'\n" + self.APP + "\nEOF_a\n"
                 'hive-goal-propose g_1 {"summary": "two files"}')
        forms = parser._signature_split_top_level_forms(parser.signature_balance_parentheses(reply)[1:-1])
        self.assertEqual([_args("(" + f + ")") for f in forms], [
            ("hive-goal-file", ["g_1", "index.html", '<p>"hi"</p>\n']), ("hive-goal-file", ["g_1", "app.js", self.APP + "\n"]),
            ("hive-goal-propose", ["g_1", '{"summary": "two files"}'])])

    def test_an_unclosed_file_body_is_an_incomplete_reply(self):
        self.assertFalse(parser.signature_raw_batch_complete("hive-goal-file g_1 app.js <<'EOF_a'\nconst a = 1;\n"))
        self.assertFalse(parser.signature_raw_batch_complete("hive-goal-file g_1 app.js <<'EOF_a'"))

    def test_a_triple_quoted_proposal_keeps_its_text(self):
        # before, a block's text was dropped for every skill with no lowering: hive-goal-propose proposed ""
        _, args = _args(parser.signature_balance_parentheses('hive-goal-propose g_1 """\n{"a": 1}\n"""'))
        self.assertEqual(args, ["g_1", '{"a": 1}'])

    def test_a_quoted_csv_keeps_its_quotes_and_an_empty_body_is_empty(self):
        _, args = _args(parser.signature_balance_parentheses("hive-goal-file g_1 people.csv <<'EOF_c'\n\"name\",\"age\"\n\"bob\",\"3\"\nEOF_c"))
        self.assertEqual(args, ["g_1", "people.csv", '"name","age"\n"bob","3"\n'])
        _, args = _args(parser.signature_balance_parentheses("hive-goal-file g_1 empty.txt <<'EOF_e'\nEOF_e"))
        self.assertEqual(args, ["g_1", "empty.txt", ""])

    def test_a_cut_off_reply_keeps_only_its_finished_files_and_the_claim_before_them(self):
        reply = ("hive-goal-claim g_1\nhive-goal-file g_1 index.html <<'EOF_i'\n<p>hi</p>\nEOF_i\nhive-goals\n"
                 "hive-goal-file g_1 app.js <<'EOF_a'\nconst a = 1;\nEOF_a\nhive-goal-file g_1 style.css <<'EOF_s'\nbody {")
        self.assertEqual(parser.finished_file_commands(reply),
                         "hive-goal-claim g_1\nhive-goal-file g_1 index.html <<'EOF_i'\n<p>hi</p>\nEOF_i\n"
                         "hive-goal-file g_1 app.js <<'EOF_a'\nconst a = 1;\nEOF_a")
        # a claim the cut may have ended inside (the reply's last command) is never run
        self.assertEqual(parser.finished_file_commands("hive-goal-file g_1 a.txt <<'EOF_a'\nx\nEOF_a\nhive-goal-claim g_1"),
                         "hive-goal-file g_1 a.txt <<'EOF_a'\nx\nEOF_a")


if __name__ == "__main__":
    unittest.main()
