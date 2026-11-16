# OmegaHive status

State of this repository as handed over (2026-10-10). It was prepared from live release
**5617f4e**, which runs on the cloud hive. The first round of port pull requests (Surface
follow-ups, idle minds, and their docs) is merged. A second round brings over everything live up to
release **f3f4bb8** (2026-10-12): `port/demo-mode-fix-r2`, `port/idle-minds-r2.5`, `port/repo-map-host`, `port/hive-scale`, `port/showreel-anchors`, `port/health-idle-ui`, `port/workbench-map`, `port/lab-compare`, `port/followups-r5` and `port/lab-pc-band`. Merge them in that order; the UI ones are stacked
(each contains the one before), as are idle minds and the repo-map host. This page describes the tree
with all of them applied. The dated done/to-do log is in
[`docs/STATUS.md`](docs/STATUS.md), and every feature with its state is in
[`docs/FEATURES.md`](docs/FEATURES.md).

## Test counts

Last measured on 2026-10-10 on this tree, from a clean clone, with the toolchain in the README
(Python 3.12, SWI-Prolog 10.1.14 built against it, PeTTa `ae66fa8`, janus-swi 1.5.3):

| Suite | Command | Result |
|---|---|---|
| Hive server | `python -m pytest -q hive/tests` | **2414 passed, 0 failed, 66 skipped** (about 8.5 minutes; final handover run) |
| OmegaClaw core | `python -m unittest discover -q -s tests` | **374 run OK, 31 skipped** |
| UI types | `npx tsc -b --noEmit` (in `hive/ui`) | clean |
| UI tests | `npx vitest run` (in `hive/ui`) | **3822 passed, 5 timed out, 39 skipped**. The 5 were 5-second timeouts on a heavily loaded machine; each passes when its file is run alone |

**With the port pull requests applied** (measured 2026-10-11 on the pull-request branches, rebased on
`main` c8a9aed, same toolchain, on a shared and heavily loaded machine):

| Suite | Branch | Result |
|---|---|---|
| Hive server, full | `port/idle-minds` | **2431 passed, 0 failed, 66 skipped** (about 74 minutes under load) |
| OmegaClaw core | `port/idle-minds` | **384 run, 23 skipped, 2 failed**: the two failures are `test_channel_hive` daemon-restart tests that fail the same way on `main` on this machine; CI's `core-tests` job passes them on GitHub. The new `tests/test_wait_quiet_runtime.py` passes 6 of 6 with a booted runtime (`HIVE_TEST_PETTA`, `HIVE_TEST_CHROMADB_LIB`) and skips its 4 runtime cases without one |
| UI types, lint, build | `port/demo-mode-fix` (which contains idle minds) and `port/surface-followups-r4` | `tsc -b` clean; lint 0 errors (84 warnings, as on `main`); `npm run build` builds |
| UI tests, full | `port/demo-mode-fix` | **3885 tests: 3824 passed, 22 timed out, 39 skipped**. All 22 were timeouts in the simulator and look-identity files under load; each of those files passes when run alone |
| UI tests, targeted | `port/surface-followups-r4` | guided, ink, Ask, messages, chat-sender, person-name, scene-input and simulator files: **682 tests, 677 passed, 5 timed out under load**; the 5 pass when their files run alone |

**With the second-round pull requests applied** (measured 2026-10-12 on the pull-request branches,
on a shared machine; targeted runs only, GitHub CI runs the full suites on each pull request):

| Suite | Branch | Result |
|---|---|---|
| Hive server, targeted | `port/repo-map-host` (contains idle minds r2.2 to r2.5) | see the pull requests: `test_idle_minds.py`, `test_repo_map.py`, `test_health.py`, `test_personal_visibility.py`, `test_mind_chat_identity.py`, `test_placement.py`, `test_mcp*.py` |
| UI types and build | `port/lab-pc-band` (the head of the UI stack) | clean `npm ci && npm run build` (`tsc -b` then Vite) |
| UI tests, targeted | each UI pull request | the test files the pull request adds or changes, on one worker with a 60-second timeout |

