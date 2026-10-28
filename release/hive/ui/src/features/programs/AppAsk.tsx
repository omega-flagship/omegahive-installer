import { useEffect, useRef, useState, type RefObject } from 'react'
import type { HiveClient } from '../../api/client'
import type { AppAskCard, AppAskRelease } from '../../api/appAsk'
import { AppAskController, parseAppAsk, type AppAskPort, type AppAskState } from '../../lib/appAsk'
import { askConfirmBound, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import { appAskOwnerCurrent, offerAppAsk, recordAppAsk, trackAppAsk } from '../../store/appAsk'
import { useAskStore } from '../../store/ask'
import { DecisionDialog } from '../../ui/DecisionDialog'
import type { AppLinkEntry } from '../../lib/appLinks'

function portFor(client: HiveClient, entry?: AppLinkEntry, entryFrame?: () => Promise<string | null>): AppAskPort | null {
  const names = ['programAskCard', 'programAskConsent', 'programAskRevoke', 'programAskFrame', 'programAskPresence', 'programAskClose', 'programAskOp', 'askPresentation', 'askClaim', 'askHandover'] as const
  if (!names.every((name) => typeof client[name] === 'function')) return null
  let entryAvailable = !!entry && !!client.appLinkEntryCard && !!client.appLinkRedeem
  return {
    programAskCard: (app) => entryAvailable && entry?.app === app ? client.appLinkEntryCard!(entry.id) : client.programAskCard!(app), programAskConsent: (app, body) => client.programAskConsent!(app, body),
    programAskRevoke: (app) => client.programAskRevoke!(app), programAskFrame: async (app, body) => {
      if (entryAvailable && entry?.app === app) {
        entryAvailable = false // consumed locally before awaiting; never retry an unknown redemption
        if (body.initial_operation_id) throw new Error("A caller turn cannot be carried into an app entry")
        if (!entryFrame || !await entryFrame()) throw new Error("This document has no current host frame")
        return client.appLinkRedeem!(entry.id, { release_digest: body.release_digest, frame_slot_id: body.frame_slot_id })
      }
      return client.programAskFrame!(app, body)
    },
    programAskPresence: (app, generation) => client.programAskPresence!(app, generation), programAskClose: (app, generation) => client.programAskClose!(app, generation),
    programAskOp: (app, generation, body) => client.programAskOp!(app, generation, body),
    askPresentation: (op) => client.askPresentation!(op), askClaim: (op, body) => client.askClaim!(op, body), askHandover: (op, body) => client.askHandover!(op, body),
  }
}
/** The parent measures its actual stage. A frame's visible:true is only a request, never visibility proof. */
export function appAskVisible(frame: HTMLIFrameElement | null): boolean {
  if (!frame?.isConnected || document.visibilityState !== 'visible' || frame.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let node: Element | null = frame; node; node = node.parentElement) {
    const css = getComputedStyle(node)
    if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) return false
  }
  const r = frame.getBoundingClientRect(), style = getComputedStyle(frame)
  if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || style.visibility !== 'visible' || style.display === 'none') return false
  // A routed stage or opaque overlay covering the frame cannot silently renew presence behind it.
  const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2))
  return document.elementFromPoint(x, y) === frame
}
interface ConsentQuestion { card: AppAskCard; resolve(value: boolean): void }
const initialState: AppAskState = { active: false, reason: null, resumable: [] }
export function useAppAsk(input: {
  client: HiveClient | null; app: string; appName: string; channel: string | null
  release: AppAskRelease | null; binding: EpochBinding | null; frame: RefObject<HTMLIFrameElement | null>
  person: boolean; documentReady: boolean; autoOpen?: boolean; entry?: AppLinkEntry; entryFrame?(): Promise<string | null>; post(value: object): void; active(value: boolean): void
}) {
  const controller = useRef<AppAskController | null>(null)
  const latest = useRef(input); latest.current = input
  const [state, setState] = useState<AppAskState>(initialState)
  const [question, setQuestion] = useState<ConsentQuestion | null>(null)
  const questionNow = useRef<ConsentQuestion | null>(null)
  const approved = useRef(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const currentOperation = useAskStore((s) => s.open)
  const early = useRef<{ data: unknown; channel: string; timer: number; resolve(value: object | null): void } | null>(null)
  const clearEarly = () => { const pending = early.current; early.current = null; if (pending) { window.clearTimeout(pending.timer); pending.resolve(null) } }
  useEffect(() => clearEarly, [])
  const available = !!input.client && !!input.channel && !!input.release && !!input.binding && input.person && input.documentReady && !!portFor(input.client)
  useEffect(() => {
    const { client, release, binding, channel, frame, app } = input
    if (!available || !client || !release || !binding || !channel) return
    const port = portFor(client, input.entry, input.entryFrame)!
    let live = true
    setBusy(false); setNote(null); setState(initialState); setQuestion(null); approved.current = false
    const current = () => binding.current()
    const c = new AppAskController({
      app, digest: release.digest, slot: channel, channel, port,
      clock: { now: () => performance.now(), later: (fn, ms) => window.setTimeout(fn, ms), cancel: (id) => window.clearTimeout(id as number) },
      current, visible: () => appAskVisible(frame.current),
      confirm: (card) => new Promise<boolean>((resolve) => {
        if (!live || !current() || questionNow.current) return resolve(false)
        approved.current = false
        const q = { card, resolve }; questionNow.current = q; setQuestion(q)
      }),
      confirmHandoff: () => askConfirmBound(`Show this Ask in ${latest.current.appName}? You can return it here at any time.`, 'Show in app', { binding }),
      hostOperation: () => useAskStore.getState().open,
      state: (next) => {
        if (!live) return
        setState(next); latest.current.active(next.active)
      },
      post: (value) => { if (live && current()) latest.current.post(value) },
      presentation: (p, owner, text) => {
        if (!current() || !recordAppAsk({ app, appName: latest.current.appName, presentation: p, controller: owner, port, current, offeredLocally: false })) return false
        return useAskStore.getState().adoptAppTurn(p.operation_id, p.turn_id, text)
      },
      owns: appAskOwnerCurrent,
      offered: offerAppAsk,
      track: (operation) => trackAppAsk(operation, current),
    })
    controller.current = c
    if (input.entry || input.autoOpen) void c.open().catch(() => undefined) // real host pass, never a fabricated frame presence
    const pending = early.current; early.current = null
    if (pending) {
      window.clearTimeout(pending.timer)
      if (pending.channel === channel && current()) void c.receive(pending.data).then(pending.resolve)
      else pending.resolve(null)
    }
    const hidden = () => c.visibilityChanged()
    const leaving = () => c.fence()
    const off = onIdentityChange(() => {
      c.fence(); latest.current.active(false); setState(initialState)
      setBusy(false); setNote(null)
      clearEarly()
      questionNow.current?.resolve(false); questionNow.current = null; setQuestion(null)
    })
    const observer = new MutationObserver(hidden)
    for (let node: Element | null = frame.current; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] })
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', leaving)
    window.addEventListener('resize', hidden)
    window.addEventListener('scroll', hidden, true)
    return () => {
      // Fence before teardown; no old message, promise, timer or pending chunk can use a later frame.
      c.dispose(); live = false; controller.current = null
      clearEarly()
      questionNow.current?.resolve(false); questionNow.current = null
      setQuestion(null); approved.current = false
      off(); observer.disconnect(); document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', leaving); window.removeEventListener('resize', hidden); window.removeEventListener('scroll', hidden, true)
      latest.current.active(false)
    }
    // The live callbacks read latest; only a new document/release/identity/client installs a new authority scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.client, input.channel, input.release?.digest, input.binding, input.app, input.autoOpen, available])
  const run = async (action: (c: AppAskController) => Promise<void>) => {
    const c = controller.current
    if (!c || busy) return
    setBusy(true); setNote(null)
    try { await action(c) } catch { if (controller.current === c && latest.current.binding?.current()) setNote('Could not confirm this change. Check again before asking for another action.') }
    finally { if (controller.current === c && latest.current.binding?.current()) setBusy(false) }
  }
  const closeQuestion = () => {
    const q = questionNow.current, yes = approved.current
    questionNow.current = null; setQuestion(null)
    // Consent is consumed only after the host modal/inert layer has been removed and the stage can be measured.
    if (q) window.requestAnimationFrame(() => q.resolve(yes))
  }
  const controls = available ? <>
    <div className="absolute right-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-2 text-xs shadow-sm" data-app-ask-controls>
      <span className="px-2 py-2 font-medium" role="status">{busy ? 'Checking…' : state.active ? 'Ask in this app' : 'Your Ask'}</span>
      <button type="button" className="rounded-lg px-3 py-2 focus-visible:outline focus-visible:outline-2" disabled={busy || !currentOperation} onClick={() => void run((c) => c.showCurrent())}>Show current Ask here</button>
      <button type="button" className="rounded-lg px-3 py-2 focus-visible:outline focus-visible:outline-2" disabled={busy} onClick={() => void run((c) => c.revoke())}>Turn off Ask access</button>
      {note && <p role="status" className="max-w-sm px-2">{note}</p>}
    </div>
    {question && <DecisionDialog icon="apps" eyebrow="Your Ask" title={`Let ${question.card.name} use your Ask?`}
      facts={[
        ['App', question.card.name], ['Version', question.card.version], ['Release', question.card.release_digest],
        ['Permission', 'May send to and show your Ask while open.'],
        ['Your choice', 'You can return to Ask at any time or turn this access off.'],
        ['May ask to set up', question.card.related_apps?.join(', ') || 'No related apps declared'],
      ]}
      bound={{ kind: 'ready' }} thing="This permission" dismissLabel="Not now" onClose={closeQuestion}
      actions={[{ label: 'Allow', busyLabel: 'Allowing', tone: 'primary', run: async () => { approved.current = true; return true } }]} />}
  </> : null
  const receive = (data: unknown): Promise<object | null> => {
    if (controller.current) return controller.current.receive(data)
    const m = parseAppAsk(data), now = latest.current
    // A single early presence handshake may cross the iframe's initial load event. Bound it to this document,
    // one8KiB message and1s; it cannot create authority before the verified load and named-person checks settle.
    if (!early.current && m?.ok && m.request.type === 'presence' && m.request.visible === true && now.person && now.release && now.channel && now.binding?.current()) return new Promise((resolve) => {
      const pending = { data, channel: now.channel!, timer: 0, resolve }
      pending.timer = window.setTimeout(() => { if (early.current === pending) { early.current = null; resolve(null) } }, 1000)
      early.current = pending
    })
    return Promise.resolve(null)
  }
  const ensureEntry = async (): Promise<boolean> => {
    const channel = latest.current.channel, until = performance.now() + 1000
    while (!controller.current && latest.current.channel === channel && latest.current.binding?.current() && performance.now() < until) await new Promise<void>(resolve => window.setTimeout(resolve, 10))
    const c = controller.current
    if (!c || latest.current.channel !== channel) return false
    try { await c.open(); return controller.current === c && latest.current.channel === channel && c.active() } catch { return false }
  }
  return { controls, receive, ensureEntry, fence: () => { clearEarly(); controller.current?.fence() }, active: state.active }
}
