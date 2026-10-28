import { useState } from 'react'
import type { Goal } from '../../api/types'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { principalWords, reviewBlocked, reviewerWords } from '../../lib/goalReview'
import { errorMessage, has, isNotFound, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'

/** Accept or return submitted work, bound to the goal exactly as opened (Review R2/R3). */
export function ReviewDialog({ seen, decision, onClose }: { seen: Goal; decision: 'accept' | 'return'; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const live = useHive((s) => s.goals[seen.id])
  const toast = useHive((s) => s.toast)
  const [notes, setNotes] = useState('')
  const holder = seen.claimed_by ? principalWords(seen.claimed_by, agents) : 'nobody'
  const accept = decision === 'accept'
  return (
    <DecisionDialog
      icon={accept ? 'check' : 'reset'}
      eyebrow={accept ? 'Accept submitted work' : 'Return submitted work'}
      title={accept ? `Accept “${seen.title}” as done?` : `Return “${seen.title}” to ${holder}?`}
      facts={[
        ['Task', `${seen.title} (${seen.id})`],
        ['Done by', holder],
        ['Result', seen.result ?? 'no result text'],
        ['Reviewed by', seen.review_by === undefined ? 'a person (this hive does not say which)' : reviewerWords(seen.review_by, (id) => (agents[id] ? shown(agents[id].name) : undefined))],
        ['Returned before', seen.returns ? `${seen.returns}×${seen.review_notes ? `, last notes: “${seen.review_notes}”` : ''}` : 'never'],
      ]}
      bound={bindTo(seen, live, ['id', 'status', 'result', 'claimed_by', 'returns'], (l) => (l.status === 'submitted' ? null : `This task is ${l.status} now, not waiting for review.`))}
      thing="This task"
      onClose={onClose}
      actions={[
        {
          label: accept ? 'Accept · done' : 'Return with notes',
          busyLabel: accept ? 'Accepting' : 'Returning',
          tone: accept ? 'primary' : 'danger',
          blocked: reviewBlocked(decision, notes),
          run: async () => {
            try {
              const g = await need(client, 'reviewGoal', 'Reviewing')(seen.id, decision, notes.trim())
              useHive.setState((st) => ({ goals: { ...st.goals, [g.id]: { ...st.goals[g.id], ...g } } }))
              toast({ tone: 'success', title: accept ? 'Accepted: done' : 'Returned with your notes' })
              return true
            } catch (e) {
              return decisionFailure(e)
            }
          },
        },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">{accept ? 'Notes (optional), recorded with the review' : 'What should change? The mind gets these notes.'}</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1 w-full resize-y rounded-xl border border-line bg-black/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <p className="text-meta leading-snug text-ink-4">{accept ? 'Accepting makes the task done and records you as its reviewer.' : 'Returning sends it back to the same mind with your notes; after repeated returns the hive fails the task.'}</p>
    </DecisionDialog>
  )
}

const ACTION_WORD: Record<string, string> = { submit: 'submitted', accept: 'accepted', return: 'returned' }

/** GET /api/goals/{id}/reviews: every submit, accept and return, oldest first. */
export function ReviewHistory({ goal }: { goal: Goal }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const res = useResource(() => need(client, 'goalReviews', 'Review history')(goal.id), { context: goal.id, key: goal.updated_at })
  if (!has(client, 'goalReviews') || res.status === 'unsupported') return null
  return (
    <div className="rounded-lg border border-line bg-black/20 px-2.5 py-1.5 text-[11.5px]" data-review-history>
      <div className="mb-0.5 text-ink-4">Review history</div>
      {res.status === 'loading' ? (
        <span className="text-ink-4">Loading…</span>
      ) : res.status === 'error' ? (
        <span className={isNotFound(res.error) ? 'text-ink-3' : 'text-bad'}>{isNotFound(res.error) ? 'Not visible to you.' : errorMessage(res.error)}</span>
      ) : res.status === 'empty' ? (
        <span className="text-ink-4">No reviews yet.</span>
      ) : (
        <ul className="space-y-0.5">
          {res.data?.map((r) => (
            <li key={r.id} className="text-ink-3">
              <span className="text-ink-2">{ACTION_WORD[r.action] ?? r.action}</span> by {principalWords(r.by, agents)} · {ago(r.at)}
              {r.notes ? <span className="text-ink-3"> · “{r.notes}”</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
