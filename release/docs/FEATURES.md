# OmegaHive feature list, third revision, final (9 Oct 2026)

This lists every OmegaHive feature, what it does, its state today, and where it lives in the code.

- **Checked against:** live release **5617f4e** (the cloud hive). This repository is the cleaned, single-commit snapshot of that release on branch `github-ready`; the rows were checked against an earlier cut of that snapshot and re-checked for the handover round (2026-10-10). Paths are relative to this repository. A bare filename such as `PLATFORM_..._20261009.md` names an internal review or receipt record that is not published.
- **Cloud hive:** live release **5617f4e** (status doc, coordination record and the internal release log).
- **Mac hive:** **a37082e**. Its sync is held while minds are awake. These commits are therefore **cloud only** until the Mac syncs: 765de1a, f50c4da, 3626a88, c57d30b, 5617f4e. Rows that depend on them say "cloud only".
- **What "Base" means in citations:** private release **2ccc456** (reviewed d5f608a plus platform fixes 9 to 13), deployed to the cloud on 2026-10-06 (`PLATFORM_CLOUD_DEPLOY_2ccc456_20261006.md`). Everything up to 5617f4e is on the cloud. Short shas such as `8739049` are release commits; each commit message records that its independent reviews passed.
- **States:** Live, Live switched off, Mac only, In review / building, Planned, Partial / limited, Retired / legacy, and UNKNOWN (used when no evidence settles it). **"Live, cloud only (Mac held on a37082e)"** is Live on the cloud, from a commit the Mac doesn't have yet. It is counted as Live.
- **Tiers:** rows for features in the **Closed Source for Product Consideration** tier are marked *(closed: repo or folder)*. Those are Studio (`omegadesign`), Fusion (`omegafusion`), Code (`omegacode`), Social (`omegasocial`), Purple (`omegapurple`), Atlas (`omegaatlas`), Truth (`omegatruth`), and inside this repo Evolve (`hive/plugins/omegaevolve`), OmegaTown and the WhatsApp bridge. Everything else here is Open (Apache-2.0). See `docs/START_HERE.md`.
- **Atlas and Truth:** their life-map and case-file forms have moved out of the platform UI into their closed repositories. They are listed below by name only; no data of theirs is in any repository.
- **Since this list (2026-10-10 to 2026-10-20):** the rows below were not re-checked one by one. What went live since is in the root `STATUS.md` ("Live since the handover") and `CHANGELOG.md`. The Studio rows ST9 to ST13 were added for it.

---

## 1. People, sign-in and admin

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| PE1 | Admin password sign-in | The operator signs in with the hive's admin password and gets a bearer token. | **Live**: Base | `hive/core/app.py` `POST /api/auth/login`; `HIVE_ADMIN_PASSWORD` |
| PE2 | Google sign-in, invite only | Admins invite an email address. That Google account accepts once, then signs in with Google directly. | **Live**: Base, hardening 5b0b915 | `hive/core/people.py`; `/api/auth/google/start`, `/api/auth/google/callback`, `/api/auth/invite/{token}`, `/api/invites` |
| PE3 | Domain allowlist enrolment | Verified Workspace accounts from a listed domain enrol as members without an invite. | **Live**: `HIVE_SIGNIN_DOMAINS` is set on the cloud (env names read by Platform, 2026-10-09) | `people.py`; `HIVE_SIGNIN_DOMAINS` |
| PE4 | Configured admins | A listed email is always an admin and is promoted at start-up or sign-in. It is never demoted. | **Live**: 35ebbf1 | `people.py`; `HIVE_ADMIN_EMAILS` |
| PE5 | Google identity binding | Each person is bound to their Google account id. An admin can clear the binding, which ends that person's sessions. | **Live**: 5b0b915, 57fd555 | `people.py`; `PATCH /api/people/{id}`; `hive/ui/src/features/people/clearGoogle.ts` |
| PE6 | Webhost sign-in (SSO) | Signs in through a trusted webhost cookie. It refuses anyone who is bound to Google. | **Mac only**: no `HIVE_SSO_*` on the cloud; the Mac sets `HIVE_SSO_LOGIN_URL` | `hive/core/sso.py`; `POST /api/auth/sso`; `HIVE_SSO_LOGIN_URL/USERS/TTL_HOURS/STATE_DIR` |
| PE7 | Public-request rules | Requests that come through a tunnel or base path are treated as public. They cannot use the password login, and their reach is limited. | **Live**: Base | `sso.py`; `HIVE_BASE_PATH`, `HIVE_PUBLIC_PASSWORD`, `HIVE_PUBLIC_URL/BASE`, `HIVE_INVITE_PATH` |
| PE8 | Sign out | Signing out expires the cookie and revokes every token issued from that sign-in. A Sign out button is always visible. | **Live**: 1ae499d, ed23c9c, 5d81377, 607d5b4 | `POST /api/auth/logout`; `hive/ui/src/shell/Nav.tsx` |
| PE9 | Friendly sign-in words | Sign-in errors are shown in plain words. A signed-out page says "Signed out", not "OFFLINE". | **Live**: 57fd555, 6e937bd | `hive/ui/src/shell/signinError.ts`, `brandStatus.ts` |
| PE10 | Who am I, and the session reference | `GET /api/auth/me` returns the person, their role and an opaque HMAC session reference. `GET /api/auth/methods` lists the sign-in options. | **Live**: Base | `hive/core/session_ref.py`; `/api/auth/me`, `/api/auth/methods` |
| PE11 | People page | Lists people, changes roles (admin or member), disables people, invites colleagues and withdraws invitations. | **Live**: Base | `features/people/PeoplePage.tsx`; `/api/people`, `/api/invites/{id}` |
| PE12 | People's requests to admins | A member asks for a mind, more allowance or access. An admin answers Once, For a time, Always, No or Never. | **Live**: Base, touched in 5617f4e | `hive/core/person_requests.py`; `/api/asks`, `/api/asks/{id}/decide`; `features/approvals/AsksPanel.tsx` |
| PE13 | You and your keys | Your profile, your API keys (add, rename, refresh, remove), who pays, and a credit check. | **Live**: Base | `features/keys/ProfilePage.tsx`, `KeyPicker.tsx`; `/api/keys*` |
| PE14 | Getting-started checklist | First-run steps: a provider, who pays, a limit, a swarm, invites. | **Live**: Base | `features/setup/SetupPage.tsx`, `SetupChecklist.tsx`, `checklist.ts` |
| PE15 | Name this hive | How other hives know this one. | **Live**: Base | `/api/hive/identity`; `features/settings/SettingsPage.tsx` |
| PE16 | Settings page | Hive, sign-in, password rotation, disk, apps and isolation, registered services, and the Ask audit. | **Live**: Base | `features/settings/SettingsPage.tsx`; `/api/settings`, `/api/settings/password/rotate` |

## 2. Personal mind and the Ask

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| PM1 | A personal mind for every person | Every named person gets one Omega mind. It starts asleep, alone in its own swarm, and is created with no model calls. | **Live**: b86cf47 | `hive/core/personal.py`; `GET/POST /api/me/mind` |
| PM2 | The Ask answers as you | Personal Ask turns speak as your mind. The words are never stored on the hive, and only you can read them, not even admins. | **Live**: b86cf47 | `hive/core/personal.py`, `hive/core/ask.py` |
| PM3 | Personal Ask controls the hive | Your personal Ask can still dispatch work and hand it to swarms. | **Live**: 96a226b | `ask.py`, `conductor.py` |
| PM4 | Mind page (`#/me/mind`) | One page for your mind: what it remembers, what it handed on, and its version. Your mind is drawn as a glass figure (Classic), a constellation (Cosmos) or an ink line (Still); other experiences show the Classic figure. | **Live**: eeae20a, 3eced24, 918fdb4 | `features/mind/PersonalMindPage.tsx`, `mindLook.ts`, `MindFigure.tsx`, `LookFigures.tsx`, `GlassFigure.tsx`, `mind.css` |
| PM5 | Browser memory: view, edit, forget | The Ask's memory of you (beliefs, recall, trace) lives in your browser. You can see it, edit it and forget it. | **Live**: 452c44b, eeae20a | `hive/ui/src/lib/askMemory/`; `features/keys/AskMemorySection.tsx`; `features/ask/memoryNav.ts` |
| PM6 | Download and restore memory (M1) | Saves your mind's memory to a file, and restores it with a preview first. | **Live**: eeae20a | `features/mind/MemoryDurability.tsx`, `durability.ts` |
| PM7 | Linked folder (M2) | Keeps a versioned memory file in a folder you pick. Chromium browsers only. | **Live**: eeae20a | `features/mind/folder.ts` |
| PM8 | Held copies for the browser | The hive holds copies of your exchanges with a swarm until your browser collects them. | **Live**: b86cf47 | `hive/core/personal_inbox.py`; `/api/me/mind/inbox`, `/api/me/mind/inbox/ack`; `features/mind/inbox.ts` |
| PM9 | Swarm-talk collector | Collects your swarm conversations into browser memory and acknowledges them only after a durable write. | **Live**: eeae20a | `features/mind/Collector.tsx` |
| PM10 | "Use my swarm talk in answers" | Recalls your swarm talk into Ask answers. | **Live, switched off**: per-person switch, off by default (eeae20a receipt) | `features/mind/PersonalMindPage.tsx`, `store.ts` |
| PM11 | Handed to swarms | Shows what your mind is doing and what it handed on, read from the Ask thread. | **Live**: eeae20a | `features/mind/hands.ts` |
| PM12 | Mind version: adopt or roll back | Would switch your mind to a better version, or back. | **Partial / limited**: the UI shows "Version choice comes later"; `/api/me/mind/versions` isn't built (P3/P4) | `PersonalMindPage.tsx`; `hive/ui/src/api/personalMind.ts` |
| PM13 | Answering chip | Shows who is answering and links to your mind. | **Live**: 27da97f | `features/ask/answerer.ts`, `features/mind/PersonalMindLink.tsx` |
| PM14 | Universal Ask (text) | A typed request is answered in a thread by the swarm's coordinator, or by your mind. | **Live**: Base | `hive/core/ask.py`; `/api/ask`, `/api/ask/{op}`, `/api/me/ask`; `features/ask/AskHost.tsx`, `Thread.tsx`, `ClassicAsk.tsx` |
| PM15 | Ask by voice | Speak to the Ask and hear its answer. | **Live**: d829307 | `features/ask/useAskVoice.ts`, `VoiceParts.tsx`, `voice.ts` |
| PM16 | Ask in every experience | Each experience draws the Ask in its own style: a capsule (Classic), a ruled line (Still), a transmission (Cosmos), liquid (Flux), a command line (Construct), a note (Canvas) and the Town skin. Professional's skin exists only in the preview build. | **Live**: 40492fb, 6838fab (Town) | `features/ask/skins.ts`, `StillLine.tsx`, `townSkin.tsx`, `candidateSkins.tsx`, `experienceAsk.css` |
| PM17 | Ask conductor | One model loop steers your screen with typed acts: it opens pages and points at things. | **Live**: on the cloud only. Code 493420d (host), 5b74d17 (executor), ee4dd1f and ff5886b (live conductor, two review revisions). The cloud flag `HIVE_ASK_CONDUCTOR=1` has been on since the 8739049 deploy. It is **off on the Mac**: the flag is unset in the Mac settings and in the running Mac hive (Platform confirmed) | `hive/core/conductor.py`; `features/ask/conductor.ts` |
| PM18 | Conductor memory | The conductor's memory notes are kept by your browser, not the hive. | **Live**: cloud `HIVE_ASK_MEMORY=on` (8739049); 6122e5f, 6580186 | `ask.py`; `features/ask/memoryNav.ts` |
| PM19 | Steer or stop a turn | Adds direction to an open Ask turn, or stops it. | **Live**: Base | `/api/ask/{op}/steer`, `/api/ask/{op}/stop` |
| PM20 | Ask takeover | The host can take over a turn, with a clear point where it is committed. | **Live**: a29ee73 | `/api/ask/{op}/takeover` |
| PM21 | Ask intents and links | The host keeps custody of the exact request body for a turn: submit, abandon, links. | **Live**: 129c779 | `hive/core/ask_intents.py`; `/api/ask/intents*`, `/api/ask/{op}/intents`, `/api/ask/{op}/links` |
| PM22 | Screen acts report back | The browser reports the result of each conductor act. | **Live**: 493420d, 5b74d17 | `/api/ask/{op}/acts/{act}/result`; `features/ask/run.ts`, `handlers.ts` |
| PM23 | Answer through a swarm's mind | When a swarm has no coordinator, a permitted mind you address answers (for example, Design's deck maker). Known follow-up: `threadInfo()` still says "orchestrator". | **Live, cloud only (Mac held on a37082e)**: host 765de1a, client f50c4da (Ask fix) | `ask.py`; `features/ask/answerer.ts`; `hive/ui/src/store/ask.ts`; `features/swarm/coordinatorPicker.ts` |
| PM24 | Safe Ask targeting | The Ask never targets a page's swarm that it can't answer from. It falls back quietly. | **Live**: ab5a497 | `features/ask/placement.ts`, `context.ts` |
| PM25 | Change who answers | A picker beside the Answering chip. | **Live**: a4aa3ae, 3eced24 | `features/ask/AnswererPicker.tsx` |
| PM26 | Recent conversations | Minds you talked to lately, each straight back to its chat. | **Live**: a37082e | `#/conversations`; `features/dot/RecentConversationsPage.tsx`, `recent.ts` |
| PM27 | Spend stop | When a turn hits its limit, it offers "New thread" and "Raise the limit for new threads" in place. | **Live**: c5ed888 | `features/ask/Thread.tsx` |
| PM28 | Earlier threads | Past Ask threads, and deleting one. | **Live**: Base | `features/ask/Earlier.tsx`; `DELETE /api/ask/threads/{id}`; `GET /api/ask` |
| PM29 | Ask audit (admins) | Every person's Ask turns as frames. Personal turns carry no content. | **Live**: Base | `/api/ask/audit`, `/api/ask/audit/{turn}`; `features/settings/AskAudit.tsx` |
| PM30 | Ask clearance | The Ask is never hidden under dialogs, and hints never cover titles. | **Live**: 32afcf7, ff5886b | `features/ask/popDismiss.ts`, `hive/ui/src/ui/useModalContainment.ts` |
| PM31 | Presence | Watch the orchestrator work live. It is display only and never takes focus. | **Live**: Base | `features/ask/Presence.tsx` |
| PM32 | Conductor model settings | Conductor model, A/B models, per-turn spend cap and Ask timeout. | **Live**: code defaults (no conductor model overrides set on the cloud) | `HIVE_ASK_CONDUCTOR_MODEL`, `_AB_MODELS`, `_TURN_USD`, `HIVE_ASK_TIMEOUT_SECONDS` |
| PM33 | Ask reads hive memory | The Ask would recall from hive memory (`/api/me/recall`). | **Planned**: the owner's direction; no reviewed plan was found | status doc "To do" 3 |
| PM34 | Minds see the screen on demand | `see_view`: a mind can look at what you are looking at. The UI waits on a Platform host route. | **Planned**: spec only | `SPEC_MIND_VIEW_CONTEXT_20261009.md` |
| PM35 | "About this swarm" context | The Ask would know the swarm you are looking at. Platform agreed a visibility-checked host field, `context.about_swarm_id`; the UI follows it. | **Planned**: shape agreed; not built | Surface build plan ("LIVE ab5a497" section) |
| PM36 | Browser-Iter personal mind | The personal mind would run as an Iter in the browser. This replaces the MeTTa wiring plan (PM37). | **Planned**: awaits the owner. The sixth revision of the plan passed one independent review; the second independent review is pending; eight open questions remain | `PLAN_PERSONAL_MIND_BROWSER_ITER_r6_20261009.md`; `PLATFORM_SURFACE_BROWSER_ITER_PLAN_r6_STANDIN_VERDICT.md` |
| PM37 | Personal-mind MeTTa wiring plan | A plan to wire a MeTTa worker in as the personal mind's memory. | **Retired / legacy**: superseded. All five revisions of the wiring plan were frozen on 2026-10-09 (the owner: use an Iter) and replaced by PM36. The worker itself is PM42 | `PLATFORM_SURFACE_MIND_METTA_WIRING_PLAN_r5_STANDIN_VERDICT.md` |
| PM38 | Mind-space worker CSP | A locked-down security header on the MeTTa worker file. | **Planned**: on hold. The host plan is a first draft only, and is moot until the browser-Iter redesign | `PLATFORM_WORKER_CSP_HOST_PLAN_R1_20261009.md` |
| PM39 | Mind memory with multiple indexes | Several ways to look up a mind's memory. | **Planned**: plan (second revision, one amendment); independent review passed | `PLATFORM_MIND_MEMORY_MULTI_INDEX_PLAN_R2_*` |
| PM40 | Per-thread spend raise | Raise the limit for one thread only. | **Planned**: host follow-up | status doc "To do" 4 |
| PM41 | Ask fast path (local understanding) | Resolves a typed request with no model and no network: features, looks by words, apps by name, guided demos, swarm-delete candidates and "Did you mean" chips. It hands everything else to the answering mind. | **Live**: Base, c34d8c6, f4b01aa, 3eced24, a37082e | `hive/ui/src/lib/intent/` (`index.ts`, `understand.ts`, `score.ts`, `look.ts`, `swarmDelete.ts`) |
| PM42 | MeTTa memory worker (mind-metta) | A MeTTaScript worker over the pinned lib_nal, lib_pln and lib_hive: revision, inference, MeTTa export and import, checked for parity with PeTTa. | **Partial / limited**: in the tree since 3eced24, but not the live personal-mind memory path (recall still uses the local ranking). Its pinned sources feed the simulator commons (DM9) | `hive/ui/src/lib/mindSpace/` (`worker.ts`, `core.ts`, `sources.ts`); seam `lib/askMemory/recall.ts:106` |

