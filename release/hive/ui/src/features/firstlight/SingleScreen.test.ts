// Purpose: verify First Light renders its observed states and actions in everyday words.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ASK_PURPOSE, askToSave } from './host'
import { SingleScreen, connectionState, landingAfter, monthProposal, monthToSave, ownMonthEditable } from './SingleScreen'
import type { Run } from './store'
import type { ProviderStatus } from '../../api/types'
import { outboundCopy, unknownModelCopy } from './conditionalCopy'

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
  it('Continue lands on the mind that greeted the person, in its chat where the greeting stays, and nowhere before it greets', () => {
    const r = sample()
    expect(landingAfter(r)).toBeNull()
    const greeted = { mind: { id: 'a_personal', name: 'Wren', status: 'awake' }, state: 'greeted' as const, greeting: { id: 'm_hello', text: 'Hello, I am Wren.', created_at: null }, created: true, retryable: false, requested_at: null }
    r.hello = { ...r.hello, hello: { ...greeted, state: 'waiting', greeting: null }, postedAt: 1 }
    expect(landingAfter(r)).toBeNull()
    r.hello = { ...r.hello, hello: greeted, postedAt: 1 }
    r.facts.greeted = true
    r.u1 = { ...r.u1!, phase: 'greeted', completion: 'confirmed' }
    expect(landingAfter(r)).toEqual({ name: 'dot', id: 'a_personal', tab: 'chat' })
    expect(render(r)).toMatch(/<button(?![^>]*disabled)[^>]*>Continue</)
  })

  it('shows the exact editable default, name, current model and exactly one explicit Wake with no form or Next tour', () => {
    const s = render(sample())
    expect(s).toContain('Meet your mind')
    // what First Light is, said on the card itself, since its name alone tells a new person nothing
    expect(s).toContain('First Light is your mind’s first wake-up: name it, say what it’s for, choose how it thinks, then wake it.')
    expect(s).toContain('value="Wren"')
    expect(s).toContain(DEFAULT_ASK_PURPOSE)
    expect(s).toContain('Invented provider')
    expect(s).not.toContain('actual-host/model')
    expect(s).not.toContain('read how it thinks') // a model the hive names needs no line about it
    expect(s.match(/data-u1-wake=/g)).toHaveLength(1)
    expect(s).toContain('Wake Wren')
    expect(s).not.toContain('<form')
    expect(s).not.toContain('>Next<')
    expect(s).not.toContain('role="radiogroup"')
    expect(s).not.toContain('aria-label="More to set up"') // a look, a role and the tour wait until First Light is finished
    expect(s).not.toContain('Choose a look')
    expect(s).not.toContain('Studio')
  })

  it('distinguishes unknown purpose from known empty and leaves whole long or multiline purpose untouched', () => {
    const r = sample()
    r.facts.askHow = null
    r.u1!.context = 'unavailable'
    const unknown = render(r)
    expect(unknown).toContain('couldn’t read what it’s for yet')
    expect(unknown).not.toContain(DEFAULT_ASK_PURPOSE)
    expect(unknown).toMatch(/data-u1-wake=""[^>]*disabled/)
    r.facts.askHow = 'Whole\n' + 'x'.repeat(900)
    const long = render(r)
    expect(long).toContain('saving here keeps it')
    expect(long).not.toContain('<textarea')
    expect(askToSave('Wren', null, r.facts.askHow)).toEqual({ name: 'Wren', how: null })
    expect(askToSave('Wren', '', '')).toEqual({ name: 'Wren', how: '' })
  })

  it('saves an own-key total only when the person changed it, shows the limit the hive holds, and keeps an enforced amount including zero', () => {
    const r = sample()
    expect(monthProposal(r)).toBe(5) // where the edit field starts
    expect(monthToSave(r, null)).toBeNull() // untouched: Wake saves no limit
    expect(monthToSave(r, '7')).toBe(7)
    expect(render(r)).toContain('No monthly limit is set yet.')
    expect(render(r)).not.toContain('Proposed limit')
    // the starting limit a first key brings is the hive's own monthly total: shown as it is, and where the edit starts
    r.facts.hiveMonthUsd = 50
    expect(render(r)).toContain('Your hive may spend up to $50 a month.')
    expect(monthProposal(r)).toBe(50)
    expect(monthToSave(r, null)).toBeNull()
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

  it('offers no sign-in that is not connected, and shows a missing model or budget as unavailable instead of claiming readiness', () => {
    const r = sample()
    r.u1!.model = null
    r.u1!.context = 'unavailable'
    r.facts.limit = null
    const s = render(r)
    expect(s).not.toContain('Sign in with')
    expect(s).not.toContain('not connected to this screen yet')
    expect(s).toContain('couldn’t read how it thinks yet')
    expect(s).toContain('read your monthly limit')
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).not.toContain('Everything is ready')
  })

  it('distinguishes a known hive limit from an unread limit on the person’s own keys', () => {
    const r = sample()
    r.facts.limit = null
    r.facts.hiveMonthUsd = 50
    const s = render(r)
    expect(s).toContain('Your hive may spend up to $50 a month.')
    expect(s).toContain('We couldn’t read the monthly limit on your own keys. Check again before waking it.')
    expect(s).not.toContain('We couldn’t read your monthly limit. Check again before waking it.')
  })

  it('only an actual greeted host record produces the attributed quote; this is not suite readiness', () => {
    const r = sample()
    expect(render(r)).not.toContain('<blockquote')
    r.hello.hello = { mind: { id: 'a_personal', name: 'Wren', status: 'awake' }, state: 'greeted', greeting: { id: 'm', text: 'Host-owned reply.', created_at: '2026-10-30T00:00:00Z' }, created: true, retryable: false, requested_at: null }
    expect(render(r)).not.toContain('<blockquote')
    r.facts.greeted = true
    r.u1!.phase = 'greeted'
    const s = render(r)
    expect(s).toContain('Wren says')
    expect(s).toContain('<blockquote>Host-owned reply.</blockquote>')
    expect(s).toContain('Wren is awake.')
    expect(s).not.toContain('data-u1-wake=')
  })

  it('paused view discloses already-sent work and exposes Resume without a second Wake', () => {
    const r = sample()
    r.status = 'paused'
    const s = render(r)
    expect(s).toContain('Anything already sent may still finish')
    expect(s).toContain('Resume First Light')
    expect(s).toContain(outboundCopy)
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
    expect(s).not.toContain('Check usage') // the usage page is outside First Light, so it waits until it is finished
    expect(s).toContain('Here’s what Wren has now')
    expect(s).toContain('x'.repeat(900))
    expect(s).toContain('Wren acts only for you.')
    expect(s).toContain(outboundCopy)
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
    expect(pending).toContain('Try saving again')
    expect(pending).toMatch(/disabled=""[^>]*>Continue/)
    expect(pending).not.toContain('data-u1-wake=')
    r.u1!.completion = 'confirmed'
    const done = render(r)
    expect(done).toContain('First Light is finished.')
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
    expect(s).toContain('Wren can&#x27;t think yet. Paste an OpenRouter key above to give it a way to think.')
    expect(s).not.toContain('data-u1-ways') // the status line already says to paste a key
    expect(s).not.toContain('Use a model on this computer') // this hive lists no model on this computer
    expect(s).not.toContain('Demo app availability is not confirmed here.')
    expect(s).not.toContain('Your hive is set up and safe')
    expect(s).not.toContain('Connected')
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    // the key field is the one way here, so it is open from the start and its Add key is the one primary
    expect(s).toContain('data-fl-inline-key')
    expect(s).not.toContain('Choose how Wren thinks')
    expect(s.match(/data-tone="primary"/g)).toHaveLength(1)
    const configured = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [{ ...provider, connected: true, configured: true, readiness: 'unverified', answer_ready: false, key_hint: 'set' }] }))
    expect(configured).not.toContain('data-u1-provider=""')
    expect(configured).toContain('hasn’t answered lately. Wake tries it.')
    expect(configured).not.toMatch(/data-u1-wake=""[^>]*disabled/)
  })
  it('only active limit work shows Checking; stale amounts and unrelated busy profile work do not', () => {
    const r = sample()
    r.u1!.limitPending = 9
    r.facts.limit!.chosen_usd = 9
    const stale = render(r)
    expect(stale).toContain('We couldn&#x27;t read your monthly limit.')
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
    expect(render(r)).toContain('No monthly limit is set yet.') // a chosen amount nobody edited here is not saved
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
    expect(s).toContain('We couldn&#x27;t read your monthly limit.')
    expect(s).not.toContain('Your minds may spend up to $5')
    expect(s).not.toContain('Checking your limit')
    expect(s).toContain('<summary>Set a limit</summary>')
    expect(s).not.toMatch(/<input type="number"[^>]*value="5"/)
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).toContain('Check again')
  })

  it('keeps one primary after a refusal and visible consent without repeating the purpose helper', () => {
    const r = sample()
    r.u1!.error = 'The host refused this attempt.'
    const s = render(r)
    expect(s.match(/data-tone="primary"/g)).toHaveLength(1)
    expect(s).toContain('Check again')
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

/** The mind has woken and greeted the person: the card's own part is over. */
const greet = (r: Run) => {
  r.facts.greeted = true
  r.u1!.phase = 'greeted'
  r.hello.hello = { mind: { id: 'a_personal', name: 'Wren', status: 'awake' }, state: 'greeted', greeting: { id: 'm', text: 'A recorded answer.', created_at: null }, created: true, retryable: false, requested_at: null }
}

describe('until First Light is finished its one way out is Not now', () => {
  const EXITS = ['>Close<', 'Take a tour', 'Change its look', 'Choose your role', 'Check usage']
  const states: Array<[string, (r: Run) => void]> = [
    ['editing', () => undefined],
    ['paused', (r) => { r.status = 'paused' }],
    ['waiting', (r) => { r.u1!.phase = 'waiting'; r.hello.postedAt = 0 }],
    ['busy', (r) => { r.u1!.busy = true }],
    ['refused', (r) => { r.u1!.error = 'The host refused this attempt.' }],
    ['wake unknown', (r) => { r.u1!.wakeUnknown = true; r.u1!.error = 'Unknown.' }],
    ['no way to think', (r) => { r.facts.ownKeys = 0; r.u1!.model = 'mock/echo' }],
    ['greeted, completion unconfirmed', (r) => { greet(r); r.u1!.completion = 'unknown' }],
  ]

  it('offers Not now and no other way out or later part in any unfinished state, and nothing while a Wake is in flight', () => {
    for (const [state, set] of states) {
      const r = sample()
      set(r)
      const s = render(r)
      for (const exit of EXITS) expect(s, `${state}: ${exit}`).not.toContain(exit)
      expect(s, state).not.toMatch(/<button(?![^>]*disabled)[^>]*>Continue</)
      const busy = state === 'busy' || state === 'waiting'
      if (busy) expect(s, state).not.toContain('>Not now<')
      else expect(s, state).toMatch(/<button(?![^>]*disabled)[^>]*data-u1-not-now=""[^>]*>Not now</)
    }
  })

  it('once the host records it finished, offers Close, its look, role and tour, and usage after an unknown Wake', () => {
    for (const [state, set] of states) {
      const r = sample()
      set(r)
      r.progress = { status: 'finished', current_beat: 'hello', beats_done: ['ask', 'hello'], beats_skipped: [], role_path: null, monthly_spend_usd: null, key_choice: null, version: 3 }
      const s = render(r)
      const busy = state === 'busy' || state === 'waiting'
      if (state === 'paused' || (!busy && !state.startsWith('greeted'))) expect(s, state).toContain('>Close<')
      expect(s, state).not.toContain('>Not now<') // nothing is left to set aside
      if (!busy && state !== 'paused') for (const later of ['Change its look', 'Choose your role', 'Take a tour']) expect(s, `${state}: ${later}`).toMatch(new RegExp(`<button(?![^>]*disabled)[^>]*>${later}<`))
      if (state === 'wake unknown') expect(s).toContain('Check usage')
      if (state.startsWith('greeted')) expect(s).toMatch(/<button(?![^>]*disabled)[^>]*>Continue</)
    }
  })

  it('a completion confirmed in this run counts as finished too', () => {
    const r = sample()
    greet(r)
    r.u1!.completion = 'confirmed'
    const s = render(r)
    expect(s).toMatch(/<button(?![^>]*disabled)[^>]*>Continue</)
    expect(s).toContain('aria-label="More to set up"')
  })
})

describe('the card asks for Check again only where it shows it', () => {
  const view = (r: Run, providers: ProviderStatus[] | null) => renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers }))
  const BUTTON = /<button[^>]*>Check again<\/button>/

  it('an unread provider status or own-key limit offers Check again while waking is ahead and no press is in flight, and no line names it otherwise', () => {
    for (const providers of [[answered], null]) for (const limitRead of [true, false]) for (const greeted of [false, true]) for (const busy of [false, true]) {
      const r = sample()
      if (!limitRead) r.facts.limit = null
      if (greeted) greet(r)
      r.u1!.busy = busy
      const s = view(r, providers)
      const state = `providers ${providers ? 'read' : 'unread'}, limit ${limitRead ? 'read' : 'unread'}${greeted ? ', greeted' : ''}${busy ? ', busy' : ''}`
      expect(BUTTON.test(s), state).toBe(!greeted && !busy && (!providers || !limitRead))
      if (!BUTTON.test(s)) expect(s, state).not.toContain('Check again')
      if (!providers) expect(s, state).toContain('We couldn’t check whether it can think.')
      if (!limitRead) expect(s, state).toContain('We couldn’t read the monthly limit on your own keys.')
    }
  })

  it('a hive that couldn’t say how its providers stand offers Check again as the one primary, holds Wake, and keeps the choices open with what else to do', () => {
    const s = view(sample(), null)
    expect(s).toMatch(/<button[^>]*data-tone="primary"[^>]*>Check again<\/button>/)
    expect(s.match(/data-tone="primary"/g)).toHaveLength(1)
    expect(s).toMatch(/data-u1-wake=""[^>]*disabled/)
    expect(s).toMatch(/<details[^>]*open=""[^>]*data-u1-choices/)
    expect(s).toContain('We couldn’t check whether it can think. Check again, or choose another way for it to think.')
  })
})

