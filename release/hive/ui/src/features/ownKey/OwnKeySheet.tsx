/**
 * The one add-your-key step, inline where the refusal was (Studio's card, the Ask thread). One paste field, the
 * monthly limit pre-filled (only when the person has none yet), one button. On success the caller retries what was
 * refused, with the person's words kept (`onDone`). A key saved but a limit not set stays open in "set limit" state.
 *
 * Identity (sol on 4e3cd2b6, as OwnMonthlyLimit.tsx): the body is keyed by the identity epoch, so nothing typed, shown
 * or pending under the earlier person survives a sign-in change; each submit is one BoundOperation (the sign-in and
 * this sheet's life), and its state writes and `onDone` happen only while that still holds.
 * In the sim the sheet never takes a credential: an invented demonstration key stands in (SIM_DEMO_KEY).
 * See addOwnKey.ts for the calls.
 */
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { bindOperation, useAlive, type BoundOperation } from '../../lib/boundOperation'
import { bindEpoch, currentEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { money } from '../../lib/format'
import { initialState, keepGoverning, LIMIT_SAVED_KEY_WORDS, SIM_DEMO_KEY, submitOwnKey, suggestedFrom, type KeySetup, type OwnKeyIo, type SheetState } from './addOwnKey'
import './ownKey.css'

/** what the sheet needs of the hive client (api/client HiveClient) */
export interface OwnKeyClient {
  mode?: string
  addKey(body: { provider: string; key: string; month_usd?: number }): Promise<never>
  myKeyLimits?(): Promise<unknown>
  setOwnKeyLimit?(body: Record<string, unknown>): Promise<unknown>
}

type Props = {
  setup: KeySetup
  client: OwnKeyClient
  /** what was refused, tried again with the person's words (the caller's own retry path) */
  onDone: () => void
  /** the verb on the button: "Add key and draw", "Add key and ask" */
  action?: string
  buttonClass?: string
}

/** Whether this client can run the sheet (read and set the total). When it can't, callers keep their old way on (Keys). */
export function canOwnKeySheet(client: Partial<OwnKeyClient> | null | undefined): client is OwnKeyClient {
  return !!client && typeof client.addKey === 'function' && typeof client.myKeyLimits === 'function' && typeof client.setOwnKeyLimit === 'function'
}

export function OwnKeySheet(props: Props) {
  const epoch = useSyncExternalStore(onIdentityChange, currentEpoch, currentEpoch)
  if (!canOwnKeySheet(props.client)) return null   // the caller shows its Keys link instead (canOwnKeySheet)
  return <OwnKeySheetBody key={epoch} {...props} />
}

function OwnKeySheetBody({ setup, client, onDone, action = 'draw', buttonClass = 'ok-btn' }: Props) {
  const id = useId()
  const alive = useAlive()
  const sim = client.mode === 'sim'
  const [state, setState] = useState<SheetState>(() => initialState(setup))
  const [key, setKey] = useState('')
  const [month, setMonth] = useState(setup.suggestedMonthUsd != null ? String(setup.suggestedMonthUsd) : '')
  // no figure in the refusal (the missing total alone): the host's own suggestion, read once, for this person only
  useEffect(() => {
    if (setup.hasTotal || setup.suggestedMonthUsd != null) return
    let live = true
    const b = bindEpoch()
    client.myKeyLimits!().then((v) => {
      const m = suggestedFrom(v)
      if (live && m !== null) b.commit(() => setMonth((cur) => cur === '' ? String(m) : cur))
    }, () => undefined)
    return () => { live = false }
  }, [client, setup.hasTotal, setup.suggestedMonthUsd])
  const saving = state.phase === 'saving'
  const limitOnly = state.keySaved
  const askLimit = !setup.hasTotal
  const io: OwnKeyIo = {
    addKey: (b) => client.addKey(b),
    read: () => client.myKeyLimits!(),
    writeLimit: (b) => client.setOwnKeyLimit!(b),
  }

  async function run(go: (op: BoundOperation, prior: SheetState) => Promise<SheetState>) {
    if (saving) return
    const op = bindOperation(alive)                     // before the first await: this sign-in, this sheet
    const prior = state
    setState({ ...prior, phase: 'saving', error: null })
    const next = await go(op, prior)
    if (!op.current() || next.phase === 'stopped') return   // another person now, or the sheet is gone: nothing more
    op.binding.commit(() => {
      setState(next)
      if (next.phase === 'done') { setKey(''); onDone() }
    })
  }
  const submit = (replace = false) => run((op, prior) => submitOwnKey(op, io, setup, { key: sim ? SIM_DEMO_KEY : key, month, replace }, prior))

  const title = state.phase === 'confirm-limit' ? 'Your monthly limit' : limitOnly ? 'Set your monthly limit' : `Add your ${setup.providerLabel} key`
  const button = saving ? 'Saving…' : limitOnly ? `Set limit and ${action}` : sim ? `Use a demo key and ${action}` : `Add key and ${action}`
  return (
    <form className="ok-sheet" data-own-key-sheet={state.phase} onSubmit={(ev) => { ev.preventDefault(); void submit(false) }} aria-labelledby={`${id}-t`}>
      <p className="ok-title" id={`${id}-t`}>{title}</p>
      {limitOnly && setup.provider && state.phase !== 'confirm-limit'
        ? <p className="ok-note" role="status" data-own-key-saved="">{LIMIT_SAVED_KEY_WORDS}</p>
        : !limitOnly && <p className="ok-note">{sim ? 'This is a demonstration: an invented key is used, and nothing real is sent.' : 'It pays only for what you ask here, and it stays yours. You can remove it any time in Keys.'}</p>}
      {!limitOnly && !sim && (
        <label className="ok-field">
          <span>{setup.providerLabel} key</span>
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
            placeholder="Paste it here" disabled={saving} data-own-key-input="" />
        </label>
      )}
      {state.phase === 'confirm-limit' ? (
        <>
          <p className="ok-note" role="status" data-own-key-governing="">
            {state.governingUsd != null ? `Your monthly limit is now ${money(state.governingUsd)}, set since you started.` : 'A monthly limit was set since you started.'} Keep it, or set {month ? money(Number(month) || 0) : 'yours'} instead.
          </p>
          <div className="ok-row">
            <button type="button" className={buttonClass} data-tone="primary" disabled={saving} data-own-key-keep="" onClick={() => void run((op, prior) => keepGoverning(op, io, prior))}>Keep it and {action}</button>
            <button type="button" className={buttonClass} disabled={saving} data-own-key-replace="" onClick={() => void submit(true)}>Set {month ? money(Number(month) || 0) : 'mine'} instead</button>
          </div>
        </>
      ) : (
        <>
          {askLimit && (
            <label className="ok-field ok-month">
              <span>Monthly limit</span>
              <span className="ok-money"><span aria-hidden="true">$</span>
                <input inputMode="decimal" value={month} onChange={(e) => setMonth(e.target.value)} disabled={saving} data-own-key-month="" aria-describedby={`${id}-m`} />
              </span>
              <small id={`${id}-m`}>The most your key spends here in a month, everything included. You can change it later.</small>
            </label>
          )}
          {state.error && <p className="ok-error" role="alert" data-own-key-error="">{state.error}</p>}
          <div className="ok-row">
            <button type="submit" className={buttonClass} data-tone="primary" disabled={saving} data-own-key-submit="">{button}</button>
          </div>
        </>
      )}
    </form>
  )
}