The hive tests that need sibling closed-source repos (for example `omegasocial`) skip with that
reason. The showreel line-reference test now anchors on the quoted text, so a moved line warns
instead of failing. Without a working PeTTa most hive tests error rather than skip.

## What works

- **People and sign-in:** admin password, invite-only Google sign-in, domain enrolment, roles,
  sign-out that revokes every token from that sign-in.
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
  own repositories.
- **Idle minds and Health:** a mind that answers only `wait` stops making model calls until new
  input or its chosen wake (`wait 900` wakes it in 900 s); model spend no longer counts as
  activity, so idle sleep and child-mind idle limits count from real input. Health notices an awake
  mind that spends with no input, stays silent with no input, holds a goal with no heartbeat or
  leaves a message unanswered, and asks it one question through the normal message path (at most
  once per idle stretch, and on its own at most every 6 hours). A personal mind is asked in its
  person's own chat. Admins and owners see the record at `GET /api/health/idle` and can Remind;
  nothing is limited or put to sleep automatically. Health's **Idle minds** section shows all of
  this, with Remind and Sleep offered only when the host's per-viewer flags (`may_remind`,
  `may_sleep`) allow and the mind is awake; a personal mind's record is its person's, and an admin
  reads it only by explicit audit, read-only, whatever the mind's visibility.
- **The hive map at scale:** each person's hive is a galaxy (their own mind "You" at its centre),
  the cloud hive in the middle; one visibility helper decides what a viewer is shown before
  anything is grouped, counted or linked; private-app homes stay hidden until known; galaxies can be
  dragged and the arrangement is kept per person in this browser.
- **Repository maps (Slice A):** an admin loads a `repo-map/1` map of a repository revision; people,
  minds (the `repo-query` skill) and MCP members (`hive_repo_query`) read it through one engine, with
  seven presets, drift between revisions, signed cursors and a 256 KiB page bound. The Code page
  has a **Map** mode (`#/code/map/<repo>@<sha>`) that reads it.
- **Lab:** Compare and the Epistemic board judge two measures only when their units, definitions
  and directions make them comparable.
- **Demos:** a self-running showreel (`?sim=1`) and guided demos with invented data, guarded by
  a test that blocks real names. Brought up to date with the current hive by the demo-mode fix:
  the page starts when browser storage is blocked, the tour and guided demos open the commons
  and app graph by route (`?tab=commons`, `?view=graph`, the latter through the unsaved-edits
  guard), and the demo's approval asks show one card at a time.

## Limited or deliberately off

| Area | State |
|---|---|
| Automatic reasoning from the mind loop | **Deliberately not wired** in this build. NAL/PLN are skills the mind calls. The reasoning foundation (69 tests, assembly gate passed) and a default-off OBSERVE organ (64 tests) are reviewed and held for activation. See `docs/EARLIER_EXPERIMENTS.md` |
| NAL/PLN libraries | Truth functions match the references except the documented deviations in `docs/reasoning-deviations.md`. PLN stays as it is by the owner's ruling and can be upgraded by its author |
| Attention | A heuristic classifier with ECAN-inspired naming; full ECAN is design intent |
| Long-term recall | ChromaDB beside the AtomSpace; the hive default embedder is `mock/hash` |
| Child minds | Built and tested (139 tests); activation held; never spawned live |
| Mind sandbox | On by default where the host can run it, checked and reported at start (`HIVE_MIND_SANDBOX=0` turns it off) |
| Docker driver | Host networking by default, without hardening flags |
| Approvals | One signer per approval; two risk levels |
| Copy-apply | Consent is built and tested; the feature itself is off (`HIVE_COPY_APPLY_CLAIMS`) |
| Code service | Live on the owner's Mac hive since 2026-10-08; the cloud install is in review |
| Channels other than the hive channel | In the core; hive minds use the hive channel by design |
| CI | `.github/workflows/ci.yml` (`hive-ci`) runs once per pull request commit on GitHub; a newer commit on the same pull request cancels the run still in progress, and a push alone starts no run. A pull request runs `core-tests` (the `tests/` unittest suite), `hive-petta-smoke` (the pinned toolchain, a smoke selection of `hive/tests` and the mind-sandbox tests) and `hive-ui` (typecheck, lint, vitest, build). The full `hive/tests` (`hive-petta`) runs only nightly on `main` and on a manual dispatch, beside `core-tests` and `hive-ui`; a failed nightly run opens, or comments on, the issue "Nightly hive-petta failed". The Linux mind-sandbox tests need unprivileged user namespaces, which the workflow enables (see `deploy/RUNBOOK.md`) |
| Glucose app | The core glucose connector (`src/glucose.py`, LibreLinkUp polling and alerts) ships as code only. No credentials, cache or readings are included (`memory/librelinkup*.json` stay git-ignored). The modular `modules/health_glucose` app ships too. Home Assistant (`modules/home_assistant`, `src/home.py`) ships as code |

