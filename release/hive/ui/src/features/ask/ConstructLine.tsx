// Purpose: Construct's floating terminal line, drawn by the host when a page covers Construct's own prompt.
import type { RefObject } from 'react'
import { useDraft } from '../../experiences/drafts'
import type { AskRegion } from './askScreen'
import { FloatingAsk } from './ClassicAsk'
import { useConstructFieldCaret } from './constructField'
import type { Placement } from './placement'

/** The existing floating terminal skin when a page covers the native prompt, at the person's size; one identity-bound draft. */
export function ConstructLine({ place, inputRef, region }: { place: Placement; inputRef: RefObject<HTMLInputElement | null>; region?: AskRegion }) {
  const draft = useDraft('construct:ask')
  useConstructFieldCaret('floating', inputRef)
  return <FloatingAsk place={place} inputRef={inputRef} experience="construct" look="terminal" sharedDraft={draft} region={region} />
}
