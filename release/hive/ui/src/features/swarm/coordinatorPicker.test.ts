import { describe, expect, it, vi } from 'vitest'
import { COORDINATOR_PICKER, focusCoordinatorPicker } from './coordinatorPicker'

/** ask-fix r2: "Set a coordinator for <swarm>" lands on the coordinator picker itself, once it is on screen. */
describe('focusCoordinatorPicker', () => {
  it('focuses the picker by its id, waiting for the settings to render', () => {
    vi.useFakeTimers()
    const el = { focus: vi.fn(), scrollIntoView: vi.fn() }
    let ready = false
    const doc = { getElementById: (id: string) => (ready && id === COORDINATOR_PICKER ? el : null) } as unknown as Document
    focusCoordinatorPicker(doc, 5, 100)
    expect(el.focus).not.toHaveBeenCalled()
    ready = true
    vi.advanceTimersByTime(100)
    expect(el.focus).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
