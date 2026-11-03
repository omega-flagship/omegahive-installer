# Linux installer reliability follow-up

Issue: [#5](https://github.com/omega-flagship/omegahive-installer/issues/5).
Related: [slow startup #2](https://github.com/omega-flagship/omegahive-installer/issues/2)
and [installer follow-up #4](https://github.com/omega-flagship/omegahive-installer/issues/4).
Prepared with AI assistance at Nebiyu Samuel's request. This is a sanitized
incident summary and source-change report, not a new release qualification.

## Observations and fixes

The real-server trial used Ubuntu 22.04 x86_64 and systemd. The r12 release URL
served r13 installer bytes (SHA256 prefix `191344a8`). Local test variants and a
bootstrap recovery helper were used during diagnosis; they are not published
release qualifications. The user ultimately confirmed successful browser sign-in,
but described it as fragile.

| Observed issue | Evidence and scope | Change |
| --- | --- | --- |
| Sudo could not read a password | Detached child sessions had no controlling terminal; the outer shell also consumed stdin. | Open the parent's foreground terminal explicitly and pass it directly to `sudo -S`; restore terminal settings on return/cancellation. No password enters Python, argv, or a log. Up to three prompts replace the unreliable single cached authentication. Without a terminal, run each command once with `sudo -n`; never retry a possibly executed command. |
| Retry rejected permissions | An existing `.config` directory was group-writable; late recovery checks discovered it after setup began. | Check existing launcher/service ancestors before setup effects and identify the rejected path. Keep ownership/symlink/write-permission checks; do not automatically chmod shared directories. |
| Hidden package prompt | Package configuration reached needrestart's service-selection question while stdout was logged. | Set `DEBIAN_FRONTEND=noninteractive` and `NEEDRESTART_MODE=l` only for the fixed apt install command. No global configuration/sudoers edits and no needrestart-driven service restarts; ordinary package maintainer behavior remains unchanged. |
| Cleanup failure | The installer reported that child processes could not be fully stopped. The exact cause was not established; subsequently listed sudo processes belonged to unrelated work. | Account for other process groups in the held session before declaring cleanup complete. Permission-denied cleanup identifies the held session and refuses; no name-based killing or post-reap signalling. Root-descendant cancellation still needs real-VM qualification. |
| Readiness timed out | Bootstrap allowed 15 seconds; journal timestamps showed about 97 seconds to readiness. The running process later passed local-owner control identity checks. | Allow 180 seconds for initial and post-restart hello; stop on dead-unit/identity failures, retain cancellation, and bound the whole bootstrap to 480 seconds. Use validated hello and a new instance after restart. |
| Retrying rebuilt a usable runtime | An activated runtime remained running after bootstrap failure; this matches #2. | Rerunning the same installer verifies recorded source identity, directory identity, artifact pins, source inventory and paths before reusing runtime/venv and resuming bootstrap. Refuse changed or cross-release state. Preserve data/cache/logs. Earlier, pre-activation partial builds keep their existing cleanup/rebuild behavior. |
| Status blocked by incomplete setup | The installed wrapper refused all commands except uninstall. | Allow status, stop and tunnel after activation, with an incomplete-setup notice on stderr. Keep open blocked until configuration completes. |
| Link expiry / misleading invite page | One-use links expired during tunnel/browser setup. A generic signed-out UI showed Google-invite messaging. Browser sign-in ultimately succeeded; no auth bypass or persistent session defect was demonstrated. | Add token-free `omegahive tunnel`; automatic headless handoff prints guidance without minting a link. Keep explicit open behavior, 60-second TTL, one-use semantics, exact origin and identity checks. Explain fragment/origin handling. Mark configuration complete before browser handoff so a browser error does not trigger rebuilding. |
| Python and uv warnings | The exec_prefix and experimental build-hash warnings appeared before later stages continued. | Do not treat them as the demonstrated cause; no unrelated dependency/runtime changes. |

## Compatibility and boundaries

- Runtime, release and installation-state schemas are unchanged; completed
  installation-state versions 1 and 2 remain readable.
- Existing `open`, `status`, `stop`, `uninstall`, desktop handoff and explicit
  non-TTY `open` remain supported. `tunnel` is additive.
- The intended behavior change is that automatic headless setup never issues a
  code. Establish forwarding first, then explicitly run `open`.
- No legacy installed release is silently rewritten or upgraded. Resume requires
  the same catalogue/release/source and validated files. Older installed managers
  are not hot-patched by this PR.
- The bundled prebuilt UI is separately pinned. This PR improves the installer
  handoff; it does not change that UI's generic Google-invite fallback.
- No released binary, host sudo policy, service restart policy, provider
  credential or authentication lifetime is changed. Release builders must create
  a new artifact and regenerate its inventories; bootstrap's control pin is
  updated with its source.

## Validation

Run from the installer repository root, as an ordinary Linux user:

```sh
(umask 077; python3 -B -m unittest discover -s release/deploy/linux -p 'test_*.py')
```

All 218 local tests pass. CLI help smoke checks, shell syntax and diff whitespace
checks also pass; the bootstrap control-source pin matches the source bytes.
The local suite covers installer/bootstrap/catalogue/front-door behavior and
real unprivileged PTYs/detached children with fake sudo. New checks cover a
97-second first start and restart under a simulated clock, cancellation and
bounded expiry, foreign identity refusal, no-token tunnel guidance, terminal
input not echoed/logged, timeout/EOF/Ctrl+C restoration, safe retry without apt
or compilation, changed-file refusal, incomplete status, and session-wide
process accounting. Local execution uses Linux/Python 3.14; it is not a fresh
Ubuntu/PAM/provider/browser end-to-end run.

Before publishing a new artifact, validate on a disposable Ubuntu 22.04 x86_64
VM with password-protected sudo and needrestart installed:

1. First install, all three privilege steps, and no hidden package prompt.
2. Cold startup delayed beyond 15 seconds, then the bootstrap-triggered restart.
3. Interrupt after activation; rerun the exact artifact and confirm no dependency
   rebuild, data loss, duplicate template or unintended agent wake/model call.
4. Ctrl+C/timeout during package work: verify root descendants and locks are
   gone or explicitly reported unresolved. Never kill unrelated sudo processes.
5. Tampered source/entrypoint and group-writable ancestors fail before new effects.
6. Establish the printed tunnel, request a fresh link, and complete browser
   sign-in; verify expired/reused/wrong-origin links still fail closed.
7. Completed installation status/open/stop/uninstall and existing schema readers.

Two independent non-author reviews are required before merge by the repository's
contribution rules. No live-release replacement or merge is part of this change.

## CI follow-up

The first PR run stopped at the release-tree integrity check: the source changes
had not been reflected in `ci/RELEASE_TREE`. The prepared CI follow-up provenance files identify
the commit containing this release subtree and its exact tree hash. The integrity
check remains enabled. The prepared source-install job runs all installer tests as a
required step and grants its disposable user only the exact apt
command with a command-scoped allowance for the two fixed environment values and linger command. Historical binary-kit jobs are unchanged.

## Review follow-up

MesTTo's review identified a passwordless/no-terminal regression, restricted-sudo
compatibility, a PTY baseline race, and the limits of the passing historical-kit
jobs. The source changes support NOPASSWD without a terminal, remove the env
wrapper, document the restricted-policy prerequisite, and synchronize the test
child before capturing terminal attributes. Permission refusals now include a
specific manual remedy without relaxing the security boundary.

The release-tree check must remain enabled. Moving the source provenance records
is a proposed CI candidate update, not a release declaration; Jon must confirm
that provenance approach or build a successor artifact before merge. The old kit
jobs do not qualify this code. The workflow follow-up may require the App's
Workflows write permission before it can be pushed.

## Follow-up diagnostic issues #8 and #9

Terminal sudo stderr is now copied to the private log while remaining visible at
the terminal. Password stdin is never captured; prompts may be logged. The PTY
regression verifies the same synthetic sudo error appears in both outputs and
that synthetic password input appears in neither.

Process snapshots now allow 10 seconds, with a separate bounded 30-second cleanup
budget. Command failure is recorded before the snapshot, and cleanup failures
are secondary diagnostics with an explicit unresolved-cleanup warning. Bootstrap
prints its readiness timeout by name while preserving the structured failure
receipt. Regressions cover a real snapshot delayed beyond two seconds, primary
failure preservation, cleanup failure, and secret-safe bootstrap messages.
