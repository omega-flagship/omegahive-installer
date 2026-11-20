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

    def test_an_unclosed_file_body_is_refused_not_staged_as_the_file(self):
        # before, the opener and every line after it became the file, the next command's line included, and a """ in
        # the body made it a triple-quoted one instead
        for reply in ("hive-goal-file g_1 a.txt <<'EOF_a'\nconst a = 1;\nhive-goal-get g_1\n",
                      'hive-goal-file g_1 a.py <<\'EOF_a\'\ndef f():\n    """doc"""\n    return 1\n'):
            parsed = parser.signature_balance_parentheses(reply)
            self.assertTrue(parsed.startswith('((syntax-error "hive-goal-file"'), parsed)
            self.assertIn("a body opened with <<'EOF_a' has no line EOF_a to close it", parsed)
            self.assertEqual(parser.unclosed_heredoc(reply), "EOF_a")
        self.assertIsNone(parser.unclosed_heredoc("hive-goal-file g_1 a.txt <<'EOF_a'\nx\nEOF_a"))

    def test_a_body_opens_only_after_a_command_whose_last_argument_spans_lines(self):
        # <<'X' ending hive-goal-get's line swallowed the claim after it, up to the line X
        forms = parser._signature_split_top_level_forms(
            parser.signature_balance_parentheses("hive-goal-get g_1 <<'X'\nhive-goal-claim g_1\nX\nhive-goals")[1:-1])
        self.assertTrue(forms[0].startswith('(syntax-error "hive-goal-get"') and "takes no body" in forms[0], forms)
        self.assertIn('(hive-goal-claim "g_1")', forms)
        self.assertIn("(hive-goals)", forms)

    def test_a_file_whose_own_lines_hold_its_marker_is_refused_whole(self):
        # a shell script with its own heredoc, in a file marked with the same name: the file ended at the script's
        # line EOF, and the rest of it, a hive-goal-done line included, followed as commands
        reply = "hive-goal-file g_1 a.sh <<'EOF'\ncat <<'EOF'\nhi\nEOF\nhive-goal-done g_1 oops\nEOF\nhive-goal-get g_1"
        forms = parser._signature_split_top_level_forms(parser.signature_balance_parentheses(reply)[1:-1])
        self.assertEqual(len(forms), 2, forms)
        self.assertTrue(forms[0].startswith('(syntax-error "hive-goal-file"') and "is EOF itself" in forms[0], forms)
        self.assertEqual(forms[1], '(hive-goal-get "g_1")')
        self.assertEqual(parser.finished_file_commands(reply), "")    # a reply cut off after it keeps none of it
        # two files that each end at their own line EOF stay two commands
        two = "hive-goal-file g_1 a.txt <<'EOF'\na\nEOF\nhive-goal-file g_1 b.txt <<'EOF'\nb\nEOF"
        self.assertEqual([_args("(" + f + ")") for f in parser._signature_split_top_level_forms(
            parser.signature_balance_parentheses(two)[1:-1])],
            [("hive-goal-file", ["g_1", "a.txt", "a\n"]), ("hive-goal-file", ["g_1", "b.txt", "b\n"])])

    def test_a_whole_body_inside_a_file_cut_short_by_its_marker_leaves_the_file_refused(self):
        # Jon's review of #545: after the line X that ended the file early, its text held a whole hive-goal-file with
        # a body of its own; opening that body forgot X, so the hive-goal-done after it ran and the file's real last
        # line X read as a command. Any marker a body closed with now refuses everything from that body on
        for inner in ("Y", "X"):
            reply = (f"hive-goal-file g_1 a.txt <<'X'\na\nX\nhive-goal-file g_1 b.txt <<'{inner}'\nb\n{inner}\n"
                     "hive-goal-done g_1 oops\nX\nhive-goal-get g_1")
            forms = parser._signature_split_top_level_forms(parser.signature_balance_parentheses(reply)[1:-1])
            self.assertEqual(len(forms), 2, forms)
            self.assertTrue(forms[0].startswith('(syntax-error "hive-goal-file"') and "is X itself" in forms[0], forms)
            self.assertEqual(forms[1], '(hive-goal-get "g_1")')
            self.assertEqual(parser.finished_file_commands(reply), "")

    def test_a_triple_quoted_proposal_keeps_its_text(self):
        # before, a block's text was dropped for every skill with no lowering: hive-goal-propose proposed ""
        _, args = _args(parser.signature_balance_parentheses('hive-goal-propose g_1 """\n{"a": 1}\n"""'))
        self.assertEqual(args, ["g_1", '{"a": 1}'])

    def test_a_quoted_csv_keeps_its_quotes_and_an_empty_body_is_empty(self):
        _, args = _args(parser.signature_balance_parentheses("hive-goal-file g_1 people.csv <<'EOF_c'\n\"name\",\"age\"\n\"bob\",\"3\"\nEOF_c"))
        self.assertEqual(args, ["g_1", "people.csv", '"name","age"\n"bob","3"\n'])
        _, args = _args(parser.signature_balance_parentheses("hive-goal-file g_1 empty.txt <<'EOF_e'\nEOF_e"))
        self.assertEqual(args, ["g_1", "empty.txt", ""])

    def test_control_characters_in_a_file_body_stay_as_they_are(self):
        # a form feed or a vertical tab once ended a line (str.splitlines), and every other control character was
        # written as \xNN, which PeTTa and this parser read back as the letters xNN
        body = "page 1\x0cpage 2\x0bv\x01\x1b[31mred\x7f\x1c\x00\n"
        _, args = _args(parser.signature_balance_parentheses(f"hive-goal-file g_1 notes.txt <<'EOF_n'\n{body}EOF_n"))
        self.assertEqual(args, ["g_1", "notes.txt", body])

    def test_a_reply_with_windows_line_ends_reads_as_with_newlines(self):
        # a reply's lines still end at \r\n and \r as at \n; only the other characters str.splitlines ends one at stay
        reply = "hive-goals\nhive-goal-file g_1 a.txt <<'EOF_a'\nx\ny\nEOF_a\nhive-goal-get g_1"
        for ending in ("\r\n", "\r"):
            self.assertEqual(parser.signature_balance_parentheses(reply.replace("\n", ending)),
                             parser.signature_balance_parentheses(reply))

    def test_a_cut_off_reply_keeps_only_its_finished_files_and_the_claim_before_them(self):
        reply = ("hive-goal-claim g_1\nhive-goal-file g_1 index.html <<'EOF_i'\n<p>hi</p>\nEOF_i\nhive-goals\n"
                 "hive-goal-file g_1 app.js <<'EOF_a'\nconst a = 1;\nEOF_a\nhive-goal-file g_1 style.css <<'EOF_s'\nbody {")
        self.assertEqual(parser.finished_file_commands(reply),
                         "hive-goal-claim g_1\nhive-goal-file g_1 index.html <<'EOF_i'\n<p>hi</p>\nEOF_i\n"
                         "hive-goal-file g_1 app.js <<'EOF_a'\nconst a = 1;\nEOF_a")
        # a claim the cut may have ended inside (the reply's last command) is never run
        self.assertEqual(parser.finished_file_commands("hive-goal-file g_1 a.txt <<'EOF_a'\nx\nEOF_a\nhive-goal-claim g_1"),
                         "hive-goal-file g_1 a.txt <<'EOF_a'\nx\nEOF_a")
        # a claim with no finished file after it is left out, so nothing runs as if files were staged
        self.assertEqual(parser.finished_file_commands("hive-goal-claim g_1\nhive-goal-file g_1 a.txt <<'EOF_a'\nx"), "")
        self.assertEqual(parser.finished_file_commands("hive-goal-claim g_1\nhive-goals\nhive-goal-get g_1"), "")


if __name__ == "__main__":
    unittest.main()
