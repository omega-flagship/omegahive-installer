## V8 — packaging and dependency integration review

- Preserve dotfiles, CI, tours and executable modes; include a release-file verifier.
- Keep dependency setup out of the parent Git index and generated runtime files outside the source tree.
- Ask for approval for unlisted skills; explicitly retain existing discovery, repository, code-review and budget-guarded image defaults; keep one upstream `add-skill` implementation.
- Filter native configuration logs before formatting, including exception payloads.
- Retry malformed tool calls after two seconds; retain sixty-second transport-error backoff.
- Install from the supplied source bundle by default during the private pre-release.
- Clarify AccountAttempts: unknown-email expiry as well as eviction can make waits differ.
- Keep the explicit pinned upstream adapter; current upstream has heartbeat/prompt extensions but lacks the complete lifecycle/provider API needed to remove it.

## V7 — full Singnet core extraction (2026-11-04)

- Replace embedded configuration, providers, utilities, generic skills, vector memory, NAL/PLN and scheduler with the pinned Singnet dependency.
- Preserve Hive-specific symbolic spaces, permissions, context, attention, channels, app creation and ITER as extensions and existing feature modules.
- Route providers and channels through native registries; retain cost accounting, routing configuration, chosen waits and shell safeguards.
- Use the dependency's NAL/PLN sources in the browser, with identical verified hashes.
- Fetch/register the dependency for ordinary clones; remove recognized retired files after copy-over without backup copies. Startup cannot fetch the old core as a fallback.
- Retain Docker/deployment configuration and original documentation. See `CORE_MODULARIZATION.md` and `CORE_VALIDATION.md`.

# Changelog

All notable changes to OmegaHive are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the policy in
[`CONTRIBUTING.md`](CONTRIBUTING.md#versioning).

The vendored OmegaClaw Core runtime has its own history upstream (OmegaClaw Core by Patrick
Hammer). Its readiness notes are summarised in [`docs/omegaclaw-core.md`](docs/omegaclaw-core.md)
and are not repeated here.

## Unreleased

### Fixed (Mac updater download)
- An accepted update's download asks for the rest of the zip after a stall or a dropped connection (a `Range`
  request). Before, one stall of over a minute failed the update and the next try began again at the first byte. A
  server that sends the whole file again starts the download over, and the update gives up only after six tries in a
  row get no further. The zip's length and sha256 are checked as before.

### Fixed (prompt defaults)
- A fresh checkout reads `src/base_prompt.txt` when no prompt or memory directory is configured and
  `memory/prompt.txt` is absent. An existing empty prompt or an explicitly configured empty memory stays empty.

### Fixed (Code review on a stopped reviewer)
- A Code change is not sent for review to a stopped reviewer, which a message never wakes. The review is unavailable
  at once, and the request says why, such as "Review controller is stopped; start it from its panel, then ask again",
  where before it waited until someone started the reviewer by hand.

### Fixed (operator password input)
- An escaped lone surrogate in an operator password returns the same 401 as a wrong password and counts toward
  outside password throttling, without creating a session.

### Fixed (Mac Code service and your git config)
- The Mac Code service runs with a home of its own inside its folder. Its sandbox reads nothing in your home, so with
  your HOME its git failed on your `~/.gitconfig` whenever you had one, and the Code workspace never opened.

### Changed (one trunk, #82)
- **One trunk**: Jon's dev/latest line (PhysixSNET/omegahive) merged into `main`: every dev/latest release since
  the two lines split, with `main`'s own work, #74's Iter minds included (an Iter's worker files are now copied
  without following links the Iter planted).
- **Operator password from outside**: an operator password session never counts from outside the hive's
  machine, `HIVE_PUBLIC_PASSWORD=1` included; that flag opens passwords to members only. This reverses #23.
- **Member password guesses**: counted per typed email by the same rules for every email; a count decays, one
  failure forgiven an hour, instead of resetting, and 100 failures since the last right password close that
  email's outside sign-in. This replaces #31's per-person count.
