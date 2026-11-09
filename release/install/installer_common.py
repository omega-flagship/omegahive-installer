#!/usr/bin/env python3
"""Interactive OmegaClaw source installer.

This script is intentionally boring: it prepares files, dependencies, and local
configuration. It does not make cognitive choices for OmegaClaw. Module loading
remains visible in modules/loader.metta and runtime secrets stay in .env.
"""

from __future__ import annotations

import argparse
import getpass
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass


PUBLIC_CORE_URL = "https://github.com/physixCN/OmegaClaw-Core.git"
PETTA_URL = "https://github.com/trueagi-io/PeTTa.git"
CHROMA_URL = "https://github.com/patham9/petta_lib_chromadb.git"
FABRICPC_URL = "https://github.com/trueagi-io/FabricPC.git"

BASE_PIP = [
    "sentence-transformers",
    "chromadb",
    "janus-swi",
    "openai",
    "requests",
]

OPTIONAL_PIP = {
    "agentverse": ["uagents"],
    "assume": ["jax", "optax"],
    "channel_mattermost": ["websocket-client"],
    "gameboy": ["pyboy", "pillow"],
}

FORCED_MODULES = {
    "channel_router",
    "scratch_space",
}

CHANNEL_MODULES = {
    "irc": "channel_irc",
    "telegram": "channel_telegram",
    "slack": "channel_slack",
    "mattermost": "channel_mattermost",
    "mock": "channel_mock",
    "whatsapp": "channel_whatsapp",
    "web_control": "channel_web_control",
}

PRIMARY_CHANNEL_CHOICES = [
    "mock",
    "web_control",
    "telegram",
    "irc",
    "mattermost",
    "slack",
    "whatsapp",
]

PROVIDERS = {
    "1": ("OpenRouter", "OPENROUTER_API_KEY", "z-ai/glm-5.1"),
    "2": ("OpenAI", "OPENAI_API_KEY", "gpt-4.1"),
    "3": ("Anthropic", "ANTHROPIC_API_KEY", "claude-opus-4-6"),
    "4": ("ASICloud", "ASI_API_KEY", "minimax"),
    "5": ("ASIOne", "ASIONE_API_KEY", "asi1-mini"),
    "6": ("Ollama-local", "OLLAMA_API_KEY", "qwen3.5:9b"),
}

RUNTIME_CONFIG_KEYS = [
    "maxNewInputLoops",
    "maxWakeLoops",
    "sleepInterval",
    "LLM",
    "provider",
    "maxOutputToken",
    "reasoningMode",
    "wakeupInterval",
    "spamShield",
    "maxPersistentAtomsChars",
    "maxAgendaAtomsChars",
    "maxBeliefAtomsChars",
    "maxWorldAtomsChars",
    "maxEventAtomsChars",
    "maxActivityAtomsChars",
    "maxScratchAtomsChars",
    "maxFeedback",
    "maxRecallItems",
    "maxInputRecallItems",
    "maxSimilarityRecall",
    "maxEpisodeRecallLines",
    "maxEpisodeResultChars",
    "maxHistory",
    "maxHistoryResultChars",
    "maxLastResultsContext",
    "embeddingprovider",
    "promotionInflationFactor",
    "mostPromotedMemories",
    "IRC_channel",
    "IRC_server",
    "IRC_port",
    "IRC_user",
    "commchannel",
    "OMEGACLAW_PRIMARY_CHANNEL",
    "MM_URL",
    "MM_CHANNEL_ID",
    "MM_BOT_TOKEN",
    "TG_BOT_TOKEN",
    "TG_CHAT_ID",
    "TG_POLL_TIMEOUT",
    "OMEGACLAW_AUTH_SECRET",
    "WA_TARGET_JID",
    "WA_PORT",
    "WA_PREFIX",
    "WA_PRIMARY_JID",
    "SL_BOT_TOKEN",
    "SL_CHANNEL_ID",
    "SL_POLL_INTERVAL",
]


@dataclass(frozen=True)
class ModuleInfo:
    name: str
    module_id: str
    kind: str
    default_enabled: bool
    entrypoint: str
    requires: tuple[str, ...]