describe('every way to think is offered inside the card', () => {
  const openrouter: ProviderStatus = { name: 'openrouter', label: 'OpenRouter', local: false, needs_key: true, connected: true, configured: true, readiness: 'unverified', source: 'stored', keys: 1, key_hint: '…4400', key_env: '', base_url: '', models: [] }
  const models = [{ id: 'openrouter/anthropic/claude-sonnet-5.5', provider: 'openrouter', label: 'anthropic/claude-sonnet-5.5', local: false }]
  const view = (r: Run, providers: ProviderStatus[]) => renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers, models }))

  it('a key that would pay for this person’s mind is one tap; the key field and the local list open only when asked', () => {
    const r = sample()
    r.u1!.model = 'mock/echo'
    const s = view(r, [answered, openrouter])
    expect(s).toMatch(/data-u1-way="openrouter"[^>]*aria-pressed="false"[^>]*>Think with OpenRouter</)
    expect(s).toMatch(/data-u1-paste=""[^>]*>Paste an OpenRouter key</)
    expect(s).not.toMatch(/data-u1-paste=""[^>]*aria-expanded/) // an action that pastes, not a toggle
    expect(s).not.toContain('Use a model on this computer') // no local model listed: not offered
    const local = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers: [answered, openrouter], models: [...models, { id: 'local/llama-invented', provider: 'local', label: 'llama-invented', local: true }] }))
    expect(local).toMatch(/data-u1-local-open=""[^>]*aria-expanded="false"[^>]*>Use a model on this computer</)
    expect(s).not.toContain('data-fl-inline-key')
    expect(s).not.toContain('data-u1-local=""')
    // someone else's hive: offered when the host says the key would pay for their mind (their own saved key, a key
    // granted to them, or the owner's where the owner lets others use it), never when it says it wouldn't
    r.path = 'guest'
    expect(view(r, [answered, openrouter])).toMatch(/data-u1-way="openrouter"[^>]*>Think with OpenRouter</)
    expect(view(r, [answered, { ...openrouter, configured: false, connected: false }])).not.toContain('Think with OpenRouter')
  })

  it('on the demonstration model with no other way, the key field is open with where to get a key, and nothing folds it away', () => {
    const r = sample()
    r.facts.ownKeys = 0
    r.u1!.model = 'mock/echo'
    const mock: ProviderStatus = { name: 'mock', label: 'Mock', local: true, needs_key: false, connected: true, configured: true, readiness: 'test_only', test_only: true, source: null, keys: 0, key_hint: '', key_env: '', base_url: '', models: ['echo'] }
    const s = view(r, [mock])
    expect(s).toContain('data-fl-inline-key')
    expect(s).toContain('OpenRouter key</span>')
    expect(s).toContain('One OpenRouter key reaches every model. Get one at <a href="https://openrouter.ai/keys"')
    expect(s).toContain('Wren can&#x27;t think yet. Paste an OpenRouter key above to give it a way to think.')
    expect(s).not.toContain('Choose how Wren thinks')
    expect(s.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1]).not.toContain('Change')
    expect(s.match(/data-tone="primary"/g)).toHaveLength(1)
    // a way the person can tap instead (a key the hive has) leaves the field closed and says to choose
    const withWay = view(r, [mock, openrouter])
    expect(withWay).not.toContain('data-fl-inline-key')
    expect(withWay).toContain('Wren can&#x27;t think yet. Choose a way for it to think above.')
  })

  it('marks the way it already thinks with', () => {
    const r = sample()
    r.u1!.model = 'openrouter/anthropic/claude-sonnet-5.5'
    expect(view(r, [answered, openrouter])).toMatch(/data-u1-way="openrouter"[^>]*aria-pressed="true"/)
  })
})

