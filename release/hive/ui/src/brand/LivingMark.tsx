import { LiveOmega } from './LiveOmega'
import { markLook, stillFor } from './stills'
import type { MarkPace } from './markPace'

/** The master still of the mark in a look, on transparency: what a hero shows before (and without) the living mark. Never
 * the flat glyph, which is for corners, bars and line art. */
export function MarkStill({ look, className = 'size-full object-contain' }: { look?: string | null; className?: string }) {
  return <img src={stillFor(markLook(look))} alt="" draggable={false} className={className} />
}

/** A hero mark: the living Omega in the look it stands for, with that look's master still as the fallback. Capped (≤30
 * frames a second) unless a caller asks for 'full' (brand/markPace; the counted gate). */
export function LivingMark({ look, className = '', pace = 'awake' }: { look?: string | null; className?: string; pace?: MarkPace }) {
  return <LiveOmega look={look} size="hero" className={className} pace={pace} fallback={<MarkStill look={look} />} />
}
