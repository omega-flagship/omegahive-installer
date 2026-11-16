import { useLayoutEffect, useState } from 'react'
import { ARM_MS } from './decisionGate'

/**
 * Whether a decision opened at `openedAt` (performance.now(), or null when none is open) may be answered yet: armed
 * `ms` after it opened, so a click or key meant for what was there before cannot answer it. Only the timer arms it;
 * a newly opened decision (a new `openedAt`) or none is unarmed at once, worked out while rendering, never by setState
 * in an effect. One already past its delay arms on the next tick, never earlier.
 */
export function useArmedAfter(openedAt: number | null, ms = ARM_MS): boolean {
  const [armedFor, setArmedFor] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (openedAt === null) return
    const timer = setTimeout(() => setArmedFor(openedAt), Math.max(0, ms - (performance.now() - openedAt)))
    return () => clearTimeout(timer)
  }, [openedAt, ms])
  return openedAt !== null && armedFor === openedAt
}