## 3. Minds

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| MI1 | The hive map | A living star map of every mind: awake, thinking or asleep, and where. Personal swarms are kept off the map. | **Live**: Base, 6e937bd | `hive/ui/src/scene/HiveScene.tsx`, `engine.ts`, `personalOnMap.ts`; `GET /api/hive` |
| MI2 | Create a mind | A new mind with a role, model and budget. Its token is shown once. | **Live**: Base | `features/create/CreateFlow.tsx`, `TokenReveal.tsx`; `POST /api/agents`; `hive/ui/src/lib/makeMind.ts` |
| MI3 | Start, stop, sleep, wake | Controls a mind's life. A late connection never wakes a stopped mind. | **Live**: Base | `/api/agents/{id}/start\|stop\|sleep\|wake` (`app.py` loop); `hive/core/hive.py` |
| MI4 | Chat with a mind | A live conversation per mind. In the chat UI, "Did you mean" never covers the chat, the chat stays at the bottom, and there is a way back to `#/conversations` (**Live**, a37082e, both hives). Showing the real sender, keeping conversations per person and binding replies to the right person are host changes (5617f4e, cloud only). | **Live, cloud only (Mac held on a37082e)**: host 5617f4e; UI a37082e is on both hives | `features/dot/Chat.tsx`; `hive/ui/src/lib/stickToBottom.ts`; `hive/core/app.py`, `rooms.py`; `/api/agents/<built-in function id>/messages` |
| MI5 | A mind's memory | Spaces and atoms. Retire a space or reset the memory. | **Live**: Base | `features/dot/MemoryInspector.tsx`; `/api/agents/{id}/memory*` |
| MI6 | Wakeups and schedule | Cron or one-shot messages that wake a mind and tell it why. | **Live**: Base | `hive/core/schedule.py`; `/api/agents/{id}/wakeups`, `/api/wakeups/{id}`; `features/dot/Schedule.tsx` |
| MI7 | Model and key per mind | Which model a mind thinks with, and who pays. | **Live**: Base | `features/models/ModelPicker.tsx`; `PATCH /api/agents/{id}`; `GET /api/models` |
| MI8 | Traces, logs and archive | What a mind did. Old traces move to a daily compressed archive and are never deleted. | **Live**: Base | `hive/core/archive.py`; `/api/agents/{id}/traces`, `/traces/archive/{day}`, `/logs`; `features/dot/ArchivedHistory.tsx`, `traceHistory.ts` |
| MI9 | Watch it think | Every model iteration on a live timeline, with replay. | **Live**: Base | `features/dot/MindTimeline.tsx` |
| MI10 | Reasoning viewers | Six read-only viewers on a mind's Tools tab: attention, self, energy, scratch, Assume and temporal. Each reads only when the hive's Tools app declares a `reasoning-module` read. Neither the installed Tools 0.6.1 nor 0.6.3 declares one, so today the viewers correctly say "no reader yet". | **Partial / limited**: UI shipped in 388fd72; no current reader | `features/dot/reasoning/ReasoningModules.tsx`, `ModuleViewer.tsx`, `load.ts` |
| MI11 | A mind's tools | What a mind can call (from its own boot receipt) and what it called. | **Live**: Base | `hive/core/inventory.py`; `/api/agents/{id}/inventory*`, `/api/agent/inventory*`; `features/dot/Tools.tsx`, `features/minds/MindTools.tsx` |
| MI12 | Sandboxed or not | Shows whether a running mind is actually OS-sandboxed. | **Live**: Base; cloud Landlock (a717292 receipt), Mac `HIVE_MIND_SANDBOX=1` | `features/dot/IsolationChip.tsx`; `/api/agents/{id}/isolation` |
| MI13 | Spending pause marker | "Paused: spending limit" when the hive is refusing a mind's model calls. | **Live**: Base | `features/dot/SpendingPause.tsx` |
| MI14 | Memory shared between minds | Timed, consented reads of another mind's memory. Every read is visible and can be revoked. | **Live**: Base | `hive/core/shares.py`; `/api/shares*`, `/api/agent/shares*`; `features/minds/MemorySharing.tsx` |
| MI15 | Move a mind between hives | Export, import and settle a mind (home ↔ cloud), or convert it to native. | **Partial / limited**: the code is deployed (Base), but no successful live move has been verified | `hive/core/placement.py`; `/api/agents/{id}/export\|settle\|moves\|convert-native`, `/api/agents/import`; `features/minds/MoveMind.tsx`, `features/dot/SwarmMove.tsx` |
| MI16 | Outside agents (harnesses) | Invite Claude Code, Codex or any MCP client into a swarm with a one-time code, then watch it connect. | **Live**: Base (this session connects through it) | `hive/core/mcp.py`; `/api/harness-invites*`; `features/harness/ConnectHarness.tsx`, `OpenInvites.tsx` |
| MI17 | Mind control: a team runs child minds | A team's controller starts child minds for one person's request, under a lease. | **Built and tested (139 tests), activation held; never spawned live**: `HIVE_MIND_SPAWN=1` is set on the Mac, unset on the cloud | `hive/core/minds.py`; `/api/teams/{swarm}/children*`, `/api/teams/{swarm}/templates`, `/api/agent/minds*`; `HIVE_MIND_SPAWN`, `HIVE_MIND_TEMPLATES` |
| MI18 | Delegation and lifecycle leases | An admin lets a coordinator start and stop its members for a set time. | **Live**: Base | `hive/core/delegation.py`, `lifecycle_broker.py`; `/api/lifecycle/*`, `/api/agent/lifecycle/{action}`; `features/lifecycle/LifecyclePage.tsx` |
| MI19 | Roles | Reusable job descriptions: a prompt, model, budget and approval rules. | **Live**: Base | `hive/core/roles.py`; `/api/roles*`; `features/roles/RolesPage.tsx`, `RoleSelect.tsx` |
| MI20 | Models and providers | AI providers, the OpenRouter catalogue and per-model endpoints. | **Live**: Base | `hive/core/providers.py`; `/api/providers*`; `features/models/ModelsPage.tsx`, `ProviderConnect.tsx` |
| MI21 | Mind kinds: Omega and external | Native OmegaClaw minds, and external members that connect over MCP. | **Live**: Base (17–21 cloud minds awake per the a717292 and Fusion/Planner receipts) | `hive/supervisor/workspace.py`; `hive/core/hive.py` |
| MI22 | Iter workers | Iter minds that work over HTTP. | **Partial / limited**: refused on the cloud because it needs the Docker driver (Docker is not installed and `HIVE_ALLOW_LOCAL_ITER` is not set); Mac only, where 2 Iter minds exist, both stopped | `hive/templates/iter/`; `HIVE_ITER_SRC`, `HIVE_ALLOW_LOCAL_ITER` |
| MI23 | Where minds run (drivers) | Local supervised processes (the default), or Docker containers. | **Partial / limited**: local is live; the Docker driver is unverified (`HIVE_DRIVER`, `HIVE_AGENT_IMAGE`, `HIVE_ITER_IMAGE`, `HIVE_DOCKER_NETWORK`) | `hive/supervisor/drivers.py`; `hive/docker/` |
| MI24 | Mind connection fixes | Minds dial the hive where it listens, use the hive's own Python, and never adopt another launch's channel. | **Live**: 33c598b, 4eba0e8, a717292, 3b0bb4a | `hive/supervisor/drivers.py`; `modules/channel_hive` |
| MI25 | Loops tuned to purpose | Task minds wait for messages and pause when done. | **In review / building**: first plan; review asked for fixes first | `PLATFORM_LOOP_PURPOSE_PLAN_r1_STANDIN_VERDICT.md` |
| MI26 | "Last seen" from real activity | — | **Planned**: host follow-up | status doc "To do" 4 |
| MI27 | `program_homes.mind_id` | Ties an app's home to a mind. | **Planned**: host follow-up | status doc "To do" 4 |
| MI28 | Mind panel | One panel per mind, with tabs: Chat, Thinking, Memory, Schedule, Model and Tools. Includes a status line and a phone layout. | **Live**: Base … a37082e | `features/dot/DotPanel.tsx`, `tabNav.ts`, `mindStatus.ts` |
| MI29 | Delete a mind | Deletes one mind: its stop is verified, the record is soft-deleted (memory kept on disk), its unfinished tasks are released, and cleanup can be retried. | **Live**: Base, lifecycle fences 216e1bf–26f913c | `DELETE /api/agents/{id}` (`app.py:1310`); `hive/core/hive.py:936` |

