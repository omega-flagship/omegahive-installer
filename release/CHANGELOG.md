# Changelog

All notable changes to OmegaHive are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the policy in
[`CONTRIBUTING.md`](CONTRIBUTING.md#versioning).

The vendored OmegaClaw Core runtime has its own history upstream (OmegaClaw Core by Patrick
Hammer). Its readiness notes are summarised in [`docs/omegaclaw-core.md`](docs/omegaclaw-core.md)
and are not repeated here.

## Unreleased

### Live since the handover (2026-10-10 → 2026-10-20)

Brings the repository up to the release live on the cloud hive on 2026-10-20: private release `5617f4e` to
`e5103fb0`, plus host round R8.4 (live as `5e204019`). The OmegaTruth and OmegaAtlas forms and the internal review
series are left out, as before; test fixtures use invented names.

#### Added
- **Studio live drawing and co-edit** (host rounds J3 R2 to R8.4): the `studio.session` Ask intent, its one-transaction
  admission, the session ledger, the Studio frame's mount, heartbeat, piece upload and step outcomes, pause, resume and
  Stop (and an admin Stop and audit), per-step maker executions with a write fence and token rotation, money checked
  at call time, steering through the Ask as queued directions, session expiry at reservation and at send (R8.1), and
  image generation for the maker during a live session on the person's own key (R8). See "Studio live sessions" in
  `hive/API.md`. Off by default (`HIVE_STUDIO_SESSIONS`).
- **Each member's own Studio maker on their own key** (R7): `POST /api/studio/setup` makes it in a private Studio
  space the person owns and the host attaches it; no own key is 402 `own_key_needed`. Studio counts as active in that
  space (R8.2).
- **Host member attach** (R8.3): a hooked Studio app's `member_attach` declaration, honoured only from its
  digest-pinned release, gives the exact scope of the host attachment. Pairs with Studio app 0.4.21.
- **The Ask sets up Studio**: pick or open a piece, confirm the cap; refusals start nothing.
- **Own-key monthly total** on the Me page ("Monthly total on your own keys"), read back before it says "Saved".
- **New hive and local owner, host side** (J1): `HIVE_LOCAL_OWNER=1`, the same-uid control socket, one-time-link
  sign-in (`/local-signin`, `POST /api/auth/local/exchange`), the loopback browser boundary, start refusals, sandbox
  interpreter checks (`HIVE_SANDBOX_PYTHON`), `GET /api/local/status`, the installed-source census, the repository-map
  extractor, the setup helper session and the coding barrier.
- **First Light onboarding**: the on-screen journey (captions; voice off in this round), progress, the setup list and
  "wake and greet" (`/api/me/onboarding`, `/api/me/setup`, `/api/me/personal-mind/hello`).
- **Ask limits and budgets**: thread and session caps, member allowances, limits on your own keys and their grants
  (`/api/me/key-limits`), and requests for more (`/api/me/limit-requests`).
- **Own-hive connections** (round H1): a hive is public or private, with access granted inside either
  (`/api/hive/own`).
- **Metered media r2**: `HIVE_MEDIA_ALLOW`, the billed-refusal breaker (`HIVE_MEDIA_BREAKER_REFUSALS`) and admin reads
  (`/api/media/results`, `/api/media/breakers`).
- Mind idle health (`/api/health/idle`, Remind), the outside-CLI catalogue (`GET /api/harnesses`), Evolve record
  figures, and the Mac test hive's restart prepare (`HIVE_RESTART_PREPARE`).

#### Changed
- **Host identity sign-out**: `POST /api/auth/logout` also ends that person's own work (their Ask turns and work
  sessions) and reports `sessions_kept`; minds keep running.
- **Stale reads by content** (R8.4): a maker's proposal is refused `stale_piece_read` only when the piece's content
  changed since its read, not on a refresh of unchanged art.
- Adding a key that is already saved in the hive shows a plain refusal (`duplicate_key`) that stays on screen.
- CI: the local-owner socket tests wait for the socket on slower runtimes; a test key no longer trips the secret
  scanner.
- Documentation: `STATUS.md`, `hive/API.md`, `hive/README.md` (settings), `hive/MCP_S3.md` (Studio maker tools),
  `docs/COMPATIBILITY.md` and `install/README.md` match this release.

#### Known gaps
- Placing generated images on the canvas (host R9 and a later Studio release).
- New one-click installers (J1) are not built; `install/` holds the legacy OmegaClaw installers, for reference only.
- Code ships separately as an engineering preview (`omegacode`, PR #1); not for members yet.
- `hive-petta` CI on Linux: 8 known test-environment failures.
- The full list is under "Not done yet / next" in `STATUS.md`.

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
