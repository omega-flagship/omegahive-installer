/**
 * The touch long-press that opens a navigation entry's menu (Nav.tsx menuProps), and the rule for which clicks on that
 * menu are choices (NavMenu). Pure (timers are passed in), so both are tested in node (longPress.test.ts).
 */

/** How long a finger rests on an entry before its menu opens. */
export const LONG_PRESS_MS = 550
/** How far (px) a resting finger may drift and still be a press; further is a scroll or a drag, never a press. */
export const LONG_PRESS_SLOP = 10

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

export interface LongPress {
  /** A finger went down at (x, y): `fire` runs if it stays within the slop for LONG_PRESS_MS. */
  down(x: number, y: number, fire: () => void): void
  /** The finger moved: past the slop it is a scroll or a drag, and the press is off. */
  move(x: number, y: number): void
  /** Lifted, cancelled, left the entry, or anything scrolled: the press is off. */
  cancel(): void
  /** A press is waiting to fire. */
  pending(): boolean
}

export function longPress(timers: Timers = realTimers, ms = LONG_PRESS_MS, slop = LONG_PRESS_SLOP): LongPress {
  let id: unknown
  let at = { x: 0, y: 0 }
  const cancel = () => {
    if (id !== undefined) timers.clear(id)
    id = undefined
  }
  return {
    down(x, y, fire) {
      cancel()
      at = { x, y }
      id = timers.set(() => {
        // fired: nothing is pending any more, so the next press never clears a stale timer
        id = undefined
        fire()
      }, ms)
    },
    move(x, y) {
      if (id !== undefined && Math.hypot(x - at.x, y - at.y) > slop) cancel()
    },
    cancel,
    pending: () => id !== undefined,
  }
}

/**
 * Whether a click on a menu item is the person's choice. Keyboard activation (detail 0) always is. A pointer click is
 * only when a pointer went down inside the menu after it opened: the finger that long-pressed the entry lifting over
 * the menu is not a choice, however late its click arrives, and every real tap on an item is one (no timing window).
 */
export const isMenuChoice = (detail: number, pressedInside: boolean): boolean => detail === 0 || pressedInside