## 4. Swarms, rooms and messages

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| SW1 | Swarms and the swarm sheet | Teams of minds with one purpose. The sheet opens instantly (64 ms per the status doc; the 364c630 note says "instantly"). | **Live**: Base, 364c630 | `features/swarm/SwarmsIndex.tsx`, `SwarmView.tsx`, `SwarmSheetSkeleton.tsx`; `/api/swarms*` |
| SW2 | Start a swarm | Minds from roles, with a purpose. | **Live**: Base | `features/launch/LaunchSwarm.tsx` (`#/swarms/new`) |
| SW3 | Change a swarm | Rename it, change its purpose, set its coordinator or nest it. There is also an admin set-coordinator link from the Ask (f50c4da, cloud only). | **Live**: Base; the set-coordinator link is cloud only | `PATCH /api/swarms/{id}`; `features/swarm/SwarmSettings.tsx`, `coordinatorPicker.ts`, `swarmEdit.ts` |
| SW4 | Members and team | Who is in a swarm. | **Live**: Base | `features/swarm/SwarmTeam.tsx`, `team.ts` |
| SW5 | Vocabulary | The swarm's shared terms. | **Live**: Base | `/api/swarms/{id}/vocab` |
| SW6 | Archive and restore | Puts a swarm away with its history, and brings it back. | **Live**: Base | `/api/swarms/{id}/archive\|restore`; `features/swarm/ArchivedSwarms.tsx` |
| SW7 | Delete a swarm | Delete it empty, or in one step with its minds: preview first, then confirm by typing its exact name. | **Live**: 26f913c (host), 3eced24 (UI) | `/api/swarms/{id}/delete-preview`, `DELETE /api/swarms/{id}`; `features/swarm/SwarmDeleteDialog.tsx`, `deleteWithMinds.ts` |
| SW8 | Connections between swarms | Agreements between swarms: purpose, scope, how long, budget, who coordinates. They end automatically. | **Live**: Base | `hive/core/connections.py`; `/api/connections*`, `/api/agent/connections`; `features/swarm/SwarmConnections.tsx`, `RevokeConnection.tsx` |
| SW9 | Services between swarms | What one swarm offers others, with grants and a capability catalogue. | **Live**: Base | `/api/swarms/{id}/services`, `/api/agent/service-catalogue`, `/api/agent/services/{swarm}`; `features/swarm/SwarmServices.tsx`, `Catalogue.tsx` |
| SW10 | Cross-swarm requests | A request links a task in one swarm to a new task in another, with review context and completion. | **Live**: Base, a3b233e | `hive/core/collab.py`; `/api/agent/requests*`; `features/swarm/CodingSwarmInboxPanel.tsx` |
| SW11 | Artifacts and findings | Immutable artifact revisions, findings with responses and dispositions, and subscriptions. | **Live**: Base | `collab.py`; `/api/agent/artifacts*`, `/api/agent/findings*`, `/api/swarms/{id}/artifacts*`; `features/artifacts/ArtifactsPage.tsx` |
| SW12 | Rooms | DMs, groups, channels and projects as one thing, with members and one transcript. | **Live**: Base | `hive/core/rooms.py`; `/api/rooms*`, `/api/agent/rooms*` |
| SW13 | Swarm team rooms | A private room per swarm where minds talk with @mentions. This is host only: the room appears as an ordinary room in Messages (and in the showreel scene). 8739049 has no UI changes. | **Live**: 8739049 | `rooms.py`; `/api/swarms/{id}/room`, `/team-room/repair` |
| SW14 | Coffee Room | Where everyone in the hive, people and minds, can meet. | **Live**: 004176c, 32a0baa | `features/messages/coffee.ts`, `CoffeeParts.tsx` |
| SW15 | Sessions | A focused thread with one mind, a task and a spending cap. A session can also discover the coding workspaces its mind opened, using a short read grant that is revoked straight after the lookup. | **Live**: Base | `hive/core/sessions.py`; `/api/sessions*`, `GET /api/sessions/{id}/workspaces` (`app.py:1812`); `features/messages/SessionView.tsx` |
| SW16 | Messages page | All your rooms and DMs. | **Live**: Base | `features/messages/MessagesPage.tsx` (`#/messages`) |
| SW17 | Explore | Everything in the hive as filterable, groupable nodes, with your own saved groups and views. | **Live**: Base | `hive/core/explore.py`; `/api/explore*`; `features/explore/ExplorePage.tsx`, `MyGroups.tsx` |
| SW18 | Holarchy | Swarms nested inside minds. | **Live**: Base | `PATCH /api/swarms/{id}` `parent_mind_id`; Explore |
| SW19 | Find help for work | Who might take a piece of work, from roles, services and recorded claims. | **Live**: Base | `/api/match`, `/api/match/catalogue`; `features/tasks/FindHelp.tsx` |
| SW20 | Files and storage | Content-addressed assets, stores, transfers and cleanup. | **Live**: Base, local store only. The S3 store is not configured on the cloud | `hive/core/assets.py`; `/api/assets*`, `/api/asset-stores`, `/api/agent/assets*`; `features/assets/AssetsPage.tsx`, `Cleanup.tsx`; `HIVE_ASSET_STORES`, `HIVE_S3_*` |
| SW21 | Local-only swarms | A private swarm whose minds can't reach outside. | **Live on the Mac**: outside model calls refused (verified live 2026-10-04, build 1a1b268); used for a closed app | `HIVE_LOCAL_ONLY_SWARMS` |
| SW22 | The hive as galaxies, one per person | — | **Planned**: awaits the owner. The second revision of the plan passed one independent review; the second independent review is pending | `PLAN_HIVE_VIEW_SCALING_r2_20261009.md`; `PLATFORM_SURFACE_HIVE_SCALING_PLAN_r2_STANDIN_VERDICT.md` |
| SW23 | Hive to hive | Each person's hive is a node that talks to the cloud hive, in a DAS shard style. | **Planned**: the owner's direction; no reviewed plan was found | status doc "To do" 3 |
| SW24 | Board and service discovery routes | A read-only board view of tasks and services. | **Retired / legacy**: the Boards UI is gone; the read-only route remains | `hive/core/boards.py`; `/api/boards/{kind}`, `/api/agent/board` |

## 5. Motivations and tasks

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| MT1 | Motivations | The why above tasks: aims held by people, swarms and minds, with links and visibility. | **Live**: a3636a2 | `hive/core/motivations.py`; `/api/motivations*`, `/api/agent/motivations`; `features/tasks/MotivationsPage.tsx`; `hive/ui/src/experiences/Motivations.tsx` |
| MT2 | Motivation hierarchy | Nested motivations. | **Live, switched off**: off by default; `HIVE_MOTIVATION_HIERARCHY` is not set on the cloud | `HIVE_MOTIVATION_HIERARCHY` |
| MT3 | Tasks | The work itself, in columns or a list, by swarm, mind or motivation. | **Live**: a3636a2 | `/api/tasks`; `features/tasks/TasksPage.tsx`, `layout.ts` (`#/tasks`) |
| MT4 | Claims, leases and heartbeats | A claim is a lease. Lapsed work goes back to the swarm, and is marked stalled after repeated lapses. | **Live**: Base | `hive/core/goals.py`; `/api/agent/goals*` |
| MT5 | Create tasks and subtasks | People and minds post tasks, and minds propose subtasks. | **Live**: Base | `/api/swarms/{id}/goals`, `PATCH /api/goals/{id}`; `features/goals/cardActions.ts` |
| MT6 | Review submitted work | Accept or return results awaiting review, with their history. | **Live**: Base | `/api/goals/{id}/review(s)`, `/api/agent/goals/{id}/review`; `features/goals/Review.tsx`; `hive/ui/src/experiences/GoalDecision.tsx` |
| MT7 | Attempts | Every attempt on a task. | **Live**: Base | `/api/goals/{id}/attempts`; `features/tasks/Attempts.tsx` |
| MT8 | Code access for a task | Give a task's mind scoped code access. | **Live**: Base. Code itself is Mac only (OC1) | `/api/goals/{id}/grants*`; `features/tasks/CodeAccess.tsx` |
| MT9 | Result schemas | A result must have the right shape before a task can be done. | **Live**: Base | `hive/core/result_schema.py` |
| MT10 | Task links | Links between tasks, motivations and work. | **Live**: Base | `features/tasks/TaskLinks.tsx` |
| MT11 | OmegaEvolve's objective | Shown as a read-only motivation. | **Live**: Base | `features/tasks/EvolveObjective.tsx` |
| MT12 | Person instruction requests | A named admin's instruction becomes a request with its own budget root. Its proposals are accepted or declined. | **Live**: a3b233e | `hive/core/minds.py`; `/api/requests*`, `/api/requests/{id}/proposals/{sid}/{decision}` |
| MT13 | Flows | Connected workflows over tasks: revisions, adoption, runs, layout, templates, validation. | **Live**: Base | `hive/core/flows.py`, `hive/flow_ir/`; `/api/flows*`, `/api/flow-runs*`, `/api/swarms/{id}/flows`, `/api/agent/flows*`, `/api/agent/flow-runs*`; `features/flow/FlowPage.tsx`, `Adoptions.tsx` |
| MT14 | Flow Studio | A standalone flow editor page. | **Live**: Base | `hive/flow_studio/`; `GET /flow-studio/` |
| MT15 | Flow skills | Publish, run and retire flows as skills. Publishing needs an exact allow rule. | **Live**: Base | `/api/agent/flows/skills*`; `hive/core/policy.py` `EXPLICIT_ONLY` |
| MT16 | Old Goals page | — | **Retired / legacy**: `#/goals` redirects to Tasks; the `GoalsBoard.tsx` component remains | `hive/ui/src/lib/router.ts`; `features/goals/GoalsBoard.tsx` |
| MT17 | Old Boards page | — | **Retired / legacy**: `#/boards` redirects to Tasks (board view) | `router.ts`; `features/boards/columns.ts`, `types.ts` |

## 6. Commons and reasoning (NAL/PLN, MeTTa)

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| CR1 | Swarm commons in MeTTa | Each swarm's shared beliefs live in a PeTTa MeTTa space, not in SQL. | **Live**: Base | `hive/spaces/lib_hive.metta`, `service.py`, `sexpr.py` |
| CR2 | Publish beliefs | A mind publishes a statement with frequency and confidence. The outcome is adopted, revised, chosen, kept, duplicate, quarantined or denied. | **Live**: Base | `/api/agent/publish`; MCP `hive_publish` |
| CR3 | Query the commons | Search by MeTTa pattern across the swarm commons and the federation. | **Live**: Base | `/api/agent/query`; MCP `hive_query` |
| CR4 | Belief detail and evidence | Full provenance: every assertion and choice. | **Live**: Base | `/api/agent/belief`, `/api/swarms/{id}/beliefs*`; MCP `hive_evidence_query` |
| CR5 | What a swarm believes | A belief constellation (confident beliefs gather at the centre), with live provenance. | **Live**: Base | `features/swarm/Constellation.tsx`, `Provenance.tsx` |
| CR6 | Governance evidence | Each answer a person gives becomes a NAL observation in the governance commons. | **Live**: Base | `hive/core/governance_evidence.py` |
| CR7 | NAL library | NAL inference. Truth functions match ONA/Wang except the deviations listed in `docs/reasoning-deviations.md` (0.99 cap, no c=0/c=1 guards, unstamped skill path, the lib_nars collision, overlap revision-pool limits). The libraries stay unchanged per the owner. | **Live**: runtime | `lib_nal.metta`; `docs/reference-lib-nal.md`; `docs/reasoning-deviations.md` |
| CR8 | PLN library | PLN inference. It stays as it is, per the owner's ruling, and can be upgraded by its author; deviations in `docs/reasoning-deviations.md`. | **Live**: runtime | `lib_pln.metta`; `docs/reference-lib-pln.md` |
| CR9 | Evolve commons library | MeTTa rules for Evolve claims. | **Live**: Base | `hive/spaces/lib_evolve.metta` |
| CR10 | Commons form | The commons drawn natively in Classic, Still and Canvas. | **Live**: Base | `hive/ui/src/forms/commons/` |
| CR11 | Reasoning skills in minds | NAL/PLN skill cards and reasoning spaces inside each mind. | **Live**: runtime. Automatic invocation from the loop is **deliberately not wired** in this release; see CR15 | `src/skills_reasoning_spaces.metta`, `src/skill_*_reasoning.metta` |
| CR15 | Reasoning foundation (Hyperon Phase A) | NAL/NARS through the production skill path, honest ERROR/EMPTY results, collision fix. | **In review / held**: assembly gate PASS (bf57ed1, 69 passed); waits on the operator-naming ruling and activation review | platform branch; `docs/EARLIER_EXPERIMENTS.md` |
| CR16 | OBSERVE organ | Experience to atoms, written by the core. | **In review / held**: default-off source passed independent review (ae47103, 64 passed); not activated | platform branch; `docs/EARLIER_EXPERIMENTS.md` |
| CR12 | Honest truth values | — | **Planned**: plan (fourth revision); independent review passed | `PLATFORM_HONEST_TRUTH_VALUES_PLAN_R4_*` |
| CR13 | lib_hive statement evaluation hazard | — | **Planned**: host follow-up | status doc "To do" 4 |
| CR14 | Temporal reasoning | Five temporal operations (induce, sequence, predict, eternalize, revise-rule) as a private, default-off component over the existing native libraries. | **Partial / limited**: the private default-off component is qualified offline. Still pending: host admission, current custody, the time projection model (an owner choice), tours and caller use. The temporal catalogue entry is unavailable | the temporal adapter draft and the truth-value folder (Tools owner drafts, internal) |

