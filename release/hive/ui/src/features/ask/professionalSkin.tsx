/**
 * Professional's Ask skin, with its binding, tokens and stylesheets (released; OmegaTown's is townSkin.tsx). AskHost
 * reaches this module only through a lazy import, so the initial bundle carries none of it: it is fetched when
 * Professional is chosen.
 */
import { Component, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ClassicAsk } from './ClassicAsk'
import { ClassicPresence } from './Presence'
import type { Placement } from './placement'
import { ProfessionalAsk } from '../../experiences/professional/Ask'
import { current as professionalOriginCurrent } from '../../experiences/professional/binding'
import { TOKENS as professionalTokens } from '../../experiences/professional/theme'
import '../../experiences/professional/styles.css'
import './experienceAsk.css'

interface SkinProps {
  place: Placement
  experience: string
  inputRef: RefObject<HTMLInputElement | null>
  /** the displayed identity epoch: a later person or session never inherits this skin's origin */
  ctx: string
}

/** A skin error cannot remove the single host's identity/confirmation lane or the canonical Ask fallback. */
class ProfessionalAskBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

/** Professional: its docked card, measured by the host through `boxRef` so pages clear its real height. */
export function ProfessionalAskSkin({ place, experience, inputRef, ctx, boxRef }: SkinProps & { boxRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={boxRef} className="professional pr-ask-layer" style={{ ...professionalTokens, left: place.left, width: place.width, right: 'auto', maxWidth: 'none', bottom: `calc(var(--sab,0px) + ${place.bottom}px)` } as CSSProperties}>
      <ProfessionalAskBoundary key={ctx} fallback={<ClassicAsk place={place} experience={experience} inputRef={inputRef} displayedOriginCurrent={() => professionalOriginCurrent(ctx)} />}>
        <ProfessionalAsk key={ctx} ctx={ctx} inputRef={inputRef} />
      </ProfessionalAskBoundary>
    </div>
  )
}

/** Presence in Professional's own furniture. */
export function ProfessionalPresence() {
  return <div className="pr-ask-presence" style={professionalTokens as CSSProperties}><ClassicPresence /></div>
}
