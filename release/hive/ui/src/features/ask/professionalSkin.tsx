/** Purpose: draw Professional's Ask card for the host, at the person's size.
 * Professional's Ask skin, with its binding, tokens and stylesheets (released). AskHost
 * reaches this module only through a lazy import, so the initial bundle carries none of it: it is fetched when
 * Professional is chosen.
 */
import { Component, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ClassicAsk } from './ClassicAsk'
import { ClassicPresence } from './Presence'
import type { Placement } from './placement'
import type { AskRegion } from './askScreen'
import { useThreadReport } from './askRoom'
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

/**
 * Professional: its docked card, measured by the host through `boxRef` so pages clear its real height. At the person's
 * half size the whole card is the left half's column, reported as the thread so the stage arranges beside it;
 * collapsed, it is hidden behind the Ask's mark and keeps its words.
 */
export function ProfessionalAskSkin({ place, experience, inputRef, ctx, boxRef, region = 'bubble' }: SkinProps & { boxRef: (el: HTMLDivElement | null) => void; region?: AskRegion }) {
  const half = region === 'half-left'
  const [report] = useThreadReport()
  return (
    <div ref={boxRef} hidden={region === 'mark'} data-region={region} className="professional pr-ask-layer" style={{ ...professionalTokens, left: place.left, width: place.width, right: 'auto', maxWidth: 'none', bottom: `calc(var(--sab,0px) + ${place.bottom}px)` } as CSSProperties}>
      {/* at half the card's whole box is the column the stage keeps clear of, reported while the column exists */}
      {half && <div ref={report} className="pr-ask-column" aria-hidden />}
      <ProfessionalAskBoundary key={ctx} fallback={<ClassicAsk place={place} experience={experience} inputRef={inputRef} displayedOriginCurrent={() => professionalOriginCurrent(ctx)} region={region} />}>
        <ProfessionalAsk key={ctx} ctx={ctx} inputRef={inputRef} half={half} mode={place.mode} />
      </ProfessionalAskBoundary>
    </div>
  )
}

/** Presence in Professional's own furniture. */
export function ProfessionalPresence() {
  return <div className="pr-ask-presence" style={professionalTokens as CSSProperties}><ClassicPresence /></div>
}