## 7. Apps platform (programs, homes, activations, store)

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| AP1 | Dot program contract v0.1 | An app supplies a work graph through `describe()`, `view()` and `act()`; the host draws it. There is also a standalone compatibility checker. | **Live**: Base | `hive/PROGRAMS.md`; `hive/core/programs.py`; `python -m hive.programs_check` (`hive/programs_check.py`) |
| AP2 | Finding and loading apps | Built-in apps plus the operator's app folders, with a reload. | **Live**: Base | `hive/plugins/`; `HIVE_PLUGIN_DIRS`; `/api/programs`, `/api/programs/reload` |
| AP3 | Release pins | An app loads only if its source digest matches the pin. | **Live**: cloud receipt `PLATFORM_CLOUD_APPS_FUSION_PLANNER_TOOLS063_20261008.md` | `HIVE_APP_PINS`, `HIVE_APP_PINS_REQUIRED`; `Programs.source_digest` |
| AP4 | App pages | The apps index and each app's page, with stages (unfold, map, compare, detail), trail, sources and uncertainty. | **Live**: Base | `features/programs/ProgramsIndex.tsx`, `ProgramPage.tsx`, `Scene.tsx`, `Rail.tsx`, `Detail.tsx`; `/api/programs/{id}`, `/view`, `/ui` |
| AP5 | App identities | Each app brings its colours and motif into your look. | **Live**: Base | `hive/ui/src/shell/appIdentities.json`, `appLook.ts`, `appStage.ts` |
| AP6 | App actions with host confirm | A person runs an app action. The host shows exactly what will happen before it runs. | **Live**: Base | `/api/programs/{id}/act`, `/confirm`; `features/programs/HostConfirm.tsx`, `frameAct.ts`; `hive/ui/src/lib/hostConfirm.ts` |
| AP7 | Read actions | Apps declare read-only actions that people and minds can run. | **Live**: a17bdda | `/api/programs/{id}/read` |
| AP8 | Minds acting in apps | A mind may use an app action only when the app marks it for agents. | **Live**: Base | `hive/core/program_actions.py`; `/api/agent/programs/{id}/act` |
| AP9 | App homes | Which swarm an app lives in. | **Live**: cloud `HIVE_APP_HOMES` (Fusion/Planner/Tools receipt) | `/api/programs/{id}/homes`; `features/programs/homesLookup.ts` |
| AP10 | Activations, offers and attachments | Where an app runs, offers to swarms, and reviewed minds attached to it. | **Live**: Base | `hive/core/program_attachments.py`; `/api/programs/{id}/activations*`, `/offers`, `/attachments*` |
| AP11 | Pause or restore an app's access | Revoke or restore an app's grants. | **Live**: Base | `/api/programs/{id}/grants/revoke\|restore`, `/enable`, `/disable`; `features/programs/AppGrants.tsx` |
| AP12 | An app's own interface | Apps can ship their own UI in a sandboxed frame. It follows the frame-parts rules, puts the CSP first, and is fenced to your identity. | **Live**: 4bb1453, 0fb0238, 6a15357, 75fcf26, ce8001d | `hive/core/ui_parts.py`; `features/programs/AppFrame.tsx`; `hive/ui/src/lib/appFrame.ts`, `appBridge.ts`, `frameOps.ts` |
| AP13 | Frame operations | The host-side actions for apps' real interfaces (PROGRAMS §9c). | **Live**: Base | `features/programs/FrameOpsDialogs.tsx`; `hive/ui/src/lib/frameOps.ts` |
| AP14 | App drafts | Private drafts per person, per app, per swarm, with optimistic revisions. | **Live**: Base | `hive/core/app_drafts.py`; `/api/apps/{id}/drafts*` |
| AP15 | Sandboxed tool runs for apps | A reviewed app runs its pinned tools inside the OS sandbox: no network, job folder only. | **Live**: Tools and Design on both hives (`HIVE_SANDBOX_RUN_APPS`, runtime-mirror 41fa1ad) | `hive/core/sandbox_run.py`; `HIVE_SANDBOX_RUNTIMES` |
| AP16 | App grant renewal | Renews a private app's scoped grant. | **Mac only**: Atlas | `HIVE_APP_GRANT_RENEWAL` |
| AP17 | Opening apps in a sensible swarm | An app opens in a swarm that is visible, usable and not private, with a chooser when none qualifies. | **Live**: 6e937bd, 044fad4 | `features/programs/pickSwarm.ts`, `OpenIn.tsx`, `AppPicker.tsx` |
| AP18 | Unavailable-app page | Unpermitted app ids get a generic page, so private apps are never named. | **Live**: 0d6f4ca, 6838fab | `features/programs/RefusedHere.tsx`, `refusedBack.ts` |
| AP19 | Named-mind check | An app view that names a mind you can't see is refused as not found. | **Live**: 1f758f6, 3ef7710, 30a37d9 | `hive/core/programs.py` |
| AP20 | App activity | What apps did, and where. | **Live**: Base | `/api/program-activity`; `features/programs/AppActivity.tsx` |
| AP21 | Updates and holds | What is waiting to load (apps and platform), who asked, what must not be interrupted. Place or lift holds. | **Live**: Base | `hive/core/updates.py`; `/api/updates*`, `/api/agent/updates*`; `features/updates/UpdatesPage.tsx`, `Holds.tsx`, `RequestUpdate.tsx` |
| AP22 | Scientist route | A request bound to a revision and sent to a named mind, with deadlines and idempotent retry. | **Partial / limited**: backend built and tested; the UI morph and switcher are pending per PROGRAMS.md | `hive/PROGRAMS.md` §7, `hive/tests/test_scientist_route.py` |
| AP23 | App store | Installing apps from the UI. Later, the Atlas house in Town would open the app if it is installed, or its store entry if not (owner). | **Planned**: P6 app store. There is no store code; today the operator installs and pins apps | Surface build plan (END OF DAY, P6); `HIVE_PLUGIN_DIRS`, `HIVE_APP_PINS` |
| AP24 | Contract v0.2 | Program-owned tasks, deltas, out-of-process apps. | **Planned**: PROGRAMS.md lists it as "later"; no reviewed plan was found | `hive/PROGRAMS.md` status table |

## 8. The apps

### Studio (OmegaDesign) *(closed: `omegadesign`)*

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| ST1 | Studio 0.4.13 | An editable creative canvas with exact source custody. Actions (installed 0.4.13 `studio_actions.py` OPERATIONS): init, inspect, revise, direction, reuse-identity, select, svg, ui, react, merge; `program.py` also exposes model, motion and save-source. | **Live**: both hives (Fusion/Planner/Tools receipt; host seam ce8001d). Installed-code status only: it does not prove managed maker invocation, a complete creative workflow or quality parity | app: `0.4.13-raster-model-hooks` (release folder, outside this repo) (`studio_actions.py`, `program.py`); host form `hive/ui/src/forms/designCanvas/` |
| ST2 | Design canvas | The full-bleed canvas in the hive UI. | **Live**: 64e5c5c (installed/UI feature scope). Real person/mind joint-edit and full export acceptance remain separate | `hive/ui/src/forms/designCanvas/DesignCanvas.tsx`, `Stage.tsx`, `Chrome.tsx` |
| ST3 | 3D model actions | `model_actions.py` OPERATIONS are exactly model-init, model-inspect, model-revise, model-glb. | **Live**: 0.4.13 (installed-code status). No procedural/parametric shape capability is promoted to autonomous arbitrary high-quality model generation | release `model_actions.py` |
| ST4 | Motion and save-source | Motion renders a bounded `editable-motion.json`, `animated-motion.svg` and manifest with exact source custody; save-source is advertised as a person action, with the host's save refusal. | **Live**: 0.4.13, dc62077 (installed-code status). Successor full save/refusal/person and native export acceptance are still owed | release `motion_actions.py`, `source_io.py` |
| ST5 | Studio 0.4.16 (save, delete, import) | — | **Release reviewed, not installed/pinned (NOT_INSTALLED_NOT_PINNED); runtime/person acceptance pending**: both independent release reviews passed; digest 31ccf95b…a60d; there is no install receipt. The `.md` report's opening still says not-reviewed; the `.json` manifest's release_review/status is current | `PLATFORM_STUDIO_C5_SUCCESSOR_CANDIDATE_20261008.md`; `PLATFORM_STUDIO_C5_SUCCESSOR_CANDIDATE_20261008.json` (machine-readable digest/status) |
| ST6 | Minds call Studio (Design Studio caller, second revision) | — | **In review / building**: returned as a Design-owned packaging defect: `modules/omegadesign_studio/affordance.metta` is missing. Current candidate paths still lack the card, and current release modules exclude Studio. Candidate-only component/cloud caller evidence is separate from host skill registration/adoption | `PLATFORM_DEPLOY_B1_de63288_20261007.md` (B1) |
| ST7 | Design qualification run (fifteenth revision) | — | **Source reviewed, native run pending**: this revision passed both independent source reviews and once had a conditional one-run owner admission, but it has not been run. The failed result of the previous revision is retained, not superseded. Platform queues it after Tools installation | `PLATFORM_WRAPUP_ANSWER_THROUGH_AND_R15_QUEUE_READBACK_20261009.json` |
| ST8 | Image generation through the metered media route | — | **Live, switched off** (default-off media route): see BU10. Actual usable provider output is not qualified; a discrepancy kept from the seventh review revision needs an owner decision; metered vision inspection still returns 501. Not a usable complete creative workflow | `hive/core/media.py` |

| ST9 | Studio live sessions (host J3 R2 to R8.4) | A person directs a Studio maker on one of their saved pieces: setup from the Ask, cap and payer up front, per-step maker executions with a write fence, steering as queued directions, pause, resume, Stop, admin Stop and audit. | **Live on the cloud hive** since 2026-10-20 (`HIVE_STUDIO_SESSIONS`); **off on the Mac test hive**, where this build cannot switch it on. A maker's proposal reaching the canvas in a real person walk is not yet shown | `hive/core/studio_sessions.py`, `studio_steps.py`, `studio_handoff.py`, `studio_gateway.py`, `studio_steer.py`; `hive/ui/src/features/studioLive/` |
| ST10 | Each member's own Studio maker | Made by the host on first use in a private Studio space the person owns, on their own key; attached by the host (R7, R8.2). | **Live on the cloud hive** | `hive/core/studio_makers.py`; `POST /api/studio/setup` |
| ST11 | Host member attach (R8.3) | A hooked Studio app's `member_attach` declaration, read only from its digest-pinned release, gives the host attachment's exact scope. | **Live on the cloud hive** with Studio 0.4.21. The host attach writes no per-action policy rows, so the maker's own direct app actions would be refused | `hive/core/program_attachments.py` |
| ST12 | Images during a live session (R8) and on the canvas | The maker can generate an image on the person's own key during their session. | Generation **live on the cloud hive** (with `HIVE_MEDIA_ROUTE=on` there). **Placing it on the canvas is not done**: it needs host R9 and a later Studio release | `hive/core/media.py`, `studio_makers.py` |
| ST13 | Stale reads by content (R8.4) | A maker's proposal is refused as stale only when the piece's content changed since its read. | **Live on the cloud hive** (`5e204019`) | `hive/core/studio_steps.py` (`_same_content`) |

No Studio whole-parity row is closed (0/23 Studio whole-parity rows closed); strict quality pairs: 0.

### Tools

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| TO1 | Tools app | 20 advisory skill module families, 12 sets (pln, nal, temporal, multi-step, motivation, memory, epistemic, learning, ethics, self, habitat, substrates) and 26 native operation heads. The cloud's 0.6.3 has 8 executable Foundations recipes and 10 Foundations cards; the Mac's 0.6.1 has 5 recipes. The status doc reports it passed the 111-cell synthetic peer verifier (111/111). That verifier does not prove confinement, sustained concurrency, native-mind boot, UI usability, adoption, or that minds choose to use Tools on their own (`PLATFORM_TOOLS_063_DELTA_r2_STANDIN_VERDICT.md:21`). | **Live**: 0.6.3 on the cloud, 0.6.1 on the Mac | cloud `/opt/omegahive/apps/omega-tools-0.6.3`; Mac `0.6.1` (release folder, outside this repo) |
| TO2 | Tools actions | Inspect a component, foundation, set, tool or source; show examples; compose-set; run-native; run-foundation. | **Live** | release `program.py` |
| TO3 | Tools results view | Shows the results of tool runs. | **Live**: 3eced24 | `features/programs/ResultPanel.tsx` |
| TO4 | Native Tools host | The hive's registry and disposable worker for reviewed native tools, each pinned to its reviewed source. | **Live**: ecd5d03 … 6614939 | `hive/core/tools.py`, `tools_worker.py` |
| TO5 | Tools callers | Minds invoking Tools, with the live hand-back. | **In review / building**: the fourth revision is prepared and delivered (full 160de795, doc-test delta f313aee3); its full suite ran 2420 PASS / 57 SKIP (independent review passed; handed over by the Tools owner). Still pending: owner review, app admission and installation, and a real caller-use hand-back; Tools install/native use remains owner-owned and separate. The full suite of the previous Tools revision failed 3 cases (reported by Design) | `README.md` (Tools owner draft, internal) |
| TO6 | Foundations recipes (detail) | Delivered recipes: branch collection (`superpose`/`collapse`), pattern join, job-local spaces with retraction, exact result deduplication, counting, a parallel map, a mutex counter and a transaction counter. The concurrency cap is 8 tasks, not 8 worker threads. Reflection and "advanced" are documented concepts held back, not arbitrary eval. None of these edit a persistent AtomSpace. | **Live**: 0.6.3 on the cloud (8 recipes); 0.6.1 on the Mac (5) | the Tools release `foundations/` (`request.schema.json`, `catalogue.json`) |
| TO7 | Ontology reference demo | Borrowed priors (99 unknowns, kept inert) with a synthetic Learn/Atom binding, 7 negative cases and withdrawal and checkpoint checks. | **Partial / limited**: an offline reference only. Adoption by a recipient's mounted ontology, live adoption and a useful result are unqualified; frozen 0.6.3 has no recipient hooks | `ontology_reference_demo.py` (Tools owner draft, internal); `evidence/ontology-reference-demo-l0.json` |