def run(cmd: list[str], cwd: pathlib.Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    print("$ " + " ".join(cmd))
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=check)


def tool_exists(name: str) -> bool:
    return shutil.which(name) is not None


def ask(prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default is not None else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return default if value == "" and default is not None else value


def yes_no(prompt: str, default: bool = False) -> bool:
    default_label = "Y/n" if default else "y/N"
    while True:
        value = input(f"{prompt} [{default_label}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Please answer yes or no.")


def ask_secret_required(prompt: str, env_name: str) -> str:
    existing = os.environ.get(env_name, "")
    while True:
        suffix = " (leave empty to use existing env)" if existing else ""
        value = getpass.getpass(f"{prompt}{suffix}: ").strip()
        if value:
            return value
        if existing:
            return existing
        print(f"{env_name} is required for this selection. Choose another provider/channel if you do not want to configure it now.")


def ask_agent_name() -> str:
    print("\nAgent identity")
    print("This names the running agent in the local prompt. The framework remains OmegaClaw.")
    while True:
        name = ask("Agent name", "Omega").strip()
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9 _'-]{0,39}", name):
            return " ".join(name.split())
        print("Use 1-40 characters: letters first, then letters/numbers/spaces/_/'/-.")


def require_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Missing required command: {name}")


INSTALLER_BOOTSTRAP_DIRS = {".bootstrap", ".local", ".micromamba"}


def clone_or_update(url: str, path: pathlib.Path) -> None:
    if path.exists():
        if (path / ".git").exists():
            run(["git", "pull", "--ff-only"], cwd=path)
            return
        if any(path.iterdir()):
            raise SystemExit(f"Refusing to overwrite non-git directory: {path}")
        path.rmdir()
    path.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", url, str(path)])


def clone_or_bootstrap_workspace(url: str, path: pathlib.Path) -> None:
    """Clone PeTTa into a workspace that may already hold installer dirs."""

    if path.exists() and (path / ".git").exists():
        run(["git", "pull", "--ff-only"], cwd=path)
        return

    if not path.exists():
        clone_or_update(url, path)
        return

    existing = {item.name for item in path.iterdir()}
    unexpected = sorted(existing - INSTALLER_BOOTSTRAP_DIRS)
    if unexpected:
        names = ", ".join(unexpected)
        raise SystemExit(f"Refusing to overwrite non-git directory: {path} contains {names}")

    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.petta-bootstrap"
    if temp.exists():
        shutil.rmtree(temp)
    run(["git", "clone", url, str(temp)])
    try:
        for item in temp.iterdir():
            target = path / item.name
            if target.exists():
                raise SystemExit(f"Refusing to overwrite existing bootstrap path: {target}")
            shutil.move(str(item), str(target))
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def restore_generated_repo_files(core: pathlib.Path) -> None:
    if not (core / ".git").exists():
        return
    for rel in ["memory/prompt.txt", "modules/loader.metta"]:
        run(["git", "restore", rel], cwd=core, check=False)


def local_dir(workspace: pathlib.Path) -> pathlib.Path:
    path = workspace / "local"
    path.mkdir(parents=True, exist_ok=True)
    return path


def local_loader_path(workspace: pathlib.Path) -> pathlib.Path:
    return local_dir(workspace) / "modules-loader.metta"


def local_prompt_path(workspace: pathlib.Path) -> pathlib.Path:
    return local_dir(workspace) / "prompt.txt"


def local_runtime_config_path(workspace: pathlib.Path) -> pathlib.Path:
    return local_dir(workspace) / "runtime-config.metta"


def parse_env_file(path: pathlib.Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        try:
            parsed = shlex.split(value, posix=True)
            values[key] = parsed[0] if parsed else ""
        except ValueError:
            values[key] = value.strip().strip("'\"")
    return values


def parse_enabled_modules_csv(value: str) -> set[str]:
    return {part.strip() for part in str(value or "").split(",") if part.strip()}


def parse_generated_loader_modules(path: pathlib.Path) -> set[str]:
    if not path.exists():
        return set()
    text = path.read_text(encoding="utf-8", errors="replace")
    if "Generated by install/installer_common.py" not in text:
        return set()
    return set(re.findall(r"\./modules/([^/\s()]+)/entry\.metta", text))


def parse_bool(text: str, key: str, default: bool) -> bool:
    match = re.search(rf"^{re.escape(key)}\s*=\s*(true|false)\s*$", text, re.M)
    return default if not match else match.group(1) == "true"


def parse_string(text: str, key: str, default: str) -> str:
    match = re.search(rf"^{re.escape(key)}\s*=\s*\"([^\"]*)\"\s*$", text, re.M)
    return default if not match else match.group(1)


def parse_requires(text: str) -> tuple[str, ...]:
    match = re.search(r"^requires\s*=\s*\[(.*?)\]", text, re.M | re.S)
    if not match:
        return ()
    return tuple(re.findall(r'"([^"]+)"', match.group(1)))


def discover_modules(core: pathlib.Path) -> dict[str, ModuleInfo]:
    modules: dict[str, ModuleInfo] = {}
    for module_file in sorted((core / "modules").glob("*/module.toml")):
        text = module_file.read_text(encoding="utf-8")
        name = module_file.parent.name
        modules[name] = ModuleInfo(
            name=name,
            module_id=parse_string(text, "id", name),
            kind=parse_string(text, "kind", "module"),
            default_enabled=parse_bool(text, "default_enabled", False),
            entrypoint=parse_string(text, "entrypoint", "entry.metta"),
            requires=parse_requires(text),
        )
    return modules


def choose_provider() -> dict[str, str]:
    print("\nLLM provider")
    for key, (provider, env_name, model) in PROVIDERS.items():
        print(f"  {key}) {provider} ({model})")
    while True:
        choice = ask("Choose provider", "1")
        if choice in PROVIDERS:
            break
        print("Choose 1-6.")
    provider, env_name, model = PROVIDERS[choice]
    model = ask("Model name", model)
    values = {
        "provider": provider,
        "LLM": model,
        "embeddingprovider": "OpenAI" if provider == "OpenAI" else "Local",
    }
    if provider == "Ollama-local":
        values["LLM_SERVER_LOCAL_URL"] = ask("Ollama URL", "http://localhost:11434")
        values[env_name] = os.environ.get(env_name, "ollama-local")
    else:
        values[env_name] = ask_secret_required(env_name, env_name)
    return values


def choose_channel() -> tuple[str, dict[str, str], set[str]]:
    print("\nPrimary channel")
    print("Choose the one channel OmegaClaw should treat as its primary control route.")
    print("Other channel modules stay disabled unless you enable them later.")
    choices = PRIMARY_CHANNEL_CHOICES
    for index, name in enumerate(choices, 1):
        print(f"  {index}) {name}")
    while True:
        raw = ask("Choose primary channel")
        if raw.isdigit() and 1 <= int(raw) <= len(choices):
            channel = choices[int(raw) - 1]
            break
        if raw in choices:
            channel = raw
            break
        print("Choose by number or name.")

    env: dict[str, str] = {
        "commchannel": channel,
        "OMEGACLAW_PRIMARY_CHANNEL": channel,
    }
    enabled = {CHANNEL_MODULES[channel]}
    if channel == "irc":
        env["IRC_channel"] = ask("IRC channel", "##omegaclaw")
    elif channel == "telegram":
        env["TG_BOT_TOKEN"] = ask_secret_required("Telegram bot token", "TG_BOT_TOKEN")
        env["TG_CHAT_ID"] = ask("Telegram chat id; empty enables auto-bind", "")
        env["TG_POLL_TIMEOUT"] = ask("Telegram poll timeout", "20")
    elif channel == "slack":
        env["SL_BOT_TOKEN"] = ask_secret_required("Slack bot token", "SL_BOT_TOKEN")
        env["SL_CHANNEL_ID"] = ask("Slack channel id; empty enables auto-bind", "")
        env["SL_POLL_INTERVAL"] = ask("Slack poll interval", "10")
    elif channel == "mattermost":
        env["MM_URL"] = ask("Mattermost URL", "https://chat.singularitynet.io")
        env["MM_CHANNEL_ID"] = ask("Mattermost channel id")
        env["MM_BOT_TOKEN"] = ask_secret_required("Mattermost bot token", "MM_BOT_TOKEN")
    elif channel == "whatsapp":
        env["WA_PORT"] = ask("WhatsApp bridge port", "3055")
        env["WA_PRIMARY_JID"] = ask("Primary WhatsApp JID; can be set later", "")
        env["WA_TARGET_JID"] = env["WA_PRIMARY_JID"]
    elif channel == "web_control":
        env["OMEGACLAW_AUTH_SECRET"] = ask("Local auth secret", "change-me")
    return channel, env, enabled


def choose_modules(modules: dict[str, ModuleInfo], channel_modules: set[str]) -> set[str]:
    enabled = {
        name
        for name, info in modules.items()
        if info.default_enabled
    } | set(FORCED_MODULES) | set(channel_modules)
    non_primary_channel_modules = set(CHANNEL_MODULES.values()) - set(channel_modules)

    print("\nDefault modules")
    default_names = sorted(name for name in enabled if name in modules)
    if default_names:
        print("Enabled automatically from module defaults:")
        print("  " + ", ".join(default_names))

    print("\nOptional modules")
    for name, info in modules.items():
        if name in enabled:
            continue
        if name in non_primary_channel_modules:
            continue
        prompt = f"Enable optional module {name} ({info.kind})"
        if yes_no(prompt, False):
            enabled.add(name)
    return {name for name in enabled if name in modules}


def enabled_modules_from_config(
    modules: dict[str, ModuleInfo],
    channel: str,
    env_values: dict[str, str] | None = None,
    previous_loader: pathlib.Path | None = None,
) -> set[str]:
    enabled = {
        name
        for name, info in modules.items()
        if info.default_enabled
    } | set(FORCED_MODULES)

    channel_module = CHANNEL_MODULES.get(channel)
    if channel_module:
        enabled.add(channel_module)

    if env_values:
        enabled |= parse_enabled_modules_csv(env_values.get("OMEGACLAW_ENABLED_MODULES", ""))

    if previous_loader is not None:
        enabled |= parse_generated_loader_modules(previous_loader)

    return {name for name in enabled if name in modules}


def validate_enabled_modules(modules: dict[str, ModuleInfo], enabled: set[str], channel: str) -> None:
    missing = [name for name in enabled if name not in modules]
    if missing:
        raise SystemExit("Unknown enabled modules: " + ", ".join(sorted(missing)))

    required = {
        name
        for name, info in modules.items()
        if info.default_enabled
    } | set(FORCED_MODULES)
    channel_module = CHANNEL_MODULES.get(channel)
    if channel_module:
        required.add(channel_module)

    absent = sorted(name for name in required if name not in enabled)
    if absent:
        raise SystemExit("Invalid module selection; required modules missing: " + ", ".join(absent))


def quote_env(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def write_env(workspace: pathlib.Path, values: dict[str, str]) -> pathlib.Path:
    env_path = workspace / ".env"
    auth_secret = values.get("OMEGACLAW_AUTH_SECRET") or os.urandom(18).hex()
    values["OMEGACLAW_AUTH_SECRET"] = auth_secret
    lines = ["# Local OmegaClaw runtime configuration. Do not commit this file."]
    for key in sorted(values):
        lines.append(f"{key}={quote_env(values[key])}")
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        env_path.chmod(0o600)
    except OSError:
        pass
    return env_path


def write_channel_instructions(workspace: pathlib.Path, channel: str, values: dict[str, str]) -> list[pathlib.Path]:
    paths: list[pathlib.Path] = []
    if channel == "telegram":
        auth_secret = values.get("OMEGACLAW_AUTH_SECRET", "").strip()
        if auth_secret:
            auth_path = workspace / "telegram-auth-command.txt"
            auth_path.write_text(
                "Send this one-time message to your Telegram bot to bind this chat:\n\n"
                f"/auth {auth_secret}\n\n"
                "After the bot confirms authentication, normal messages from that chat will reach OmegaClaw.\n",
                encoding="utf-8",
            )
            try:
                auth_path.chmod(0o600)
            except OSError:
                pass
            paths.append(auth_path)
    return paths


def write_loader(workspace: pathlib.Path, modules: dict[str, ModuleInfo], enabled: set[str]) -> pathlib.Path:
    loader = local_loader_path(workspace)
    lines = [
        "; Enabled modules for this OmegaClaw deployment.",
        "; Generated by install/installer_common.py. Re-run the installer to change this list.",
        "; Module identity, skills, signatures, risks, effects, and trace remain declared in each module.",
    ]
    for name in sorted(enabled):
        info = modules[name]
        lines.append(f"!(import! &self (library OmegaClaw-Core ./modules/{name}/{info.entrypoint}))")
    loader.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return loader


_METTA_SYMBOL_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


def _metta_string(value: str) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def metta_config_expr(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return '""'
    if re.fullmatch(r"-?\d+(?:\.\d+)?", text):
        return text
    if text.lower() == "true":
        return "True"
    if text.lower() == "false":
        return "False"
    if _METTA_SYMBOL_RE.match(text):
        return text
    return _metta_string(text)


def write_runtime_config(workspace: pathlib.Path, values: dict[str, str]) -> pathlib.Path:
    config = local_runtime_config_path(workspace)
    lines = [
        "; Workspace-local runtime config overlay.",
        "; Generated by install/installer_common.py. Do not commit this file.",
        "; It removes imported default config stubs so init-time configure atoms have one value.",
    ]
    for key in RUNTIME_CONFIG_KEYS:
        lines.append(f"!(collapse (match &self (= ({key}) $old) (remove-atom &self (= ({key}) $old))))")

    # provider and LLM are read directly by the loop; most other runtime values
    # are resolved by existing `(configure ...)` calls from environment.
    for key in ["provider", "LLM"]:
        if values.get(key):
            lines.append(f"(= ({key}) {metta_config_expr(values[key])})")

    config.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return config


def write_root_run(workspace: pathlib.Path) -> None:
    (workspace / "run.metta").write_text(
        textwrap.dedent(
            f"""
            !(import! &self (library lib_import))
            !(git-import! "{PUBLIC_CORE_URL}")
            !(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw_core))))
            !(import! &self ./local/modules-loader.metta)
            !(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw_attention))))
            !(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/loop))))
            !(import! &self ./local/runtime-config.metta)

            !(omegaclaw)
            """
        ).lstrip(),
        encoding="utf-8",
    )


def write_agent_prompt(workspace: pathlib.Path, core: pathlib.Path, agent_name: str) -> pathlib.Path:
    prompt_path = local_prompt_path(workspace)
    result = subprocess.run(
        ["git", "show", "HEAD:memory/prompt.txt"],
        cwd=str(core),
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        text = result.stdout
    else:
        source_prompt = core / "memory" / "prompt.txt"
        text = source_prompt.read_text(encoding="utf-8")
    # Replace the default agent name only as a standalone word. OmegaClaw remains
    # the framework name and should not be rewritten.
    text = re.sub(r"\bOmega\b", agent_name, text)
    prompt_path.write_text(text, encoding="utf-8")
    return prompt_path


def write_start_scripts(workspace: pathlib.Path) -> list[pathlib.Path]:
    start_sh = workspace / "start-omegaclaw.sh"
    start_sh.write_text(
        textwrap.dedent(
            """
            #!/usr/bin/env bash
            set -euo pipefail
            cd "$(dirname "$0")"
            if [ -f .env ]; then
              set -a
              . ./.env
              set +a
            fi
            LOCAL_PREFIX="$PWD/.micromamba/envs/omegaclaw"
            LOCAL_TOOLCHAIN="$LOCAL_PREFIX/bin"
            if [ -d "$LOCAL_TOOLCHAIN" ]; then
              export MAMBA_ROOT_PREFIX="$PWD/.micromamba"
              export PATH="$LOCAL_TOOLCHAIN:$PATH"
              export DYLD_FALLBACK_LIBRARY_PATH="$LOCAL_PREFIX/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
            fi
            if [ -x .venv/bin/python ]; then
              export OMEGACLAW_PYTHON_EXECUTABLE="$PWD/.venv/bin/python"
            elif [ -x "$LOCAL_TOOLCHAIN/python" ]; then
              export OMEGACLAW_PYTHON_EXECUTABLE="$LOCAL_TOOLCHAIN/python"
            fi
            if [ -f .venv/bin/activate ]; then
              . ./.venv/bin/activate
            fi
            if [ -d .venv/lib/python3.11/site-packages ]; then
              export PYTHONPATH="$PWD/.venv/lib/python3.11/site-packages${PYTHONPATH:+:$PYTHONPATH}"
            fi
            if [ -d repos/OmegaClaw-Core/src ]; then
              export PYTHONPATH="$PWD/repos/OmegaClaw-Core/src${PYTHONPATH:+:$PYTHONPATH}"
            fi
            if [ -f repos/OmegaClaw-Core/install/doctor.py ]; then
              "$OMEGACLAW_PYTHON_EXECUTABLE" repos/OmegaClaw-Core/install/doctor.py --workspace "$PWD" --startup-check
            fi
            mkdir -p logs
            LOG_FILE="${OMEGACLAW_LOG_FILE:-$PWD/logs/omegaclaw-$(date +%Y%m%d-%H%M%S).log}"
            echo "OmegaClaw log: $LOG_FILE"
            echo "OmegaClaw supervisor active. Press Ctrl-C or close this window to stop." | tee -a "$LOG_FILE"
            stop_requested=0
            child_pid=""
            stop_supervisor() {
              stop_requested=1
              echo "OmegaClaw supervisor stopping by user request." | tee -a "$LOG_FILE"
              if [ -n "${child_pid:-}" ]; then
                if command -v pkill >/dev/null 2>&1; then
                  pkill -TERM -P "$child_pid" 2>/dev/null || true
                fi
                kill "$child_pid" 2>/dev/null || true
                wait "$child_pid" 2>/dev/null || true
              fi
              exit 0
            }
            trap stop_supervisor INT TERM
            while true; do
              set +e
              ./run.sh run.metta "$@" > >(tee -a "$LOG_FILE") 2>&1 &
              child_pid="$!"
              wait "$child_pid"
              status="$?"
              child_pid=""
              set -e
              if [ "$stop_requested" -eq 1 ]; then
                echo "OmegaClaw supervisor stopped." | tee -a "$LOG_FILE"
                exit 0
              fi
              echo "OmegaClaw SWI runtime exited with status $status; supervisor restarting runtime." | tee -a "$LOG_FILE"
              sleep "${OMEGACLAW_RESTART_DELAY:-2}"
            done
            """
        ).lstrip(),
        encoding="utf-8",
    )
    start_sh.chmod(0o755)

    start_command = workspace / "Start OmegaClaw.command"
    start_command.write_text(
        textwrap.dedent(
            """
            #!/bin/sh
            DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
            exec "$DIR/start-omegaclaw.sh" "$@"
            """
        ).lstrip(),
        encoding="utf-8",
    )
    start_command.chmod(0o755)

    launchers = [start_command]
    if sys.platform == "darwin":
        desktop = pathlib.Path.home() / "Desktop"
        if desktop.is_dir():
            desktop_command = desktop / "Start OmegaClaw.command"
            desktop_command.write_text(
                textwrap.dedent(
                    f"""
                    #!/bin/sh
                    exec {shlex.quote(str(start_command))} "$@"
                    """
                ).lstrip(),
                encoding="utf-8",
            )
            desktop_command.chmod(0o755)
            launchers.append(desktop_command)

    return launchers


def pip_install(workspace: pathlib.Path, enabled: set[str]) -> None:
    python = workspace / ".venv" / "bin" / "python"
    if not python.exists():
        run([sys.executable, "-m", "venv", str(workspace / ".venv")])
    packages = list(BASE_PIP)
    for module in sorted(enabled):
        packages.extend(OPTIONAL_PIP.get(module, []))
    run([str(python), "-m", "pip", "install", "--upgrade", "pip"])
    run([str(python), "-m", "pip", "install", *packages])


def install_system_deps(enabled: set[str]) -> None:
    packages: list[str] = []
    if "omega_vm" in enabled:
        packages.extend(["qemu", "busybox"] if sys.platform == "darwin" else ["qemu-system-aarch64", "busybox"])
    if "vm_policy" in enabled and sys.platform != "darwin":
        packages.extend(["nftables", "ufw"])

    if not packages:
        return

    deduped = list(dict.fromkeys(packages))
    if sys.platform == "darwin" and tool_exists("brew"):
        print("\nInstalling selected module system dependencies with Homebrew...")
        for package in deduped:
            if subprocess.run(["brew", "list", package], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                continue
            run(["brew", "install", package])
    elif sys.platform.startswith("linux") and tool_exists("apt-get"):
        print("\nInstalling selected module system dependencies with apt...")
        sudo = ["sudo"] if os.geteuid() != 0 and tool_exists("sudo") else []
        run([*sudo, "apt-get", "update"])
        run([*sudo, "apt-get", "install", "-y", *deduped])
    else:
        print("\nModule system dependencies were selected but no supported package manager was found:")
        print("  " + ", ".join(deduped))
        print("Install these packages manually before using the selected modules.")


def install_node_deps(core: pathlib.Path, enabled: set[str]) -> None:
    if not ({"channel_whatsapp", "codex_code"} & enabled):
        return
    require_tool("npm")
    if "channel_whatsapp" in enabled:
        bridge = core / "modules" / "channel_whatsapp" / "src" / "whatsapp_bridge"
        if (bridge / "package.json").exists():
            run(["npm", "install"], cwd=bridge)
    if "codex_code" in enabled:
        run(["npm", "install", "-g", "@openai/codex@0.133.0"])


def install_fabricpc(workspace: pathlib.Path, enabled: set[str], env_values: dict[str, str]) -> None:
    if "assume" not in enabled:
        return
    fabric = workspace / "repos" / "FabricPC"
    clone_or_update(FABRICPC_URL, fabric)
    python = workspace / ".venv" / "bin" / "python"
    run([str(python), "-m", "pip", "install", "-e", str(fabric)])
    env_values["FABRICPC_REPO"] = str(fabric)
    env_values["FABRICPC_PYTHON"] = str(python)


def prepare_workspace(workspace: pathlib.Path, repo_url: str) -> pathlib.Path:
    require_tool("git")
    clone_or_bootstrap_workspace(PETTA_URL, workspace)
    repos = workspace / "repos"
    restore_generated_repo_files(repos / "OmegaClaw-Core")
    clone_or_update(repo_url, repos / "OmegaClaw-Core")
    clone_or_update(CHROMA_URL, repos / "petta_lib_chromadb")
    write_root_run(workspace)
    return repos / "OmegaClaw-Core"


def repair_install(workspace: pathlib.Path, repo_url: str) -> int:
    workspace = workspace.expanduser().resolve()
    print(f"OmegaClaw repair workspace: {workspace}")
    env_path = workspace / ".env"
    env_values = parse_env_file(env_path)
    if not env_values:
        raise SystemExit(f"No existing install config found at {env_path}; run the interactive installer first.")

    previous_loader = workspace / "repos" / "OmegaClaw-Core" / "modules" / "loader.metta"
    core = prepare_workspace(workspace, repo_url)
    write_root_run(workspace)
    modules = discover_modules(core)
    channel = env_values.get("commchannel") or env_values.get("OMEGACLAW_PRIMARY_CHANNEL") or "mock"
    if env_values.get("OMEGACLAW_PRIMARY_CHANNEL") != channel:
        print(
            "Repair normalized OMEGACLAW_PRIMARY_CHANNEL to match commchannel "
            f"({channel})."
        )
        env_values["OMEGACLAW_PRIMARY_CHANNEL"] = channel
    enabled = enabled_modules_from_config(modules, channel, env_values, previous_loader)
    validate_enabled_modules(modules, enabled, channel)

    agent_name = env_values.get("OMEGACLAW_AGENT_NAME", "Omega")
    env_values["OMEGACLAW_AGENT_NAME"] = agent_name
    env_values["OMEGACLAW_ENABLED_MODULES"] = ",".join(sorted(enabled))
    env_values["OMEGACLAW_MODULE_LOADER"] = str(local_loader_path(workspace))
    env_values["OMEGACLAW_PROMPT_FILE"] = str(local_prompt_path(workspace))

    write_loader(workspace, modules, enabled)
    write_runtime_config(workspace, env_values)
    write_agent_prompt(workspace, core, agent_name)
    write_env(workspace, env_values)
    write_channel_instructions(workspace, channel, env_values)
    write_start_scripts(workspace)

    print("OmegaClaw repair complete.")
    print(f"Config: {env_path}")
    print(f"Modules: {local_loader_path(workspace)}")
    print(f"Runtime config: {local_runtime_config_path(workspace)}")
    print(f"Prompt: {local_prompt_path(workspace)}")
    print(f"Start script: {workspace / 'start-omegaclaw.sh'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Install OmegaClaw from source.")
    parser.add_argument("--workspace", default=str(pathlib.Path.home() / "OmegaClaw"))
    parser.add_argument("--repo-url", default=PUBLIC_CORE_URL)
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--repair", action="store_true", help="Repair an existing install from saved .env without re-asking setup questions.")
    args = parser.parse_args()

    workspace = pathlib.Path(args.workspace).expanduser().resolve()
    if args.repair:
        return repair_install(workspace, args.repo_url)

    if args.non_interactive:
        raise SystemExit("Non-interactive install is not implemented yet; use the interactive installer.")

    print(f"OmegaClaw workspace: {workspace}")
    core = prepare_workspace(workspace, args.repo_url)
    modules = discover_modules(core)

    agent_name = ask_agent_name()
    provider_env = choose_provider()
    channel, channel_env, channel_modules = choose_channel()
    enabled = choose_modules(modules, channel_modules)
    enabled |= FORCED_MODULES
    enabled.add(CHANNEL_MODULES[channel])
    validate_enabled_modules(modules, enabled, channel)

    env_values = {
        **provider_env,
        **channel_env,
        "OMEGACLAW_AGENT_NAME": agent_name,
        "OMEGACLAW_ENABLED_MODULES": ",".join(sorted(enabled)),
        "OMEGACLAW_MODULE_LOADER": str(local_loader_path(workspace)),
        "OMEGACLAW_PROMPT_FILE": str(local_prompt_path(workspace)),
    }
    install_system_deps(enabled)
    pip_install(workspace, enabled)
    install_fabricpc(workspace, enabled, env_values)
    install_node_deps(core, enabled)
    loader_path = write_loader(workspace, modules, enabled)
    runtime_config_path = write_runtime_config(workspace, env_values)
    prompt_path = write_agent_prompt(workspace, core, agent_name)
    env_path = write_env(workspace, env_values)
    instruction_paths = write_channel_instructions(workspace, channel, env_values)
    launchers = write_start_scripts(workspace)

    print("\nOmegaClaw install complete.")
    print(f"Config: {env_path}")
    print(f"Modules: {loader_path}")
    print(f"Runtime config: {runtime_config_path}")
    print(f"Prompt: {prompt_path}")
    print(f"Start script: {workspace / 'start-omegaclaw.sh'}")
    for launcher in launchers:
        print(f"Launcher: {launcher}")
    for instruction_path in instruction_paths:
        print(f"Channel setup instruction: {instruction_path}")
    print("Auth secret: generated and saved in .env; value not displayed")
    print("Run again later with the generated Start OmegaClaw launcher; it will reuse .env.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
