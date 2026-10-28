/**
 * The unsaved-state guard for mind-proposed navigation (Host §5): a proposal never moves the page while something on
 * it is unsaved; it shows as a "Go" card instead. Pages mark their unsaved state with `useUnsaved(dirty)` or the DOM
 * attribute `data-ask-unsaved` on the form; an open look preview or a typed draft in an open editor counts too.
 */
import { useEffect, useId } from 'react'

const marks = new Set<string>()

export function markUnsaved(key: string, on: boolean): void {
  if (on) marks.add(key)
  else marks.delete(key)
}

/** A page says it holds unsaved work while `dirty`. */
export function useUnsaved(dirty: boolean): void {
  const id = useId()
  useEffect(() => {
    markUnsaved(id, dirty)
    return () => markUnsaved(id, false)
  }, [id, dirty])
}

export interface DirtyProbe {
  /** `document.querySelector('[data-ask-unsaved="true"]') !== null` in the browser */
  domUnsaved?: () => boolean
  /** a look is being previewed and not yet kept */
  lookPreview?: () => boolean
}

export function hasUnsaved(probe: DirtyProbe = {}): boolean {
  if (marks.size) return true
  if (probe.lookPreview?.()) return true
  if (probe.domUnsaved?.()) return true
  return false
}

export const domUnsaved = (): boolean => typeof document !== 'undefined' && document.querySelector('[data-ask-unsaved="true"]') !== null
