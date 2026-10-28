# L0 private Linux frontdoor contract (CONTEXT_CF40)

Self-contained deploy/linux module; its test_frontdoor.py uses stdlib only and imports no Hive module. Source implementation only. No Linux execution or current3a07 reconciliation has
occurred. These files do not implement J1d system setup, an updater, L1 deployment,
an app install/review bypass, an SSH proxy or a public listener.

The installer owns exact release/runtime/app pins, private-directory creation,
fresh-data initialization under the existing marker contract when required,
descriptor creation, unit rendering and the user-service lifecycle. It installs
all four files from this directory together, without changing their bodies.

## Descriptor

The sole descriptor is the OS account's
`$HOME/.local/share/omegahive/runtime.json`, where HOME comes from pwd, not the
caller's environment. It is a plain single-link current-UID0600 file, at most
64KiB, inside a current-UID0700 directory. JSON rejects duplicate/nonfinite data.
All18 keys are mandatory; no extra keys or secrets:

| Key | Value |
| --- | --- |
| schema | `studio-linux-user-runtime/2` |
| runtime_root | Exact canonical versioned folder under the installation's `releases/` |
| release_root | Exactly `runtime_root/app`, containing the reviewed Hive source |
| python | Named venv executable; canonical target remains inside runtime_root |
| petta_path | Exact canonical PeTTa folder inside runtime_root |
| data_dir | Exactly OS-pwd HOME/.local/share/omegahive/data, canonical current-UID0700; never adopted/deleted here |
| port | JSON integer exactly8700: the hive/API listener and original sign-in URL |
| browser_port | JSON integer exactly8701: the second browser Host/Origin port; not a second listener |
| sandbox_python | Canonical plain executable inside runtime_root; no symlink |
| source_revision | Full40lowercase owner commit; descriptor custody is not Git validation |
| plugin_dirs | At most16 unique canonical directories inside runtime_root |
| app_pins | At most16 canonical HIVE_APP_PINS records; release/digest/files only, no env payload |
| swipl_bin | Exact executable file inside runtime_root, not its bin directory |
| libpython_dir | Exactly canonical runtime_root/runtime/python/lib, or explicit null for a separately verified RPATH-only runtime |
| studio_maker_template | null on first start, then the normal admin route's existing Omega mind id (`a_<8hex>`); never invented |
| default_model | Explicit non-mock openrouter/openai/anthropic model id; no credential |
| embedding_model | Explicit model id, or mock/hash with that scope stated |
| ssh_target | Nonsecret validated user@reachable-linux-host for exact SSH guidance, or explicit null (unconfigured) |

Files/directories and ancestry must not be writable by another account; selected
runtime folders must belong to the account. Named venv Python may be a leaf link
to the managed Python inside the same bundle. No ambient uv cache is accepted.
App pin `digest` is `sha256:<64hex>`; optional `files` has at most512 safe relative
names and SHA256 values. Pin releases must lie within declared plugin dirs. Hive
performs its existing digest/review checks; this launcher does not grant consent.

`serve.py --runtime <descriptor>` builds a new explicit environment and execs
the selected venv Python as `-B -m hive` from release_root. The stdlib launcher
itself runs as `python -I -B serve.py`. It checks the unit's
HIVE_SANDBOX_PYTHON agrees with the descriptor, then drops inherited environment.
The new environment has loopback/local-owner/sandbox enabled, explicit model choices,
exact data/PeTTa/plugin paths, required app pins and scoped PATH. The sole optional
loader value is the descriptor's LD_LIBRARY_PATH; no inherited suffix survives.
No provider/Google identity secret, PYTHONPATH/PYTHONHOME or ambient HIVE setting
is copied. Provider setup remains the existing First Light/private key flow.

## User unit and installed command

Render `omegahive.service.in` to
`$HOME/.config/systemd/user/omegahive.service`. No root system unit, User/Group
creation. The single privileged phase also runs exactly `sudo -n /usr/bin/loginctl enable-linger <user>` (user from
the kernel uid) so the user manager, and with it the hive, keeps running after logout and starts at boot. Uninstall
leaves linger on (other user services may rely on it), runs no sudo, and prints the one `disable-linger` command. Restart is off for first L0 acceptance; the unit
retains `KillMode=control-group`,30second stop,umask0077 and no core dumps.

Exactly six placeholders exist: PYTHON is the named descriptor Python, SERVE
the installed absolute serve.py, RUNTIME the fixed descriptor, WORKDIR the
release_root, and SANDBOX_ENV the whole
`HIVE_SANDBOX_PYTHON=<sandbox_python>` token. LIBPYTHON_ENV is the whole
`LD_LIBRARY_PATH=<libpython_dir>` token (an empty value for explicit null). Each replacement is one systemd
quoted value: reject NUL/CR/LF/control characters, escape backslash/doublequote,
and reject percent signs in generated paths. Do not interpolate a shell. Refuse leftover
tokens. The installer owns safe rendering and only fixed daemon-reload/enable/start/stop/disable
commands. Do not turn these Source templates into implicit operations.

