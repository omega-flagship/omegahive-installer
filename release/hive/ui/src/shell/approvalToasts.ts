import { useEffect } from 'react'
import type { Approval } from '../api/types'
import { navigate } from '../lib/router'
import { hiveBus, useHive, type Toast } from '../store/store'
import { modalLayers } from '../ui/useModalContainment'
import { guideReading } from '../features/guided/reading'

/**
 * Approval toasts yield to an open modal: a decision the person is in the middle of (a DecisionDialog, a sheet) is
 * never covered or raced by a new ask. While any modal layer is open, new asks wait; when the last modal closes, one
 * toast says what arrived (the newest ask, or how many). The Inbox badge counts them all along. Pure, so it is tested.
 */
export function approvalToastQueue<T = Approval>(show: (asks: T[]) => void, modalOpen: () => boolean, every = 800) {
  let waiting: T[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  const flush = () => {
    if (modalOpen() || !waiting.length) return
    const asks = waiting
    waiting = []
    if (timer) clearInterval(timer)
    timer = null
    show(asks)
  }
  return {
    push(a: T) {
      if (!modalOpen() && !waiting.length) return show([a])
      waiting.push(a)
      if (!timer) timer = setInterval(flush, every)
    },
    flush,
    pending: () => waiting.length,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      waiting = []
    },
  }
}

/** An ask as it was queued: the approval and the store session it arrived in (Review R-B2). */
export interface QueuedAsk {
  approval: Approval
  session: string
}

/**
 * The asks that may be announced now, as the CURRENT store holds them. An ask is announced only if it was queued in the
 * session the store holds now (an id reused by a later session, or A -> B -> A, never revives it) and that store still
 * holds it as pending. What is shown comes from the store's own copy, never the queued object.
 */
export function announceable(queued: QueuedAsk[], now: { session: string; approvals: Record<string, Approval> }): Approval[] {
  const out: Approval[] = []
  for (const q of queued) {
    if (q.session !== now.session) continue
    const held = now.approvals[q.approval.id]
    if (held?.status === 'pending') out.push(held)
  }
  return out
}

/**
 * Whether the queue empties on this store change: a new session (Review R-B2), or init run again for the same client
 * (Kimi K3: a re-init re-reads the hive; asks queued before it are not announced after it).
 */
export const queueEmptiesOn = (now: { session: string; inits: number }, prev: { session: string; inits: number }): boolean => now.session !== prev.session || now.inits !== prev.inits

/**
 * Whether new asks wait now: a modal layer is open, or a guided demo's reading step is showing (html[data-guide-reading],
 * set by features/guided/GuideLayer while the person reads a viewer). The asks are not dropped: the Inbox badge counts
 * them, and when it ends one toast says what arrived, exactly as after a modal.
 */
export const asksWait = (): boolean => modalLayers.size > 0 || guideReading()

/** The toast group of approval asks: one card at a time. */
export const ASK_GROUP = 'approval-asks'

/**
 * The toast for asks that waited (or one that just arrived), as the CURRENT store holds them: null when none is still
 * pending in this session (decided or withdrawn while held, or from another person's session), or the inbox is open.
 */
export function askToast(queued: QueuedAsk[], now: Pick<ReturnType<typeof useHive.getState>, 'session' | 'approvals' | 'agents'> & { toasts?: Toast[] }, hash: string): Omit<Toast, 'id'> | null {
  const still = announceable(queued, now)
  if (!still.length || hash.startsWith('#/approvals')) return null
  const last = still[still.length - 1]
  const a = now.agents[last.agent_id]
  // an ask's card is already on screen: one card says more decisions wait (it replaces that card, never piles). No
  // number: the inbox counts them (Kimi r1 #4: a count of every pending ask could include asks this person can't act on)
  if ((now.toasts ?? []).some((t) => t.group === ASK_GROUP)) return { tone: 'info', icon: 'shield', group: ASK_GROUP, title: 'More decisions waiting', body: `The newest: ${a?.name ?? 'a mind'} asks to run ${last.skill}`, action: { label: 'Open the inbox', run: () => navigate({ name: 'approvals' }) }, ttl: 7000 }
  return still.length === 1
    ? { tone: 'info', icon: 'shield', group: ASK_GROUP, hue: a?.hue, title: `${a?.name ?? 'A mind'} asks to run ${last.skill}`, body: last.command, action: { label: 'Review', run: () => navigate({ name: 'approvals', focus: last.id }) }, ttl: 7000 }
    : { tone: 'info', icon: 'shield', group: ASK_GROUP, title: `${still.length} new asks while you were busy`, body: `The newest: ${a?.name ?? 'a mind'} asks to run ${last.skill}`, action: { label: 'Open the inbox', run: () => navigate({ name: 'approvals' }) }, ttl: 7000 }
}

/** A new approval raises a toast that opens the inbox (unless the inbox is already open, or a modal is). */
export function useApprovalToasts(): void {
  useEffect(() => {
    const q = approvalToastQueue<QueuedAsk>(
      (queued) => {
        // an ask decided while it waited is not announced, nor one from another session (Review R-B1/R-B2)
        const s = useHive.getState()
        const t = askToast(queued, s, window.location.hash)
        if (t) s.toast(t)
      },
      asksWait,
    )
    const off = hiveBus.on((e) => {
      if (e.type !== 'approval.created' || e.approval.status !== 'pending') return
      if (window.location.hash.startsWith('#/approvals')) return
      q.push({ approval: e.approval, session: useHive.getState().session })
    })
    // a new session, or a fresh init of the same client, empties the queue: nothing waiting from before is announced
    const offSession = useHive.subscribe((st, prev) => {
      if (queueEmptiesOn(st, prev)) q.stop()
    })
    return () => {
      off()
      offSession()
      q.stop()
    }
  }, [])
}
