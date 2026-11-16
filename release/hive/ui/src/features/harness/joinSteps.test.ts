import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessInviteRow, HarnessRefusal } from '../../api/missingUi'

/**
 * Someone who invites an outside agent and then leaves the page can open its setup instructions again from the
 * invitation, without withdrawing it. The page keeps each code it made for the page session; for a code it does not
 * hold (made before a reload, or by someone else), the steps show where the code goes and say plainly why the hive
 * cannot show it again. A connection the hive refused shows where the person waits, with why and what to do. The admin
 * check, the reads and the store are replaced at their modules; INVENTED codes, names and addresses only.
 */

const h = vi.hoisted(() => ({ rows: [] as HarnessInviteRow[], refusals: [] as HarnessRefusal[], read: '' }))

vi.mock('../../lib/useAdmin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/useAdmin')>()),
  useMe: () => ({ me: undefined, admin: true, loaded: true, failed: false }),
}))
// each read answers at once; which one it is shows in the client method its fetcher calls
vi.mock('../../lib/useResource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/useResource')>()),
  useResource: (fetcher: () => Promise<unknown>) => {
    h.read = ''
    void fetcher().catch(() => undefined)
    return { status: 'ready', data: h.read === 'refusals' ? h.refusals : h.rows, mutate: () => undefined, reload: () => undefined }
  },
}))
vi.mock('../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store')>()
  // the selector answers from this test's hive; getState, setState and subscribe stay the store's own
  const client = {
    harnessInvites: () => ((h.read = 'invites'), Promise.resolve([])),
    harnessRefusals: () => ((h.read = 'refusals'), Promise.resolve([])),
    revokeHarnessInvite: async () => ({}),
    createHarnessInvite: async () => ({}),
  }
  const pick = (select: (s: unknown) => unknown) =>
    select({ ...real.useHive.getState(), client, swarms: { s_garden: { id: 's_garden', name: 'Garden' } }, toast: () => undefined })
  return { ...real, useHive: Object.assign(pick, real.useHive) }
})

const { CODE_PLACEHOLDER, FRESH_CODE_MINUTES, freshInvite, heldJoining, holdJoining, joinSteps, refusalGroups, refusalWords, settleJoining, starter } = await import('./joinSteps')
const { InviteSteps, Refusals } = await import('./InviteSteps')
const { OpenInvites } = await import('./OpenInvites')
const { useHive } = await import('../../store/store')

const LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes Agent', mcp: 'Any MCP client' } as const
const KINDS = Object.keys(LABEL) as HarnessInviteRow['harness'][]
const row = (id: string, name: string, harness: HarnessInviteRow['harness'], status: HarnessInviteRow['status']): HarnessInviteRow => ({
  id, harness, harness_label: LABEL[harness], name, swarm_id: 's_garden', role_id: null, created_by: 'user:p_ada',
  created_at: '2026-11-09T04:40:00Z', expires_at: Date.parse('2026-11-10T04:40:00Z') / 1000,
  redeemed_at: status === 'connected' ? '2026-11-09T05:00:00Z' : null, agent_id: status === 'connected' ? 'a_quill' : null,
  revoked_at: status === 'revoked' ? '2026-11-09T06:00:00Z' : null, status,
})
const MADE = { code: 'ohv1_INVENTED-code-1', mcp_url: 'https://hive.example.org/mcp', local_url: 'http://127.0.0.1:8700/mcp' }
const steps = (invite: HarnessInviteRow) => renderToStaticMarkup(createElement(InviteSteps, { invite }))
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
/** The page as the browser opened it: the address the hive's own client builds its calls from. */
const openedAt = (href: string) => {
  const url = new URL(href)
  vi.stubGlobal('location', url)
  vi.stubGlobal('window', { location: url })
}