The installed `omegahive open|status` dispatcher executes the selected Python
as `-I -B <installed-control.py> --runtime <fixed-descriptor> open|status`.
This control client never starts/stops/installs/deletes services or data. The
installer dispatcher separately owns enable/start/open recovery and stop/uninstall behavior.

## Authentication and browser

Before every request, the client verifies private data/run/socket ownership and
mode, queries fixed `systemctl --user show -p MainPID --value omegahive.service`,
connects and reads Linux SO_PEERCRED, then queries MainPID again. PID and UID must
match; canonical `/proc/PID/exe` must be the selected canonical Python inside the
selected bundle (the canonical-current comparison, not a literal `/current/`
prefix). It queries again after the reply. No PID file or discovery is used.
The service manager output is bounded4096bytes/3seconds; socket reply64KiB/5seconds.
The chosen versioned bundle is the active L0 selection; no updater/symlink
promotion is implemented by these files.

Only hello and signin operations exist. `status` prints plain running text;
explicit `status --json` prints a small safe identity summary, never raw
preflight/credentials or Linux qualification. Explicit `open` waits for the
existing supervised hello identity, requests exactly one sign-in code, and
validates the same closed reply: a43-character code, expires_in exactly60,
and the exact ORIGINAL `http://127.0.0.1:8700/local-signin#CODE` service URL.
Only after that validation does headless output change the port to8701, retaining
the same host, path and code fragment. The desktop URL stays8700.
Only hello readiness can retry; a sign-in request is never automatically retried.

With a local graphical DISPLAY/Wayland session, `open` keeps the existing fixed
root-owned `/usr/bin/xdg-open` handoff without a shell. The URL is an ephemeral
opener argument; opener output is discarded and its timeout is5seconds. No
reusable browser token enters the client. Success means handoff requested, not
completed sign-in.

With no display, explicit `omegahive open`, including SSH/non-TTY invocation,
prints the loopback-only tunnel command before minting, then prints the validated
one-use link with instructions to open it on the user's own computer within a
minute, and exits0. The tunnel binds `127.0.0.1:8701:127.0.0.1:8700`; a configured
ssh_target is used, or clearly marked `<you>@<this-server>` placeholders must be
replaced. No reachable host is invented. The response and link references are
cleared after printing, including failure paths; this is not memory zeroization
or terminal scrollback erasure. The explicit caller must handle this sensitive
output securely and must not retain the real link in install logs or diagnostic
receipts. If link printing fails, the fixed message is "Your sign-in link couldn't
be shown. Run omegahive open again." No exception text or link is included. Printing a link proves neither a tunnel nor authenticated browser state.

The installer's automatic final handoff uses `--defer-headless-signin` only when
headless AND stdout is not a real TTY. It then prints nonsecret tunnel/rerun
instructions, issues no sign-in code and exits0, allowing setup to finish under a
capturing harness. Only stdout decides: terminal stdout with piped stdin, such as
interactive curl|sh, keeps the ordinary handoff; desktop behavior is unchanged.
`console=True` bypasses the install log but does not itself prevent parent capture.
The defer flag is accepted before or after `open`; it is invalid with `status`.

The service still listens only at127.0.0.1:8700. `serve.py` explicitly sets
`HIVE_LOCAL_BROWSER_PORT=8701` from the closed descriptor after dropping inherited
environment. The existing localowner.ports() seam admits only the configured8700
and8701 Host/Origin ports;8702 remains refused. No extra listener or general port
allowance is added. Browser fragment removal and same-Origin exchange remain
the existing route contract.
Actual secure `ssh -L` plus exchange/browser validation is still required; this
Source update does not claim that real tunnel/sign-in proof.


Current same-UID malware/root remain outside the stated boundary. This is not
OS containment, a complete runtime closure, a browser qualification, paid-model
permission, First Light success or Assist readiness. Missing display/X authority,
user bus, unsupported system program/layout, occupied port, sandbox failures and
unsafe ownership remain actionable failures for actual Linux validation. No
implicit fallback, automatic reissue, password route or consent bypass is added.

## One first-boot template seed (normal host authority only)

The descriptor initially contains studio_maker_template:null. The installer
bootstrap must use a real named local-owner admin session and normal POST/api/agents
to create the exact reviewed Omega template, asleep. No direct database writes,
private Hive imports, fake Hive object or implicit paid run. After successful
normal-route readback, installer atomically replaces the0600 descriptor with the
actual id and restarts the same user service once. serve.py then sets only that
HIVE_STUDIO_MAKER_TEMPLATE value. Existing host code validates the id/kind and
refuses a personal mind. Role/persona/tools/budget seed content is a separate
reviewed owner input, still pending. P14 install reviews remain named-admin acts.

