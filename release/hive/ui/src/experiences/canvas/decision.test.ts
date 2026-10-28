import { describe, expect, it } from 'vitest'
import type { Approval } from '../sdk'
import { accepts, ARM_MS, askedAt, bind, bindingNote, canDecide, inspect } from './decision'

const ap = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap_1',
  agent_id: 'a1',
  skill: 'shell',
  command: '(shell-confirm "rm -rf /srv/scratch/build-cache")',
  reason: 'rule: shell commands that delete need a person',
  risk: 'high',
  status: 'pending',
  decided_by: null,
  created_at: '2026-10-04T10:00:00Z',
  decided_at: null,
  ...over,
})

describe('decision binding', () => {
  it('is ready only while the live request is pending and identical to what was inspected', () => {
    const seen = inspect(ap())
    expect(bind(seen, ap(), undefined)).toEqual({ kind: 'ready' })
    expect(canDecide(bind(seen, ap(), undefined))).toBe(true)
    expect(bindingNote(bind(seen, ap(), undefined))).toBeNull()
  })

  it('two requests sharing a visible prefix but differing in target are not interchangeable', () => {
    const a = ap({ id: 'ap_a', command: '(shell-confirm "rm -rf /srv/scratch/build-cache")' })
    const b = ap({ id: 'ap_b', command: '(shell-confirm "rm -rf /srv/scratch/build-cache /home/quinn")' })
    expect(b.command.startsWith(a.command.slice(0, 40))).toBe(true)
    const seenA = inspect(a)
    // the same id now carrying B's target: changed, buttons off
    const swapped = bind(seenA, { ...b, id: 'ap_a' }, undefined)
    expect(swapped).toEqual({ kind: 'changed', fields: ['command'] })
    expect(canDecide(swapped)).toBe(false)
    expect(bindingNote(swapped)).toMatch(/changed while it was open/)
    // and the inspection of A is never bound to B
    expect(inspect(b).id).not.toBe(seenA.id)
  })

  it('switches off when the request disappears', () => {
    const b = bind(inspect(ap()), undefined, undefined)
    expect(b).toEqual({ kind: 'gone' })
    expect(canDecide(b)).toBe(false)
    expect(bindingNote(b)).toMatch(/no longer on the hive/)
  })

  it('switches off when decided elsewhere, and says by whom', () => {
    for (const status of ['approved', 'denied', 'expired', 'used'] as const) {
      const b = bind(inspect(ap()), ap({ status, decided_by: 'user:operator' }), undefined)
      expect(b.kind).toBe('decided')
      expect(canDecide(b)).toBe(false)
      expect(bindingNote(b)).toContain(`already ${status} by user:operator elsewhere`)
    }
  })

  it('detects any change to what the person read (reason, risk, skill, requester, time)', () => {
    const seen = inspect(ap())
    expect(bind(seen, ap({ reason: 'human-only' }), undefined)).toEqual({ kind: 'changed', fields: ['reason'] })
    expect(bind(seen, ap({ risk: 'low' }), undefined)).toEqual({ kind: 'changed', fields: ['risk'] })
    expect(bind(seen, ap({ skill: 'fetch' }), undefined)).toEqual({ kind: 'changed', fields: ['skill'] })
    expect(bind(seen, ap({ agent_id: 'a2' }), undefined)).toEqual({ kind: 'changed', fields: ['agent_id'] })
    expect(bind(seen, ap({ created_at: '2026-10-04T10:00:01Z' }), undefined)).toEqual({ kind: 'changed', fields: ['created_at'] })
  })

  it('is off while an answer is in flight', () => {
    const b = bind(inspect(ap()), ap(), 'approve')
    expect(b).toEqual({ kind: 'deciding', d: 'approve' })
    expect(canDecide(b)).toBe(false)
  })

  it('the snapshot does not follow later mutation of the live object', () => {
    const live = ap()
    const seen = inspect(live)
    live.command = '(shell-confirm "rm -rf /")'
    expect(seen.command).toBe('(shell-confirm "rm -rf /srv/scratch/build-cache")')
    expect(bind(seen, live, undefined).kind).toBe('changed')
  })
})

describe('fresh activation', () => {
  it('rejects key repeat at any time', () => {
    expect(accepts({ repeat: true, at: 10_000 }, 0)).toBe(false)
  })
  it('rejects activations carried into a just-opened (or just re-armed) inspection', () => {
    expect(accepts({ at: 1000 }, 1000)).toBe(false)
    expect(accepts({ at: 1000 + ARM_MS - 1 }, 1000)).toBe(false)
    expect(accepts({ at: 1000 + ARM_MS }, 1000)).toBe(true)
  })
  it('a held Enter that approved request A cannot approve request B', () => {
    // A opened at t=0 and approved at t=600 by a fresh press; B opens at t=700 while the key is still down
    expect(accepts({ at: 600 }, 0)).toBe(true)
    const bOpened = 700
    // repeats of the held key, and the browser's click from any carried press, fall inside B's arming window
    for (const t of [716, 750, 800, 1000, 1149]) expect(accepts({ repeat: true, at: t }, bOpened)).toBe(false)
    expect(accepts({ at: 760 }, bOpened)).toBe(false)
    // only a new, deliberate press after B has been on screen counts
    expect(accepts({ at: bOpened + ARM_MS + 1 }, bOpened)).toBe(true)
  })
})

describe('asked at', () => {
  it('formats a full local timestamp and passes through junk', () => {
    expect(askedAt('2026-10-04T10:00:00Z')).toMatch(/^2026-10-0[45] \d\d:\d\d:00$/)
    expect(askedAt('not a date')).toBe('not a date')
  })
})
