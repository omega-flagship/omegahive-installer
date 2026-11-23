/**
 * Purpose: wake an asleep Research swarm and send the research request it held back, on one press of the person's,
 * offered only where that press can go through, keeping how each such request stands for the answer it sits under
 * (features/ask/answer.metta).
 *
 * The host refuses a research request as researcher_asleep when the Research swarm's coordinator is stopped
 * (hive/core/research.py admit), and keeps the refused intent. Before any press, a check reads that intent back and
 * inspects the coordinator as the press will (askAutoWake's nativeWakePorts, with no wake, and wakeStep: the host's
 * authority rule), so the press is offered only while the coordinator is awake or the person may wake it, and otherwise
 * the person is told who can; the check runs again once the coordinator's status moves on. One press reads the intent
 * back, wakes the coordinator through the Ask's own wake (WakeBeforeSend: wait until it is awake), then submits the same
 * intent, which the host sends as it was stored (ask_intents.submit). Nothing wakes or sends without the press: a
 * conducted turn still wakes nothing first.
 */
import { readAsleepResearch } from '../api/ask'
import { ApiError, type HiveClient } from '../api/client'
import type { Agent } from '../api/types'
import { bindEpoch, onIdentityChange } from '../lib/identityEpoch'
import { nativeWakePorts, WakeBeforeSend, wakeStep, type NativeWakeClient, type WakeGate } from './askAutoWake'

/**
 * How one held-back research request stands on this page. checking: reading whether a press could send it (nothing is
 * offered yet); ready: not pressed, and a press can send it (or the page couldn't tell, and the press reads again);
 * working: reading it back, waking the coordinator or sending; sent: the host took it; blocked: the person may not wake
 * the coordinator now (gate), or it can't be woken; failed: the wake or the send didn't go through (pressing again tries
 * once more).
 */
export type ResearchWakePhase = 'checking' | 'ready' | 'working' | 'sent' | 'blocked' | 'failed'
export interface ResearchWakeView {
  phase: ResearchWakePhase
  /** the coordinator, by name, once read */
  name?: string
  /** the coordinator's id, once read */
  mind?: string
  /**
   * the coordinator's status this view stands on: the page's own (its live minds) when the check began, else the one
   * read; a check runs again once the page's moves on from it
   */
  status?: string
  /** what a press does now, as last read: wake the coordinator first, or only send (it is awake or already starting) */
  press?: 'wake' | 'send'
  step?: 'inspecting' | 'waking' | 'sending'
  gate?: WakeGate
  /** the host's reason a wake failed (its start refusal or the mind's last error), when it gave one */
  reason?: string
  /** the coordinator woke but the request was not taken, or the intent can no longer be sent from here */
  unsent?: 'send' | 'gone'
}

export type ResearchWakeClient = NativeWakeClient & Pick<HiveClient, 'askIntent' | 'askSubmitIntent'>

/** What was read of the coordinator, which each later view of the same request carries on. */
type Coordinator = Pick<ResearchWakeView, 'name' | 'mind' | 'status'>
const carried = (v: ResearchWakeView | undefined): Coordinator => ({
  ...(v?.name ? { name: v.name } : {}), ...(v?.mind ? { mind: v.mind } : {}), ...(v?.status ? { status: v.status } : {}),
})
const coordinator = (m: Pick<Agent, 'id' | 'name' | 'status'>, live?: string): Coordinator =>
  ({ name: m.name.slice(0, 60), mind: m.id, status: live ?? m.status })

const views = new Map<string, ResearchWakeView>()
const listeners = new Set<() => void>()
const publish = () => {
  for (const l of listeners) l()
}

onIdentityChange(() => {
  views.clear()
  publish()
})

