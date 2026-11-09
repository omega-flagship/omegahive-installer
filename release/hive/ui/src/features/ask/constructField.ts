import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react'
import { usePhase } from '../../shell/phase'
import { onIdentityChange } from '../../lib/identityEpoch'

/** The native prompt and its fallback are alternative presentations, never simultaneous Ask fields. */
type Place = 'native' | 'floating'
let place: Place = 'native'
let caret = false
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
export const constructFieldPlace = () => place
export function placeConstructField(next: Place, doc: Pick<Document, 'activeElement'> | null = typeof document === 'undefined' ? null : document): void {
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
export function useConstructFieldPlace(): Place {
  return useSyncExternalStore(subscribe, constructFieldPlace, () => 'native')
}
/** Transfer only the Ask's own focus, with the shared words and the cursor at their end. */
export function useConstructFieldCaret(owner: Place, ref: RefObject<HTMLInputElement | null>): void {
  const active = useConstructFieldPlace() === owner
  useLayoutEffect(() => {
    if (!active || !caret || !ref.current) return
    caret = false
    ref.current.focus({ preventScroll: true })
    const end = ref.current.value.length
    ref.current.setSelectionRange(end, end)
  }, [active, ref])
}

const FIELD_PART = { rest: 'construct rest field', awake: 'construct awake field', pro: 'construct pro field' } as const
export const useConstructFieldPart = () => usePhase((s) => s.phased ? FIELD_PART[s.phase] : undefined)
