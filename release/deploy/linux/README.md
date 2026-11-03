# OmegaHive Linux front door

This self-contained module has no Hive imports. `installer.sh` is the one-file
download template; `install.py` installs and dispatches `omegahive open`, `status`,
`stop`, and `uninstall`. The separate control/serve/unit files implement the
reviewed local-owner handoff. This Source is unrun and its release catalogue is
deliberately disabled.

The final published script must contain a complete reviewed bundle, its byte
count and SHA256, and `ROOT_BOUND_RELEASE=1`. Download it over the owner's
published HTTPS origin to a file, then run that file as the ordinary Ubuntu
user. No URL is published by this Source packet. A checksum embedded in a script
checks the payload; it does not authenticate a script obtained from an untrusted
origin. Never pipe an unverified remote body into a shell.

The bundled `studio-linux-user-release/2` catalogue must be `ready: true` and bind the exact current
source tree, positive file inventory, every platform artifact, both hash locks,
both app archives and their canonical program digests, the complete L0 module,
the prebuilt UI archive/manifest and its separate build-source commit/tree,
the reviewed OpenRouter model, and the normal-owner bootstrap helper/seed. The
template keeps these unknown fields null. It refuses before apt or a password
prompt. Both x86_64 and aarch64 package sets must be complete.

Each platform's `source_payload.prefix` must explicitly name the same single
canonical archive-root component, with no slash or trailing slash. It must equal
the kit's `github.source_prefix`. The installer never infers or strips a guessed
first component. It verifies every directory/file beneath that literal prefix,
then writes only the exact root-relative inventory. Optional directory entries
must be the prefix root or ancestors of declared files and contain no data.
Extra paths, links, duplicates and file/ancestor collisions are refused. The raw
source tarball is never repacked or modified by this contract.

The reviewed r2 archive's L0 module inventory is retained as baseline evidence.
The final r3 archive still needs its own exact inventory before release. Required module hashes
must match that tree; missing/different modules refuse. Nothing is injected into
or substituted for the selected release tree to make this condition pass.

Only the fixed package and linger commands are elevated. Each may prompt through the controlling terminal; passwords never enter Python or the install log. Package configuration is noninteractive and needrestart is list-only for that command, without changing system policy. There are no root
application folders, builder accounts, global pip changes, global loader edits
or privileged service files. Runtime archives are SHA256 checked before use;
CPython's exact python-build-standalone archive is pinned separately from uv.
uv creates the private environment and syncs the hash-locked closure of the six
Hive base roots plus the explicitly reviewed Janus bridge and every other
current application requirement/constraint, including its frozen Google closure.
The unrelated repository-root ML requirements are not installed. Build dependencies are separately hash constrained. If uv creates
a symlink for the environment's Python,
the installer replaces that one symlink with the reviewed executable bytes as a
regular file. Its path remains inside the environment next to `pyvenv.cfg`;
resolving a symlink to the base interpreter would lose the installed environment.
The live service and sandbox both select this canonical environment executable.
SWI is built
into the same versioned home release, then the existing bridge directions are
checked before the service starts. Exact selected uv support for the flags,
CPython/SWI compatibility and both platform locks require actual Linux checks.

The installer refuses unsupported Ubuntu releases, root, unsafe home paths,
missing Landlock ABI, failed user namespace isolation, insufficient disk,
modified archives, an existing installation and an unreviewed Studio seed.
Module pins must join both platform Source vectors before sudo. Both dependency
lock bodies are checked for exact version/hash syntax before sudo. curl ignores
ambient configuration and proxies, follows at most three HTTPS-only redirects,
and checks the final pinned bytes before use.
Directories, descriptor, lock and logs are private. Child output goes to the
private install log, which is never dumped on failure. Progress is a few friendly
lines. Linux waitid(WNOWAIT) retains each original session leader until a bounded
numeric ps snapshot shows it is the sole zombie in its owned session, including descendant process groups.
Failed/timed-out steps clean that held group before reaping; cancellation does
not interrupt cleanup. No post-reap numeric signalling is permitted. Numeric
snapshots stay in memory and export no process table. Failed cleanup remains
unresolved; no OS containment or escaped-process guarantee is made. Privileged
apt and descendant cleanup require actual disposable-VM checks. Failed logs and
attempt records are retained. A rerun resumes final configuration of an activated, verified release. Only earlier partial builds follow the existing recorded cleanup/rebuild path.

