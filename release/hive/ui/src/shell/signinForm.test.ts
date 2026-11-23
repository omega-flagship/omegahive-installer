import { describe, expect, it } from 'vitest'
import { signinForm, signinWays, signinWho, type SigninWays } from './signinForm'

/** The sign-in form's two ways in: a member reads only their own, the operator's is one small link away. */

const words = (f: ReturnType<typeof signinForm>) => [f.label, f.heading, f.line, f.passwordPlaceholder].join(' ')
const ways = (over: Partial<SigninWays> = {}): SigninWays => ({ google: null, members: true, operator: true, ...over })
const GOOGLE = '/omegahive/api/auth/google/start'
const methods = (over: Partial<Parameters<typeof signinWays>[0]> = {}) => ({
  password: false,
  public: true,
  member_password: false,
  sso: { enabled: true, provider: 'google', login_url: GOOGLE },
  ...over,
})

describe('sign-in form on a hive that takes member passwords', () => {
  it('opens on the member’s way in: email and password, and no word of the operator’s', () => {
    const f = signinForm(ways(), false)
    expect(f.email).toBe(true)
    expect(f.line).toBe('Sign in with your email and the password an admin gave you.')
    expect(words(f)).not.toMatch(/operator|hive password|no email/i)
  })

  it('keeps the operator’s way in behind one small link', () => {
    expect(signinForm(ways(), false).other).toBe('Run this hive? Sign in with the hive password')
  })

  it('the link opens the operator’s form: the hive password, no email field, and a link back', () => {
    const f = signinForm(ways(), true)
    expect(f.email).toBe(false)
    expect(f.label).toBe('Operator login')
    expect(f.line).toBe('Enter the hive password to wake the interface.')
    expect(f.passwordPlaceholder).toBe('Hive password')
    expect(f.other).toBe('Sign in with your email instead')
  })
})

describe('sign-in form on a hive without member passwords', () => {
  it('is the operator’s form, with no link to a way in the hive does not have', () => {
    for (const operator of [false, true]) {
      const f = signinForm(ways({ members: false }), operator)
      expect(f).toEqual({ ...signinForm(ways(), true), other: null })
    }
  })
})

describe('sign-in form from outside, where the operator’s password never counts', () => {
  it('beside Google, the member form reads as the other way in, with no link to the operator’s form', () => {
    const f = signinForm(ways({ google: GOOGLE, operator: false }), false)
    expect(f.email).toBe(true)
    expect(f.line).toBe('Or sign in with the email and password an admin gave you.')
    expect(f.other).toBeNull()
  })

  it('stays on the member form even after the operator’s link was followed', () => {
    expect(signinForm(ways({ operator: false }), true).email).toBe(true)
  })
})

describe('the ways in a hive’s sign-in methods give', () => {
  it('from outside: Google when it is on, member passwords as reported, never the operator’s password', () => {
    expect(signinWays(methods({ member_password: true }))).toEqual({ google: GOOGLE, members: true, operator: false })
    // an older hive reported password true from outside with HIVE_PUBLIC_PASSWORD=1; its session never counted there
    expect(signinWays(methods({ password: true })).operator).toBe(false)
  })

  it('without Google, nothing to continue with', () => {
    const off = methods({ member_password: true, sso: { enabled: false, provider: 'google', login_url: null } })
    expect(signinWays(off)).toEqual({ google: null, members: true, operator: false })
  })

  it('on the hive’s own machine: the password form alone, as before, with the operator’s way in', () => {
    expect(signinWays(methods({ public: false, password: true, member_password: true }))).toEqual({
      google: null,
      members: true,
      operator: true,
    })
  })
})

/** acceptance-tests #15: the card says who Google lets in, and how anyone else gets an invitation. */
describe('who may sign in (signinWho)', () => {
  const sso = (over: { domains?: string[]; open?: boolean } = {}) => ({ enabled: true, login_url: GOOGLE, ...over })
  const ASK = 'Anyone else needs an invitation: ask one of this hive’s admins to invite your email.'

  it('one listed domain: names it, then says how anyone else gets in', () => {
    expect(signinWho(sso({ domains: ['singularitynet.io'], open: false }))).toEqual({
      line: `Anyone with a singularitynet.io Google account can sign in. ${ASK}`,
      inviteOnly: false,
    })
  })

  it('several domains: names each', () => {
    expect(signinWho(sso({ domains: ['a.io', 'b.org', 'c.net'], open: false }))?.line).toBe(
      `Anyone with a Google account at a.io, b.org or c.net can sign in. ${ASK}`,
    )
    expect(signinWho(sso({ domains: ['a.io', 'b.org'], open: false }))?.line).toMatch(/^Anyone with a Google account at a\.io or b\.org can/)
  })

  it('a public hive: any Google account, no invitation needed', () => {
    expect(signinWho(sso({ domains: ['singularitynet.io'], open: true }))).toEqual({
      line: 'Any Google account can sign in.',
      inviteOnly: false,
    })
  })

  it('no domains and not public: invite only, and whom to ask', () => {
    expect(signinWho(sso({ domains: [], open: false }))).toEqual({
      line: 'This hive is invite only: ask one of its admins to invite your email.',
      inviteOnly: true,
    })
  })

  it('an older hive that does not say, or no Google: nothing, the card stays as it was', () => {
    expect(signinWho(sso())).toBeNull()
    expect(signinWho(sso({ open: false }))).toBeNull()
    expect(signinWho({ enabled: false, login_url: null, domains: ['a.io'], open: true })).toBeNull()
    expect(signinWho({ enabled: true, login_url: null, domains: ['a.io'], open: false })).toBeNull()
  })
})
