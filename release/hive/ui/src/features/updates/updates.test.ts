import { describe, expect, it } from 'vitest'
import { checkHoldBody, HOLD_MAX_MS, holdBlocked, holdScopeWords, holdsFor, holdUntil, isIsoUtc, short } from './updates'

const h = (scope: string) => ({ id: scope, scope, reason: 'r', held_by: 'x', created_at: '', until: null })

describe('update holds', () => {
  it('a restart hold blocks only the platform; an app hold only that app; all blocks both', () => {
    const holds = [h('restart'), h('program:omegatruth')]
    expect(holdsFor(holds, 'platform').map((x) => x.scope)).toEqual(['restart'])
    expect(holdsFor(holds, 'program:omegatruth').map((x) => x.scope)).toEqual(['program:omegatruth'])
    expect(holdsFor(holds, 'program:atlas')).toEqual([])
    expect(holdsFor([h('all')], 'program:atlas')).toHaveLength(1)
  })
  it('shows a short build id', () => {
    expect(short('1520817abcdef')).toBe('1520817')
    expect(short(null)).toBe('unknown')
  })
  it('names what a hold stops', () => {
    expect(holdScopeWords('restart')).toBe('No platform restart')
    expect(holdScopeWords('program:ledger', () => 'Ledger')).toBe('No reload of Ledger')
    expect(holdScopeWords('all')).toMatch(/No updates at all/)
  })
})

describe('until is a real ISO date-time (finding d: the hive does not check it)', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  it('only the hive’s own UTC form counts as ISO', () => {
    expect(isIsoUtc('2026-10-05T18:30:00.000Z')).toBe(true)
    for (const bad of ['tomorrow', '2026-10-05', '2026-10-05T18:30Z', '2026-10-05T18:30:00Z', '2026-13-05T18:30:00.000Z', '2026-02-30T10:00:00.000Z', '2026-10-05T18:30:00.000+01:00', ''])
      expect(isIsoUtc(bad), bad).toBe(false)
  })
  it('a picked local time becomes the ISO time sent; empty means until released', () => {
    const r = holdUntil('2026-10-05T18:30', now)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(isIsoUtc(r.until!)).toBe(true)
      expect(Date.parse(r.until!)).toBe(new Date('2026-10-05T18:30').getTime())
    }
    expect(holdUntil('  ', now)).toEqual({ ok: true, until: undefined })
  })
  it('refuses words, impossible dates and the past', () => {
    expect(holdUntil('tomorrow', now).ok).toBe(false)
    expect(holdUntil('2026-02-30T10:00', now).ok).toBe(false)
    expect(holdUntil('2020-01-01T00:00', now)).toEqual({ ok: false, why: 'The end must be in the future.' })
  })
  it('needs a reason; the client refuses a malformed body before sending', () => {
    expect(holdBlocked('', { ok: true, until: undefined })).toMatch(/why/)
    expect(holdBlocked('x'.repeat(501), { ok: true, until: undefined })).toMatch(/500/)
    expect(holdBlocked('nightly run', { ok: false, why: 'nope' })).toBe('nope')
    expect(holdBlocked('nightly run', { ok: true, until: undefined })).toBeNull()
    expect(checkHoldBody({ scope: 'restart', reason: 'r', until: 'tomorrow' })).toMatch(/ISO/)
    // a real future time, relative to now (a fixed date here went stale at 18:30Z on 2026-10-05)
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    expect(checkHoldBody({ scope: 'restart', reason: 'r', until: soon })).toBeNull()
    expect(checkHoldBody({ scope: 'program:ledger', reason: ' ' })).toMatch(/reason/)
    expect(checkHoldBody({ scope: 'bogus' as 'all', reason: 'r' })).toMatch(/scope/)
  })
})

describe('next10 hold end: ISO with a timezone, in the future, at most 7 days ahead (updates.py _until at ad9e82c)', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')
  const local = (ms: number) => {
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  it('what is sent always carries a timezone (Z)', () => {
    const r = holdUntil(local(now + 3_600_000), now)
    expect(r.ok && r.until).toMatch(/Z$/)
  })
  it('exactly 7 days ahead is accepted (the host allows at <= now + 7 days); a minute more is refused in plain words', () => {
    expect(holdUntil(local(now + HOLD_MAX_MS), now).ok).toBe(true)
    const r = holdUntil(local(now + HOLD_MAX_MS + 60_000), now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toMatch(/at most 7 days from now/)
  })
  it('the client check before sending applies the same range', () => {
    expect(checkHoldBody({ scope: 'restart', reason: 'r', until: new Date(now + HOLD_MAX_MS).toISOString() }, now)).toBeNull()
    expect(checkHoldBody({ scope: 'restart', reason: 'r', until: new Date(now + HOLD_MAX_MS + 1).toISOString() }, now)).toMatch(/7 days/)
    expect(checkHoldBody({ scope: 'restart', reason: 'r', until: new Date(now - 1).toISOString() }, now)).toMatch(/future/)
    expect(checkHoldBody({ scope: 'restart', reason: 'r' }, now)).toBeNull()
  })
})
