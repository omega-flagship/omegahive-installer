import { createPortal } from 'react-dom'
import { plural } from '../../lib/plural'
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { formatPersonSwarmUSD as usd, P2_SAVED, type PersonSwarmCard } from '../../api/personSwarms'
import { accepts, ARM_MS } from '../../lib/decisionGate'
import { bindEpoch } from '../../lib/identityEpoch'
import { useIdentityEpoch } from '../../lib/epochBound'
import { useEscape, useReducedMotion } from '../../lib/hooks'
import { PersonSwarmConsent, type PersonSwarmState } from '../../lib/personSwarmConsent'
import { registerPersonSwarmHost } from '../../lib/personSwarmAct'
import { useHive } from '../../store/store'
import { useModalContainment } from '../../ui/useModalContainment'

const EMPTY: PersonSwarmState = { kind: 'hidden' }
const emptySubscribe = () => () => undefined
const emptySnapshot = () => EMPTY

/** Mounted by the host page, outside AppFrame, with a new lifetime on each page/source/identity generation. */
export function PersonSwarmConsentHost({ programId, swarmId, generation, spaceLine, onSettle }: {
  programId: string; swarmId: string | null; generation: string
  /** P14 first open: a display-only "your space" line above the unchanged card (never a consent field). */
  spaceLine?: string
  onSettle?: (kind: 'saved' | 'declined') => void
}) {
  const client = useHive((s) => s.client)
  const epoch = useIdentityEpoch()
  const scope = `${epoch}\0${programId}\0${generation}`
  const [host, setHost] = useState<{ scope: string; controller: PersonSwarmConsent } | null>(null)
  const settle = useRef(onSettle)
  useLayoutEffect(() => { settle.current = onSettle }, [onSettle])
  useLayoutEffect(() => {
    if (!client) return
    let mounted = true
    const binding = bindEpoch()
    const current = () => mounted && binding.current() && useHive.getState().client === client
    const controller = new PersonSwarmConsent(client, programId, current)
    controller.onSettle = (kind) => settle.current?.(kind)
    const off = registerPersonSwarmHost({ client, program: programId, swarm: swarmId, current, consentRequired: () => { void controller.check(true) } })
    setHost({ scope, controller })
    void controller.check()
    return () => { mounted = false; off(); controller.dispose() }
  }, [client, scope, programId, swarmId])
  const controller = host?.scope === scope ? host.controller : null
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  if (!controller || state.kind === 'hidden' || state.kind === 'loading') return null
  return <PersonSwarmConsentDialog state={state} controller={controller} spaceLine={spaceLine} />
}

/** Shared presentation only. Consent, generation, arming and persistence stay
 * in the owning host controller; this body cannot approve or start anything. */