The descriptor has the exact 17-key product-R2 runtime shape. Data is always the
real account's `~/.local/share/omegahive/data`. No ambient provider key, default
model, identity setting or loader path is inherited. A reviewed non-mock
OpenRouter selection reaches FirstLight before its first personal row; the user
adds their own key through the normal UI. An explicit `mock/hash` embedding
choice makes no real embedding claim. A headless host must bind an actual
non-secret SSH destination; the control module gives its safe tunnel guidance
before issuing any one-time code. Full authenticated headless handoff remains a
separate qualification requirement.

Only control.open receives the narrow display/Wayland/Xauthority context; the
control module validates those values.
The downloaded-script bootstrap preserves those same three GUI values into the
installer, so they remain available for its initial control.open. It passes no
provider credential, loader override or ambient bus configuration to that child.
User-manager calls derive the private
`/run/user/UID` bus instead of inheriting ambient D-Bus configuration. The sole
trusted PBS library directory reaches the unit through its sixth loader token,
the manager shim and the control interpreter before ELF startup. No ambient
loader/preload path is appended. This requires the companion product-R3 unit and
serve/control agreement; product-R2 cannot be substituted.

App ZIP checks alone do not prove live admission. The separately reviewed
bootstrap helper must use same-UID, one-use signin, memory-only owner credentials
and the normal authenticated program/agent routes, verify the live Assist/Studio
pins and create the exact owner-reviewed inactive Studio maker template. It then
atomically records the returned ID and restarts once. There is no direct store
write, fake host import, manual validation marker, invented empty template or
automatic consent grant. That helper and exact seed remain pending inputs here.

`~/.local/bin/omegahive open` first starts the fixed user service idempotently,
then calls the secret-safe local control client. Installation enables the unit
for future user logins. `stop` stops only that unit. `uninstall` stops and disables
it, removes the shim before the selected
runtime and state so a partial failure cannot leave a dangling entry point, and asks before deleting conversations/data. It preserves data unless
the user explicitly types `DELETE`; caches/logs and unrelated releases remain.

Own tests are in `test_install.py` and are Source only. They use synthetic
archives, temporary home paths and fake command dispatch; they install nothing.
Fresh Ubuntu install → signed-in FirstLight → owner-key conversation → tiny-cap
Assist/Studio → stop/open/uninstall, screenshots and timings are still NOT_RUN.


R7 ships a prebuilt host UI. Neither Node nor npm is required, fetched or executed
on the user's machine. `ui_prebuilt` has exactly `archive`, `manifest`,
`source_revision`, and `source_tree`; the first two are local path/byte/SHA256
artifacts. The pinned raw manifest format is `omegahive.ui-prebuilt/1`, with a
relative dist-file dictionary of byte counts and SHA256 values. Its source commit
and tree describe the UI build, independently of later deploy-only host changes.
The fixed archive root is `dist/`; no user-supplied prefix is accepted. Every
file, directory, size and hash is checked before sudo, with no extra files, links,
collisions or missing entries. The new exclusive destination is `hive/ui/dist`.
The exact manifest and a small separate host/UI provenance record remain inside
the selected release. Descriptive `built_with` text is data and is never run.

The rendered user unit is checked with `systemd-analyze --user verify` before
manager/shim/state creation and before `daemon-reload` or `start`. Failure stops
setup with a plain message and retains the private log. Generated home/service
paths containing percent signs are refused. The closed catalogue/two-architecture
release expectations are not a shortcut for the separate internal ARM demo.

The current installer file contains44 authored tests, including all34 prior
identities and focused prebuilt-integrity/no-Node/service/DELETE regressions.
Those are Source declarations only: no unit, installer, Linux journey, model or
provider execution is implied by this Source change. Older failed and not-run
receipts stay associated with their exact older Sources.

## R8 restart and incomplete setup recovery

The final lines show `~/.local/bin/omegahive open`, which works in the current
terminal even before `~/.local/bin` is on PATH. After signing out and in, a new
terminal can use `omegahive open`. `status` is plain text by default;
`omegahive status --json` is the explicit safe machine-readable form. Open's
control invocation is bounded to210seconds; the control client separately owns
its bounded hello-only readiness wait and single sign-in request.

Before release extraction, `install-progress.json` records one exact release
identity/inode and fixed artifact kinds with permitted content hashes. A small
recovery command uses Ubuntu's system Python until the private interpreter is
ready. After interruption, rerun the exact same complete installer. If activation wrote
its installation state, the installer verifies the release identity/inode, fixed
owned-file pins, runtime paths and complete source inventory before resuming bootstrap.
It keeps the runtime, venv, data and caches; changed files fail closed. Earlier
partial builds without activation state retain the recorded cleanup/rebuild path. `~/.local/bin/omegahive uninstall` also removes that
recorded partial setup and always keeps data, caches, logs and unrelated releases.
Unknown legacy folders or changed records/files are kept and reported for review;
there is no inferred ownership or arbitrary path deletion. The record stays
uncommitted through bootstrap and the final control check; success retains a completed
record and retires the recovery marker before browser handoff. A browser failure
therefore does not turn a configured runtime into an incomplete installation.
`status`, `stop`, and `tunnel` remain available after activation while setup is
incomplete; `open` asks the user to finish configuration first. Runtime and
installation-state schemas remain unchanged.

