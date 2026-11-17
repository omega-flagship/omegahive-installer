#!/bin/bash
# Purpose: run, start, open, stop or report the hive that "Install OmegaHive.command" set up in one folder of this Mac
# user's home ($OMEGAHIVE_HOME, ~/OmegaHive by default), start it again when its owner logs in, or take it off the Mac.
# The hive runs in local-owner mode (hive/core/localowner.py) as a launchd job of this user's login session, so closing
# Terminal leaves it running; "open" signs its owner in through a one-time link in the default browser.
#
#   omegahive.sh open       start the hive if it is not running, then open it signed in (what Start OmegaHive does)
#   omegahive.sh link       the same start, then print its one-time sign-in link for the Omega Hive app to open
#   omegahive.sh start      start the hive if it is not running
#   omegahive.sh stop       stop it until the next start or open, logins included
#   omegahive.sh status     what the running hive reports on its control socket
#   omegahive.sh login      what its login item runs at each login: start it unless its owner stopped it or turned
#                           starting at login off
#   omegahive.sh autostart on|off|status   whether the hive starts when its owner logs in (on unless turned off)
#   omegahive.sh register   put the Omega Hive app in ~/Applications and, unless starting at login is off, the login
#                           item in ~/Library/LaunchAgents (the installer, after every install and refresh)
#   omegahive.sh uninstall  stop the hive, remove the app and the login item, and delete the hive's folder once its
#                           path is typed
#   omegahive.sh create     enrol Create's Code service with the hive and raise its controller's cap (installer, once)
#   omegahive.sh run        the hive itself, in the foreground (the launchd job runs this)
#
# On Linux (the Windows installer's WSL distro) there is no launchd:
#   omegahive.sh serve       the hive in the foreground, started again 10 seconds after any exit but a clean one, as
#                            launchd's KeepAlive does; the Windows side runs it under a hidden wsl.exe, which keeps
#                            WSL from stopping the distro while the hive runs
#   omegahive.sh signin-url  wait for the running hive, then print its one-time sign-in link for the Windows side
#   start and open start serve in a session of its own; stop ends serve and the hive with it.
set -euo pipefail
# Everything this script writes in the hive's folder (the launchd plist, package.json, logs) is the owner's alone.
umask 077

