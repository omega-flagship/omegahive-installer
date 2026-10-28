import { describe, expect, it } from 'vitest'
import { COMPANY_SEPARATE, REFUSAL_CODES, TRANSIENT_MS, canShowGreeting, cents, guestBand, helloView, limitLine, payerLine, refusalSentence, usd, type Who } from './honest'
import { readHello, readMonthlyLimit, type Hello, type MonthlyLimit } from './host'

const limit = (over: Partial<MonthlyLimit> = {}): MonthlyLimit => ({ done: true, enforced: true, enforced_by: 'own', limit_usd: 20, spent_usd: 0, chosen_usd: 20, host_name: null, pending_request: null, ...over })
const owner: Who = { path: 'owner', host: 'Pip Lanternfield', ownKeys: 1 }
const guest: Who = { path: 'guest', host: 'Hazel', ownKeys: 0 }
const member: Who = { path: 'member', host: 'Rowan', ownKeys: 0 }
const STOPS = /stops your minds|the hive stops/

const hello = (over: Partial<Hello> = {}): Hello => ({ mind: { id: 'a_m', name: 'Pip', status: 'awake' }, state: 'waiting', greeting: null, created: true, retryable: false, requested_at: '2026-10-13T10:00:00Z', ...over })

describe('limits: named as enforced only when the host says so, with what enforces it', () => {
  it('an enforced own limit says the amount, what enforces it, and that the hive stops minds there', () => {
    const line = limitLine(limit(), owner)
    expect(line).toBe('Your limit: $20 a month (your own limit on your keys); the hive stops your minds there.')
  })
  it('each enforcer is named in owner words', () => {
    expect(limitLine(limit({ enforced_by: 'invite', limit_usd: 5 }), guest)).toContain('the limit Hazel set on your invite')
    expect(limitLine(limit({ enforced_by: 'invite', limit_usd: 5 }), guest)).toContain('$5.00 a month')
    expect(limitLine(limit({ enforced_by: 'rule' }), member)).toContain('a limit set for you in this hive')
    expect(limitLine(limit({ enforced_by: 'member-default' }), member)).toContain('this hive’s usual limit')
  })
  it('a limit that is not enforced is never said to stop anything, even with an amount chosen', () => {
    for (const w of [owner, guest, member]) {
      const line = limitLine(limit({ enforced: false, enforced_by: null }), w)
      expect(line, w.path).not.toMatch(STOPS)
    }
    expect(limitLine(limit({ enforced: false, enforced_by: null, chosen_usd: 20 }), owner)).toBe('You chose $20 a month, but it isn’t a limit yet: nothing holds your minds to it.')
    expect(limitLine(null, owner)).toBe('No monthly limit is in force for you yet.')
  })
  it('the reader trusts only a literal enforced: true, and never names a limit without an amount', () => {
    const item = (enforced: unknown, detail: Record<string, unknown>) => ({ id: 'monthly_limit', done: true, enforced, detail })
    expect(readMonthlyLimit(item(false, { limit_usd: 20, enforced_by: 'own' }))!.enforced).toBe(false)
    expect(readMonthlyLimit(item('true', { limit_usd: 20, enforced_by: 'own' }))!.enforced).toBe(false)
    expect(readMonthlyLimit(item(true, { enforced_by: 'own' }))!.enforced).toBe(false)
    expect(readMonthlyLimit(item(true, { limit_usd: 20, enforced_by: 'own' }))).toMatchObject({ enforced: true, enforced_by: 'own', limit_usd: 20 })
    // the allowance shape (pre-H1 people): allowance_usd and allowance_origin
    expect(readMonthlyLimit(item(true, { allowance_usd: 10, enforced_by: 'member-default' }))).toMatchObject({ enforced: true, enforced_by: 'member-default', limit_usd: 10 })
    // enforced with no known enforcer: not named as enforced (the reader, and the lines on their own)
    expect(readMonthlyLimit(item(true, { limit_usd: 20 }))!.enforced).toBe(false)
    expect(readMonthlyLimit(item(true, { limit_usd: 20, enforced_by: 'someone' }))!.enforced).toBe(false)
    expect(limitLine(limit({ enforced_by: null }), owner)).not.toContain('stops')
    expect(guestBand(limit({ enforced_by: null, limit_usd: 5 }), 'Hazel')).not.toContain('stops')
    // not enforced: no enforcer is kept
    expect(readMonthlyLimit(item(false, { limit_usd: 20, enforced_by: 'own' }))!.enforced_by).toBeNull()
    // and the line read from it never says the hive stops minds
    expect(limitLine(readMonthlyLimit(item(false, { limit_usd: 20, enforced_by: 'own', chosen_usd: 20 })), owner)).not.toMatch(STOPS)
  })
  it('the model company’s own limit is said to be separate', () => {
    expect(COMPANY_SEPARATE).toMatch(/model company may have its own limits too; those are separate/)
  })
})

describe('who pays: every key, limit and guest screen names the payer', () => {
  it('a guest: the host’s key, never their own; the host’s key is never shown', () => {
    expect(payerLine(guest)).toBe('Hazel’s key pays, not yours. You never see Hazel’s key.')
  })
  it('an owner: their own key (or will, once they add one)', () => {
    expect(payerLine(owner)).toBe('Your own key pays: you pay the model company directly.')
    expect(payerLine({ ...owner, ownKeys: 0 })).toMatch(/^Your own key will pay, once you add one/)
  })
  it('anyone else: their own key if they have one, else the hive owner’s keys', () => {
    expect(payerLine(member)).toBe('Rowan’s keys pay for your minds here.')
    expect(payerLine({ ...member, ownKeys: 2 })).toMatch(/^Your own key pays/)
  })
})

