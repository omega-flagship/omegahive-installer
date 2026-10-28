# OmegaHive: done and to do

Test counts and the current what-works / what-is-limited summary are in the root `STATUS.md`.

Releases this repository was prepared from: **5617f4e** (handover, 9 to 10 Oct), then **e5103fb0** plus host
round R8.4 (live as **5e204019**, 20 Oct).

Every change under "Done" went through the two-reviewer gate before deploy, was tested and was deployed. The 8 to 9 Oct changes were also render-checked.

## Done (10 to 20 Oct)

### Studio
- **Live drawing and co-edit** (host J3 R2 to R8.4). A person directs a Studio maker on one of their saved pieces;
  cap and payer shown up front; steer through the Ask; pause, resume, Stop; their own edits always win.
- **Each member's own maker on their own key** (R7, R8.2), attached by the host. **Host member attach** (R8.3) uses
  Studio app 0.4.21's `member_attach` declaration.
- **Image generation** for the maker during a live session, on the person's own key (R8); expiry enforced at
  reservation and at send (R8.1).
- **Stale reads checked by content** (R8.4).
- **The Ask sets up Studio.**
- **Switched on on the cloud hive** on 20 Oct. It stays off on the Mac test hive.

### People, money and onboarding
- **Monthly total on your own keys** on the Me page, and a plain refusal for a key that is already saved.
- **Ask limits and budgets:** thread and session caps, member allowances, own-key limits and grants, requests for more.
- **Own-hive connections:** public or private hives, with access granted inside either.
- **Host identity sign-out:** sign-out ends that person's own work only.
- **First Light onboarding screens** (captions; voice off in this round).

### New hive (host side for future installers)
- Local-owner hive: one-time-link sign-in, loopback browser boundary, start refusals, sandbox interpreter checks.
- New hive: installed-source census, repository map of the installed source, setup helper session, coding barrier.

### Separately
- **Code** ships as an engineering preview in the `omegacode` repository (PR #1).

## To do next (from 20 Oct)
The numbered list with detail is under "Not done yet / next" in the root `STATUS.md`:
images on the canvas (R9); the first real end-to-end Studio walk (frame fix and R8.5); Linux CI differences in
`hive-petta` (8 known failures); new installers (J1); Code for members; the Studio "Revise the want" save refusal;
maker direct app actions with no policy rules; the derived Studio-space monthly cap against own-key work; logging of
`program_error` reasons.

---

The rest of this page is the log as it stood on 9 Oct 2026.

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
- **OmegaTown** is released (closed tier: Closed Source for Product Consideration). Private apps are never named to people who do not have them.
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
- **Known limitation: the current demo mode is out of date and broken.**
- **Known limitation: full custom "any UI"** is mostly finished and untested.
- **Known limitation: local deploy runs through the web interface; it should become an app.** See "Known issues" in the root `STATUS.md`.
- **Known issue: no first-time deployer for a single Omega.** Compatibility exists; the flow has not been made. See "Known issues" in the root `STATUS.md`.
- **Known issue: deploying an app with its swarm.** There is no good flow yet; setting it up is confusing. See "Known issues" in the root `STATUS.md`.
1. Sync the Mac hive to the live release once its minds are idle.
2. Plans that cleared review and wait for the owner's OK: browser-Iter personal mind; hive view as galaxies, one per person; mind memory with multiple indexes; honest truth values.
3. Owner's direction: each person's hive as a node that talks to the cloud hive (DAS-shard style); the Ask reading hive memory (`/api/me/recall`); the "about this swarm" context; minds seeing the screen on demand (`see_view`).
4. Host follow-ups: lib_hive statement evaluation hazard; per-thread spend raise; `program_homes.mind_id`; mac-sync running `npm ci`; the keep-assets deploy fix; "last seen" tracking real activity.
5. The pending Design qualification run, and a temporal reasoning round.
6. GitHub: the private handover, in two tiers (Open, Apache-2.0; and Closed Source for Product Consideration). See `START_HERE.md`.
