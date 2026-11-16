import { useEffect, useRef, useState } from 'react'
import type { ModelOption, ProviderStatus } from '../../api/types'
import { useHive } from '../../store/store'
import { providerAnswerReady } from '../setup/checklist'
import { KEY_PROVIDERS, keyIn, type ProviderName } from '../keys/keyProvider'
import { readDefaultModel } from '../models/modelUtil'
import { navigate, type Route } from '../../lib/router'
import { pastedText } from '../../lib/hooks'
import { macKeys } from '../../lib/shortcutOwner'
import { useIntro } from '../../tour/introStore'
import { startFirstLight } from './door'
import { ASK_HOW_MAX, ASK_NAME_MAX, askPurposeValue, askToSave, personaEditable } from './host'
import { payerLine } from './honest'
import { InlineKey, pasteHint, type Paste } from './InlineKey'
import { LEAD_PROVIDER, connectedPlans, currentPlan, keyedWays, localModels, modelForKey } from './plans'
import { flDraft, flExit, flFinished, insteadOf, keepFlDraft, u1Busy, useFirstLight, whoOf, type Run } from './store'
import { outboundCopy, profileSaveCopy, spendingCopy, unknownRetryCopy } from './conditionalCopy'

export const U1_MONTH_DEFAULT = 5
type ReadinessProvider = ProviderStatus
/** Host metadata only. Configured is not answered, and rendering never probes. */
export function connectionState(model: string | null, providers: ReadinessProvider[] | null | undefined, ownKeys: number | null = null): 'unknown' | 'unverified' | 'ready' | 'local-down' | 'unavailable' | 'no-key' | 'no-provider' | 'demo' {
  const name = model?.split('/')[0]
  if (name === 'mock') return 'demo'
  if (providers === null || providers === undefined) return 'unknown'
  const provider = providers.find((p) => p.name === name)
  if (!provider) return providers.length === 0 && ownKeys === 0 ? 'no-provider' : 'unknown'
  if (provider.test_only || provider.readiness === 'test_only') return 'demo'
  if (providerAnswerReady(provider)) return 'ready'
  if (provider.readiness === 'not_answering') return provider.local ? 'local-down' : 'unavailable'
  const configured = (p: ProviderStatus) => p.configured ?? p.connected // configuration only, never answer evidence
  const absentKey = (p: ProviderStatus) => !p.local && p.needs_key && !configured(p) && p.source === null && p.keys === 0 && p.key_hint === ''
  if (ownKeys === 0 && absentKey(provider)) {
    const noAlternative = providers.every((p) => p.name === 'mock' || p.test_only || p.readiness === 'test_only' || absentKey(p) || (p.local && p.readiness === 'not_answering'))
    return noAlternative ? 'no-provider' : 'no-key'
  }
  return configured(provider) ? 'unverified' : 'unknown'
}
export function providerWords(model: string | null, providers: ProviderStatus[] | null | undefined): string {
  const provider = providers?.find((p) => p.name === model?.split('/')[0])
  if (provider?.test_only || provider?.name === 'mock') return 'Demonstration model'
  if (provider?.local) return 'A model on this computer'
  return provider?.label?.trim() || 'Not confirmed'
}
export const ownMonthEditable = (run: Run): boolean => run.path !== 'guest' && run.facts.ownKeys > 0 && run.facts.limit !== null && (!run.facts.limit.enforced || run.facts.limit.enforced_by === 'own')
export const monthProposal = (run: Run): number => run.facts.limit?.enforced && run.facts.limit.limit_usd !== null ? run.facts.limit.limit_usd : run.facts.limit?.chosen_usd ?? run.facts.hiveMonthUsd ?? U1_MONTH_DEFAULT
/** Wake saves an own-key monthly total only when the person changed it here; otherwise the limit the hive holds stays. */
export const monthToSave = (run: Run, edited: string | null): number | null => !ownMonthEditable(run) || edited === null ? null : edited.trim() ? Number(edited) : Number.NaN
/**
 * Where Continue takes the person once First Light is done: to the mind that greeted them, in its chat, where the
 * greeting they just read stays (the hello is sent in their own conversation with the mind, onboarding.py) and the map
 * shows that mind selected. Without a greeting there is no mind to land on, and First Light just closes.
 */