beforeEach(() => {
  for (const id of ['hi_1', 'hi_2', 'hi_3', 'hi_4', 'hi_5']) settleJoining(id, 'revoked')
  h.refusals = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the steps an outside agent follows', () => {
  it('carry the server URL and the join code, with nothing left to fill in, for every kind of agent', () => {
    for (const kind of KINDS) {
      const text = joinSteps(kind, 'https://hive.example.org/mcp', 'ohv1_INVENTED').map((s) => s.text).join('\n')
      expect(text, kind).toContain('https://hive.example.org/mcp')
      expect(text, kind).toContain('ohv1_INVENTED')
      expect(text, kind).not.toMatch(/\{url\}|\{code\}|undefined/)
    }
  })

  it('give Codex the code in its config file for the app or the CLI, saying it sits there in plain text, or from a shell for a terminal, then have it reopened and checked', () => {
    const [config, terminal, shell, check] = joinSteps('codex', 'https://hive.example.org/mcp', 'ohv1_INVENTED')
    expect(config.text).toBe('[mcp_servers.omegahive]\nurl = "https://hive.example.org/mcp"\nhttp_headers = { Authorization = "Bearer ohv1_INVENTED" }')
    expect(config.label).toBe('For the Codex app or the CLI, add to ~/.codex/config.toml. The code sits in that file in plain text')
    expect(terminal.text).toBe('[mcp_servers.omegahive]\nurl = "https://hive.example.org/mcp"\nbearer_token_env_var = "OMEGAHIVE_TOKEN"')
    expect(terminal.label).toContain('only from a terminal')
    expect(shell.text).toBe('export OMEGAHIVE_TOKEN=ohv1_INVENTED')
    expect(check).toEqual({ label: 'Then quit Codex and open it again, and type this to check it lists omegahive', text: '/mcp' })
  })

  it('give Claude Code a command that replaces an earlier omegahive entry at user scope, after how to get the claude command, then a new session to check', () => {
    const [install, command, check] = joinSteps('claude-code', 'https://hive.example.org/mcp', 'ohv1_INVENTED')
    expect(install).toEqual({ label: 'If the claude command is not installed yet (the Claude desktop app does not add it), on a Mac or Linux', text: 'curl -fsSL https://claude.ai/install.sh | bash' })
    expect(command.text.split('; ')).toEqual([
      'claude mcp remove omegahive -s local',
      'claude mcp remove omegahive -s user',
      'claude mcp add --scope user --transport http omegahive https://hive.example.org/mcp --header "Authorization: Bearer ohv1_INVENTED"',
    ])
    expect(command.label).toContain('replaces any omegahive entry added before')
    expect(check).toEqual({ label: 'Then start a new Claude Code session, and type this to check it lists omegahive', text: '/mcp' })
  })

  it('show again, with the code and both addresses, for a waiting invitation this page made', () => {
    holdJoining('hi_1', MADE)
    const html = steps(row('hi_1', 'Codex', 'codex', 'waiting'))
    expect(html).toContain('Paste this into Codex:')
    expect(html).toContain(esc('http_headers = { Authorization = "Bearer ohv1_INVENTED-code-1" }'))
    expect(html).toContain(esc('url = "https://hive.example.org/mcp"'))
    expect(html).toContain('aria-label="Where it runs"')
    expect(html).toContain(esc(starter('Codex')))
    expect(html).toContain('send it only to the agent you are inviting')
    expect(html).toContain('once this page reloads or you sign out it cannot be shown again')
    expect(html).not.toContain(esc(CODE_PLACEHOLDER))
    expect(html).not.toContain('cannot show the code again')
  })

  it('without the code, show where it goes, the address this page reaches the hive at, and say plainly why', () => {
    openedAt('https://hive.example.org/garden/index.html#/connect')
    const html = steps(row('hi_2', 'Claude', 'claude-code', 'waiting'))
    expect(html).toContain(esc('claude mcp add --scope user --transport http omegahive https://hive.example.org/garden/mcp --header "Authorization: Bearer <join code>"'))
    expect(html).toContain(esc(starter('Claude')))
    expect(html).toContain('The join code was shown once, when this invitation was made. The hive does not keep a copy, so it cannot show the code again.')
    expect(html).toContain(`If you saved it, use it where the steps say ${esc(CODE_PLACEHOLDER)}. If not, withdraw this invitation and invite Claude again for a new code.`)
    expect(html).not.toContain('Where it runs')
    expect(html).not.toContain('ohv1_')
  })

  it('hold a code only while it can still be used to join, and never past a change of who is signed in', () => {
    holdJoining('hi_3', { mcp_url: MADE.mcp_url })
    expect(heldJoining('hi_3')).toBeUndefined()
    for (const status of ['connected', 'expired', 'revoked'] as const) {
      holdJoining('hi_3', MADE)
      settleJoining('hi_3', 'waiting')
      expect(heldJoining('hi_3')).toEqual(MADE)
      settleJoining('hi_3', status)
      expect(heldJoining('hi_3'), status).toBeUndefined()
    }
    holdJoining('hi_4', MADE)
    useHive.setState((s) => ({ inits: s.inits + 1 }))
    expect(heldJoining('hi_4')).toBeUndefined()
  })
})

