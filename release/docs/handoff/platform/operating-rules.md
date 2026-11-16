# Platform operating rules

Standing rules for anyone (agent or person) working in the OmegaHive platform lane. They come from the project lead's rulings between 2026-10-03 and 2026-10-09. Where a rule has a reason, the reason is given, because the rule is easier to keep when you know what it prevents.

## Privacy and ownership

- The two private apps (a personal health app and a research-truth app) stay private and local. Never copy, quote or summarise their corpus, records, archives, labels or code into any cloud session, repository, demo or outbound transcript. Metadata only: paths, versions, code file names, test counts, statuses, interface decisions.
- Never modify another owner's code or another agent's active checkout. Work in your own clone, worktree or scratch directory.
- Synthetic, disposable checks only. Never run a mutation flag against real data. Never invent evidence inside a personal record to satisfy a checker.
- Demo data is invented, and a guard test blocks real names.
- Admins can see private items for auditability: there are no true secrets, only opaque-by-default with deliberate access.
- No public exposure (address, port, certificate, tunnel) without the project lead's explicit yes for that exposure.

## Where things run

- The cloud hive on the SingularityNET server is the working hive. The local Mac hive is for testing only.
- Every cloud deploy is also synced to the Mac hive, never one without the other. A Mac sync may be held while minds there are awake.
- The private apps stay on the Mac.
- Services load immutable releases only, never an owner's working folder. Check loaded paths after each rollout.
- One source per setting: derive values, and check both the launcher and the environment file before changing one.

## Review and deploy gate

- Every platform change gets two independent reviews (a GPT-based reviewer and a reviewer from a different model family) before a safe restart. Self-review is not enough.
- Restart only through the safe-restart script, which refuses if there is an active update hold, a bounded runner, or an awake mind other than the standing residents.
- Owners place a restart hold for every bounded or paid run and release it after the observed stop. The hold is the contract; the awake-mind check is only a safety net.
- After every restart: check that Google sign-in is ready (not just a 200 response) and do a browser render check.
- Test what changed plus a smoke test. Full suites only for core plumbing. Run one full suite at a time across all helpers, on a detached worktree at the exact sha.
- No pushes unless the project lead asks.

## Evidence

- Nothing is "tested", "accepted" or "complete" without a shadow run. Every acceptance document carries a `SHADOW EVIDENCE` line, or says `NOT TESTED`.
- Label every claim VERIFIED, OBSERVED, CLAIMED, UNKNOWN or DECISION, and bind it to the command that witnessed it.
- Keep live acceptance receipts separate from mock or replay demos.
- Name the acceptance level: L0 offline, L1 disposable host, L2 live with synthetic data under a hold, L3 native mind under a cap.

## Sandbox to production (promotion laws)

1. No process judges its own outputs. The swarm can change the candidate, never the walls, the exams or the gate.
2. No freeze without an end-to-end shadow from one self-contained tree.
3. Effects that leave our systems are gated by where they reach, not by the verb: egress default-deny, per-task expiring grants; content never grants authority; casual conversation is never approval.
4. Containers are allowed for OmegaHive as one sandbox option, with a non-host network by default.
5. "Ready" means the full suite passed.
6. Two receipts: review acceptance and independent capture.
7. Ceremony scales with risk; authority decisions are Allow, Deny, RequireProbe, RequireReview or Defer, and records cannot mint Allow.

The pipeline: candidate (isolated copy) → contained run → gate on the exact digest → shadow → independent evaluation → exact single-use approval → canary → promote or roll back. Untrusted output (HTML, UI builds, PDFs, media) renders only in a sandboxed frame or script-free viewer.

## Housekeeping

- Delete what you made once it is done; keep only receipts (small: metadata and digests).
- One working clone each; share dependencies rather than reinstalling per clone.
- A handoff is done only when leftovers are gone; include a "cleaned:" line.
- Watch the disk: under 10 GB free, stop creating large things; under 3 GB, tell the platform at once.
- Remove only what you created; never touch another owner's checkout, the shared hive data or private-app data.
- Keep the number of live agent sessions small (the Mac has limited memory); wake a finished session only to unblock work.

## Identity and naming

- Google sign-in is the only person identity. Apps receive a person viewer; gate on the person id from config, not on a local-operator flag. A local break-glass password remains on the Mac at loopback only, at the project lead's discretion.
- The product is **OmegaHive** ("OmegaDot" is retired). Agents are **minds**. Display names drop the "Omega" prefix (Design, Review); ids, program ids, folders and receipts keep their names. Some folder and storage-key names still say "omegadot" and are renamed later in one planned pass.

## Coordination mechanics

- Reach the platform by writing a file: one message per new `.md` file in the coordination inbox, or a top-level `.md` in your own owner folder. The platform replies in your folder and moves handled inbox notes to a done folder.
- Platform work sessions (lanes) each get their own worktree and branch, build candidates only, and never restart, deploy, change the live hive, push or run Codex commands. Details: `platform-sessions.md`.
- Implementation of a new feature waits for the project lead's OK on its reviewed plan.
- The project lead does not write code: Code acceptance follows describe, mind proposes, plain summary, accept.

_Curated summary. Full version kept privately (source: PLATFORM_HOUSEKEEPING_RULE.md, PLATFORM_RESTART_RULE_20261004.md, PLATFORM_IDENTITY_GOOGLE_ONLY_20261005.md, NAMING.md, SANDBOX_TO_PRODUCTION.md, PLATFORM_CONTACT.md, LOCAL_TRANSPLANT_20261003.md, session.json standing rules and decisions)._
