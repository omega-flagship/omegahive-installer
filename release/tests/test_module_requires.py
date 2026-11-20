"""A module whose module.toml requires what a mind lacks stays out of that mind: not imported, not parsed, not catalogued.

The first test install that ran Make on 20 Nov had Create's Code service but gave its minds no OmegaCode client, and a
builder offered code-open followed it into "the OmegaCode client is not installed for this mind" and failed its goal.
Each rule of hive/runtime/extensions/module_requires.py is checked on a constructed input here, then the selection the
mind's import (hive_services.module_loader) and its parser (helper_command_parser) share, on the real modules."""
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from hive.runtime import hive_services  # noqa: E402
from hive.runtime.extensions import helper_command_parser as parser  # noqa: E402
from hive.runtime.extensions import module_requires as requires  # noqa: E402
from module_loader_test_utils import omegacode_client_tree as _client_tree  # noqa: E402

MET, MISSING, UNKNOWN = requires.MET, requires.MISSING, requires.UNKNOWN


def _path_without_omegacode():
    """This interpreter's path less any entry holding an omegacode package, so the client is absent unless a test adds it."""
    return [p for p in sys.path if not (pathlib.Path(p or ".") / "omegacode").exists()]


class RequirementRulesTest(unittest.TestCase):
    def test_python_version(self):
        self.assertEqual(requires.requirement_state("python>=3.10")[0], MET)
        newer = f"python>={sys.version_info[0]}.{sys.version_info[1] + 1}"
        state, why = requires.requirement_state(newer)
        self.assertEqual(state, MISSING)
        self.assertIn("{}.{}".format(*sys.version_info[:2]), why)

    def test_a_python_distribution_by_its_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            info = pathlib.Path(tmp) / "invented_dist-1.4.2.dist-info"
            info.mkdir()
            (info / "METADATA").write_text("Metadata-Version: 2.1\nName: invented-dist\nVersion: 1.4.2\n")
            with mock.patch.object(sys, "path", [tmp] + sys.path):
                self.assertEqual(requires.requirement_state("invented-dist>=1.2", {"PATH": ""})[0], MET)
                self.assertEqual(requires.requirement_state("invented-dist==1.4.2", {"PATH": ""})[0], MET)
                state, why = requires.requirement_state("invented-dist>=2", {"PATH": ""})
                self.assertEqual((state, why), (MISSING, "invented-dist 1.4.2 is installed, not >=2"))

    def test_an_executable_on_path_is_met_whatever_its_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            tool = pathlib.Path(tmp) / "invented-tool"
            tool.write_text("#!/bin/sh\n")
            tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
            self.assertEqual(requires.requirement_state("invented-tool>=99", {"PATH": tmp})[0], MET)
            state, why = requires.requirement_state("invented-tool>=99", {"PATH": os.path.join(tmp, "empty")})
            self.assertEqual((state, why), (MISSING, "no Python distribution or executable named invented-tool"))

    def test_the_omegacode_client_from_omegacode_src_or_this_pythons_path(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sys, "path", _path_without_omegacode()):
            self.assertEqual(requires.requirement_state("service:omegacode", {})[0], MISSING)
            self.assertEqual(requires.requirement_state("service:omegacode", {"OMEGACODE_SRC": tmp})[0], MISSING)
            src = _client_tree(tmp)
            # the listing this Python kept of tmp before the client was written, believed current as when the write
            # lands within the folder's mtime tick: on CI on 20 Nov the client then read as missing
            finder = sys.path_importer_cache.get(tmp)
            if finder is not None and hasattr(finder, "_path_mtime"):
                finder._path_mtime = os.stat(tmp).st_mtime
            self.assertEqual(requires.requirement_state("service:omegacode", {"OMEGACODE_SRC": src}),
                             (MET, "the OmegaCode client imports from " + src))
            with mock.patch.object(sys, "path", [src] + sys.path):
                self.assertEqual(requires.requirement_state("service:omegacode", {})[0], MET)
            self.assertNotIn("omegacode", sys.modules)   # found without importing it

    def test_what_has_no_rule_counts_as_met(self):
        for entry in ("service:invented", "fabricpc:external-repo", "npm:@openai/codex@0.133.0",
                      "openrouter:model:qwen/qwen3-coder-next", "not a requirement"):
            with self.subTest(entry=entry):
                self.assertEqual(requires.requirement_state(entry, {"PATH": ""})[0], UNKNOWN)

    def test_versions_compare_by_their_numeric_parts(self):
        for have, op, want, meets in [("17.2", ">=", "12", True), ("0.22", ">=", "0.4", True), ("0.3", ">=", "0.4", False),
                                      ("2.1.0rc1", ">=", "2.1", True), ("1.4", "==", "1.4.0", True),
                                      ("1.4.2", "==", "1.4", False), ("dev", ">=", "1", None)]:
            with self.subTest(have=have, op=op, want=want):
                self.assertIs(requires._meets(have, op, want), meets)

    def test_unmet_lists_only_what_is_shown_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            module = pathlib.Path(tmp) / "invented"
            module.mkdir()
            (module / "module.toml").write_text(
                'id = "invented"\nrequires = ["python>=3.10", "invented-tool>=1", "service:invented"]\n')
            self.assertEqual(requires.unmet(module, {"PATH": ""}),
                             [("invented-tool>=1", "no Python distribution or executable named invented-tool")])
            self.assertEqual(requires.unmet(pathlib.Path(tmp) / "absent", {"PATH": ""}), [])


