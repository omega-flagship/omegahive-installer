# OmegaClaw Installers

These installers are for source installs from the public repository. They create
a local PeTTa workspace, install Python/runtime dependencies, ask what to name
the agent, enable default-on modules automatically, ask about optional modules,
ask for the primary communication channel and LLM provider, then save that
configuration so later starts do not ask again.

## macOS

Double-click:

```text
install/macos/Install OmegaClaw.command
```

The installer opens Apple's command-line tools installer if needed. It then
creates a pinned user-local OmegaClaw runtime under
`~/OmegaClaw/.micromamba` and `~/OmegaClaw/.local`, even if Homebrew is
installed. The runtime installs `python=3.11`, `nodejs>=20,<27`, `git`,
`cmake`, `pkg-config`, `openblas`, and `pip` from conda-forge, plus the
SWI-Prolog 10.0.2-1 universal macOS app bundle. The local `swipl` wrapper uses
the local Python runtime, and the installer verifies an actual SWI-Prolog Janus
`py_call` smoke test before continuing. It runs without sudo.

## Windows

Double-click:

```text
install/windows/Install OmegaClaw.cmd
```

OmegaClaw runs on Windows through Ubuntu on WSL. The installer enables/uses WSL,
installs Ubuntu packages, then lets the shared installer add selected module dependencies and creates the Linux workspace at `~/OmegaClaw`
inside WSL. If Windows asks for a reboot or asks you to create a Linux user,
finish that step and run the installer again.

## What Gets Written

The installer creates or updates:

- `~/OmegaClaw` as the PeTTa workspace.
- `~/OmegaClaw/repos/OmegaClaw-Core` from this public repository.
- `~/OmegaClaw/repos/petta_lib_chromadb`.
- `~/OmegaClaw/.venv` for Python packages.
- `~/OmegaClaw/.env` for local provider/channel secrets.
- `~/OmegaClaw/local/prompt.txt` with the chosen agent name.
- `~/OmegaClaw/local/modules-loader.metta` for selected modules.
- `~/OmegaClaw/local/runtime-config.metta` for local non-secret MeTTa config
  overlay values such as provider and model.
- `~/OmegaClaw/start-omegaclaw.sh` and a platform launcher.
- `~/OmegaClaw/logs/omegaclaw-*.log` for full startup/runtime output from
  each launcher run.

Secrets are local runtime configuration. Do not commit `.env`.

## Module Selection

Module defaults come from each `modules/*/module.toml`:

- `default_enabled = true` modules are enabled automatically.
- `default_enabled = false` non-channel modules are offered as opt-in questions.
- The selected primary channel is enabled even when its module is normally
  optional.
- Other channel modules stay disabled unless enabled later, so WhatsApp is not
  assumed for users who choose Telegram, web control, mock, IRC, Slack, or
  Mattermost.

The result is a normal MeTTa module loader file, not hidden Python routing.
Selected module dependencies are installed during setup where the platform has
a supported package manager. The tracked `modules/loader.metta` remains the
safe source-checkout default; installed deployments use
`~/OmegaClaw/local/modules-loader.metta`.

## Provider And Channel Choices

Provider setup asks for provider, model, and API key where needed. Channel setup
asks for one primary channel and then only that channel's auth material. A
healthy channel is not enough for replies: the first real inbound message still
needs the selected LLM provider credential in `~/OmegaClaw/.env`. The startup
doctor checks this so a missing provider key is reported directly instead of
letting the first cognition turn fail mysteriously. The agent-name step rewrites
only the standalone default name `Omega`; `OmegaClaw` remains the framework
name. On later runs the generated launcher reads `~/OmegaClaw/.env`; re-run the
installer only when changing modules, channel, provider, or agent name. To
repair stale generated launch files without re-entering secrets, run:

```text
python ~/OmegaClaw/repos/OmegaClaw-Core/install/installer_common.py --workspace ~/OmegaClaw --repair
```

The generated root `run.metta` uses PeTTa's `git-import!` to register the local
`repos/OmegaClaw-Core` clone as the `OmegaClaw-Core` library. The installer
pulls that clone during setup. The generated root `run.metta` imports
the core substrate first, then `~/OmegaClaw/local/modules-loader.metta`, then
the attention organ, then `src/loop.metta`, then
`~/OmegaClaw/local/runtime-config.metta`, and only then starts the loop. The
loop must be imported last because PeTTa compiles calls such as `initChannels`,
`receive`, and attention helpers at import time. The selected channel and module
surface are visible to MeTTa without dirtying the Git clone, but modules attach
only after core runtime primitives are loaded.

For Telegram, leaving `TG_CHAT_ID` empty enables first-chat binding. If the
local auth secret is enabled, the installer writes `telegram-auth-command.txt`
inside the workspace; send that one-time `/auth ...` message to the bot before
ordinary chat messages will reach the agent.

The generated launcher intentionally runs the normal verbose MeTTa path rather
than hiding startup internals. The same output shown in Terminal is also written
to the latest file under `~/OmegaClaw/logs/`. The launcher is a persistent
supervisor: if the SWI-Prolog runtime exits cleanly or crashes, the outer
OmegaClaw session remains open and starts the runtime again. Stop it manually
with Ctrl-C or by closing the launcher window.