The existing control hello does not expose program load/digest. Real
GET/api/programs and GET/api/programs/{id} via the same normal authenticated
bootstrap are the available readback seam; do not fabricate _load qualification.
No bootstrap credential-exchange/API helper is implemented in this four-file
frontdoor module. That narrow additional task requires Root assignment.

## Product R2: real personal model and exact private data

The data path is fixed under the real OS account home, not any UID-owned0700
folder. Both validators and every control request enforce that exact path.
Other runtime/plugin/loader paths remain within the selected home-owned bundle.

The installer must select a real default_model before the first startup. serve
sets BOTH HIVE_DEFAULT_MODEL and HIVE_ASK_CONDUCTOR_MODEL from that field. Context
personal.py76–78/137–140 uses the conductor/default for a NEW personal mind,
created asleep; it does not spend just because a model is named. No existing
mock row is silently edited by the launcher. First Light preflight279–323 then
requires a priced real provider, the person's paying key, and the normal budget
gates before wake; local/mock bypass292–293 cannot qualify a real conversation.
The ordinary person adds the key/monthly limit through existing host routes.
No ambient key or unpriced/budget bypass is enabled. embedding_model is explicit;
mock/hash remains permitted for embeddings only and grants no embedding result.

Actual acceptance must read the live personal mind's non-mock model and own-key/
cap status, then retain the actual provider call and tiny-cap conversation. A
control hello/preflight/browser-handoff report is not that evidence. Current
Source3a07 reconciliation and the real key/cap journey are still NOT_RUN.

## Product R3: private loader environment before ELF startup

The unit renders the sole trusted LD_LIBRARY_PATH BEFORE starting the selected
Python. It clears LD_PRELOAD/LD_AUDIT/PYTHONPATH/PYTHONHOME using UnsetEnvironment.
The installer dispatcher and every selected-Python control/bootstrap invocation
must provide the same closed loader environment before exec; setting it only
inside serve.py is too late to help the launcher's own ELF startup. Both control
and serve then validate exact descriptor agreement before using the service.
This late check does not claim it can undo a loader that already ran.

The only nonnull directory admitted is runtime_root/runtime/python/lib: the
managed PBS archive destination inside this exact selected release. Its archive
and content custody are the installer's reviewed catalogue/runtime responsibility;
this path check alone is not complete native-library closure proof. No colon
append, system loader file, global loader mutation or ambient directory is used.
Null requires an explicitly qualified RPATH-only runtime and renders an empty
LD_LIBRARY_PATH; missing actual runtime pins never become that qualification.


## R7 installer integration

R7 retained the seventeen-key schema/1 descriptor. R11.1 uses the closed eighteen-key
schema/2 descriptor with fixed service8700 and browser8701; the control/serve loader
and identity checks remain in force. The installer ships verified prebuilt `hive/ui/dist`
from its separately pinned UI source commit/tree; host deploy-only changes may
have another source identity. No Node/npm install, prerequisite or build runs
on the user's machine. UI artifact/build-source metadata is retained separately
from the descriptor, without introducing environment, credential or authority fields.

The installer validates the rendered unit using `systemd-analyze --user verify`
before daemon-reload/start, refuses percent signs in generated home/service
paths, and removes its shim before runtime/state deletion. A failed validator
never starts the service. No runtime/FirstLight/paid-model qualification follows
from Source-only integrity checks or mocked unit declarations.

The companion R7 control change uses an explicit local SSH bind:
`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:<port>:127.0.0.1:<port> <user@host>`.
The actual code change belongs to the separately reviewed control successor.

## R8 journal contract

`install-progress.json` is a small no-follow current-user record with closed
keys: schema,attempt,release_id,source_revision,source_tree,runtime_identity,
owned_files. It contains no authentication/session/provider values. Artifact
kinds resolve only to the fixed unit,manager,shim,state paths; the record cannot
provide a deletion path. Planned hashes are durable before writes/replacements.
Only the shim may have two permitted bodies (system-Python recovery and final
private-Python dispatch). The release has an exact device/inode recorded before
extraction; the creation-to-record window permits removal of an empty directory
only. Recovery validates every target before its first service command/deletion,
refuses links/replacements/unrecorded files, retains an immutable failed-attempt
snapshot, and keeps all data/cache/logs and unrelated releases. A complete
installation without a recovery marker retains the normal typed DELETE prompt.

The installation lock serializes install and command/recovery operations. The
progress marker is retired only after bootstrap/status/browser handoff succeeds;
its completed snapshot remains in logs. Source tests mock all privileged,
service,download,build,application and browser operations. No runtime or release
qualification is granted by this Source.

R8 complete installation records use studio-linux-user-installation/2 with an exact manager_pin. The fixed manager is validated and retired during uninstall so the same reviewed release can be installed again. Existing schema/1 records remain readable; unrecorded legacy manager files are never guessed to be owned.
