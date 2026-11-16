# OmegaHive: done and to do (state at 12 Oct 2026)

Test counts and the current what-works / what-is-limited summary are in the root `STATUS.md`.

Release this repository was prepared from: **5617f4e**. Work that went live after it arrives as
pull requests: up to live release **15e24f0** under "Done (10 Oct)" (merged), and up to live release
**f3f4bb8** under "Done (10 to 12 Oct)".

Every change under "Done" was reviewed by two independent reviewers, tested, deployed and render-checked.

## Done (10 to 12 Oct, live up to f3f4bb8; brought over as pull requests)

Merge in this order: `port/demo-mode-fix-r2`, `port/idle-minds-r2.5`, `port/repo-map-host`, `port/hive-scale`, `port/showreel-anchors`, `port/health-idle-ui`, `port/workbench-map`, `port/lab-compare`, `port/followups-r5` and `port/lab-pc-band`, then this docs pull request.

### Demo-mode fix, again (`port/demo-mode-fix-r2`)
- The thirteen demo commits of the first round, rebased on `main` (their first pull request closed unmerged when its base branch was deleted).

### Idle minds, privacy follow-ups (`port/idle-minds-r2.5`)
- **A personal mind's conversations are its person's in both directions;** a mind's message is a note only from a real, non-deleted mind.
- **A personal mind's idle record and export are its person's, whatever its visibility.** Admins read them only by explicit audit; live audit never streams a person's chat.
- **Per-viewer flags** `is_mine`, `may_remind`, `may_sleep` on `/api/agents`, `/api/agents/{id}` and the Health idle routes, computed from the same refusals the Remind and Sleep routes use; agent views also carry `may_control` (the owner's or an admin's, the rule every route that acts on a mind uses) and approvals `may_answer`.
- **Export and import:** a person's own export is their transcript's rows; a personal mind moves only back home (`409 personal_mind_unbound`); old conversation tails keep their owner across a move (`409 conversation_owner_mismatch`).

### Repository maps, host (`port/repo-map-host`, stacked on idle minds)
- Admin loader, read engine, seven presets, drift, signed cursors, a 256 KiB response bound with an honest `too_large` refusal, a 2 s time bound, and read-only repo spaces with serialised mounts. Routes under `/api/repo-maps`, the `repo-query` skill and the `hive_repo_query` MCP tool.

### Surface (`port/hive-scale`, `port/showreel-anchors`, `port/health-idle-ui`, `port/workbench-map`, `port/lab-compare`, `port/followups-r5`, `port/lab-pc-band`, stacked in that order on the demo fix)
- **Hive map at scale:** a universe of galaxies, one per person's hive, with one visibility helper and private-app homes that fail closed until known.
- **Showreel anchors:** code references are anchored by excerpt; a moved line warns instead of failing.
- **Health, Idle minds section:** status, idle calls and spend, Health's question and the mind's answer, history, Remind and Sleep by the host's flags only, bound to the identity the act started under.
- **Workbench Map:** a Map mode of the Code page over the repository-map routes, with levels that hold at 10,000 nodes, answers bound to their revision, and the repo space's mount shown as the host reports it.
- **Lab compare:** measures are judged only when comparable; units must be recorded and declared.
- **Follow-ups:** one unsaved-edits question per route event; guided play forgets a kept thread when its run ends; chat labels with no `/me`; the Constellation's own tour target; galaxy names clear of the HUD and the docked Ask; measured timeouts for simulator-heavy tests.
- **Lab research reports:** removed with Evolve, which is out of main and public releases until it launches (Jon, 12 Nov 2026).

## Done (10 Oct, live after the snapshot; brought over as pull requests)

