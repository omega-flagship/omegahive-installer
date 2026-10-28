import { useEffect, useRef, useState } from 'react'
import type { HiveClient } from '../../api/client'
import { STALE, type EpochBinding, type Stale } from '../../lib/identityEpoch'
import {
  parseAppLinkRequest, readAppLinkAnswer, readAppPresentation,
  type AppLinkAnswer, type AppLinkEntry, type AppLinkRequest, type AppLinkResult,
  type AppPresentation,
} from '../../lib/appLinks'
import { DecisionDialog, type DecisionResult } from '../../ui/DecisionDialog'
import { PersonSwarmCardDetails } from './PersonSwarmConsent'

interface Waiter { request: AppLinkRequest | null; resolve(result: object | null): void }
interface Question {
  answer: AppLinkAnswer; frame: string; waiters: Waiter[]; back: boolean
  completion?: { result: AppLinkResult; entry?: AppLinkEntry; snapshot?: AppPresentation | null }
  deciding: boolean
}
const unavailable = (): AppLinkResult => ({ state: 'refused', reason: 'not_available' })
const wire = (request: AppLinkRequest, result: AppLinkResult) => ({ type: `${request.type}-result`, id: request.id, ...result })
const methods = ['appLinkFrame', 'appLinkClose', 'appLinkPrepare', 'appLinkInspect', 'appLinkDecide', 'appLinkEntryCard', 'appLinkRedeem', 'appLinkCheck'] as const

/** Only the real parent invokes this hook. Frame data supplies a target id and
 * optional untrusted text; every name, model, price and permission below comes
 * from authenticated, release-checked host responses. */
