import type { ReactNode } from 'react'
import { LiveOmega } from './LiveOmega'
import { useAskMark } from './askMark'

/**
 * The Ask field's own Omega: your mind's mark, living in the look it is in and behaving as it works (brand/askMark,
 * omega-mark.metta ask-behaves). aria-hidden decoration: the field's name, placeholder and words are unchanged, nothing
 * here sits on the input path, and `fallback` (the look's own glyph) shows under reduced motion, without WebGL and while
 * it loads.
 */
export function AskLeadMark({ experience, typing, fallback }: { experience: string; typing: boolean; fallback: ReactNode }) {
  const s = useAskMark(experience, typing)
  return <LiveOmega look={experience} size="corner" className="size-[26px]" fallback={fallback} presence={{ state: s.presence, level: s.level }} pulse={s.pulse} hold={s.hold} />
}
