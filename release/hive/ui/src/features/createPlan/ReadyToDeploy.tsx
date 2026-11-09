/**
 * Ready to deploy: the page large, a plain summary of what was built, and the person's one go. The go is offered only
 * when the plan says it is available (otherwise it shows, held, with the reason), and says plainly when a review was
 * waived on the way. Presentation only: the go goes through the page's act.
 */
import type { PlanView } from './contract'
import { deployGo } from './planModel'
import { RunningPage, type PageFrame } from './LivePair'

/** The finished page (the verified preview) and what it does: the plan's acceptance criteria (older views: summary lines). */
export function ReadyPreview({ view, frame, reduced }: { view: PlanView; frame: PageFrame | null; reduced: boolean }) {
  const lines = view.summary?.length ? view.summary : view.acceptance
  return (
    <section className="pr" aria-label="What was built">
      <div className="pr-stage">
        {frame ? <RunningPage frame={frame} receipt={null} reduced={reduced} title="The finished page" /> : <p className="pl-why">The finished page shows here.</p>}
      </div>
      {lines.length > 0 && (
        <ul className="pr-summary" aria-label="What it does">
          {lines.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </section>
  )
}

export function DeployGo({ view, busy, alert, onDeploy }: { view: PlanView; busy: boolean; alert: string | null; onDeploy: () => void }) {
  const go = deployGo(view)
  const held = !go.available || busy
  return (
    <div className="pr-go" role="group" aria-label="Your go">
      <div className="pr-go-words">
        <p className="pr-go-title">{go.available ? 'Ready when you are' : 'Not ready to deploy yet'}</p>
        <p className="pr-go-line">
          {go.available
            ? go.unreviewed
              ? 'Not reviewed: your setting allowed it to skip review. Deploying puts it in your Apps as it is.'
              : 'Checked and reviewed. Deploying puts it in your Apps.'
            : go.why_not}
        </p>
      </div>
      <button type="button" className="pr-deploy" disabled={held} aria-disabled={held || undefined} onClick={go.available && !busy ? onDeploy : undefined}>
        {busy ? 'Deploying…' : 'Deploy'}
      </button>
      {alert && <p className="pr-alert" role="alert">{alert}</p>}
    </div>
  )
}