describe('the invitations list', () => {
  it('offers each waiting invitation its setup instructions, and joined, expired or withdrawn ones none', () => {
    holdJoining('hi_1', MADE)
    h.rows = [row('hi_1', 'Codex', 'codex', 'waiting'), row('hi_2', 'Claude', 'claude-code', 'waiting'), row('hi_3', 'Quill', 'claude-code', 'connected'), row('hi_4', 'Guest', 'mcp', 'expired'), row('hi_5', 'Hermes', 'hermes', 'revoked')]
    const html = renderToStaticMarkup(createElement(OpenInvites))
    const items = html.split('<li').slice(1)
    expect(items).toHaveLength(5)
    const offers = (name: string) => items.find((i) => i.includes(`>${name} <`))!.includes('aria-expanded="false"')
    expect(['Codex', 'Claude'].map(offers)).toEqual([true, true])
    expect(['Quill', 'Guest', 'Hermes'].map(offers)).toEqual([false, false, false])
    expect(html.match(/>Setup instructions</g)).toHaveLength(2)
    // an expired invitation offers a fresh code in one tap; nothing else does
    expect(items.filter((i) => i.includes('>New code<')).map((i) => i.includes('>Guest <'))).toEqual([true])
    expect(html).not.toContain('ohv1_INVENTED-code-1')   // folded until asked for
  })

  it('says above the invitations when a connection was refused while one waited, and why', () => {
    h.rows = [row('hi_1', 'Codex', 'codex', 'waiting'), row('hi_5', 'Hermes', 'hermes', 'revoked')]
    h.refusals = [
      { at: '2026-11-09T05:10:00Z', why: 'revoked', invite: { id: 'hi_5', name: 'Hermes', harness_label: 'Hermes Agent' } },
      { at: '2026-11-09T05:09:00Z', why: 'revoked', invite: { id: 'hi_5', name: 'Hermes', harness_label: 'Hermes Agent' } },
      { at: '2026-11-09T04:30:00Z', why: 'unknown', invite: null },   // before the invitation was made: not shown
    ]
    const html = renderToStaticMarkup(createElement(OpenInvites))
    expect(html).toContain('data-refusals')
    expect(html).toContain('2 connections were refused, the last')
    expect(html).toContain('It used the code of the invitation for Hermes, which was withdrawn.')
    expect(html).not.toContain('never made')
    h.rows = [row('hi_5', 'Hermes', 'hermes', 'revoked')]   // nothing waits: nothing to say
    expect(renderToStaticMarkup(createElement(OpenInvites))).not.toContain('data-refusals')
  })
})

describe('a refused connection', () => {
  const at = (minute: number, why: HarnessRefusal['why'], invite: HarnessRefusal['invite'] = null): HarnessRefusal => ({ at: `2026-11-09T05:${String(minute).padStart(2, '0')}:00Z`, why, invite })
  const quill = { id: 'hi_7', name: 'Quill', harness_label: 'Codex' }

  it('says why its code failed and what to do, for every reason the hive gives', () => {
    expect(refusalWords({ why: 'revoked', invite: quill })).toEqual({ what: 'It used the code of the invitation for Quill, which was withdrawn.', next: 'That agent still has the old code. Run the setup steps of a waiting invitation again; they replace the old entry.' })
    expect(refusalWords({ why: 'expired', invite: quill }).what).toBe('It used the code of the invitation for Quill, which had expired.')
    expect(refusalWords({ why: 'expired', invite: quill }).next).toBe('New code on that invitation makes a fresh code with its steps.')
    expect(refusalWords({ why: 'connected', invite: quill }).what).toBe('It used a code that Quill already joined with.')
    expect(refusalWords({ why: 'unknown', invite: null }).what).toBe('It used a code this hive never made.')
    expect(refusalWords({ why: 'no_code', invite: null }).what).toBe('It sent no join code.')
    for (const why of ['revoked', 'expired', 'connected', 'unknown', 'no_code'] as const) expect(refusalWords({ why, invite: quill }).next, why).not.toBe('')
  })

  it('groups by reason and invitation, counts them, keeps the last time, and leaves out those before `since`', () => {
    const groups = refusalGroups([at(12, 'unknown'), at(10, 'revoked', quill), at(14, 'revoked', quill), at(1, 'no_code')], '2026-11-09T05:05:00Z')
    expect(groups).toEqual([
      { why: 'revoked', invite: quill, count: 2, last: '2026-11-09T05:14:00Z' },
      { why: 'unknown', invite: null, count: 1, last: '2026-11-09T05:12:00Z' },
    ])
    expect(refusalGroups([at(1, 'no_code')], '2026-11-09T05:05:00Z')).toEqual([])
  })

  it('shows nothing where none was refused, and one plain line per group where some were', () => {
    expect(renderToStaticMarkup(createElement(Refusals, { refusals: [], since: '2026-11-09T05:00:00Z' }))).toBe('')
    const html = renderToStaticMarkup(createElement(Refusals, { refusals: [at(12, 'unknown')], since: '2026-11-09T05:00:00Z' }))
    expect(html).toContain('role="status"')
    expect(html).toContain('A connection was refused, the last')
    expect(html).toContain('It used a code this hive never made. Check the whole code was pasted, or run the setup steps again.')
    const two = renderToStaticMarkup(createElement(Refusals, { refusals: [at(12, 'unknown'), at(13, 'unknown')], since: '2026-11-09T05:00:00Z' }))
    expect(two).toContain('2 connections were refused, the last')
  })
})

describe('a fresh code for an expired invitation', () => {
  it('is a new invitation for the same agent, swarm and role, living at least a day or as long as the first', () => {
    const hour = row('hi_4', 'Guest', 'mcp', 'expired')   // made 04:40, expiring 04:40 the next day: a day
    expect(freshInvite({ ...hour, expires_at: Date.parse('2026-11-09T05:40:00Z') / 1000 })).toEqual({ harness: 'mcp', name: 'Guest', swarm_id: 's_garden', role_id: null, ttl_minutes: FRESH_CODE_MINUTES })
    expect(freshInvite({ ...hour, expires_at: Date.parse('2026-11-16T04:40:00Z') / 1000 }).ttl_minutes).toBe(7 * 24 * 60)
    expect(FRESH_CODE_MINUTES).toBe(24 * 60)
  })
})
