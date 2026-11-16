import { describe, expect, it } from 'vitest'
import { baseRevisionOf } from '../contract'
import { canConfirm, digestOf, editGate, MIN_DWELL_MS, openGate, sameSource, staleAgainst, type Envelope } from './consent'
import { conceal, isRevealed, resealOnLeave, reveal, sealed } from './privacy'
import { inspectedSource, snapshotScope } from './requests'
import { sampleGraph } from './sample'
import { envelopeOf, type Draft } from './useAtlas'

/** A minimal event target: what window and document offer the reseal installer. */
function target(extra: { hidden?: boolean } = {}) {
  const fns = new Map<string, Set<() => void>>()
  return {
    hidden: extra.hidden ?? false,
    addEventListener: (t: string, f: () => void) => void (fns.get(t) ?? fns.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: () => void) => void fns.get(t)?.delete(f),
    fire: (t: string) => fns.get(t)?.forEach((f) => f()),
    count: () => [...fns.values()].reduce((n, s) => n + s.size, 0),
  }
}

describe('Review C1: values re-seal when the window loses focus, even if it stays visible', () => {
  it('window blur conceals unconditionally (document visible)', () => {
    const win = target()
    const doc = target({ hidden: false })
    let s = reveal(sealed(), '*', 1)
    resealOnLeave(win, doc, () => (s = conceal(s)))
    expect(isRevealed(s, 'x')).toBe(true)
    win.fire('blur')
    expect(isRevealed(s, 'x')).toBe(false)
  })

  it('visibilitychange conceals when hidden, not when it becomes visible', () => {
    const win = target()
    const doc = target({ hidden: false })
    let s = reveal(sealed(), '*', 1)
    resealOnLeave(win, doc, () => (s = conceal(s)))
    doc.fire('visibilitychange') // became visible: nothing to do
    expect(isRevealed(s, 'x')).toBe(true)
    doc.hidden = true
    doc.fire('visibilitychange')
    expect(isRevealed(s, 'x')).toBe(false)
  })

  it('uninstalls both listeners', () => {
    const win = target()
    const doc = target()
    const off = resealOnLeave(win, doc, () => undefined)
    expect(win.count() + doc.count()).toBe(2)
    off()
    expect(win.count() + doc.count()).toBe(0)
  })
})

describe('Review C2: a consent is bound to the inspected revision and snapshot closure', () => {
  const g = sampleGraph()
  const target = g.items.find((i) => i.kind === 'hypothesis')!.id
  const draft: Draft = { action: 'investigate', items: [target], worker: 'scientist-x', question: 'Does it hold up?', budget: 900, expiryMs: 3600_000, reason: '', viaKey: false, source: inspectedSource(g, 'investigate', [target]) }

  it('the source is the revision plus exactly the snapshot closure the dialog shows', () => {
    const src = inspectedSource(g, 'investigate', [target])
    expect(src.revision).toBe(g.revision)
    expect(new Set(src.scope)).toEqual(snapshotScope(g, [target]).ids)
    expect(inspectedSource(g, 'revoke-request', [target]).scope).toEqual([target])
  })

  it('the digest changes with the revision and with the closure; edits keep the source', () => {
    const env = envelopeOf(draft)
    const r2: Envelope = { ...env, source: { ...env.source!, revision: 'r2' } }
    const wider: Envelope = { ...env, source: { ...env.source!, scope: [...env.source!.scope, 'extra'] } }
    expect(digestOf(r2)).not.toBe(digestOf(env))
    expect(digestOf(wider)).not.toBe(digestOf(env))
    expect(digestOf({ ...env, source: { ...env.source!, scope: [...env.source!.scope].reverse() } })).toBe(digestOf(env))
    expect(envelopeOf({ ...draft, worker: 'other' }).source).toEqual(draft.source)
    // an envelope without a source keeps the digest the previous canonical form gave it (independent re-derivation)
    const { source: _omit, ...plain } = env
    void _omit
    const canon = JSON.stringify([plain.action, [...plain.items].sort(), Object.keys(plain.params).sort().map((k) => [k, plain.params[k]])])
    let h = 0x811c9dc5
    for (let i = 0; i < canon.length; i++) h = Math.imul(h ^ canon.charCodeAt(i), 0x01000193)
    expect(digestOf(plain)).toBe((h >>> 0).toString(16).padStart(8, '0'))
    expect(digestOf(plain)).not.toBe(digestOf(env))
  })

  it('a revision change or a closure change makes the open consent stale; the same source does not', () => {
    const gate = openGate(envelopeOf(draft), 0)
    expect(staleAgainst(gate, inspectedSource(g, 'investigate', [target]))).toBe(false)
    const g2 = { ...g, revision: 'review-r2' }
    expect(staleAgainst(gate, inspectedSource(g2, 'investigate', [target]))).toBe(true)
    // same revision label, but a new premise links into the target: the closure differs
    const g3 = { ...g, items: [...g.items, { id: 'new-premise', kind: 'observation', label: 'invented' }], links: [...g.links, { id: 'l-new', from: 'new-premise', to: target, rel: 'supports' }] } as typeof g
    expect(staleAgainst(gate, inspectedSource(g3, 'investigate', [target]))).toBe(true)
    expect(sameSource(undefined, undefined)).toBe(true)
  })

  it('draft edits still re-arm (new digest, dwell restarts) and keep the inspected source', () => {
    const g0 = openGate(envelopeOf(draft), 0)
    const g1 = editGate(g0, envelopeOf({ ...draft, question: 'A different question?' }), 5000)
    expect(g1.digest).not.toBe(g0.digest)
    expect(canConfirm(g1, { kind: 'pointer', digest: g1.digest }, 5000 + MIN_DWELL_MS - 1)).toBe('too-soon')
    expect(g1.envelope.source).toEqual(draft.source)
  })

  it('the host sends the inspected revision when a form gives one, else the session revision', () => {
    expect(baseRevisionOf({ baseRevision: 'review-r1' }, 'review-r2')).toBe('review-r1')
    expect(baseRevisionOf({ baseRevision: null }, 'review-r2')).toBeNull()
    expect(baseRevisionOf(undefined, 'review-r2')).toBe('review-r2')
    expect(baseRevisionOf({}, undefined)).toBeNull()
  })
})
