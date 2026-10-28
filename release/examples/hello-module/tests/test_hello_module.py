"""hello-module follows the module contract, and its declarations parse when it is enabled.

Run from the repository root:  python -m pytest -q examples/hello-module/tests

1. The manifest and the entry atoms agree, with the same checks tests/test_module_organs.py applies to modules/.
2. Enabled through a loader (the pattern of tests/test_home_assistant_module.py), the command parser reads its
   signature, catalog and affordance files: `hello-greet Ada` parses to a valid skill call.
3. With PeTTa available (PETTA_PATH, swipl on PATH), the declaration files load in PeTTa and the skill runs. The
   module's own import lines are left out there, because they resolve only once it is installed under modules/.
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tomllib

import pytest

MODULE = pathlib.Path(__file__).resolve().parents[1]
ROOT = MODULE.parents[1]
INSTALLED_NAME = "hello_module"     # the folder name under modules/ that entry.metta's import lines expect
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src import helper_command_parser as parser  # noqa: E402


def _manifest():
    return tomllib.loads((MODULE / "module.toml").read_text(encoding="utf-8"))


def test_manifest_matches_entry_atoms():
    manifest = _manifest()
    module_id = manifest["id"]
    entrypoint = manifest.get("entrypoint", "entry.metta")
    entry = (MODULE / entrypoint).read_text(encoding="utf-8")
    assert f"(Module {module_id})" in entry
    assert f"(ModuleKind {module_id} {manifest['kind']})" in entry
    assert f'(ModuleVersion {module_id} "{manifest["version"]}")' in entry
    assert f'(ModuleEntrypoint {module_id} "{entrypoint}")' in entry
    assert f"(ModuleOptional {module_id} {'True' if manifest.get('optional') else 'False'})" in entry
    assert f"(ModuleDefaultEnabled {module_id} {'True' if manifest['default_enabled'] else 'False'})" in entry
    assert "skill:hello-greet" in manifest["provides"]
    for provide in manifest["provides"]:
        kind, _, name = provide.partition(":")
        assert kind == "skill", provide
        assert f"(Provides {module_id} (Skill {name}))" in entry
    for key in ("catalog", "signatures"):
        assert manifest[key] in entry
    assert "skills.metta" in entry
    for name in ("catalog.metta", "affordance.metta", "signatures.metta", "skills.metta"):
        assert f"./modules/{INSTALLED_NAME}/{name}" in entry


def test_declarations_parse_when_enabled(tmp_path):
    modules = tmp_path / "modules"
    shutil.copytree(MODULE, modules / INSTALLED_NAME, ignore=shutil.ignore_patterns("tests", "__pycache__"))
    (modules / "loader.metta").write_text(
        f"!(import! &self (library OmegaClaw-Core ./modules/{INSTALLED_NAME}/entry.metta))\n", encoding="utf-8")
    old_root = parser.MODULE_DECLARATIONS_ROOT
    try:
        parser.MODULE_DECLARATIONS_ROOT = modules
        parser.reload_signature_commands()
        parsed = parser.signature_balance_parentheses("hello-greet Ada Lovelace")
        help_text = parser.skill_help("hello")
        affordance_paths = parser._module_declaration_paths("affordance.metta")
    finally:
        parser.MODULE_DECLARATIONS_ROOT = old_root
        parser.reload_signature_commands()

    assert parsed == '((hello-greet "Ada Lovelace"))'
    assert parser.test_metta_expression(parsed) == "METTA-SYNTAX-OK"
    assert "hello-greet name returns a greeting" in help_text
    assert affordance_paths == [modules / INSTALLED_NAME / "affordance.metta"]


def test_not_callable_unless_enabled():
    """The module is not under modules/ and not in any loader, so the default command surface does not know it."""
    parser.reload_signature_commands()
    signatures = "\n".join(p.read_text(encoding="utf-8") for p in parser.signature_declaration_paths())
    assert "hello-greet" not in signatures


def _petta():
    path = pathlib.Path(os.environ.get("PETTA_PATH", "")).expanduser()
    if not os.environ.get("PETTA_PATH") or not (path / "run.sh").is_file() or shutil.which("swipl") is None:
        return None
    return path


@pytest.mark.skipif(_petta() is None, reason="needs PETTA_PATH with run.sh, and swipl on PATH")
def test_declarations_load_in_petta(tmp_path):
    parts = [line for line in (MODULE / "entry.metta").read_text(encoding="utf-8").splitlines()
             if not line.startswith("!(import!")]
    for name in ("catalog.metta", "affordance.metta", "signatures.metta", "skills.metta"):
        parts.append((MODULE / name).read_text(encoding="utf-8"))
    parts += ['!(println! (match &self (Provides omegaclaw.example.hello $thing) $thing))',
              '!(println! (match &self (SkillSignature hello-greet $arg) $arg))',
              '!(println! (hello-greet "Ada"))']
    probe = tmp_path / "hello_probe.metta"
    probe.write_text("\n".join(parts) + "\n", encoding="utf-8")
    result = subprocess.run(["sh", str(_petta() / "run.sh"), str(probe)], cwd=tmp_path, capture_output=True,
                            text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    out = result.stdout
    assert "(Skill hello-greet)" in out
    assert "(Arg rest-text name)" in out
    assert '(Greeting \\"hello\\" \\"Ada\\")' in out