OH=${OMEGAHIVE_HOME:-$HOME/OmegaHive}
TOOLCHAIN=$OH/toolchain/envs/hive
# Where the Omega core's stamp and rendered runtime live (core below; the hive reads it as OMEGACLAW_RUNTIME_CACHE, and
# without it they would go to ~/.cache, outside the hive's folder).
RUNTIME_CACHE=$OH/cache/omega-runtime
SOCKET=$OH/data/run/control.sock
SELF=$OH/app/install/macos/omegahive.sh
OS=$(uname -s)
SERVE_PID=$OH/run/serve.pid
# One launchd label per hive folder, from a checksum of its path as deploy/up.sh names one container per
# $OMEGAHIVE_HOME: two folders' hives never replace each other's job.
LABEL=org.omegahive.hive.$(printf '%s' "$OH" | cksum | cut -d ' ' -f 1)
DOMAIN=gui/$(id -u)
# Create's Code service, when setup-code.sh gave this hive one: a job of its own beside the hive's, its plist in run/,
# where hive.env tells the hive's release guard to read it (HIVE_CODE_AGENT_PLIST), inside $OH like the hive's own.
CODE=$OH/code
CODE_LABEL=family.omegahive.omegacode.${LABEL##*.}
CODE_PLIST=$OH/run/family.omegahive.omegacode.plist
# On Linux the service is a systemd user unit of this name, which the hive's guard reads (hive/core/code.py CODE_UNIT).
CODE_UNIT=omegacode.service
REPO=$OH/repos/small-app
# The hourly offer of a newer signed release while the hive runs: a third job, its plist in run/ too.
UPDATE_LABEL=$LABEL.update
UPDATE_PLIST=$OH/run/$UPDATE_LABEL.plist
# The two things a Mac hive keeps outside $OH, for its owner to find and both removed by uninstall: launchd loads a
# login session's own jobs at login only from ~/Library/LaunchAgents (an app's SMAppService needs a signed app), and
# Spotlight, Launchpad and the Dock find apps in an Applications folder. The login item runs a script inside the app,
# since Login Items names an item after the app holding its program, where a program run as /bin/bash reads "bash".
LOGIN_LABEL=$LABEL.login
LOGIN_PLIST=$HOME/Library/LaunchAgents/$LOGIN_LABEL.plist
# Each folder's app is its own: the default folder's is Omega Hive, another's adds that folder's name and its checksum.
APP_NAME="Omega Hive"
[ "$OH" = "$HOME/OmegaHive" ] || APP_NAME="Omega Hive (${OH##*/} ${LABEL##*.})"
APP=$HOME/Applications/$APP_NAME.app
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# Its owner's last stop, which the login item keeps: stop writes it, start (and so open) removes it.
STOPPED=$OH/run/stopped

say() { printf '%s\n' "$*"; }
fail() { printf 'OmegaHive: %s\n' "$*" >&2; exit 1; }

# HIVE_PORT kept in hive.env since the install chose it: the browser keeps the owner's session per origin.
port() { sed -n 's/^HIVE_PORT=//p' "$OH/hive.env" 2>/dev/null | tail -n 1; }

# One request on the hive's same-uid control socket (hive/core/localowner.py LocalOwner.answer), through the hive's
# own client (hive/core/newhive_helper.py control()); prints field $2 of the answer, or nothing when nobody answers.
control() {
  [ -S "$SOCKET" ] || return 0
  (cd "$OH/app" && "$OH/venv/bin/python" -c '
import sys
from hive.core.newhive_helper import control
try:
    answer = control(sys.argv[1], {"op": sys.argv[2]}, timeout=5)
except Exception:
    sys.exit(0)
if isinstance(answer, dict) and answer.get("ok"):
    print(answer.get(sys.argv[3], ""))' "$SOCKET" "$1" "$2") 2>/dev/null || true
}

running() { [ -n "$(control hello port)" ]; }

# The sandbox runtimes and the Tools app's settings, as export lines for run(): JSON written by Python, quoted for the
# shell by shlex. Tools run on the toolchain's Node (see run()). When setup-tools.sh put the Tools app in apps/, the
# hive finds it there (HIVE_PLUGIN_DIRS) and admits it only at the digest and lock pins.sh names (HIVE_APP_PINS), so the
# Tools page lists its tools; it may run its skills in the sandbox (HIVE_SANDBOX_RUN_APPS)
# as MeTTa on this folder's Python, whose runtime reads PeTTa and SWI-Prolog (tools_worker.py imports both; the sandbox
# adds the venv and the toolchain's Python itself). The sandbox gives a job no PATH to swipl, and the prebuilt bundle's
# compiled-in home is the machine it was built on, so the runtime also names SWI_HOME_DIR, the home swipl itself reports
# (PLBASE), for any layout; a hive honours it once a runtime may name its environment
# (tools/runtime-env), and an older hive ignores it. Plugin folders, pins and apps the owner names in hive.env are
# kept beside the Tools app; the runtimes are the installer's alone. A function, not a here-document inside $(...),
# which macOS's bash 3.2 can misparse.
# Studio, the app the hive shows as Create, is mounted and pinned the same way when setup-studio.sh put it in apps/
# (its pin binds the page lock its page is checked against), may run its actions in the sandbox, and turns on Studio's
# live sessions unless the owner's hive.env says otherwise. A Mac hive keeps them off by itself until its restart path
# is reviewed (hive/core/studio_sessions.py names what is missing in the hive's log); Create's Make, Code and Flow work
# either way.
app_settings() {
  . "$OH/app/install/macos/pins.sh"
  "$OH/venv/bin/python" -I - "$OH" "$TOOLCHAIN" "$OMEGA_TOOLS_DIGEST" "$OMEGA_TOOLS_LOCK_SHA256" \
    "$OMEGADESIGN_DIGEST" "$OMEGADESIGN_LOCK_SHA256" <<'PY'
import json, os, re, shlex, subprocess, sys
oh, toolchain, digest, lock, studio_digest, studio_lock = sys.argv[1:7]
runtimes = {"node": {"exe": f"{toolchain}/bin/node", "reads": [f"{oh}/package.json"]}}
if os.environ.get('HIVE_CODE_SANDBOX_PROJECT_TESTS') == 'on':
    runtimes['python'] = {'exe': os.path.realpath(f'{oh}/venv/bin/python'), 'reads': [toolchain]}
out = {}
tools = os.path.normpath(os.path.join(oh, "apps", "omega-tools"))
studio = os.path.normpath(os.path.join(oh, "apps", "omegadesign"))
# The installer's pinned apps that setup put in apps/: each app's folder, its source digest and the one file its pin binds.
pinned = {app: (folder, d, files) for app, folder, d, files in (
    ("omega-tools", tools, digest, {"release-data.lock.json": lock}),
    ("omegadesign", studio, studio_digest, {"ui/bundle.lock.json": studio_lock}))
    if os.path.isfile(os.path.join(folder, "plugin.json"))}
if "omega-tools" in pinned:
    runtimes["metta"] = {"exe": f"{oh}/venv/bin/python", "reads": [f"{oh}/PeTTa", f"{oh}/swipl"]}
    try:
        dump = subprocess.run([f"{oh}/swipl/bin/swipl", "--dump-runtime-variables=sh"], capture_output=True, text=True).stdout
    except OSError:
        dump = ""
    home = re.search(r'^PLBASE="([^"]+)";$', dump, re.M)
    if home:
        runtimes["metta"]["env"] = {"SWI_HOME_DIR": home.group(1)}
    else:   # the hive still starts; only Tools skill runs on a relocated SWI-Prolog fail, and its log says why
        print(f"OmegaHive: {oh}/swipl/bin/swipl named no home (PLBASE); Tools skills may not find SWI-Prolog", file=sys.stderr)
if pinned:
    folders = [folder for folder, _, _ in pinned.values()]
    dirs = [d for d in os.environ.get("HIVE_PLUGIN_DIRS", "").split(os.pathsep) if d and os.path.normpath(d) not in folders]
    out["HIVE_PLUGIN_DIRS"] = os.pathsep.join(folders + dirs)
    try:
        pins = json.loads(os.environ.get("HIVE_APP_PINS") or "{}")
    except ValueError:
        pins = None
    if isinstance(pins, dict):   # an owner value that is no JSON object stays as written, and the hive refuses it
        for app, (folder, d, files) in pinned.items():
            pins[app] = {"release": folder, "digest": d, "files": files}
        out["HIVE_APP_PINS"] = json.dumps(pins)
    apps = [a.strip() for a in os.environ.get("HIVE_SANDBOX_RUN_APPS", "").split(",") if a.strip() and a.strip() not in pinned]
    out["HIVE_SANDBOX_RUN_APPS"] = ",".join(list(pinned) + apps)
if "omegadesign" in pinned and not os.environ.get("HIVE_STUDIO_SESSIONS", "").strip():
    out["HIVE_STUDIO_SESSIONS"] = "on"
out["HIVE_SANDBOX_RUNTIMES"] = json.dumps(runtimes)
for key, value in out.items():
    print(f"export {key}={shlex.quote(value)}")
PY
}

# From dev/latest 9e9c1e4 on, minds run on singnet/Omega at the revision core-dependency.json pins, and the
# runtime refuses while the copies of it the tree used to carry remain (hive/runtime/core.py), so a release used as it
# is woke no mind. scripts/setup_core.py removes those copies, checks out the
# pinned revision into third_party/Omega and stamps it; --source takes it from the git bundle the release carries, so
# this needs no network, and the toolchain's git does the checkout. A release from before 9e9c1e4 carries its core.
core() {
  if [ ! -f "$OH/app/core-dependency.json" ]; then echo "This release carries its own Omega core."; return 0; fi
  rev=$("$OH/venv/bin/python" -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["revision"])' \
    "$OH/app/core-dependency.json")
  bundle=$OH/app/install/macos/omega-core-$(printf %.7s "$rev").bundle
  [ -f "$bundle" ] || fail "this release lacks the Omega core it pins ($(basename "$bundle")); download the release again"
  PATH="$TOOLCHAIN/bin:/usr/bin:/bin" OMEGACLAW_RUNTIME_CACHE="$RUNTIME_CACHE" \
    "$OH/venv/bin/python" -I "$OH/app/scripts/setup_core.py" --source "$bundle"
  echo "The Omega core is set up at $(printf %.7s "$rev")."
}

run() {
  [ -f "$OH/installed" ] || fail "$OH holds no finished install; double-click Install OmegaHive.command again"
  P=$(port); [ -n "$P" ] || fail "$OH/hive.env names no HIVE_PORT"
  # The owner's own settings, one KEY=VALUE per line in hive.env (HIVE_CODE_SERVICE_CONFIG, HIVE_COPY_APPLY_CLAIMS and
  # the rest; config.py reads them from the launcher's environment). The toolchain and local-owner lines below win.
  set -a; . "$OH/hive.env"; set +a
  # Only this folder's toolchain: a Homebrew or other Python, Node or SWI-Prolog on PATH never reaches the hive.
  export PATH="$OH/swipl/bin:$OH/venv/bin:$TOOLCHAIN/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export VIRTUAL_ENV="$OH/venv" PETTA_PATH="$OH/PeTTa" HIVE_DATA_DIR="$OH/data"
  export OMEGACLAW_RUNTIME_CACHE="$RUNTIME_CACHE"
  # local-owner mode: one owner, signed in by one-time links, loopback only, every mind in the OS sandbox
  # (localowner.check_environment refuses to start otherwise).
  export HIVE_LOCAL_OWNER=1 HIVE_MIND_SANDBOX=1 HIVE_HOST=127.0.0.1 HIVE_PORT="$P"
  # The hive builds the addresses it hands out, such as an outside agent's join URL, from HIVE_PUBLIC_URL, whose default
  # is http://127.0.0.1:8700, so a hive on another port would send agents to 8700. hive.env's own value wins.
  export HIVE_PUBLIC_URL="${HIVE_PUBLIC_URL:-http://127.0.0.1:$P}"
  # Sandboxed tools run on the toolchain's Node. Node reads the nearest package.json above a tool's bundle to choose its
  # module type, and the sandbox shows a file above the bundle but refuses its contents, so Node exited 1 and the
  # first-boot preflight failed, refusing minds with the tools.
  # $OH/package.json is the nearest one above the data folder, and the runtime is granted to read it.
  printf '{"private": true}\n' > "$OH/package.json"
  # The sandbox runtimes, and the Tools app when setup-tools.sh installed it (app_settings above).
  SETTINGS=$(app_settings) || fail "could not work out the hive's app and sandbox settings"
  eval "$SETTINGS"
  mkdir -p "$OH/data/run" && chmod 700 "$OH/data" "$OH/data/run"
  # The owner-only socket a local OmegaCode service enrols through (hive/core/code_local_enrolment.py), beside the
  # control socket in data/run (the review of PhysixSNET/omegahive#25, point 5). Owner-local enrolment pins its own
  # release, b26ab7da, which is not published, and the hive refuses a release selected beside it (code.py
  # _select_release); a hive whose hive.env selects the published release for Create's Code service enrols that service
  # through POST /api/services/enrol instead ("create" below), so it gets no socket.
  [ -n "${HIVE_CODE_SERVICE_RELEASE:-}" ] || export HIVE_CODE_LOCAL_ENROLMENT_SOCKET="$OH/data/run/code-enrolment.sock"
  # The updater's state (install/macos/update.py: the release on offer, its last check, a failed update), which the
  # hive's Updates page reads and whose Update now runs the updater as its hourly job does; a build without the updater
  # names none, and the page then offers nothing (hive/core/updates.py).
  if [ -f "$OH/app/install/macos/update.py" ]; then export HIVE_UPDATE_STATE="$OH/run/update-state.json"; fi
  cd "$OH/app"
  exec "$OH/venv/bin/python" -m hive
}

# Loads a plist as a launchd job of this login session, replacing a loaded one, so the job runs from the plist just
# written. bootout returns before the job is gone, and bootstrapping its label meanwhile fails with 5 (Input/output
# error): 20 half-second polls wait for it, then 3 bootstrap attempts a second apart.
load_job() {   # $1 plist, $2 label
  launchctl bootout "$DOMAIN/$2" >/dev/null 2>&1 || true
  i=0
  while launchctl print "$DOMAIN/$2" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  i=0
  until launchctl bootstrap "$DOMAIN" "$1" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 3 ] || fail "launchd did not take the job in $1"
    sleep 1
  done
}

# First boot runs the sandbox preflight before it answers; 180 one-second polls bound the wait.
wait_running() {
  i=0
  until running; do
    i=$((i + 1))
    if [ "$i" -ge 180 ]; then
      say "The hive did not start. The end of its log, $OH/logs/hive.log:"
      tail -n 25 "$OH/logs/hive.log" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
}

# Linux: serve's process, while it lives.
serving() { [ -f "$SERVE_PID" ] && kill -0 "$(cat "$SERVE_PID" 2>/dev/null)" 2>/dev/null; }

# Linux: the hive in the foreground for as long as this process lives, started again after a crash. A stop (TERM) ends
# the hive and then this loop; the hive's own clean exit ends the loop too.
serve() {
  [ -f "$OH/installed" ] || fail "$OH holds no finished install; run the installer again"
  serving && fail "the hive is already being served (pid $(cat "$SERVE_PID"))"
  mkdir -p "$OH/run" "$OH/logs"
  echo "$$" > "$SERVE_PID"
  # Create's Code service, when setup gave the hive one, starts once the hive answers and is enrolled with it then
  # (create is a no-op once enrolled); systemd keeps it running beside the hive.
  if [ -f "$CODE/config.json" ]; then
    { wait_running >/dev/null && start_code && create; } >> "$OH/logs/hive.log" 2>&1 &
  fi
  child=""
  trap '[ -z "$child" ] || kill -TERM "$child" 2>/dev/null; [ -z "$child" ] || wait "$child" 2>/dev/null; rm -f "$SERVE_PID"; exit 0' TERM INT HUP
  while :; do
    /bin/bash "$SELF" run >> "$OH/logs/hive.log" 2>&1 &
    child=$!
    code=0; wait "$child" || code=$?
    child=""
    [ "$code" -ne 0 ] || break
    printf '%s serve: the hive exited with %s; starting it again in 10 seconds\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$code" >> "$OH/logs/hive.log"
    sleep 10
  done
  rm -f "$SERVE_PID"
}

# The launchd job: written each start from the folder it runs in, loaded into this user's login session. On Linux,
# serve in a session of its own (under WSL the Windows side runs serve itself, so WSL keeps the distro up).
start() {
  # A start is its owner's choice, so from here a login starts the hive again.
  rm -f "$STOPPED"
  running && return 0
  [ -f "$OH/installed" ] || fail "$OH holds no finished install; double-click Install OmegaHive.command again"
  if [ "$OS" = Linux ]; then
    if ! serving; then setsid /bin/bash "$SELF" serve </dev/null >/dev/null 2>&1 & fi
    say "Starting your hive..."
    wait_running
    return 0
  fi
  mkdir -p "$OH/run" "$OH/logs"
  PLIST=$OH/run/$LABEL.plist
  "$OH/venv/bin/python" - "$PLIST" "$LABEL" "$SELF" "$OH" "$HOME" <<'PY'
import plistlib, sys
path, label, script, home, user_home = sys.argv[1:6]
with open(path, "wb") as out:
    plistlib.dump({"Label": label, "ProgramArguments": ["/bin/bash", script, "run"],
                   "EnvironmentVariables": {"OMEGAHIVE_HOME": home, "HOME": user_home},
                   "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 10,
                   "ProcessType": "Interactive",
                   "StandardOutPath": f"{home}/logs/hive.log", "StandardErrorPath": f"{home}/logs/hive.log"}, out)
PY
  load_job "$PLIST" "$LABEL"
  say "Starting your hive..."
  wait_running
  start_code
  start_updates
}

# While the hive runs, update.py check --job asks every hour whether a newer signed release is out and offers it to the
# owner, who may say Not now; on Update it hands the refresh to a Terminal window of its own, since the installer's
# stop would boot this job out with any child it ran. The job is loaded only when absent, so a start inside an update
# never boots the update out.
start_updates() {
  [ -f "$OH/app/install/macos/update.py" ] || return 0
  ! launchctl print "$DOMAIN/$UPDATE_LABEL" >/dev/null 2>&1 || return 0
  "$OH/venv/bin/python" - "$UPDATE_PLIST" "$UPDATE_LABEL" "$TOOLCHAIN/bin/python3.12" "$OH" "$HOME" <<'PY'
import plistlib, sys
path, label, py, home, user_home = sys.argv[1:6]
with open(path, "wb") as out:
    plistlib.dump({"Label": label,
                   "ProgramArguments": [py, "-I", f"{home}/app/install/macos/update.py", "check", "--home", home, "--job"],
                   "EnvironmentVariables": {"HOME": user_home},
                   "StartInterval": 3600, "RunAtLoad": False, "ProcessType": "Interactive", "Umask": 0o077,
                   "StandardOutPath": f"{home}/logs/update-job.log", "StandardErrorPath": f"{home}/logs/update-job.log"}, out)
PY
  load_job "$UPDATE_PLIST" "$UPDATE_LABEL"
}

# Create's Code service, in the reviewed command form the hive's guard checks (hive/core/code.py: <the hive's python>
# -B -s -m omegacode --config <absolute>, the release alone on PYTHONPATH, an empty private working folder): on a Mac a
# launchd job inside sandbox-exec with setup-code.sh's profile, on Linux a systemd user unit. It starts after the hive
# and stops with it. A service that does not answer leaves the hive running without Create, and says so.
start_code() {
  [ -f "$CODE/config.json" ] || return 0
  if [ "$OS" = Linux ]; then start_code_unit; else start_code_job; fi
  code_answers \
    || say "Create's Code service did not answer, so Create is unavailable until the next start; its log: $CODE/logs/service.log"
}

# Linux: a transient systemd user unit in the same command form, its files nowhere but $CODE. systemd confines it as
# setup-code.sh's seatbelt profile confines it on a Mac: the system and the home folder read-only, writable only its
# state, temp, working folder, logs and the repository; no new privileges; a temp of its own. A user unit takes those
# through a user namespace, in which its uid stays this account's.
start_code_unit() {
  release=$CODE/releases/$(sed -n 's/^HIVE_CODE_SERVICE_RELEASE=//p' "$OH/hive.env" | tail -n 1)
  systemctl --user stop "$CODE_UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$CODE_UNIT" >/dev/null 2>&1 || true
  systemd-run --user --quiet --collect --unit="$CODE_UNIT" --working-directory="$CODE/wd" \
    --setenv=PYTHONPATH="$release" --setenv=HOME="$HOME" --setenv=TMPDIR="$CODE/tmp/" \
    --setenv=PATH="$TOOLCHAIN/bin:/usr/bin:/bin" --setenv=PYTHONDONTWRITEBYTECODE=1 --setenv=PYTHONUNBUFFERED=1 \
    -p UMask=0077 -p Restart=always -p RestartSec=10 -p TimeoutStopSec=10 \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=read-only -p PrivateTmp=yes \
    -p "ReadWritePaths=$CODE/state $CODE/tmp $CODE/wd $CODE/logs $REPO" \
    -p "StandardOutput=append:$CODE/logs/service.log" -p "StandardError=append:$CODE/logs/service.log" \
    -- "$OH/venv/bin/python" -B -s -m omegacode --config "$CODE/config.json"
}

# A Mac: the launchd job, inside sandbox-exec with setup-code.sh's profile. Its HOME is its own folder's home, which
# that profile grants: the profile lets it read none of the owner's home, and git reads ~/.gitconfig there, so with
# the owner's HOME every git command the service ran failed whenever the owner had a git config, and the Code
# workspace never opened (omegahive-feedback#103). Linux's unit keeps the owner's HOME, which it may read.
start_code_job() {
  mkdir -p "$CODE/home" && chmod 700 "$CODE/home"
  "$OH/venv/bin/python" - "$CODE_PLIST" "$CODE_LABEL" "$CODE" \
    "$CODE/releases/$(sed -n 's/^HIVE_CODE_SERVICE_RELEASE=//p' "$OH/hive.env" | tail -n 1)" "$OH/venv/bin/python" \
    "$TOOLCHAIN" <<'PY'
import plistlib, sys
path, label, code, release, py, toolchain = sys.argv[1:7]
with open(path, "wb") as out:
    plistlib.dump({"Label": label,
                   "ProgramArguments": ["/usr/bin/sandbox-exec", "-f", f"{code}/omegacode.sb", py, "-B", "-s", "-m",
                                        "omegacode", "--config", f"{code}/config.json"],
                   "WorkingDirectory": f"{code}/wd",
                   "EnvironmentVariables": {"PYTHONPATH": release, "HOME": f"{code}/home", "TMPDIR": f"{code}/tmp/",
                                            "PATH": f"{toolchain}/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                                            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
                   "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10, "ExitTimeOut": 10, "Umask": 0o077,
                   "ProcessType": "Interactive",
                   "StandardOutPath": f"{code}/logs/service.log", "StandardErrorPath": f"{code}/logs/service.log"}, out)
PY
  load_job "$CODE_PLIST" "$CODE_LABEL"
}

# It answers its operator and refuses anyone else within 30 seconds (60 half-second polls), on its config's port.
code_answers() {
  "$OH/venv/bin/python" -I - "$CODE/operator-token" "$CODE/config.json" <<'PY'
import json, sys, time, httpx
token = open(sys.argv[1]).read().strip()
url = f"http://127.0.0.1:{json.load(open(sys.argv[2]))['port']}/v1/capabilities"
for _ in range(60):
    try:
        mine = httpx.get(url, headers={"Authorization": "Bearer " + token}, timeout=2)
        anyone = httpx.get(url, timeout=2)
        if mine.status_code == 200 and anyone.status_code == 401:
            sys.exit(0)
    except httpx.HTTPError:
        pass
    time.sleep(0.5)
sys.exit(1)
PY
}

# A newer signed release is offered before the hive starts (install/macos/update.py), then the hive starts and URL is
# its one-time sign-in link. A check that fails or finds nothing never keeps the hive from starting; exit 10 means the
# owner took the update and its installer has already refreshed the hive and opened it, or, with --terminal ($1), does
# so in a Terminal window of its own.
open_prepare() {
  if [ "$OS" = Darwin ] && [ -f "$OH/app/install/macos/update.py" ]; then
    "$TOOLCHAIN/bin/python3.12" -I "$OH/app/install/macos/update.py" check --home "$OH" ${1:+"$1"} \
      || [ $? -ne 10 ] || exit 0
  fi
  start
  URL=$(control signin url)
  [ -n "$URL" ] || fail "the hive did not give a sign-in link; see $OH/logs/hive.log"
}

open_hive() {
  open_prepare
  # The link signs the owner in once, within 60 seconds (localowner.CODE_SECONDS). It goes to the terminal alone,
  # never to stdout, which the installer copies into its log.
  if [ "$OS" = Darwin ] && open "$URL" >/dev/null 2>&1; then
    say "Your hive is open in your browser, signed in as its owner (http://127.0.0.1:$(port))."
  elif { printf 'Open this link in your browser within a minute to sign in to your hive:\n%s\n' "$URL" > /dev/tty; } 2>/dev/null; then
    :
  else
    say "Your browser did not open. Open Omega Hive to get a new sign-in link."
  fi
}

# What the Omega Hive app runs: open's start, with the one-time link alone on stdout, which the app opens itself and
# never logs (as signin-url gives the Windows side its link), and an update its owner takes handed to a Terminal window,
# since the app has none. Everything else goes to stderr, which the app shows only when this fails.
app_link() {
  open_prepare --terminal >&2
  printf '%s\n' "$URL"
}

# Linux: the link for the Windows side, which opens it in the Windows browser; on stdout, which that side reads and
# never logs. The Windows side has just started serve, whose pid may not be written yet, so this waits for the hive to
# answer (wait_running's bound), saying why on stderr if it never does.
signin_url() {
  wait_running >&2
  URL=$(control signin url)
  [ -n "$URL" ] || fail "the hive did not give a sign-in link; see $OH/logs/hive.log"
  printf '%s\n' "$URL"
}

# Ends the hive and every job it loaded, and waits until it no longer answers.
halt() {
  if [ "$OS" = Linux ]; then
    systemctl --user stop "$CODE_UNIT" >/dev/null 2>&1 || true
    if serving; then kill -TERM "$(cat "$SERVE_PID")" 2>/dev/null || true; fi
    i=0
    while { serving || running; } && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
    return 0
  fi
  launchctl bootout "$DOMAIN/$UPDATE_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$CODE_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  # bootout asks launchd to end a job and returns while its hive is still exiting, so a start right after found the
  # old hive answering and started nothing. Wait until it no longer answers and its job is gone: launchd kills a job
  # ExitTimeOut after its TERM, 20 seconds by default, so 30 one-second polls bound the wait.
  i=0
  while { running || launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; } && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  if running; then fail "the hive still answers 30 seconds after it was asked to stop; its log is $OH/logs/hive.log"; fi
}

# Its owner's stop, which a login keeps on a Mac: the login item reads the mark it leaves.
stop() {
  halt
  if [ "$OS" = Linux ]; then say "Your hive is stopped."; return 0; fi
  mkdir -p "$OH/run"
  date '+%Y-%m-%d %H:%M:%S' > "$STOPPED"
  say "Your hive is stopped, and stays stopped when you log in. Open Omega Hive to start it again."
}

# Create's Code service is enrolled once, as the hive's owner in a session from a one-time sign-in code that ends with
# the step (POST /api/services/enrol; the service's operator route takes the one-time token and registers itself with
# the hive), and the Create · Code controller, which the hive makes with 0.50 USD for its whole life, may spend up to 5,
# about twenty requests at 0.25 each. The hive's own spending total needs no step here: the first key its owner adds
# brings the hive's starting limit, 50 USD a month (hive/core/budgets.py seed_start_total, PhysixSNET/omegahive#35).
# The cap is set without a line in the installer's window: a money line there, before any key or choice, reads as a
# charge, and the mind's page shows the cap where it can be changed.
# Studio, when setup-studio.sh put it in apps/, is installed in the same owner session: the owner's review of the release
# the hive pinned (POST /api/programs/omegadesign/install, which an owner, never the local operator, may make), turned
# on in the Create · Code controller's swarm, where Create then opens with its Studio, Make, Code and Flow. Reviewed but
# on in no swarm a person sees, the hive lists no Create; on only in a person's personal swarm, Create asks where to
# open (both seen on a v0.33 hive, 17 November). A review of an older release is renewed when an update brings a new one.
create() {
  [ -f "$CODE/config.json" ] || return 0
  start
  (cd "$OH/app" && "$OH/venv/bin/python" - "$SOCKET" "$(port)" "$CODE" "$OH" <<'PY'
import json
import os
import sys
import urllib.request

from hive.core.newhive_helper import control

sock, port, code, oh = sys.argv[1:5]
base = f"http://127.0.0.1:{port}"


def call(method, path, body=None, token=None, url=None):
    req = urllib.request.Request((url or base) + path, data=None if body is None else json.dumps(body).encode(),
                                 method=method)
    req.add_header("Origin", base)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


token = call("POST", "/api/auth/local/exchange", {"code": control(sock, {"op": "signin"})["code"]})["token"]
try:
    if any(s.get("name") == "omegacode" and s.get("enabled", True) for s in call("GET", "/api/services", token=token)):
        print("Create's Code service is already enrolled with your hive.")
    else:
        enrol_token = call("POST", "/api/services/enrol", {"name": "omegacode"}, token)["enrol_token"]
        operator = open(f"{code}/operator-token").read().strip()
        service = f"http://127.0.0.1:{json.load(open(f'{code}/config.json'))['port']}"
        call("POST", "/v1/operator/register", {"enrol_token": enrol_token}, operator, url=service)
        print("Create's Code service is enrolled with your hive.")
    controller = None
    for mind in call("GET", "/api/agents", token=token):
        if mind.get("name") == "Create · Code controller":
            controller = mind
            if float(mind.get("budget_usd") or 0) < 5:
                call("PATCH", f"/api/agents/{mind['id']}", {"budget_usd": 5}, token)
    if os.path.isfile(os.path.join(oh, "apps", "omegadesign", "plugin.json")):
        entry = call("GET", "/api/programs/omegadesign", token=token)
        status = call("GET", "/api/programs/omegadesign/install", token=token)
        swarm = (controller or {}).get("swarm_id")
        if entry.get("error") or not entry.get("digest"):
            print(f"Studio did not load in your hive, so it shows no Create: {entry.get('error') or 'no pinned release'}")
        elif not swarm:
            print("Your hive has no Create · Code controller yet, so Studio is not turned on; it is at the next start.")
        else:
            # a person app opens in each person's own space, so only a swarm app is turned on in a chosen swarm
            in_swarm = status.get("placement") == "swarm"
            active = {a.get("swarm_id") for a in call("GET", "/api/programs/omegadesign/activations", token=token)
                      if a.get("active")}
            if not status.get("installed") or status.get("release_digest") != entry["digest"]:
                call("POST", "/api/programs/omegadesign/install", {"release_digest": entry["digest"],
                     "placement": status["placement"], "use_in": [swarm] if in_swarm else []}, token)
            elif in_swarm and swarm not in active:
                call("POST", "/api/programs/omegadesign/activations", {"swarm_id": swarm}, token)
            print("Create is in your hive: Studio, with its Make, Code and Flow.")
finally:
    call("POST", "/api/auth/logout", {}, token)   # this session was for the step alone
PY
  )
  # A fresh Code process enrols through its ordinary operator route first. Its next owned start enables the
  # proposal-test plane with that same registration, after the runtime profile and host claims are configured.
  enabled=$("$OH/venv/bin/python" -I "$OH/app/install/macos/code-runtime.py" enable "$CODE/config.json")
  if [ "$enabled" = enabled ]; then
    start_code
    code_answers || fail "Code did not answer after proposal tests were enabled; see $CODE/logs/service.log"
  fi
}

status() {
  if running; then say "running on http://127.0.0.1:$(control hello port) (pid $(control hello pid))"; else say "not running"; fi
}

# "off" when hive.env says HIVE_START_AT_LOGIN=off, else "on": the owner's choice, kept there across refreshes.
start_at_login() {
  choice=$(sed -n 's/^HIVE_START_AT_LOGIN=//p' "$OH/hive.env" 2>/dev/null | tail -n 1)
  if [ "$choice" = off ]; then echo off; else echo on; fi
}

# Sets the hive.env line $1=$2, or removes it when $2 is empty, keeping every other line as it is.
env_line() {
  mkdir -p "$OH/run"
  { grep -v "^$1=" "$OH/hive.env" 2>/dev/null || true
    [ -z "$2" ] || printf '%s=%s\n' "$1" "$2"; } > "$OH/run/hive.env.new"
  mv "$OH/run/hive.env.new" "$OH/hive.env"
}

# What the login item runs at each login: the hive's start, with no browser and no update dialog (the hourly job
# offers updates while it runs), unless its owner turned starting at login off or stopped the hive and has not started
# it since. A hive its owner turned off in its own page starts here like any other and stays off, since the hive keeps
# that choice in its database (hive/core/power.py), and its page is then there to turn it back on.
login_start() {
  when=$(date '+%Y-%m-%d %H:%M:%S')
  if [ "$(start_at_login)" = off ]; then
    say "$when login: starting at login is off (omegahive.sh autostart on turns it on)"
  elif [ -f "$STOPPED" ]; then
    say "$when login: not started, since its owner stopped it at $(cat "$STOPPED"); opening Omega Hive starts it"
  else
    say "$when login: starting the hive"
    start
  fi
}

remove_login_item() {
  launchctl bootout "$DOMAIN/$LOGIN_LABEL" >/dev/null 2>&1 || true
  rm -f "$LOGIN_PLIST"
}

# The Omega Hive app and the login item, written by the installer after every install, refresh or run, and again by
# autostart on. The app is an AppleScript applet, since osacompile's applet is Apple's own universal binary: an app
# whose main executable is a script can be taken for an Intel app on Apple Silicon, which asks to install Rosetta. It
# runs the omegahive script in its Resources with open, shows a failure's own words in an alert, and carries the brand
# icon and the hive's label as its bundle identifier. The login item runs that same script with login. A login item
# that already holds what would be written is left as it is, so a refresh never rewrites an item its owner turned off
# in Login Items. Time: one osacompile, ten sips resizes and one codesign, about two seconds.
register() {
  [ "$OS" = Darwin ] || return 0
  [ -f "$OH/installed" ] || fail "$OH holds no finished install; double-click Install OmegaHive.command again"
  # Made in build/register, which each run starts empty, then moved into place whole.
  work=$OH/build/register
  rm -rf "$work"
  mkdir -p "$HOME/Applications" "$work"
  new=$work/$APP_NAME.app
cat > "$work/main.applescript" <<'AS'
on run
	try
		set signinLink to do shell script quoted form of (POSIX path of (path to resource "omegahive")) & " link"
		if signinLink is not "" then open location signinLink
	on error errorText
		display alert "Omega Hive could not open your hive" message errorText as critical
	end try
end run
AS
  said=$(osacompile -o "$new" "$work/main.applescript" 2>&1) || fail "osacompile could not make $APP_NAME.app: $said"
  { printf '#!/bin/bash\n# Purpose: run omegahive.sh of the hive in this folder for its Omega Hive app and login item\n'
    printf 'export OMEGAHIVE_HOME=%q\n' "$OH"
    cat <<'SH'
script=$OMEGAHIVE_HOME/app/install/macos/omegahive.sh
if [ ! -f "$script" ]; then
  echo "No hive is installed in $OMEGAHIVE_HOME any more. Install Omega again, or move this app to the Trash." >&2
  exit 1
fi
exec /bin/bash "$script" "$@"
SH
  } > "$new/Contents/Resources/omegahive"
  chmod 755 "$new/Contents/Resources/omegahive"
  png=$OH/app/hive/ui/public/brand/favicon-512.png
  if [ -f "$png" ]; then
    mkdir "$work/omega.iconset"
    for s in 16 32 128 256 512; do
      sips -z "$s" "$s" "$png" --out "$work/omega.iconset/icon_${s}x${s}.png" >/dev/null || break
      sips -z $((s * 2)) $((s * 2)) "$png" --out "$work/omega.iconset/icon_${s}x${s}@2x.png" >/dev/null || break
    done
    # The asset catalog's icon would win over applet.icns, so it goes once the brand icon is in place.
    if iconutil -c icns "$work/omega.iconset" -o "$new/Contents/Resources/applet.icns" 2>/dev/null; then
      rm -f "$new/Contents/Resources/Assets.car"
    else
      say "The app keeps AppleScript's icon: iconutil could not make one from $png."
    fi
  fi
  "$OH/venv/bin/python" -I - "$new/Contents/Info.plist" "$LABEL" <<'PY'
import plistlib, sys
path, ident = sys.argv[1:3]
with open(path, "rb") as f:
    info = plistlib.load(f)
info.pop("CFBundleIconName", None)   # the icon is applet.icns (CFBundleIconFile)
info["CFBundleIdentifier"] = ident
with open(path, "wb") as f:
    plistlib.dump(info, f)
PY
  codesign --force --sign - "$new" >/dev/null 2>&1 || fail "codesign could not sign $APP_NAME.app ad hoc"
  rm -rf "$APP.old"
  if [ -e "$APP" ]; then mv "$APP" "$APP.old"; fi
  mv "$new" "$APP"
  rm -rf "$APP.old"
  # LaunchServices and Spotlight would find the app by themselves a little later; this makes it findable at once.
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
  say "Omega Hive is in your Applications folder ($APP), where Spotlight, Launchpad and the Dock find it."
  if [ "$(start_at_login)" = off ]; then
    remove_login_item
    say "Your hive does not start when you log in (omegahive.sh autostart on turns that on)."
  else
    "$OH/venv/bin/python" -I - "$work/login.plist" "$LOGIN_LABEL" "$APP/Contents/Resources/omegahive" "$OH" <<'PY'
import plistlib, sys
path, label, program, home = sys.argv[1:5]
with open(path, "wb") as out:
    plistlib.dump({"Label": label, "ProgramArguments": [program, "login"], "RunAtLoad": True, "Umask": 0o077,
                   "StandardOutPath": f"{home}/logs/login.log", "StandardErrorPath": f"{home}/logs/login.log"}, out)
PY
    if ! cmp -s "$work/login.plist" "$LOGIN_PLIST"; then
      mkdir -p "${LOGIN_PLIST%/*}"
      mv "$work/login.plist" "$LOGIN_PLIST"
    fi
    say "Omega Hive starts your hive when you log in, unless you turn it off in System Settings, General, Login Items."
  fi
  rm -rf "$work"
}

# Whether the hive starts when its owner logs in, kept in hive.env as HIVE_START_AT_LOGIN=off (on when absent), so an
# install or a refresh keeps the choice. macOS's own switch for the item in Login Items works beside it; on also lifts
# a launchctl disable of the item.
autostart() {
  [ "$OS" = Darwin ] || fail "starting at login is for a Mac hive"
  [ -f "$OH/installed" ] || fail "$OH holds no finished install; double-click Install OmegaHive.command again"
  case "${1:-}" in
    on)
      env_line HIVE_START_AT_LOGIN ""
      launchctl enable "$DOMAIN/$LOGIN_LABEL" >/dev/null 2>&1 || true
      register ;;
    off)
      env_line HIVE_START_AT_LOGIN off
      remove_login_item
      say "Your hive no longer starts when you log in. Open Omega Hive to start it." ;;
    status) start_at_login ;;
    *) fail "usage: omegahive.sh autostart on|off|status" ;;
  esac
}

