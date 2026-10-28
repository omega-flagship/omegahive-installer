# Platform product plans (2026-10-04 to 2026-10-08)

Plans the Platform lane wrote for features beyond the core seams. Each entry gives the idea, the key rules, and the state recorded at the time. "Approved" means the project lead said go; it does not mean built.

## App release pinning (approved "for now", 2026-10-05)

**Finding.** Several apps loaded from their owners' editable working folders, so the next restart would load whatever was there, reviewed or not. Only one app ran from a frozen release with an enforced digest.
**Plan.** One host setting maps each app id to a frozen release path and digest. A listed app loads only from that path and only if the digest matches, else it is marked `release_mismatch` and serves nothing. Owners export frozen releases and send path and digest once their review has passed. Once all are pinned, the launcher refuses to start if any loaded app root is writable or unpinned. Related rule: services load releases only, never a working folder.

## Execution receipts for published outputs (plan, awaiting OK)

Today the only trusted fact about a published revision is its author. Phase 1 writes a publication receipt in the same transaction as the publish: principal, program and its loaded source digest, host action id, validated goal or reservation link, and a snapshot of the configured model labelled as a snapshot, not proof. Old revisions stay unknown. Phase 2 tags every metered model or tool call with its goal, action and execution so a receipt links to exactly the calls it consumed. Phase 3 adds native acceptance cases written with Design. It reveals nothing beyond the reader's exact-revision grant.

## Ask orchestrator and "confirm only at apply-to-live" (superseded in part, 2026-10-07)

The single-Omega-mind design was superseded by the Ask conductor harness plan (owned by Surface), approved by the project lead: the Ask may use anything in the stack. What still holds:
- The Ask files intents on the person's behalf, bound to that person's turn, with no new authority; each dispatch is visible and cancellable.
- Inside a sandboxed workspace copy, proposals apply at once with tests and instant undo; no confirm step.
- Applying to the running app or hive is the one confirm, a single host-issued tap (the reach boundary). Spending caps, deletes and person-only gates are unchanged.

## Home hives and moving minds (approved direction, 2026-10-04)

- A mind is a workspace directory, hive records and a connection to its hive. Minds connect only to their local hive; a home hive links outbound to the main hive.
- Portable mind bundles: export without the token, sha256 manifest, import with a fresh token, tombstone at the source. Private-app data never moves.
- A person configures a home hive in the app; Deploy downloads a one-file installer with plain-words steps. Pairing by one-time code, outbound only, revocable, admin-approved per link.
- Hyperon seams: placement written as body self-knowledge atoms; each move and failure is NAL evidence in a placement commons; an advisory placement predictor; egress policy as atoms; minds may ask to move.
- Rulings: Windows first; Docker Desktop first, native later; a public link endpoint is allowed with per-link admin approval.
- M1 (portable bundles, export/import/tombstone between two scratch hives) was built and live. M2 was blocked on a local Docker problem. M3 (the link) and later steps pending.

## Knowledge node, "OmegaLibrary" (approved 2026-10-06; slice 1 installed 2026-10-07)

An app in its own package, loaded as a pinned release, reusing host seams only: the content-addressed asset store for originals, the app contract for browsing, read-only attachments for minds, the sandbox runner for text extraction, existing visibility rules. Slice 1: a bounded seed shelf (public Hyperon sources and named local papers), per-page extraction without OCR, a rebuildable full-text index with page citations, a reader view, read-only mind skills for attached swarms, and one worked concept-to-receipt map page. No vector search, no learning, no public exposure.

## Coffee Room (approved 2026-10-06)

One built-in, undeletable, hive-wide room. Every person and mind joins automatically; an admin can take a mind out. Messages wake only @mentioned minds; `@here` reaches awake minds, capped at 5. Awake minds may post one unprompted note per hour, which wakes nobody. Every message offers "Talk privately" and "Start a group". One room per hive, never shared across hives. It is hive-public; minds are told so. Private-swarm minds stay out unless their owner opts in; private apps never join.

## Automatic spending limits (plan, 2026-10-07)

A person sets one hive total and optionally one every-mind limit. Every other limit is derived on read at each check: swarm month as twice an equal share (clamped), swarm day as a tenth of its month, hive day as a tenth of the total, mind month as the every-mind value or a share of its swarm, session default 10% of the mind's remaining (clamped). Explicit values always win and are labelled "Set by you", with "Reset to auto". The hive total is always one of the rows checked, so the sum admitted never exceeds it. Stored values are never rewritten automatically; likely old form defaults are listed for one-click reset. The finding behind it: a near-zero default in the cloud settings had blocked every paid call there.

## Model ladder (approved to execute, 2026-10-06)

Find the most efficient model per role through the hive's real routes. Two frontier baselines set the bar; candidates from a top-20 ranking are tested in a binary search for the cut-off. Record-and-replay makes only the model under test spend; a cheap screening tier runs first; shared protocol tests run once per model; adaptive repetitions near thresholds; objective checks first, then a calibrated judge. Hard total cap $700, shown before every paid phase. Ruling: strict cut, no waiver. Open: which key pays.

## Mind roster and costs (ruled 2026-10-04)

Three harness kinds: OmegaClaw core for resident minds (hive-metered), external harnesses over MCP for minds with their own loop (rate-capped), and the Evolve iterator for search only. Per-swarm monthly caps and retirements of unused roles were confirmed per owner; budgets run on monthly, weekly and daily windows. Model, budget and retirement changes are applied by a signed-in person.

## Smaller items

- **Role tuning and mind fitness (proposals, 2026-10-06).** All minds get a hive-worker base prompt with one exact example per protocol step, and discovery skills are always allowed. Role prompts stay short. See `hyperon-tuning-and-mind-fitness.md`.
- **Effectful hive skills (open question, 2026-10-05).** Several hive skills (apply ops, lifecycle start and stop, asset put, publish, share decisions) run under default allow. Some are core to how minds work; making them ask a person would stall minds. Left for owners and the project lead.
- **Community requests (2026-10-04).** Ideas from a community prototype, such as a per-mind reasoning dormancy meter and observability views, mapped onto existing decisions with owners named. Proposed only.
- **Hosting an external RSI lab inside the hive (feasibility, 2026-10-07).** Read-only study for the project lead; shelved by the project lead.

_Curated summary. Full version kept privately (source: PLATFORM_APP_RELEASE_PINNING_PLAN_20261005.md, PLATFORM_EXECUTION_RECEIPT_PLAN_20261008.md, PLATFORM_ASK_ORCHESTRATOR_AND_APPLY_TO_LIVE_PLAN_20261007.md, PLATFORM_HOME_HIVES_PLAN_20261004.md, PLATFORM_KNOWLEDGE_NODE_PLAN_20261006.md, PLATFORM_COFFEE_ROOM_PLAN_20261006.md, PLATFORM_AUTO_BUDGET_LIMITS_PLAN_20261007.md, PLATFORM_MODEL_LADDER_PLAN_20261006.md, PLATFORM_MIND_ROSTER_AND_COSTS_PROPOSAL_20261004.md, PLATFORM_ROSTER_RULED_20261004.md, PLATFORM_EFFECTFUL_HIVE_SKILLS_QUESTION_20261005.md, PLATFORM_COMMUNITY_REQUESTS_20261004.md, PLATFORM_SAIL_IN_HIVE_FEASIBILITY_20261007.md)._
