#!/usr/bin/env python3
"""OmegaClaw install/runtime doctor.

This is deployment plumbing, not cognition. It checks that the local workspace
composition matches the saved config before the MeTTa loop starts.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

try:
    import installer_common
except Exception:  # pragma: no cover - direct execution fallback
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    import installer_common


def _run_text(cmd: list[str], cwd: pathlib.Path | None = None, timeout: int = 8) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        return completed.returncode, completed.stdout.strip()
    except Exception as exc:
        return 1, f"{type(exc).__name__}: {exc}"


def _check(condition: bool, label: str, ok: str, bad: str, rows: list[tuple[str, str, str]]) -> bool:
    rows.append(("OK" if condition else "FAIL", label, ok if condition else bad))
    return condition


def _contains_module(loader_text: str, module: str) -> bool:
    return f"./modules/{module}/entry.metta" in loader_text


def _ordered(text: str, *needles: str) -> bool:
    offset = -1
    for needle in needles:
        found = text.find(needle)
        if found <= offset:
            return False
        offset = found
    return True


def _janus_smoke() -> tuple[bool, str]:
    rc, output = _run_text(
        [
            "swipl",
            "-q",
            "-g",
            "use_module(library(janus)),current_predicate(py_call/3),py_call(sys:version,V,[py_string_as(string)]),writeln(V),halt.",
        ],
        timeout=15,
    )
    if rc != 0:
        detail = output.splitlines()[-1] if output else "swipl Janus smoke failed"
        if "Library not loaded" in output:
            detail = "Janus native library could not load its Python runtime"
        return False, detail
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    version = lines[-1] if lines else ""
    if not version.startswith("3.11."):
        return False, f"Janus must embed Python 3.11.x; got {version or 'no version output'}"
    return True, f"Python {version.split()[0]}"


def _provider_required_env(provider: str) -> str:
    return {
        "OpenRouter": "OPENROUTER_API_KEY",
        "OpenAI": "OPENAI_API_KEY",
        "Anthropic": "ANTHROPIC_API_KEY",
        "ASICloud": "ASI_API_KEY",
        "ASIOne": "ASIONE_API_KEY",
        "Ollama-local": "OLLAMA_API_KEY",
        "Test": "TEST_SERVER_IP",
    }.get(provider, "")


def diagnose(workspace: pathlib.Path, include_remote: bool = False, check_runtime: bool = False) -> tuple[bool, list[tuple[str, str, str]]]:
    workspace = workspace.expanduser().resolve()
    core = workspace / "repos" / "OmegaClaw-Core"
    env_path = workspace / ".env"
    run_path = workspace / "run.metta"
    launcher_path = workspace / "Start OmegaClaw.command"
    start_path = workspace / "start-omegaclaw.sh"
    loader_path = workspace / "local" / "modules-loader.metta"
    runtime_config_path = workspace / "local" / "runtime-config.metta"
    prompt_path = workspace / "local" / "prompt.txt"

    rows: list[tuple[str, str, str]] = []
    ok = True

    env = installer_common.parse_env_file(env_path)
    commchannel = env.get("commchannel", "")
    primary_channel = env.get("OMEGACLAW_PRIMARY_CHANNEL", "")
    channel = commchannel or primary_channel or ""
    provider = env.get("provider", "")
    expected_channel_module = installer_common.CHANNEL_MODULES.get(channel, "")

    ok &= _check(core.exists() and (core / ".git").exists(), "core clone", str(core), "missing Git clone", rows)
    if core.exists() and (core / ".git").exists():
        rc, head = _run_text(["git", "rev-parse", "--short", "HEAD"], cwd=core)
        rows.append(("INFO" if rc == 0 else "WARN", "core commit", head or "unknown"))
        if include_remote:
            rc, remote = _run_text(["git", "ls-remote", "https://github.com/physixCN/OmegaClaw-Core.git", "HEAD"])
            rows.append(("INFO" if rc == 0 else "WARN", "public HEAD", remote.split()[0][:12] if remote else "unavailable"))

    ok &= _check(env_path.exists(), ".env", str(env_path), "missing install config", rows)
    ok &= _check(bool(provider), "LLM provider", provider or "<none>", "provider unset", rows)
    required_env = _provider_required_env(provider)
    if provider:
        if required_env:
            ok &= _check(
                bool(env.get(required_env)),
                "LLM provider credential",
                f"{required_env}=configured",
                f"{provider} requires {required_env}; rerun installer repair or edit .env",
                rows,
            )
        else:
            ok &= _check(False, "LLM provider credential", "", f"unknown provider {provider}", rows)
    ok &= _check(bool(channel), "primary channel", channel or "<none>", "commchannel/OMEGACLAW_PRIMARY_CHANNEL unset", rows)
    ok &= _check(
        not (commchannel and primary_channel and commchannel != primary_channel),
        "channel config consistency",
        f"commchannel={commchannel or '<unset>'}",
        f"commchannel={commchannel} but OMEGACLAW_PRIMARY_CHANNEL={primary_channel}",
        rows,
    )
    ok &= _check(run_path.exists(), "root run.metta", str(run_path), "missing root run.metta", rows)
    if run_path.exists():
        run_text = run_path.read_text(encoding="utf-8", errors="replace")
        ok &= _check("./local/modules-loader.metta" in run_text, "root module loader", "workspace-local loader imported", "root run.metta does not import ./local/modules-loader.metta", rows)
        core_imported = "lib_omegaclaw_core" in run_text or "lib_omegaclaw" in run_text
        ok &= _check(core_imported, "root core import", "core substrate imported", "core substrate import missing", rows)
        if "lib_omegaclaw_core" in run_text:
            order_needles = ("lib_omegaclaw_core", "./local/modules-loader.metta", "lib_omegaclaw_attention", "./src/loop", "./local/runtime-config.metta", "(omegaclaw)")
        else:
            order_needles = ("lib_omegaclaw", "(omegaclaw)")
        ok &= _check(
            _ordered(run_text, *order_needles),
            "composition order",
            "core -> local modules -> attention -> loop -> local runtime config -> start",
            "root run.metta must import core before local modules, attention before loop, local runtime config after loop, and start loop last",
            rows,
        )
        ok &= _check("lib_omegaclaw_body" not in run_text, "old body loader", "not imported by generated root", "generated root still imports old body loader path", rows)

    ok &= _check(loader_path.exists(), "local module loader", str(loader_path), "missing local/modules-loader.metta", rows)
    ok &= _check(runtime_config_path.exists(), "local runtime config", str(runtime_config_path), "missing local/runtime-config.metta", rows)
    if loader_path.exists():
        loader_text = loader_path.read_text(encoding="utf-8", errors="replace")
        ok &= _check(_contains_module(loader_text, "channel_router"), "channel router", "enabled", "channel_router missing", rows)
        if expected_channel_module:
            ok &= _check(_contains_module(loader_text, expected_channel_module), "selected channel module", expected_channel_module, f"{expected_channel_module} missing", rows)
        enabled = sorted(set(re.findall(r"\./modules/([^/\s()]+)/entry\.metta", loader_text)))
        rows.append(("INFO", "enabled modules", ", ".join(enabled) if enabled else "<none>"))

    ok &= _check(prompt_path.exists(), "local prompt", str(prompt_path), "missing local prompt", rows)
    env_prompt = env.get("OMEGACLAW_PROMPT_FILE", "")
    prompt_matches = False
    if env_prompt:
        try:
            prompt_matches = pathlib.Path(env_prompt).expanduser().resolve() == prompt_path
        except Exception:
            prompt_matches = env_prompt == str(prompt_path)
    ok &= _check(prompt_matches, "prompt env", "points at local prompt", "OMEGACLAW_PROMPT_FILE does not point at local prompt", rows)
    ok &= _check(start_path.exists(), "start script", str(start_path), "missing start-omegaclaw.sh", rows)
    ok &= _check(launcher_path.exists(), "launcher", str(launcher_path), "missing Start OmegaClaw.command", rows)

    loop_path = core / "src" / "loop.metta"
    if loop_path.exists():
        loop_text = loop_path.read_text(encoding="utf-8", errors="replace")
        ok &= _check(bool(loop_text.strip()), "loop source", str(loop_path), "src/loop.metta is empty", rows)
        ok &= _check("(CHARS_SENT: (string_length $send) $send)" not in loop_text, "prompt leak guard", "prompt body is not printed", "loop still prints full prompt body", rows)

    if channel == "telegram":
        ok &= _check(bool(env.get("TG_BOT_TOKEN")), "Telegram token", "configured", "TG_BOT_TOKEN missing", rows)
        rows.append(("INFO", "Telegram bind mode", "fixed chat" if env.get("TG_CHAT_ID") else "auth/auto-bind"))

    if check_runtime:
        janus_ok, janus_detail = _janus_smoke()
        ok &= _check(
            janus_ok,
            "SWI-Prolog Janus bridge",
            janus_detail,
            janus_detail + "; rerun the macOS installer to repair the pinned local runtime",
            rows,
        )

    return ok, rows


def print_rows(rows: list[tuple[str, str, str]]) -> None:
    width = max([len(label) for _, label, _ in rows] + [10])
    for status, label, detail in rows:
        print(f"{status:4} {label:<{width}} {detail}")


def _telegram_api(token: str, method: str, params: dict[str, str] | None = None, timeout: int = 10) -> tuple[bool, object]:
    params = params or {}
    url = f"https://api.telegram.org/bot{token}/{method}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    if not payload.get("ok"):
        return False, payload.get("description", f"{method} failed")
    return True, payload.get("result")


def _telegram_update_message(update: dict) -> tuple[str, dict | None]:
    for kind in ("message", "edited_message", "channel_post", "edited_channel_post"):
        value = update.get(kind)
        if isinstance(value, dict):
            return kind, value
    return "unsupported", None


def _telegram_auth_candidate(text: str) -> str:
    stripped = str(text or "").strip()
    lower = stripped.lower()
    if lower.startswith("/auth "):
        return stripped[6:].strip()
    if lower.startswith("auth "):
        return stripped[5:].strip()
    return stripped


def _chat_summary(message: dict | None) -> str:
    if not isinstance(message, dict):
        return "chat=unknown"
    chat = message.get("chat") or {}
    chat_type = chat.get("type", "unknown")
    chat_id = str(chat.get("id", "unknown"))
    if len(chat_id) > 8:
        chat_id = f"{chat_id[:4]}...{chat_id[-4:]}"
    return f"chat_type={chat_type} chat={chat_id}"


def telegram_probe(workspace: pathlib.Path) -> tuple[bool, list[tuple[str, str, str]]]:
    workspace = workspace.expanduser().resolve()
    env = installer_common.parse_env_file(workspace / ".env")
    rows: list[tuple[str, str, str]] = []
    ok = True

    token = env.get("TG_BOT_TOKEN", "").strip()
    auth_secret = env.get("OMEGACLAW_AUTH_SECRET", "").strip()
    configured_chat = env.get("TG_CHAT_ID", "").strip()

    ok &= _check(bool(token), "Telegram token", "configured", "TG_BOT_TOKEN missing", rows)
    if not token:
        return False, rows

    api_ok, me = _telegram_api(token, "getMe")
    ok &= _check(api_ok and isinstance(me, dict), "Telegram getMe", "bot reachable", f"failed: {me}", rows)
    if isinstance(me, dict):
        rows.append(("INFO", "Telegram bot", f"@{me.get('username', '<unknown>')} id={me.get('id', '<unknown>')}"))

    api_ok, webhook = _telegram_api(token, "getWebhookInfo")
    ok &= _check(api_ok and isinstance(webhook, dict), "Telegram webhook info", "available", f"failed: {webhook}", rows)
    if isinstance(webhook, dict):
        webhook_url = str(webhook.get("url", "") or "")
        ok &= _check(
            not webhook_url,
            "Telegram webhook",
            "not set; getUpdates polling can receive messages",
            "webhook is set; Telegram will not deliver updates to polling until deleteWebhook",
            rows,
        )
        pending = webhook.get("pending_update_count", 0)
        rows.append(("INFO", "Telegram pending webhook updates", str(pending)))

    api_ok, updates = _telegram_api(
        token,
        "getUpdates",
        {"timeout": "0", "allowed_updates": json.dumps(["message", "edited_message", "channel_post", "edited_channel_post"])},
    )
    ok &= _check(api_ok and isinstance(updates, list), "Telegram getUpdates", "poll API reachable", f"failed: {updates}", rows)
    if isinstance(updates, list):
        rows.append(("INFO", "Telegram pending updates", str(len(updates))))
        for update in updates[-10:]:
            if not isinstance(update, dict):
                continue
            kind, message = _telegram_update_message(update)
            text = ""
            if isinstance(message, dict):
                text = str(message.get("text", "") or message.get("caption", "") or "")
            if configured_chat:
                chat = str((message or {}).get("chat", {}).get("id", ""))
                decision = "would-allow-fixed-chat" if chat == configured_chat else "would-ignore-wrong-chat"
            elif auth_secret:
                decision = "would-auth-bind" if _telegram_auth_candidate(text) == auth_secret else "would-ignore-auth-required"
            else:
                decision = "would-allow-auto-bind"
            rows.append(("INFO", f"update {update.get('update_id', 'unknown')}", f"kind={kind} {_chat_summary(message)} {decision}"))

    return ok, rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Check an OmegaClaw source install.")
    parser.add_argument("--workspace", default=str(pathlib.Path.home() / "OmegaClaw"))
    parser.add_argument("--startup-check", action="store_true", help="Run only local checks suitable for launcher startup.")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--remote", action="store_true", help="Also query public GitHub HEAD.")
    parser.add_argument("--telegram-probe", action="store_true", help="Probe Telegram Bot API without printing tokens or message bodies.")
    args = parser.parse_args()

    if args.telegram_probe:
        ok, rows = telegram_probe(pathlib.Path(args.workspace))
    else:
        ok, rows = diagnose(
            pathlib.Path(args.workspace),
            include_remote=args.remote and not args.startup_check,
            check_runtime=args.startup_check,
        )
    if not args.quiet:
        print_rows(rows)
    if not ok:
        if args.quiet:
            failed = [f"{label}: {detail}" for status, label, detail in rows if status == "FAIL"]
            print("OmegaClaw startup check failed: " + "; ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