# Takes the hive off this computer: stops it and every job it loaded, removes its login item and its app, then deletes
# its folder, minds, chats and keys included, only once its owner types that folder's path.
uninstall() {
  # No folder, no hive here: OMEGAHIVE_HOME names another place (it is ~/OmegaHive when unset). Say so, and remove only
  # what a folder deleted by hand leaves outside it, its login item and app, rather than report a stop or a removal
  # that never happened.
  if [ ! -d "$OH" ]; then
    if [ "$OS" = Darwin ] && { [ -f "$LOGIN_PLIST" ] || [ -e "$APP" ]; }; then
      remove_login_item
      if [ -e "$APP" ]; then
        "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
        rm -rf "$APP"
      fi
      say "No hive is installed in $OH. The login item and $APP it left are removed."
      return 0
    fi
    fail "No hive is installed in $OH, so there is nothing to remove. Set OMEGAHIVE_HOME to the hive's folder."
  fi
  halt
  say "Your hive is stopped."
  if [ "$OS" = Darwin ]; then
    remove_login_item
    if [ -e "$APP" ]; then
      "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
      rm -rf "$APP"
    fi
    say "Its login item and $APP are removed."
  fi
  printf "Your hive's minds, chats and keys are still in %s.\n" "$OH"
  printf 'To delete them as well, type that path and press Return; press Return alone to keep them: '
  answer=""
  read -r answer || true
  if [ "${answer%/}" != "$OH" ]; then
    say "Kept $OH."
    return 0
  fi
  case "$OH" in ""|/|"$HOME"|"$HOME/") fail "$OH is not a hive folder this deletes" ;; esac
  rm -rf "$OH"
  say "Deleted $OH."
}

case "${1:-open}" in
  run) run ;;
  core) core ;;
  serve) serve ;;
  signin-url) signin_url ;;
  start) start ;;
  open) open_hive ;;
  link) app_link ;;
  create) create ;;
  stop) stop ;;
  status) status ;;
  login) login_start ;;
  autostart) autostart "${2:-}" ;;
  register) register ;;
  uninstall) uninstall ;;
  *) fail "usage: omegahive.sh [open|start|stop|status|login|autostart|register|uninstall|create|run|serve|signin-url]" ;;
esac