## Known issues

| Area | Issue |
|---|---|
| Deploying an app with its swarm | There is no good flow for deploying an app with a swarm configured. Setting it up today is confusing: the app's release pin, its swarm, the app home and the grants are configured in separate places (environment settings such as `HIVE_APP_PINS` and per-app `*_SWARMS` variables, plus hive actions), with no single guided step that checks they agree. A one-step "deploy app into swarm" flow is wanted. |
| First-time deployer for a single Omega | There is no first-time deployer for running a single Omega mind on its own. The compatibility exists (the inherited OmegaClaw runtime still runs one agent, and the installers in `install/` and `deploy/` cover the pieces), but the guided flow has not been made. |
| Local deploy | Local deployment runs through the web interface. It should become its own app. |
| Advanced frontier-parity features | Computer use, browser use, draw on screen and vibe coding are tested working on the Mac and unproven on Linux. None has a full implementation yet; all are in progress. |
| Hive-to-hive connection | Not complete. The representative-to-hive connection works (a person's representative talking to the cloud hive); full hive-to-hive linking is still to be built. |
| Full custom "any UI" | Letting each person reshape the whole interface into any UI they want is mostly finished and untested. |
| Reasoning tools (PLN, ECAN and others) | Tested in previous builds and integrated here, but not activated or bug-fixed in this build. See "Limited or deliberately off" above and `docs/EARLIER_EXPERIMENTS.md`. |
| Limited end-to-end testing | End-to-end testing across all features and functions is limited. Everything here has worked in one or another earlier build, but these pieces have only lived together for about a week. Expect integration bugs. |
| Hive, folder and screen organisation; infinite hives | Organising the hive into folders and screens, and nesting hives without limit ("infinite hives"), is scoped and partly built. It needs finishing. |
| Modules and add-ons not fully ported | Many modules and add-ons in the outer parts of this handover (for example `modules/`, `channels/`, the `omegahive-candidates` repo and the legacy folders listed in `LEGACY.md`) have not been fully ported to the latest hive. They are known to work in previous builds, but their compatibility with this hive is untested. |
| Demo mode | **Fixed** by the demo-mode fix pull request (`port/demo-mode-fix`): the `?sim=1` showreel, the tour and the guided demos match the current hive again. |
| A personal mind's Health record, for admins | **Fixed** by `port/idle-minds-r2.5`: a personal mind's idle record is its person's whatever its visibility; an admin reads it only by explicit audit (`?include=all` or `?include=personal`), read-only. |
| Mind export | **Fixed** by `port/idle-minds-r2.5`: a personal mind's bundle carries its person's conversations only for that person (their own transcript's rows) or an admin's explicit audit, and is refused (`409 personal_mind_unbound`) anywhere it would not arrive as that person's personal mind. Import refuses a bundle whose rows would be attributed to someone else (`409 conversation_owner_mismatch`). |
| Repository map mounts | A loaded revision is also mounted into a read-only space; the read routes answer from the database rows, not the space. Members cannot query the space directly yet. |
| UI tests under load | A few vitest tests use a 5-second timeout and can time out on a heavily loaded machine; they pass when run alone. |

## Release history

The 2026-10-06 private release report (what was reviewed then, what was removed before export,
and the Linux isolation follow-ups) is kept at
[`docs/handoff/platform/release-report-2026-10-06.md`](docs/handoff/platform/release-report-2026-10-06.md).