export function PersonSwarmCardDetails({ card, changed }: {
  card: Pick<PersonSwarmCard, 'program_name' | 'minds' | 'key_id' | 'month_usd' | 'spend_note' | 'template_id' | 'template_digest' | 'rules'>
  changed?: { fields: readonly string[]; updated?: Pick<PersonSwarmCard, 'month_usd'> | null }
}) {
  const models = useHive((s) => s.models)
  const keys = useHive((s) => s.keys)
  return <>
            <p className="mt-3 text-sm">{card.program_name} would create {plural(card.minds.length, 'helper')}, just for you:</p>
            <ul className="mt-2 space-y-1 text-sm">{card.minds.map((mind) => <li key={mind.slot}>{mind.name}</li>)}</ul>
            <dl className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-2 rounded-lg bg-[#f7f7f9] p-3 text-sm">
              <dt>They think with</dt><dd>{[...new Set(card.minds.map((mind) => models.find((model) => model.id === mind.model)?.label ?? 'See model details below'))].join(', ')}</dd>
              <dt>Paid with</dt><dd>{(() => { const key = keys?.find((key) => key.id === card.key_id); return key ? `${key.label} ${key.hint}` : 'Your own key' })()}</dd>
              <dt>Monthly total</dt><dd className={changed?.fields.includes('month_usd') ? 'rounded bg-[#fff4e5] p-1 text-[#6a3a00]' : undefined}>
                {changed?.updated && changed.fields.includes('month_usd') ? <>
                  Up to {changed.updated.month_usd === null ? 'not available' : usd(changed.updated.month_usd)} a month (was {card.month_usd === null ? 'not available' : usd(card.month_usd)})
                </> : <>Up to {card.month_usd === null ? 'not available' : usd(card.month_usd)} a month, all {card.minds.length} together</>}
              </dd>
            </dl>
            <p className="mt-3 text-sm" data-host-spend-note="">{card.spend_note}</p>
            <details className="mt-3 text-sm"><summary className="min-h-11 cursor-pointer py-2 font-semibold">Details: helper list, exact model and version</summary>
              <ul className="space-y-2">{card.minds.map((mind) => <li key={mind.slot}><strong>{mind.name}</strong> · {mind.model}{mind.budget_usd === null ? '' : ` · ${usd(mind.budget_usd)}`}<p>{mind.persona}</p></li>)}</ul>
              <p className="mt-2 break-all">Template: {card.template_id} · {card.template_digest}</p>
              {card.rules.length > 0 && <ul>{card.rules.map((rule, index) => <li key={index}>{rule.mode === 'ask' ? 'Always ask you' : 'Do not allow'}: {rule.skill}</li>)}</ul>}
            </details>
  </>
}

function PersonSwarmConsentDialog({ state, controller, spaceLine }: { state: Exclude<PersonSwarmState, { kind: 'hidden' | 'loading' }>; controller: PersonSwarmConsent; spaceLine?: string }) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLHeadingElement>(null)
  const reduced = useReducedMotion()
  const busy = state.kind === 'asking' && state.busy
  const openedAt = state.kind === 'asking' ? state.openedAt : null
  const [armed, setArmed] = useState(false)
  useLayoutEffect(() => {
    if (openedAt === null) { setArmed(false); return }
    const remaining = Math.max(0, ARM_MS - (performance.now() - openedAt))
    setArmed(remaining === 0)
    const timer = setTimeout(() => setArmed(true), remaining)
    return () => clearTimeout(timer)
  }, [openedAt])
  useEscape(() => { if (!busy) controller.decline() })
  useModalContainment(box, { initialFocus: head })
  useLayoutEffect(() => { head.current?.focus() }, [state.kind])
  const card = state.kind === 'asking' || state.kind === 'changed' ? state.card : null
  const title = state.kind === 'saved' ? 'Consent saved' : state.kind === 'unknown' ? 'Your hive has not confirmed the answer' : 'Shall I set up your helpers?'
  const button = 'min-h-11 rounded-lg border border-[#c4c4cc] px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f1f24]'
  const fieldNames: Record<string, string> = { template_digest: 'the helper list', key_id: 'your key', month_usd: 'the monthly total', consent_revision: 'your setup consent', authority_revision: 'this app’s authority' }
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === 'Enter' || event.key === ' ') && (event.repeat || state.kind !== 'asking' || !accepts({ repeat: event.repeat, at: performance.now() }, state.openedAt))) event.preventDefault()
  }
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[rgb(20_14_40/.32)] p-[6px] pb-2 md:items-center" data-person-swarm-consent="">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-status`}
        className="flex max-h-[90dvh] w-full max-w-[470px] flex-col overflow-hidden rounded-[14px] border border-[#c4c4cc] bg-white font-sans text-[#1f1f24] shadow-[0_30px_90px_rgb(0_0_0/.45)]"
        style={{ transition: reduced ? 'none' : 'opacity 240ms ease' }}>
        <div className="flex min-h-12 items-center border-b border-[#d6d6dc] bg-[#f4f4f6] px-4 py-3 text-sm font-semibold">
          🔒 Your hive{card ? ` · ${card.program_name} asks to set up helpers for you` : ''}
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          <h2 ref={head} id={`${id}-title`} tabIndex={-1} className="text-[19px] font-bold outline-none focus-visible:underline">{title}</h2>
          {card && spaceLine && <p className="mt-3 text-sm font-semibold" data-person-app-space-line="">{spaceLine}</p>}
          {card && <PersonSwarmCardDetails card={card} changed={state.kind === 'changed' ? state : undefined} />}
          <p id={`${id}-status`} role="status" aria-live="polite" className="mt-3 text-sm">
            {state.kind === 'changed' ? `This changed since it was shown to you: ${state.fields.length ? state.fields.map((field) => fieldNames[field] ?? 'the helper setup').join(', ') : 'the helper setup'}. Nothing has been set up. Please look again.` :
              state.kind === 'saved' ? P2_SAVED : state.kind === 'unknown' ? 'The answer was lost. Consent may have been saved. Nothing will be sent again automatically.' :
                state.kind === 'unavailable' ? state.message : busy ? 'Saving…' : !armed ? 'Ready in a moment…' : ''}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[#d6d6dc] p-4">
          <button type="button" className={`${button} bg-[#f4f4f6]`} disabled={busy} onClick={controller.decline}>{state.kind === 'asking' || state.kind === 'changed' ? 'Not now' : 'Close'}</button>
          {state.kind === 'changed' && <button type="button" className={`${button} bg-[#1f1f24] text-white`} onClick={() => { void controller.lookAgain() }}>Look again</button>}
          {state.kind === 'asking' && <button type="button" className={`${button} bg-[#1f1f24] text-white disabled:opacity-60 aria-disabled:opacity-60`} disabled={busy} aria-disabled={!armed || busy}
            onKeyDown={handleKey} onClick={() => { void controller.accept({ at: performance.now() }) }}>Yes, set them up</button>}
        </div>
        {card && <p className="px-4 pb-4 text-xs text-[#4b4b55]">You can send them to sleep any time from your menu.</p>}
      </div>
    </div>, document.body,
  )
}