describe('every line of the card is in everyday words', () => {
  // words an engineer writes and a person reads as something being broken (round 1 of user testing), and a raw time
  const ENGINEER = /\b(host|hosts|host’s|policy|outbound|invented|establish(es|ed)?|proof|readiness|scope|api|egress|explicit|provider|recorded|omega|sequence)\b/i
  const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
  // the fixture's own provider label says "Invented provider"; a real one is a company's name
  const named: ProviderStatus = { ...answered, label: 'OpenRouter' }
  // the hive's free inference (plans.freeRoute), as free.test.ts states it
  const free: ProviderStatus = { ...named, name: 'free', label: 'Free inference', needs_key: false, source: null, keys: 0, base_url: 'https://inference.asicloud.cudos.org/v1', models: ['minimax/minimax-m3.1-flash'], daily_calls: 200 }
  const greeted = { mind: { id: 'a_personal', name: 'Wren', status: 'awake' }, state: 'greeted' as const, greeting: { id: 'm', text: 'Hello, I am Wren.', created_at: '2026-11-10T06:00:11.934Z' }, created: true, retryable: false, requested_at: null }
  /** The card in every state a person can meet it: each one a change from the plain editing card. */
  const STATES: Record<string, (r: Run) => ProviderStatus[]> = {
    editing: () => [named],
    'model unknown': (r) => { r.u1!.model = null; r.u1!.context = 'unavailable'; return [named] },
    'model unknown with error': (r) => { r.u1!.model = null; r.u1!.context = 'unavailable'; r.u1!.error = unknownModelCopy; return [named] },
    'provider not answered lately': (r) => { r.u1!.model = 'remote/model'; return [{ ...named, name: 'remote', label: 'OpenRouter', readiness: 'unverified', answer_ready: false }] },
    'readiness unknown': () => null as unknown as ProviderStatus[],
    'key field open': (r) => { r.facts.ownKeys = 0; r.u1!.model = 'mock/echo'; return [{ ...named, name: 'mock', label: 'Mock', local: true, needs_key: false, readiness: 'test_only', test_only: true, keys: 0, source: null }] },
    'limit unread': (r) => { r.facts.limit = null; return [named] },
    'purpose unread': (r) => { r.facts.askHow = null; return [named] },
    'long purpose': (r) => { r.facts.askHow = 'Whole\n' + 'x'.repeat(900); return [named] },
    waiting: (r) => { r.u1!.phase = 'waiting'; r.hello.postedAt = 0; return [named] },
    greeted: (r) => { r.facts.greeted = true; r.u1!.phase = 'greeted'; r.u1!.completion = 'confirmed'; r.hello.hello = greeted; return [named] },
    'completion unsaved': (r) => { r.facts.greeted = true; r.u1!.phase = 'greeted'; r.u1!.completion = 'unknown'; r.hello.hello = greeted; return [named] },
    'completion saving': (r) => { r.facts.greeted = true; r.u1!.phase = 'greeted'; r.u1!.completion = 'saving'; r.hello.hello = greeted; return [named] },
    paused: (r) => { r.status = 'paused'; return [named] },
    'wake unknown': (r) => { r.u1!.wakeUnknown = true; r.u1!.error = "Wren couldn't finish waking. We couldn't confirm whether this was charged."; return [named] },
    'free inference offered': () => [named, free],
    'thinking with free inference': (r) => { r.u1!.model = 'free/minimax/minimax-m3.1-flash'; return [named, free] },
    'free inference no longer offered': (r) => { r.u1!.model = 'free/minimax/minimax-m3.1-flash'; return [named] },
    'free inference model dropped': (r) => { r.u1!.model = 'free/acme/retired-model'; return [named, free] },
  }
  it('no state shows an engineer’s word or a raw time, and the greeting is quoted with plain words around it', () => {
    for (const [name, make] of Object.entries(STATES)) {
      const r = sample()
      const providers = make(r)
      const text = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 12_000, providers })).replace(/<[^>]+>/g, ' ')
      expect(text, name).not.toMatch(ENGINEER)
      expect(text, name).not.toMatch(ISO_TIME)
    }
    const r = sample()
    STATES.greeted(r)
    const s = renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 12_000, providers: [named] }))
    expect(s).toContain('<p>Wren says</p><blockquote>Hello, I am Wren.</blockquote><p>Wren is awake.</p>')
  })
})

