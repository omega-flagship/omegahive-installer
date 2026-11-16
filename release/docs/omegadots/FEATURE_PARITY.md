# OmegaDots Hive: feature parity with OpenAI Dots and Grok Bot

Snapshot: 2026-10-03.

## Who we compare against

- **OpenAI Dots**: launched 2026-09-29 at DevDay; runs on GPT-6 Astra.
- **Grok Bot**: from SpaceXAI (formerly xAI), co-distributed with Cursor, beta
  since 2026-08-11. It is xAI's always-on agent product. It is not the `@grok`
  reply bot on X.

## How reliable this is

- The research notes behind it are in `research/competitors-2026-10.md`.
- Most sources were reachable only as search snippets. Treat specific limits
  (VM sizes, caps) as unverified.

## The goal

At least full parity. Where both products are weak, we aim to win: memory
control, spend caps, undo, model choice, replay, self-hosting and federation.

## Status key

| Mark | Meaning |
|---|---|
| ✅ | Built and tested on `claude/holarchy-nested-spaces` |
| 🟡 | Partly built |
| P*n* | Planned for phase *n* in PLAN.md |

The new tracks added for parity are:

- **E**: Embodiment (computer, browser, live view)
- **I**: Integrations and channels
- **T**: Teams and enterprise

## Columns

- **D**, **G**: whether Dots and Grok Bot have the feature: Y (yes),
  P (partial), R (on their roadmap only), N (no), ? (unclear).
- **Hive**: our status, using the key above.