### Evolve *(closed: `hive/plugins/omegaevolve`)*

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| EV1 | OmegaEvolve app | A research-record registry for an Omega and Iter pair (one real paid run completed 2026-10-04; capability gain unmeasured). Actions: register, contribute, register-benchmark, assess-benchmark, attach-benchmark-receipt, seed. | **Live**: enabled on the cloud (receipt), Evolve Omega a_5cef4301 awake (a717292) | `hive/plugins/omegaevolve/` |
| EV2 | Evolve claims and experiments | Immutable claims, offline preflight, lineage and a data-only projection. | **Live**: Base | `hive/core/evolve.py`, `evolve_preflight.py`, `evolve_projection.py`, `evolve_seed.py`, `evolve_state.py` |
| EV3 | OmegaBench | An evidence-bounded benchmark protocol: seal, compare, import trials, metrics. | **Partial / limited**: CLI and Lab suites only; no scheduler, adoption or official scores | `omegabench/`; Lab suites `tests-omegabench`, `bench-omega-development` |

### Fusion *(closed: `omegafusion`)*

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| FU1 | OmegaFusion 0.1.0 | A read-only synthetic slice: the society, markets, forecasts, receipts and track records. Actions: inspect-source, compare, inspect-receipt, inspect-actor, inspect-market, inspect-position, explain-score, view-channel. | **Live**: cloud (Fusion/Planner/Tools receipt) | release `69364e4` (release folder, outside this repo) |
| FU2 | Forecast composer | A person drafts and sends a forecast. | **Partial / limited**: the host composer exists, but 0.1.0 has no forecast-submit action | `features/programs/FusionComposer.tsx`, `fusionForecast.ts`, `fusionForecastActions.ts` |

### Planner

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| PL1 | OmegaPlanner plan checker 0.2.1 | Validates stored plans and, when asked, checks that a review return is complete. It has no person actions. | **Live**: cloud (receipt) | release `0.2.1-20261008` (release folder, outside this repo) |

### Library

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| LI1 | OmegaLibrary 0.1.0 | A pinned source shelf with page citations. People and attached minds can use library_search and library_read (read actions). | **Live**: both hives (`PLATFORM_OMEGALIBRARY_0.1.0_INSTALL_20261007.md`) | release `0.1.0-ecbd701` (release folder, outside this repo) |

### Commons Explorer

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| CE1 | Commons Explorer | "What does this swarm believe, and why?" Each belief unfolds into its reports, rivals and gaps. Actions: compare, inspect-source, challenge, investigate-gap (creates a task). | **Live**: enabled on the cloud (receipt) | `hive/plugins/commons_explorer/` |

### OmegaCode and vibe coding *(closed: `omegacode`)*

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| OC1 | Code service | OmegaCode workspaces, runs and verification, as a registered service on port 8724. | **Live on the Mac hive only** (release 345fde53, real runs since 2026-10-08; loaded-release receipt `PLATFORM_ROLLOUT_CODE_345fde53_HOST_4abf4e3_20261008.md`). That receipt excludes canonical-runner live behaviour and SSO-positive Code acceptance. No fresh process check was done on 2026-10-10. Cloud install in review | `omegacode` (closed repo); host `hive/core/code.py`; `HIVE_CODE_*` |
| OC2 | Code page | Edit targets: the platform, each app, each mind and each service. It shows a file tree and opens, attaches and selects workspaces through a proxy. | **Live on the Mac hive** (real runs since 2026-10-08, release 345fde53); cloud install in review: it needs the Code service | `features/code/CodePage.tsx`, `TargetCard.tsx`; `/api/code/*` |
| OC3 | Code canvas | Code drawn on a canvas, with vibe and hand modes. | **Live on the Mac hive** (real runs since 2026-10-08, release 345fde53); cloud install in review: UI shipped a3ce998, 53bb865 | `features/code/canvas/CodeCanvas.tsx` |
| OC4 | Vibe coding | Describe a change, the mind proposes, you get a plain summary, you accept. | **Live on the Mac hive** (UI and source shipped: 3eced24; release 345fde53); cloud install in review. Fully accepted experience is separate: Code's full human/model/Workbench/browser/comparator acceptance is still unqualified, and no successful end-to-end vibe interaction is asserted. Surface owns the shell and should confirm this row | `features/code/canvas/vibe.ts`, `vibeRoute.ts`, `vibeSession.ts`, `useVibe.ts` |
| OC5 | Copy-apply | A proposal is put into the person's own copy. | **Live, switched off**: `HIVE_COPY_APPLY_CLAIMS` is unset on both hives (receipts) | `hive/core/app.py`; `features/code/canvas/vibeConsent.ts` |
| OC6 | Copy-apply consent | Accepting or declining a newer consent revokes every earlier capability, and consent is re-checked at use. | **Live**: 4352af2 | `hive/core/services.py`, `minds.py` |
| OC7 | Hand tools | Editor, edit sessions, file actions, debugger, merge, git export, symbolic panel, suggestions, evidence history and live work. | **Mac only** (UI/source shipped). Fully accepted experience is separate: Code's full human/model/Workbench/browser/comparator acceptance is still unqualified, and no successful end-to-end debugger interaction is asserted. Surface owns the shell and should confirm this row | `features/code/*.tsx`, `features/code/suggestions/` |
| OC7a | Language queries and rename/completion previews | Language queries, rename previews, completion previews and completion applies for a workspace. | **Mac only**: Mac source/service implementation; depends on toolchain and grant; UI acceptance unqualified | omegacode `api.py` 529–545: `POST /v1/workspaces/{id}/language`, `/language/renames`, `/language/completion-previews`, `/language/completion-applies` |
| OC7b | Repository facts and retrieval | Python syntax facts and change impact; lexical/symbolic retrieval. The literal dynamic-import successor stays candidate-only. | **Mac only**: Mac source/service implementation; depends on toolchain and grant; UI acceptance unqualified | omegacode `api.py` 561–565: `POST /v1/workspaces/{id}/repository-facts`, `/repository-retrieval` |
| OC7c | Frozen run-result custody | Frozen proof-result, output and source custody for a run, plus the four run-result routes. | **Mac only**: Mac source/service implementation; depends on toolchain and grant; UI acceptance unqualified | omegacode `api.py` 739–768: `GET /v1/runs/{id}/proof-result`, `/output`, `/source` and the run-result routes |
| OC7d | Workspace fork, checkpoint, recovery and Git export | Source routes for workspace fork/checkpoint/recovery and Git export, within their scope limits and service-enforced authority. | **Mac only**: Mac source/service implementation; depends on toolchain and grant; UI acceptance unqualified. Not native/Linux or whole-parity accepted | omegacode `api.py` (workspace and export routes) |
| OC8 | Registered services | A service enrols with a one-time token, registers, sends heartbeats and holds capability tokens. Services can be turned off or removed. | **Live**: Base | `hive/core/services.py`; `/api/services*`, `/api/agent/code/*`; `features/settings/RegisteredServices.tsx` |
| OC9 | Proposal tests | Run-and-time holds for proposals. | **Live, switched off**: off by default; the proposal-test flags are not set on the cloud | `hive/core/proposal_tests.py`; `/api/services/proposal-tests/*`; `HIVE_PROPOSAL_TEST_CLAIMS`, `_ARGV_PREFIXES` |
| OC10 | Mind code skills | code-read and code-search are allowed. code-edit, code-run, code-merge-apply and the rest need approval for their exact binding. | **Mac only** (service availability): the host policy defaults can be present on both hosts; actual Code operations need an available Code service plus the exact grant/approval. "Mac only" describes where the service is available, not a different policy-default implementation | `hive/core/policy.py` defaults |
| OC11 | Code on the cloud | — | **In review / building**: the copy-only cloud design is reviewed (sixth revision); the fourth runbook revision has two export refusal failures and one Git restore-proof failure. A bounded, tested correction was delivered on 2026-10-09 (12 disposable cases pass); owner kit adoption/review of the correction and the target install are unconfirmed, and syntax checks alone do not qualify it. Needs the owner's three yeses | `PLATFORM_CLOUD_CODE_FIRST_CUT_RUNBOOK_R4_20261009.md`; `CLOUD_RUNBOOK_R4_EXPORT_CONTRACT_FINDINGS_20261009T162837Z.md`, `CLOUD_RUNBOOK_R4_GIT_CONTRACT_FINDING_20261009T163036Z.md`; correction receipt in the bundle report of `github-wrapup-current.json` |
| OC12 | Code Linux daemon and resident supervisor | — | **In review / building**: the current candidates are the Linux daemon client, the resident supervisor, the systemd unit and alert, and the client-supervisor interop check, frozen and packaged for review. An earlier daemon revision passed independent source review; these successors are delivered candidates that have not yet passed review, and are not live or proven on Linux. Linux startup, pin and runtime-fence decisions remain | Code wrap-up bundle `github-wrapup-20261009T174548Z` (receipt `github-wrapup-current.json`); omegacode candidate folders `linux_daemon_assembly_r38`, `linux_resident_supervisor_r31`, `linux_unit_alert_r1`, `linux_client_supervisor_interop_r2` |
| OC13 | Code's isolated Mac Python environment | — | **In review / building**: reviewed, not applied (no switch receipt). The test interpreter existing locally does not prove the live service changed interpreter | `PLATFORM_CODE_ISOLATED_ENV_r2_STANDIN_VERDICT.md` |
| OC14 | Code (Linux) owner contract | The reviewed contract (fourth revision) and its four amendments (A1, A2, A2.1, A2.2). | **Planned**: reviewed contract; the runtime is planned, and the build is under OC12. Handover-copy fingerprints (re-issued by the Code owner 2026-10-10; pins for this copy, not a replacement for the original reviewed contract identity): contract `d58da7cc9bb86e3ca23edd18912f0bbc3fcb82252abe88f58163566e46826ce2`; A1 `eae49027f662f29da66249e7e5add1b6f62b518d8679f1a7afc9000d70521630`; A2 `9fff91149f8f0cdc8c837c0fd66d22a7247f3ca18fcfd35c8c85c9da54c31672`; A2.1 `d651410f9ded6bfa259bf5d1416186d1f087202248dfec013a4ee3e7c54a89d0`; A2.2 `df5c13609a8b155effbd9446c8281418f7b31635f31dc092f64b6aaaa2f61723` | `PLATFORM_LINUX_CODE_OWNER_INTERFACE_R4_AMENDMENT_*`; omegacode `R4_HANDOVER_FINGERPRINTS_20261010.json` |

All 64 Code whole-parity requirements remain unqualified. OC2, OC3, OC5, OC6, OC8 and OC9 are unchanged: the Code owner found no contradicting evidence, which is not a fresh live/UI qualification.

### Other apps

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| OT1 | Atlas *(closed: `omegaatlas`)* | Personal-health app. Its life-map form (Classic, Cosmos and Still) moved out of the platform UI into `omegaatlas`. | **Mac only**; moved out of this repo | `omegaatlas` (closed repo) |
| OT2 | OmegaTruth *(closed: `omegatruth`)* | Research-truth app. Its case-file form (Classic, Construct and Still) moved out of the platform UI into `omegatruth`. | **Mac only**; moved out of this repo | `omegatruth` (closed repo) |
| OT3 | OmegaPurple *(closed: `omegapurple`)* | Dropped from the cloud because it is Goals-based; it is back with its owner. | **Mac only** | Mac `HIVE_APP_PINS` |
| OT4 | Contract fixture | A synthetic test app for contract 0.1. | **Live**: enabled on the cloud | `hive/plugins/contract_fixture/` |
| OT5 | OmegaSocial *(closed: `omegasocial`)* | Local social app candidates (action, attachment and human bridges). | **In review / building**: unmounted candidates only; no installed release | `omegasocial` (closed repo) |

