"""Purpose: a file a mind sends as hive-goal-file reaches the staging route exactly as written, through the command
parser and the hive's PeTTa: PeTTa reads the string literal the parser writes and hands hive_commons.goal_file its text,
so a quoted CSV or a JSON string keeps the quote marks it starts and ends with, and every line keeps its newline. Before,
goal_file also stripped a quote from each end of what PeTTa had already decoded."""
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_a_quoted_csv_and_a_json_string_file_are_staged_word_for_word(tmp_path):
    # HIVE_TEST_PETTA is what CI's runtime step sets (scripts/ci/runtime-tests.sh), and reading it is what makes
    # scripts/ci/pr_hive_tests.py --runtime select this module; PETTA_PATH serves a local run.
    petta = Path(os.environ.get("HIVE_TEST_PETTA") or os.environ.get("PETTA_PATH") or str(Path.home() / "PeTTa"))
    if not (petta / "src/main.pl").is_file():
        pytest.skip("needs PeTTa")
    # the skill as modules/hive/skills.metta defines it, so the test calls what a mind's command calls
    rule = "(= (hive-goal-file $id $path $text)\n   (py-call (hive_commons.goal_file $id $path $text)))"
    assert rule in (ROOT / "modules/hive/skills.metta").read_text()
    # A separate interpreter keeps this check's Python stubs out of the hive fixtures' persistent PeTTa interpreter.
    script = textwrap.dedent(r'''
        import json, os, pathlib, sys
        root, scratch, petta, rule = sys.argv[1:]
        root, scratch, petta = map(pathlib.Path, (root, scratch, petta))
        os.environ.update(HIVE_API_URL="http://hive.test", HIVE_WS_TOKEN="member-test-token",
                          OMEGACLAW_MEMORY_DIR=str(scratch / "memory"))
        for path in (petta / "python", root / "hive/runtime/extensions", root / "modules/hive/src"):
            sys.path.insert(0, str(path))
        import helper_command_parser as parser
        import hive_commons
        staged = []
        def call(method, path, payload=None):
            staged.append((method, path, payload))
            return {"path": payload["path"], "bytes": len(payload["text"].encode())}, None
        hive_commons._call = call
        parser.reload_signature_commands(root / "modules/hive/signatures.metta")
        from petta import PeTTa
        metta = PeTTa(petta_path=str(petta))
        metta.process_metta_string(rule)
        files = {"people.csv": '"name","age"\n"bob","3"\n', "greeting.json": '"hello"\n'}
        for name, text in files.items():
            reply = f"hive-goal-file g_1 {name} <<'EOF_f'\n{text}EOF_f"
            out = metta.process_metta_string("!" + parser.signature_balance_parentheses(reply))
            assert out and "HIVE-GOAL-FILE-STAGED " + name in out[0], out
        assert [(p["path"], p["text"]) for _, _, p in staged] == list(files.items()), staged
        assert [(m, path) for m, path, _ in staged] == [("POST", "/api/agent/goals/g_1/files")] * 2, staged
        print("HIVE-GOAL-FILE-WORD-FOR-WORD-OK")
    ''')
    result = subprocess.run([sys.executable, "-c", script, str(ROOT), str(tmp_path), str(petta), rule],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "HIVE-GOAL-FILE-WORD-FOR-WORD-OK" in result.stdout
