// Purpose: the stage's window (screens/arrange/arrange.ts stageWindow): below the stage's bar and above the Ask's dock,
// and beside the Ask's open thread wherever it opens (rising over the dock, pinned to a side, a phone's sheet), never
// under it; the whole window when the thread is elsewhere or leaves no room. INVENTED geometry.
import { describe, expect, it } from 'vitest'
import type { ScreenBox } from '../../scene/sceneStore'
import { stageWindow, type StageWindow } from './arrange'

const desk = { w: 1440, h: 900 }
const area = (r: StageWindow) => r.w * r.h
const overlaps = (r: StageWindow, t: ScreenBox) => r.x < t.right && t.left < r.x + r.w && r.y < t.bottom && t.top < r.y + r.h

describe('the stage window', () => {
  it('is the viewport below the bar and above the dock while no thread is open', () => {
    expect(stageWindow(desk, 40, 95, null)).toEqual({ x: 0, y: 40, w: 1440, h: 765 })
    expect(stageWindow(desk, 0, 0, null)).toEqual({ x: 0, y: 0, w: 1440, h: 900 })
  })

  it('keeps the window above a thread rising over the dock, where on v0.31 the thread covered the shown picture', () => {
    // a classic desktop: the bar 40 px, the dock's room 95 px, the thread 558 to 1117 across and 563 to 805 down
    expect(stageWindow(desk, 40, 95, { left: 558, top: 563, right: 1117, bottom: 805 })).toEqual({ x: 0, y: 40, w: 1440, h: 523 })
  })

  it('keeps the rest of the screen beside a thread pinned to a side', () => {
    expect(stageWindow(desk, 40, 95, { left: 1040, top: 0, right: 1440, bottom: 900 })).toEqual({ x: 0, y: 40, w: 1040, h: 765 })
    expect(stageWindow(desk, 40, 95, { left: 0, top: 0, right: 380, bottom: 900 })).toEqual({ x: 380, y: 40, w: 1060, h: 765 })
  })

  it('keeps the window above a phone’s sheet', () => {
    expect(stageWindow({ w: 390, h: 844 }, 40, 80, { left: 0, top: 420, right: 390, bottom: 764 })).toEqual({ x: 0, y: 40, w: 390, h: 380 })
  })

  it('is the whole window when the thread is outside it, or covers all of it', () => {
    const whole = { x: 0, y: 40, w: 1440, h: 765 }
    // in the dock's room only, or above the bar
    expect(stageWindow(desk, 40, 95, { left: 500, top: 810, right: 900, bottom: 890 })).toEqual(whole)
    expect(stageWindow(desk, 40, 95, { left: 500, top: 0, right: 900, bottom: 40 })).toEqual(whole)
    // a full-height sheet leaves no strip at all: nothing beats drawing in the whole window under it
    expect(stageWindow(desk, 40, 95, { left: -10, top: 0, right: 1500, bottom: 900 })).toEqual(whole)
  })

  it('over 5000 seeded threads: inside the whole window, clear of the thread when it leaves room, and the largest strip', () => {
    // mulberry32: the same 5000 cases on every run
    let seed = 20261115
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
    for (let i = 0; i < 5000; i++) {
      const view = { w: int(320, 2560), h: int(480, 1600) }
      const top = int(0, 80)
      const bottom = int(0, 200)
      const left = int(-100, view.w)
      const up = int(-100, view.h)
      const thread = { left, top: up, right: left + int(1, view.w), bottom: up + int(1, view.h) }
      const whole = { x: 0, y: top, w: view.w, h: Math.max(0, view.h - top - bottom) }
      const got = stageWindow(view, top, bottom, thread)
      const where = JSON.stringify({ view, top, bottom, thread, got })
      expect(got.x >= whole.x && got.y >= whole.y && got.x + got.w <= whole.x + whole.w && got.y + got.h <= whole.y + whole.h, where).toBe(true)
      // the four strips the thread leaves, each the whole window's width or height along one edge
      const l = Math.max(0, thread.left)
      const r = Math.min(view.w, thread.right)
      const t = Math.max(whole.y, thread.top)
      const b = Math.min(whole.y + whole.h, thread.bottom)
      const over = l < r && t < b
      const strips = over ? [t - whole.y, whole.y + whole.h - b].map((h) => h * whole.w).concat([l, view.w - r].map((w) => w * whole.h)) : []
      if (!over) expect(got, where).toEqual(whole)
      else if (Math.max(...strips) <= 0) expect(got, where).toEqual(whole)
      else {
        expect(overlaps(got, thread), where).toBe(false)
        expect(area(got), where).toBe(Math.max(...strips))
      }
    }
  })
})