### Idle minds (`port/idle-minds`)
- **A chosen wait makes no model calls.** A reply that is only `wait` ends the mind's remaining turns until new input or its chosen wake (`wait 900` wakes it in 900 s). Before, one message bought 12 model calls and each autonomous wake 8, all of them waits. A provider error now backs off 60 s.
- **Spend is not activity.** Model spend no longer moves a mind's last-active time. A new `last_input_at` records real input (a message from a person or mind, a goal claim, heartbeat or result, a published belief, the mind's own message); the hive's own housekeeping notes do not count. Idle sleep and child minds' idle limits count from it.
- **Health asks idle minds.** Health notices an awake mind that spends with no input, is silent with no input, holds a goal with no heartbeat or has an unanswered message, and asks it one question through the normal message path, rate-limited. Routes: `GET /api/health/idle`, `GET /api/agents/{id}/health/idle`, `POST /api/agents/{id}/health/remind`. No new limit and no automatic sleep.
- **Personal-mind privacy in conversations.** A personal mind's Health question goes to its person's own chat. Another mind's message to a personal mind is its person's; the loopback operator and other admins see neither without audit (`?include=all` or `?include=personal`).
- **Messages index** on `(agent_id, direction, conversation_id, created_at)`; the owed-message scan leaves out room talk before its cap.

### Surface follow-ups (`port/surface-followups-r4`)
- **Chat labels for admin audit.** "You" only for the viewer's own messages; the password operator is "the operator"; everyone else by display name.
- **Ask wording.** A mind is called the orchestrator only when it is the swarm's coordinator; otherwise the line says it answers directly.
- **Guided play.** A thread the person reopens stays open for the rest of the run; no mark is drawn once its element has gone.
- **Map clicks.** A press on empty space stays empty on release.

### Demo-mode fix (`port/demo-mode-fix`, stacked on idle minds)
- **The demo page starts when browser storage is blocked.**
- **Tour and guided demos by route.** `?tab=commons` opens a swarm's commons constellation; `?view=graph` opens an app's graph view through the unsaved-edits guard; the apps chapter uses the app's own home, never a private one.
- **Approval asks one card at a time,** saying when more decisions wait; the activity ticker stands clear above the Ask; the Tasks page's filters reach the Ask; the simulator's coordinators never doze off; showreel code references match the code.

The two privacy gaps noted here are fixed by `port/idle-minds-r2.5` (see above).

## Done (8 to 9 Oct)

### People and their minds
- **A personal mind for every person.** Each person gets one, asleep in their own swarm, created with no model calls.
- **The Ask answers as you.** The personal mind's conversation words are never stored on the hive and are readable only by that person, admins included. It can still hand work to swarms.
- **Mind page (`#/me/mind`).** View, edit and forget the browser memory; download and restore it; link a folder to it; swarm conversations are collected into the browser; "Use my swarm talk in answers" is off by default.
- **The Ask answers through a swarm's own mind** when the swarm has no coordinator.
- **Spend stop.** "New thread" and "Raise the limit for new threads" are offered in place.
- **Change who answers**, plus a "Recent conversations" page.

### Hive and apps
- **Conductor and Ask memory** are on; the Ask steers the screen.
- **Swarm team rooms.** Minds talk to each other with @mentions.
- **OmegaTown** is removed, deprecated in favour of OmegaWorld, which comes later (Jon, 12 Nov 2026); a saved OmegaTown look opens Classic. Private apps are never named to people who do not have them.
- **Evolve** is out of main and public releases until it launches (Jon, 12 Nov 2026): its app, its objective among the motivations and its research reports in Lab are gone. A hive's stored Evolve records are left as they are.
- **Apps open in a sensible swarm.** They choose from swarms that are visible, usable and not private, and show a chooser when none qualifies.
- **Copy-apply consent.** A new accept or a decline revokes every earlier capability. Copy-apply itself stays off.
- **Swarm delete**, the tools results view, reasoning viewers, and safe reload after deploys.
- **Studio (design app)** is live with its host fixes; the tools service passed its HTTP acceptance (111/111).

