/**
 * Purpose: what the person's say over a view needs wherever it is drawn, the run card (ViewConsent.tsx) or the prompt
 * under an HTML view (ViewFrame.tsx): the domains an HTML view declares that wait on them, and one answer of theirs,
 * pressed, on its way, and what went wrong if the hive could not record it.
 */
import { useState } from 'react'
import type { ArtifactView, HtmlArtifactView } from '../../api/moneyWork'

/** The domains an HTML view declares that wait on the person, each once. */
export const askedDomains = (view: ArtifactView): string[] =>
  view.carrier === 'metta' ? [] : [...new Set(Object.values((view as HtmlArtifactView).asks ?? {}).flatMap((list) => list ?? []))]

/** One answer the person gives: pressed, on its way, and what went wrong if it could not be recorded. */
export function useAnswer(give: () => Promise<void>) {
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
