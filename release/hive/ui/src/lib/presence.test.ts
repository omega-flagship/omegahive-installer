import { describe, expect, it } from 'vitest'
import { checkAskEvent, checkInk, PRESENCE_CAPTION_MAX, validTarget } from '../api/ask'
import { NAV_FEATURE, onScreen, resolvePresence, selectorsFor, type PresenceEl, type PresenceRoot } from './presence'
import { FEATURES } from '../features/registry'
import { NAV_ITEMS } from '../shell/navItems'

/** Presence (Jon, 2026-10-05): the pure resolver and the host's checks mirrored on the client. */
const vp = { width: 1000, height: 800 }
const el = (left: number, top: number, w: number, h: number, inert = false): PresenceEl => ({
  getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h }),
  closest: (sel: string) => (inert && sel.includes('inert') ? {} : null),
})
function root(map: Record<string, PresenceEl[]>): PresenceRoot & { asked: string[] } {
  const asked: string[] = []
  return { asked, querySelectorAll: (s: string) => (asked.push(s), map[s] ?? []) }
}

describe('resolvePresence', () => {
  it('finds the on-screen elements for an entity, then a feature, then a region, with their union box', () => {
    const r = root({ '[data-presence-ref="mind:a_vega01"]': [el(10, 10, 100, 20), el(10, 200, 50, 20)] })
    const out = resolvePresence({ entity: { kind: 'mind', ref: 'a_vega01' }, feature: 'minds.see' }, r, vp)
    expect(out).toMatchObject({ kind: 'found', box: { left: 10, top: 10, right: 110, bottom: 220 } })
  })
  it('falls back from entity to feature when the entity is not on screen', () => {
    const r = root({ '[data-presence-ref="goal:g1"]': [el(10, 900, 10, 10)], '[data-presence-feature="work.goals"]': [el(5, 5, 40, 40)] })
    expect(resolvePresence({ entity: { kind: 'goal', ref: 'g1' }, feature: 'work.goals' }, r, vp).kind).toBe('found')
  })
  it('a target that is not on screen is "not on screen": off the viewport, zero-sized, or inert under a modal', () => {
    const r = root({ '[data-presence-feature="money.usage"]': [el(-200, 10, 100, 20), el(10, 10, 0, 0), el(10, 10, 50, 50, true)] })
    expect(resolvePresence({ feature: 'money.usage' }, r, vp)).toEqual({ kind: 'not-on-screen' })
  })
  it('never searches beyond the document as it is: only the attribute selectors are queried, and unsafe values give none', () => {
    const r = root({})
    resolvePresence({ entity: { kind: 'mind', ref: 'a"],*,[x="' }, region: 'page' }, r, vp)
    expect(r.asked).toEqual(['[data-presence-region="page"]'])
    expect(selectorsFor({ feature: 'x"];alert(1)' })).toEqual([])
  })
  it('onScreen: partly visible counts', () => {
    expect(onScreen(el(990, 790, 40, 40), vp)).toBe(true)
  })
  it('every classic nav item names a real feature for its data-presence-feature', () => {
    for (const it of NAV_ITEMS) expect(FEATURES.some((f) => f.id === NAV_FEATURE[it.key]), it.key).toBe(true)
  })
})

describe('presence frames: the host’s checks mirrored (defence in depth)', () => {
  const base = { type: 'ask', operation_id: 'ask:op:12345678', turn_id: 't', seq: 2, phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' } }
  it('the closed verb set, plain-text captions of at most 120 characters, valid targets only', () => {
    expect(checkAskEvent({ ...base, verb: 'point', target: { feature: 'work.goals' }, caption: 'Goals live here' })).not.toBeNull()
    expect(checkAskEvent({ ...base, verb: 'teleport', target: { feature: 'work.goals' }, caption: 'x' })).toBeNull()
    expect(checkAskEvent({ ...base, verb: 'point', target: { feature: 'work.goals' }, caption: 'x'.repeat(PRESENCE_CAPTION_MAX + 1) })).toBeNull()
    expect(checkAskEvent({ ...base, verb: 'point', target: { feature: 'work.goals' }, caption: '<b>bold</b>' })).toBeNull()
    expect(checkAskEvent({ ...base, verb: 'point', target: { url: 'https://x' }, caption: 'x' })).toBeNull()
    expect(validTarget({ entity: { kind: 'mind', ref: 'a b' } })).toBe(false)
  })
  it('sketch ink: the closed shape set, at most 64 points, clamped to 0..1, anything malformed dropped', () => {
    expect(checkInk({ shape: 'circle' })).toEqual({ shape: 'circle' })
    expect(checkInk({ shape: 'path', points: [[-1, 0.5], [2, 3]] })).toEqual({ shape: 'path', points: [[0, 0.5], [1, 1]] })
    expect(checkInk({ shape: 'spiral' })).toBeNull()
    expect(checkInk({ shape: 'path', points: Array.from({ length: 65 }, () => [0, 0]) })).toBeNull()
    expect(checkInk({ shape: 'path', points: [[0, Number.NaN], [1, 1]] })).toBeNull()
    expect(checkInk({ shape: 'circle', colour: 'red' })).toBeNull()
    expect(checkAskEvent({ ...base, verb: 'sketch', target: { feature: 'work.goals' }, ink: { shape: 'underline' } })).not.toBeNull()
    expect(checkAskEvent({ ...base, verb: 'point', target: { feature: 'work.goals' }, caption: 'x', ink: { shape: 'circle' } })).toBeNull()
  })
})
