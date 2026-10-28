import importlib.util
import os
import pathlib
import shutil
import tempfile
import tomllib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE = ROOT / "modules" / "home_assistant" / "bridge" / "home_assistant.py"


def load_module():
    spec = importlib.util.spec_from_file_location("home_assistant_module_test", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HomeAssistantModuleTests(unittest.TestCase):
    def test_installed_module_is_invisible_until_loader_imports_it(self):
        from src import helper_command_parser as parser

        old_root = parser.MODULE_DECLARATIONS_ROOT
        with tempfile.TemporaryDirectory() as tmpdir:
            modules = pathlib.Path(tmpdir) / "modules"
            installed = modules / "home_assistant"
            installed.parent.mkdir(parents=True)
            shutil.copytree(ROOT / "modules" / "home_assistant", installed)
            (modules / "loader.metta").write_text("", encoding="utf-8")
            try:
                parser.MODULE_DECLARATIONS_ROOT = modules
                signatures = "\n".join(path.read_text(encoding="utf-8") for path in parser.signature_declaration_paths())
                catalog = parser.skill_catalog()
                affordance_paths = parser._module_declaration_paths("affordance.metta")
            finally:
                parser.MODULE_DECLARATIONS_ROOT = old_root

        self.assertNotIn("observe-house", signatures)
        self.assertNotIn("Home Assistant body app", catalog)
        self.assertEqual(affordance_paths, [])

    def test_module_files_contribute_cards_only_when_enabled(self):
        from src import helper_command_parser as parser

        old_root = parser.MODULE_DECLARATIONS_ROOT
        with tempfile.TemporaryDirectory() as tmpdir:
            modules = pathlib.Path(tmpdir) / "modules"
            enabled = modules / "home_assistant"
            enabled.parent.mkdir(parents=True)
            shutil.copytree(ROOT / "modules" / "home_assistant", enabled)
            (modules / "loader.metta").write_text(
                '!(import! &self (library OmegaClaw-Core ./modules/home_assistant/entry.metta))\n',
                encoding="utf-8",
            )
            try:
                parser.MODULE_DECLARATIONS_ROOT = modules
                signatures = "\n".join(path.read_text(encoding="utf-8") for path in parser.signature_declaration_paths())
                catalog = parser.skill_catalog()
                affordance_paths = parser._module_declaration_paths("affordance.metta")
            finally:
                parser.MODULE_DECLARATIONS_ROOT = old_root

        self.assertIn("observe-house", signatures)
        self.assertIn("use-house-affordance", signatures)
        self.assertIn("Home Assistant body app", catalog)
        self.assertEqual(len(affordance_paths), 1)

    def test_module_declares_standard_trace_contract(self):
        module_toml = tomllib.loads((ROOT / "modules" / "home_assistant" / "module.toml").read_text(encoding="utf-8"))
        entry = (ROOT / "modules" / "home_assistant" / "entry.metta").read_text(encoding="utf-8")

        self.assertIn("python>=3.10", module_toml["requires"])
        self.assertIn("home-assistant:long-lived-access-token", module_toml["requires"])
        self.assertTrue(module_toml["env"]["HOME_ASSISTANT_TOKEN"]["secret"])
        self.assertEqual(module_toml["env"]["OMEGACLAW_HA_TRACE"]["default"], "0")
        self.assertFalse(module_toml["trace"]["default_enabled"])
        self.assertIn("HouseActionTrace", module_toml["trace"]["writes"])
        self.assertIn("(RuntimeConfig omegaclaw.app.home-assistant OMEGACLAW_HA_TRACE \"optional-default-off\")", entry)
        self.assertIn("(TraceAvailable omegaclaw.app.home-assistant HouseActionTrace)", entry)
        self.assertIn("(TraceWrites omegaclaw.app.home-assistant HouseActionTrace)", entry)

    def test_action_returns_compact_summary_and_skips_full_trace_by_default(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ.pop("OMEGACLAW_HA_TRACE", None)
            module.ACTION_LOG = pathlib.Path(tmpdir) / "actions.jsonl"
            state_before = {
                "entity_id": "light.test",
                "state": "off",
                "attributes": {
                    "friendly_name": "Test Light",
                    "supported_color_modes": ["color_temp"],
                    "min_color_temp_kelvin": 2000,
                    "max_color_temp_kelvin": 6500,
                },
            }
            state_after = {
                "entity_id": "light.test",
                "state": "on",
                "attributes": {
                    "friendly_name": "Test Light",
                    "brightness": 180,
                    "color_temp_kelvin": 2700,
                    "supported_color_modes": ["color_temp"],
                },
            }

            module._states = lambda: [state_before]
            module._area_entities = lambda target: []
            module._resolve_entity = lambda target, states=None: ("light.test", state_before)

            def fake_request(method, path, payload=None, timeout=10):
                if method == "POST":
                    self.assertEqual(path, "/api/services/light/turn_on")
                    self.assertEqual(payload["color_temp_kelvin"], 2700)
                    return [{"changed": True}]
                if method == "GET":
                    return state_after
                raise AssertionError((method, path, payload))

            module._request = fake_request
            result = module.use_house_affordance("set-color-temperature", "light.test", "warm 2700K")

            self.assertIn("HOUSE-AFFORDANCE-USED", result)
            self.assertIn("trace_id", result)
            self.assertIn("changed_count", result)
            self.assertNotIn('"before"', result)
            self.assertNotIn('"after"', result)
            self.assertFalse(module.ACTION_LOG.exists())

    def test_action_trace_can_be_enabled(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["OMEGACLAW_HA_TRACE"] = "1"
            module.ACTION_LOG = pathlib.Path(tmpdir) / "actions.jsonl"
            state_before = {
                "entity_id": "light.test",
                "state": "off",
                "attributes": {
                    "friendly_name": "Test Light",
                    "supported_color_modes": ["color_temp"],
                    "min_color_temp_kelvin": 2000,
                    "max_color_temp_kelvin": 6500,
                },
            }
            state_after = {
                "entity_id": "light.test",
                "state": "on",
                "attributes": {
                    "friendly_name": "Test Light",
                    "brightness": 180,
                    "color_temp_kelvin": 2700,
                    "supported_color_modes": ["color_temp"],
                },
            }

            module._states = lambda: [state_before]
            module._area_entities = lambda target: []
            module._resolve_entity = lambda target, states=None: ("light.test", state_before)

            def fake_request(method, path, payload=None, timeout=10):
                if method == "POST":
                    return [{"changed": True}]
                if method == "GET":
                    return state_after
                raise AssertionError((method, path, payload))

            module._request = fake_request
            result = module.use_house_affordance("set-color-temperature", "light.test", "warm 2700K")

            self.assertIn("HOUSE-AFFORDANCE-USED", result)

            trace = module.ACTION_LOG.read_text(encoding="utf-8")
            self.assertIn('"before"', trace)
            self.assertIn('"after"', trace)
            self.assertIn('"color_temp_kelvin": 2700', trace)
            os.environ.pop("OMEGACLAW_HA_TRACE", None)

    def test_room_observation_is_compact(self):
        module = load_module()
        module._area_entities = lambda room: ["light.test"]
        module._states = lambda: [{
            "entity_id": "light.test",
            "state": "on",
            "attributes": {
                "friendly_name": "Test Light",
                "brightness": 100,
                "supported_color_modes": ["color_temp", "rgb"],
                "supported_features": 44,
                "min_color_temp_kelvin": 2000,
                "max_color_temp_kelvin": 6500,
            },
        }]
        result = module.observe_room("Test")
        self.assertIn("ROOM-OBSERVATION", result)
        self.assertIn("brightness", result)
        self.assertNotIn("supported_color_modes", result)
        self.assertNotIn("supported_features", result)

    def test_house_observation_is_bounded_summary_not_device_dump(self):
        module = load_module()
        states = []
        for index in range(25):
            states.append({
                "entity_id": f"light.test_{index}",
                "state": "on",
                "attributes": {
                    "friendly_name": f"Test Light {index}",
                    "brightness": 128,
                    "supported_color_modes": ["rgbw", "color_temp"],
                    "supported_features": 4,
                },
                "last_changed": "2026-05-27T00:00:00+00:00",
                "last_updated": "2026-05-27T00:00:00+00:00",
            })
        module._states = lambda: states

        result = module.observe_house()

        self.assertTrue(result.startswith("HOUSE-OBSERVATION "))
        self.assertIn('"active_count": 25', result)
        self.assertIn('"omitted_active": 9', result)
        self.assertIn('"active_sample"', result)
        self.assertNotIn("last_changed", result)
        self.assertNotIn("supported_color_modes", result)


if __name__ == "__main__":
    unittest.main()