| # | Capability | D | G | Hive | How the hive does it |
|---|---|---|---|---|---|
| 1 | Always-on persistent agent | Y | Y | ✅ | Omega's continuous loop. The supervisor restores the desired state after a hive restart; the acceptance test covers this. |
| 2 | Goals and long-horizon tasks | Y | Y | P2 | Goal, Claim and Result atoms; Context Frames; resumable plans. |
| 3 | Scheduled tasks (timezone, destination, notify) | Y | Y | P2 | Hive scheduler (cron with timezone) sends wake messages to the hub. The `scheduler_reminders` module never fires today. |
| 4 | Event triggers (email, chat, doc change) | Y | Y | I | Event bus fed by connector webhooks and polling, with pattern filters, delivered as `CHANNEL_EVENT`s. |
| 5 | Proactive read-only background work | Y | P | 🟡 → P2 | Omega already wakes itself (`wakeupInterval`). Add an idle read-only skill policy and a private-notes space. |
| 6 | Parallel background subagents | Y | Y | P2 | Iter workers and goal delegation inside a swarm, with concurrency and depth caps. |
| 7 | Teach by demonstration | N | Y | E | Record DOM and action traces from the browser, then compile them into a skill. Omega skills are MeTTa, so a taught task becomes inspectable code. |
| 8 | Skills (procedural memory) | P | Y | 🟡 | Omega skills plus skill cards and triggers. Add a port of upstream's `SKILL.md` workflow loader. |
| 9 | Own computer per agent | Y | P | 🟡 | One container per agent through the docker driver (tested). VM isolation (Firecracker/QEMU) comes with the Omega Cloud driver in P5. |
| 10 | Browser and computer use | Y | Y | E | Chromium in the agent sandbox, driven by a computer-use skill module, with persistent profiles. |
| 11 | Terminal, files, code execution | Y | Y | 🟡 | Omega `shell`/file skills and `codex_code`, inside the container. Gate `shell-confirm` behind approvals (P2). |
| 12 | Live view and human takeover | Y | Y | E | VNC or WebRTC stream of the agent's screen in the UI, with an input handoff lock. |
| 13 | Opt-in local computer access | Y | Y | E | Companion desktop app with an Ask / Always / Never policy, bound to one host. |
| 14 | Private-network egress | N | Y | P5 | WireGuard or Tailscale sidecar per agent or swarm. |
| 15 | Large app catalog | Y | P | I | MCP-first, plus OpenAPI import and adapters to existing catalogs. |
| 16 | Bring-your-own MCP | ? | Y | I | Native MCP client skill module; servers scoped per agent. |
| 17 | Email, calendar, Slack, Teams | Y | Y | 🟡 → I | The fork already has Slack, Telegram, WhatsApp, Mattermost and IRC channels. Email, calendar and Teams come through MCP connectors. |
| 18 | Purchases with approval | Y | N | P2 + I | A payment tool is always routed through the approval gate and a budget. |
| 19 | Password manager | N | Y | I | Vault broker (Bitwarden/1Password/KeePass). Approval for each fill; secrets never enter the model context. |
| 20 | Secure credential entry | Y | Y | E | Out-of-band form injects credentials into the browser; they are redacted from logs and screenshots. |
| 21 | Per-agent memory | Y | Y | ✅ | Private AtomSpaces with ChromaDB, one memory directory per agent. Persistence was fixed in Phase 0. |
| 22 | **View, edit and delete memory** | N | N | P2 | Memory inspector: browse, edit and retire atoms through proposal-first cleanup. **Neither competitor has this.** |
| 23 | Many agents per user | R | Y | ✅ | No hard cap; limited by resources. |
| 24 | Agent group chat and handoffs | P | Y | P2 | Swarm group thread, goal claims and handoffs, and a shared commons instead of text-only handoffs. |
| 25 | Shared team agents (Grok **Team Bots**: one shared bot per workflow; public beta 2026-09-28) | P | Y | T* | See "Team Bots parity" below. Pulled forward to straight after Phase 2. |
| 26 | Shared docs workspace | Y | N | T | Collaborative documents (CRDT) that agents edit and can be @-tagged in. |
| 27 | Web, desktop and mobile apps | Y | Y | 🟡 | Mobile-first PWA web UI (in progress). Desktop (Tauri) and native mobile later. |
| 28 | Slack, Teams and SMS channels | Y/Y/R | Y | 🟡 → I | Slack exists. Add Teams, SMS, email and Matrix adapters. |
| 29 | Voice (call the agent, voice memos) | Y | Y | I | Speech-to-text and text-to-speech pipeline plus WebRTC or SIP. The fork has a `sense_audio` module to build on. |
| 30 | Outbound phone calls | ? | P | I | SIP-trunk tool behind approval. |
| 31 | Persona (name, avatar, handle) | Y | Y | 🟡 | Name, persona and hue exist. The avatar renderer is part of the UI. |
| 32 | Notifications and inline decisions | Y | Y | P2 | Push, email and chat notifications; inline approval forms and drafts. |
| 33 | Per-action rules (allow / pre-approved / ask / hand off / deny) | Y | Y | P2 | Policy engine over action, target and data class; standing rules in Approvals. |
| 34 | Second-model auto-review | Y | Y | P2 | Independent reviewer model **plus a symbolic norm checker** (deontic, from MesTTo `omegaclaw-deontic`), which gives proof-carrying allow/deny decisions. |
| 35 | Monitor that pauses on risk | Y | P | P2 | Runtime monitor with pause and kill hooks; integrity alarms are shared with Crucible. |
| 36 | Actions only a human may take | Y | P | P2 | Hard-coded list the agent can never take (password change, money transfer). Enforced in the syntax membrane. |
| 37 | Pause, stop, reset, delete | Y | Y | 🟡 | Start, stop, sleep, wake and delete are built. Add a memory reset and a global kill switch (P2). |
| 38 | Network egress allowlist | N | Y | P5 | Per-agent egress firewall. The docker driver already supports `--network`. |
| 39 | **Spend caps** | N | N | ✅ | Hard per-agent budgets in the LLM gateway (402 when exhausted; tested). Per-routine caps come with the scheduler. |
| 40 | **Undo and rollback** | N | N | P2.5 + E | Crucible rollback for code. An action journal with compensating actions plus VM snapshots for the world. |
| 41 | Activity feed | Y | Y | 🟡 | Live event stream in the UI is built; a task timeline with artifacts comes in P2. |
| 42 | **Recording and replay for everyone** | N | P | P2 | "Thinking timeline": loop, LLM and skill events plus a bounded trace per iteration (MesTTo trace schema), exported as OTel spans. |
| 43 | Audit log, SIEM, OTel | P | Y | 🟡 → P5 | The event log exists. Add a hash-chained audit trail and an OTel exporter. |
| 44 | Template marketplace and recipes | N | Y | P3 | Agent recipe export and import (persona, skills, modules; no secrets) plus a registry. |
| 45 | **Agent API and webhooks** | N | N | ✅ / P3 | REST API and agent hub are built. Outbound webhooks and SDKs come in P3. |
| 46 | SSO, SCIM, RBAC | Y | P | T | OIDC/SAML, SCIM, role-scoped capabilities. |
| 47 | Admin capability toggles | Y | Y | T | Per-role switches for computer, local exec, apps and messaging. |
| 48 | Compliance and retention | Y | N | 🟡 | Self-hosted, so data stays on your hardware. Configurable retention in P5. |
| 49 | **Model choice per agent** | N | N | ✅ | `<provider>/<model>` per agent: Anthropic, OpenAI, OpenRouter, any self-hosted vLLM/SGLang/Ollama, or the offline mock. |
| 50 | Vehicle or embedded surface | N | P | — | Low priority. A generic voice endpoint covers it. |
| 51 | Agents with their own org identity | R | P | T | Agent service accounts with their own credentials. |

