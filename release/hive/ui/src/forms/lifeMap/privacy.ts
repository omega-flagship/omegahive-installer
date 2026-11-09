/**
 * Values are sealed by default. A person reveals on intent (press a value, or hold "Reveal"); everything re-seals
 * after a quiet interval, when the window loses focus or the page is hidden, or on demand. Pure state; the hook drives the clock.
 */
export interface RevealState {
  all: boolean
  ids: ReadonlySet<string>
  lastActivity: number
  idleMs: number
}

export const DEFAULT_IDLE_MS = 12_000

export const sealed = (idleMs = DEFAULT_IDLE_MS): RevealState => ({ all: false, ids: new Set(), lastActivity: 0, idleMs })

/** Reveal one value, or every value in view with '*'. Intent also counts as activity. */
export function reveal(s: RevealState, id: string | '*', now: number): RevealState {
  if (id === '*') return { ...s, all: true, lastActivity: now }
  const ids = new Set(s.ids)
  ids.add(id)
  return { ...s, ids, lastActivity: now }
}

export function conceal(s: RevealState, id?: string): RevealState {
  if (id == null) return { ...s, all: false, ids: new Set() }
  if (!s.ids.has(id)) return s
  const ids = new Set(s.ids)
  ids.delete(id)
  return { ...s, ids }
}

export const anyRevealed = (s: RevealState) => s.all || s.ids.size > 0

/** Pointer, key or scroll activity while something is revealed keeps it open; when sealed it changes nothing. */
export const touch = (s: RevealState, now: number): RevealState => (anyRevealed(s) ? { ...s, lastActivity: now } : s)

/** Re-seal once the idle interval has passed. */
export function tick(s: RevealState, now: number): RevealState {
  if (!anyRevealed(s)) return s
  return now - s.lastActivity >= s.idleMs ? conceal(s) : s
}

export const isRevealed = (s: RevealState, id: string) => s.all || s.ids.has(id)

/** Seconds until everything re-seals (null when sealed). */
export const remaining = (s: RevealState, now: number): number | null => (anyRevealed(s) ? Math.max(0, Math.ceil((s.idleMs - (now - s.lastActivity)) / 1000)) : null)

type Listens = { addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void }

/**
 * Review C1: what re-seals revealed values besides idle. Losing window focus conceals UNCONDITIONALLY (a window can
 * lose focus and stay visible: another window on top, a screen share, a person walking away); the page becoming hidden
 * conceals too. Returns the uninstaller.
 */
export function resealOnLeave(win: Listens, doc: Listens & { readonly hidden: boolean }, conceal: () => void): () => void {
  const onBlur = () => conceal()
  const onVisibility = () => {
    if (doc.hidden) conceal()
  }
  win.addEventListener('blur', onBlur)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    win.removeEventListener('blur', onBlur)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
