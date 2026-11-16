import { describe, expect, it } from 'vitest'
import { POINTER_FINE, pointerFineStore } from './pointerFine'
import navSource from './Nav.tsx?raw'

/** Kimi K3 follow-up (9593fd1) P1-2: draggable only with a fine pointer, live; touch reorders through the menu. */
function stubMedia(initial: boolean) {
  const subs = new Set<() => void>()
  const q = {
    matches: initial,
    addEventListener: (_: string, cb: () => void) => subs.add(cb),
    removeEventListener: (_: string, cb: () => void) => subs.delete(cb),
  }
  const asked: string[] = []
  const mm = (s: string) => (asked.push(s), q as unknown as MediaQueryList)
  return { mm, asked, set: (v: boolean) => ((q.matches = v), subs.forEach((f) => f())), subs }
}

describe('P1-2: navigation entries are draggable only under (pointer: fine), kept live', () => {
  it('asks (pointer: fine) and follows its changes', () => {
    const m = stubMedia(true)
    const store = pointerFineStore(m.mm)
    expect(m.asked).toEqual([POINTER_FINE])
    expect(POINTER_FINE).toBe('(pointer: fine)')
    let seen = 0
    const off = store.subscribe(() => seen++)
    expect(store.get()).toBe(true)
    m.set(false) // a tablet undocked: touch only
    expect(store.get()).toBe(false)
    expect(seen).toBe(1)
    off()
    expect(m.subs.size).toBe(0)
  })
  it('no matchMedia (tests, old engines): not draggable', () => {
    expect(pointerFineStore(undefined).get()).toBe(false)
  })
  it('Nav makes entries draggable from that store, refuses a touch-started drag, and keeps Move up/down', () => {
    expect(navSource).toContain('draggable: fine,')
    expect(navSource).not.toContain('draggable: true')
    expect(navSource).toContain("if (!fine || lastPointer.current === 'touch')")
    expect(navSource).toContain("e.id === 'up' || e.id === 'down'")
  })
})
