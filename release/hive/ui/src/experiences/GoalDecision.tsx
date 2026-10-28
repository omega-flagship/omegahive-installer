import { useMemo, useState } from 'react'
import type { Goal } from '../api/types'
import { shown } from '../lib/displayName'
import type { DecisionResult } from '../lib/decisionGate'
import { GOAL_VERB_LABEL, goalBound, goalDrift, goalEffect, goalRecheckResult, goalWriteResult, seenOf, verbFor } from '../lib/goalDecision'
import { NOT_CONFIRMED, useHive } from '../store/store'
import { DecisionDialog } from '../ui/DecisionDialog'

/**
 * Review D1: a goal's terminal or re-open change, decided in the shared DecisionDialog with the goal as inspected
 * (title, status, holder, swarm, what the change does). The dialog refuses while the live goal no longer matches what
 * was opened (status, holder, swarm, title or version), during its arming window, on a held key and while in flight;
 * the binding is checked again at the moment of dispatch. A refused change says so and changes nothing.
 * Review B1 (next22): a change whose answer was lost is never called refused. The store reads the goal again: if the
 * change is there it reports success; if the goal is unchanged this dialog is spent and a retry is a fresh
 * GoalDecision; if the goal cannot be read, it stays "not confirmed" with "Check again".
 * Render inside <AnimatePresence>; `seen` is the goal exactly as it was when the person asked.
 */
export function GoalDecision({ seen, to, session, onClose, dismissLabel, restoreFocus }: {
  seen: Goal
  to: Goal['status']
  /**
   * Surface R (Kimi follow-up): the store session `seen` was read under, stamped by the opener where it was shown. Given,
   * the change goes only in that session; omitted, the session at the moment the dialog opens.
   */
  session?: string
  onClose: () => void
  dismissLabel?: string
  /** Where focus goes on close when the opener left with the goal (it moved lists): see useModalContainment. */
  restoreFocus?: (opener: HTMLElement | null) => HTMLElement | null | undefined
}) {
  const live = useHive((s) => s.goals[seen.id])
  const swarm = useHive((s) => s.swarms[seen.swarm_id])
  const agents = useHive((s) => s.agents)
  const snap = useMemo(() => (session === undefined ? seenOf(seen) : { ...seenOf(seen), session }), [seen, session])
  // Surface R: re-check the binding when the store's session changes (a different client is a different hive)
  useHive((s) => s.session)
  // while our own change is in flight the store moves the goal optimistically; that is not someone else's change
  const [sending, setSending] = useState(false)
  const bound = sending ? ({ kind: 'ready' } as const) : goalBound(snap, live, to)
  const holder = seen.claimed_by ? agents[seen.claimed_by.replace(/^agent:/, '')] : null
  const holderName = holder ? shown(holder.name) : seen.claimed_by
  const verb = verbFor(to) ?? 'done'
  // "Check again" after a lost answer whose re-read failed: read the goal once more and say what it shows
  const recheck = async (): Promise<DecisionResult> => {
    const r = goalRecheckResult(await useHive.getState().reconcileGoal(seen.id), seen, to, recheck)
    if (r === true) useHive.getState().toast({ tone: 'success', title: 'The task was updated', body: 'The task was read again: the change is there.' })
    return r
  }
  // The dialog shows a not-confirmed outcome itself (the store stays quiet, so no notice covers it on a phone). Closed
  // while the goal is still unconfirmed, the way to check it again goes with the person, as a notice.
  const notice = (body: string) =>
    useHive.getState().toast({
      tone: 'error',
      title: 'Not confirmed',
      body,
      action: { label: 'Check again', run: () => void recheck().then((r) => r !== true && (typeof r === 'string' || 'failed' in r || !r.recheck ? useHive.getState().toast({ tone: 'error', title: 'Not confirmed', body: typeof r === 'string' ? r : 'failed' in r ? r.failed : r.unsettled }) : notice(r.unsettled))) },
    })
  const close = () => {
    if (useHive.getState().goalsUnsure[seen.id]) notice(`${NOT_CONFIRMED} “${seen.title}” has not been read again yet; check it before asking again.`)
    onClose()
  }
  const danger = to === 'cancelled' || to === 'failed'
  return (
    <DecisionDialog
      icon={danger ? 'alert' : 'check'}
      eyebrow={`Task · ${seen.status} → ${to}`}
      title={`${GOAL_VERB_LABEL[verb]}: “${seen.title}”?`}
      facts={[
        ['Task', seen.title],
        ['Status now', seen.status],
        ['Held by', holderName ?? 'Nobody'],
        ['Swarm', swarm ? shown(swarm.name) : seen.swarm_id],
        ['What changes', goalEffect(seen, to, holderName ?? null)],
        ['Task id', <span className="font-mono text-[12px]">{seen.id}</span>],
      ]}
      bound={bound}
      thing="This task"
      actions={[
        {
          label: GOAL_VERB_LABEL[verb],
          busyLabel: 'Changing',
          tone: danger ? 'danger' : 'primary',
          run: async () => {
            // the same binding, read again at the moment of dispatch
            const drift = goalDrift(snap, useHive.getState().goals[seen.id], to)
            if (drift) return drift
            setSending(true)
            const r = await useHive.getState().writeGoal(seen.id, { status: to }, snap.session, { quiet: true })
            if (r.kind !== 'taken') setSending(false)
            return goalWriteResult(r, recheck)
          },
        },
      ]}
      onClose={close}
      dismissLabel={dismissLabel ?? (to === 'cancelled' ? 'Keep it' : undefined)}
      restoreFocus={restoreFocus}
    />
  )
}
