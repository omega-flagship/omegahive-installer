import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError, type Me } from '../../api/client'
import { identityLine } from '../../lib/identity'
import { UnsupportedError, type ResourceState } from '../../lib/useResource'
import { PeopleState } from './PeoplePage'

type Data = Parameters<typeof PeopleState>[0]['res']['data']

const render = (res: ResourceState<NonNullable<Data>>) =>
  renderToStaticMarkup(createElement(PeopleState, { res: { ...res, reload: () => undefined }, children: (d) => createElement('p', null, `people:${d.people.length}`) }))
const failed = (error: unknown): ResourceState<NonNullable<Data>> => ({ status: 'error', data: undefined, error, refreshing: false })

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
    expect(render({ status: 'ready', data: { people: [], invites: [], google_ready: true }, error: undefined, refreshing: false })).toContain('people:0')
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
