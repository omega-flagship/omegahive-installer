/**
 * Purpose: wake an asleep Research swarm and send the research request it held back, on one press of the person's,
 * keeping how each such press stands for the answer it sits under (features/ask/answer.metta).
 *
 * The host refuses a research request as researcher_asleep when the Research swarm's coordinator is stopped
 * (hive/core/research.py admit), and keeps the refused intent. One press reads that intent back, wakes the coordinator
 * through the Ask's own wake (askAutoWake's WakeBeforeSend and nativeWakePorts: the host's authority rule, wait until it
 * is awake), then submits the same intent, which the host sends as it was stored (ask_intents.submit). Nothing wakes or
 * sends without the press: a conducted turn still wakes nothing first.
 */
import { readAsleepResearch } from '../api/ask'
import type { HiveClient } from '../api/client'
import { bindEpoch, onIdentityChange } from '../lib/identityEpoch'
import { nativeWakePorts, WakeBeforeSend, type NativeWakeClient, type WakeGate } from './askAutoWake'

/**
 * How one held-back research request stands on this page. ready: not pressed (or a press that changed nothing);
 * working: reading it back, waking the coordinator or sending; sent: the host took it; blocked: the person may not wake
 * the coordinator now (gate); failed: the wake or the send didn't go through (pressing again tries once more).
 */
export type ResearchWakePhase = 'ready' | 'working' | 'sent' | 'blocked' | 'failed'
export interface ResearchWakeView {
  phase: ResearchWakePhase
  /** the coordinator, by name, once read */
  name?: string
  step?: 'inspecting' | 'waking' | 'sending'
  gate?: WakeGate
  /** the host's reason a wake failed (its start refusal or the mind's last error), when it gave one */
  reason?: string
  /** the coordinator woke but the request was not taken, or the intent can no longer be sent from here */
  unsent?: 'send' | 'gone'
}

export type ResearchWakeClient = NativeWakeClient & Pick<HiveClient, 'askIntent' | 'askSubmitIntent'>

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
   * The press: at most one at a time per intent, and never again once the host took it or the person may not wake the
   * coordinator. Every write is bound to the person who pressed (a sign-in change drops it).
   */
  async press(intent: string, client: ResearchWakeClient | null | undefined, principal: string | null | undefined): Promise<void> {
    const now = views.get(intent)?.phase
    if (now === 'working' || now === 'sent' || now === 'blocked') return
    const binding = bindEpoch()
    let name: string | undefined
    const show = (v: ResearchWakeView) => {
      binding.commit(() => {
        views.set(intent, { ...v, ...(name ? { name } : {}) })
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
        name = mind.name.slice(0, 60)
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
