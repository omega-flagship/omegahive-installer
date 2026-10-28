# Platform coordination: history, owners and lanes

How the OmegaHive platform work is organised, who owns what (by role), and how the coordination record is kept. Read this before taking over the Platform lane.

## Short history

- **2026-10-03, transplant.** The platform work had been driven from a cloud Claude session that could not reach the project lead's Mac. On the project lead's instruction the whole process moved into a local Claude Code session on the Mac ("transplant"). The cloud session became a spectator.
- **2026-10-03, first acceptance.** One shared synthetic hive was started locally with both private apps mounted on invented data. A live acceptance receipt covered app discovery, enrolled versus unenrolled views, and the Scientist sequence (inspect, challenge, correction, stale or pending, cancel, acknowledgement, fresh validated result). Zero remote model calls, no real corpus.
- **2026-10-03, naming.** "OmegaDot" became **OmegaHive**; agents became "minds".
- **2026-10-04, takeover.** The first local platform session died mid-task. A new session took over the lane, studied the whole hive (six readers, a live UI tour, its own probes), answered about 17 owners, and published the modular Hyperon direction and the seam contracts.
- **2026-10-04 onward, lanes.** Platform work was split into parallel work sessions (see `platform-sessions.md`).
- **2026-10-06, cloud primary.** The cloud hive on the SingularityNET server became the working hive; the Mac hive became a test bench. The private apps stay on the Mac. Minds went live on the cloud on 2026-10-08.
- **2026-10-09, wrap-up.** After a successful team demo the project lead asked to wrap up: finish in-flight work only, and prepare this private GitHub repository for the project lead to push.

## Owners by role

| Role | Owns |
|---|---|
| Project lead | Direction, rulings, approvals of plans and of anything that reaches outside our systems; holds the push |
| Platform owner (a Claude Code session) | The hive host, UI shell, stages, app loading and pinning, goals and requests, budgets, identity, transport, deploys to cloud and Mac, routing of reviews, receipts |
| Surface owner (a Claude Code session, formerly "OmegaUI") | Whole alternative hive experiences, looks, app identities, the Ask's front end, demo mode and the browser personal mind |
| Code owner (Codex) | The Code workbench service, its daemon and adapter; Linux confined runs under the owner contract |
| Design owner (Codex) | Studio (OmegaDesign) app and its releases |
| Review owner (Codex) | OmegaReview: the native review swarm (see `omegareview-role-handoffs.md`) |
| Tools owner (Codex) | The modular tools catalogue and recipes (family, slot, implementation), MeTTa foundations |
| Atom and Reason owners (Codex) | OmegaAtom (space custody, evidence envelope, lineage) and OmegaReason (inference) |
| Other app owners (Codex) | Evolve, Planner, Flow, Match, Learn, Bench, Purple (security), Alignment, Fusion, HiveConnect |
| Private-app owners (Codex) | A personal health app and a research-truth app; private and local, metadata only |
| Independent reviewers | A GPT-based reviewer and a reviewer from a different model family; both must pass a change before a deploy. Specialist domain rulings go to the domain author (for NAL/PLN, the OmegaClaw author) |

The Platform owner may start Claude and Codex sub-agents for its own work; deploys and review routing stay with the Platform owner.

## The coordination record

- A single JSON coordination record is kept current by the Platform owner. Its main parts: the project lead's decisions and open decisions, the transplant record, the platform's live and in-flight builds, in-review items, open follow-ups, standing rules, scheduled work, cloud deployment state, and per-owner integration candidates. Treat it as the index; detail lives in the documents it names.
- **Receipts** go in a receipts folder, live acceptance separate from mock or replay demos (see `receipts-index.md`).
- **Messages** go through an inbox folder, one file per message; owners also write top-level files in their own folders.

## Decisions recorded in the record (selected, durable)

- Every feature must let Hyperon reasoning (PLN, NAL, motivation) take part.
- Ask allowance per day for the admin and for others, with a per-turn ceiling; voice layered on-device first; Hyperon tuning Phase A approved; app release pinning approved; the model ladder approved to execute.
- Organs may write a mind's own private memory outside the command gate: bounded, default-off, never in private apps, auditable.
- Member allowance per month by default, then encourage people to add their own keys; on exhaustion stop, notify the admin, request a card. Auto-approve off: an admin approves each until a rule exists. Every approval offers Once, For a time, Always, No, Never.
- Members request minds and swarms on the shared hive (admin notified), or self-deploy on a local mini-hive linked with one admin approval.
- Studio is an app within the hive. Display names drop the "Omega" prefix.
- The Code workbench hand-test was cancelled: Code acceptance moves to the describe, propose, confirm path.
- Hosting an external research lab inside the hive was shelved.

## Next steps for a new Platform owner

1. Read `status-2026-10-09.md`, then `operating-rules.md`.
2. Sync the Mac hive to the live release when its minds are idle.
3. Re-verify the parked cloud Code install runbook (latest revision) independently and send it to both reviewers.
4. Carry the four review-cleared plans to the project lead for an OK (`reviewed-plans.md`).
5. Keep the coordination record and receipts current as you go.

_Curated summary. Full version kept privately (source: LOCAL_TRANSPLANT_20261003.md, session.json, PLATFORM_TO_OWNERS_20261003.md, PLATFORM_SESSION_MESSAGES_20261003.md, PLATFORM_STUDY_20261004.md)._
