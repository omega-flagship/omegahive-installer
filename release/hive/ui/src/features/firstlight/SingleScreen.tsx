import { useEffect, useRef, useState } from 'react'
import type { ProviderStatus } from '../../api/types'
import { providerAnswerReady } from '../setup/checklist'
import { navigate } from '../../lib/router'
import { useIntro } from '../../tour/introStore'
import { startFirstLight } from './door'
import { ASK_HOW_MAX, ASK_NAME_MAX, askPurposeValue, askToSave, personaEditable } from './host'
import { payerLine } from './honest'
import { connectedPlans, currentPlan } from './plans'
import { useFirstLight, whoOf, type Run } from './store'
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
export const monthProposal = (run: Run): number => run.facts.limit?.enforced && run.facts.limit.limit_usd !== null ? run.facts.limit.limit_usd : run.facts.limit?.chosen_usd ?? U1_MONTH_DEFAULT
export const monthToSave = (run: Run, edited: string | null): number | null => !ownMonthEditable(run) ? null : edited !== null ? edited.trim() ? Number(edited) : Number.NaN : run.facts.limit?.enforced ? null : monthProposal(run)

/** Explicit props make Source-planned rendering independent of external-store SSR snapshots. */
export function SingleScreen({ run, now, providers }: { run: Run; now: number; providers?: ProviderStatus[] | null }) {
  const g = useFirstLight.getState()
  const u = run.u1
  const [name, setName] = useState<string | null>(null)
  const shownName = name ?? run.facts.mind?.name ?? ''
  const [purpose, setPurpose] = useState<string | null>(null) // real dirty flag; empty string is an intentional clear
  const [month, setMonth] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const thinkingRef = useRef<HTMLDetailsElement | null>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  if (!u) return null
  const amount = monthToSave(run, month)
  const validAmount = amount === null || (Number.isFinite(amount) && amount >= 0 && amount <= 10000)
  const limitWords = spendingCopy(run.facts.limit, ownMonthEditable(run) ? monthProposal(run) : null, u.limitPending ?? null, u.limitChecking === true && u.busy && run.status === 'playing', u.limitUncertain === true)
  const known = run.status === 'playing' && !run.loadError && u.context === 'known' && !!u.model && !!run.facts.mind
  const budgetUnknown = run.facts.ownKeys > 0 && run.facts.limit === null
  const waiting = u.phase === 'waiting' && !run.hello.hello?.retryable
  const busy = u.busy || waiting
  const shownPurpose = purpose ?? askPurposeValue(run.facts.askHow)
  const connection = connectionState(u.model, providers, run.facts.ownKeys)
  const plans = run.mode === 'live' && run.facts.mind ? connectedPlans(providers, run.path === 'owner') : []
  const onPlan = currentPlan(u.model, plans)
  const unavailable = connection === 'local-down' || connection === 'unavailable' || connection === 'no-key' || connection === 'no-provider' || connection === 'demo'
  const wakeHeld = unavailable || connection === 'unknown'
  const retrySetup = !known || budgetUnknown || u.limitUncertain === true || u.limitPending != null || (!!u.error && !u.wakeUnknown)
  const primary = unavailable ? 'choose' : retrySetup || connection === 'unknown' ? 'read' : 'wake'
  const saveWords = u.saves && !u.busy ? profileSaveCopy(u.saves) : null
  const failure = run.loadError ?? u.error
  const outcome = failure ? u.profileSaved && saveWords ? `${failure} ${saveWords}` : failure : saveWords
  const hello = run.hello.hello
  const greeting = run.facts.greeted && hello?.state === 'greeted' ? hello.greeting : null
  const configure = (where: 'keys' | 'model') => {
    if (busy) return
    g.toggle() // pauses this local chain; never changes model, keys or permissions on its own
    navigate(where === 'model' && run.facts.mind ? { name: 'dot', id: run.facts.mind.id, tab: 'model' } : { name: 'me' })
  }
  if (run.status === 'paused') return <div className="fl-u1-body" data-firstlight-single="paused">
    <h2>First Light is paused</h2>
    <p>Any request already sent may still finish. Resume to read the current state before continuing.</p>
    <p>{shownName || 'Your omega'} acts only for you.</p><p className="fl-small">{outboundCopy}</p>
    <button type="button" className="fl-btn" data-tone="primary" onClick={() => { g.toggle(); void g.reload() }}>Resume First Light</button>
    <button type="button" className="fl-btn" onClick={g.notNow}>Not now</button>
  </div>
  return <div className="fl-u1-body" data-firstlight-single={u.phase}>
    <header><span className="fl-u1-eyebrow">First Light</span><h2>Meet your omega</h2></header>
    <div className="fl-u1-fields"><label className="fl-field"><span>Its name</span><input ref={nameRef} className="fl-input" value={shownName} maxLength={ASK_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Give it a name" autoComplete="off" disabled={busy || !run.facts.mind || run.status === 'loading' || u.phase === 'greeted'} /></label>
    <label className="fl-field"><span>What do you want it to be?</span>
      {run.facts.askHow !== null && !personaEditable(run.facts.askHow)
        ? <p>It already has longer words of its own. Change them on its page; saving here keeps them.</p>
        : <textarea className="fl-input" rows={2} value={shownPurpose} maxLength={ASK_HOW_MAX} onChange={(e) => setPurpose(e.target.value)} disabled={busy || run.facts.askHow === null || u.phase === 'greeted'} />}
      <span className="fl-field-help">In your own words. You can change this any time on its page.</span>
    </label></div>
    {run.facts.askHow === null && <p role="status">Your existing purpose is not known yet. It will not be replaced by a default.</p>}
    <section aria-label="How it thinks" className="fl-u1-thinking">
      <details ref={thinkingRef} open={unavailable || undefined} data-u1-choices=""><summary><span>How it thinks · <span data-u1-model="">{providerWords(u.model, providers)}</span></span><span className="fl-change">Change</span></summary>
      <p className="fl-small">{u.model ? 'Current host model; this setting alone is not proof it answers.' : 'The current model is not confirmed.'}</p>
      <div className="fl-chips">
        {plans.map((p) => <button key={p.provider} type="button" className="fl-btn" data-u1-plan={p.provider} data-tone={!onPlan && p === plans[0] ? 'primary' : undefined}
          aria-pressed={onPlan?.provider === p.provider} disabled={busy || run.status === 'loading'} onClick={() => void g.thinkWith(p.model)}>{p.label}</button>)}
        {!plans.some((p) => p.provider === 'subscription-cli') && <button type="button" className="fl-btn" disabled aria-describedby="fl-u1-auth-note">Sign in with Claude</button>}
        {!plans.some((p) => p.provider === 'subscription-codex') && <button type="button" className="fl-btn" disabled aria-describedby="fl-u1-auth-note">Sign in with ChatGPT</button>}
        <button type="button" className="fl-btn" disabled={busy || run.status === 'loading'} onClick={() => configure('keys')}>Paste a key</button>
        <button type="button" className="fl-btn" disabled={busy || run.status === 'loading' || !run.facts.mind} onClick={() => configure('model')}>Use a model on this computer</button>
      </div>
      {plans.length > 0 && <p className="fl-small" data-u1-plan-note="">{onPlan ? `Thinking with your ${onPlan.provider === 'subscription-codex' ? 'ChatGPT' : 'Claude'} plan on this computer. Its own daily allowance applies.` : 'Your plan is already connected on this computer. One tap and your omega thinks with it; nothing changes until you choose.'}</p>}
      {plans.length < 2 && <p id="fl-u1-auth-note" className="fl-small">Provider sign-in is not connected to this screen yet. The existing key and Model settings remain available; a local model can be chosen there only if this host offers one. Nothing is selected or connected automatically.</p>}
      <p className="fl-pays">{payerLine(whoOf(run))}</p>
      <div className="fl-chips" aria-label="Optional setup later">
        <button type="button" className="fl-btn" disabled={busy} onClick={() => startFirstLight({ mode: 'live', beat: 'look' })}>Change its look</button>
        <button type="button" className="fl-btn" disabled={busy} onClick={() => startFirstLight({ mode: 'live', beat: 'arrive' })}>Choose your role</button>
        <button type="button" className="fl-btn" disabled={busy} onClick={() => { g.stop(); useIntro.getState().startTour() }}>Take a tour</button>
      </div>
      {connection === 'unverified' && <p className="fl-small">This provider has not answered recently. Wake is an explicit attempt under the host’s spending and permission checks.</p>}
      {connection === 'unknown' && <p className="fl-small">Provider readiness could not be read. Read the current setup before Wake.</p>}
      </details>
      {unavailable && <p role="status" data-u1-provider="">{connection === 'local-down' ? "The model on this computer isn't answering." : `${shownName || 'Your omega'} can't think yet. It needs a way to think.`}</p>}
      {(connection === 'no-key' || connection === 'no-provider') && <details className="fl-small"><summary>What still works</summary><p>Still works: your own pages and edits, where your permissions allow.</p><p>{connection === 'no-key' ? 'This selected model has no available key. A different or local model may be available in its Model settings.' : 'Add a key, or choose a model on this computer in its Model settings. Nothing is selected automatically.'}</p></details>}
      <div className="fl-u1-spending"><p data-u1-limit="">{limitWords}</p>
      {ownMonthEditable(run) && <details className="fl-u1-month"><summary>{limitWords === spendingCopy(null, null, null) ? 'Set a limit' : 'Change'}</summary><label className="fl-field"><span>Monthly total on your own keys, dollars</span><input type="number" min={0} max={10000} step={1} value={month ?? (u.limitUncertain ? u.limitPending == null ? '' : String(u.limitPending) : String(monthProposal(run)))} onChange={(e) => setMonth(e.target.value)} disabled={busy} /></label></details>}</div>
      {budgetUnknown && <p role="status">Your own-key limit could not be read. Wake waits for its current scope; read it again.</p>}
    </section>
    {outcome && <p role={failure ? 'alert' : 'status'} className={failure ? 'fl-error' : undefined} data-u1-save={saveWords ? '' : undefined}>{outcome}</p>}
    {u.saves?.readback && <details><summary>Here’s what {u.saves.readback.name} has now</summary><p>Name: {u.saves.readback.name}</p><p className="fl-u1-readback">Purpose: {u.saves.readback.purpose}</p></details>}
    {u.wakeUnknown && u.phase !== 'greeted' && <button type="button" className="fl-btn" onClick={() => navigate({ name: 'usage' })}>Check usage</button>}
    {u.phase !== 'greeted' && retrySetup && !busy && <button type="button" className="fl-btn" data-tone={primary === 'read' ? 'primary' : undefined} disabled={run.status === 'loading'} onClick={() => void g.reload()}>{run.status === 'loading' || u.context === 'reading' ? 'Reading your current setup…' : 'Read current setup again'}</button>}
    {u.phase !== 'greeted' && <>
      <div className="fl-u1-actions">{primary === 'choose' && <button type="button" className="fl-btn" data-tone="primary" data-u1-choose="" disabled={busy} onClick={() => { if (thinkingRef.current) { thinkingRef.current.open = true; thinkingRef.current.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus() } }}>Choose how {shownName.trim() || 'your omega'} thinks</button>}<button type="button" className="fl-btn" data-tone={primary === 'wake' ? 'primary' : undefined} data-u1-wake="" disabled={!known || wakeHeld || primary === 'read' || busy || budgetUnknown || !shownName.trim() || !validAmount} onClick={() => void g.wakeSingleScreen(askToSave(shownName, purpose, run.facts.askHow), amount)}>{u.busy ? 'Saving and requesting Wake…' : waiting ? 'Waiting for your omega…' : u.wakeUnknown ? unknownRetryCopy : `Wake ${shownName.trim() || 'your omega'}`}</button>
      {!busy && <button type="button" className="fl-btn" onClick={g.notNow}>Not now</button>}</div>
    </>}
    {waiting && <p role="status">Waiting for the host’s recorded greeting{run.hello.postedAt !== null ? ` · ${Math.max(0, Math.floor((now - run.hello.postedAt) / 1000))} s` : ''}. No reply is invented here.</p>}
    {busy && <button type="button" className="fl-btn" onClick={g.toggle}>Pause setup</button>}
    {greeting && <section aria-label="Recorded greeting"><p>Recorded greeting from {hello!.mind.name}{greeting.created_at ? ` · ${greeting.created_at}` : ''}</p><blockquote>{greeting.text}</blockquote><p>Host-reported mind status: {hello!.mind.status}. This does not establish that every creation service is ready.</p><p role="status">{u.completion === 'confirmed' ? 'First Light is saved as complete.' : u.completion === 'saving' ? 'Saving First Light completion…' : 'First Light completion is not confirmed yet.'}</p>{u.completion !== 'confirmed' && <button type="button" className="fl-btn" data-tone="primary" disabled={u.completion === 'saving'} onClick={() => void g.finishSingleScreen()}>Save completion again</button>}<button type="button" className="fl-btn" data-tone={u.completion === 'confirmed' ? 'primary' : undefined} disabled={u.completion !== 'confirmed'} onClick={g.stop}>Continue</button></section>}
    {u.phase === 'greeted' && !busy && <button type="button" className="fl-btn" onClick={g.notNow}>Not now</button>}
    <div className="fl-u1-consent"><p>{shownName || 'Your omega'} acts only for you.</p><p>{outboundCopy}</p><details className="fl-small"><summary>What this means</summary><p>The current host API has not reported an outbound-approval policy here. Wake still uses the host’s existing model, key, egress and spending checks; earlier saved changes remain if a later step is refused.</p></details></div>
  </div>
}