export function landingAfter(run: Run): Route | null {
  const h = run.hello.hello
  return h?.state === 'greeted' && h.greeting ? { name: 'dot', id: h.mind.id, tab: 'chat' } : null
}

/**
 * Explicit props make Source-planned rendering independent of external-store SSR snapshots.
 *
 * First Light is the onboarding, so every way to think works inside the card (a plan or a keyed provider the hive
 * already has, a key pasted here, a model on this computer, a key the hive already holds pasted again), and a look, a
 * role, the tour and usage, which each leave it, are offered only once it is finished (store.flFinished). It can always
 * be finished: when the personal mind cannot wake (store.insteadOf) the card offers Restore, another of the person's
 * minds, or, where the hive leaves neither, a finish. Beside the main button, Not now sets it aside (store.flExit): the
 * Finish setup nudge then brings the person back to it, with what they typed and did not save (store.flDraft); Close
 * stands there instead where there is nothing to set aside.
 */
export function SingleScreen({ run, now, providers, models }: { run: Run; now: number; providers?: ProviderStatus[] | null; models?: ModelOption[] | null }) {
  const g = useFirstLight.getState()
  const u = run.u1
  // what the person typed last time and did not save, shown again where they left off (read once, when the card opens)
  const [kept] = useState(flDraft)
  const [name, setName] = useState<string | null>(kept?.name ?? null)
  const shownName = name ?? run.facts.mind?.name ?? ''
  const [purpose, setPurpose] = useState<string | null>(kept?.purpose ?? null) // real dirty flag; empty string is an intentional clear
  const [month, setMonth] = useState<string | null>(kept?.month ?? null)
  useEffect(() => keepFlDraft({ name, purpose, month }), [name, purpose, month])
  // the way to think opened inside the card: the key field, or the models on this computer (null: untouched, so the key
  // field opens by itself while it is the only way the hive offers). A way's button opens its choice and never closes
  // it: pressing it again leaves it open, and pressing another way's button switches to that one.
  const [adding, setAdding] = useState<'key' | 'local' | null>(null)
  const [keyNote, setKeyNote] = useState<string | null>(null)
  // the last press of Paste: the key it found in what was copied, and what the field then says
  const [paste, setPaste] = useState<Paste | null>(null)
  // the starting monthly limit a key saved here brought: said in the card, since the pop-up saying it sits behind First Light
  const [startNote, setStartNote] = useState<string | null>(null)
  const [remembered] = useState(() => readDefaultModel()?.model ?? null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const thinkingRef = useRef<HTMLDetailsElement | null>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  if (!u) return null
  const done = flFinished(run)
  // the card's own part is still open: not greeted, and not ended another way
  const editing = u.phase !== 'greeted' && u.phase !== 'ended'
  const instead = insteadOf(run, providers)
  const personal = run.facts.mind?.name ?? (shownName.trim() || 'Your mind')
  const amount = monthToSave(run, month)
  const validAmount = amount === null || (Number.isFinite(amount) && amount >= 0 && amount <= 10000)
  const limitWords = spendingCopy(run.facts.limit, amount !== null && Number.isFinite(amount) ? amount : null, u.limitPending ?? null, u.limitChecking === true && u.busy && run.status === 'playing', u.limitUncertain === true, run.facts.hiveMonthUsd ?? null)
  const known = run.status === 'playing' && !run.loadError && u.context === 'known' && !!u.model && !!run.facts.mind
  const budgetUnknown = run.facts.ownKeys > 0 && run.facts.limit === null
  const waiting = u.phase === 'waiting' && !run.hello.hello?.retryable
  const busy = u1Busy(run)
  const choosing = busy || run.status === 'loading'
  const shownPurpose = purpose ?? askPurposeValue(run.facts.askHow)
  const connection = connectionState(u.model, providers, run.facts.ownKeys)
  const plans = run.mode === 'live' && run.facts.mind ? connectedPlans(providers, run.path === 'owner') : []
  const onPlan = currentPlan(u.model, plans)
  const ways = run.mode === 'live' && run.facts.mind ? keyedWays(providers, models, run.path === 'owner', remembered) : []
  const here = localModels(models, providers)
  const unavailable = connection === 'local-down' || connection === 'unavailable' || connection === 'no-key' || connection === 'no-provider' || connection === 'demo'
  // no plan, no key the hive has, no model on this computer: pasting a key is the one way, so its field is open from
  // the start (its Add key the one primary) and the card says so; a person with no way they can tap is never left with
  // nothing to do. A chosen model on this computer that is not answering keeps the choices as they are.
  const onlyKey = plans.length === 0 && ways.length === 0 && here.length === 0
  const keyShown = adding === 'key' || (adding === null && unavailable && onlyKey && connection !== 'local-down')
  const wakeHeld = unavailable || connection === 'unknown'
  const retrySetup = !known || budgetUnknown || u.limitUncertain === true || u.limitPending != null || (!!u.error && !u.wakeUnknown)
  const primary = unavailable ? 'choose' : retrySetup || connection === 'unknown' ? 'read' : 'wake'
  const saveWords = u.saves && !u.busy ? profileSaveCopy(u.saves) : null
  const failure = run.loadError ?? u.error
  const outcome = failure ? u.profileSaved && saveWords ? `${failure} ${saveWords}` : failure : saveWords
  const hello = run.hello.hello
  const greeting = run.facts.greeted && hello?.state === 'greeted' ? hello.greeting : null
  // an edit not yet on the host: Save writes it now (Wake would write it too), and the fields then show what was saved
  const unsaved = (name !== null && name.trim() !== (run.facts.mind?.name ?? '')) || (purpose !== null && purpose !== askPurposeValue(run.facts.askHow))
  const saveProfile = async () => {
    if (await g.saveSingleProfile(askToSave(shownName, purpose, run.facts.askHow))) {
      setName(null)
      setPurpose(null)
    }
  }
  const open = (which: 'key' | 'local') => {
    setKeyNote(null)
    setAdding(which)
  }
  // Paste does what it says: it opens the key field and puts the copied key in it (the key goes only with Add key). The
  // clipboard is read on this press; when the browser will not read it, or what was copied holds no key, the cursor
  // goes to the field and the field says how to paste by hand.
  const pasteKey = () => {
    open('key')
    void pastedText().then((text) => {
      const key = text === null ? null : keyIn(text)
      const how = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : macKeys() ? 'mac' : 'ctrl'
      setPaste((p) => ({ n: (p?.n ?? 0) + 1, key, hint: pasteHint(key ? 'pasted' : text === null ? 'unreadable' : 'none', how) }))
    })
  }
  // the primary while it cannot think: open the choices and take the person to a way, the key field when it is the only one
  const chooseWay = () => {
    const d = thinkingRef.current
    if (d) d.open = true
    if (onlyKey) {
      setAdding('key')
      d?.querySelector<HTMLInputElement>('input[type=password]')?.focus()
      return
    }
    d?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }
  // A key saved here is how it thinks from now on: the card reads the setup again (the key changed its keys and
  // limit), then moves the mind onto the key's provider unless its model is already there, so Wake comes next.
  // A key the hive already held for this person (`held`) is the same: it is theirs, so it is how it thinks.
  const keySaved = async (provider: ProviderName, startingLimit: string | null, held: boolean) => {
    const label = KEY_PROVIDERS.find((p) => p.name === provider)?.label ?? provider
    setStartNote(startingLimit)
    setKeyNote(held ? `That ${label} key is already saved in this hive, so ${shownName.trim() || 'your mind'} thinks with it.` : null)
    setAdding(null)
    await g.reload()
    const r = useFirstLight.getState().run
    if (!r?.u1 || r.u1.model?.split('/')[0] === provider) return
    const model = modelForKey(provider, useHive.getState().models, remembered)
    if (model) return g.thinkWith(model)
    setKeyNote(`The ${label} key is saved, but this hive lists no ${label} model your mind can use.`)
  }
  // the one way out (store.flExit): Not now sets First Light aside for the Finish setup nudge; Close leaves it as it is
  const leave = flExit(run) === 'close'
    ? <button type="button" className="fl-btn" data-u1-close="" onClick={g.leave}>Close</button>
    : <button type="button" className="fl-btn" data-u1-not-now="" onClick={g.leave}>Not now</button>
  const completionWords = u.completion === 'confirmed' ? 'First Light is saved as complete.' : u.completion === 'saving' ? 'Saving First Light completion…' : 'First Light completion is not confirmed yet.'
  const completion = <><p role="status">{completionWords}</p>{u.completion !== 'confirmed' && <button type="button" className="fl-btn" data-tone="primary" disabled={u.completion === 'saving'} onClick={() => void g.finishSingleScreen()}>Save completion again</button>}<button type="button" className="fl-btn" data-tone={done ? 'primary' : undefined} disabled={!done} onClick={() => { const to = landingAfter(run); g.stop(); if (to) navigate(to) }}>Continue</button>{!done && !busy && leave}</>
  if (run.status === 'paused') return <div className="fl-u1-body" data-firstlight-single="paused">
    <h2>First Light is paused</h2>
    <p>Any request already sent may still finish. Resume to read the current state before continuing.</p>
    <p>{shownName || 'Your mind'} acts only for you.</p><p className="fl-small">{outboundCopy}</p>
    <button type="button" className="fl-btn" data-tone="primary" onClick={() => { g.toggle(); void g.reload() }}>Resume First Light</button>
    {leave}
  </div>
  return <div className="fl-u1-body" data-firstlight-single={u.phase}>
    <header><span className="fl-u1-eyebrow">First Light</span><h2>Meet your mind</h2></header>
    {run.facts.minds?.established && !done && !run.loadError && <p className="fl-small" data-u1-may-leave="">You've used this hive before, so you can close this whenever you like.</p>}
    <div className="fl-u1-fields"><label className="fl-field"><span>Its name</span><input ref={nameRef} className="fl-input" value={shownName} maxLength={ASK_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Give it a name" autoComplete="off" disabled={busy || !run.facts.mind || run.status === 'loading' || !editing} /></label>
    <label className="fl-field"><span>What do you want it to be?</span>
      {run.facts.askHow !== null && !personaEditable(run.facts.askHow)
        ? <p>It already has longer words of its own. Change them on its page; saving here keeps them.</p>
        : <textarea className="fl-input" rows={2} value={shownPurpose} maxLength={ASK_HOW_MAX} onChange={(e) => setPurpose(e.target.value)} disabled={busy || run.facts.askHow === null || !editing} />}
      <span className="fl-field-help">In your own words. You can change this any time on its page.</span>
    </label></div>
    {unsaved && u.phase === 'editing' && <div className="fl-chips"><button type="button" className="fl-btn" data-u1-save-profile="" disabled={busy || run.status !== 'playing' || !run.facts.mind || !shownName.trim()} onClick={() => void saveProfile()}>Save</button></div>}
    {run.facts.askHow === null && <p role="status">Your existing purpose is not known yet. It will not be replaced by a default.</p>}
    <section aria-label="How it thinks" className="fl-u1-thinking">
      {/* while it cannot think the choices stay open: its summary does not fold them away */}
      <details ref={thinkingRef} open={unavailable || undefined} data-u1-choices=""><summary onClick={(e) => { if (unavailable) e.preventDefault() }}><span>How it thinks · <span data-u1-model="">{providerWords(u.model, providers)}</span></span>{!unavailable && <span className="fl-change">Change</span>}</summary>
      <p className="fl-small">{u.model ? 'Current host model; this setting alone is not proof it answers.' : 'The current model is not confirmed.'}</p>
      <div className="fl-chips">
        {plans.map((p) => <button key={p.provider} type="button" className="fl-btn" data-u1-plan={p.provider} data-tone={!onPlan && p === plans[0] ? 'primary' : undefined}
          aria-pressed={onPlan?.provider === p.provider} disabled={choosing} onClick={() => void g.thinkWith(p.model)}>{p.label}</button>)}
        {ways.map((w) => <button key={w.provider} type="button" className="fl-btn" data-u1-way={w.provider} aria-pressed={u.model?.split('/')[0] === w.provider} disabled={choosing} onClick={() => void g.thinkWith(w.model)}>Think with {w.label}</button>)}
        <button type="button" className="fl-btn" data-u1-paste="" disabled={choosing} onClick={pasteKey}>Paste an {LEAD_PROVIDER.label} key</button>
        {here.length > 0 && <button type="button" className="fl-btn" data-u1-local-open="" aria-expanded={adding === 'local'} disabled={choosing || !run.facts.mind} onClick={() => open('local')}>Use a model on this computer</button>}
      </div>
      {keyShown && <InlineKey disabled={choosing} focus={adding === 'key'} paste={paste} onSaved={(p, start, held) => void keySaved(p, start, held)} />}
      {adding === 'local' && here.length > 0 && <div className="fl-chips" role="group" aria-label="Models on this computer" data-u1-local="">
        {here.map((m) => <button key={m.id} type="button" className="fl-btn" aria-pressed={u.model === m.id} disabled={choosing} onClick={() => { setAdding(null); void g.thinkWith(m.id) }}>{m.label}</button>)}
      </div>}
      {keyNote && <p role="status" className="fl-small">{keyNote}</p>}
      {plans.length > 0 && <p className="fl-small" data-u1-plan-note="">{onPlan ? `Thinking with your ${onPlan.provider === 'subscription-codex' ? 'ChatGPT' : 'Claude'} plan on this computer. Its own daily allowance applies.` : 'Your plan is already connected on this computer. One tap and your mind thinks with it; nothing changes until you choose.'}</p>}
      <p className="fl-pays">{payerLine(whoOf(run))}</p>
      {connection === 'unverified' && <p className="fl-small">This provider has not answered recently. Wake is an explicit attempt under the host’s spending and permission checks.</p>}
      {connection === 'unknown' && <p className="fl-small">Provider readiness could not be read. Read the current setup before Wake.</p>}
      </details>
      {unavailable && <p role="status" data-u1-provider="">{connection === 'local-down' ? "The model on this computer isn't answering." : `${shownName || 'Your mind'} can't think yet. ${onlyKey ? `Paste an ${LEAD_PROVIDER.label} key above to give it a way to think.` : 'Choose a way for it to think above.'}`}</p>}
      {/* with the key field the one way, the status line above already says to paste a key */}
      {(connection === 'no-key' || connection === 'no-provider') && !onlyKey && <p className="fl-small" data-u1-ways="">{connection === 'no-key' ? `This model has no key here yet. Paste an ${LEAD_PROVIDER.label} key, or choose another way it can think.` : `Paste an ${LEAD_PROVIDER.label} key, or ${here.length > 0 ? 'use a model on this computer' : 'choose another way above'}. Nothing is selected until you choose it.`}</p>}
      {startNote && <p role="status" className="fl-small" data-u1-start-limit="">{startNote}</p>}
      <div className="fl-u1-spending"><p data-u1-limit="">{limitWords}</p>
      {ownMonthEditable(run) && <details className="fl-u1-month"><summary>{limitWords === spendingCopy(null, null, null) ? 'Set a limit' : 'Change'}</summary><label className="fl-field"><span>Monthly total on your own keys, dollars</span><input type="number" min={0} max={10000} step={1} value={month ?? (u.limitUncertain ? u.limitPending == null ? '' : String(u.limitPending) : String(monthProposal(run)))} onChange={(e) => setMonth(e.target.value)} disabled={busy} /></label></details>}</div>
      {budgetUnknown && <p role="status">Your own-key limit could not be read. Wake waits for its current scope; read it again.</p>}
    </section>
    {outcome && <p role={failure ? 'alert' : 'status'} className={failure ? 'fl-error' : undefined} data-u1-save={saveWords ? '' : undefined}>{outcome}</p>}
    {u.saves?.readback && <details><summary>Here’s what {u.saves.readback.name} has now</summary><p>Name: {u.saves.readback.name}</p><p className="fl-u1-readback">Purpose: {u.saves.readback.purpose}</p></details>}
    {done && u.wakeUnknown && u.phase !== 'greeted' && <button type="button" className="fl-btn" onClick={() => navigate({ name: 'usage' })}>Check usage</button>}
    {editing && retrySetup && !busy && <button type="button" className="fl-btn" data-tone={primary === 'read' && !instead ? 'primary' : undefined} disabled={run.status === 'loading'} onClick={() => void g.reload()}>{run.status === 'loading' || u.context === 'reading' ? 'Reading your current setup…' : 'Read current setup again'}</button>}
    {/* the personal mind cannot wake here: what the hive allows instead, each of which finishes First Light */}
    {editing && instead && <div role="group" aria-label={`Instead of waking ${personal} here`} data-u1-instead="">
      <p role="status">{instead.archived
        ? `${personal} is archived, so it can't wake. ${instead.restore ? `Restore it to wake it here${instead.others.length ? ', or wake another of your minds and finish with that.' : '.'}` : instead.others.length ? 'Only an admin can restore it, so wake another of your minds and finish with that.' : 'Only an admin can restore it, so First Light can finish without it. Ask an admin to restore it, then wake it from its page.'}`
        : `This hive did not give you a personal mind just now. ${instead.others.length ? 'Read your setup again, or wake another of your minds and finish with that.' : 'Read your setup again.'}`}</p>
      <div className="fl-chips">
        {instead.restore && <button type="button" className="fl-btn" data-tone="primary" data-u1-restore="" disabled={busy} onClick={() => void g.restorePersonal()}>Restore {personal}</button>}
        {instead.others.map((m) => <button key={m.id} type="button" className="fl-btn" data-tone={!instead.restore && m === instead.others[0] ? 'primary' : undefined} data-u1-wake-other={m.id} disabled={busy} onClick={() => void g.wakeOther(m.id)}>Wake {m.name}</button>)}
        {instead.finish && <button type="button" className="fl-btn" data-tone="primary" data-u1-finish-here="" disabled={busy} onClick={() => void g.finishHere()}>Finish First Light</button>}
      </div>
    </div>}
    {editing && <>
      <div className="fl-u1-actions">{!instead && primary === 'choose' && !keyShown && <button type="button" className="fl-btn" data-tone="primary" data-u1-choose="" disabled={busy} onClick={chooseWay}>Choose how {shownName.trim() || 'your mind'} thinks</button>}{!instead && <button type="button" className="fl-btn" data-tone={primary === 'wake' ? 'primary' : undefined} data-u1-wake="" disabled={!known || wakeHeld || primary === 'read' || busy || budgetUnknown || !shownName.trim() || !validAmount} onClick={() => void g.wakeSingleScreen(askToSave(shownName, purpose, run.facts.askHow), amount)}>{u.busy ? 'Saving and requesting Wake…' : waiting ? 'Waiting for your mind…' : u.wakeUnknown ? unknownRetryCopy : `Wake ${shownName.trim() || 'your mind'}`}</button>}
      {!busy && leave}</div>
    </>}
    {waiting && <p role="status">Waiting for the host’s recorded greeting{run.hello.postedAt !== null ? ` · ${Math.max(0, Math.floor((now - run.hello.postedAt) / 1000))} s` : ''}. No reply is invented here.</p>}
    {busy && <button type="button" className="fl-btn" onClick={g.toggle}>Pause setup</button>}
    {greeting && <section aria-label="Recorded greeting"><p>Recorded greeting from {hello!.mind.name}{greeting.created_at ? ` · ${greeting.created_at}` : ''}</p><blockquote>{greeting.text}</blockquote><p>Host-reported mind status: {hello!.mind.status}. This does not establish that every creation service is ready.</p>{completion}</section>}
    {u.phase === 'ended' && <section aria-label="How First Light ended" data-u1-ended=""><p>{u.other ? `${u.other.name} is awake.` : `First Light finishes without waking ${personal}, which stays archived until an admin restores it.`}</p>{completion}</section>}
    {/* a look, a role and the tour each leave this card, so they wait until First Light is finished */}
    {done && <div className="fl-chips" aria-label="More to set up">
      <button type="button" className="fl-btn" disabled={busy} onClick={() => startFirstLight({ mode: 'live', beat: 'look' })}>Change its look</button>
      <button type="button" className="fl-btn" disabled={busy} onClick={() => startFirstLight({ mode: 'live', beat: 'arrive' })}>Choose your role</button>
      <button type="button" className="fl-btn" disabled={busy} onClick={() => { g.stop(); useIntro.getState().startTour() }}>Take a tour</button>
    </div>}
    <div className="fl-u1-consent"><p>{shownName || 'Your mind'} acts only for you.</p><p>{outboundCopy}</p><details className="fl-small"><summary>What this means</summary><p>The current host API has not reported an outbound-approval policy here. Wake still uses the host’s existing model, key, egress and spending checks; earlier saved changes remain if a later step is refused.</p></details></div>
  </div>
}