- **OmegaTown removed**: deprecated in favour of OmegaWorld, which comes later (Jon on #106; #1). Its notes,
  images and brand look go as PhysixSNET/omegahive#101 removes them, and so does its line in this README's tier
  table. A saved Town look opens the Classic hive.
- **Evolve removed until it launches**: out of scope for the launch candidate, so out of `main` and every public
  release until Jon launches it (Jon on #106). Its app, core modules, MeTTa library, figure routes, Lab research
  reports band, objective among the motivations, guided tour, docs and tests go, with the self-improvement design page
  built on it. A hive's stored Evolve records are left as they are. The public release rule now keeps out every file
  named for Evolve, not just its plugin folder, and a test fails if one is tracked again.
- **CI**: `ci.yml` (hive-ci) gates pull requests and builds its toolchain with PhysixSNET #70's PeTTa helper;
  `build.yml` builds the Docker image; `release.yml` publishes it on a `v*` tag or by hand.

### Fixed (commons data, #111 item 1)
- Commons publish statements, belief lookups and query patterns are passed as quoted data to PeTTa. A query can no
  longer run a nested Python call, and loading a function named like a logical connective cannot make a publish
  execute it before the grant check. Stored statements and the operations log keep their existing shapes.

### Fixed (the commons log, #111 item 8, #223)
- **A crash mid-write no longer stops the hive**: a torn last line in `spaces.log.jsonl` is cut off with a warning,
  and every complete record before it is kept. Any other line the hive cannot replay stops the start and names its
  line and byte. Each write to the commons is fsynced before it returns and logged in the order it was applied, and
  the log is compacted to a snapshot once replaying it costs more than the snapshot did.
- **Upgrading a log #82 wrote after a crash**: #82 skipped a torn line but left it in the file, so the next record
  was glued onto it. This release refuses to start on such a line and names the bytes to delete, the torn remainder
  before the record (usually everything before the second `{"op":` on the line). The record after them is whole and
  is kept.
- **Rolling back**: a release from before this one cannot read a compacted log. It stops at the first snapshot
  record, so rolling back after a compaction means starting with empty commons.

### Added (out-of-box core readiness, from dev/latest)

These layers collect the portable core-readiness work prepared after live Omega testing. They avoid
private deployment assumptions and keep optional organs disabled until explicitly loaded.

- Typed command syntax membrane driven by `SkillSignature`, `SignatureSpace`, `SignatureLowering`, `SignatureShorthand`, and `SignatureRecoveryHint` declarations.
- Symbolic skill affordance directory with cards, topics, arguments, risks, effects, input-aware triggers, and compact context hints.
- Runtime spaces for persistent, agenda, beliefs, world, events, activity, assume, attention, skills, skill-triggers, scratch, and agentverse.
- Bounded context views for large skill payloads via `SkillContextView` and `SkillContextPolicy`; raw history remains exact.
- Core continuity skill `pin` with volatile working-state guidance.
- Portable energy loop self-regulation and restart/reboot continuity affordances.
- Canonical `web-search` surface, with legacy `search` retained as an alias.
- Symbolic memory cleanup affordances: `space-transform`, `space-merge-atoms`, `persistent-merge-atoms`, and reviewed persistent retirement.
- Optional default-off Agentverse module with discovery, registry, listener, async inbox, trace, and AgentChatProtocol call path.
- Repeatable parser and context-compaction benchmarks under `tests/`.

### Changed (out-of-box core readiness, from dev/latest)
- Core context now uses compact bootstrap skill hints; full help and cards remain inspectable through symbolic affordance skills.
- Parser errors now fail closed with recovery hints and relevant skill-card lines when available.
- PLN/NAL guidance now distinguishes NAL copulas from truth-valued PLN statements.
- Generated runtime memory files are ignored except curated prompt/history seed files.
- Remote-agent support moved behind the module boundary; old hardcoded Agentverse core bridge was removed.

### Validation (out-of-box core readiness, from dev/latest)
- Live Omega tested syntax repair, context compaction, runtime spaces, pin continuity, memory merge behavior, and Agentverse end-to-end remote call behavior before readiness branch publication.
- Clean readiness branch tests and benchmark commands are documented in the root `README.md` and `docs/review/benchmark_suite.py`.

### Not included (out-of-box core readiness, from dev/latest)
- Deployment-specific glue such as live webhost proxy configuration, live run-script endpoint values, WhatsApp channels, and Home Assistant body-app experiments.

### Added (2026-11-03)
- **Member passwords** (T-101, `t101/member-passwords`): until Google sign-in is set up, an admin adds a
  member by email and the hive makes a password, shown once (`POST /api/people/members`); the member signs in
  with email and password as a member, never an admin. Admins reset (`POST /api/people/{id}/password`) or
  remove it (`DELETE`); stored as a salted scrypt hash. With Google on, outside member password login is
  refused like the operator's; wrong guesses from outside wait per account, on #27's schedule.

### Added (live up to f3f4bb8, brought over as pull requests, 2026-10-12)
- **Repository maps, Slice A** (`port/repo-map-host`): `POST /api/admin/repo-maps` loads a
  `repo-map/1` map (admins only); `GET /api/repo-maps`, `GET /api/repo-maps/{repo}/presets`,
  `GET /api/repo-maps/{repo}/drift`, `GET /api/repo-maps/{repo}/{sha}`,
  `GET /api/repo-maps/{repo}/{sha}/nodes`, `GET /api/repo-maps/{repo}/{sha}/nodes/{node_id}` and
  `POST /api/repo-maps/{repo}/{sha}/query` read it; minds use the `repo-query` skill and MCP members
  the `hive_repo_query` tool. Each revision is mounted into a read-only space `repo:<repo>@<sha>`.
- **Health, Idle minds section** (`port/health-idle-ui`): the idle record, history, Remind and Sleep
  in the UI, offered only by the host's flags.
- **Per-viewer flags** (`port/idle-minds-r2.5`): `is_mine`, `may_remind`, `may_sleep` on agent views
  and idle rows.
- **Hive map at scale** (`port/hive-scale`): a universe of galaxies, one per person's hive.
- **Workbench Map** (`port/workbench-map`): a Map mode of the Code page over the repository maps.
- **Lab research reports** (`port/lab-pc-band`): OmegaEvolve's recorded contributions as a read-only
  band in the predictive-coding family.

### Changed (2026-10-12)
- **Lab compare** (`port/lab-compare`): two measures are judged only when comparable (declared units,
  same definition and direction); blank or undeclared units are unknown.
- **Showreel** (`port/showreel-anchors`): code references are anchored by excerpt; a moved line warns.
- **Mind export and import** (`port/idle-minds-r2.5`): a person's own export is their transcript's
  rows; a personal mind's bundle is refused anywhere but home (`409 personal_mind_unbound`); import
  refuses rows that would change owner (`409 conversation_owner_mismatch`).

### Fixed (2026-10-12)
- **Privacy** (`port/idle-minds-r2.5`): a personal mind's idle record and export are its person's
  whatever its visibility; ghost `agent:*` senders are not input; live audit never streams a
  person's chat. This closes the two known issues below.
- **Demo mode** (`port/demo-mode-fix-r2`): the demo-mode fix, rebased on `main`.
- **Surface follow-ups** (`port/followups-r5`): one unsaved-edits question per route event; a kept
  guided thread is forgotten when its run ends; chat labels with no `/me`; the Constellation's own
  tour target; galaxy names clear of the HUD and the docked Ask; measured simulator test timeouts.

### Added (live after the snapshot, brought over as pull requests, 2026-10-10)
- **Idle minds** (`port/idle-minds`): a reply that is only `wait` ends a mind's turns until new
  input or its chosen wake, so a waiting mind makes no model calls; a provider error backs off
  60 s. A new `agents.last_input_at` records real input, and model spend no longer counts as
  activity. Health notices idle, silent or owing minds and asks each one question through the
  normal message path; `GET /api/health/idle`, `GET /api/agents/{id}/health/idle` and
  `POST /api/agents/{id}/health/remind`. New index on
  `messages(agent_id, direction, conversation_id, created_at)`.

### Changed
- **Personal-mind conversations** (`port/idle-minds`): a personal mind's Health question goes to
  its person's own chat, and another mind's message to a personal mind is its person's; the
  loopback operator and other admins need audit (`?include=all` or `?include=personal`) to see
  either.
- **Chat labels for admin audit** (`port/surface-followups-r4`): "You" only for the viewer's own
  messages; "the operator" for the password operator; others by name.
- **Ask wording** (`port/surface-followups-r4`): a mind is called the orchestrator only when it
  is the swarm's coordinator.

### Fixed
- **Demo mode** (`port/demo-mode-fix`): the page starts when browser storage is blocked; the
  tour and guided demos open the commons (`?tab=commons`) and an app's graph view
  (`?view=graph`, through the unsaved-edits guard) by route; approval asks show one card at a
  time; the activity ticker stands clear above the Ask; the Tasks page's filters reach the Ask;
  the simulator's coordinators never doze off; showreel code references match the code.
- **Guided play and the map** (`port/surface-followups-r4`): a thread the person reopens stays
  open; no mark once its element has gone; a press on empty map space stays empty on release.

### Known issues (fixed 2026-10-12 by `port/idle-minds-r2.5`)
- When a person has made their personal mind public or shared it, admins could read that mind's
  Health idle record without asking for audit.
- Mind export could carry a person's private conversation without an explicit audit step.

### Changed (GitHub handover round, 2026-10-10)
- Two tiers are marked: Open (Apache-2.0) and Closed Source for Product Consideration. Inside this
  repository the closed folders are `hive/plugins/omegaevolve`, the OmegaTown experience and
  the WhatsApp bridge folders (`channels/whatsapp_bridge`, `modules/channel_whatsapp/src/whatsapp_bridge`).
- The life-map and case-file forms, which belong to two closed apps, moved out of the platform UI
  into those apps' closed repositories.
- Documentation rewritten for a human team: README with exact toolchain versions, `STATUS.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/COMPATIBILITY.md`,
  `docs/EARLIER_EXPERIMENTS.md`, `docs/reasoning-deviations.md`, and two theory pages on
  governance and on ledger and provenance.
- NAL and PLN reference pages corrected against the code, with a committed probe.

## 0.1.0 (initial import, 2026-10-09)

First import as a single squashed commit, prepared from live release **5617f4e** (the cloud hive).

### Platform at import
- People and sign-in: admin password, invite-only Google sign-in, domain enrolment, configured
  admins, sign-out that revokes every token from that sign-in.
- A personal mind for every person, created asleep with no model calls; the Ask answers as you,
  and its words are never stored on the hive.
- Universal Ask (text and voice) on every page; Ask conductor and conductor memory.
- Swarm team rooms with @mentions; swarm delete; power modes.
- Per-swarm symbolic commons in MeTTa with evidence stamps and revision; governance evidence from
  every approval answer.
- Policy gate, exact-bound approvals, capability tokens, budgets with durable reservations,
  visibility tiers, OS sandboxing of minds (Linux namespaces and Landlock, fail closed).
- Copy-apply consent built (the feature itself is off).
- App contract with digest-pinned releases, homes, grants and exact-request actions.
- Experiences and looks: Classic, Still, Canvas, Cosmos, Flux, Construct and Town.
- Self-running showreel and guided demos with invented data; the demo commons runs the real
  MeTTa libraries.
- Privacy round: other people's personal minds hidden from default lists; mind chats show the
  real sender; downloads use names the viewer may see.

### Removed before import
- Runtime state, databases, sign-in files, keys and local testing helpers.
- The review patch series.

For the 2026-10-06 private release report, see
[`docs/handoff/platform/release-report-2026-10-06.md`](docs/handoff/platform/release-report-2026-10-06.md).
