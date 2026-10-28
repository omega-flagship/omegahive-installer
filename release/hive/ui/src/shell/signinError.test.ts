import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SigninNotice } from './Ambient'
import { clearSigninError, readSigninError, signinErrorWords, UNKNOWN_SIGNIN_WORDS, withoutSigninError } from './signinError'

/** Surface: sign-in problems in plain words (pairs with Platform's sign-in hardening). Invented data only. */

const GOOGLE = 'https://hive.example.org/api/auth/google/login'
const html = (code: string | null, googleUrl?: string | null) => renderToStaticMarkup(createElement(SigninNotice, { code, googleUrl }))

const CODES: [string, string][] = [
  ['identity_mismatch', 'This Google account isn&#x27;t the one linked to that email. Ask an admin to check your account.'],
  ['domain_unverified', 'Please sign in with your SingularityNET Workspace account.'],
  ['state_mismatch', 'That sign-in started in another browser or took too long. Please try again.'],
  ['bad_id_token', 'Google&#x27;s answer couldn&#x27;t be verified. Please try again.'],
  ['google_signin_required', 'This account signs in with Google.'],
  ['google_unavailable', 'Google sign-in is unavailable right now. Try again shortly.'],
  ['signin_failed', 'Sign-in did not complete. Try again.'],
]

describe('signin_error words', () => {
  it.each(CODES)('%s shows its own words, not the code', (code, words) => {
    const out = html(code)
    expect(out).toContain(words)
    expect(out).toContain('role="alert"')
    expect(out).not.toContain(code)
  })

  it('google_signin_required shows the Google button from the hive login_url', () => {
    const out = html('google_signin_required', GOOGLE)
    expect(out).toContain(`href="${GOOGLE}"`)
    expect(out).toContain('Continue with Google')
  })

  it('no Google button for other codes, nor without a login_url', () => {
    for (const [code] of CODES.filter(([c]) => c !== 'google_signin_required')) expect(html(code, GOOGLE)).not.toContain('Continue with Google')
    expect(html('google_signin_required', null)).not.toContain('Continue with Google')
    expect(html('google_signin_required')).not.toContain('<a')
  })

  it('an unknown code shows the neutral words and never the code', () => {
    for (const code of ['totally_new_code', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(signinErrorWords(code)).toBe(UNKNOWN_SIGNIN_WORDS)
      const out = html(code)
      expect(out).toContain('Sign-in didn&#x27;t complete. Please try again.')
      expect(out).not.toContain(code)
    }
  })

  it('nothing from the address is rendered: markup, tokens and emails stay out', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const search = `?signin_error=${encodeURIComponent(hostile)}&id_token=eyJhbGciOi.secret.sig&email=victim%40example.org`
    const code = readSigninError({ search, hash: '' })
    expect(code).toBe(hostile)
    const out = html(code, GOOGLE)
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('eyJhbGciOi')
    expect(out).not.toContain('victim')
    expect(out).toContain('Sign-in didn&#x27;t complete. Please try again.')
  })

  it('no code, nothing shown', () => {
    expect(html(null)).toBe('')
    expect(signinErrorWords('')).toBeNull()
  })
})

describe('reading and clearing signin_error', () => {
  it('reads the code from the query, the hash, or the router hash', () => {
    expect(readSigninError({ search: '?signin_error=state_mismatch', hash: '' })).toBe('state_mismatch')
    expect(readSigninError({ search: '', hash: '#signin_error=bad_id_token' })).toBe('bad_id_token')
    expect(readSigninError({ search: '', hash: '#/?signin_error=identity_mismatch' })).toBe('identity_mismatch')
    expect(readSigninError({ search: '?invite=abc', hash: '#/people' })).toBeNull()
  })

  it.each(['google_unavailable', 'signin_failed'])('the host code %s is read from the query and the hash, with its own words', (code) => {
    for (const where of [{ search: `?signin_error=${code}`, hash: '#/' }, { search: '', hash: `#signin_error=${code}` }, { search: '', hash: `#/?signin_error=${code}` }]) {
      const read = readSigninError(where)
      expect(read).toBe(code)
      expect(signinErrorWords(read)).not.toBe(UNKNOWN_SIGNIN_WORDS)
      expect(withoutSigninError({ pathname: '/', ...where })).not.toContain('signin_error')
    }
  })

  it('the address without signin_error keeps everything else', () => {
    expect(withoutSigninError({ pathname: '/omegadot/', search: '?signin_error=x', hash: '' })).toBe('/omegadot/')
    expect(withoutSigninError({ pathname: '/', search: '?invite=abc&signin_error=x', hash: '#/people' })).toBe('/?invite=abc#/people')
    expect(withoutSigninError({ pathname: '/', search: '', hash: '#/?signin_error=x' })).toBe('/#/')
    expect(withoutSigninError({ pathname: '/', search: '', hash: '#signin_error=x&foo=1' })).toBe('/#foo=1')
    expect(withoutSigninError({ pathname: '/', search: '', hash: '#signin_error=x' })).toBe('/')
    expect(withoutSigninError({ pathname: '/', search: '?invite=abc', hash: '#/' })).toBeNull()
  })

  it('clears with history.replaceState (no reload, no new entry), and only when present', () => {
    const replaceState = vi.fn()
    clearSigninError({ location: { pathname: '/', search: '?signin_error=state_mismatch', hash: '#/' } as Location, history: { state: { k: 1 }, replaceState } as unknown as History })
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/#/')
    replaceState.mockClear()
    clearSigninError({ location: { pathname: '/', search: '', hash: '#/' } as Location, history: { state: null, replaceState } as unknown as History })
    expect(replaceState).not.toHaveBeenCalled()
  })
})
