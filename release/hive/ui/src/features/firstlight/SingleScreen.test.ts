import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ASK_PURPOSE, askToSave } from './host'
import { SingleScreen, connectionState, monthProposal, monthToSave, ownMonthEditable } from './SingleScreen'
import type { Run } from './store'
import type { ProviderStatus } from '../../api/types'

/** Explicit pure-view props; no claim that setState changes Zustand's SSR initial snapshot. */
const sample = (): Run => ({
  id: 1, mode: 'live', path: 'owner', status: 'playing', loadError: null,
  facts: { name: 'Pip', host: 'Pip', mind: { id: 'a_personal', name: 'Wren', status: 'asleep' }, askHow: '', ownKeys: 1, limit: { done: false, enforced: false, enforced_by: null, limit_usd: null, spent_usd: 0, chosen_usd: null, host_name: null, pending_request: null }, greeted: false },
  hello: { hello: null, postedAt: null },
  u1: { context: 'known', model: 'actual-host/model', busy: false, phase: 'editing', error: null, profileSaved: false },
} as Run)
const answered: ProviderStatus = { name: 'actual-host', label: 'Invented provider', local: false, needs_key: true, connected: true, configured: true, readiness: 'answered', answer_ready: true, source: 'stored', keys: 1, key_hint: '', key_env: '', base_url: '', models: [] }
const render = (r: Run) => renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [answered] }))

