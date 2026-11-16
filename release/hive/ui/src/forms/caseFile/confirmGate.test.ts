import { describe, expect, it } from 'vitest'
import { ARM_MS, finished, opened, released, requestKey, tryConfirm } from './confirmGate'

const req = { action: 'ask-scientist', items: ['c1'], revision: 'r7' }

describe('full-context confirm', () => {
  it('needs fresh activation: nothing confirms while it is arming', () => {
    const s = opened(req, 1000, false)
    const early = tryConfirm(s, req, { kind: 'pointer', at: 1000 + ARM_MS - 1 })
    expect(early).toMatchObject({ ok: false, why: 'arming' })
    expect(tryConfirm(s, req, { kind: 'pointer', at: 1000 + ARM_MS }).ok).toBe(true)
  })

  it('refuses key auto-repeat, always', () => {
    const s = opened(req, 0, false)
    expect(tryConfirm(s, req, { kind: 'key', key: 'Enter', repeat: true, at: 10_000 })).toMatchObject({ ok: false, why: 'repeat', words: null })
  })

  it('opened from the keyboard: that key must be released before a key can confirm', () => {
    let s = opened(req, 0, true)
    expect(tryConfirm(s, req, { kind: 'key', key: 'Enter', repeat: false, at: 5000 })).toMatchObject({ ok: false, why: 'held' })
    // a pointer is not a held key
    expect(tryConfirm(s, req, { kind: 'pointer', at: 5000 }).ok).toBe(true)
    s = released(s)
    expect(tryConfirm(s, req, { kind: 'key', key: 'Enter', repeat: false, at: 5000 }).ok).toBe(true)
  })

  it('is bound to the request on screen: a different item or revision is stale', () => {
    const s = opened(req, 0, false)
    expect(tryConfirm(s, { ...req, revision: 'r8' }, { kind: 'pointer', at: 5000 })).toMatchObject({ ok: false, why: 'stale' })
    expect(tryConfirm(s, { ...req, items: ['c2'] }, { kind: 'pointer', at: 5000 })).toMatchObject({ ok: false, why: 'stale' })
    expect(requestKey(req)).not.toBe(requestKey({ ...req, action: 'ask-challenger' }))
  })

  it('one confirm in flight: a second press is refused until the first settles', () => {
    const s = opened(req, 0, false)
    const first = tryConfirm(s, req, { kind: 'pointer', at: 5000 })
    if (!first.ok) throw new Error('first confirm refused')
    expect(tryConfirm(first.next, req, { kind: 'pointer', at: 5100 })).toMatchObject({ ok: false, why: 'busy' })
    expect(tryConfirm(finished(first.next, req), req, { kind: 'pointer', at: 5200 }).ok).toBe(true)
  })

  it('a keyboard confirm leaves the key held, so holding Enter cannot confirm twice', () => {
    const s = opened(req, 0, false)
    const k = tryConfirm(s, req, { kind: 'key', key: 'Enter', repeat: false, at: 5000 })
    if (!k.ok) throw new Error('refused')
    const after = finished(k.next, req)
    expect(tryConfirm(after, req, { kind: 'key', key: 'Enter', repeat: false, at: 6000 })).toMatchObject({ ok: false, why: 'held' })
  })
})
