/**
 * Create's Make bench: "What would you like to make?" on an empty canvas, then the plan at work, then ready to deploy.
 * MeTTa composes the page (plan.metta: plan-start, plan, plan-ready) from the facts planFacts.ts states; this file only
 * offers the islands it places (the sentence field, the plan's head, its questions, the board, the stream, the code
 * beside the running page, the finished page and the go) and carries out the presses.
 */
import { useMemo, useState } from 'react'
import { navigate } from '../../lib/router'
import { useReducedMotion } from '../../lib/hooks'
import { useIdentityEpoch } from '../../lib/epochBound'
import { experienceById } from '../../experiences/registry'
import { useLook } from '../../shell/uiVariant'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { guardComposing } from '../ask/keys'
import { cx } from '../../lib/cx'
import type { PlanView } from './contract'
import { planFacts } from './planFacts'
import { usePlan } from './usePlan'
import { PlanBoard } from './PlanBoard'
import { PlanStream } from './PlanStream'
import { QuestionCards } from './QuestionCards'
import { LivePair } from './LivePair'
import { DeployGo, ReadyPreview } from './ReadyToDeploy'
import './createPlan.css'

const EXAMPLE = 'a small web page that shows the weather in London'

/** The one sentence on the empty canvas. */
export function PlanSay({ busy, onStart }: { busy: boolean; onStart: (sentence: string) => void }) {
  const [text, setText] = useState('')
  const send = () => { if (!busy && text.trim()) onStart(text.trim()) }
  return (
    <form className="pc-say" onSubmit={(e) => e.preventDefault()} aria-busy={busy || undefined}>
      <label className="pc-say-label" htmlFor="pc-say-field">What would you like to make?</label>
      <div className="pc-say-row">
        <input id="pc-say-field" className="pc-say-input" value={text} maxLength={600} disabled={busy} autoComplete="off"
          placeholder={`e.g. ${EXAMPLE}`} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (guardComposing(e)) return
            if (e.key === 'Enter') { e.preventDefault(); send() }
          }} />
        <button type="button" className="pc-say-go" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Starting…' : 'Make it'}</button>
      </div>
    </form>
  )
}

/** The person's sentence, where it stands in one line, and an act that did not go through. */
function PlanHead({ view, stale, alert }: { view: PlanView | null; stale: boolean; alert: string | null }) {
  return (
    <header className="pc-head">
      <p className="pc-eyebrow">Making</p>
      <h2 className="pc-sentence">{view ? `“${view.sentence}”` : 'Opening your plan…'}</h2>
      {view?.status_line && <p className="pc-status">{view.status_line}</p>}
      {stale && <p className="pc-stale" role="status">Couldn't refresh just now; showing the last view.</p>}
      {alert && <p className="pc-alert" role="alert">{alert}</p>}
    </header>
  )
}

function PlanForming({ reduced }: { reduced: boolean }) {
  return (
    <div className="pc-forming" role="status">
      <span className={cx('pc-forming-orbs', !reduced && 'pc-forming-live')} aria-hidden="true"><i /><i /><i /></span>
      <span>Planning the pieces, and who takes each…</span>
    </div>
  )
}

export default function PlanCanvas() {
  const epoch = useIdentityEpoch()
  return <BoundPlanCanvas key={epoch} />
}

function BoundPlanCanvas() {
  const plan = usePlan()
  const reduced = useReducedMotion()
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const [stopAsking, setStopAsking] = useState(false)
  const { view } = plan
  const showing = !!plan.frame || !!plan.file
  const page = useMemo(() => planFacts(view, { can: plan.can, starting: plan.starting, startError: plan.startError, stopAsking: stopAsking && !plan.stopping, opening: !view && plan.following, showing }),
    [view, plan.can, plan.starting, plan.startError, stopAsking, plan.stopping, plan.following, showing])
  const composed = useMemo(() => compose(page.screen, page.facts), [compose, page])
  const islands = {
    'plan-say': <PlanSay busy={plan.starting} onStart={plan.start} />,
    'plan-head': <PlanHead view={view} stale={plan.stale} alert={plan.alert} />,
    'plan-forming': <PlanForming reduced={reduced} />,
    ...(view ? {
      'plan-questions': <QuestionCards view={view} answering={plan.answering} onAnswer={plan.answer} />,
      'plan-board': <PlanBoard view={view} reduced={reduced} />,
      'plan-stream': <PlanStream view={view} reduced={reduced} />,
      'live-pair': <LivePair view={view} file={plan.file} frame={plan.frame} reduced={reduced} />,
      'ready-preview': <ReadyPreview view={view} frame={plan.frame} reduced={reduced} />,
      'deploy-go': <DeployGo view={view} busy={plan.deploying} alert={plan.alert} onDeploy={plan.deploy} />,
    } : {}),
  }
  const onAction = (action: string) => {
    if (action === 'stop-ask') setStopAsking(true)
    else if (action === 'stop-no') setStopAsking(false)
    else if (action === 'stop-yes') { setStopAsking(false); plan.stop() }
    else if (action === 'open-app' && view?.installed) navigate({ name: 'program', id: view.installed.app_id })
    else if (action === 'fresh') { setStopAsking(false); plan.fresh() }
  }
  return (
    <div className="pc" data-plan-screen={page.screen} data-reduced={reduced || undefined}>
      <Screen plan={composed} className="pc-col" host={{ data: page.data, islands, onAction }} />
    </div>
  )
}
