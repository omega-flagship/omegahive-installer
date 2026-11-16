/**
 * The personal mind's figure, drawn in the look being worn (glass, constellation or line portrait), with its labels
 * beside it where there is room (mind.css: the labels show only in a centre at least 620px wide; the composed facts
 * above say the same in words). The personal mind page places it as an island (mind.metta): it is a drawing, not a
 * part any block draws.
 */
import type { MindPresence } from '../../api/personalMind'
import { useMediaQuery } from '../../lib/hooks'
import { plural } from '../../lib/plural'
import { money } from '../../lib/format'
import { MindFigure } from './MindFigure'

export interface MindPortraitProps {
  name: string
  presence: MindPresence
  notes: number
  talks: number
  acting: boolean
  /** the version it runs, when known */
  version: string | null
  allowance: number | null
  /** what its hands are doing now, in words */
  hands: string
}

export function MindPortrait({ name, presence, notes, talks, acting, version, allowance, hands }: MindPortraitProps) {
  const wide = useMediaQuery('(min-width: 1024px)')
  return (
    <section className="pm-center relative flex flex-col items-center" aria-label="Who it is">
      <span className="pm-glow" aria-hidden />
      <div className="relative mt-2">
        <MindFigure name={name} presence={presence} remembers={notes + talks} acting={acting} versioned={!!version} width={wide ? 260 : 150} />
        {version && (
          <span className="pm-tag" data-side="r" style={{ left: '62%', top: '-1%' }}>
            <i />
            <span>
              <b>Halo</b>
              {version}
            </span>
          </span>
        )}
        <span className="pm-tag" data-side="l" style={{ right: '64%', top: '6%' }}>
          <span>
            <b>Remembers</b>
            {plural(notes, 'note')} · {plural(talks, 'talk')}
          </span>
          <i />
        </span>
        <span className="pm-tag" data-side="l" style={{ right: '64%', top: '27%' }}>
          <span>
            <b>Energy</b>
            {allowance !== null ? `your allowance · ${money(allowance)} a month` : 'your allowance'}
          </span>
          <i />
        </span>
        <span className="pm-tag" data-side="r" style={{ left: '76%', top: '58%' }}>
          <i />
          <span>
            <b>Hands</b>
            {hands}
          </span>
        </span>
      </div>
    </section>
  )
}
