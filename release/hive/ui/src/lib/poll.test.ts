import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVisiblePoll } from './poll'

function fakeDoc(hidden = false) {
  const listeners = new Set<() => void>()
  return {
    hidden,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    set(h: boolean) {
      this.hidden = h
      for (const fn of listeners) fn()
    },
    get listeners() {
      return listeners.size
    },
  }
}

describe('startVisiblePoll', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls while visible, pauses while hidden, and runs at once when shown again', () => {
    const doc = fakeDoc()
    const fn = vi.fn()
    const stop = startVisiblePoll(fn, 1000, doc as unknown as Document)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(3)
    doc.set(true)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(3)
    doc.set(false)
    expect(fn).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(4)
    expect(doc.listeners).toBe(0)
  })

  it('does not start while the page is hidden', () => {
    const doc = fakeDoc(true)
    const fn = vi.fn()
    startVisiblePoll(fn, 1000, doc as unknown as Document)
    vi.advanceTimersByTime(3000)
    expect(fn).not.toHaveBeenCalled()
  })
})