The unit keeps `Restart=no`: login enablement and explicit open recovery address
B1 without adding automatic crash loops. No unattended boot-before-login promise
is made. B4 headless authentication and B5 UI labels remain separate work. The C2
phrase “Nothing was sent anywhere” is deliberately omitted: downloading runtimes
and packages is networked. Failure copy names the private log without making an
unsupported privacy or data-safety guarantee.

All44 prior installer test IDs remain. Added regressions cover service start,
explicit status JSON, full mocked failure→rerun lifecycle, partial uninstall,
foreign/replaced/symlink targets, changed pins, retained data/cache/logs/releases,
disk-number copy and password/return advice. These are authored Source only; no
new tests or Linux install have run for R8.

## SSH sign-in and slow startup

Initial and post-bootstrap restart readiness each allow 180 seconds. Parent
bootstrap and open budgets cover their child waits. A dead unit or foreign
identity fails closed; only transient hello failures retry. Readiness does not
mean sandbox qualification or successful browser authentication.

On a headless installation the automatic handoff never mints a short-lived link.
Run `~/.local/bin/omegahive tunnel` to print the loopback-only forwarding command,
start that tunnel on your own computer, then run `~/.local/bin/omegahive open` on
the server. Open the complete link immediately, retaining `127.0.0.1`, port 8701,
and its fragment. Codes still expire after 60 seconds and remain single-use.
Do not switch to `localhost` or another port: browser storage is origin-specific.
The generic Google-invite fallback is not the local-owner sign-in flow.

Existing commands, explicit non-TTY `open`, desktop handoff, and old completed
installation-state formats remain supported. These source changes require a new
reviewed bundle and regenerated pins; do not edit an installed pinned release
or overwrite a previously published asset. Resumption is limited to matching
release/source identity, not an in-place upgrade across releases.

Regression evidence and the remaining real-VM qualification are recorded in
`docs/trials/2026-10-29-installer-reliability.md` at the installer repository root.

## Sudo compatibility and directory permissions

With a foreground terminal, sudo reads directly from that terminal using `-S`;
NOPASSWD rules do not prompt. Without a controlling terminal, the same fixed
command runs once with `sudo -n` and stdin closed. No `sudo -v` probe is used and
no failed command is retried: sudo and its target can share exit codes, and the
target may already have made changes. A password-requiring install needs a
foreground terminal (`ssh -t`); cloud-init and mixed sudo-group/NOPASSWD rules
remain usable when the fixed commands are authorized without a password.

The package command uses sudo's environment assignments followed by the actual
`/usr/bin/apt-get` executable, not an `/usr/bin/env` or shell wrapper. Standard
sudo `ALL` policies normally allow these assignments. A restricted policy must
explicitly permit the two fixed values; an administrator can use this
command-scoped sudoers default alongside the existing apt command authorization:

```sudoers
Defaults!/usr/bin/apt-get env_keep += "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l"
```

Validate policy edits with `visudo`. This does not authorize apt by itself and
needs neither unrestricted `env` execution nor a broad `SETENV` grant. The installer
never edits sudoers or silently drops the noninteractive package settings when a
restricted policy refuses them. CI uses exact apt and linger argument lists.

Group/world-writable paths remain refused, including Ubuntu's commonly created
0775 `~/.config`. For user-owned paths the error prints a shell-quoted
`chmod go-w -- PATH` suggestion, conditional on that path being intended private.
It does not automatically change shared-directory permissions or assume that a
private group will remain private.

## Failure diagnostics

For terminal-authenticated system steps, child stderr (including sudo errors) is
copied to both the terminal and the private setup log. Password input still goes
directly from the terminal to sudo and is never read or logged by Python. Prompts
may appear in the log; no terminal-input capture or shell tracing is enabled.
Process snapshots allow up to 10 seconds, within a separate 30-second cleanup
budget. A failed command is recorded before process verification; a subsequent
snapshot or cleanup failure is reported as secondary and never implies that all
children stopped. Bootstrap names a control-readiness timeout explicitly in its
stderr diagnostic, alongside its existing structured failure receipt.