export function useAppLinks(input: {
  client: HiveClient | null; app: string; swarm: string; channel: string | null
  binding: EpochBinding | null; person: boolean; documentReady: boolean; entry?: AppLinkEntry
  current(): boolean; visible(): boolean; modal(): boolean; post(value: object): void
  navigate(entry: AppLinkEntry, intent: string | undefined, snapshot: AppPresentation | null, back: boolean): void
}) {
  const latest = useRef(input); latest.current = input
  const frame = useRef<string | null>(null)
  const registration = useRef<Promise<string | null> | null>(null)
  const handoff = useRef<string | undefined>(undefined)
  const live = useRef(false)
  const question = useRef<Question | null>(null)
  const [shown, setShown] = useState<Question | null>(null)
  const capture = useRef<{ id: string; resolve(value: AppPresentation | null): void; timer: number } | null>(null)
  const available = !!input.client && input.client.mode === 'live' && methods.every(name => typeof input.client?.[name] === 'function') && !!input.channel && !!input.binding && input.person && input.documentReady
  const current = (fid?: string) => live.current && latest.current.current() && !!latest.current.binding?.current() && (!fid || frame.current === fid)
  const finishWaiters = (q: Question, result: AppLinkResult) => {
    for (const waiter of q.waiters) waiter.resolve(waiter.request ? wire(waiter.request, result) : null)
    q.waiters.length = 0
  }
  const clearCapture = () => {
    const old = capture.current; capture.current = null
    if (old) { clearTimeout(old.timer); old.resolve(null) }
  }
  useEffect(() => {
    if (!available || !input.client || !input.channel || !input.binding) return
    const { client, app, swarm, channel, binding, entry } = input
    let alive = true
    live.current = true; handoff.current = undefined
    const promise = client.appLinkFrame!(app, { swarm_id: swarm, frame_slot_id: channel, ...(entry ? { entry_id: entry.id } : {}) }).then(value => {
      const id = value && typeof value === 'object' && Object.keys(value).join(',') === 'frame_id' ? (value as { frame_id?: unknown }).frame_id : null
      if (typeof id !== 'string' || !/^[\w.:-]{1,80}$/.test(id)) return null
      if (!alive || !binding.current()) { void client.appLinkClose!(app, id, {}).catch(() => undefined); return null }
      frame.current = id
      return id
    }).catch(() => null)
    registration.current = promise
    return () => {
      alive = false; live.current = false; frame.current = null; registration.current = null
      clearCapture()
      const q = question.current; question.current = null; setShown(null)
      if (q) finishWaiters(q, { state: 'declined' })
      const permitted = handoff.current
      void promise.then(id => id && client.appLinkClose!(app, id, permitted ? { handoff: permitted } : {}).catch(() => undefined))
    }
  }, [available, input.client, input.app, input.swarm, input.channel, input.binding, input.entry?.id])

  useEffect(() => {
    if (!shown?.answer.review || !input.client) return
    const client = input.client, app = input.app, q = shown
    let alive = true, timer: number | undefined
    const inspect = async () => {
      if (!alive || !current(q.frame) || question.current !== q || q.deciding) return
      try {
        const result = readAppLinkAnswer(await client.appLinkInspect!(app, q.frame, q.answer.review!.id))
        if (!alive || !current(q.frame) || question.current !== q) return
        if (!result || result.result) {
          q.completion = { result: result?.result ?? { state: 'declined' } }
          question.current = null; setShown(null)
          finishWaiters(q, q.completion.result)
          return
        }
      } catch {
        if (alive && question.current === q) {
          question.current = null; setShown(null); finishWaiters(q, { state: 'declined' })
        }
        return
      }
      timer = window.setTimeout(() => void inspect(), 500)
    }
    timer = window.setTimeout(() => void inspect(), 500)
    return () => { alive = false; clearTimeout(timer) }
  }, [shown, input.client, input.app])

  const snapshot = (): Promise<AppPresentation | null> => {
    if (!current()) return Promise.resolve(null)
    clearCapture()
    return new Promise(resolve => {
      const id = crypto.randomUUID()
      const timer = window.setTimeout(() => { if (capture.current?.id === id) { capture.current = null; resolve(null) } }, 250)
      capture.current = { id, resolve, timer }
      latest.current.post({ type: 'presentation-snapshot', id })
    })
  }
  const presentation = (data: unknown): boolean => {
    if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'presentation-state') return false
    const m = data as Record<string, unknown>, old = capture.current
    if (!old || !current() || m.id !== old.id || Object.keys(m).some(k => !['type', 'id', 'channel', 'version', 'state'].includes(k))) return true
    const value = readAppPresentation({ version: m.version, state: m.state })
    clearTimeout(old.timer); capture.current = null; old.resolve(value)
    return true
  }
  const begin = (answer: AppLinkAnswer, fid: string, waiter: Waiter, back: boolean) => {
    const prior = question.current
    if (answer.review && prior?.answer.review?.id === answer.review.id) { prior.waiters.push(waiter); return }
    if (prior) {
      if (answer.review) void latest.current.client!.appLinkDecide!(latest.current.app, fid, answer.review.id, { approve: false, open_now: false }).catch(() => undefined)
      waiter.resolve(waiter.request ? wire(waiter.request, { state: 'refused', reason: 'busy' }) : null)
      return
    }
    if (answer.result && !answer.notice) { waiter.resolve(waiter.request ? wire(waiter.request, answer.result) : null); return }
    const q: Question = { answer, frame: fid, waiters: [waiter], back, deciding: false }
    question.current = q; setShown(q)
  }
  const receive = (data: unknown): Promise<object | null> | null => {
    const parsed = parseAppLinkRequest(data)
    if (!parsed) return null
    if (!parsed.ok) return Promise.resolve(parsed.id ? { type: `${parsed.type}-result`, id: parsed.id, ...unavailable() } : null)
    const request = parsed.msg
    return new Promise(resolve => {
      if (!available || !current()) return resolve(wire(request, unavailable()))
      if (!latest.current.visible() && !question.current) return resolve(wire(request, { state: 'refused', reason: 'depth' }))
      if (latest.current.modal() && !question.current) return resolve(wire(request, { state: 'refused', reason: 'busy' }))
      void registration.current?.then(async fid => {
        if (!fid || !current(fid)) return resolve(wire(request, unavailable()))
        try {
          const answer = readAppLinkAnswer(await latest.current.client!.appLinkPrepare!(latest.current.app, fid, { type: request.type, app: request.app }))
          if (!current(fid)) return resolve(null)
          if (!answer || answer.review && (answer.review.target !== request.app || answer.review.kind !== request.type)) {
            begin({ result: unavailable(), notice: 'This app request is unavailable.' }, fid, { request, resolve }, false)
            return
          }
          begin(answer, fid, { request, resolve }, false)
        } catch {
          if (current(fid)) begin({ result: unavailable(), notice: 'This app request is unavailable.' }, fid, { request, resolve }, false)
          else resolve(null)
        }
      })
      if (!registration.current) resolve(wire(request, unavailable()))
    })
  }
  const decide = async (q: Question, openNow: boolean): Promise<DecisionResult | Stale> => {
    // A retired or duplicate callback cannot settle this dialog or a newer card.
    if (!q.answer.review || q.deciding || question.current !== q || !current(q.frame)) return STALE
    q.deciding = true
    try {
      const answer = readAppLinkAnswer(await latest.current.client!.appLinkDecide!(latest.current.app, q.frame, q.answer.review.id, { approve: true, open_now: openNow }))
      if (!current(q.frame) || question.current !== q) return STALE
      if (!answer?.result || answer.entry && answer.entry.app !== q.answer.review.target) {
        q.completion = { result: unavailable() }; return true
      }
      const saved = answer.entry && !q.back ? await snapshot() : null
      if (!current(q.frame) || question.current !== q) return STALE
      q.completion = { result: answer.result, entry: answer.entry, snapshot: saved }
      return true
    } catch {
      if (!current(q.frame) || question.current !== q) return STALE
      q.completion = { result: unavailable() }
      return true
    } finally { q.deciding = false }
  }
  const closeQuestion = () => {
    const q = question.current; question.current = null; setShown(null)
    if (!q) return
    const completed: NonNullable<Question['completion']> = q.completion ?? { result: q.answer.result ?? { state: 'declined' as const } }
    if (!q.completion && q.answer.review && current()) void latest.current.client!.appLinkDecide!(latest.current.app, q.frame, q.answer.review.id, { approve: false, open_now: false }).catch(() => undefined)
    const first = q.waiters[0]?.request
    const intent = first?.type === 'app-open' ? first.intent : undefined
    finishWaiters(q, completed.result)
    if (completed.entry) {
      const entry = completed.entry
      // Remove the modal/inert layer first; the next frame's P1 visibility check
      // must measure the actual stage. This is a one-shot host continuation.
      handoff.current = entry.id
      window.requestAnimationFrame(() => { if (current(q.frame)) latest.current.navigate(entry, intent, completed.snapshot ?? null, q.back) })
    }
  }
  const review = shown?.answer.review
  const facts: [string, string][] = review ? [
    ['Asked by', review.caller_name], ['App', review.target_name], ['Version', review.version], ['Release', review.release_digest],
    ['Permission', review.session_permission], ['May ask to set up', review.related_apps.join(', ') || 'No related apps declared'],
    ...(review.template ? [
      ['Consent revision', review.approved_revision ?? JSON.stringify(review.template.consent_revision)],
      ['Price guide', review.price_guide.join('; ')],
    ] as [string, string][] : []),
    ...(review.kind === 'app-setup' ? [['Open now', 'Only “Set up and open now” starts the first session; later sessions use the normal host card.']] as [string, string][] : []),
  ] : []
  const controls = shown ? <DecisionDialog icon="apps" eyebrow="Your apps"
    title={review ? review.kind === 'app-setup' ? `${review.caller_name} is asking to set up ${review.target_name}` : `Open ${review.target_name}?` : shown.answer.notice ?? 'This app request is unavailable'}
    facts={facts} thing="This app request" bound={{ kind: 'ready' }} dismissLabel={review ? 'Cancel' : 'Close'} onClose={closeQuestion}
    actions={review ? review.kind === 'app-setup' ? [
      { label: 'Set up', busyLabel: 'Setting up', tone: 'primary', run: () => decide(shown, false) },
      { label: 'Set up and open now', busyLabel: 'Setting up', tone: 'primary', run: () => decide(shown, true) },
    ] : [{ label: 'Open', busyLabel: 'Opening', tone: 'primary', run: () => decide(shown, true) }] : []}>
      {review?.template && <div className="rounded-lg bg-white p-3 text-[#1f1f24]"><PersonSwarmCardDetails card={review.template} /></div>}
    </DecisionDialog> : null
  return { controls, receive, presentation, ready: () => registration.current ?? Promise.resolve(null),
    prepareHandoff: (entry: AppLinkEntry) => { handoff.current = entry.id },
    cancel: () => { clearCapture(); const q = question.current; question.current = null; setShown(null); if (q) finishWaiters(q, { state: 'declined' }) },
  }
}