describe('the guest band: whose hive, whose key and their limit', () => {
  it('says all three, to the cent, with what was used', () => {
    expect(guestBand(limit({ enforced_by: 'invite', limit_usd: 5, spent_usd: 0.02 }), 'Hazel')).toBe('Guest in Hazel’s hive. Runs on Hazel’s key, not yours. Your limit: $5.00 a month (used $0.02); the hive stops your minds there.')
  })
  it('with no limit in force, it says so (and never names one)', () => {
    const band = guestBand(limit({ enforced: false, enforced_by: null, limit_usd: 5 }), 'Hazel')
    expect(band).toMatch(/^Guest in Hazel’s hive\. Runs on Hazel’s key, not yours\./)
    expect(band).not.toMatch(STOPS)
    expect(band).not.toContain('$5.00')
  })
})

describe('the hello: no greeting while the mind can’t answer; Try again only when retryable', () => {
  it('shows the mind’s own words only once the host says it greeted', () => {
    const g = hello({ state: 'greeted', greeting: { id: 'm1', text: 'Hi Pip, I’m awake.', created_at: null } })
    expect(helloView(g, 1, 2, 'Pip')).toMatchObject({ phase: 'greeted', greeting: 'Hi Pip, I’m awake.' })
    expect(canShowGreeting(g)).toBe(true)
  })
  it('a waiting hello shows no greeting, even if words were somehow attached', () => {
    const odd = hello({ state: 'waiting', greeting: { id: 'm1', text: 'Hi', created_at: null } })
    expect(helloView(odd, 1, 2, 'Pip').greeting).toBeNull()
    expect(canShowGreeting(odd)).toBe(false)
    expect(canShowGreeting(null)).toBe(false)
  })
  it('the reader drops a greeting the host did not mark greeted', () => {
    const raw = { mind: { id: 'a_m', name: 'Pip', status: 'awake' }, state: 'waiting', greeting: { id: 'm1', text: 'Hi' }, retryable: false }
    expect(readHello(raw)!.greeting).toBeNull()
    expect(readHello({ ...raw, state: 'greeted', greeting: { id: 'm1', text: '   ' } })!.state).toBe('waiting')
  })
  it('Try again only when the host says retryable', () => {
    expect(helloView(hello({ retryable: false }), 1, 2, 'Pip').tryAgain).toBe(false)
    expect(helloView(hello({ retryable: true }), 1, 2, 'Pip').tryAgain).toBe(true)
    expect(helloView(null, 1, 2, 'Pip').tryAgain).toBe(false)
    expect(helloView(null, null, 2, 'Pip').tryAgain).toBe(false)
  })
  it('a GET that finds no hello just after our own Wake reads as still waking, then as lost', () => {
    expect(helloView(null, 1000, 1000 + TRANSIENT_MS - 1, 'Pip')).toMatchObject({ phase: 'still-waking', line: 'Still waking…', greeting: null })
    expect(helloView(null, 1000, 1000 + TRANSIENT_MS + 1, 'Pip')).toMatchObject({ phase: 'lost', greeting: null, tryAgain: false })
    expect(helloView(null, null, 5, 'Pip').phase).toBe('idle')
  })
})

describe('every refusal code has a plain sentence of its own', () => {
  it('the listed codes, each its own words (never the generic fallback)', () => {
    const generic = refusalSentence('something_else', { path: 'owner', host: 'Hazel' })
    const seen = new Set<string>()
    for (const code of REFUSAL_CODES) {
      for (const path of ['owner', 'guest'] as const) {
        const s = refusalSentence(code, { path, host: 'Hazel', limit: limit({ enforced_by: 'invite', limit_usd: 5 }) })
        expect(s, code).not.toBe(generic)
        expect(s, code).toMatch(/^[A-Z].*[.!]$/)
        expect(s, code).not.toMatch(/\b(dots?|teams?|goals?|boards?)\b/i)
        seen.add(s)
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(REFUSAL_CODES.length)
    expect(REFUSAL_CODES).toEqual(expect.arrayContaining(['no_key_grant', 'own_key_required', 'owner_only', 'owner_present', 'invite_unavailable', 'no_model', 'no_key', 'no_budget', 'spend_limit', 'hive_limit', 'cannot_wake']))
  })
  it('a guest at their limit hears whose hive and what to do', () => {
    expect(refusalSentence('spend_limit', { path: 'guest', host: 'Hazel', limit: limit({ enforced_by: 'invite', limit_usd: 5 }) })).toBe('You’ve reached your $5.00 limit in Hazel’s hive this month, so your mind can’t wake. Ask Hazel for more, or start your own hive later.')
  })
  it('an unknown code falls back to the host’s own message', () => {
    expect(refusalSentence('weird', { path: 'owner', host: 'x', fallback: 'The host says no.' })).toBe('The host says no.')
  })
})

describe('money', () => {
  it('whole amounts plain, the rest to the cent; a guest’s limit to the cent', () => {
    expect(usd(20)).toBe('$20')
    expect(usd(0.02)).toBe('$0.02')
    expect(usd(5.5)).toBe('$5.50')
    expect(cents(5)).toBe('$5.00')
  })
})