export const askResearchWake = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  view(intent: string): ResearchWakeView | null {
    return views.get(intent) ?? null
  },
  /**
   * Before any press: whether a press can send it now, read as the press reads (the intent, then the coordinator, with
   * no wake), so the press is offered only where it can go through and otherwise the person is told who can wake the
   * coordinator. `live` is the coordinator's status as the page holds it now (the hive's agent.updated events): once it
   * differs from the status a ready or blocked view stands on, the check runs again (someone else woke or stopped the
   * coordinator), and each check stands on the page's status it began with, so a page out of step with the hive reads
   * at most once more per change. A press, once started, is never overwritten by a check; a sign-in change drops it.
   */
  async check(intent: string, client: ResearchWakeClient | null | undefined, principal: string | null | undefined, live?: string): Promise<void> {
    const was = views.get(intent)
    const again = (was?.phase === 'ready' || was?.phase === 'blocked') && !!live && live !== was.status
    if ((was && !again) || !client || !principal) return
    const binding = bindEpoch()
    // the view this check stands on: a first check shows nothing until it has read; a check again leaves what shows
    const from: ResearchWakeView = was ?? { phase: 'checking' }
    if (!was) binding.commit(() => {
      views.set(intent, from)
      publish()
    })
    const settle = (v: ResearchWakeView) => {
      binding.commit(() => {
        if (views.get(intent) !== from) return
        views.set(intent, v)
        publish()
      })
    }
    // the press couldn't send it either
    if (!client.askIntent || !client.askSubmitIntent) return settle({ phase: 'failed', unsent: 'gone' })
    const read = await client.askIntent(intent).then((v) => ({ held: readAsleepResearch(v) }), () => null)
    if (!binding.current()) return
    let who: Coordinator = { ...carried(was), ...(live ? { status: live } : {}) }
    // a read that failed tells nothing: the press is offered, and reads again
    if (!read) return settle({ phase: 'ready', ...who })
    // already sent elsewhere, closed, or refused for another reason now
    if (!read.held) return settle({ phase: 'failed', unsent: 'gone' })
    const ports = nativeWakePorts({
      client, principal, context: { swarm_id: read.held.swarm },
      current: binding.current,
      send: () => Promise.reject(new Error('a check never sends')),
      phase: () => undefined,
      target: (mind) => {
        who = coordinator(mind, live)
      },
    })
    let step
    try {
      step = wakeStep(await ports.inspect())
    } catch (e) {
      if (!binding.current()) return
      // a person the hive won't show the coordinator to, or won't let act on it, may not wake it; anything else tells
      // nothing, so the press is offered and reads again
      return settle(e instanceof ApiError && (e.status === 403 || e.status === 404) ? { phase: 'blocked', gate: 'authority', ...who } : { phase: 'ready', ...who })
    }
    if (!binding.current()) return
    switch (step.kind) {
      case 'send':
      case 'wait':
        return settle({ phase: 'ready', press: 'send', ...who })
      case 'wake':
        return settle({ phase: 'ready', press: 'wake', ...who })
      case 'gated':
        return settle({ phase: 'blocked', gate: step.gate, ...who })
      case 'unavailable':
        return settle({ phase: 'blocked', ...who })
    }
  },
  /**
   * The press: at most one at a time per intent, and never while a check reads it, once the host took it, or while the
   * person may not wake the coordinator. Every write is bound to the person who pressed (a sign-in change drops it).
   */
  async press(intent: string, client: ResearchWakeClient | null | undefined, principal: string | null | undefined): Promise<void> {
    const was = views.get(intent)
    if (was && was.phase !== 'ready' && was.phase !== 'failed') return
    const binding = bindEpoch()
    let who = carried(was)
    const show = (v: ResearchWakeView) => {
      binding.commit(() => {
        views.set(intent, { ...v, ...who })
        publish()
      })
    }
    show({ phase: 'working', step: 'inspecting' })
    if (!client?.askIntent || !client.askSubmitIntent || !principal) return show({ phase: 'failed', unsent: 'gone' })
    const read = client.askIntent
    const submit = client.askSubmitIntent
    // a read that fails is a request that can't be sent from here now
    const held = await read(intent).then(readAsleepResearch, () => null)
    if (!binding.current()) return
    // already sent elsewhere, closed, or refused for another reason now: nothing is woken for it
    if (!held) return show({ phase: 'failed', unsent: 'gone' })
    const attempt = new WakeBeforeSend(nativeWakePorts({
      client, principal, context: { swarm_id: held.swarm },
      current: binding.current,
      send: () => submit(intent),
      phase: (step) => show({ phase: 'working', step }),
      target: (mind) => {
        who = coordinator(mind)
      },
    }))
    const result = await attempt.run()
    if (!binding.current()) return
    switch (result.kind) {
      case 'sent':
        return show({ phase: 'sent' })
      case 'gated':
        return show({ phase: 'blocked', gate: result.gate })
      case 'wake-failed':
        return show({ phase: 'failed', ...(result.detail ? { reason: result.detail } : {}) })
      case 'send-error':
        return show({ phase: 'failed', unsent: 'send' })
      case 'stale':
        views.delete(intent)
        publish()
    }
  },
}
