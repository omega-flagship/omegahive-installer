#!/usr/bin/env python3
"""Tests for installed OmegaClaw modules that use the module contract."""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tomllib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = ROOT.parents[1]
HAS_METTA_RUNNER = (OMEGACLAW_ROOT / "run.sh").exists()
REAL_MODULES = ROOT / "modules"


def real_modules():
    if not REAL_MODULES.exists():
        return []
    return sorted(path.parent for path in REAL_MODULES.glob("*/module.toml"))


def expected_provides_atom(module_id: str, provide: str) -> str:
    kind, _, name = provide.partition(":")
    wrappers = {
        "channel": "Channel",
        "surface": "Surface",
        "simulation": "Simulation",
        "skill": "Skill",
        "space": "Space",
        "provider": "Provider",
        "app": "App",
        "sense": "Sense",
        "affordance": "Affordance",
        "runtime-organ": "RuntimeOrgan",
    }
    wrapper = wrappers.get(kind)
    if not wrapper or not name:
        raise AssertionError(f"Unsupported provides entry: {provide}")
    return f"(Provides {module_id} ({wrapper} {name}))"


def expected_dependency_atom(module_id: str, requirement: str) -> str:
    for sep in (">=", "==", ":"):
        if sep in requirement:
            name, version = requirement.split(sep, 1)
            if sep == ">=":
                version = f">={version}"
            return f'(RuntimeDependency {module_id} {name} "{version}")'
    raise AssertionError(f"Unsupported requirement entry: {requirement}")


def run_module_smoke(smoke: str) -> subprocess.CompletedProcess[str]:
    args = [
        sys.executable,
        str(ROOT / "tests" / "run_metta_smokes.py"),
        smoke,
        "--timeout",
        "20",
    ]
    if not HAS_METTA_RUNNER:
        args.append("--list")
    return subprocess.run(
        args,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )


class OmegaClawInstalledModuleTests(unittest.TestCase):
    def test_standard_run_loads_modules_from_one_composition_hook(self):
        run_text = (ROOT / "run.metta").read_text(encoding="utf-8")
        imported_libs = re.findall(r"OmegaClaw-Core\s+(lib_omegaclaw[_a-z]*)", run_text)
        direct_loader_imports = re.findall(r"\./modules/loader\.metta", run_text)

        loader_imports = []
        for lib in imported_libs:
            path = ROOT / f"{lib}.metta"
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            if "./modules/loader.metta" in text:
                loader_imports.append(lib)

        composition_hooks = direct_loader_imports + loader_imports
        self.assertEqual(
            len(composition_hooks),
            1,
            "Side-effectful module skills must be loaded through exactly one standard composition hook.",
        )

    def test_real_gameboy_module_loads_through_metta_entrypoint(self):
        result = run_module_smoke("tests/module_gameboy_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_gameboy_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.simulation.gameboy", result.stdout)
        self.assertIn("GAMEBOY-STATUS", result.stdout)
        self.assertIn("(Skill gb-step)", result.stdout)
        self.assertIn("screenshot-observable", result.stdout)

    def test_real_omega_vm_module_loads_through_metta_entrypoint(self):
        result = run_module_smoke("tests/module_omega_vm_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_omega_vm_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.device.omega-vm", result.stdout)
        self.assertIn("OMEGA-VM-STATUS", result.stdout)
        self.assertIn("(Skill vm-shell)", result.stdout)
        self.assertIn("tiny-linux-boot", result.stdout)

    def test_real_assume_module_loads_through_metta_entrypoint(self):
        result = run_module_smoke("tests/module_assume_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_assume_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.reasoning.assume", result.stdout)
        self.assertIn("(Skill assume-predict)", result.stdout)
        self.assertIn("canonical-symbolic-graph", result.stdout)
        self.assertIn("ASSUME-SMOKE-PASS", result.stdout)

    def test_real_publishing_module_loads_through_metta_entrypoint(self):
        result = run_module_smoke("tests/module_publishing_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_publishing_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.skill.publishing", result.stdout)
        self.assertIn("(Skill write-web-page)", result.stdout)
        self.assertIn("demo.html", result.stdout)

    def test_real_scratch_space_module_loads_through_metta_entrypoint(self):
        result = run_module_smoke("tests/module_scratch_space_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_scratch_space_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.memory.scratch-space", result.stdout)
        self.assertIn("(Skill scratch-add)", result.stdout)
        self.assertIn("SCRATCH-SMOKE-PASS", result.stdout)
        self.assertIn("SCRATCH-PROMOTION-PASS", result.stdout)

    def test_real_module_manifests_match_entrypoint_atoms(self):
        for module in real_modules():
            with self.subTest(module=module.name):
                manifest = tomllib.loads((module / "module.toml").read_text(encoding="utf-8"))
                module_id = manifest["id"]
                entrypoint = manifest.get("entrypoint", "entry.metta")
                entry = (module / entrypoint).read_text(encoding="utf-8")

                self.assertIn(f"(Module {module_id})", entry)
                self.assertIn(f"(ModuleKind {module_id} {manifest['kind']})", entry)
                self.assertIn(f'(ModuleVersion {module_id} "{manifest["version"]}")', entry)
                self.assertIn(f'(ModuleEntrypoint {module_id} "{entrypoint}")', entry)
                self.assertIn(f"(ModuleOptional {module_id} {'True' if manifest.get('optional') else 'False'})", entry)

                if "default_enabled" not in manifest:
                    self.fail(f"{module_id} is an installed module but does not declare default_enabled")
                expected = "True" if manifest["default_enabled"] else "False"
                self.assertIn(f"(ModuleDefaultEnabled {module_id} {expected})", entry)

                for provide in manifest.get("provides", []):
                    self.assertIn(expected_provides_atom(module_id, provide), entry)

                for requirement in manifest.get("requires", []):
                    self.assertIn(expected_dependency_atom(module_id, requirement), entry)

                for event in manifest.get("trace", {}).get("writes", []):
                    self.assertIn(f"(TraceWrites {module_id} {event})", entry)

                for name, spec in manifest.get("env", {}).items():
                    if spec.get("runtime_state"):
                        self.assertIn(f"(RuntimeState {module_id} {name} ignored)", entry)

                for key in ("catalog", "signatures"):
                    if manifest.get(key):
                        self.assertIn(manifest[key], entry)
                if (module / "skills.metta").exists():
                    self.assertIn("skills.metta", entry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
