import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, type Me, type Person } from '../../api/client'
import { identityLine } from '../../lib/identity'
import { UnsupportedError, type ResourceState } from '../../lib/useResource'
import { STALE } from '../../lib/identityEpoch'
import { Screen } from '../../screens/Screen'
import { ScreensSpace } from '../../screens/screenSpace'
import { passwordAct, shownFrom, type ShownPassword } from './memberPassword'
import { peopleScreen, type Can, type Moment, type PeopleData } from './data'

vi.setConfig({ testTimeout: 20_000 })

// metta-screens-people: the page is composed by MeTTa now (people.metta), so these tests draw the composed screen where
// they drew PeopleState, PasswordShown and Row before; what they assert is unchanged
const space = ScreensSpace.open()
const compose = (screen: string, facts: Parameters<typeof space.compose>[2]) => space.compose(screen, 'classic', facts)
const ALL: Can = { invite: true, addMember: true, revokeInvite: true, updatePerson: true, clearGoogle: true, resetPassword: true, removePassword: true }
const draw = (res: ResourceState<PeopleData>, moment: Moment = { invite: null, password: null }) => {
  const { data, facts } = peopleScreen(res, { admin: true, selfId: null }, ALL, moment, { seen: () => '1h ago', day: () => '1/2/2026' }, compose)
  return renderToStaticMarkup(createElement(Screen, { plan: compose('people', facts), host: { data, framed: true, onAction: () => undefined, onOpen: () => undefined } }))
}
const render = (res: ResourceState<PeopleData>) => draw(res)
const failed = (error: unknown): ResourceState<PeopleData> => ({ status: 'error', data: undefined, error, refreshing: false })
const readyWith = (data: PeopleData): ResourceState<PeopleData> => ({ status: 'ready', data, error: undefined, refreshing: false })

describe('People page states', () => {
  it('says "Admins only" on a 403', () => {
    const html = render(failed(new ApiError(403, 'forbidden', 'admins only')))
    expect(html).toContain('Admins only')
    expect(html).not.toContain('Try again')
  })

  it('shows any other failure as an error with a retry, never "Admins only"', () => {
    for (const e of [new ApiError(500, 'internal', 'Internal error'), new ApiError(0, 'network', 'Failed to fetch'), new ApiError(401, 'unauthorized', 'Sign in again'), new Error('timeout')]) {
      const html = render(failed(e))
      expect(html).toContain('Could not load people')
      expect(html).toContain('Try again')
      expect(html).not.toContain('Admins only')
    }
  })

  it('says "not available here" when the hive has no people list', () => {
    const html = render({ status: 'unsupported', data: undefined, error: new UnsupportedError(), refreshing: false })
    expect(html).toContain('Not available here')
    expect(html).not.toContain('Admins only')
  })

  it('renders the list when ready', () => {
    const html = render({ status: 'ready', data: { people: [], invites: [], google_ready: true }, error: undefined, refreshing: false })
    expect(html).toContain('aria-label="In this hive"')
    expect(html).toContain('Hive operator')
  })
})

describe('Profile identity', () => {
  const ok = (me: Me): ResourceState<Me> => ({ status: 'ready', data: me, error: undefined, refreshing: false })
  it('calls a password session the operator, an admin', () => {
    expect(identityLine(ok({ principal: 'operator', kind: 'password', role: null, expires_at: null, person: null }))).toContain('Operator (admin)')
  })
  it('shows the role a Google session reports', () => {
    const line = identityLine(ok({ principal: 'p_1', kind: 'sso', signin: 'google', role: 'member', expires_at: null, person: { id: 'p_1', email: 'a@example.org', name: 'A' } }))
    expect(line).toBe('a@example.org · Signed in with Google · Member')
    // r1.1: an older host that doesn't say how is never guessed as Google
    expect(identityLine(ok({ principal: 'p_1', kind: 'sso', role: 'member', expires_at: null, person: null }))).not.toContain('Google')
  })
  it('localowner-ui r1: the installer\'s local sign-in (an sso-kind session) is never called Google', () => {
    const line = identityLine(ok({ principal: 'p_owner', kind: 'sso', signin: 'local_install', role: 'admin', expires_at: null, person: { id: 'p_owner', email: 'owner@local.invalid', name: 'Owner' } }))
    expect(line).not.toContain('Google')
    expect(line).toContain('Signed in on this computer')
    expect(identityLine(ok({ principal: 'p_1', kind: 'sso', signin: 'google', role: 'member', expires_at: null, person: null }))).toContain('Google')
  })
  it('never guesses "Member" when me() fails or is missing', () => {
    const failedMe = identityLine({ status: 'error', data: undefined, error: new ApiError(500, 'x', 'boom'), refreshing: false })
    expect(failedMe).toMatch(/unknown/i)
    expect(failedMe).not.toMatch(/Member|Admin/)
    expect(identityLine({ status: 'unsupported', data: undefined, error: new UnsupportedError(), refreshing: false })).toMatch(/unknown/i)
  })
})

