#!/usr/bin/env python3
"""Installer sanity checks.

These tests avoid running package managers or cloning repositories. They protect
the public install contract: local clone startup, module loader generation, and
launcher files that do not embed private deployment state.
"""

import re
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def assert_ordered(testcase, text, *needles):
    offset = -1
    for needle in needles:
        found = text.find(needle)
        testcase.assertGreater(found, offset, f"{needle!r} should appear after the previous composition element")
        offset = found


def load_installer_common():
    path = ROOT / "install" / "installer_common.py"
    spec = importlib.util.spec_from_file_location("installer_common", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_doctor():
    install_dir = str(ROOT / "install")
    if install_dir not in sys.path:
        sys.path.insert(0, install_dir)
    path = ROOT / "install" / "doctor.py"
    spec = importlib.util.spec_from_file_location("doctor", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class InstallerTests(unittest.TestCase):
    def test_public_run_file_registers_public_local_clone(self):
        run_metta = (ROOT / "run.metta").read_text(encoding="utf-8")
        self.assertIn("https://github.com/physixCN/OmegaClaw-Core.git", run_metta)
        self.assertIn("git-import!", run_metta)
        self.assertIn("(library OmegaClaw-Core lib_omegaclaw)", run_metta)
        self.assertNotIn("lib_omegaclaw_no_agentverse", run_metta)
        self.assertNotIn("https://github.com/asi-alliance/OmegaClaw-Core.git", run_metta)

    def test_core_substrate_defers_loop_until_modules_are_loaded(self):
        core = (ROOT / "lib_omegaclaw_core.metta").read_text(encoding="utf-8")
        full = (ROOT / "lib_omegaclaw.metta").read_text(encoding="utf-8")
        self.assertNotIn("./src/loop", core)
        self.assertNotIn("./modules/loader.metta", core)
        self.assertIn("./src/memory", core)
        assert_ordered(
            self,
            full,
            "lib_omegaclaw_core",
            "./modules/loader.metta",
            "lib_omegaclaw_attention",
            "./src/loop",
        )

    def test_installer_discovers_modules_and_writes_workspace_local_loader(self):
        installer = load_installer_common()
        modules = installer.discover_modules(ROOT)
        self.assertIn("channel_router", modules)
        self.assertIn("scratch_space", modules)
        self.assertIn("web_search", modules)
        self.assertEqual(modules["channel_router"].entrypoint, "entry.metta")

        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            path = installer.write_loader(
                workspace,
                modules,
                {"channel_router", "scratch_space", "web_search"},
            )
            self.assertEqual(path, workspace / "local" / "modules-loader.metta")
            text = path.read_text(encoding="utf-8")
            self.assertIn("./modules/channel_router/entry.metta", text)
            self.assertIn("./modules/scratch_space/entry.metta", text)
            self.assertIn("./modules/web_search/entry.metta", text)
            self.assertNotIn("Jon", text)
            self.assertFalse((workspace / "repos" / "OmegaClaw-Core" / "modules" / "loader.metta").exists())

    def test_install_docs_explain_saved_configuration(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        install_readme = (ROOT / "install" / "README.md").read_text(encoding="utf-8")
        for text in [readme, install_readme]:
            self.assertIn("modules/loader.metta", text)
            self.assertIn("local/modules-loader.metta", text)
            self.assertIn("local/runtime-config.metta", text)
            self.assertIn(".env", text)
            self.assertIn("default_enabled", text)
            self.assertIn("agent name", text.lower())
            self.assertIn("provider", text.lower())
            self.assertIn("channel", text.lower())

    def test_metta_configure_reads_environment_without_exposing_secrets_as_argv(self):
        utils = (ROOT / "src" / "utils.metta").read_text(encoding="utf-8")
        helper = (ROOT / "src" / "helper_metta.py").read_text(encoding="utf-8")
        self.assertIn("helper.config_assignment_atom", utils)
        self.assertNotIn("(let $value (argk $name $default)", utils)
        self.assertIn("def config_assignment_atom", helper)
        self.assertIn("os.environ.get(key)", helper)
        self.assertIn("sys.argv[1:]", helper)
        self.assertNotIn("(atom_to_number $Value)", utils)

    def test_required_secret_reprompts_unless_existing_env_is_available(self):
        installer = load_installer_common()
        original_getpass = installer.getpass.getpass
        original_env = os.environ.get("OMEGA_TEST_SECRET")
        try:
            os.environ["OMEGA_TEST_SECRET"] = "from-env"
            installer.getpass.getpass = lambda prompt: ""
            self.assertEqual(installer.ask_secret_required("Secret", "OMEGA_TEST_SECRET"), "from-env")

            os.environ.pop("OMEGA_TEST_SECRET", None)
            answers = iter(["", "fresh-secret"])
            installer.getpass.getpass = lambda prompt: next(answers)
            self.assertEqual(installer.ask_secret_required("Secret", "OMEGA_TEST_SECRET"), "fresh-secret")
        finally:
            installer.getpass.getpass = original_getpass
            if original_env is None:
                os.environ.pop("OMEGA_TEST_SECRET", None)
            else:
                os.environ["OMEGA_TEST_SECRET"] = original_env

    def test_telegram_install_writes_local_auth_command_file(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            values = {"OMEGACLAW_AUTH_SECRET": "secret-token"}
            paths = installer.write_channel_instructions(workspace, "telegram", values)
            self.assertEqual(paths, [workspace / "telegram-auth-command.txt"])
            text = paths[0].read_text(encoding="utf-8")
            self.assertIn("/auth secret-token", text)
            self.assertIn("Telegram bot", text)

    def test_non_telegram_install_does_not_write_auth_command_file(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            paths = installer.write_channel_instructions(
                workspace,
                "web_control",
                {"OMEGACLAW_AUTH_SECRET": "secret-token"},
            )
            self.assertEqual(paths, [])
            self.assertFalse((workspace / "telegram-auth-command.txt").exists())

    def test_module_defaults_separate_core_from_device_heavy_modules(self):
        installer = load_installer_common()
        modules = installer.discover_modules(ROOT)
        for name in ["assume", "channel_router", "scratch_space", "web_search"]:
            self.assertTrue(modules[name].default_enabled, name)
        for name in [
            "agentverse",
            "channel_mattermost",
            "channel_telegram",
            "channel_whatsapp",
            "codex_code",
            "gameboy",
            "health_glucose",
            "omega_vm",
            "vm_policy",
        ]:
            self.assertFalse(modules[name].default_enabled, name)

    def test_installer_enables_default_modules_and_asks_only_for_optional(self):
        installer = load_installer_common()
        modules = {
            "channel_router": installer.ModuleInfo("channel_router", "channel_router", "channel", True, "entry.metta", ()),
            "scratch_space": installer.ModuleInfo("scratch_space", "scratch_space", "core", True, "entry.metta", ()),
            "web_search": installer.ModuleInfo("web_search", "web_search", "channel", True, "entry.metta", ()),
            "channel_whatsapp": installer.ModuleInfo("channel_whatsapp", "channel_whatsapp", "channel", False, "entry.metta", ()),
            "channel_telegram": installer.ModuleInfo("channel_telegram", "channel_telegram", "channel", False, "entry.metta", ()),
            "agentverse": installer.ModuleInfo("agentverse", "agentverse", "remote", False, "entry.metta", ()),
        }
        asked = []
        original_yes_no = installer.yes_no
        try:
            def fake_yes_no(prompt, default=False):
                asked.append((prompt, default))
                return "agentverse" in prompt

            installer.yes_no = fake_yes_no
            enabled = installer.choose_modules(modules, {"channel_telegram"})
        finally:
            installer.yes_no = original_yes_no

        self.assertIn("channel_router", enabled)
        self.assertIn("scratch_space", enabled)
        self.assertIn("web_search", enabled)
        self.assertIn("channel_telegram", enabled)
        self.assertNotIn("channel_whatsapp", enabled)
        self.assertIn("agentverse", enabled)
        self.assertEqual(asked, [("Enable optional module agentverse (remote)", False)])

    def test_windows_wrapper_leaves_optional_system_deps_to_shared_installer(self):
        script = (ROOT / "install" / "windows" / "Install-OmegaClaw.ps1").read_text(encoding="utf-8")
        base_install_line = next(line for line in script.splitlines() if line.startswith("sudo apt-get install -y"))
        for required in ["git", "python3", "swi-prolog", "nodejs", "npm", "build-essential"]:
            self.assertIn(required, base_install_line)
        for optional in ["qemu-system-aarch64", "busybox", "nftables", "ufw"]:
            self.assertNotIn(optional, base_install_line)


    def test_macos_installer_has_no_admin_local_toolchain_fallback(self):
        script = (ROOT / "install" / "macos" / "Install OmegaClaw.command").read_text(encoding="utf-8")
        self.assertIn("install_local_toolchain", script)
        self.assertIn("micro.mamba.pm/api/micromamba", script)
        self.assertIn('SWI_VERSION="10.0.2"', script)
        self.assertIn('SWI_BUILD="1"', script)
        self.assertIn("swipl-${SWI_VERSION}-${SWI_BUILD}.fat.dmg", script)
        self.assertIn("install_swi_prolog_app", script)
        self.assertIn("repair_swi_janus_linkage", script)
        self.assertIn("install_name_tool -change", script)
        self.assertIn("libpython3.11.dylib", script)
        self.assertIn("verify_toolchain_versions", script)
        self.assertIn("nodejs>=20,<27", script)
        self.assertIn("SWI-Prolog must be >=10.0", script)
        self.assertIn("current_predicate(py_call/3)", script)
        self.assertIn("SWI-Prolog Janus must embed Python 3.11.x", script)
        self.assertIn("No administrator password is required", script)
        self.assertIn("~/OmegaClaw/.micromamba", (ROOT / "README.md").read_text(encoding="utf-8"))
        self.assertIn("without sudo", (ROOT / "install" / "README.md").read_text(encoding="utf-8"))
        self.assertIn("Node.js >=20", (ROOT / "README.md").read_text(encoding="utf-8"))
        self.assertIn("SWI-Prolog 10.0.2-1", (ROOT / "README.md").read_text(encoding="utf-8"))
        self.assertNotIn("swi-prolog nodejs", script)
        self.assertNotIn("brew install", script)
        self.assertNotIn("raw.githubusercontent.com/Homebrew/install", script)
        self.assertNotIn("NONINTERACTIVE=1", script)


    def test_primary_channel_choice_is_explicit_and_records_primary_route(self):
        installer = load_installer_common()
        answers = iter(["telegram", "", "20"])
        original_ask = installer.ask
        original_getpass = installer.getpass.getpass
        try:
            installer.ask = lambda prompt, default=None: next(answers)
            installer.getpass.getpass = lambda prompt: "telegram-token"
            channel, env, enabled = installer.choose_channel()
        finally:
            installer.ask = original_ask
            installer.getpass.getpass = original_getpass

        self.assertEqual(channel, "telegram")
        self.assertEqual(env["commchannel"], "telegram")
        self.assertEqual(env["OMEGACLAW_PRIMARY_CHANNEL"], "telegram")
        self.assertEqual(env["TG_BOT_TOKEN"], "telegram-token")
        self.assertEqual(enabled, {"channel_telegram"})

    def test_whatsapp_is_not_the_installer_default_primary_channel(self):
        installer = load_installer_common()
        self.assertIn("whatsapp", installer.PRIMARY_CHANNEL_CHOICES)
        self.assertNotEqual(installer.PRIMARY_CHANNEL_CHOICES[0], "whatsapp")

    def test_installer_does_not_print_generated_auth_secret(self):
        source = (ROOT / "install" / "installer_common.py").read_text(encoding="utf-8")
        self.assertNotIn("Auth secret: {", source)
        self.assertIn("value not displayed", source)

    def test_doctor_requires_selected_provider_credential(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            core = workspace / "repos" / "OmegaClaw-Core"
            core.mkdir(parents=True)
            (core / ".git").mkdir()
            (core / "src").mkdir()
            (core / "src" / "loop.metta").write_text(
                "(change-state! &loops 0)\n(println! (CHARS_SENT: (string_length $send)))\n",
                encoding="utf-8",
            )
            (workspace / ".env").write_text(
                "provider='OpenRouter'\ncommchannel='telegram'\nOMEGACLAW_PRIMARY_CHANNEL='telegram'\n"
                "TG_BOT_TOKEN='telegram-token'\nOMEGACLAW_PROMPT_FILE='{}'\n".format(workspace / "local" / "prompt.txt"),
                encoding="utf-8",
            )
            (workspace / "run.metta").write_text(
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_core))\n"
                "!(import! &self ./local/modules-loader.metta)\n"
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_attention))\n"
                "!(import! &self (library OmegaClaw-Core ./src/loop))\n"
                "!(omegaclaw)\n",
                encoding="utf-8",
            )
            (workspace / "local").mkdir()
            (workspace / "local" / "modules-loader.metta").write_text(
                "!(import! &self (library OmegaClaw-Core ./modules/channel_router/entry.metta))\n"
                "!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/entry.metta))\n",
                encoding="utf-8",
            )
            (workspace / "local" / "prompt.txt").write_text("You are Omega.\n", encoding="utf-8")
            (workspace / "start-omegaclaw.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (workspace / "Start OmegaClaw.command").write_text("#!/bin/sh\n", encoding="utf-8")

            ok, rows = doctor.diagnose(workspace)

        self.assertFalse(ok)
        self.assertTrue(
            any(label == "LLM provider credential" and status == "FAIL" for status, label, _ in rows),
            rows,
        )

    def test_petta_bootstrap_allows_installer_owned_toolchain_dirs(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            (workspace / ".micromamba").mkdir(parents=True)
            (workspace / ".bootstrap").mkdir()
            (workspace / ".local").mkdir()

            original_run = installer.run
            try:
                def fake_run(cmd, cwd=None, check=True):
                    self.assertEqual(cmd[:3], ["git", "clone", installer.PETTA_URL])
                    clone_path = pathlib.Path(cmd[3])
                    (clone_path / ".git").mkdir(parents=True)
                    (clone_path / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
                    (clone_path / "src").mkdir()

                installer.run = fake_run
                installer.clone_or_bootstrap_workspace(installer.PETTA_URL, workspace)
            finally:
                installer.run = original_run

            self.assertTrue((workspace / ".git").exists())
            self.assertTrue((workspace / "run.sh").exists())
            self.assertTrue((workspace / ".micromamba").exists())
            self.assertTrue((workspace / ".bootstrap").exists())
            self.assertTrue((workspace / ".local").exists())

    def test_petta_bootstrap_rejects_unknown_non_git_workspace_content(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            workspace.mkdir()
            (workspace / "notes.txt").write_text("not installer-owned\n", encoding="utf-8")
            with self.assertRaises(SystemExit) as raised:
                installer.clone_or_bootstrap_workspace(installer.PETTA_URL, workspace)
            self.assertIn("notes.txt", str(raised.exception))


    def test_start_script_loads_user_local_macos_toolchain(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            launchers = installer.write_start_scripts(workspace)
            start = (workspace / "start-omegaclaw.sh").read_text(encoding="utf-8")
            launcher = workspace / "Start OmegaClaw.command"
            self.assertIn(".micromamba/envs/omegaclaw", start)
            self.assertIn("MAMBA_ROOT_PREFIX", start)
            self.assertIn("PATH=\"$LOCAL_TOOLCHAIN:$PATH\"", start)
            self.assertIn("DYLD_FALLBACK_LIBRARY_PATH", start)
            self.assertIn("OMEGACLAW_PYTHON_EXECUTABLE", start)
            self.assertIn(".venv/lib/python3.11/site-packages", start)
            self.assertIn("repos/OmegaClaw-Core/src", start)
            self.assertIn("PYTHONPATH", start)
            self.assertIn("install/doctor.py", start)
            self.assertIn("--startup-check", start)
            self.assertNotIn("--quiet", start)
            self.assertIn("OmegaClaw log:", start)
            self.assertIn("tee -a", start)
            self.assertIn("while true; do", start)
            self.assertIn("OmegaClaw supervisor active. Press Ctrl-C or close this window to stop.", start)
            self.assertIn("stop_supervisor()", start)
            self.assertIn("trap stop_supervisor INT TERM", start)
            self.assertIn("child_pid", start)
            self.assertIn("OmegaClaw SWI runtime exited with status $status; supervisor restarting runtime.", start)
            self.assertIn("OMEGACLAW_RESTART_DELAY", start)
            self.assertNotIn("not auto-restarting", start)
            self.assertNotIn("--silent", start)
            self.assertIn(launcher, launchers)
            self.assertIn("start-omegaclaw.sh", launcher.read_text(encoding="utf-8"))

    def test_installed_run_registers_local_clone_with_git_import(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            installer.write_root_run(workspace)
            text = (workspace / "run.metta").read_text(encoding="utf-8")
            self.assertIn("git-import!", text)
            self.assertIn(installer.PUBLIC_CORE_URL, text)
            self.assertIn("./local/modules-loader.metta", text)
            self.assertIn("./local/runtime-config.metta", text)
            self.assertIn("(library OmegaClaw-Core lib_omegaclaw_core)", text)
            assert_ordered(
                self,
                text,
                "lib_omegaclaw_core",
                "./local/modules-loader.metta",
                "lib_omegaclaw_attention",
                "./src/loop",
                "./local/runtime-config.metta",
                "(omegaclaw)",
            )
            self.assertNotIn("lib_omegaclaw_body", text)

    def test_installer_writes_local_runtime_config_without_secrets(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            path = installer.write_runtime_config(
                workspace,
                {
                    "provider": "Ollama-local",
                    "LLM": "z-ai/glm-5.1",
                    "TG_BOT_TOKEN": "super-secret-token",
                    "OMEGACLAW_AUTH_SECRET": "super-secret-auth",
                },
            )
            self.assertEqual(path, workspace / "local" / "runtime-config.metta")
            text = path.read_text(encoding="utf-8")
            self.assertIn("(remove-atom &self (= (provider) $old))", text)
            self.assertIn("(remove-atom &self (= (commchannel) $old))", text)
            self.assertIn("(= (provider) Ollama-local)", text)
            self.assertIn('(= (LLM) "z-ai/glm-5.1")', text)
            self.assertNotIn("super-secret-token", text)
            self.assertNotIn("super-secret-auth", text)

    def test_repo_run_registers_public_local_clone(self):
        text = (ROOT / "run.metta").read_text(encoding="utf-8")
        self.assertIn("git-import!", text)
        self.assertIn("https://github.com/physixCN/OmegaClaw-Core.git", text)
        self.assertIn("(library OmegaClaw-Core lib_omegaclaw)", text)
        self.assertNotIn("lib_omegaclaw_no_agentverse", text)
        self.assertNotIn("lib_omegaclaw_body", text)

    def test_macos_installer_writes_desktop_launcher_when_desktop_exists(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            workspace = home / "OmegaClaw"
            desktop = home / "Desktop"
            workspace.mkdir()
            desktop.mkdir()

            original_platform = installer.sys.platform
            original_home = os.environ.get("HOME")
            try:
                installer.sys.platform = "darwin"
                os.environ["HOME"] = str(home)
                launchers = installer.write_start_scripts(workspace)
            finally:
                installer.sys.platform = original_platform
                if original_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = original_home

            desktop_launcher = desktop / "Start OmegaClaw.command"
            self.assertIn(desktop_launcher, launchers)
            self.assertTrue(desktop_launcher.exists())
            self.assertIn(str(workspace / "Start OmegaClaw.command"), desktop_launcher.read_text(encoding="utf-8"))


    def test_installer_personalizes_agent_name_without_renaming_framework(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            fake_core = pathlib.Path(tmp)
            (fake_core / "memory").mkdir()
            (fake_core / "memory" / "prompt.txt").write_text(
                "You are Omega, an OmegaClaw agent. Omega remembers.\n",
                encoding="utf-8",
            )
            prompt_path = installer.write_agent_prompt(workspace=pathlib.Path(tmp), core=fake_core, agent_name="Ada")
            text = prompt_path.read_text(encoding="utf-8")
            self.assertIn("You are Ada", text)
            self.assertIn("OmegaClaw agent", text)
            self.assertIn("Ada remembers", text)
            self.assertNotIn("AdaClaw", text)
            self.assertEqual(prompt_path, pathlib.Path(tmp) / "local" / "prompt.txt")
            self.assertIn("You are Omega", (fake_core / "memory" / "prompt.txt").read_text(encoding="utf-8"))

    def test_repair_preserves_saved_config_and_rewrites_generated_runtime_files(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            core = workspace / "repos" / "OmegaClaw-Core"
            core.mkdir(parents=True)
            (core / ".git").mkdir()
            (core / "memory").mkdir()
            (core / "memory" / "prompt.txt").write_text("You are Omega.\n", encoding="utf-8")
            (core / "modules").mkdir()
            for name in ["channel_router", "scratch_space", "web_search", "channel_telegram"]:
                module = core / "modules" / name
                module.mkdir()
                (module / "module.toml").write_text(
                    f'id = "{name}"\nkind = "module"\nentrypoint = "entry.metta"\ndefault_enabled = {"true" if name in {"channel_router", "scratch_space", "web_search"} else "false"}\n',
                    encoding="utf-8",
                )
            (core / "modules" / "loader.metta").write_text(
                "; Generated by install/installer_common.py. Re-run the installer to change this list.\n"
                "!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/entry.metta))\n",
                encoding="utf-8",
            )
            (workspace / ".env").write_text(
                "commchannel='telegram'\nOMEGACLAW_PRIMARY_CHANNEL='telegram'\nTG_BOT_TOKEN='token'\nOMEGACLAW_AGENT_NAME='Ada'\n",
                encoding="utf-8",
            )

            calls = []
            original_prepare = installer.prepare_workspace
            original_write_start = installer.write_start_scripts
            try:
                installer.prepare_workspace = lambda ws, repo_url: core
                installer.write_start_scripts = lambda ws: calls.append(("start", ws)) or []
                result = installer.repair_install(workspace, installer.PUBLIC_CORE_URL)
            finally:
                installer.prepare_workspace = original_prepare
                installer.write_start_scripts = original_write_start

            self.assertEqual(result, 0)
            env = installer.parse_env_file(workspace / ".env")
            self.assertEqual(env["commchannel"], "telegram")
            self.assertEqual(pathlib.Path(env["OMEGACLAW_PROMPT_FILE"]).resolve(), (workspace / "local" / "prompt.txt").resolve())
            self.assertIn("channel_telegram", env["OMEGACLAW_ENABLED_MODULES"])
            resolved_workspace = workspace.resolve()
            self.assertIn("./local/modules-loader.metta", (resolved_workspace / "run.metta").read_text(encoding="utf-8"))
            self.assertIn("./local/runtime-config.metta", (resolved_workspace / "run.metta").read_text(encoding="utf-8"))
            self.assertIn("channel_telegram", (resolved_workspace / "local" / "modules-loader.metta").read_text(encoding="utf-8"))
            self.assertTrue((resolved_workspace / "local" / "runtime-config.metta").exists())
            self.assertIn("You are Ada", (resolved_workspace / "local" / "prompt.txt").read_text(encoding="utf-8"))

    def test_repair_normalizes_stale_primary_channel_to_commchannel(self):
        installer = load_installer_common()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            core = workspace / "repos" / "OmegaClaw-Core"
            core.mkdir(parents=True)
            (core / ".git").mkdir()
            (core / "memory").mkdir()
            (core / "memory" / "prompt.txt").write_text("You are Omega.\n", encoding="utf-8")
            (core / "modules").mkdir()
            for name in ["channel_router", "scratch_space", "web_search", "channel_telegram", "channel_whatsapp"]:
                module = core / "modules" / name
                module.mkdir()
                (module / "module.toml").write_text(
                    f'id = "{name}"\nkind = "module"\nentrypoint = "entry.metta"\ndefault_enabled = {"true" if name in {"channel_router", "scratch_space", "web_search"} else "false"}\n',
                    encoding="utf-8",
                )
            (workspace / ".env").write_text(
                "commchannel='telegram'\nOMEGACLAW_PRIMARY_CHANNEL='whatsapp'\nTG_BOT_TOKEN='token'\n",
                encoding="utf-8",
            )

            original_prepare = installer.prepare_workspace
            original_write_start = installer.write_start_scripts
            try:
                installer.prepare_workspace = lambda ws, repo_url: core
                installer.write_start_scripts = lambda ws: []
                result = installer.repair_install(workspace, installer.PUBLIC_CORE_URL)
            finally:
                installer.prepare_workspace = original_prepare
                installer.write_start_scripts = original_write_start

            self.assertEqual(result, 0)
            env = installer.parse_env_file(workspace / ".env")
            self.assertEqual(env["commchannel"], "telegram")
            self.assertEqual(env["OMEGACLAW_PRIMARY_CHANNEL"], "telegram")
            self.assertIn("channel_telegram", env["OMEGACLAW_ENABLED_MODULES"])

    def test_doctor_accepts_repaired_workspace_contract(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            core = workspace / "repos" / "OmegaClaw-Core"
            (core / ".git").mkdir(parents=True)
            (core / "src").mkdir()
            (core / "src" / "loop.metta").write_text(
                "(change-state! &loops 0)\n(println! (CHARS_SENT: (string_length $send)))\n",
                encoding="utf-8",
            )
            (workspace / "local").mkdir()
            (workspace / "local" / "modules-loader.metta").write_text(
                "!(import! &self (library OmegaClaw-Core ./modules/channel_router/entry.metta))\n"
                "!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/entry.metta))\n",
                encoding="utf-8",
            )
            (workspace / "local" / "prompt.txt").write_text("You are Ada.\n", encoding="utf-8")
            (workspace / "local" / "runtime-config.metta").write_text("(= (provider) OpenRouter)\n", encoding="utf-8")
            (workspace / "run.metta").write_text(
                '!(git-import! "https://github.com/physixCN/OmegaClaw-Core.git")\n'
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_core))\n"
                "!(import! &self ./local/modules-loader.metta)\n"
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_attention))\n"
                "!(import! &self (library OmegaClaw-Core ./src/loop))\n"
                "!(import! &self ./local/runtime-config.metta)\n"
                "!(omegaclaw)\n",
                encoding="utf-8",
            )
            (workspace / "start-omegaclaw.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (workspace / "Start OmegaClaw.command").write_text("#!/bin/sh\n", encoding="utf-8")
            prompt_path = workspace / "local" / "prompt.txt"
            (workspace / ".env").write_text(
                f"provider='OpenRouter'\nOPENROUTER_API_KEY='key'\n"
                f"commchannel='telegram'\nOMEGACLAW_PRIMARY_CHANNEL='telegram'\nTG_BOT_TOKEN='token'\nOMEGACLAW_PROMPT_FILE='{prompt_path}'\n",
                encoding="utf-8",
            )
            ok, rows = doctor.diagnose(workspace)
            self.assertTrue(ok, rows)

    def test_doctor_startup_check_rejects_broken_janus_bridge(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            core = workspace / "repos" / "OmegaClaw-Core"
            (core / ".git").mkdir(parents=True)
            (core / "src").mkdir()
            (core / "src" / "loop.metta").write_text(
                "(change-state! &loops 0)\n",
                encoding="utf-8",
            )
            (workspace / "local").mkdir()
            (workspace / "local" / "modules-loader.metta").write_text(
                "!(import! &self (library OmegaClaw-Core ./modules/channel_router/entry.metta))\n",
                encoding="utf-8",
            )
            prompt_path = workspace / "local" / "prompt.txt"
            prompt_path.write_text("You are Ada.\n", encoding="utf-8")
            (workspace / "run.metta").write_text(
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_core))\n"
                "!(import! &self ./local/modules-loader.metta)\n"
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_attention))\n"
                "!(import! &self (library OmegaClaw-Core ./src/loop))\n"
                "!(omegaclaw)\n",
                encoding="utf-8",
            )
            (workspace / "start-omegaclaw.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (workspace / "Start OmegaClaw.command").write_text("#!/bin/sh\n", encoding="utf-8")
            (workspace / ".env").write_text(
                f"commchannel='mock'\nOMEGACLAW_PRIMARY_CHANNEL='mock'\nOMEGACLAW_PROMPT_FILE='{prompt_path}'\n",
                encoding="utf-8",
            )

            original = doctor._janus_smoke
            try:
                doctor._janus_smoke = lambda: (False, "Janus native library could not load its Python runtime")
                ok, rows = doctor.diagnose(workspace, check_runtime=True)
            finally:
                doctor._janus_smoke = original

            self.assertFalse(ok)
            joined = "\n".join(str(row) for row in rows)
            self.assertIn("SWI-Prolog Janus bridge", joined)
            self.assertIn("rerun the macOS installer", joined)

    def test_doctor_rejects_loader_before_core_composition(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            core = workspace / "repos" / "OmegaClaw-Core"
            (core / ".git").mkdir(parents=True)
            (core / "src").mkdir()
            (core / "src" / "loop.metta").write_text(
                "(change-state! &loops 0)\n(println! (CHARS_SENT: (string_length $send)))\n",
                encoding="utf-8",
            )
            (workspace / "local").mkdir()
            (workspace / "local" / "modules-loader.metta").write_text(
                "!(import! &self (library OmegaClaw-Core ./modules/channel_router/entry.metta))\n"
                "!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/entry.metta))\n",
                encoding="utf-8",
            )
            (workspace / "local" / "prompt.txt").write_text("You are Ada.\n", encoding="utf-8")
            (workspace / "run.metta").write_text(
                '!(git-import! "https://github.com/physixCN/OmegaClaw-Core.git")\n'
                "!(import! &self ./local/modules-loader.metta)\n"
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_core))\n"
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_attention))\n"
                "!(import! &self (library OmegaClaw-Core ./src/loop))\n"
                "!(omegaclaw)\n",
                encoding="utf-8",
            )
            (workspace / "start-omegaclaw.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (workspace / "Start OmegaClaw.command").write_text("#!/bin/sh\n", encoding="utf-8")
            prompt_path = workspace / "local" / "prompt.txt"
            (workspace / ".env").write_text(
                f"commchannel='telegram'\nOMEGACLAW_PRIMARY_CHANNEL='telegram'\nTG_BOT_TOKEN='token'\nOMEGACLAW_PROMPT_FILE='{prompt_path}'\n",
                encoding="utf-8",
            )

            ok, rows = doctor.diagnose(workspace)

            self.assertFalse(ok, rows)
            self.assertTrue(any(label == "composition order" and status == "FAIL" for status, label, _ in rows), rows)

    def test_doctor_rejects_stale_primary_channel_mismatch(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            core = workspace / "repos" / "OmegaClaw-Core"
            (core / ".git").mkdir(parents=True)
            (core / "src").mkdir()
            (core / "src" / "loop.metta").write_text(
                "(change-state! &loops 0)\n(println! (CHARS_SENT: (string_length $send)))\n",
                encoding="utf-8",
            )
            (workspace / "local").mkdir()
            (workspace / "local" / "modules-loader.metta").write_text(
                "!(import! &self (library OmegaClaw-Core ./modules/channel_router/entry.metta))\n"
                "!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/entry.metta))\n",
                encoding="utf-8",
            )
            (workspace / "local" / "prompt.txt").write_text("You are Ada.\n", encoding="utf-8")
            (workspace / "run.metta").write_text(
                '!(git-import! "https://github.com/physixCN/OmegaClaw-Core.git")\n'
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_core))\n"
                "!(import! &self ./local/modules-loader.metta)\n"
                "!(import! &self (library OmegaClaw-Core lib_omegaclaw_attention))\n"
                "!(import! &self (library OmegaClaw-Core ./src/loop))\n"
                "!(omegaclaw)\n",
                encoding="utf-8",
            )
            (workspace / "start-omegaclaw.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (workspace / "Start OmegaClaw.command").write_text("#!/bin/sh\n", encoding="utf-8")
            prompt_path = workspace / "local" / "prompt.txt"
            (workspace / ".env").write_text(
                f"commchannel='telegram'\nOMEGACLAW_PRIMARY_CHANNEL='whatsapp'\nTG_BOT_TOKEN='token'\nOMEGACLAW_PROMPT_FILE='{prompt_path}'\n",
                encoding="utf-8",
            )

            ok, rows = doctor.diagnose(workspace)

            self.assertFalse(ok, rows)
            self.assertTrue(any(label == "channel config consistency" and status == "FAIL" for status, label, _ in rows), rows)

    def test_telegram_probe_reports_webhook_and_auth_decision_without_message_body(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            workspace.mkdir()
            (workspace / ".env").write_text(
                "TG_BOT_TOKEN='token'\nOMEGACLAW_AUTH_SECRET='secret'\n",
                encoding="utf-8",
            )

            def fake_api(token, method, params=None, timeout=10):
                self.assertEqual(token, "token")
                if method == "getMe":
                    return True, {"username": "OmegaTestBot", "id": 123}
                if method == "getWebhookInfo":
                    return True, {"url": "", "pending_update_count": 0}
                if method == "getUpdates":
                    self.assertEqual(json.loads(params["allowed_updates"]), ["message", "edited_message", "channel_post", "edited_channel_post"])
                    return True, [
                        {"update_id": 42, "message": {"chat": {"id": 999, "type": "private"}, "text": "/auth secret"}},
                        {"update_id": 43, "message": {"chat": {"id": 999, "type": "private"}, "text": "private body should not print"}},
                    ]
                return False, "unexpected"

            original_api = doctor._telegram_api
            try:
                doctor._telegram_api = fake_api
                ok, rows = doctor.telegram_probe(workspace)
            finally:
                doctor._telegram_api = original_api

            rendered = "\n".join(detail for _, _, detail in rows)
            self.assertTrue(ok, rows)
            self.assertIn("would-auth-bind", rendered)
            self.assertIn("would-ignore-auth-required", rendered)
            self.assertNotIn("private body should not print", rendered)
            self.assertNotIn("/auth secret", rendered)

    def test_telegram_probe_flags_active_webhook_as_polling_blocker(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp) / "OmegaClaw"
            workspace.mkdir()
            (workspace / ".env").write_text("TG_BOT_TOKEN='token'\n", encoding="utf-8")

            def fake_api(token, method, params=None, timeout=10):
                if method == "getMe":
                    return True, {"username": "OmegaTestBot", "id": 123}
                if method == "getWebhookInfo":
                    return True, {"url": "https://example.invalid/webhook", "pending_update_count": 2}
                if method == "getUpdates":
                    return False, "Conflict: webhook active"
                return False, "unexpected"

            original_api = doctor._telegram_api
            try:
                doctor._telegram_api = fake_api
                ok, rows = doctor.telegram_probe(workspace)
            finally:
                doctor._telegram_api = original_api

            self.assertFalse(ok, rows)
            self.assertTrue(any(label == "Telegram webhook" and status == "FAIL" for status, label, _ in rows), rows)

    def test_public_prompt_has_no_private_operator_names(self):
        # The real names to guard against stay in local configuration, never in the repo (the same variables as the
        # UI's noRealPeople guard): OMEGA_PRIVATE_OWNER_NAMES and OMEGA_PRIVATE_FAMILY_NAMES, comma-separated.
        prompt = (ROOT / "memory" / "prompt.txt").read_text(encoding="utf-8")
        self.assertNotRegex(prompt, r"\bDad\b")
        private_names = [n.strip() for var in ("OMEGA_PRIVATE_OWNER_NAMES", "OMEGA_PRIVATE_FAMILY_NAMES")
                         for n in os.environ.get(var, "").split(",") if n.strip()]
        for private_name in private_names:
            self.assertNotRegex(prompt, rf"\b{re.escape(private_name)}\b")


if __name__ == "__main__":
    unittest.main()
