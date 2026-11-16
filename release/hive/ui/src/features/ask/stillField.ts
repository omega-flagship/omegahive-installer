import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react'
import { usePhase } from '../../shell/phase'
import { onIdentityChange } from '../../lib/identityEpoch'

/** The paper and its fallback are alternative presentations, never simultaneous Ask fields. */
type Place = 'paper' | 'floating'
let place: Place = 'paper'
let caret = false
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
export const stillFieldPlace = () => place
export function placeStillField(next: Place, doc: Pick<Document, 'activeElement'> | null = typeof document === 'undefined' ? null : document): void {
  if (place === next) return
  caret = !!doc?.activeElement?.matches('[data-ask-input]')
  place = next
  for (const cb of [...listeners]) cb()
}
onIdentityChange(() => {
  caret = false
  // Geometry belongs to the page, not to a person; the next identity keeps the active location.
  for (const cb of [...listeners]) cb()
})
export function useStillFieldPlace(): Place {
  return useSyncExternalStore(subscribe, stillFieldPlace, () => 'paper')
}
/** Transfer only the Ask's own focus, with the shared words and the cursor at their end. */
export function useStillFieldCaret(owner: Place, ref: RefObject<HTMLInputElement | null>): void {
  const active = useStillFieldPlace() === owner
  useLayoutEffect(() => {
    if (!active || !caret || !ref.current) return
    caret = false
    ref.current.focus({ preventScroll: true })
    const end = ref.current.value.length
    ref.current.setSelectionRange(end, end)
  }, [active, ref])
}

const FIELD_PART = { rest: 'still rest field', awake: 'still awake field', pro: 'still pro field' } as const
export const useStillFieldPart = () => usePhase((s) => s.phased ? FIELD_PART[s.phase] : undefined)