class ModuleSelectionTest(unittest.TestCase):
    def _core(self, tmp):
        """A core root whose loader names two modules, one requiring a tool this mind lacks."""
        modules = pathlib.Path(tmp) / "modules"
        for name, needs in (("plain", '"python>=3.10"'), ("needs_tool", '"python>=3.10", "invented-tool>=1"')):
            (modules / name).mkdir(parents=True)
            (modules / name / "module.toml").write_text(f'id = "{name}"\nrequires = [{needs}]\n')
            (modules / name / "signatures.metta").write_text(f"(SkillSignature {name}-skill)\n")
        loader = modules / "loader.metta"
        loader.write_text("; two modules\n"
                          "!(import! &self (library OmegaClaw-Core ./modules/plain/entry.metta))\n"
                          "!(import! &self (library OmegaClaw-Core ./modules/needs_tool/entry.metta))\n")
        return modules, loader

    def test_a_module_missing_its_requirement_is_neither_imported_nor_parsed(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"PATH": ""}):
            modules, loader = self._core(tmp)
            running, off = parser.module_selection(loader, modules)
            self.assertEqual(running, ["plain"])
            self.assertEqual(list(off), ["needs_tool"])
            self.assertEqual(parser.module_loader_text(loader, off),
                             "; two modules\n!(import! &self (library OmegaClaw-Core ./modules/plain/entry.metta))\n")
            paths = parser._module_declaration_paths("signatures.metta", tmp)
            self.assertEqual(paths, [modules / "plain" / "signatures.metta"])

    def test_with_the_client_the_mind_imports_the_host_loader_itself(self):
        host = ROOT / "modules" / "loader.metta"
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sys, "path", _path_without_omegacode()):
            src = _client_tree(tmp)
            with mock.patch.dict(os.environ, {"OMEGACODE_SRC": src, "OMEGACLAW_MEMORY_DIR": tmp}):
                os.environ.pop("OMEGACLAW_MODULE_LOADER", None)
                running, off = parser.module_selection(host)
                self.assertIn("code_workspace", running)
                self.assertNotIn("code_workspace", off)
                if not off:
                    self.assertEqual(pathlib.Path(hive_services.module_loader()), host)

    def test_without_the_client_the_mind_imports_the_loader_less_code_workspace(self):
        host = ROOT / "modules" / "loader.metta"
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sys, "path", _path_without_omegacode()):
            with mock.patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": tmp}):
                for name in ("OMEGACLAW_MODULE_LOADER", "OMEGACODE_SRC"):
                    os.environ.pop(name, None)
                running, off = parser.module_selection(host)
                self.assertIn("code", running)
                self.assertEqual([entry for entry, _why in off["code_workspace"]], ["service:omegacode"])
                with self.assertLogs("hive_modules", "WARNING") as logged:
                    loaded = pathlib.Path(hive_services.module_loader())
            self.assertEqual(loaded, pathlib.Path(tmp) / "modules-loader.metta")
            self.assertIn("module code_workspace left out: requires service:omegacode", logged.output[0])
            # the mind imports exactly what the parser authorizes: the host loader's modules less those left out
            self.assertEqual(parser._enabled_module_names(loaded), running)
            self.assertNotIn("code_workspace", parser._enabled_module_names(loaded))
            self.assertIn("code", parser._enabled_module_names(loaded))


if __name__ == "__main__":
    unittest.main()
