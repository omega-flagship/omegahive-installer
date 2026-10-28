/** The merge review packet in the drawer's Changes, when the service declares it and the hive relays it (row 29). */
import { useEffect, useState } from 'react'
import { loadMergeReview, verificationWords, type MergeReviewState } from './mergeReview'

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

export function MergeReviewCard({ call, ws, caps }: { call: Call; ws: { id: string; generation: number; tree_digest: string }; caps: { status: string; features: ReadonlySet<string> } }) {
  const [state, setState] = useState<{ key: string; s: MergeReviewState } | null>(null)
  const key = `${ws.id}:${ws.generation}:${caps.status}:${caps.features.size}`
  useEffect(() => {
    let live = true
    void loadMergeReview(call, ws, caps).then((s) => live && setState({ key, s }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, call])
  const s = state?.key === key ? state.s : null
  if (!s || s.kind === 'hidden') return null
  if (s.kind === 'error') return <p className="cc-card-bad mx-3 mb-3">The merge review packet did not load: {s.text}</p>
  const p = s.packet
  return (
    <section className="cc-iter-open mx-3 mb-3" aria-label="Merge review packet">
      <h3>Review packet for the merge (generation {p.generation})</h3>
      <p>
        {p.files} file{p.files === 1 ? '' : 's'} changed; {verificationWords(p.verification)}. Quality is {p.quality === 'not_assessed' ? 'not assessed' : p.quality}; a review is
        {p.dispatch === 'host_bridge_required' ? ' started by the hive, not from here' : ` ${p.dispatch}`}.
      </p>
      {p.limitations.length > 0 && (
        <ul className="cc-card-fine">
          {p.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
