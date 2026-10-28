#!/usr/bin/env python3
"""Stress tests for the file-writing hand.

These tests keep the fix at the body/motor boundary: the agent still chooses
`write-file`, but fragile byte preservation should not depend on Prolog string
printing when the command channel can safely lower content to base64.
"""

import base64
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402


RICH_HTML = """<html><head><title>Habitat: Family</title></head>
<body>
<nav data-label="Home: 🏠">家 | Family | Login</nav>
<p>Quote: "safe" and apostrophe: it's ok.</p>
<p>MeTTa-looking text: (PersistentNote "agent" "x:y" "0.9")</p>
<p>Shell-looking text: $(rm -rf /) && echo "do not run"</p>
</body></html>"""

ODD_CONTENT = """First line: colon should survive.
Second line starts like a command: send-channel this must remain file text.
Third line starts like MeTTa: (space-transform "persistent" "(Old)" "events" "(New)" "reason")
Tabs\tand carriage\rreturns and backslash C:\\Agent\\notes survive."""


class WriteSurfaceTests(unittest.TestCase):
    def assert_metta_ok(self, expression):
        self.assertEqual(metta.test_metta_expression(expression), "METTA-SYNTAX-OK")

    def decode_write_base64(self, parsed):
        prefix = '((write-file-base64 "'
        self.assertTrue(parsed.startswith(prefix), parsed)
        parts = parsed[len(prefix) : -2].split('" "', 1)
        self.assertEqual(len(parts), 2, parsed)
        path, payload = parts
        return path, base64.b64decode(payload).decode("utf-8")

    def decode_append_base64(self, parsed):
        prefix = '((append-file-base64 "'
        self.assertTrue(parsed.startswith(prefix), parsed)
        parts = parsed[len(prefix) : -2].split('" "', 1)
        self.assertEqual(len(parts), 2, parsed)
        path, payload = parts
        return path, base64.b64decode(payload).decode("utf-8")

    def test_triple_quoted_write_lowers_to_exact_utf8_base64(self):
        raw = f'write-file memory/web/smoke.html """\n{RICH_HTML}\n"""'
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        path, body = self.decode_write_base64(parsed)
        self.assertEqual(path, "memory/web/smoke.html")
        self.assertEqual(body, RICH_HTML)

    def test_plain_quoted_write_with_rich_content_should_also_lower_to_base64(self):
        escaped = RICH_HTML.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        raw = f'write-file memory/web/smoke.html "{escaped}"'
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        path, body = self.decode_write_base64(parsed)
        self.assertEqual(path, "memory/web/smoke.html")
        self.assertEqual(body, RICH_HTML)

    def test_plain_quoted_write_preserves_multiline_control_characters(self):
        escaped = (
            ODD_CONTENT.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\t", "\\t")
            .replace("\r", "\\r")
        )
        raw = f'write-file memory/notes/odd.txt "{escaped}"'
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        path, body = self.decode_write_base64(parsed)
        self.assertEqual(path, "memory/notes/odd.txt")
        self.assertEqual(body, ODD_CONTENT)

    def test_literal_multiline_quoted_write_preserves_indentation(self):
        content = "<div>\n  <p>Indented: yes</p>\n\n  <p>Blank line above</p>\n</div>"
        raw = f'write-file memory/web/indent.html "{content}"'
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        path, body = self.decode_write_base64(parsed)
        self.assertEqual(path, "memory/web/indent.html")
        self.assertEqual(body, content)

    def test_append_file_uses_same_safe_byte_path(self):
        raw = 'append-file memory/notes/odd.txt "Next: line\\nCommand-looking: pin no split"'
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        path, body = self.decode_append_base64(parsed)
        self.assertEqual(path, "memory/notes/odd.txt")
        self.assertEqual(body, "Next: line\nCommand-looking: pin no split")

    def test_multiple_writes_in_one_cycle_do_not_merge_content(self):
        raw = "\n".join(
            [
                'write-file memory/notes/a.txt "A: one"',
                'write-file memory/notes/b.txt "B: two"',
            ]
        )
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        self.assertIn('write-file-base64 "memory/notes/a.txt" "QTogb25l"', parsed)
        self.assertIn('write-file-base64 "memory/notes/b.txt" "QjogdHdv"', parsed)

    def test_direct_base64_remains_escape_hatch_for_triple_quote_content(self):
        content = 'Literal delimiter: """ and pipes | and parens (ok)'
        payload = base64.b64encode(content.encode("utf-8")).decode("ascii")
        raw = f'write-file-base64 memory/notes/delimiter.txt {payload}'
        parsed = parser.signature_balance_parentheses(raw)
        self.assert_metta_ok(parsed)
        self.assertEqual(
            parsed,
            f'((write-file-base64 "memory/notes/delimiter.txt" "{payload}"))',
        )

    def test_empty_base64_payload_is_valid_empty_bytes(self):
        parsed = parser.signature_balance_parentheses('append-file-base64 memory/notes/empty.txt ""')
        self.assert_metta_ok(parsed)
        self.assertEqual(parsed, '((append-file-base64 "memory/notes/empty.txt" ""))')

    def test_write_base64_helper_preserves_bytes(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as tmpdir:
            path = pathlib.Path(tmpdir) / "rich.html"
            payload = base64.b64encode(RICH_HTML.encode("utf-8")).decode("ascii")
            result = metta.write_file_base64(str(path), payload)
            self.assertIn("WRITE-FILE-BASE64-SUCCESS", result)
            self.assertEqual(path.read_text(encoding="utf-8"), RICH_HTML)

    def test_write_base64_helper_rejects_invalid_payload(self):
        result = metta.write_file_base64("/tmp/agent-invalid-base64.txt", "not base64 ***")
        self.assertIn("WRITE-FILE-BASE64-ERROR invalid base64", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
