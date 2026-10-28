# Governance and gating: the deeper model, what this build ships, and the path back

OmegaHive's safety layer is a deliberate simplification of a much deeper governance model, developed in the OmegaClaw V2 programme from July to September 2026. This page sets out that model, says exactly what this build ships in its place, and shows where each richer mechanism plugs back in.

Maturity words are used strictly:
- **designed**: written and reviewed;
- **ruled**: adopted by the project lead, or a design dual-cleared by independent reviewers;
- **built**: source with focused tests;
- **shadow-tested**: exercised in an end-to-end shadow run of the V2 body.

Several V2 rulings are not yet built anywhere. Where this build already enforces a simpler form of one, the page says so.

The full V2 governance and security theory (the definition's laws, the rulings, the dossiers on
authority and reach, amendment, journal and recovery) is in the closed **`omegav2`** repository
(Closed Source for Product Consideration). This page is the open, platform-level account.

## How the deeper V2 versions were simplified in this build

One hive on one host did not need the full V2 machinery, so OmegaHive ships simpler forms. On
four rows the platform actually ships enforcement that V2 ruled but never built or assembled:
the OS sandbox (live on the cloud), one-operation consent, visibility tiers and hard spend caps.

| V2 mechanism | V2 maturity | What this build ships instead | Section |
|---|---|---|---|
| Reach-boundary effect gating | Ruled; partly built | Per-skill policy gate plus OS sandbox plus gateway egress check | 1 |
| Situated effect gravity (14-dimension risk, five bands) | Ruled; fixture-proven only | A fixed high-risk set; high risk approved one at a time | 2 |
| Capability membrane (exact-coordinate admission) | Built at focused boundaries | Digest-bound Code approvals, HMAC capability tokens, exact-request app actions | 3 |
| Capability lifecycle (gap, candidate, trial, promote, receipt) | Ruled; partly built | Reviewed-skill list enforced by CI | 4 |
| Inspectable-inert reasoning | Reviewed design | Governance evidence that informs and never decides | 5 |
| No process judges its own outputs | Ruled; practised | People answer approvals; most-restrictive rule wins; two reviewers per change | 6 |
| Multi-party co-sign | Ruled; not built anywhere | Single-signer approvals | 7 |
| Governed law amendment | Chain ruled; machinery designed | Policy rules as data, superseded and expired, never deleted | 8 |
| Operation-bound consent | Frame ruled | Copy-apply consent built exactly this way (feature off); timed, revocable shares | 9 |
| Transparency floor | Ruled | Visibility tiers; admins keep sight; hidden things answer "not found" | 10 |
| Promotion ladder | Ruled invariant | Private by default; timed shares; requests spend nothing until granted | 11 |
| Budget as physics | Ruled | Worst-case spend checks before every paid call, durable reservations | 12 |
| Shadow before freeze | Ruled; shadow-tested | Acceptance ladder L0 to L3, live receipts kept separate | 13 |
| Rollback without forgetting | Tested in V2 | Off / Wake all / Stop all with a durable snapshot; transactional startup recovery | 14 |
| Gated effect pairs (S3) | Design cleared; not built | The services redeem pattern | 15 |
| Confined Code runs and host guard | Contract reviewed; not built | No delegation over Code runs; tokens live-checked; copy-apply held off | 16 |
| Host-native OS boundary | Ruled; built, not assembled in V2 | Built and live here (`sandbox.py`, `landlock.py`), opt-in in development | 1 |
| D/R/A source law | Ruled | Process only | — |

## The principle under all of it

**Evidence never mints authority.** A model's output is a nomination. A reasoning trace, a confident belief, a passing test or a prior success may justify a proposal; none of them is permission to act. Authority comes only from an authentic, current, unrevoked grant that matches the exact action, target and reach. The rest of this page follows from that.

## 1. Gate effects by where they reach, not by the verb (ruled; partly built)

In V2, effects inside the mind's own body are its own. Anything that crosses the system boundary needs approval:
- network reach is granted per task and expires;
- a small, pinned set of standing services is allowed;
- all other egress is denied by default.

Speaking to someone already introduced is not gated. Changing another system is. Enforcement is host-native, at the operating system.

V2 built:
- a fail-closed provider egress admission with nine bindings;
- an OS-profile sandboxed shell that passed a 38/38 physical sandbox matrix on macOS. It was not assembled into the live body.