## 9. Experiences and looks

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| EX1 | Classic | The original: a living star map with a side rail. | **Live**: Base | `hive/ui/src/experiences/registry.ts` (`CLASSIC`); `hive/ui/src/App.tsx` |
| EX2 | OmegaTown *(closed: folder `hive/ui/src/experiences/omegatown`)* | Walk among your minds, people and work. | **Live**: cloud and Mac, 6838fab, 0d6f4ca. 0d6f4ca also closed the direct-URL name echo (generic unavailable page, AP18) | `hive/ui/src/experiences/omegatown/` |
| EX3 | Cosmos | A 3D galaxy you fly through. | **Live**: Base (passed Surface review) | `experiences/cosmos/` |
| EX4 | Construct | A living terminal where everything is a command. | **Live**: Base (passed Surface review) | `experiences/construct/` |
| EX5 | Flux | Swarms as living fluid. | **Live**: Base (passed Surface review) | `experiences/flux/` |
| EX6 | Still | Just ask: one decision at a time. | **Live**: Base (passed Surface review) | `experiences/still/` |
| EX7 | Canvas | One infinite canvas: zoom out for the hive, zoom in to talk. | **Live**: Base (passed Surface review) | `experiences/canvas/` |
| EX8 | Professional | A clear workspace; a candidate for a refined Classic. | **Partial / limited**: in the Surface preview build only. It is compiled out of release builds, so neither hive offers it; it awaits a whole-experience review | `experiences/professional/`; `experiences/registry.ts:44-61` (`UNREVIEWED_ALLOWED`, `CANDIDATES`) |
| EX9 | Change UI gallery | Pick a look, layout or experience. It has no classic page. | **Live**: Base | `hive/ui/src/shell/ChangeUi.tsx`, `LookSection.tsx`, `LookPreviewBar.tsx` |
| EX10 | Looks | OmegaHive (default), Ember Forge, Deep Sea, Phosphor Terminal, Sakura Night, Paper Studio. | **Live**: Base | `hive/ui/src/shell/uiVariants.seed.json`, `uiVariant.ts` |
| EX11 | Layouts and density | Side rail, top bar or dock, at compact, regular or roomy density. | **Live**: Base | `shell/uiVariant.ts`, `layout.ts`, `rail.ts`, `navPrefs.ts` |
| EX12 | Your look, saved on the hive | Saved per person, with revisions; a stale write is refused. | **Live**: 1c47d2b–65aa421 | `hive/core/ui_prefs.py`; `/api/me/ui` |
| EX13 | Request an experience | Describe the experience you want. Includes look revisions, held looks and a conflict notice with "Use mine". | **Live**: c34d8c6 | `features/requestExperience/`; `shell/LookConflictNotice.tsx`, `lookActions.ts` |
| EX14 | Surface preview build | A marked test build that opens unreviewed experiences (Professional) and holds back Still and Canvas. | **Partial / limited**: a test mode only, never a release | `shell/PreviewBuildMarker.tsx`; `experiences/registry.ts:41-43` (`HELD_IN_PREVIEW`) |
| EX15 | Coverage rule | Every experience reaches every feature, natively or through its classic page (enforced by test). | **Live**: Base | `features/registry.ts` (63 features); `experiences/coverage.ts` |
| EX16 | Experience chrome | The Omega menu, the hive directory and scoped feature pickers inside experiences. | **Live**: Base | `experiences/OmegaMenu.tsx`, `HiveDirectory.tsx`, `ScopedFeaturePicker.tsx`, `ExperienceHost.tsx` |
| EX17 | OS clock | — | **Live**: de63288 | `shell/OsClock.tsx`, `clockModel.ts` |
| EX18 | Resting and power screens | Rest scenes and faces, and Off and Wake-all dialogs. | **Live**: d829307, f4b01aa | `features/power/` |
| EX19 | Command palette and search | Jump to anything. | **Live**: Base | `features/palette/CommandPalette.tsx`, `navCommands.ts`; `hive/ui/src/lib/fuzzy.ts` |
| EX20 | Ambient feed and keyboard access | A quiet live feed of the hive, and keyboard and screen-reader access to every dot. | **Live**: Base | `shell/Ambient.tsx`, `Hud.tsx` |
| EX21 | Readability and contrast | — | **Live**: 4180c31 | `hive/ui/src/forms/readabilityKit.ts`, `*/contrast.test.ts` |
| EX22 | Phone layouts | — | **Live**: 6e937bd | `features/dot/phoneLayout.ts` |
| EX23 | Live notices and approval toasts | — | **Live**: Base | `shell/liveNotices.ts`, `approvalToasts.ts` |
| EX24 | Classic navigation | One source for the rail, top bar, dock, phone bar and More sheet, the `g` shortcuts and the palette's navigation. | **Live**: Base, a3636a2, de63288, f4b01aa, a37082e | `hive/ui/src/shell/navItems.ts`, `Nav.tsx`, `NavMenu.tsx`, `navGo.ts`, `shortcuts.ts` |
| EX25 | Close goes back | Closing a page returns you to where you came from, through a per-tab navigation trail. | **Live**: b5619a3 | `hive/ui/src/lib/router.ts`; `lib/closeHome.*.test.ts` |
| EX26 | Frame-rate meter and Lab badge | An optional frame-rate meter (toggled in Change UI) and a Lab badge in the HUD. | **Live**: Base | `hive/ui/src/shell/FpsMeter.tsx`, `fpsMeterState.ts`, `LabBadge.tsx`; toggle `ChangeUi.tsx:105`; `Hud.tsx:110` |

## 10. Demo mode, showreel and guided demos

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| DM1 | Demo simulator (`?sim=1`) | A whole hive in the browser with invented people. It makes no real calls. | **Live**: Base and later | `hive/ui/src/api/sim/SimClient.ts`, `data.ts`, `demo.ts`, `demo3.ts`, `phase2.ts` |
| DM2 | Invented demo data | Ada and others. A guard test blocks real names. | **Live**: d18143b | `api/sim/noRealPeople.test.ts`; `OMEGA_PRIVATE_FAMILY_NAMES` |
| DM3 | Self-running showreel | "Watch it run" plays seven scenes with 0 model and 0 hive calls. Any input takes over. | **Live**: 918fdb4, 27da97f | `features/showreel/` (`scenes.ts`: personal-mind, team-room, swarm-delete, studio, tools, lab, health) |
| DM4 | Guided demos from the Ask | 25 scripts (6+5+4+4+4+2) play on the real page. They draw only and never click. | **Live**: first release d1a0c2f on both hives; the follow-up c57d30b is cloud only (Mac held on a37082e) | `features/guided/` (`scripts/apps.ts`, `brain.ts`, `hive.ts`, `modules.ts`, `people.ts`, `stubs.ts`) |
| DM5 | Guided Tools demos | — | **Live**: aec67c2 | `features/guided/scripts/apps.ts` |
| DM6 | Demo cursor and ink | The cursor plus circles, arrows and words, shared by the showreel and guided demos. | **Live**: d1a0c2f; the c57d30b follow-up changes are cloud only | `features/ink/` |
| DM7 | Welcome and tour | A first-run welcome, then a 10-chapter tour of the live hive. | **Live**: Base | `hive/ui/src/tour/` (`Intro.tsx`, `TourPlayer.tsx`, `chapters.ts`) |
| DM8 | Demo Ask card | What to try, plus the simulated memory switch. Demo mode only. | **Live**: 3eced24, 27da97f | `features/keys/DemoAskCard.tsx`, `demoTries.ts` |
| DM9 | Simulator commons on real MeTTa | The demo commons runs on the pinned lib_nal, lib_pln and lib_hive, over invented demo data. It is a bounded real-engine simulation; it doesn't qualify real host membership or consent. | **Live, cloud only (Mac held on a37082e)**: 3626a88 | `api/sim/commons.ts`, `api/sim/SimClient.ts`, `api/sim/parity/`; `hive/ui/src/lib/mindSpace/sources.ts` |
| DM10 | Demo polish | A fast swarm sheet, reliable orb clicks, no glow blow-out, demo-delete cleanup. | **Live**: 364c630, ff5886b | `hive/ui/src/scene/`, `features/swarm/` |
| DM11 | Assume demo | A causal prediction demo. | **Partial / limited**: a guided script and a repo demo, not a hive feature | `demos/assume/`; guided script `assume` |
| DM12 | Demo data for recent features (D2, D3) | Invented data for the Ask, team rooms and swarm delete (D2), and for Studio, Tools, Code/Lab and Health (D3). | **Live**: 3eced24 | `hive/ui/src/api/sim/demo.ts`, `demo3.ts` |
| DM13 | Simulator seed cache | A seed program the simulator has already run is not run again in the same page or test worker. | **Live, cloud only (Mac held on a37082e)**: 3626a88 | `hive/ui/src/api/sim/SimClient.ts:184-205` (`simSeedCache`) |
| DM14 | Standalone demo page build | `npm run build:demo` makes a demo-only page (`dist-demo/page.html`) for an outside host. | **Partial / limited**: a build target; neither hive deploys it | `hive/ui/package.json` `build:demo`; `hive/ui/scripts/artifact-page.mjs` |

## 11. Budgets, usage and health

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| BU1 | Spending rules at every level | Limits for the hive, a swarm, a mind, a key, a person or every mind, by day, month or total. | **Live**: Base | `hive/core/budgets.py`; `/api/budgets`, `DELETE /api/budgets/{rule}` |
| BU2 | Automatic limits | One hive total sets every other limit, always rounded down. | **Live**: 41b0d91 … a91de0c | `hive/core/limits_auto.py`; `HIVE_BUDGET_USD`, `HIVE_SWARM_MONTHLY_USD`, `HIVE_MEMBER_MONTHLY_USD`, `HIVE_PERSON_REQUEST_CEILING_USD` |
| BU3 | Limits page | Every limit in force, where it comes from, and what each mind is checked against. | **Live**: 7a25993 | `hive/core/limits_view.py`; `/api/budgets/limits`; `features/usage/Limits.tsx` |
| BU4 | Auto-candidates and overruns | — | **Live**: a759843 | `/api/budgets/auto-candidates`, `/api/budgets/overruns` |
| BU5 | Settle unknown-cost calls | Calls with unknown cost are held as reservations until a person settles them at their real cost or releases them. | **Live**: Base | `hive/core/cost_reservations.py`; `/api/budgets/reservations`, `POST /api/budgets/reservations/{id}/resolve` (`app.py:2217`); `features/usage/SettleCalls.tsx`, `heldCalls.ts` |
| BU6 | Usage and spend | Spend, tokens by kind, and your own spend. | **Live**: Base | `/api/usage`, `/api/usage/me`; `features/usage/UsageView.tsx`, `MySpend.tsx` |
| BU7 | LLM gateway | An OpenAI-compatible endpoint that picks the provider, injects the key, meters usage and refuses calls once a budget is spent. | **Live**: Base | `hive/core/gateway.py`; `/llm/v1/chat/completions`, `/llm/v1/embeddings`; `HIVE_MAX_LLM_CALLS_PER_MINUTE` |
| BU8 | Provider keys | Keys are stored 0600 and are never shown to minds or the UI (only a hint). The gateway sends each key only to its configured provider. Supports the OpenRouter catalogue and local LLMs. | **Live**: Base | `hive/core/providers.py`, `gateway.py:357`; `/api/providers/{name}/key`; `HIVE_PROVIDERS_FILE`, `HIVE_LOCAL_LLM_*` |
| BU9 | Unpriced models and offline mode | Lets models with no price run; runs the hive offline on mock/echo. | **Live, switched off**: `HIVE_ALLOW_UNPRICED=0` and `HIVE_OFFLINE` not set on the cloud | `HIVE_ALLOW_UNPRICED`, `HIVE_OFFLINE`, `HIVE_DEFAULT_MODEL`, `HIVE_EMBEDDING_MODEL` |
| BU10 | Metered media route | A host-metered image route for minds. | **Live, switched off**: `HIVE_MEDIA_ROUTE` is unset on both hives (26f913c receipt) | `hive/core/media.py`; `/llm/v1/media` |
| BU11 | Health | Errors across minds: classified, with patterns and what to do. | **Live**: Base | `hive/core/health.py`; `/api/health`, `/api/agent/health`, `/api/agents/{id}/health`; `features/health/HealthPage.tsx` |
| BU12 | The health mind | Which mind answers incidents. | **Live**: Base | `/api/health/mind`; `features/minds/HealthMind.tsx` |
| BU13 | Unconnected minds | Reports a mind that started but never connected. | **Live**: 1958e84 (first live catch recorded) | `health.py` |
| BU14 | Sleep and spend | — | **Live**: Base | `features/health/SleepAndSpend.tsx`, `sleepSpend.ts` |
| BU15 | Lab | Run 14 test and benchmark suites from the UI, with history, compare, drift, epistemic views and a scorecard. | **Live**: Base | `hive/core/lab.py`, `hive/bench/`; `/api/lab/*`; `features/lab/` |
| BU16 | Off, Wake all and Stop all | Off records who was awake and stops everyone; Wake all brings them back. Stop all is the kill switch. | **Live**: Base | `hive/core/power.py`; `/api/hive/power`, `/api/hive/stop-all`; `features/hive/StopAll.tsx`, `features/power/` |

## 12. Safety and privacy

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| SA1 | Policy gate | Every mind action is checked before it runs: allow, ask or deny. The most specific rule wins. Some skills are human-only, and some need an exact rule. | **Live**: Base | `hive/core/policy.py`; `/api/agent/authorize`, `/api/policy*` |
| SA2 | Reviewed hive skills | A new `hive-*` skill defaults to "ask" until it is reviewed and listed. | **Live**: Base | `policy.py` `REVIEWED_HIVE_SKILLS` |
| SA3 | Approvals | Once, For a time, Always, No, Never. Includes a track record and one-time redeem. | **Live**: Base | `/api/approvals*`, `/api/agent/approvals*`; `features/approvals/ApprovalsView.tsx`, `decision.ts`; `hive/ui/src/experiences/ApprovalDecision.tsx` |
| SA4 | Policy rules | What minds may do without asking. | **Live**: Base | `features/approvals/PolicyEditor.tsx` |
| SA5 | Decision history | — | **Live**: Base | `ApprovalsView.tsx` history tab |
| SA6 | Decision and confirm dialogs | Exact-digest confirmation before any consequential act. | **Live**: Base | `hive/ui/src/ui/DecisionDialog.tsx`, `ConfirmDialog.tsx`; `hive/ui/src/lib/confirmDigest.ts`, `decisionGate.ts` |
| SA7 | Visibility | Minds and swarms are private, shared or public. Admins keep sight for audit. | **Live**: Base | `hive/core/visibility.py`; `PUT /api/agents/{id}/visibility`, `/api/swarms/{id}/visibility`; `hive/ui/src/ui/Visibility.tsx` |
| SA8 | Others' personal minds hidden | Another person's personal mind or swarm is hidden from every default list and event, unless that person has shared it with you as a member. Admin audit is opt-in with `?include=personal`. | **Live, cloud only (Mac held on a37082e)**: 5617f4e | `visibility.py` `hidden_personal` (`:312`); `/api/swarms`, `/api/agents`, `/api/events` |
| SA9 | Mind-chat identity | The real sender is shown, each person sees only their own conversations, and replies bind to the right person. Cross-posting is refused. | **Live, cloud only (Mac held on a37082e)**: 5617f4e | `hive/core/app.py`, `rooms.py` |
| SA10 | Safe download names | A file is named only as the viewer is allowed to see it. | **Live, cloud only (Mac held on a37082e)**: 5617f4e | `assets.py` |
| SA11 | Personal content never stored | Personal Ask turns leave no content in the hive's history. | **Live**: b86cf47 | `personal.py`, `ask.py` |
| SA12 | Identity epoch | Per-person state dies when the signed-in identity changes. | **Live**: 7abb545 | `hive/ui/src/lib/identityEpoch.ts`, `epochBound.ts` |
| SA13 | OS sandbox for minds | Landlock on Linux, sandbox-exec on the Mac, an allowlisted environment and limits. | **Live**: cloud Landlock (a717292), Mac `HIVE_MIND_SANDBOX=1` | `hive/supervisor/sandbox.py`, `landlock.py`, `limits.sh`; `HIVE_MIND_SANDBOX(_PORTS)` |
| SA14 | Code grant scope | A person's grant scope bounds every Code capability. | **Live**: bfbb100 | `hive/core/services.py` |
| SA15 | One hive per data folder | An exclusive lock plus one start-up recovery. | **Live**: a3b233e | `hive/core/exclusive.py` |
| SA16 | Tokens shown once, stored hashed | Applies to minds, services and invites. | **Live**: Base | `hive.py`, `services.py`, `mcp.py` |
| SA17 | Wording and private-name guards | UI tests block forbidden wording and private names. | **Live**: test-enforced | `hive/ui/src/wordingGuard.test.ts`, `privateNames.test.ts` |

