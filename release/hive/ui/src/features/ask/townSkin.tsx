/**
 * Closed Source for Product Consideration (OmegaTown): see experiences/omegatown/CLOSED_SOURCE.md. Not Apache-2.0.
 *
 * OmegaTown's Ask skin and presence (released: registry `reviewed`). AskHost loads this module lazily, only when Town
 * is the experience, so other experiences never fetch it. The Ask here is the person's own Ask (the owner, 2026-10-08:
 * "ask is essentially me"): the shared floating capsule, bound to Town's displayed origin. Residents speak in their
 * own chat, never through it.
 */
import type { RefObject } from 'react'
import { ClassicAsk } from './ClassicAsk'
import { ClassicPresence } from './Presence'
import type { Placement } from './placement'
import { current as townOriginCurrent } from '../../experiences/omegatown/binding'
import '../../experiences/omegatown/styles.css'
import './townAsk.css'

interface SkinProps {
  place: Placement
  experience: string
  inputRef: RefObject<HTMLInputElement | null>
  /** the displayed identity epoch: a later person or session never inherits this skin's origin */
  ctx: string
}

/** OmegaTown: the shared floating capsule, bound to Town's displayed origin. */
export function TownAskSkin({ place, experience, inputRef, ctx }: SkinProps) {
  return <ClassicAsk key={ctx} place={place} experience={experience} inputRef={inputRef} displayedOriginCurrent={() => townOriginCurrent(ctx)} />
}

/** Presence in Town's own furniture. */
export function TownPresence() {
  return <div className="town-ask-presence"><ClassicPresence /></div>
}