describe('Member passwords (T-101)', () => {
  const shown = { email: 'ada@example.org', name: 'Ada', password: 'invented-pass-1', reason: 'added' as const }

  const withPassword = (pw: ShownPassword) => draw(readyWith({ people: [], invites: [], google_ready: false, member_passwords: true }), { invite: null, password: { ...pw, copied: false } })
  const person = (over: Partial<Person>): Person => ({ id: 'p_1', email: 'ada@example.org', name: 'Ada', role: 'member', invited_by: null, created_at: '', last_seen_at: null, disabled: false, ...over })

  it('1.2: shows the new password once, with the note that it will not be shown again', () => {
    const html = withPassword(shown)
    expect(html).toContain('invented-pass-1')
    expect(html).toContain('It will not be shown again')
    expect(html).toContain('ada@example.org')
    expect(html).toContain('Copy password')
  })

  it('says a reset ended the member’s earlier password sign-ins', () => {
    const html = withPassword({ ...shown, reason: 'reset', endedSessions: 2 })
    expect(html).toContain('New password for Ada')
    expect(html).toContain('earlier password sign-ins ended (2)')
  })

  it('a member row offers reset and remove; its sign-in line says hive password', () => {
    const html = draw(readyWith({ people: [person({ password_set: true })], invites: [], google_ready: false, member_passwords: true }))
    expect(html).toContain('Signs in with a hive password')
    expect(html).toContain('Reset password')
    expect(html).toContain('Remove password')
    const fresh = draw(readyWith({ people: [person({ id: 'p_2', name: 'Bo', email: 'bo@example.org' })], invites: [], google_ready: false, member_passwords: true }))
    expect(fresh).toContain('Make a password')
    expect(fresh).not.toContain('Remove password')
  })

  it('shownFrom keeps the password and the reset count from the one answer that carries them', () => {
    const r = { person: { id: 'p_1', email: 'ada@example.org', name: 'Ada', role: 'member' as const, invited_by: null, created_at: '', last_seen_at: null, disabled: false, password_set: true }, password: 'invented-pass-2', note: 'x', ended_sessions: 1 }
    expect(shownFrom(r, 'reset')).toEqual({ email: 'ada@example.org', name: 'Ada', password: 'invented-pass-2', reason: 'reset', endedSessions: 1 })
  })

  it('passwordAct: a "no" sends nothing', async () => {
    const call = vi.fn(async () => 'x')
    const onDone = vi.fn()
    expect(await passwordAct(call, { onDone, onFail: vi.fn(), question: { text: 'q', label: 'l' }, ask: async () => false })).toBe(false)
    expect(call).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('passwordAct: a sign-in change while the request is open shows nothing', async () => {
    let live = true
    const binding = { epoch: 1, current: () => live, commit: <R,>(w: () => R) => (live ? w() : STALE) }
    const onDone = vi.fn()
    const call = async () => {
      live = false   // another identity signed in before the answer came back
      return 'invented-pass-3'
    }
    expect(await passwordAct(call, { onDone, onFail: vi.fn(), binding })).toBe(false)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('passwordAct: a failure goes to onFail, never onDone', async () => {
    const onDone = vi.fn()
    const onFail = vi.fn()
    expect(await passwordAct(async () => Promise.reject(new ApiError(409, 'already_member', 'x')), { onDone, onFail })).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
    expect(onFail).toHaveBeenCalledOnce()
  })

  it('names a member password session without calling it the operator', () => {
    const line = identityLine({ status: 'ready', data: { principal: 'user:p_1', kind: 'member_password', role: 'member', expires_at: null, person: { id: 'p_1', email: 'ada@example.org', name: 'Ada' } }, error: undefined, refreshing: false })
    expect(line).toBe('ada@example.org · Signed in with a hive password · Member')
  })
})
