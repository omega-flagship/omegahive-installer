import { useState } from 'react'
import type { GoalAttempt } from '../../api/missingUi'
import type { Goal } from '../../api/types'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { errorMessage, has, isNotFound, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'

/** The words one attempt shows: valid or not, and the hive's own reasons when it was not. */
export function attemptLine(a: Pick<GoalAttempt, 'ok' | 'errors'>): string {
  if (a.ok) return 'valid'
  return a.errors.length ? `not valid: ${a.errors.join('; ')}` : 'not valid'
}

/**
 * GET /api/goals/{id}/attempts (Surface missing-UI batch 1 r2, audit item 5): every result a mind submitted on this
 * task, verbatim, valid or not, oldest first, shown in the task's detail. The host route keeps its backend name. The
 * hive keeps attempts only for tasks with a result schema, so an empty list on a task without one says so rather than
 * implying nothing was tried.
 */
export function TaskAttempts({ task: goal }: { task: Goal }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const [open, setOpen] = useState(false)
  const res = useResource(() => need(client, 'goalAttempts', 'Result attempts')(goal.id), { context: goal.id, key: `${goal.updated_at}:${open}` })
  if (!has(client, 'goalAttempts') || res.status === 'unsupported') return null
  const n = res.data?.length ?? 0
  return (
    <div className="rounded-lg border border-line bg-black/20 px-2.5 py-1.5 text-[11.5px]" data-task-attempts>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1 text-left text-ink-4 hover:text-ink-2">
        <span className="flex-1">Every result attempt on this task{res.status === 'ready' ? ` (${n})` : ''}</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open &&
        (res.status === 'loading' ? (
          <span className="text-ink-4">Loading…</span>
        ) : res.status === 'error' ? (
          <span className={isNotFound(res.error) ? 'text-ink-3' : 'text-bad'}>{isNotFound(res.error) ? 'Not visible to you.' : errorMessage(res.error)}</span>
        ) : res.status === 'empty' || n === 0 ? (
          <span className="text-ink-4">No attempts kept. The hive keeps them only for tasks that ask for a result in a set shape.</span>
        ) : (
          <ol className="mt-1 space-y-1.5">
            {res.data?.map((a, i) => (
              <li key={a.id} className="rounded-md border border-line/70 px-2 py-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ink-2">#{i + 1}</span>
                  <span className={a.ok ? 'text-good' : 'text-bad'}>{attemptLine(a)}</span>
                  <span className="text-ink-4">
                    by {shown(agents[a.agent_id]?.name ?? a.agent_id)} · {ago(a.at)}
                  </span>
                </div>
                <pre className="thin-scroll mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-3">{a.raw}</pre>
              </li>
            ))}
          </ol>
        ))}
    </div>
  )
}