Mechanisms listed elsewhere: consent for memory sharing (MI14), copy-apply consent (OC6), private app names (AP18), demo name guard (DM2), public-request rules (PE7), provider keys (BU8), kill switch (BU16), governance evidence (CR6), local-only egress (SW21).

## 13. Platform and ops (deploy, mac-sync, MCP, outside agents)

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| OP1 | Cloud deploy | Deploys a release with a health check and a render check. | **Live**: every PLATFORM_DEPLOY_* receipt | `cloud-deploy.sh` (owner deploy script, outside this repo) |
| OP2 | Mac sync | Each cloud deploy also attempts a Mac sync. The restart can be held while Mac minds are awake. | **Live**: the Mac is behind, on a37082e (sync held) | `mac-sync.sh` (owner deploy script, outside this repo) |
| OP3 | Safe restart and sign-in check | — | **Live** | `restart-sessions.sh` (owner deploy script, outside this repo) |
| OP4 | Keep-assets deploy fix | — | **In review / building**: a second-revision candidate exists | `cloud-deploy.sh.keep-assets-r2-candidate` (owner deploy script, outside this repo) |
| OP5 | mac-sync runs `npm ci` | — | **Planned**: host follow-up | status doc "To do" 4 |
| OP6 | MCP endpoint | 20 tools: whoami, inbox, send, goals, goal_claim/get/result/heartbeat/cancel_ack/create, exhibit_read, artifact_read, revision_read, request, motivation_create, motivations, capabilities, publish, query, evidence_query. | **Live**: Base (used by this session) | `hive/core/mcp.py`; `/mcp`; `hive/MCP_S3.md`, `hive/JOINING.md` |
| OP7 | Agent hub and HTTP inbox | A WebSocket for minds, and HTTP inbox and messages for agents without one. | **Live**: Base | `WS /agent-hub`; `/api/agent/inbox`, `/api/agent/messages` |
| OP8 | Live events | A WebSocket to the UI. A browser leaving is quiet. | **Live**: 4d113e1 | `hive/core/events.py`; `WS /api/events` |
| OP9 | Other agent routes | Control, trace, skill decisions, exhibits and review receipts. | **Live**: Base | `/api/agent/control`, `/trace`, `/skills/decisions`, `/exhibits`, `/review-receipts` |
| OP10 | Safe reload after deploys | Reloads a stale UI chunk without losing your work. | **Live**: 3eced24 | `hive/ui/src/lib/chunkReload.ts`, `shell/unsavedWork.ts` |
| OP11 | Base paths and mounting | — | **Live**: Base | `app.py` (`outer.mount`); `HIVE_BASE_PATH`, `HIVE_HOST`, `HIVE_PORT` |
| OP12 | Linux app bundles and runtime mirror | — | **Live**: 8e3e02a, df5df49 … 41fa1ad | `hive/core/sandbox_run.py`, `hive/supervisor/` |
| OP13 | Services load releases only | The Code service is pinned to an immutable release. | **Live**: 4abf4e3, 692d04e | `hive/core/services.py`; `HIVE_CODE_SERVICE_CONFIG`, `HIVE_CODE_AGENT_PLIST` |
| OP14 | Run it locally | Setup script, requirements, `python -m hive`. | **Live**: documented | `README.md`; `scripts/dev/setup_petta_env.sh`; `hive/__main__.py` |
| OP15 | Deploy runbook and env template | — | **Live**: documented | `deploy/RUNBOOK.md`, `deploy/hive.env.example`, `deploy/setup_runtime.sh` |
| OP16 | Docker image and workflows | — | **Partial / limited**: the Dockerfile and agent images are present; upstream workflows are disabled, and only ci.yml is active | `Dockerfile`, `hive/docker/`, `docs/inherited-workflows/` |
| OP17 | This GitHub repo | — | **In review / building**: the `github-ready` snapshot of 5617f4e, prepared and verified, not pushed | `PLATFORM_GITHUB_REPO_READY_20261009.md` |
| OP18 | Installers and doctor | Installers for the OmegaClaw core. | **UNKNOWN**: no hive receipt | `install/` (`macos/`, `windows/`, `doctor.py`) |

## 14. Runtime (OmegaClaw core, PeTTa, skills)

| # | Feature | What it does | State | Where |
|---|---|---|---|---|
| RT1 | OmegaClaw core loop | Receive, build context, call the LLM, parse skills, evaluate, append history. Every Omega mind runs it. | **Live**: cloud minds awake (a717292) | `run.metta`, `lib_omegaclaw*.metta`, `src/loop.metta`, `src/helper*.py`, `lib_llm_ext.py` |
| RT2 | PeTTa | MeTTa on SWI-Prolog; it runs minds and commons. | **Live** | `PETTA_PATH`; `scripts/dev/setup_petta_env.sh`; `hive/supervisor/drivers.py` |
| RT3 | Syntax command membrane | Typed command signatures, so bad output fails closed. | **Live** | `src/helper_command_parser.py`, `src/skill_signatures*.metta` |
| RT4 | Runtime memory spaces | Named spaces: persistent, agenda, beliefs, world, events, and others. | **Live** | `src/skills_runtime_spaces.metta`, `src/memory.metta` |
| RT5 | Skill affordance directory | Skill cards, help, aliases and choose-skill-for. | **Live** | `src/skills_affordance.metta`, `src/skill_catalog*.metta`, `src/skill_affordance*.metta` |
| RT6 | Context compaction | Large payloads get a mechanical placeholder in the model's view; raw history stays exact. | **Live** | `src/helper_metta.py` |
| RT7 | Pin, energy and spin pressure | — | **Live** | `src/skills_core.metta`, `src/energy.py`, `src/attention_ledger.py`, `src/attention_spin.metta` |
| RT8 | Attention | A heuristic attention classifier (ECAN-inspired naming: constant STI/LTI, no spreading). Full ECAN is design intent; V2 has a tested native attention bank (`docs/EARLIER_EXPERIMENTS.md`). | **Live** | `lib_omegaclaw_attention.metta`, `src/skills_attention.metta` |
| RT9 | Proposal-first cleanup | — | **Live** | `src/skills_memory.metta`, `src/skills_space_mutation.metta` |
| RT10 | Module contract and loader | — | **Live** | `modules/loader.metta`, `modules/*/module.toml`; `docs/reference-omegaclaw-module-contract.md` |
| RT11 | Hive channel | How every hive mind talks to its hive. | **Live** | `modules/channel_hive`, `modules/hive`; `hive/templates/omega/prompt.txt`; `HIVE_WS_URL/TOKEN`, `HIVE_TOKEN`, `HIVE_API_URL`, `HIVE_LLM_*`, `HIVE_CHANNEL_DIR`, `HIVE_LAUNCH_ID` |
| RT12 | Other channels | WhatsApp *(bridge closed: GPL-3 dependency)*, Telegram, Mattermost, Slack, IRC, web control, mock and web search. | **Partial / limited**: WhatsApp, Telegram and web control carried a long-running mind in production in 2026; hive minds use the hive channel by design. Slack, Mattermost and IRC are untested in production | `channels/*.py`, `modules/channel_*` |
| RT13 | Senses and bodies | Vision, webcam, audio, Home Assistant, image and video generation, publishing, VM, Game Boy, body container, scheduler reminders, scratch space. | **Partial / limited**: optional modules; not wired for hive minds by default | `modules/sense_*`, `modules/home_assistant`, `modules/media_*`, `modules/publishing`, `modules/omega_vm`, `modules/gameboy`, `modules/body_container`, `modules/scheduler_reminders`, `modules/scratch_space` |
| RT14 | Assume / FabricPC | A predictive-coding organ. Its graph is MeTTa atoms; the JAX FabricPC engine is an optional warm numeric view and needs an external checkout. Learned changes return as reviewable atoms. | **Optional module, tested**: symbolic tests pass offline (50 passed; 12 FabricPC cases skip without the engine). Not enabled for hive minds | `modules/assume` |
| RT15 | Agentverse remote agents | — | **Partial / limited**: optional module | `modules/agentverse` |
| RT16 | Codex code hand | — | **Partial / limited**: optional module | `modules/code`, `modules/codex_code`, `src/codex_code.py` |
| RT17 | Vector memory | ChromaDB-backed memory. The workspace clones the ChromaDB library itself when `HIVE_CHROMADB_LIB` is absent, so that setting being absent doesn't make the store unavailable. Embeddings default to mock/hash, and the cloud sets no embedding model. | **Partial / limited**: the cloud embeds with mock/hash; ChromaDB availability on the cloud is unverified | `hive/supervisor/workspace.py:73` (`chromadb_lib`); `HIVE_CHROMADB_LIB`, `HIVE_EMBEDDING_MODEL` |
| RT18 | Optional glucose module | — | **Built, code only**: the core `src/glucose.py` connector ships (no credentials or readings); the modular `modules/health_glucose` app ships too | `src/glucose.py` |
| RT19 | Core tests and docs | — | **Live**: root tests 378 OK, 19 skipped (2026-10-10; see `STATUS.md`) | `tests/`, `Autotests/`, `docs/reference-*`, `docs/tutorial-01..08` |

## Review of this list (third revision)

Every correction below was checked against the code of the release snapshot or 5617f4e, or against a receipt, before it was applied.