## Team Bots parity

Grok Team Bots launched in public beta on 2026-09-28. Their features and our
equivalents:

| Team Bots feature | Hive equivalent |
|---|---|
| One shared bot per team workflow | A team-owned dot or swarm, owned by a team rather than a person |
| Shared context, skills and memory | Shared persona, modules and skills. Team memory is the swarm commons, and the dot's private spaces are shared by the team. |
| Shared plugins and credentials | Team-scoped connector grants and vault entries. Use by each person still goes through per-action approval. |
| Each person gets a private chat with the shared bot | A conversation per user on the hub (`conversation_id` per person), where the dot sees who it is talking to |
| Published to the whole team | Team roles (owner, editor, user) on the dot; visible on everyone's Hive home |
| Own Slack app (DM or @mention) | Slack channel adapter per team dot (the fork already has Slack) |
| Pre-built team templates (sales, product, marketing, data) | Recipe templates (P3 marketplace), with team versions first |

This needs a minimal multi-user layer (users, teams, roles) from track T.
That part moves forward to straight after Phase 2. SSO and SCIM stay in T.

## External agents as swarm members (vendor-neutral)

The hive must let **third-party agents join swarms**: Dots, Grok Bots and Team
Bots, OpenClaw, custom OpenAI or Anthropic agents, and anything else.

| Path | For | How |
|---|---|---|
| **Hive MCP server** | Grok Bot / Team Bots (bring-your-own MCP), ChatGPT apps (built on MCP), Claude, and any MCP-capable agent | Tools: `hive_post`, `hive_inbox`, `hive_publish`, `hive_query`, `hive_belief`, `hive_goals`, `hive_claim_goal`, `hive_result`. Auth is a per-member hive token. |
| **Chat bridge** | Dots (Slack and Teams), Team Bots (Slack) | The swarm's group thread is mirrored into a Slack or Teams channel. Messages from the external bot become hub messages from that member. Structured commands such as `/believe` and `/claim` are parsed. |
| **API adapters** | OpenClaw (upstream Omega already has an adapter), OpenAI Agents API, Anthropic agents | The adapter runs as a hive module and calls the agent's API for each task. |
| **Hive SDK, A2A, webhooks** | Everything else | Module Space protocol (P3), Agent2Agent where supported, or a plain webhook endpoint. |

**Trust rules for external members:**
- Their beliefs count with a **trust discount** (`c' = c·trust`). New vocabulary
  they introduce is quarantined until approved.
- Every hive action passes the same policy engine and approvals as our own
  dots.
- They **never** enter Crucible and never modify Omega code.
- Every contribution is labelled with its origin, e.g. "Grok Bot via MCP",
  and the UI shows it.
- Their membership can be revoked instantly. Their past assertions stay, with
  their provenance.

## Where the hive is ahead of both

- **Built and tested now:**
  - per-agent model choice;
  - hard spend caps;
  - one container per agent, never a shared VM (Grok Bot shares one VM, and
    its logins, across all of a user's bots);
  - an open REST API and agent hub;
  - self-hosting.
- **Built only by us:**
  - shared beliefs with **evidential provenance and revision**, so agents that
    echo each other cannot inflate confidence;
  - **inspectable symbolic memory**;
  - **swarm-to-federation sharing** across owners;
  - **Crucible**: gated, benchmarked self-improvement with human-approved
    promotion and rollback.
- **Planned to beat both:**
  - memory edit/delete (#22);
  - replay for everyone (#42);
  - undo (#40);
  - proof-carrying policy decisions (#34).

## New tracks added to PLAN.md

### E: Embodiment (after Phase 2)

- Sandboxed Chromium with a computer-use skill module.
- Live screen stream with human takeover.
- Secure credential entry.
- Teach-by-demonstration that compiles to MeTTa skills.
- Opt-in local-computer companion.
- Action journal and snapshots for undo.

### I: Integrations and channels (with Phase 3)

- MCP client module.
- Connectors: email, calendar, Teams, GitHub, docs.
- Event-trigger bus.
- Vault broker.
- Voice: speech-to-text, text-to-speech, WebRTC and SIP.
- Teams, SMS, Matrix and email channels.
- Payment tool behind approval.

### X: External members (with Phase 3)

- Hive MCP server.
- Slack and Teams chat bridge for external bots.
- OpenClaw and Agents-API adapters.
- External-member trust policy and origin labels in the UI.

### T: Teams and enterprise (after Phase 4; Team Bots parity pulled forward)

- Multi-user auth with SSO and SCIM.
- RBAC and admin toggles.
- Shared team agents.
- Collaborative documents.
- Agent service identities.
