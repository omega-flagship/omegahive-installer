/**
 * Purpose: the person's say over a view, drawn from MeTTa (views.metta). Before a view runs, a card names it and its maker
 * and runs it only on Run it (view-run). Under an HTML view running without the domains it declares, view-host asks to
 * allow them only for that revision (both answers as consentAnswers.ts keeps them). Each answer is the person's own click,
 * recorded by the hive (POST /api/artifacts/{id}/view/grants), which hands out a view's code only after it and widens an
 * HTML view's CSP only for the revision allowed (hive/core/views.py Grants).
 */
import type { ArtifactView } from '../../api/moneyWork'
import { experienceById } from '../../experiences/registry'
import { Screen } from '../../screens/Screen'
import { NotThePage } from '../../screens/openScreens'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { askedDomains, useAnswer } from './consentAnswers'

/** Before a view runs: who made it (`maker`, null when the person can't see that mind), what it would reach, and Run it. */
export function RunCard({ view, maker, onRun }: { view: ArtifactView; maker: string | null; onRun: () => Promise<void> }) {
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const { busy, error, answer } = useAnswer(onRun)
  const asks = askedDomains(view)
  const plan = compose('view-run', { counts: { 'view.asks': asks.length, 'view.maker': maker ? 1 : 0 }, flags: { 'view.failed': error !== null } })
  return (
    <div data-view-run={view.artifact_id} className="rounded-2xl border border-line p-4">
      <NotThePage.Provider value={true}><Screen plan={plan} className="space-y-3" host={{
        data: { 'view.title': view.title, 'view.maker': maker ?? '', 'view.asks': asks.join(', '), 'view.busy': busy, 'view.error': error ?? '' },
        onAction: (action) => { if (action === 'run') answer() },
      }} /></NotThePage.Provider>
    </div>
  )
}