| Checker | What they checked | Result | What the third revision did |
|---|---|---|---|
| Independent reviewer (a GPT model) | The whole second revision (sha af86f479) | **CORRECTIONS-NEEDED** (`OMEGAHIVE_FEATURE_LIST_R2_STANDIN_CHECK.md`) | Applied all of it: (1) added MI29 (delete a mind) and session workspaces in SW15; (2) RT17 splits ChromaDB availability from the mock/hash default (`workspace.py:73`); SA8–SA10 are cloud only; MI15 is Partial (no live move verified); (3) BU5 now cites `/budgets/reservations/{id}/resolve` (`app.py:2217`); ST8 points to BU10; coordination paths are now absolute; (4) BU8 says keys go to the configured provider (`gateway.py:357`); SA8 keeps shared-as-member minds visible (`visibility.py:312`); OP2 says "attempts"; counts are now 367 endpoints, 37 folders and 63 registry entries. The AP15 note was garbled: 41fa1ad is the correct runtime-mirror commit, so AP15 is unchanged. |
| Surface | The Surface-owned rows (UI, Ask, experiences, demo) | 23 corrections and 8 missing rows (`FEATURE_LIST_R1_SURFACE_CORRECTIONS_20261009.md`) | Applied every one: PM2, PM4, PM16, PM17, PM23, PM34–PM38, MI4, MI10, SW3, SW13, EX2, EX8, EX14, DM4, DM6, DM9, SW22, AP23 and AP4, plus new rows PM41, PM42, MI28, EX24, EX25, DM12, DM13 and DM14. The cloud-only split for 765de1a, f50c4da, 3626a88, c57d30b and 5617f4e was confirmed with `git log a37082e..5617f4e`. Platform confirmed the Mac conductor is off. |
| Tools owner | Tools, reasoning and Commons | Corrections (`20261009-175708Z-root-feature-list-tools-reasoning-commons-wrapup-corrections.md`) | Applied: TO1 (8 recipes on 0.6.3, 5 on 0.6.1, 26 operation heads); TO5 (fourth revision prepared and delivered); CR14 is Partial (a private default-off temporal component); MI10 is qualified (no current reader); DM9 is qualified (demo, not host consent); CR7 audit wording; new rows TO6 (Foundations detail) and TO7 (ontology reference demo, Partial). |
| Code | The Code wrap-up handoff (`20261009T174703Z-code-to-platform-opus-github-upload-wrap-handoff.md`) | Not about the list | It is a GitHub packaging handoff. OC12 was updated from it: the Linux daemon, supervisor, unit and interop candidates are frozen for review. |
| Design | The Design wrap-up and acceptance queue (`20261009T174448Z-omegadesign-to-platform-wrapup-current-acceptance-queue.md`) | Not about the list | It is an acceptance queue. It updated ST5 (0.4.16 digest reviewed, no install receipt), ST7 (the qualification run hasn't run) and TO5 (the previous Tools full suite failed 3 cases). |
| Second independent reviewer (a different model family) | The whole second revision | **CORRECTIONS-NEEDED** (`a red-team review log (internal)`) | Applied: (1) the app-repos receipt now exists, and the "doesn't cover" bullet is corrected; (2) 63 registry features; (4) new row EX26 (frame-rate meter and Lab badge); (6) TO1 reworded to the 111-cell synthetic peer verifier, with its limits; (7) SW1's 64 ms is now sourced to the status doc. (5) needed no change: the MI8 trace-archive and log routes were already cited. |

**Where reviewers disagreed, and what the third revision chose:**
- **Endpoint count.** One reviewer says 363, with the 4 loop routes already inside it. The other says 363 + 4 = 367. The code shows the loop routes are registered by a call, `app.post(f"/api/agents/{{agent_id}}/{action}")(lifecycle)` at `app.py:1320`, not by a decorator, so they are not among the 363. **367** is used. One decorator, `@app.get('/api/tools')` at `app.py:1220`, is single-quoted; the first revision's count missed it, which is where the 362 came from.
- **MI10.** Surface corrected only the commit (Live, 388fd72). The Tools owner asked for a qualification. `ReasoningModules.tsx:13-14` confirms the viewers read only when the Tools app declares `reasoning-module`, and neither Tools release does. So MI10 is **Partial / limited** (the UI shipped, but there is no reader yet).
- **EX8.** The first revision had it as In review; Surface says Partial. `registry.ts` compiles candidates out of production builds, so Surface's **Partial / limited** (preview build only) is used.
- **PM37 and PM38.** The first revision had them as Planned and In review. Surface's build plan records all five mind-wiring revisions as frozen. PM37 is now **Retired / legacy** (superseded by PM36), and PM38 is **Planned** (on hold).

---

## How this was checked

**Read-only.** No code was edited, nothing was committed, and no hive was touched. This file was then added to the repo as `docs/FEATURES.md`.

**Mechanical enumeration of the release snapshot (before the handover round):**

| Item | Count | How it was counted | Where it maps |
|---|---|---|---|
| HTTP and WebSocket endpoints in `hive/core` | **367** | 363 decorators (the first two revisions missed `@app.get('/api/tools')`, which is single-quoted) plus 4 registered in a loop (`/api/agents/{id}/start\|stop\|sleep\|wake`). Route modules installed: `boards.install_routes`, `motivations.install_routes` | 85 prefix groups, listed below |
| UI feature folders (`hive/ui/src/features/*`) | **37**, plus `registry.ts` (63 features) and `auditMap.ts` | `ls` | listed below |
| UI forms (`hive/ui/src/forms/*`) | **4** at the time (commons, caseFile, lifeMap, designCanvas); caseFile and lifeMap have since moved to the closed `omegatruth` and `omegaatlas` repos | `ls` | CR10, OT2, OT1, ST2 |
| Experiences | **8** (7 released, plus Professional as a candidate) | `experiences/registry.ts` | EX1–EX8 |
| Looks | **6** variants (default plus 5 seeds), **3** layouts, **8** app identities | `uiVariants.seed.json`, `uiVariant.ts`, `appIdentities.json` | EX10, EX11, AP5 |
| In-repo plugins | **3** (commons_explorer, contract_fixture, omegaevolve) | `ls hive/plugins` | CE1, OT4, EV1 |
| External apps | **6** reviewed releases read (Studio 0.4.13, Tools 0.6.1, Fusion 69364e4, Planner 0.2.1, Library 0.1.0, Code service 345fde53), plus Purple, Atlas and Truth as Mac-only and private | the `describe()` action lists in each `program.py` | section 8 |
| MCP tools | **20** | `hive/core/mcp.py` tool list | OP6, plus the per-tool rows CR2–CR4, MT1, MT4–MT5, SW9–SW11 |
| `HIVE_*` env flags | **93** in code (98 with tests and docs) | `grep -oE "HIVE_[A-Z0-9_]+"` | listed below |
| Showreel scenes, guided scripts, tour chapters | **7**, **25**, **10** | `scenes.ts`, `guided/scripts/*.ts`, `tour/chapters.ts` | DM3, DM4, DM7 |
| Lab suites | **14** | `hive/bench/catalog.py` | BU15 |

**How routes map to rows (85 prefix groups):**
- tools (`/api/tools`, the native Tools catalogue) → TO4
- auth → PE1–PE10
- people, invites → PE11
- asks → PE12
- keys → PE13
- settings → PE16
- me (`me/mind`, `me/ask`, `me/ui`) → PM1, PM8, PM14, EX12
- ask → PM14–PM29
- agents → MI2–MI15, MI28, MI29
- wakeups → MI6
- models, providers → MI7, MI20
- shares, `agent/shares` → MI14
- harness-invites → MI16
- teams, `agent/minds` → MI17
- lifecycle, `agent/lifecycle` → MI18
- roles → MI19
- swarms → SW1–SW7, SW9, SW11, SW13, CR4, MT5, MT13, SA7
- connections, `agent/connections` → SW8
- `agent/service-catalogue`, `agent/services` → SW9
- `agent/requests` → SW10
- `agent/artifacts`, `agent/findings`, `agent/exhibits` → SW11, OP9
- rooms, `agent/rooms` → SW12
- sessions (including `sessions/{id}/workspaces`) → SW15
- explore → SW17
- match → SW19
- assets, asset-stores, `agent/assets` → SW20
- boards, `agent/board` → SW24
- motivations, `agent/motivations` → MT1
- tasks → MT3
- goals, `agent/goals` → MT4–MT8
- requests → MT12
- flows, flow-runs, flow-studio, `agent/flows`, `agent/flow-runs` → MT13–MT15
- `agent/publish`, `agent/query`, `agent/belief` → CR2–CR4
- programs, `agent/programs` → AP1–AP13
- apps → AP14
- program-activity → AP20
- updates, `agent/updates` → AP21
- code, `agent/code` → OC2, OC8
- services → OC8, OC9
- budgets → BU1–BU5
- usage → BU6
- llm → BU7, BU10
- health, `agent/health` → BU11, BU12
- lab → BU15
- hive (`hive`, `hive/identity`, `hive/power`, `hive/stop-all`) → MI1, PE15, BU16
- policy, `agent/authorize` → SA1, SA4
- approvals, `agent/approvals` → SA3
- `agent/inventory` → MI11
- `agent/skills` → OP9
- mcp → OP6
- agent-hub, `agent/inbox`, `agent/messages` → OP7
- events → OP8
- `agent/control`, `agent/trace`, `agent/review-receipts` → OP9
- the `{path}` catch-all (UI) → EX1

**How feature folders map to rows (37):**
- approvals → SA3–SA5, PE12
- artifacts → SW11
- ask → PM13–PM31
- assets → SW20
- boards → MT17
- code → OC2–OC7
- create → MI2
- dot → MI3–MI13, MI28, PM26
- explore → SW17
- flow → MT13
- goals → MT6, MT16
- guided → DM4, DM5
- harness → MI16
- health → BU11, BU14
- hive → BU16
- ink → DM6
- keys → PE13, PM5, DM8
- lab → BU15
- launch → SW2
- lifecycle → MI18
- messages → SW14–SW16
- mind → PM4–PM13
- minds → MI11, MI14, MI15, BU12
- models → MI7, MI20
- palette → EX19
- people → PE11, PE5
- power → EX18, BU16
- programs → AP4–AP20, FU2, TO3
- requestExperience → EX13
- roles → MI19
- settings → PE16, PM29, OC8
- setup → PE14
- showreel → DM3
- swarm → SW1–SW11, CR5
- tasks → MT1, MT3, MT7, MT8, MT10, MT11, SW19
- updates → AP21
- usage → BU3, BU5, BU6

**How the 93 env flags map to rows** (full names, without the `HIVE_` prefix):
- **Sign-in:**
  - `ADMIN_PASSWORD` → PE1
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` → PE2
  - `SIGNIN_DOMAINS` → PE3
  - `ADMIN_EMAILS` → PE4
  - `SSO_LOGIN_URL`, `SSO_USERS`, `SSO_TTL_HOURS`, `SSO_STATE_DIR` → PE6
  - `PUBLIC_URL`, `PUBLIC_BASE`, `PUBLIC_PASSWORD`, `INVITE_PATH`, `BASE_PATH` → PE7, OP11
- **Ask:** `ASK_CONDUCTOR`, `ASK_CONDUCTOR_MODEL`, `ASK_CONDUCTOR_AB_MODELS`, `ASK_CONDUCTOR_TURN_USD`, `ASK_MEMORY`, `ASK_TIMEOUT_SECONDS` → PM17, PM18, PM32
- **Minds:**
  - `MIND_SPAWN`, `MIND_TEMPLATES` → MI17
  - `DRIVER`, `AGENT_IMAGE`, `ITER_IMAGE`, `DOCKER_NETWORK`, `SUPERVISED` → MI23
  - `ITER_SRC`, `ALLOW_LOCAL_ITER` → MI22
  - `PYTHON` → MI24
  - `MIND_SANDBOX`, `MIND_SANDBOX_PORTS` → MI12, SA13
- **Commons and tasks:**
  - `LOCAL_ONLY_SWARMS` → SW21
  - `ASSET_STORES`, `S3_KEY`, `S3_SECRET` → SW20
  - `MOTIVATION_HIERARCHY` → MT2
  - `GOAL_LEASE_MINUTES` → MT4
- **Apps:**
  - `PLUGIN_DIRS` → AP2
  - `APP_PINS`, `APP_PINS_REQUIRED` → AP3
  - `APP_HOMES` → AP9
  - `SANDBOX_RUN_APPS`, `SANDBOX_RUNTIMES` → AP15
  - `APP_GRANT_RENEWAL` → AP16
- **Code:**
  - `CODE_REPOS`, `CODE_OWNERS`, `CODE_ALLOW_PRIVATE`, `CODE_SERVICE_CONFIG`, `CODE_AGENT_PLIST` → OC1, OP13
  - `COPY_APPLY_CLAIMS` → OC5
  - `PROPOSAL_TEST_CLAIMS`, `PROPOSAL_TEST_ARGV_PREFIXES` → OC9
- **Money:**
  - `BUDGET_USD`, `SWARM_MONTHLY_USD`, `MEMBER_MONTHLY_USD`, `PERSON_REQUEST_CEILING_USD` → BU2
  - `MAX_LLM_CALLS_PER_MINUTE` → BU7
  - `PROVIDERS_FILE`, `LOCAL_LLM_URL`, `LOCAL_LLM_KEY`, `LOCAL_LLM_MODELS` → BU8
  - `ALLOW_UNPRICED`, `OFFLINE`, `DEFAULT_MODEL`, `EMBEDDING_MODEL` → BU9
  - `MEDIA_ROUTE` → BU10
- **Runtime:**
  - `CORE_ROOT`, `CHROMADB_LIB` → RT1, RT17
  - mind-side: `AGENT_ID`, `TOKEN`, `WS_URL`, `WS_TOKEN`, `API_URL`, `LLM_URL`, `LLM_TOKEN`, `LLM_MODEL`, `CHANNEL_DIR`, `LAUNCH_ID`, `SKILLS`, `PROMPT`, `BASE_PROMPT` → RT11
- **Process:** `DATA_DIR`, `HOST`, `PORT`, `LOG_LEVEL` → OP11, SA15
- **Lab and tests:** `BENCH_MODEL`, `BENCH_WATTS_PER_CORE`, `E2E`, `EPISTEMIC_RESOLVE`, `TEST_PETTA`, `TEST_CHROMADB_LIB` → BU15, RT19

**Changes in the second revision (history):** Platform read the cloud's environment *names* (values only for two non-secret flags: `ALLOW_UNPRICED=0`, `MIND_SANDBOX=1`). From that:
- PE3 is Live.
- PE6 and MI17 are Mac only.
- MT2, OC9 and BU9 are Live, switched off.
- PM32 is Live on code defaults.
- RT17 is Partial.
- SW20 is local store only.

OP18 (installers) stays UNKNOWN, because no code evidence settles it.

MI22 is resolved from cloud evidence: two Iter minds created on 10-08 are in `error` with "start refused: Iter workers … must run sandboxed: use the docker driver, or set HIVE_ALLOW_LOCAL_ITER=1" (`hive/supervisor/drivers.py:175`). Privacy combined is Live at 5617f4e. The repo's `docs/STATUS.md` line 3 was corrected to "prepared from 5617f4e".

**Limits of this check:** enumerating endpoints, folders and settings shows that every one of them maps to a row. It does not prove that every user-visible feature has a row. Rows added in the third revision from review show that gap: PM41, PM42, MI28, MI29, EX24, EX25, DM12–DM14, TO6 and TO7.

**What "Live" rests on:**
1. The release repo log (`omegahive-private` (release folder, outside this repo), 157 commits; each message names its verdicts).
2. The cloud live head 5617f4e (status doc and `session.json`).
3. The deploy receipts dated 7–9 Oct.
4. The cloud apps receipt and the Code rollout receipt.
5. `git log` on each file, which places it in Base 2ccc456 or a later commit.

For flag-gated features, the cloud state comes from the deploy receipts (conductor and memory on, copy-apply off, media off) and from Platform's read of the cloud environment names (second revision). A setting that is absent uses the code default. The Mac's flags were read from the non-secret lines of the owner's Mac launcher (outside this repo).

**Where the evidence disagrees:**
- The status doc puts the combined privacy change (third revision) under "In review", but release commit 5617f4e *is* its fourth revision, which passed independent review. It is listed as Live here.
- `docs/STATUS.md` line 3 in the repo said "prepared from c57d30b". It was fixed in the second revision to say 5617f4e.

**What this list doesn't cover:**
- **App repos.** The first revision said this receipt was missing. It now exists: `PLATFORM_GITHUB_APP_REPOS_20261009.md`, written at 18:41 after the first revision, is the app-repo inventory (prepared, not published). It lists Studio 0.4.13, Tools 0.6.3, Fusion 69364e4, Planner 0.2.1, Library ecbd701 and Code 345fde53. Purple, Atlas and Truth are excluded. The app rows here were read from the pinned release folders those shas name. Tools 0.6.3 was checked through the Tools owner's report, and its source is `0.6.3` (Tools owner draft, internal).
- The cloud's environment was read by name only, by Platform. Its values were not read, apart from the two non-secret flags above.
