import type { RefObject } from 'react'
import { useDraft } from '../../experiences/drafts'
import { FloatingAsk } from './ClassicAsk'
import { useConstructFieldCaret } from './constructField'
import type { Placement } from './placement'

/** The existing floating terminal skin when a page covers the native prompt; one identity-bound draft. */
export function ConstructLine({ place, inputRef }: { place: Placement; inputRef: RefObject<HTMLInputElement | null> }) {
  const draft = useDraft('construct:ask')
  useConstructFieldCaret('floating', inputRef)
  return <FloatingAsk place={place} inputRef={inputRef} experience="construct" look="terminal" sharedDraft={draft} />
}
