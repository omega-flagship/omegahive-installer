// Radio groups (stand-in P2-4 on 61936cb): pure helpers, no store, so any renderer can use them.

/** The value an arrow, Home or End key moves a radio group to (wrapping), or null for any other key. */
export function nextRadio<T>(key: string, values: readonly T[], current: T): T | null {
  const i = Math.max(0, values.indexOf(current))
  if (key === 'ArrowRight' || key === 'ArrowDown') return values[(i + 1) % values.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return values[(i - 1 + values.length) % values.length]
  if (key === 'Home') return values[0]
  if (key === 'End') return values[values.length - 1]
  return null
}

/**
 * Props for one radio in a group (WAI-ARIA radio group): only the checked one is a tab stop (the first when none is),
 * and the arrow keys, Home and End move to the next. `choose` runs the same path a click does. In 'select' mode (a view
 * or a form draft) the arrows also choose; in 'focus' mode (a choice the hive acts on: status, who can see it) they only
 * move focus, and Space or Enter chooses, so nothing changes on the hive by moving through the options.
 */
export function radioProps<T>(value: T, values: readonly T[], current: T | undefined, choose: (v: T) => void, mode: 'select' | 'focus' = 'select') {
  const checked = value === current
  const stop = current === undefined || !values.includes(current) ? value === values[0] : checked
  return {
    role: 'radio' as const,
    'aria-checked': checked,
    tabIndex: stop ? 0 : -1,
    'data-radio-value': String(value),
    onKeyDown: (e: { key: string; preventDefault(): void; currentTarget: { parentElement: { querySelector(sel: string): { focus(): void } | null } | null } }) => {
      const to = nextRadio(e.key, values, value)
      if (to === null) return
      e.preventDefault()
      if (mode === 'select') choose(to)
      e.currentTarget.parentElement?.querySelector(`[data-radio-value="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(to)) : String(to)}"]`)?.focus()
    },
  }
}
