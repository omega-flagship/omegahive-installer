# Competitor census: OpenAI Dots and Grok Bot

Research notes from 2026-10-03.

**How reliable this is.** Direct fetches of every vendor page and most press
pages were blocked by the session's proxy. Facts come from search-result
snippets. "Confirmed" means a vendor-domain snippet. The capability matrix is
in `../FEATURE_PARITY.md`.

## OpenAI Dots

**Launch.** Launched on 2026-09-29. The model is GPT-6 Astra, released
2026-09-03, with no model picker.

**Computer and autonomy.**
- One persistent Linux VM with Chrome per dot.
- Watch it live or take over.
- Optional local-computer access through the desktop app, off by default.
- Goals, scheduled tasks, event triggers, read-only proactive research and
  parallel background tasks.

**Apps and channels.**
- 4,000+ apps through ChatGPT plugins.
- Slack and Teams; SMS is "coming soon".
- Voice calls.
- An avatar persona with an @handle.

**Safety and controls.**
- Custom Rules per action: act / act if pre-approved / ask / hand off.
- A second-model auto-review that cannot be turned off.
- A monitor that pauses work.
- Password changes and money transfers are human-only.
- A secure credential form.
- Pause, stop and reset.
- Activity tab and live view.
- **No** memory editing, spend cap, replay or Dots API.

**Collaboration.** ChatGPT Space and Pages for shared documents.

**Enterprise and pricing.**
- Enterprise beta with admin RBAC and SSO/SCIM.
- First dot included in the Pro tiers and in Business Premium.
- New Pro 500 tier.
- Not available in the EEA, UK or CH on Pro.

**Roadmap.** Teams of dots, and "specialist dots" through Microsoft Agent 365.

**Key sources:**
- developers.openai.com/codex/dots
- help.openai.com/en/articles/20001529 and 20001530
- learn.chatgpt.com/docs/dots/controls
- Bloomberg, TechCrunch, VentureBeat and Datacamp (2026-09-29)

## Grok Bot

**Launch and plans.**
- From SpaceXAI (xAI after the SpaceX merger), with Cursor.
- Beta since 2026-08-11. The model is Grok 4.6.
- Bundled into SuperGrok and Cursor plans; no standalone plan.

**Computer and autonomy.**
- **One Debian VM shared by all of a user's bots**, including their logins.
- Optional local execution: Ask, Always or Never.
- Private-network egress through Tailscale or Cloudflare.
- Routines on cron or events.
- Teach-a-task by demonstration.
- Skills.
- Delegation to Cursor Cloud Agents.

**Apps and channels.**
- About 13 native connectors.
- Bring-your-own MCP; Composio provides 1,000+ more.
- 1Password vault.
- Voice.
- Slack for Team Bots.
- Apps on macOS, Windows, Linux, iOS and Android.

**Multi-agent and sharing.**
- Group chats of 2–6 bots with text-only handoffs.
- Team Bots, in beta since 2026-09-28.
- A recipe marketplace.

**Safety and controls.**
- Approvals: allow once, always allow, or deny.
- Auto Review.
- Masked secrets.
- An egress allowlist on Enterprise.

**Observability.** Enterprise only: audit logs, plus Action Recording exported
as OTel.

**Gaps and problems.**
- No API, webhooks or undo.
- No memory UI.
- A spend cap is unclear.
- No compliance claims.
- Reported outages on the shared VM and fast quota burn.

**Key sources:**
- x.ai/bot and x.ai/news/designing-grok-bot
- docs.x.ai/grok-bot/security and docs.x.ai/grok/connectors
- cursor.com/docs/grok-bot/teams
- unite.ai and techzine

## Re-check when primary pages are reachable

- Which Dots Pro tiers include a dot.
- Whether Dots supports MCP.
- Whether Dots can place outbound calls.
- Whether Grok Bot can set a spend cap.
- Grok Bot's 50-bot and 50-routine limits.
- The VM specifications for both products.
