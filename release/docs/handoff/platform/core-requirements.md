# Platform core requirements R1 to R20 (standing)

The project lead's requirements for the platform as a whole, recorded 2026-10-03 and 2026-10-04. Every app and every platform phase is designed against them. Recording a requirement does not expose data or grant access. Most items are design intent; build status is noted where it was recorded.

## Connection and federation

- **R1. Hives connect to hives globally.** Teams of people and swarms interact across instances securely. Local single-operator use is the first slice, not the destination. Required: mutually authenticated cross-instance connections; multiple human teams per instance; explicit invitations with scoped, revocable delegation; encrypted transport; audience-controlled sharing (nothing visible by default); the receiving instance's policy decides every action; audit provenance; resource limits per connection, delegation and team.
- **R4. Invite a swarm.** A one-time invite names a scope (one app's readable surface, one memory space or one channel), actions (read, ask, propose), an expiry and a budget. Visitors get a guest identity bound to that scope and never the host's keys, memory or other apps.
- **R5. Hives advertise capabilities and wishlists.** A signed, owner-approved profile in a readable directory. Opt-in, public items only, descriptions and contact routes only. Every connection still goes through R1 authentication.
- **R11. Connecting swarms with a purpose.** One connection object: two swarms, a purpose, what is shared (memory read or write, channels, repositories, services), a duration, a budget and who may revoke. Drawn in the scene or via "Connect", reviewed on a card, ends or revokes automatically, fully logged.

## Code and the workbench

- **R2. Edit the code of anything running in the hive, from inside the hive.**
- **R3. A workbench at least as capable as the terminal it replaces:** read, search and edit files, multi-file changes, a real shell in the candidate's sandbox, git operations, never a push without an explicit step.
- **R6. Workbench continuity lives in an Omega mind's spaces** (open tasks, decisions, what changed and why), not in a transcript that gets summarised away.
- **R20. Hand-coding, vibe coding and everything between.** One editor with an explicit, service-enforced scope (selection, function, file, folder, workspace). Changes arrive as proposals on the exact generation, accepted or rejected per hunk. Hand edits are never lost; stale proposals are marked. Note: the project lead does not hand-write code, so Code acceptance follows the describe, propose, plain summary, accept path.

## Health and housekeeping

- **R7. Error checking across minds.** First slice built: command results are classified, grouped per mind with severity and advice; repeated failures raise a live alert; a Health page exists.
- **R8. A system health mind** that wakes on a health alert, investigates read-only and proposes fixes.
- **R14. A cleaning mind** that watches disk, memory and log growth, alerts before space runs out, and proposes (never performs) cleanup without the owner's say-so.

## People, privacy and visibility

- **R10. A private app shows its real data only to its owner;** invited people and visiting swarms see synthetic data only. The app's owner decides the gates; the platform supplies the trusted principal and invite scopes.
- **R13. Private, shared or public** for minds and swarms, choosable after creation. Admins keep sight of private items for auditability, per the ruling that there are no true secrets.

## Interface

- **R9. A chat-first home.** One input, "How can I help you today?", backed by a page mind that drives the interface through a typed, visible, undoable action registry. Risky actions still need approval. (This became the Universal Ask.)
- **R15. Chat as one object, the room.** DM, group, channel and project are presets of one room; a room can change kind and keeps its members and full history.
- **R18. Updates in the app.** The hive detects changed apps and pending platform commits and shows them; a person or an upgrade mind applies them.
- **R19. One explorer for everything.** Hives, swarms, minds, apps, rooms and people are nodes in the existing holarchy. Personal groupings are free and many-to-many. One facet list drives both filtering and grouping, built for very large scale.

## Data and storage

- **R12. Local and cloud storage with transfer.** The asset store has interchangeable backends (local disk by default, S3-compatible cloud). Every file is addressed by its sha256 everywhere, so moving it never changes its identity.
- **R16. Migration into OmegaHive as a self-contained hive feature.** When a new mind starts, it can import session histories, PDFs, archives and repositories from other harnesses. The hive itself detects, reads, maps, copies and verifies; no agent session runs it.

## Work and review

- **R17. A task is done when a reviewer has checked it.** A reviewed task's result moves to `submitted`. First an automatic shape check (built), then a reviewer's check. A wrong shape goes straight back to the same mind before any reviewer time is spent.

## How these link

- Seams that implement R1, R4 and R11 (grants, bridge, shares): `architecture-and-seams.md`.
- Personal minds, the Ask and memory: `reviewed-plans.md`.
- Home hives and moving minds (R1, R12): `product-plans.md`.

_Curated summary. Full version kept privately (source: PLATFORM_CORE_REQUIREMENTS.md)._
