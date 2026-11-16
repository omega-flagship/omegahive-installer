import { create } from 'zustand'
import { readRestPrefs, writeRestPrefs } from './rest'
import { usePower } from './store'

/**
 * The power entries every menu shows next to "Stop all minds" (the classic Hive menu, and Ω in every experience):
 * Wake all and Turn the hive off for admins (never while the hive is off), and Quiet's idle setting for everyone.
 *
 * A plain function, read when the menu renders (each menu renders its items as it opens), so a menu that shows them
 * adds one line and no hook: `...powerMenuItems()`.
 */
export interface PowerItem {
  id: 'wake-all' | 'power-off' | 'rest'
  label: string
  run: () => void
  /** Turn the hive off is the destructive one. */
  danger?: boolean
}

export function powerMenuItems(): PowerItem[] {
  const { admin, gate } = usePower.getState()
  const rest: PowerItem = { id: 'rest', label: `${restChoiceLabel(useRestPrefs.getState().minutes)}…`, run: () => usePower.getState().openDialog('rest') }
  if (admin !== true || gate === 'off') return [rest]
  return [
    { id: 'wake-all', label: 'Wake all minds…', run: () => usePower.getState().openDialog('wake') },
    { id: 'power-off', label: 'Turn the hive off…', run: () => usePower.getState().openDialog('off'), danger: true },
    rest,
  ]
}

/** Quiet's one setting, per person on this browser: minutes without input before resting (0 = never). */
export const useRestPrefs = create<{ minutes: number; setMinutes(n: number): void }>()((set) => ({
  minutes: readRestPrefs().minutes,
  setMinutes(minutes) {
    writeRestPrefs({ minutes })
    set({ minutes })
  },
}))

export const restChoiceLabel = (n: number) => (n === 0 ? 'Never rest' : `Rest after ${n} minute${n === 1 ? '' : 's'} idle`)