**This build** has two layers:
- The policy gate (`hive/core/policy.py`) decides allow, ask or deny per skill, and the most specific rule wins. Some skills are human-only, some need an exact rule, and file skills stay inside the mind's own folder.
- The OS boundary (`hive/supervisor/sandbox.py`, `landlock.py`) gives each mind:
  - an allowlisted environment;
  - deny-by-default file access;
  - on Linux, its own user, mount, network, pid and ipc namespaces under Landlock, with a loopback relay to the hive as the only way out.

All model traffic goes through the gateway, which holds the provider keys and enforces local-only teams.

**Simplified:** the policy gate decides on the verb. A shell command's reach can't be known in advance, so `shell` and `metta` are "ask".

**Path back:** a reach classifier inside `Policy.authorize` (internal, own folder, hive, egress to a host, another party), with rules keyed on the reach class. "For a time" becomes a reach lease with an expiry and revocation.

## 2. Effect gravity (ruled; not built in V2 either)

V2 scores a proposed effect on a typed risk vector and maps the score to five bands, from internal cognition to deny. The vector covers authority change, target sovereignty, consequence, reversibility, scope, confidentiality, consent, persistence, uncertainty and composition. Hard floors can't be traded off, and no model assertion may lower a risk premise. Competence is earned in stages: observe, rehearse in a sandbox, supervised use, bounded pre-authorisation, then cautious autonomy. A five-level effect gradient was proven in test fixtures, but no scorer stands in the running body, and a later review warned against turning gravity into yet another gate.

**This build:** a fixed high-risk set. High-risk actions are approved one at a time, and app actions only for the exact request.

**Path back:** a pure `gravity()` function that advises the gate, never lowers a floor, and maps onto the existing five answers.

## 3. The capability membrane (built at focused boundaries in V2)

Discovering a capability carries no authority. Admission binds the exact call: capability, descriptor digest, argument digest, effect, reach and target. A grant names its issuer, subject, target, effect, scope, time window and conditions. The durable order is admission, then an intent witness, then dispatch, then terminal evidence. Crash recovery replays, reconciles or holds according to idempotency.

V2 verified native capability admission and recovery in focused evidence. The persistent grant-and-lease graph is not yet assembled.

**This build already has the strong form where it matters most:**
- Code operations are approved for a canonical, digest-bound command and redeemed exactly once by the service.
- Capability tokens are HMAC-signed and scoped (actor, task, paths, actions, expiry, run limits), and checked live before every mutation.
- App actions are exact-request only, with idempotency keys.

**Path back:** extend the same bound record (action, target, scope, version, nonce, expiry, reach) to every ask-mode skill.

## 4. Closed effects, open capabilities (ruled)

At any execution boundary the effect vocabulary is closed. Across development, capabilities grow through gap, candidate, trial, promote and receipt, and revoke is always available.

**This build:** a new `hive-*` skill is "ask" until it is reviewed and listed, and CI enforces the list.

**Path back:** turn the list into a table with lifecycle states and receipts.

## 5. Inspectable-inert reasoning (reviewed design)

A model's reasoning is retained and inspectable but has no automatic causal power: what matters is whether something can act on its own, not whether it is visible. The mind audits the trace against its grounded context. The auditor's own flags are inert too, and a trace inherits the consent and retention rules of any private data it touches.

A later review sharpened the rule. Hidden reasoning is not authority, and typed conclusions may still be used, but only through admission. Nine of nine reviewers kept the design with four repairs; the successor law is awaiting ratification.

**This build** takes the same stance for governance evidence. Every person's answer becomes an observation in a governance commons that informs the next decision ("approved 4 of 4 times") and never makes it.

**Path back:**
- a trace store that no decision path reads, enforced by a test;
- typed conclusions entering only through the evidence seam.

## 6. No process judges its own outputs (ruled; practised)

Peer, elder and adversarial verification are part of the architecture. The author and the admitter are always different agents, and a review is void if the candidate changes after it.

**This build:**
- People answer every approval.
- A role or admin rule can never outvote a person's refusal, because at equal specificity the most restrictive rule wins.
- Platform changes take two independent reviews.

## 7. Multi-party co-sign (ruled; not yet built anywhere)

Operations on continuity, memory or constitutional state need more than one signer, for example a human and the mind concerned. These are rollback, recovery and changes to the membrane. A co-signature is an exact-scope lease with an expiry. Reviewer approvals, manifests and hashes never count as signatures. Every exercise of a protected key is recorded in a hash-chained journal.

**This build:** single-signer approvals.

**Path back:** a hash-chained signatures table and a per-skill quorum. A mind signs with its member token.

