import { hiveBase } from '../../api/client'
import type { HarnessInviteRow, HarnessRefusal } from '../../api/missingUi'
import { onIdentityChange } from '../../lib/identityEpoch'

/** The kinds of outside agent an invitation can be for. */
export type Harness = HarnessInviteRow['harness']

/** Where the join code goes, in steps shown once this page no longer holds the code. */
export const CODE_PLACEHOLDER = '<join code>'

/** Where a member's token goes, in its connect steps: the hive showed it once, when the member was added, and keeps no copy. */
export const TOKEN_PLACEHOLDER = '<its token>'

/** What each kind of outside agent is called, as the Connect page names them. */
export const HARNESS_TITLE: Record<Harness, string> = { 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes Agent', mcp: 'Any MCP client' }

/** The first words an outside agent is told once it has joined. */
export const starter = (name: string) =>
  `You are connected to an OmegaHive swarm through the omegahive tools, as ${name}. Call hive_whoami first and follow your role. Then keep working: check hive_inbox for messages and hive_goals for work, claim tasks you can do, report results with hive_goal_result, and reply to people with hive_send.`

/**
 * How each kind of agent joins, with the hive's server URL and the join code filled in; the host's join table
 * (hive/core mcp.py JOIN) gives the same steps. Codex takes the code as a static header in ~/.codex/config.toml, which
 * the Codex app reads as well as the CLI, and only when it starts: a variable exported in a shell never reaches the app.
 * That key sits in the file in plain text, so the step says so, and Codex run only from a terminal can keep it out of
 * the file instead. Claude Code's add refuses a name it already holds and a local entry shadows a user one, so its step
 * removes both before adding at user scope; the claude command installs apart from the desktop app. A member that has
 * joined connects the same way with its token (a join code becomes the member's token when it is used), so `what` names
 * the key in the steps' words: the join code, or the member's token. Pure.
 */
export function joinSteps(kind: Harness, url: string, code: string, what: 'code' | 'token' = 'code'): { label: string; text: string }[] {
  switch (kind) {
    case 'claude-code':
      return [
        { label: 'If the claude command is not installed yet (the Claude desktop app does not add it), on a Mac or Linux', text: 'curl -fsSL https://claude.ai/install.sh | bash' },
        {
          label: 'In a terminal. It replaces any omegahive entry added before, so a "No MCP server" line is fine',
          text: `claude mcp remove omegahive -s local; claude mcp remove omegahive -s user; claude mcp add --scope user --transport http omegahive ${url} --header "Authorization: Bearer ${code}"`,
        },
        { label: 'Then start a new Claude Code session, and type this to check it lists omegahive', text: '/mcp' },
      ]
    case 'codex':
      return [
        { label: `For the Codex app or the CLI, add to ~/.codex/config.toml. The ${what} sits in that file in plain text`, text: `[mcp_servers.omegahive]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${code}" }` },
        { label: `Or, if you run Codex only from a terminal, add this to ~/.codex/config.toml instead, which keeps the ${what} out of the file`, text: `[mcp_servers.omegahive]\nurl = "${url}"\nbearer_token_env_var = "OMEGAHIVE_TOKEN"` },
        { label: 'With that one, in the shell that runs Codex', text: `export OMEGAHIVE_TOKEN=${code}` },
        { label: 'Then quit Codex and open it again, and type this to check it lists omegahive', text: '/mcp' },
      ]
    case 'hermes':
      return [{ label: 'Add to the Hermes config (mcp_servers)', text: `mcp_servers:\n  omegahive:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${code}"` }]
    default:
      return [
        { label: 'Server URL (streamable HTTP)', text: url },
        { label: 'Header', text: `Authorization: Bearer ${code}` },
      ]
  }
}

/** What the hive answers once, when an invitation is made: the join code and its server URLs. */
export interface Joining {
  code: string
  mcp_url?: string
  local_url?: string
}

// The hive keeps only a hash of a join code (hive/core mcp.py), so the code exists only in the answer to the request
// that made the invitation. This page keeps that answer in memory, never in storage: a waiting invitation's steps can
// be shown again until the page reloads or the person signed in changes.
const held = new Map<string, Joining>()
onIdentityChange(() => held.clear())

/** Keep the hive's answer to making an invitation, so this page can show its steps again. */
export function holdJoining(id: string, answer: Partial<Joining>): void {
  if (answer.code) held.set(id, { code: answer.code, mcp_url: answer.mcp_url, local_url: answer.local_url })
}

/** The answer this page holds for an invitation it made, if any. */
export function heldJoining(id: string): Joining | undefined {
  return held.get(id)
}

/** Forget an invitation's code once it is not waiting: a joined code is the agent's key, an expired or withdrawn one is dead. */
export function settleJoining(id: string, status: HarnessInviteRow['status']): void {
  if (status !== 'waiting') held.delete(id)
}

/** The hive's MCP server as this page reaches the hive: the live client's base plus /mcp. */
export function pageMcpUrl(): string {
  return new URL(hiveBase() + '/mcp', location.href).href
}

/** What a refused connection means and what to do about it, in plain words (mcp.py refuse's `why`). Pure. */
export function refusalWords(r: Pick<HarnessRefusal, 'why' | 'invite'>): { what: string; next: string } {
  const name = r.invite?.name ?? 'an agent'
  switch (r.why) {
    case 'revoked':
      return { what: `It used the code of the invitation for ${name}, which was withdrawn.`, next: 'That agent still has the old code. Run the setup steps of a waiting invitation again; they replace the old entry.' }
    case 'expired':
      return { what: `It used the code of the invitation for ${name}, which had expired.`, next: 'New code on that invitation makes a fresh code with its steps.' }
    case 'connected':
      return { what: `It used a code that ${name} already joined with.`, next: 'Each code joins one agent. Invite again to add another.' }
    case 'no_code':
      return { what: 'It sent no join code.', next: 'Check its settings carry the Authorization line from the setup steps.' }
    default:
      return { what: 'It used a code this hive never made.', next: 'Check the whole code was pasted, or run the setup steps again.' }
  }
}

/**
 * Refused connections since `since` (an ISO time), one group per reason and invitation, newest group first, with how
 * many and when the last one was. Pure. Time: one pass over the refusals.
 */
export function refusalGroups(refusals: readonly HarnessRefusal[], since: string): { why: HarnessRefusal['why']; invite: HarnessRefusal['invite']; count: number; last: string }[] {
  const groups = new Map<string, { why: HarnessRefusal['why']; invite: HarnessRefusal['invite']; count: number; last: string }>()
  for (const r of refusals) {
    if (r.at < since) continue
    const key = `${r.why} ${r.invite?.id ?? ''}`
    const g = groups.get(key)
    if (g) {
      g.count++
      if (r.at > g.last) g.last = r.at
    } else groups.set(key, { why: r.why, invite: r.invite, count: 1, last: r.at })
  }
  return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last))
}

/** A fresh code's least lifetime, in minutes: a day, the Connect page's default, so a person setting an app up by hand has time. */
export const FRESH_CODE_MINUTES = 24 * 60

/** The invitation to make for a fresh code: the same agent, swarm and role, living at least a day or as long as the first. Pure. */
export function freshInvite(r: Pick<HarnessInviteRow, 'harness' | 'name' | 'swarm_id' | 'role_id' | 'created_at' | 'expires_at'>) {
  const first = Math.round((r.expires_at - Date.parse(r.created_at) / 1000) / 60)
  return { harness: r.harness, name: r.name, swarm_id: r.swarm_id, role_id: r.role_id, ttl_minutes: Math.max(FRESH_CODE_MINUTES, first || 0) }
}