### Demos
- **Self-running showreel.** Add `?sim=1` and press "Watch it run". It makes 0 model and 0 hive calls, and any input takes over.
- **Guided demos started from the Ask** play on the real page, with one control surface, marks on their exact targets and the thread folding during a step. They draw only and never click.
- **Demo data is invented**, and a guard test blocks real names (see `OMEGA_PRIVATE_FAMILY_NAMES` in the README).
- **The demo simulator's commons** runs on the real MeTTa libraries (lib_nal, lib_pln, lib_hive).
- **Polish:** sign-in page wording, phone layouts, swarm sheet speed, reliable clicks on moving orbs, no colour blow-out.

### Platform
- **NAL/PLN literature audit.** NAL truth functions match ONA/Wang except the deviations listed in `reasoning-deviations.md`; PLN stays as it is by the owner's ruling and can be upgraded by its author.
- **Code (Linux) owner contract** and its four amendments, all reviewed.

## In review or building (not live)
- **(done, live 5617f4e) Privacy, combined:** other people's personal minds hidden from every default list; mind chats show the real sender and each person sees only their own conversations; downloads use filenames the viewer may see.
- **Tools callers:** the fourth revision fixes three test and doc updates, then install with the live mind-invocation handback.
- **Code on the cloud:** the copy-only cloud design is reviewed; the install runbook is in review and needs the owner's approvals plus a quiet window for about 10 hive restarts.
- **Code (Linux) daemon** has an earlier revision reviewed as source; the resident supervisor is being built.
- **Isolated Mac Python environment for Code** is reviewed and is applied after this.

## To do next
- **Known issue: advanced frontier-parity features** (computer use, browser use, draw on screen, vibe coding): tested working on the Mac, unproven on Linux, none fully implemented (in progress).
- **Known issue: hive-to-hive connection not complete;** the representative-to-hive connection works.
- **Known limitation: reasoning tools (PLN, ECAN and others)** were tested in previous builds and are integrated here, but not activated or bug-fixed.
- **Known limitation: limited end-to-end testing.** Everything has worked in one or another earlier build, but these pieces have only lived together for about a week.
- **Known limitation: hive, folder and screen organisation, and infinite hives:** scoped, partly built, needs finishing.
- **Known limitation: many modules and add-ons not fully ported** to the latest hive; known working in previous builds, compatibility untested.
- **Fixed: a personal mind's Health record and export** are its person's whatever its visibility (`port/idle-minds-r2.5`).
- **Known limitation: repository map spaces** are mounted but not yet queried by members; reads answer from the database rows.
- **Fixed: demo mode** is up to date again (`port/demo-mode-fix`).
- **Known limitation: full custom "any UI"** is mostly finished and untested.
- **Known limitation: local deploy runs through the web interface; it should become an app.** See "Known issues" in the root `STATUS.md`.
- **Known issue: no first-time deployer for a single Omega.** Compatibility exists; the flow has not been made. See "Known issues" in the root `STATUS.md`.
- **Known issue: deploying an app with its swarm.** There is no good flow yet; setting it up is confusing. See "Known issues" in the root `STATUS.md`.
1. Sync the Mac hive to the live release once its minds are idle.
2. Plans that cleared review and wait for the owner's OK: browser-Iter personal mind; mind memory with multiple indexes; honest truth values. (The hive view as galaxies, one per person, is live: `port/hive-scale`.)
3. Owner's direction: each person's hive as a node that talks to the cloud hive (DAS-shard style); the Ask reading hive memory (`/api/me/recall`); the "about this swarm" context; minds seeing the screen on demand (`see_view`).
4. Host follow-ups: lib_hive statement evaluation hazard; per-thread spend raise; `program_homes.mind_id`; mac-sync running `npm ci`; the keep-assets deploy fix. ("Last seen" tracking real activity is done, with idle minds.)
5. The pending Design qualification run, and a temporal reasoning round.
6. GitHub: the private handover, in two tiers (Open, Apache-2.0; and Closed Source for Product Consideration). See `START_HERE.md`.
