import { describe, expect, it, vi } from 'vitest'
import { isMenuChoice, LONG_PRESS_MS, LONG_PRESS_SLOP, longPress } from './longPress'
import navSource from './Nav.tsx?raw'
import menuSource from './NavMenu.tsx?raw'

// vitest hands CSS imports back empty: read the file itself (as ui/overlays.test.ts does)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const cssSource = fs.readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** Kimi K3 follow-up on the classic nav (9593fd1): P1-1 long-press vs scrolling, P2-6 the menu's 450 ms guard. */
const fake = () => {
  vi.useFakeTimers()
  return { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) }
}

describe('P1-1: a long-press never fires while the finger scrolls', () => {
  it('a resting finger (within the slop) opens the menu after the delay', () => {
    const lp = longPress(fake())
    const fire = vi.fn()
    lp.down(100, 100, fire)
    lp.move(103, 104) // 5px: still a press
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fire).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('a finger that drifts past the slop is a scroll: no menu', () => {
    const lp = longPress(fake())
    const fire = vi.fn()
    lp.down(100, 100, fire)
    lp.move(100, 100 + LONG_PRESS_SLOP + 1)
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(fire).not.toHaveBeenCalled()
    expect(lp.pending()).toBe(false)
    vi.useRealTimers()
  })
  it('a scroll (or pointercancel / lift / leave) cancels the press', () => {
    const lp = longPress(fake())
    const fire = vi.fn()
    lp.down(10, 10, fire)
    lp.cancel()
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(fire).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('Nav wires pointermove, cancel and a capture-phase scroll listener to the press; no system callout on entries', () => {
    expect(navSource).toContain('onPointerMove: (e: PointerEvent<HTMLElement>) => press.move(e.clientX, e.clientY)')
    expect(navSource).toContain("onPointerCancel: () => press.cancel()")
    expect(navSource).toMatch(/addEventListener\('scroll', off, \{ capture: true, passive: true \}\)/)
    expect(navSource).not.toMatch(/setTimeout\(\(\) => \{\s*pressed\.current = true/)
    expect(cssSource).toContain("[data-nav-key][aria-haspopup='menu'] { -webkit-touch-callout: none; }")
  })
})

describe('P2-6: the menu has no timing dead end, and a fired press leaves nothing stale', () => {
  it('the long-pressing finger lifting over the menu is never a choice, however late its click lands', () => {
    expect(isMenuChoice(1, false)).toBe(false)
  })
  it('a real tap on an item (a pointer went down in the menu) always is, even within 450 ms', () => {
    expect(isMenuChoice(1, true)).toBe(true)
  })
  it('keyboard activation (detail 0) always is', () => {
    expect(isMenuChoice(0, false)).toBe(true)
  })
  it('NavMenu uses the rule, with no 450 ms window', () => {
    expect(menuSource).toContain('isMenuChoice(e.detail, pressedInside.current)')
    expect(menuSource).toContain('onPointerDown={() => (pressedInside.current = true)}')
    expect(menuSource).not.toMatch(/openedAt|< 450/)
  })
  it('after the press fires nothing is pending, so the next press never clears a stale timer', () => {
    const lp = longPress(fake())
    lp.down(0, 0, () => undefined)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(lp.pending()).toBe(false)
    const fire = vi.fn()
    lp.down(0, 0, fire)
    expect(lp.pending()).toBe(true)
    lp.cancel()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fire).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
