# Platform work sessions (lanes), October 2026

On 2026-10-04 the project lead split platform work into parallel Claude Code sessions so the platform owner session stopped being the bottleneck. Each lane builds one workstream as a candidate; the platform owner reviews, routes to independent review and merges. This file summarises the shared lane rules, the lane briefs and what their receipts reported.

## Shared lane rules

- Read first: the standing rules, the post-takeover study, the modular Hyperon direction (D0 first), the seam contracts through the latest amendment (frozen shapes: build to them exactly), and the reasoning seams rule.
- Work only in your own worktree and branch from the agreed base. Never edit the live checkout, the upstream reference copy or another owner's folder. Share UI dependencies rather than reinstalling.
- Focused tests while iterating; one full suite at the end. Several known pre-existing failures are documented. Do not run several full suites at once on the shared machine.
- Never: restart or deploy, change the live hive, push, clean disk beyond your own scratch, edit other worktrees, run Codex commands, or ask for permission changes.
- Done means: commits with attribution, honest test counts naming the level (L0 offline, L1 disposable host), a receipt stating what is not done and the risks, and a short inbox note that wakes the platform owner. No review result, no deploy.
- Codex owners are the customers. Contact them only through files in their folder; the platform owner relays.

## Lane briefs

| Lane | Brief | Receipt reported |
|---|---|---|
| hivecore | Build the Hive core scene (metagraph sphere, nerves, five notice tiers) plus a host snapshot route and salience pass | no receipt in the lane folder |
| reasoning | D0 foundation: one NAL in the mind with PLN separated, real PLN priors, committed stamped revision, a core NAL hook; plus a reasoning observatory. Reuse donor code | no receipt in the lane folder |
| evidence | S1/S1b evidence publication and retraction, plus the governance export | no receipt in the lane folder |
| bridge | S3 MCP member bridge to the first schema revision, exact JSON-RPC error mapping, strict binding digests on bound goals | built; focused tests pass |
| inventory | S4 per-mind tool inventory from a boot receipt; owner/admin and self views | built; focused L0/L1 tests pass; dynamic entries wait on another owner's chain |
| budget | S5 review fixes: one-transaction reserve and dispatch (or expiry sweep), never store or return prompts, plus hardening | built; focused tests pass; full suite with two known unrelated failures |
| appseams | App-frame subscribe bridge, finding targets with a validator hook, the S6 attachment binding object | built; focused and UI tests pass; one regression found and fixed |
| integration | Bring owners' tested candidates onto one branch (the OmegaCode chain, Flow and others) with attribution | integrated; full suite green after fixes; the Code browser runner timed out under machine load |

## What this tells a new agent

- The seam shapes are frozen in the contract amendments; lane code was written to them.
- Several lanes finished at L0/L1 only. A lane receipt is not a deploy; check the live release before assuming any of it is live.
- Known flaky or pre-existing failures are named in the receipts, so a new failure is a real signal.

_Curated summary. Full version kept privately (source: platform-sessions/README.md, hivecore.md, reasoning.md, evidence.md, bridge.md, bridge-RECEIPT.md, bridge-REPLY-20261004-2220.md, inventory.md, inventory-RECEIPT.md, budget.md, budget-RECEIPT.md, appseams.md, appseams-RECEIPT.md, integration.md, integration-RECEIPT.md)._