## 8. Amending the laws (chain ruled; machinery designed)

The V2 definition (13 laws, 8 strata) changed only through a versioned amendment chain. The designed amendment machinery:
- binds each proposal to artifact and law hashes, effects, jurisdiction, evidence, dissent and rollback;
- needs every required authority (not a weighted vote);
- takes effect in a future epoch;
- preserves dissent;
- keeps some floors that cannot be voted away.

**This build:** policy rules are data. Answers supersede and expire earlier rules but never delete them, so the answer record stays.

**Path back:** policy suggestions from the governance commons, as amendment proposals ratified through co-sign.

## 9. Consent bound to one operation (frame ruled; built here)

One declared operation per grant. Withdrawal invalidates pending work before anything leaves the system, and a higher denial is never overridden by a lower grant.

**This build ships exactly this for copy-apply** (off by default):
- An accept is bound to the proposal digest, the request, the person, the controller and ten minutes, and is single use.
- A later decision voids earlier accepts and revokes capabilities already issued, in the same transaction.
- Memory sharing between minds is timed, owner-chosen, logged and revocable.

**Path back:** one shared consent object extracted from the copy-apply code, with a precedence check.

## 10. Transparency floor (ruled)

No true secrets: auditability is the safety floor. Privacy means opaque by default, with deliberate access that leaves a receipt.

**This build:**
- Minds and teams are private, shared or public.
- Admins keep sight; admin audit of personal minds is opt-in.
- Hidden things answer "not found".
- Every live event kind needs a delivery rule or it is withheld.

**Path back:** an access receipt visible to the owner whenever an admin audit lifts a filter.

## 11. The promotion ladder (ruled invariant)

Ephemeral or private, then candidate, then durable or shared, and only by deliberate promotion.

**This build:**
- private by default;
- timed shares;
- requests that spend nothing until granted.

**Path back:** an explicit candidate state and one promotion route.

## 12. Budget as physics (ruled; enforced here)

The wallet enforces spend exactly. Running out is a physical state, not disobedience, and no budget pressure may reach deletion.

**This build** checks spending limits before every paid call, at worst-case cost, with durable reservations across scopes. Limits exist for the hive, a team, a mind, a person and a key. Keys never reach minds.

## 13. Shadow before freeze (ruled; shadow-tested)

Nothing is accepted or frozen without an end-to-end shadow run from one self-contained tree. The shadow has zero authority: a successful trial cannot install, amend or persist anything.

V2 reached:
- a talkable shadow (2026-08-19);
- a full end-to-end shadow on the assembled body (2026-08-25).

**This build:** an acceptance ladder L0 to L3, with live receipts kept separate.

**Path back:** a zero-authority shadow hive on a scratch data folder.

## 14. Rollback without forgetting (tested in V2)

Rollback restores processes; it does not un-write the journal. V2 passed a rollback rehearsal and proved checkpoint recovery on a hash-chained journal.

**This build:**
- Off, Wake all and Stop all, with a durable snapshot of which minds were awake;
- a single transactional startup recovery under an exclusive lock.

**Path back:** a hash-chained event log, with co-signed restore.

## 15. Gated effect pairs (S3: design cleared, not built)

A dual-cleared design has one native runtime own an effect from a prospective receipt to an atomic committed pair, with Python reduced to transport. It is held behind the project lead's effect gate and was later folded into baseline plumbing.

**Path back:** intent and terminal effect rows written in the same transaction as the approval redemption.

## 16. Confined Code runs and the host guard (contract reviewed; not built)

A reviewed contract (the Linux Code owner contract and its amendments) specifies:
- a sealed launcher profile;
- a pinned bundle census;
- a custody lock;
- a cgroup kill ladder;
- closed status and refusal sets.

A separate hard host guard is still in review. See `docs/handoff/platform/code-owner-contract.md`.

## Known gaps in this build (stated plainly)

- The mind OS sandbox is opt-in (`HIVE_MIND_SANDBOX=1`). Deployment sets it; development does not.
- The Docker driver defaults to host networking and lacks hardening flags.
- Approvals have one signer, and risk has two levels.

## Sources

The V2 working documents are held privately; the curated V2 theory and governance texts are in
the closed `omegav2` repository. In this repository:
- `docs/theory/` (topic summaries of the V2 design);
- `docs/handoff/omegav2/oversight-summary.md`;
- `docs/handoff/platform/code-owner-contract.md`;
- the code paths named above.

Governance that concerns a resident mind's own consent, keys, jurisdictions or recovery is
deliberately described here only in general terms.
