# OmegaHive status

State of this repository on 2026-10-20. It was first handed over on 2026-10-10 from live release
**5617f4e**. Since then it has been brought up to the release live on the cloud hive on 2026-10-20 (private release
`5617f4e` to `e5103fb0`, plus host round R8.4, live as `5e204019`). What changed is in
[Live since the handover](#live-since-the-handover-2026-10-10-to-2026-10-20) below and in
[`CHANGELOG.md`](CHANGELOG.md). The dated done/to-do log is in [`docs/STATUS.md`](docs/STATUS.md), and the
2026-10-09 feature list is in [`docs/FEATURES.md`](docs/FEATURES.md).

## Live since the handover (2026-10-10 to 2026-10-20)

- **Studio live drawing and co-edit** (host rounds J3 R4 to R8.4). A person directs a Studio maker that draws on one
  of their saved Studio pieces while they keep editing it. The cap and the payer are shown before anything starts;
  the person can steer through the Ask, pause, resume and Stop, and their own edits always win. Each step runs in its
  own maker execution with a write fence. Image generation works for the maker during a live session.
- **Each member's own Studio maker, on their own key** (R7 to R8.3). The host makes it on first use in a private
  Studio space the person owns, and attaches it to the Studio app without an admin act. For Studio 0.4.21, which has
  attachment hooks, this uses the app's own `member_attach` declaration from its digest-pinned release (R8.3).
- **Stale reads checked by content** (R8.4). A maker's proposal is refused as stale only when the piece's content
  changed since the maker read it, not when the frame re-uploads unchanged art.
- **The Ask sets up Studio.** From the Ask a person picks or opens a piece and confirms the cap. Refusals are plain
  and start nothing.
- **Own-key monthly total on the Me page.** "Monthly total on your own keys" shows, sets and reads back the limit that
  paid work on a person's own keys checks first; Studio needs it before a session. Adding a key that is already saved
  in the hive is refused in plain words (`duplicate_key`).
- **New hive and local owner, host side** (J1, for future installers). A local-owner hive signs its owner in through a
  one-time link (no password), checks its installed source against a verified manifest (installed-source census),
  checks its sandbox interpreter at start, and holds coding work until its repository map is ready. Inert unless
  `HIVE_LOCAL_OWNER=1`.
- **First Light onboarding screens.** A guided first journey on the real hive screens with captions (voice is off in
  this round), plus the setup list and "wake and greet" routes.
- **Ask limits and budgets.** Per-person thread and session caps, member allowances, limits on your own keys and
  grants of them, requests for more, and plain refusals.
- **Own-hive connections.** A hive is public or private, with access granted inside either.
- **Host identity sign-out.** Signing out ends that person's own work only (their Ask turns and work sessions); minds
  keep running.
- **Metered media r2.** An allowlist of minds per media op, a breaker after billed-but-refused results, and admin reads.

**Switches on the live hives.** Studio live sessions are **on on the cloud hive** (switched on 2026-10-20; it runs
Studio app 0.4.21) and **off on the Mac test hive**. On macOS this build cannot switch them on until a reviewed exact-commit
safe-restart override is adopted.

**Code** ships separately as an engineering preview, in the `omegacode` repository (PR #1). It is not offered to
members yet.

**Installers.** New one-click installers are **not built**. `install/` holds the legacy OmegaClaw installers, kept for
reference only; they do not install OmegaHive.

### Not done yet / next

1. **Images on the canvas.** A maker can generate an image, but placing it on the canvas is not done. It needs host
   round R9 and a later Studio release.
2. **First real end-to-end Studio walk.** In the first person walks on the cloud a maker's proposal was published but
   did not reach the canvas. The frame fix (the form of the body hash on the step and recovery wire, r1.14d) is in
   this branch; host round R8.5 (a stopped session's goal no longer delays the next session's first step) is in this branch too.
   The live walk is re-run after both are deployed.
3. **Linux CI (`hive-petta`).** On GitHub Actions at `2a30d1b` the job had 8 failures, known as test-environment
   differences of the Linux runner (all 232 tests in those three files pass on macOS at the branch head): the local-owner socket and
   sandbox-interpreter tests in `test_local_owner.py`, and Studio session tests in `test_studio_session_r3.py` and
   `test_studio_session_r3_handoff.py`. Triage and fixes are open.
4. **New installers (J1).** The macOS, Windows and Linux installers for the new hive are not built; the host side is.
5. **Code for members.** Code is an engineering preview, not yet usable by members.
6. **Studio "Revise the want" save.** After a person revises the brief of a piece, saving it to the hive is refused
   by the Studio app's own source checks, and the person sees an unconfirmed save. It needs a Studio app fix.
7. **Maker direct app actions have no policy rules.** The host attach (R8.3) writes the attachment with `ask` on each
   action but no per-action policy rows, so a maker's own direct app actions on the mind path would be refused. Studio
   sessions do not use that path today.
8. **Derived Studio-space monthly cap.** A member's private Studio space can carry a hive-derived monthly limit that
   also binds work paid on their own key. Whether it should is an open host policy question; the UI also needs to name
   which limit binds.
9. **Logging of `program_error` reasons.** When an app raises, the host returns 500 `program_error` but logs nothing
   and stores no reason on the failed action. The reason should be logged and a bounded code kept with the action.

## Test counts

**2026-10-20, this branch.**

| Suite | Where | Result |
|---|---|---|
| Hive server (`hive-petta`) | GitHub Actions, Linux, at `2a30d1b` | **3472 passed, 8 failed, 151 skipped** (see "Not done yet", item 3) |
| OmegaClaw core (`core-tests`) | GitHub Actions, at `2a30d1b` | passed |
| UI (`hive-ui`) | GitHub Actions, at `2a30d1b` | **5338 passed, 0 failed, 39 skipped**; production build passes |
| Targeted hive tests (Studio sessions, new hive, local owner, Ask limits, host identity, own hive) | macOS, on the first ported commit | **780 passed, 8 skipped, 0 failed** |
| Studio R8.3 and R8.4 tests (`test_studio_session_r83.py`, `test_studio_session_r84.py`) | macOS, at the branch head | **36 passed, 1 skipped** |

**2026-10-10, at the handover.** Measured on that tree, from a clean clone, with the toolchain in the README
(Python 3.12, SWI-Prolog 10.1.14 built against it, PeTTa `ae66fa8`, janus-swi 1.5.3):

| Suite | Command | Result |
|---|---|---|
| Hive server | `python -m pytest -q hive/tests` | **2414 passed, 0 failed, 66 skipped** (about 8.5 minutes; final handover run) |
| OmegaClaw core | `python -m unittest discover -q -s tests` | **374 run OK, 31 skipped** |
| UI types | `npx tsc -b --noEmit` (in `hive/ui`) | clean |
| UI tests | `npx vitest run` (in `hive/ui`) | **3822 passed, 5 timed out, 39 skipped**. The 5 were 5-second timeouts on a heavily loaded machine; each passes when its file is run alone |

The hive tests that need sibling closed-source repos (for example `omegasocial`) skip with that
reason. The showreel line-reference test now anchors on the quoted text, so a moved line warns
instead of failing. Without a working PeTTa most hive tests error rather than skip.

## What works

- **People and sign-in:** admin password, invite-only Google sign-in, domain enrolment, roles,
  sign-out that revokes every token from that sign-in and ends that person's own work. A local-owner hive signs its
  owner in through a one-time link instead.
- **Spend limits:** per-person Ask thread and session caps, member allowances, a monthly total on your own keys
  (Me page), grants of your keys to others, and requests for more.
- **Personal minds and the Ask:** a personal mind for every person; a text and voice Ask on every
  page; the Ask conductor steering the screen with typed acts (on the cloud).
- **Minds and swarms:** native OmegaClaw minds on PeTTa and external members over MCP; swarm team
  rooms with @mentions; Off / Wake all / Stop all with a durable snapshot.
- **Symbolic commons:** one MeTTa space per swarm with evidence stamps, disjoint-evidence revision
  and an operations log replayed at boot; the same libraries in the browser.
- **Reasoning skills:** NAL, PLN and NARS are callable in every native mind.
- **Governance:** policy gate per skill (allow, ask, deny; Once, For a time, Always, No, Never),
  exact-bound approvals, HMAC capability tokens, OS sandboxing (Landlock and namespaces on
  Linux, sandbox-exec on macOS), budgets checked at worst case before every paid call, visibility
  tiers, local-only swarms that refuse outside model calls (verified live on 2026-10-04).
- **Apps:** a fixed app contract, digest-pinned releases (`HIVE_APP_PINS`), app homes, grants and
  exact-request app actions. Studio, Tools, Fusion, Planner and Library ran on the hive from their
  own repositories. On the cloud hive, Studio live sessions let a member's own Studio maker draw with them (see
  "Live since the handover").
- **Demos (currently out of date and broken; see Known issues):** a self-running showreel (`?sim=1`) and guided demos with invented data, guarded by
  a test that blocks real names.

## Limited or deliberately off

| Area | State |
|---|---|
| Automatic reasoning from the mind loop | **Deliberately not wired** in this build. NAL/PLN are skills the mind calls. The reasoning foundation (69 tests, assembly gate passed) and a default-off OBSERVE organ (64 tests) are reviewed and held for activation. See `docs/EARLIER_EXPERIMENTS.md` |
| NAL/PLN libraries | Truth functions match the references except the documented deviations in `docs/reasoning-deviations.md`. PLN stays as it is by the owner's ruling and can be upgraded by its author |
| Attention | A heuristic classifier with ECAN-inspired naming; full ECAN is design intent |
| Long-term recall | ChromaDB beside the AtomSpace; the hive default embedder is `mock/hash` |
| Child minds | Built and tested (139 tests); activation held; never spawned live |
| Mind sandbox | Opt-in (`HIVE_MIND_SANDBOX=1`); deployments set it, development does not |
| Docker driver | Host networking by default, without hardening flags |
| Approvals | One signer per approval; two risk levels |
| Copy-apply | Consent is built and tested; the feature itself is off (`HIVE_COPY_APPLY_CLAIMS`) |
| Code | Shipped separately as an engineering preview (`omegacode`, PR #1); not offered to members yet |
| Studio live sessions | Off by default (`HIVE_STUDIO_SESSIONS`). On on the cloud hive since 2026-10-20; off on the Mac test hive, where this build cannot switch them on. Image placement on the canvas is not done |
| Media route | Off by default (`HIVE_MEDIA_ROUTE=on`); minds need an `HIVE_MEDIA_ALLOW` entry, except a member's own Studio maker during their live session |
| Local-owner and new hive | Host side only, inert unless `HIVE_LOCAL_OWNER=1`. The installers that would set it are not built |
| Channels other than the hive channel | In the core; hive minds use the hive channel by design |
| CI | `.github/workflows/ci.yml` runs on GitHub Actions. At `2a30d1b`, `core-tests` and `hive-ui` pass; `hive-petta` has 8 known Linux test-environment failures (see "Not done yet", item 3) |
| Glucose app | The core glucose connector (`src/glucose.py`, LibreLinkUp polling and alerts) ships as code only. No credentials, cache or readings are included (`memory/librelinkup*.json` stay git-ignored). The modular `modules/health_glucose` app ships too. Home Assistant (`modules/home_assistant`, `src/home.py`) ships as code |

## Known issues

| Area | Issue |
|---|---|
| Deploying an app with its swarm | There is no good flow for deploying an app with a swarm configured. Setting it up today is confusing: the app's release pin, its swarm, the app home and the grants are configured in separate places (environment settings such as `HIVE_APP_PINS` and per-app `*_SWARMS` variables, plus hive actions), with no single guided step that checks they agree. A one-step "deploy app into swarm" flow is wanted. |
| First-time deployer for a single Omega | There is no first-time deployer for running a single Omega mind on its own. The compatibility exists (the inherited OmegaClaw runtime still runs one agent; the legacy OmegaClaw installers in `install/`, kept for reference, and `deploy/` cover the pieces), but the guided flow has not been made. The new one-click installers (J1) are not built either; only their host side is. |
| Local deploy | Local deployment runs through the web interface. It should become its own app. |
| Advanced frontier-parity features | Computer use, browser use, draw on screen and vibe coding are tested working on the Mac and unproven on Linux. None has a full implementation yet; all are in progress. |
| Hive-to-hive connection | Not complete. The representative-to-hive connection works (a person's representative talking to the cloud hive); full hive-to-hive linking is still to be built. |
| Full custom "any UI" | Letting each person reshape the whole interface into any UI they want is mostly finished and untested. |
| Reasoning tools (PLN, ECAN and others) | Tested in previous builds and integrated here, but not activated or bug-fixed in this build. See "Limited or deliberately off" above and `docs/EARLIER_EXPERIMENTS.md`. |
| Limited end-to-end testing | End-to-end testing across all features and functions is limited. Everything here has worked in one or another earlier build, but these pieces have only lived together since early October 2026. Expect integration bugs. |
| Hive, folder and screen organisation; infinite hives | Organising the hive into folders and screens, and nesting hives without limit ("infinite hives"), is scoped and partly built. It needs finishing. |
| Modules and add-ons not fully ported | Many modules and add-ons in the outer parts of this handover (for example `modules/`, `channels/`, the `omegahive-candidates` repo and the legacy folders listed in `LEGACY.md`) have not been fully ported to the latest hive. They are known to work in previous builds, but their compatibility with this hive is untested. |
| Demo mode | The current demo mode (the `?sim=1` showreel and the guided demos) is out of date and broken. It needs updating to the current hive before it is used. |
| UI tests under load | A few vitest tests use a 5-second timeout and can time out on a heavily loaded machine; they pass when run alone. |

## Release history

The 2026-10-06 private release report (what was reviewed then, what was removed before export,
and the Linux isolation follow-ups) is kept at
[`docs/handoff/platform/release-report-2026-10-06.md`](docs/handoff/platform/release-report-2026-10-06.md).