describe('U1 single-screen view and explicit intent projection', () => {
  it('shows the exact editable default, name, current model and exactly one explicit Wake with no form or Next tour', () => {
    const s = render(sample())
    expect(s).toContain('Meet your omega')
    expect(s).toContain('value="Wren"')
    expect(s).toContain(DEFAULT_ASK_PURPOSE)
    expect(s).toContain('Invented provider')
    expect(s).not.toContain('actual-host/model')
    expect(s).toContain('this setting alone is not proof it answers')
    expect(s.match(/data-u1-wake=/g)).toHaveLength(1)
    expect(s).toContain('Wake Wren')
    expect(s).not.toContain('<form')
    expect(s).not.toContain('>Next<')
    expect(s).not.toContain('role="radiogroup"')
    expect(s).toContain('aria-label="Optional setup later"')
    expect(s).not.toContain('Choose a look')
    expect(s).not.toContain('Studio')
  })

  it('distinguishes unknown purpose from known empty and leaves whole long or multiline purpose untouched', () => {
    const r = sample()
    r.facts.askHow = null
    r.u1!.context = 'unavailable'
    const unknown = render(r)
    expect(unknown).toContain('not known yet')
    expect(unknown).not.toContain(DEFAULT_ASK_PURPOSE)
    expect(unknown).toMatch(/data-u1-wake=""[^>]*disabled/)
    r.facts.askHow = 'Whole\n' + 'x'.repeat(900)
    const long = render(r)
    expect(long).toContain('saving here keeps them')
    expect(long).not.toContain('<textarea')
    expect(askToSave('Wren', null, r.facts.askHow)).toEqual({ name: 'Wren', how: null })
    expect(askToSave('Wren', '', '')).toEqual({ name: 'Wren', how: '' })
  })

  it('proposes $5 only within confirmed own-key scope and preserves an untouched enforced amount including zero', () => {
    const r = sample()
    expect(monthProposal(r)).toBe(5)
    expect(monthToSave(r, null)).toBe(5)
    expect(render(r)).toContain('Proposed limit: $5 a month. It starts when you save.')
    for (const amount of [0, 17]) {
      r.facts.limit = { ...r.facts.limit!, enforced: true, enforced_by: 'own', limit_usd: amount }
      expect(monthProposal(r)).toBe(amount)
      expect(monthToSave(r, null)).toBeNull()
      expect(monthToSave(r, '9')).toBe(9)
    }
    expect(Number.isNaN(monthToSave(r, ''))).toBe(true)
    r.path = 'guest'
    expect(ownMonthEditable(r)).toBe(false)
    expect(monthToSave(r, '100')).toBeNull()
  })

  it('exposes unsupported provider sign-in and missing model or budget as unavailable instead of claiming readiness', () => {
    const r = sample()
    r.u1!.model = null
    r.u1!.context = 'unavailable'
    r.facts.limit = null
    const s = render(r)
    expect(s).toContain('not connected to this screen yet')
    expect(s).toMatch(/disabled=""[^>]*>Sign in with Claude/)
    expect(s).toMatch(/disabled=""[^>]*>Sign in with ChatGPT/)
    expect(s).toContain('current model is not confirmed')
    expect(s).toContain('limit could not be read')
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).not.toContain('Everything is ready')
  })

  it('only an actual greeted host record produces the attributed quote; this is not suite readiness', () => {
    const r = sample()
    expect(render(r)).not.toContain('<blockquote')
    r.hello.hello = { mind: { id: 'a_personal', name: 'Wren', status: 'awake' }, state: 'greeted', greeting: { id: 'm', text: 'Host-owned reply.', created_at: '2026-10-30T00:00:00Z' }, created: true, retryable: false, requested_at: null }
    expect(render(r)).not.toContain('<blockquote')
    r.facts.greeted = true
    r.u1!.phase = 'greeted'
    const s = render(r)
    expect(s).toContain('Recorded greeting from Wren')
    expect(s).toContain('<blockquote>Host-owned reply.</blockquote>')
    expect(s).toContain('does not establish that every creation service is ready')
    expect(s).not.toContain('data-u1-wake=')
  })

  it('paused view discloses already-sent work and exposes Resume without a second Wake', () => {
    const r = sample()
    r.status = 'paused'
    const s = render(r)
    expect(s).toContain('Any request already sent may still finish')
    expect(s).toContain('Resume First Light')
    expect(s).not.toContain('data-u1-wake=')
  })

  it('only typed not-answering evidence says down; unverified never says Connected and does not deadlock explicit Wake', () => {
    const p = { name: 'local', label: 'Model on this computer', local: true, needs_key: false, connected: true, configured: true, answer_ready: false, source: null, key_hint: '', key_env: '', base_url: '', models: [], readiness: 'not_answering' as const }
    const r = sample()
    r.u1!.model = 'local/from-host'
    const s = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [p] }))
    expect(s).toContain("The model on this computer isn&#x27;t answering.")
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).toMatch(/<details[^>]*open=""[^>]*data-u1-choices/)
    expect(s).toContain('Choose how Wren thinks')
    expect(connectionState(r.u1!.model, [{ ...p, readiness: 'answered', answer_ready: true }])).toBe('ready')
    expect(connectionState(r.u1!.model, [{ ...p, connected: true, test_only: true }])).toBe('demo')
    expect(connectionState('mock/example', [{ ...p, name: 'mock', connected: true }])).toBe('demo')
    expect(connectionState(r.u1!.model, null)).toBe('unknown')
    expect(connectionState(r.u1!.model, [{ ...p, readiness: 'unverified' }])).toBe('unverified')
    const unverified = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [{ ...p, readiness: 'unverified' } as ProviderStatus] }))
    expect(unverified).not.toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(unverified).not.toContain('Connected')
  })

  it('unknown charge exposes a manual credit-warning retry and usage, with no unsupported safety promise', () => {
    const r = sample()
    r.u1!.wakeUnknown = true
    r.u1!.error = "Wren couldn't finish waking. We couldn't confirm whether this was charged."
    r.u1!.saves = { name: 'saved', purpose: 'unknown', preferences: 'not_sent', priorLimitSaved: false, readback: { name: 'Wren', purpose: 'Whole\n' + 'x'.repeat(900) } }
    const s = render(r)
    expect(s).toContain('Try again: this may use credit')
    expect(s).toContain('Check usage')
    expect(s).toContain('Here’s what Wren has now')
    expect(s).toContain('x'.repeat(900))
    expect(s).toContain('Wren acts only for you.')
    expect(s).toContain("The outbound-approval policy could not be confirmed here")
    expect(s).not.toContain('Nothing was charged')
    expect(s).not.toContain('asks before anything leaves your space')
  })

  it('greeted-but-unconfirmed completion offers only progress retry and cannot enable Continue or replay Wake', () => {
    const r = sample()
    r.facts.greeted = true
    r.u1!.phase = 'greeted'
    r.u1!.completion = 'unknown'
    r.hello.hello = { mind: { id: 'a_personal', name: 'Wren', status: 'awake' }, state: 'greeted', greeting: { id: 'm', text: 'A recorded answer.', created_at: null }, created: true, retryable: false, requested_at: null }
    const pending = render(r)
    expect(pending).toContain('Save completion again')
    expect(pending).toMatch(/disabled=""[^>]*>Continue/)
    expect(pending).not.toContain('data-u1-wake=')
    r.u1!.completion = 'confirmed'
    const done = render(r)
    expect(done).toContain('First Light is saved as complete.')
    expect(done).not.toMatch(/disabled=""[^>]*>Continue/)
  })

  it('proven absent remote key plus no own key exposes the u1 help without mistaking a literal configured key or stale local readiness for absence', () => {
    const remote: ProviderStatus & { readiness: 'unverified' } = { name: 'remote', label: 'Remote provider', local: false, needs_key: true, connected: false, source: null, keys: 0, key_hint: '', key_env: '', base_url: '', models: [], readiness: 'unverified' }
    expect(connectionState('remote/model', [remote], 0)).toBe('no-provider')
    for (const [providers, own] of [
      [[{ ...remote, key_hint: 'set' }], 0], // ProviderStore.status has source null/keys0 for a literal configured key
      [[{ ...remote, key_hint: '…1234' }], 0],
      [[{ ...remote, keys: 1 }], 0],
      [[{ ...remote, source: 'env' }], 0],
      [[{ ...remote, keys: undefined }], 0],
      [[remote], 1],
      [[remote], null],
    ] as const) expect(connectionState('remote/model', [...providers], own)).toBe('unknown')
    const local = { ...remote, name: 'local', local: true, needs_key: false }
    expect(connectionState('remote/model', [remote, local], 0)).toBe('no-key')
    expect(connectionState('remote/model', [remote, { ...local, readiness: 'not_answering' }], 0)).toBe('no-provider')
    expect(connectionState('remote/model', [remote, { ...local, connected: true, readiness: 'answered' }], 0)).toBe('no-key')
    expect(connectionState('remote/model', null, 0)).toBe('unknown')
  })

  it('no-provider opens plain choices as the sole primary and holds Wake; configured-unverified still permits an explicit first answer attempt', () => {
    const r = sample()
    r.facts.ownKeys = 0
    r.u1!.model = 'remote/model'
    const provider: ProviderStatus = { name: 'remote', label: 'Remote provider', local: false, needs_key: true, connected: false, source: null, keys: 0, key_hint: '', key_env: '', base_url: '', models: [] }
    const s = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [provider] }))
    expect(s).toContain('data-u1-provider=""')
    expect(s).toContain('Wren can&#x27;t think yet. It needs a way to think.')
    expect(s).toContain('Still works: your own pages and edits, where your permissions allow.')
    expect(s).not.toContain('Demo app availability is not confirmed here.')
    expect(s).not.toContain('Your hive is set up and safe')
    expect(s).not.toContain('Connected')
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).toContain('Choose how Wren thinks')
    expect(s.match(/data-tone="primary"/g)).toHaveLength(1)
    const configured = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [{ ...provider, connected: true, configured: true, readiness: 'unverified', answer_ready: false, key_hint: 'set' }] }))
    expect(configured).not.toContain('data-u1-provider=""')
    expect(configured).toContain('This provider has not answered recently.')
    expect(configured).not.toMatch(/data-u1-wake=""[^>]*disabled/)
  })
  it('only active limit work shows Checking; stale amounts and unrelated busy profile work do not', () => {
    const r = sample()
    r.u1!.limitPending = 9
    r.facts.limit!.chosen_usd = 9
    const stale = render(r)
    expect(stale).toContain('We couldn&#x27;t confirm a spending limit here.')
    expect(stale).not.toContain('Checking your limit')
    expect(stale).toContain('<summary>Set a limit</summary>')
    expect(stale.match(/Monthly total on your own keys, dollars/g)).toHaveLength(1)
    expect(stale).toMatch(/<input type="number"[^>]*value="9"/)
    r.u1!.busy = true // e.g. profile work, not a limit request
    expect(render(r)).not.toContain('Checking your limit')
    r.u1!.limitChecking = true
    expect(render(r)).toContain('Checking your limit…')
    expect(render(r)).toContain('<summary>Change</summary>')
    r.u1!.busy = false // a stale flag cannot project an active operation
    expect(render(r)).not.toContain('Checking your limit')
    r.u1!.limitChecking = false
    r.u1!.limitPending = null
    expect(render(r)).toContain('Proposed limit: $9 a month. It starts when you save.')
    expect(render(r)).toContain('<summary>Change</summary>')
    r.facts.limit = { ...r.facts.limit!, enforced: true, enforced_by: 'own', limit_usd: 9 }
    expect(render(r)).toContain('Your minds may spend up to $9 a month.')
    expect(render(r)).toContain('<summary>Change</summary>')
  })

  it('generic unconfirmed scope masks an old enforced value without exposing another person’s amount', () => {
    const r = sample()
    r.facts.limit = { ...r.facts.limit!, enforced: true, enforced_by: 'own', limit_usd: 5 }
    r.u1!.limitUncertain = true
    r.u1!.limitPending = null
    const s = render(r)
    expect(s).toContain('We couldn&#x27;t confirm a spending limit here.')
    expect(s).not.toContain('Your minds may spend up to $5')
    expect(s).not.toContain('Checking your limit')
    expect(s).toContain('<summary>Set a limit</summary>')
    expect(s).not.toMatch(/<input type="number"[^>]*value="5"/)
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).toContain('Read current setup again')
  })

  it('keeps one primary after a refusal and visible consent without repeating the purpose helper', () => {
    const r = sample()
    r.u1!.error = 'The host refused this attempt.'
    const s = render(r)
    expect(s.match(/data-tone="primary"/g)).toHaveLength(1)
    expect(s).toContain('Read current setup again')
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).toContain('Wren acts only for you.')
    expect(s.match(/You can change this any time/g)).toHaveLength(1)
    expect(s.match(/In your own words\. You can change this any time on its page\./g)).toHaveLength(1)
    expect(s).not.toContain('Change monthly total')
    for (const phase of ['editing', 'waiting', 'greeted'] as const) {
      r.u1!.phase = phase
      expect(render(r)).toContain('Wren acts only for you.')
    }
  })

})
