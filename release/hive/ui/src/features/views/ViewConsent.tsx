/**
 * Purpose: the person's say over a view, drawn from MeTTa (views.metta). Before a view runs, a card names it and its maker
 * and runs it only on Run it (view-run). Under an HTML view running without the domains it declares, a prompt names them
 * and allows them only for that revision (view-reach). Each answer is the person's own click, recorded by the hive
 * (POST /api/artifacts/{id}/view/grants), which hands out a view's code only after it and widens an HTML view's CSP
 * only for the revision allowed (hive/core/views.py Grants).
 */
import { useState } from 'react'
import type { ArtifactView, HtmlArtifactView } from '../../api/moneyWork'
import { experienceById } from '../../experiences/registry'
import { Screen } from '../../screens/Screen'
import { NotThePage } from '../../screens/openScreens'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'

/** The domains an HTML view declares that wait on the person, each once. */
const askedDomains = (view: ArtifactView): string[] =>
  view.carrier === 'metta' ? [] : [...new Set(Object.values((view as HtmlArtifactView).asks ?? {}).flatMap((list) => list ?? []))]

/** One answer the person gives: pressed, on its way, and what went wrong if it could not be recorded. */
function useAnswer(give: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    give().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
  }
  return { busy, error, answer }
}

/** Before a view runs: who made it, what it would reach, and Run it. */
export function RunCard({ view, maker, onRun }: { view: ArtifactView; maker: string; onRun: () => Promise<void> }) {
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const { busy, error, answer } = useAnswer(onRun)
  const asks = askedDomains(view)
  const plan = compose('view-run', { counts: { 'view.asks': asks.length }, flags: { 'view.failed': error !== null } })
  return (
    <div data-view-run={view.artifact_id} className="rounded-2xl border border-line p-4">
      <NotThePage.Provider value={true}><Screen plan={plan} className="space-y-3" host={{
        data: { 'view.title': view.title, 'view.maker': maker, 'view.asks': asks.join(', '), 'view.busy': busy, 'view.error': error ?? '' },
        onAction: (action) => { if (action === 'run') answer() },
      }} /></NotThePage.Provider>
    </div>
  )
}

/** Under an HTML view running without the domains it declares: which they are, and Allow for this version. */
export function ReachPrompt({ view, onAllow }: { view: HtmlArtifactView; onAllow: () => Promise<void> }) {
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const { busy, error, answer } = useAnswer(onAllow)
  const asks = askedDomains(view)
  if (!asks.length) return null
  const plan = compose('view-reach', { counts: { 'view.asks': asks.length }, flags: { 'view.failed': error !== null } })
  return (
    <div data-view-reach={view.artifact_id} className="mt-2">
      <NotThePage.Provider value={true}><Screen plan={plan} className="space-y-2" host={{
        data: { 'view.asks': asks.join(', '), 'view.busy': busy, 'view.error': error ?? '' },
        onAction: (action) => { if (action === 'allow') answer() },
      }} /></NotThePage.Provider>
    </div>
  )
}
