#!/usr/bin/env python3
"""Tests for the proposed OmegaClaw module contract."""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tomllib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
OMEGACLAW_ROOT = ROOT.parents[1]
HAS_METTA_RUNNER = (OMEGACLAW_ROOT / "run.sh").exists()
FIXTURE = ROOT / "tests" / "fixtures" / "modules" / "whatsapp_channel"
ECHO_FIXTURE = ROOT / "tests" / "fixtures" / "modules" / "echo_channel"
OS_FIXTURE = ROOT / "tests" / "fixtures" / "modules" / "omega_os_surface"
GAME_FIXTURE = ROOT / "tests" / "fixtures" / "modules" / "metta_maze_game"
MODULE_FIXTURES = ROOT / "tests" / "fixtures" / "modules"


def module_fixtures():
    return sorted(path.parent for path in MODULE_FIXTURES.glob("*/module.toml"))


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


class OmegaClawModuleContractTests(unittest.TestCase):
    def test_manifest_declares_boring_package_boundary(self):
        manifest = tomllib.loads((FIXTURE / "module.toml").read_text(encoding="utf-8"))

        self.assertEqual(manifest["id"], "omegaclaw.channel.whatsapp")
        self.assertEqual(manifest["kind"], "channel")
        self.assertEqual(manifest["entrypoint"], "entry.metta")
        self.assertTrue(manifest["optional"])
        self.assertIn("channel:whatsapp", manifest["provides"])
        self.assertIn("skill:send-channel", manifest["provides"])
        self.assertIn("node>=20", manifest["requires"])
        self.assertTrue(manifest["env"]["OMEGACLAW_WA_AUTH_DIR"]["runtime_state"])
        self.assertIn("ChannelMessageReceived", manifest["trace"]["writes"])

    def test_entrypoint_declares_cognitive_contract_in_metta(self):
        entry = (FIXTURE / "entry.metta").read_text(encoding="utf-8")

        required_atoms = [
            "(Module omegaclaw.channel.whatsapp)",
            "(ModuleKind omegaclaw.channel.whatsapp channel)",
            "(Channel whatsapp)",
            "(Provides omegaclaw.channel.whatsapp (Skill send-channel))",
            "(ChannelCapability whatsapp file-send)",
            "(RuntimeDependency omegaclaw.channel.whatsapp node \">=20\")",
            "(RuntimeState omegaclaw.channel.whatsapp OMEGACLAW_WA_AUTH_DIR ignored)",
            "(TraceWrites omegaclaw.channel.whatsapp ChannelMessageReceived)",
        ]
        for atom in required_atoms:
            with self.subTest(atom=atom):
                self.assertIn(atom, entry)

    def test_module_contract_smoke_is_isolated_and_queryable(self):
        result = run_module_smoke("tests/module_contract_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_contract_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.channel.whatsapp", result.stdout)
        self.assertIn("file-send", result.stdout)
        self.assertIn("ChannelMessageReceived", result.stdout)

    def test_membrane_can_wrap_different_internals_behind_same_surface(self):
        whatsapp = (FIXTURE / "entry.metta").read_text(encoding="utf-8")
        echo = (ECHO_FIXTURE / "entry.metta").read_text(encoding="utf-8")

        self.assertIn("(ModuleImplementation omegaclaw.channel.whatsapp node-bridge)", whatsapp)
        self.assertIn("(ModuleImplementation openclaw.channel.echo opaque-executable)", echo)
        self.assertIn("(Provides omegaclaw.channel.whatsapp (Skill send-channel))", whatsapp)
        self.assertIn("(Provides openclaw.channel.echo (Skill send-channel))", echo)

        result = run_module_smoke("tests/module_membrane_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_membrane_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("omegaclaw.channel.whatsapp", result.stdout)
        self.assertIn("openclaw.channel.echo", result.stdout)
        self.assertIn("node-bridge", result.stdout)
        self.assertIn("opaque-executable", result.stdout)
        self.assertIn("ChannelMessageSent", result.stdout)

    def test_large_modules_can_be_worlds_not_only_skills(self):
        os_entry = (OS_FIXTURE / "entry.metta").read_text(encoding="utf-8")
        game_entry = (GAME_FIXTURE / "entry.metta").read_text(encoding="utf-8")

        self.assertIn("(ModuleKind omegaclaw.os.omega-surface operating-surface)", os_entry)
        self.assertIn("(Provides omegaclaw.os.omega-surface (Surface omega-os))", os_entry)
        self.assertIn("(SurfaceCapability omega-os live-mind-map)", os_entry)
        self.assertIn("(ModuleKind openclaw.game.metta-maze simulation)", game_entry)
        self.assertIn("(Provides openclaw.game.metta-maze (Simulation metta-maze))", game_entry)
        self.assertIn("(SimulationCapability metta-maze action-feedback)", game_entry)

        result = run_module_smoke("tests/module_worlds_smoke.metta")

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolated\ttests/module_worlds_smoke.metta", result.stdout)
        if not HAS_METTA_RUNNER:
            return
        self.assertIn("operating-surface", result.stdout)
        self.assertIn("simulation", result.stdout)
        self.assertIn("SurfaceProvider omegaclaw.os.omega-surface omega-os", result.stdout)
        self.assertIn("SimulationProvider openclaw.game.metta-maze metta-maze", result.stdout)
        self.assertIn("open-window", result.stdout)
        self.assertIn("act-in-game", result.stdout)
        self.assertIn("UIEvent", result.stdout)
        self.assertIn("GameStateObserved", result.stdout)

    def test_module_manifests_match_entrypoint_atoms(self):
        for fixture in module_fixtures():
            with self.subTest(module=fixture.name):
                manifest = tomllib.loads((fixture / "module.toml").read_text(encoding="utf-8"))
                module_id = manifest["id"]
                entrypoint = manifest.get("entrypoint", "entry.metta")
                entry = (fixture / entrypoint).read_text(encoding="utf-8")

                self.assertIn(f"(Module {module_id})", entry)
                self.assertIn(f"(ModuleKind {module_id} {manifest['kind']})", entry)
                self.assertIn(f'(ModuleVersion {module_id} "{manifest["version"]}")', entry)
                self.assertIn(f'(ModuleEntrypoint {module_id} "{entrypoint}")', entry)
                self.assertIn(f"(ModuleOptional {module_id} {'True' if manifest.get('optional') else 'False'})", entry)

                for provide in manifest.get("provides", []):
                    self.assertIn(expected_provides_atom(module_id, provide), entry)

                for requirement in manifest.get("requires", []):
                    self.assertIn(expected_dependency_atom(module_id, requirement), entry)

                for event in manifest.get("trace", {}).get("writes", []):
                    self.assertIn(f"(TraceWrites {module_id} {event})", entry)

                for name, spec in manifest.get("env", {}).items():
                    if spec.get("runtime_state"):
                        self.assertIn(f"(RuntimeState {module_id} {name} ignored)", entry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
