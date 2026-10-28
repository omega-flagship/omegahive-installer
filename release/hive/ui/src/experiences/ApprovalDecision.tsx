import { useMemo, useState } from 'react'
import { shown } from '../lib/displayName'
import { APPROVAL_REFUSAL_UNCONFIRMED, APPROVAL_UNCONFIRMED, approvalBound, approvalSeenOf, askedAt } from '../lib/approvalDecision'
import { useHive as useStore } from '../store/store'
import { DecisionDialog, type DecisionAction } from '../ui/DecisionDialog'
import { heldForInbox, useHive, type Approval, type Decision } from './sdk'
import { takeRefusal } from '../lib/approvalRefusal'

/**
 * Review R2/R3 for experiences that answer approval requests (Cosmos, Flux): the only place an answer is given. The
 * shared DecisionDialog shows the complete exact request (never clipped), who asked and from which swarm, the skill,
 * risk, the full rule or reason, when and the request id. Focus starts on the heading; answers refuse during the arming
 * window, on a held key, while one is in flight, and while the live request no longer matches what was opened (gone,
 * answered elsewhere, or any inspected field changed); the binding is checked again at the moment of dispatch.
 * Render inside <AnimatePresence>; `seen` is the request exactly as it was when the person opened it.
 *
 * Answers go through the experience SDK's store, so the Surface preview build's hold (answers open the classic
 * approvals page) still applies here.
 */
export function ApprovalDecision({ seen: request, session, onClose, restoreFocus }: {
  seen: Approval
  /** Surface R (Kimi follow-up): the store session `seen` was read under, stamped by the opener; omitted, the session when the dialog opens. */
  session?: string
  onClose: () => void
  restoreFocus?: (opener: HTMLElement | null) => HTMLElement | null | undefined
}) {
  const seen = useMemo(() => (session === undefined ? approvalSeenOf(request) : { ...approvalSeenOf(request), session }), [request, session])
  const live = useStore((s) => s.approvals[seen.id])
  const agent = useStore((s) => s.agents[seen.agent_id])
  const swarm = useStore((s) => (agent?.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const canAnswer = useStore((s) => !!s.client?.answerApproval)
  // Surface R: re-check the binding when the store's session changes (a different client is a different hive)
  useStore((s) => s.session)
  // while our own answer is in flight the store records it; that is not someone else's answer
  const [sending, setSending] = useState(false)
  const bound = sending ? ({ kind: 'ready' } as const) : approvalBound(seen, live)
  const who = agent ? shown(agent.name) : 'A mind'
  // this dialog's own identity: a refusal the store notes for an answer is taken back by the dialog that sent it, only
  const instance = useMemo(() => ({}), [])

  const answer = (label: string, d: Decision, tone: DecisionAction['tone'], minutes?: number): DecisionAction => ({
    label,
    busyLabel: d === 'deny' || d === 'never' ? 'Refusing' : 'Approving',
    tone,
    run: async () => {
      // the same binding, read again at the moment of dispatch
      const now = approvalBound(seen, useStore.getState().approvals[seen.id])
      if (now.kind !== 'ready') return now.kind === 'gone' ? 'This request is no longer on the hive.' : now.kind === 'closed' ? now.why : `This request changed while it was open (${now.fields.join(', ')}). Close and open it again.`
      setSending(true)
      const r = await useHive.getState().decide(seen.id, d, minutes, seen.session, instance)
      // UI review S5: a surface-preview build hands the answer to the Inbox and says so; the dialog closes, claiming nothing
      if (heldForInbox(r)) return true
      if (r) return true
      setSending(false)
      // host-identity r1: the host refused this answer (403 owner_only, or 404 not_found): say so plainly, never a generic failure
      const refused = takeRefusal(seen.id, instance)
      if (refused) return { failed: refused }
      // Review B1 (commons f0818d8): the store says only that no answer was confirmed (its toast names why); a lost
      // answer is among the reasons, so this never says "Nothing changed": the person checks the request first
      return { failed: d === 'deny' || d === 'never' ? APPROVAL_REFUSAL_UNCONFIRMED : APPROVAL_UNCONFIRMED }
    },
  })

  return (
    <DecisionDialog
      icon="shield"
      eyebrow={`${seen.risk} risk · asks for you`}
      title={
        <>
          {who} asks to use <span className="font-mono">{seen.skill}</span>
        </>
      }
      facts={[
        ['Exact request', <pre className="m-0 font-mono text-[12.5px] leading-[1.45] break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{seen.command}</pre>],
        ['Why it needs you', <span className="whitespace-pre-wrap">{seen.reason || 'No rule given: this skill always needs a person.'}</span>],
        ['Asked by', <>{who} <span className="font-mono text-[12px] text-ink-3">{seen.agent_id}</span></>],
        ['Swarm', swarm ? shown(swarm.name) : agent?.swarm_id ? <span className="font-mono">{agent.swarm_id}</span> : 'No swarm'],
        ['Skill', <span className="font-mono">{seen.skill}</span>],
        ['Risk', seen.risk],
        ['Asked', <time dateTime={seen.created_at}>{askedAt(seen.created_at)}</time>],
        ['Request id', <span className="font-mono text-[12px]">{seen.id}</span>],
      ]}
      bound={bound}
      thing="This request"
      actions={[
        answer('Approve once', 'approve', 'primary'),
        answer('Deny', 'deny', 'danger'),
        // Kimi r1: every standing answer (for an hour, always, never) needs the client's answerApproval, the same gate
        ...(canAnswer ? [answer('Allow for 1 hour', 'for', 'plain', 60), answer('Always allow this', 'remember', 'plain'), answer('Never allow this', 'never', 'plain')] : []),
      ]}
      onClose={onClose}
      dismissLabel="Not now"
      restoreFocus={restoreFocus}
    />
  )
}
