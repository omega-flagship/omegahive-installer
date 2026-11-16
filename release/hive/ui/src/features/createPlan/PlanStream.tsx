/**
 * The work on the plan, as it happens: Code's work stream generalised to the plan's stages (plan → tests first → build →
 * check → review → ready → deployed; one moving at a time, a check's decisive line in mono, red → fix → green in place),
 * then one row per piece: who is on it, the file or test or review it is at, in that assignee's own hue. Drawn with the
 * work stream's own glass (code/canvas/work/workStream.css). Presentation only: stages and rows come from the plan
 * model. Reduced motion: nothing pulses or glides.
 */
import { cx } from '../../lib/cx'
import { Icon, type IconName } from '../../ui/Icon'
import type { PlanView } from './contract'
import { pieceRows, planStages, type PlanStage, type PlanStageKey } from './planModel'
import { hueOf } from './PlanBoard'
import '../code/canvas/work/workStream.css'

const ICON: Record<PlanStageKey, IconName> = { plan: 'list', tests: 'flask', build: 'edit', check: 'play', review: 'shield', ready: 'check', deployed: 'apps' }
const STATE_WORDS: Record<PlanStage['state'], string> = { waiting: 'still to come', active: 'happening now', done: 'done', failed: 'needs a look', skipped: 'not this time' }

export function PlanStream({ view, reduced }: { view: PlanView; reduced: boolean }) {
  const stages = planStages(view)
  const rows = pieceRows(view)
  const moving = stages.find((s) => s.state === 'active') ?? stages.find((s) => s.state === 'failed')
  return (
    <section className="ws ps" aria-label="The work on your plan" data-reduced={reduced || undefined}>
      <ol className="ws-steps">
        {stages.map((s, n) => (
          <li key={s.key} className="ws-step" data-state={s.state} data-key={s.key === 'check' ? 'test' : s.key} aria-current={s.state === 'active' ? 'step' : undefined}>
            <span className="ws-rail" aria-hidden="true">
              <span className={cx('ws-orb', s.state === 'active' && !reduced && 'ws-orb-live')}>
                {s.state === 'done' ? <Icon name="check" size={11} /> : s.state === 'failed' ? <Icon name="info" size={11} /> : s.state === 'active' ? null : <Icon name={ICON[s.key]} size={11} />}
              </span>
              {n < stages.length - 1 && <span className="ws-line" />}
            </span>
            <div className="ws-body">
              <p className="ws-words"><span className="sr-only">{STATE_WORDS[s.state]}: </span>{s.words}</p>
              {s.line && <p className="ws-out">{s.line}</p>}
              {s.detail && <p className="ws-detail">{s.detail}</p>}
              {s.key === 'build' && s.state !== 'waiting' && rows.length > 0 && (
                <ul className="ps-rows" aria-label="Each piece">
                  {rows.map((r) => (
                    <li key={r.id} className="ps-row" data-phase={r.phase} style={{ ['--mind-hue' as string]: String(r.builder?.hue ?? hueOf(r.assignee.display)) }}>
                      <span className={cx('ps-dot', (r.phase === 'building' || r.phase === 'testing' || r.phase === 'fixing') && !reduced && 'ps-dot-live')} aria-hidden="true" />
                      <span className="ps-row-words">
                        <span className="ps-row-title">{r.title}</span>
                        <span className="ps-row-state">{r.words.startsWith(`${r.title} · `) ? r.words.slice(r.title.length + 3) : r.words}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">{moving ? moving.words : ''}</p>
    </section>
  )
}
