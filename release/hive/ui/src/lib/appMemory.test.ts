import { describe, expect, it } from 'vitest'
import { MemoryOpenBudget, MemoryReasonTokens, memoryHostCurrent, memoryNotice, parseMemoryRequest, readMemorySession } from './appMemory'

const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

describe('P8 content-free app protocol', () => {
  it('accepts only a small topic and declared-name selector, with no person or data authority', () => {
    expect(parseMemoryRequest({ type: 'memory-open', channel: 'opaque-channel', id: 'r1', topic: '  gardening  ', theme: 'calm-dark' }))
      .toEqual({ ok: true, request: { id: 'r1', topic: 'gardening', theme: 'calm-dark' } })
    expect(parseMemoryRequest({ type: 'memory-open', id: 'r2' })).toEqual({ ok: true, request: { id: 'r2', topic: 'your memory' } })
  })

  it.each(['memory-read', 'memory-export', 'memory-fix', 'memory-forget', 'memory-screenshot'])('refuses the raw or mutating op %s', (type) => {
    expect(parseMemoryRequest({ type, id: 'r1' })).toEqual({ ok: false, id: 'r1', reason: 'unsupported' })
  })

  it.each([
    { owner: 'user:other' }, { principal: 'user:other' }, { belief_id: 'b_other' }, { text: 'not a read capability' },
    { theme: { accent: '#123456' } }, { theme: 'url(x)' }, { topic: 'x'.repeat(161) }, { topic: 'bad\u202etopic' },
    { token: 'opaque', topic: 'caller invented reason' }, { token: 'not/a/token' },
  ])('rejects extra authority, data and unsafe selectors: %j', (extra) => {
    expect(parseMemoryRequest({ type: 'memory-open', id: 'r1', ...extra })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('only constructs lifecycle notices; no memory result can be included', () => {
    for (const phase of ['opened', 'closed'] as const) {
      expect(memoryNotice(phase, 'r1')).toEqual({ type: `memory-${phase}`, id: 'r1' })
      expect(Object.keys(memoryNotice(phase, 'r1')).sort()).toEqual(['id', 'type'])
    }
    expect(parseMemoryRequest({ type: 'other', id: 'r1' })).toBeNull()
  })
})

describe('P8 local host session/document fence', () => {
  it('uses explicit server expiry seconds or explicit nonexpiry, never missing authority', () => {
    expect(readMemorySession({ principal: 'user:invented', expires_at: 1234 })).toEqual({ principal: 'user:invented', expiresAt: 1_234_000 })
    expect(readMemorySession({ principal: 'user:invented', expires_at: null })).toEqual({ principal: 'user:invented', expiresAt: null })
  })

  it.each([undefined, NaN, Infinity, -1, 0, '1234', Number.MAX_SAFE_INTEGER])('refuses missing or invalid expiry %s', (expires_at) => {
    expect(readMemorySession({ principal: 'user:invented', expires_at })).toBeNull()
  })

  it.each(['agent:a_x', 'service:s_x', 'user:', 'user:bad name', 'user:bad\nname'])('refuses non-person or malformed principal %s', (principal) => {
    expect(readMemorySession({ principal, expires_at: null })).toBeNull()
  })

  const admitted = () => ({ session: { principal: 'user:invented', expiresAt: 2000 }, owner: { principal: 'user:invented', hive: 'live@host' },
    hive: 'live@host', program: { enabled: true, digest: DIGEST }, releaseDigest: DIGEST, identityCurrent: true, documentCurrent: true, ready: true, now: 1000 })

  it('admits exactly the bound local session, memory owner, document and known release', () => {
    expect(memoryHostCurrent(admitted())).toBe(true)
    expect(memoryHostCurrent({ ...admitted(), session: { principal: 'user:invented', expiresAt: null }, now: 1e12 })).toBe(true)
    expect(memoryHostCurrent({ ...admitted(), now: 2000 })).toBe(false)
  })

  it.each([
    { session: null }, { owner: null }, { owner: { principal: 'user:other', hive: 'live@host' } },
    { owner: { principal: 'user:invented', hive: 'live@other-host' } }, { hive: 'live@other-host' },
    { program: undefined }, { program: null }, { program: { enabled: true } },
    { program: { enabled: false, digest: DIGEST } }, { program: { enabled: true, digest: OTHER_DIGEST } },
    { releaseDigest: undefined }, { releaseDigest: 'unverified' }, { identityCurrent: false }, { documentCurrent: false }, { ready: false }, { now: 2001 },
  ])('fails closed when one captured authority is missing or stale [%#]: %j', (changed) => {
    expect(memoryHostCurrent({ ...admitted(), ...changed })).toBe(false)
  })
})

describe('P8 per-app openings and opaque host reasons', () => {
  it('keeps the three-open budget across callers/mounts until the ten-minute window ends', () => {
    let now = 0
    const shared = new MemoryOpenBudget(() => now)
    const mount = () => () => shared.admit('person@app', false)
    expect([mount()(), mount()(), mount()(), mount()()]).toEqual([true, true, true, false])
    expect(shared.admit('person@other-app', false)).toBe(true)
    now = 599_999; expect(mount()()).toBe(false)
    now = 600_000; expect(mount()()).toBe(true)
  })

  it('only a host-supplied active-use exception permits a fourth recent opening', () => {
    const budget = new MemoryOpenBudget(() => 10)
    for (let i = 0; i < 3; i++) expect(budget.admit('person@app', false)).toBe(true)
    expect(budget.admit('person@app', false)).toBe(false)
    expect(budget.admit('person@app', true)).toBe(true)
    expect(budget.admit('person@app', false)).toBe(false)
    budget.clear(); expect(budget.admit('person@app', false)).toBe(true)
  })

  it('caps retained app buckets and reclaims expired ones', () => {
    let now = 0
    const budget = new MemoryOpenBudget(() => now)
    for (let i = 0; i < 128; i++) expect(budget.admit(`person@app${i}`, false)).toBe(true)
    expect(budget.admit('person@extra', true)).toBe(false)
    now = 600_000; expect(budget.admit('person@extra', false)).toBe(true)
  })

  it('keeps the topic host-only and binds every opaque token to app, swarm, digest and currentness', () => {
    let current = true
    const reasons = new MemoryReasonTokens()
    const token = reasons.issue('app', 'swarm', DIGEST, 'Invented private gardening note', () => current)
    expect(token).not.toContain('gardening')
    expect(reasons.resolve(token, 'app', 'swarm', DIGEST)).toBe('Invented private gardening note')
    expect(reasons.resolve(token, 'other-app', 'swarm', DIGEST)).toBeNull()
    expect(reasons.resolve(token, 'app', 'other-swarm', DIGEST)).toBeNull()
    expect(reasons.resolve(token, 'app', 'swarm', OTHER_DIGEST)).toBeNull()
    expect(reasons.resolve('unknown', 'app', 'swarm', DIGEST)).toBeNull()
    current = false; expect(reasons.resolve(token, 'app', 'swarm', DIGEST)).toBeNull()
    current = true; reasons.clear(); expect(reasons.resolve(token, 'app', 'swarm', DIGEST)).toBeNull()
  })
})
