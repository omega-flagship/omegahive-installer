import { useEffect, useState } from 'react'

/**
 * The hive's one Easter egg: whenever time is rewound or fast-forwarded (a timeline scrubbed back, a jump ahead, a
 * replay restarted), a second clock appears beside the OS clock, the hive's system-info spot, showing the time you
 * jumped to with a 1.21 GW reading, while the real clock keeps the true time. Decoration only: nothing else changes.
 */
const EVENT = 'omega:timejump'
let last = 0

/** `to`: when the jump lands (a Date, shown as a time), or a short label where there is no clock time (a step). */
export function timeJump(to?: Date | string): void {
  try {                                                         // an Easter egg fails silent: it never breaks the control that fired it
    const now = Date.now()
    if (now - last < 250 || typeof window === 'undefined') return
    last = now
    const when = typeof to === 'string' && /^\d{4}-\d\d-\d\d/.test(to) ? new Date(to) : to   // a timestamp string is a time
    const detail = when instanceof Date ? (Number.isFinite(when.getTime()) ? when.toISOString() : null) : when ?? null
    window.dispatchEvent(new CustomEvent(EVENT, { detail }))
  } catch { /* decoration only */ }
}

/** A scrubber moved: backwards is a rewind; more than one step forwards is a fast forward. `at` says where it landed. */
export function scrubbed(from: number, to: number, at?: Date | string, step = 1): void {
  try { if (to < from || to - from > step) timeJump(at) } catch { /* decoration only */ }
}

/** For a moment after a time jump: where it landed (an ISO time or a label; '' when unknown). Null otherwise. */
export function useTimeJump(ms = 2200): string | null {
  const [on, setOn] = useState<string | null>(null)
  useEffect(() => {
    let t = 0
    const f = (e: Event) => { setOn((e as CustomEvent<string | null>).detail ?? ''); window.clearTimeout(t); t = window.setTimeout(() => setOn(null), ms) }
    window.addEventListener(EVENT, f)
    return () => { window.removeEventListener(EVENT, f); window.clearTimeout(t) }
  }, [ms])
  return on
}

/** What the second clock reads, from MeTTa (omega-mark.metta `jump-reading`, evaluated by PeTTa into brand/rules.json). */
let reading: Promise<string> | null = null
export function useJumpReading(): string {
  const [r, setR] = useState('1.21 GW')
  useEffect(() => {
    reading ??= fetch(`${import.meta.env.BASE_URL}brand/rules.json`).then((x) => x.json()).then((j: { time_jump?: Record<string, string> }) => j.time_jump?.rewind ?? '1.21 GW').catch(() => '1.21 GW')
    let live = true
    void reading.then((v) => { if (live) setR(v) })
    return () => { live = false }
  }, [])
  return r
}
