// @vitest-environment node
/**
 * First Light on a fresh own hive, mounted on real ReactDOM (the MiniDOM) over the real store and the live host adapter;
 * only the hive's HTTP answers are scripted. Until the omega is named, can think and has woken, nothing in or around the
 * card but its Not now (or Escape) ends First Light, opens another page or records it as skipped. Every way to think
 * works inside the card: a key pasted there (refused or saved), a model on this computer, a key the hive already has.
 * The whole path ends with First Light recorded finished, with Continue and the later parts.
 *
 * Not now sets it aside (Jon, PR 39; Ahmad's choice on Syntropy 65): the host records it skipped, and the setup nudge
 * says Finish setup on every page until the person's mind has been awake; one tap reopens the card where they left off,
 * with what they typed and did not save.
 *
 * And it can always be finished, whatever the hive's state (Peter, Lisbon, 10 November: his personal mind archived after
 * he moved his minds to another swarm, his key already saved, and no way out): a key the hive already holds, pasted
 * again, counts as saved; an archived personal mind is restored, or another of the person's minds is woken instead;
 * where the hive leaves neither, First Light finishes without it; and a hive already in use before First Light came to
 * it is not held at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, MiniNode, press, reactProps } from '../../ui/miniDom.testkit'
import type { KeyInfo, ModelOption, ProviderStatus } from '../../api/types'
import { ApiError } from '../../api/client'
import { useHive } from '../../store/store'
import { addKeyRefusalWords } from '../keys/ownLimit'
import { SetupNudge } from '../setup/SetupChecklist'
import { FinishSetup } from '../setup/finishSetup'
import { BLANK_PROGRESS, type FlClient, type Progress } from './host'
import { startFirstLight, useFlDoor } from './door'
import { keepFlDraft, useFirstLight } from './store'

const nav = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../../lib/router', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/router')>()), navigate: (...a: unknown[]) => { nav.calls.push(a) } }))

/** A fresh own hive as its HTTP API answers First Light: no key yet, the first mind on the demonstration model. */
class OwnHive implements FlClient {
  log: string[] = []
  progress: Progress = { ...BLANK_PROGRESS }
  model = 'mock/echo'
  name = 'Omega'
  persona = ''
  ownKeys = 0
  awake = false
  /** the personal mind's swarm is archived: its wake is refused, as hive.require_open_swarm refuses it */
  archived = false
  admin = true
  retainedMutationScope() { return { host: 'https://own-hive.invalid', principal: 'user:owner' } }
  async restoreSwarm(id: string) {
    this.log.push(`restore:${id}`)
    this.archived = false
    return { id, name: this.name, description: 'Personal mind', hue: 0, archived_at: null, member_ids: ['a_personal'] }
  }
  async agentAction(id: string, action: string) {
    this.log.push(`${action}-other:${id}`)
    return { id, name: 'Helper', status: 'starting' }
  }
  async onboarding() { return { record: 'first-light.progress/1', ...this.progress } }
  async patchOnboarding(body: Record<string, unknown>) {
    const { version, ...w } = body
    this.log.push(`progress:${JSON.stringify(w)}`)
    if (version !== this.progress.version) throw new ApiError(409, 'stale_onboarding', 'changed')
    this.progress = { ...this.progress, ...(w as Partial<Progress>), version: this.progress.version + 1 }
    return { record: 'first-light.progress/1', ...this.progress }
  }
  async mySetup() {
    // no own-key total of the person's own: the starting limit a first key brings is the hive's month total (budgets)
    const limit = { id: 'monthly_limit', done: false, enforced: false, detail: { enforced_by: null, limit_usd: null, spent_usd: 0, chosen_usd: null } }
    return { items: [{ id: 'provider_key', done: this.ownKeys > 0, detail: { own_keys: this.ownKeys, guest: false } }, limit, { id: 'mind_awake', done: this.awake, detail: {} }], complete: false }
  }
  /** a key added on a fresh hive brings its starting month limit (POST /api/keys, HIVE_START_LIMIT_MONTH_USD, scope hive) */
  async listBudgets() {
    return this.ownKeys > 0 ? [{ id: 'b_hive', scope: 'hive', period: 'month', limit_usd: 50, spent_usd: 0, note: '', origin: 'rule' }] : []
  }
  async setOwnKeyLimit(body: Record<string, unknown>) {
    this.log.push(`limit:${JSON.stringify(body)}`)
    return {}
  }
  async hiveOwn() { return { owner_name: 'Rachel', you_are_owner: true, your_access: 'owner', visibility: 'private', pays: 'own-key' } }
  // as GET /api/auth/me answers: who is signed in (the setup nudges' × is per principal), their kind and role
  async me() { return { principal: 'user:owner', kind: 'person', role: this.admin ? 'admin' : 'member', person: { name: 'Rachel' } } }
  async myMind() { return { mind: { id: 'a_personal', name: this.name, status: this.awake ? 'awake' : 'asleep' } } }
  async getAgent(id: string) { return { id, name: this.name, persona: this.persona, model: this.model } }
  async patchAgent(id: string, body: { persona?: string; model?: string }) {
    this.log.push(`agent:${JSON.stringify(body)}`)
    if (body.model !== undefined) this.model = body.model
    if (body.persona !== undefined) this.persona = body.persona
    return { id, name: this.name, persona: this.persona, model: this.model }
  }
  async renameMyMind(name: string) {
    this.log.push(`name:${name}`)
    this.name = name
    return { mind: { id: 'a_personal', name, status: 'asleep' } }
  }
  async setAskSettings() { return {} }
  async programs() { return [] }
  async personalMindHello(wake: boolean) {
    if (!wake) return { hello: null }
    if (this.archived) throw new ApiError(409, 'cannot_wake', "Your mind couldn't wake just now. Try again in a moment, or ask an admin.")
    this.log.push(`wake:${this.model}`)
    this.awake = true
    return { mind: { id: 'a_personal', name: this.name, status: 'awake' }, state: 'greeted', greeting: { id: 'm1', text: `Hello, I am ${this.name}.`, created_at: null }, created: true, retryable: false, requested_at: null }
  }
}

const provider = (over: Partial<ProviderStatus> & { name: string }): ProviderStatus => ({ label: over.name, local: false, needs_key: true, connected: false, configured: false, source: null, keys: 0, key_hint: '', key_env: '', base_url: '', models: [], ...over } as ProviderStatus)
const mock = provider({ name: 'mock', label: 'Mock', local: true, needs_key: false, connected: true, configured: true, readiness: 'test_only', test_only: true, models: ['echo'] })
const anthropic = provider({ name: 'anthropic', label: 'Anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })
const echo: ModelOption = { id: 'mock/echo', provider: 'mock', label: 'echo', local: true }
/** The models the hive lists for a keyed provider once it has a key (hive/core/config.py's own lists). */
const LISTED: Record<string, { label: string; models: string[] }> = {
  openrouter: { label: 'OpenRouter', models: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-5.6-sol'] },
  anthropic: { label: 'Anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
}
const KEY = 'sk-or-' + 'v1-invented00000000000000000000000000000000000000000000000000000000'
const ANTHROPIC_KEY = 'sk-ant-' + 'api03-invented0000000000000000000000000000'
const REFUSED = 'sk-or-' + 'v1-refused000000000000000000000000000000000000000000000000000000000'
/** a key the person saved in this hive before (You & your keys, an older build): the hive refuses their own copy again */
const HELD = 'sk-or-' + 'v1-held0000000000000000000000000000000000000000000000000000000000000'

let hive: OwnHive
let added: unknown[]
/** The hive store's one key add (POST /api/keys) answered as the hive would: a refused key calls back with its error. */
const addKey = async (body: { provider: string; key: string; default?: boolean }, onError?: (err: unknown) => void): Promise<KeyInfo | null> => {
  added.push(body)
  if (body.key === REFUSED) {
    onError?.(new ApiError(400, 'key_invalid', 'The provider did not accept this key.'))
    return null
  }
  if (body.key === HELD) {
    onError?.(new ApiError(409, 'duplicate_key', 'that key is already saved as one of yours', { envelope: { code: 'duplicate_key', message: 'that key is already saved as one of yours', own: true, key_id: 'k_held' } }))
    return null
  }
  hive.ownKeys = 1
  const { label, models } = LISTED[body.provider]
  const key = { id: 'k1', provider: body.provider, provider_label: label, label: `${label} key`, owner: 'user:owner', hint: '…0000', default: true, created_at: null, spent_usd: 0, starting_limit: { usd: 50, scope: 'own' } } as unknown as KeyInfo
  const keyed = provider({ name: body.provider, label, connected: true, configured: true, readiness: 'unverified', source: 'stored', keys: 1, key_hint: '…0000', models })
  useHive.setState({ keys: [key], providers: [mock, ...(body.provider === 'anthropic' ? [] : [anthropic]), keyed], models: [echo, ...models.map((m) => ({ id: `${body.provider}/${m}`, provider: body.provider, label: m, local: false }))] })
  return key
}

let doc: MiniDocument, container: MiniNode, root: Root
let saved: Record<string, unknown>
let hiveBefore: ReturnType<typeof useHive.getState>
const selectors = { querySelector: (MiniNode.prototype as unknown as Record<string, unknown>).querySelector, closest: (MiniNode.prototype as unknown as Record<string, unknown>).closest }

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  doc = new MiniDocument()
  Object.assign(doc, { getElementById: () => null })
  // the layer asks whether a modal holds the screen, and "Choose how … thinks" looks for the first choice in the card:
  // the MiniDOM has no selectors, so neither finds anything
  Object.assign(MiniNode.prototype, { querySelector: () => null, closest: () => null })
  const media = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })
  const win = { document: doc, HTMLIFrameElement: class {}, innerWidth: 1280, innerHeight: 800, location: { hash: '#/', search: '' }, matchMedia: media, addEventListener: () => undefined, removeEventListener: () => undefined }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  hive = new OwnHive()
  added = []
  nav.calls.length = 0
  hiveBefore = useHive.getState()
  useHive.setState({ client: hive as never, providers: [mock, anthropic], models: [echo], keys: [], addKey })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await act(async () => root.unmount())
  useFirstLight.getState().stop()
  useFlDoor.setState({ asked: null, record: null })
  keepFlDraft(null)
  useHive.setState(hiveBefore, true)
  Object.assign(MiniNode.prototype, selectors)
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

const settle = async () => {
  for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function open() {
  const { default: FirstLightLayer } = await import('./FirstLightLayer')
  // First Light's layer, and the setup nudge App mounts beside it (outside every page and experience)
  await act(async () => root.render(createElement(Fragment, null, createElement(FirstLightLayer, { experience: 'classic' }), createElement(SetupNudge))))
  await act(async () => startFirstLight({ mode: 'live' }))
  await settle()
  expect(useFirstLight.getState().run?.u1).toBeTruthy()
}
const all = (pick: (n: MiniNode) => boolean) => doc.body.findAll(pick)
const words = (n: MiniNode) => n.textContent.trim()
const buttons = () => all((n) => n.tagName === 'BUTTON')
const button = (text: string) => {
  const b = buttons().find((x) => words(x) === text)
  if (!b) throw new Error(`no "${text}" button among ${buttons().map(words).join(' | ')}`)
  return b
}
const enabled = (n: MiniNode) => !n.hasAttribute('disabled')
const text = (tag: string) => all((n) => n.tagName === tag.toUpperCase()).map(words).join(' | ')
const type = async (n: MiniNode, value: string) => act(async () => { (reactProps(n).onChange as (e: unknown) => void)({ target: { value } }) })
const tap = async (n: MiniNode) => { await act(async () => press(n)); await settle() }
const field = (pick: (n: MiniNode) => boolean) => all((n) => n.tagName === 'INPUT' && pick(n))[0]
const panel = () => all((n) => n.tagName === 'SECTION' && n.getAttribute('aria-label') === 'First Light')[0]
const escape = async () => act(async () => { (reactProps(panel()).onKeyDown as (e: unknown) => void)({ key: 'Escape', preventDefault: () => undefined }) })
const EXITS = ['Not now', 'Close', 'Continue', 'Take a tour', 'Change its look', 'Choose your role', 'Check usage']
/** the ways out an unfinished card does not offer: everything but its Not now */
const NOT_YET = EXITS.filter((x) => x !== 'Not now')
const nudge = () => all((n) => n.getAttribute('data-tour') === 'finish-setup')

describe('First Light keeps its place until the person sets it aside or their omega wakes', () => {
  it('no control, key or later part of First Light but Not now ends an unfinished card, opens a page or records it skipped', async () => {
    await open()
    const id = useFirstLight.getState().run!.id
    // every enabled control the card shows but Not now, each pressed once, in every state the presses reach
    const pressed: string[] = []
    const pressable = (b: MiniNode) => enabled(b) && words(b) !== 'Not now' && !pressed.includes(words(b))
    for (let next = buttons().find(pressable); next; next = buttons().find(pressable)) {
      pressed.push(words(next))
      await tap(next)
      expect(useFirstLight.getState().run?.id).toBe(id)
    }
    await tap(button('Paste an OpenRouter key'))
    expect(pressed).toContain('Paste an OpenRouter key')
    expect(all((n) => n.hasAttribute('data-fl-inline-key'))).toHaveLength(1) // pressing Paste never hides the field
    // only ways that work are offered: this fresh hive has no plan, no model on this computer and no key yet
    expect(buttons().map(words).filter((w) => /^(Sign in with|Use a model on this computer|Think with)/.test(w))).toEqual([])
    // a later part (a link to its look or role) waits: it does not replace the unfinished card
    await act(async () => startFirstLight({ mode: 'live', beat: 'look' }))
    await settle()
    const run = useFirstLight.getState().run
    expect(run?.id).toBe(id)
    expect(run?.u1).toBeTruthy()
    expect(nav.calls).toEqual([])
    for (const exit of NOT_YET) expect(buttons().map(words)).not.toContain(exit)
    expect(enabled(button('Not now'))).toBe(true)
    // the host's record says First Light is under way, never skipped, so a load anywhere brings it back
    expect(hive.progress.status).toBe('in_progress')
    expect(hive.log.filter((x) => x.startsWith('progress:'))).toEqual(['progress:{"status":"in_progress"}'])
    expect(nudge()).toEqual([])
  })

  it('a refused key keeps the card and says why under the field; the same key is not sent again', async () => {
    await open()
    await type(field((n) => reactProps(n).type === 'password'), REFUSED)
    await tap(button('Add key'))
    const alert = all((n) => n.hasAttribute('data-fl-key-refused'))[0]
    expect(words(alert)).toBe(`${addKeyRefusalWords(new ApiError(400, 'key_invalid', 'The provider did not accept this key.'), 'OpenRouter')} Paste a different key to try again.`)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(enabled(button('Add key'))).toBe(false)
    expect(added).toEqual([{ provider: 'openrouter', key: REFUSED, default: true }])
    expect(hive.model).toBe('mock/echo')
    expect(useFirstLight.getState().run?.u1).toBeTruthy()
    expect(nav.calls).toEqual([])
  })

  it('the whole path: a name, a key pasted in the card, Wake; First Light is finished and only then can be left', async () => {
    await open()
    await type(field((n) => reactProps(n).placeholder === 'Give it a name'), 'Wren')
    expect(enabled(button('Wake Wren'))).toBe(false) // the demonstration model cannot think
    // with no other way to think on this hive the key field is already open, and the card says to paste a key
    expect(all((n) => n.hasAttribute('data-fl-inline-key'))).toHaveLength(1)
    expect(words(all((n) => n.hasAttribute('data-u1-provider'))[0])).toBe("Wren can't think yet. Paste an OpenRouter key above to give it a way to think.")
    // it asks for an OpenRouter key by name, with OpenRouter's keys page and why: one key reaches every model
    expect(text('label')).toContain('OpenRouter API key')
    expect(words(all((n) => n.hasAttribute('data-fl-key-lead'))[0])).toBe('One OpenRouter key reaches every model. Get one at openrouter.ai/keys.')
    expect(all((n) => n.tagName === 'A').map((a) => a.getAttribute('href'))).toContain('https://openrouter.ai/keys')
    expect(all((n) => n.getAttribute('role') === 'radio')).toEqual([]) // no provider to pick: the key's start decides
    await type(field((n) => reactProps(n).type === 'password'), KEY)
    await tap(button('Add key'))
    expect(added).toEqual([{ provider: 'openrouter', key: KEY, default: true }])
    // the key is how it thinks now, with no further choice: the mind moves onto OpenRouter's Sonnet, the key field closes
    expect(hive.model).toBe('openrouter/anthropic/claude-sonnet-5.5')
    expect(all((n) => n.hasAttribute('data-fl-inline-key'))).toEqual([])
    expect(words(all((n) => n.hasAttribute('data-u1-model'))[0])).toBe('OpenRouter')
    // the starting monthly limit the key brought is said in the card, since the pop-up saying it sits behind First Light
    expect(words(all((n) => n.hasAttribute('data-u1-start-limit'))[0])).toBe('Your monthly limit starts at $50. Change it on Limits.')
    // and the spending line shows that same limit, the one the hive holds, not a proposal of its own
    expect(words(all((n) => n.hasAttribute('data-u1-limit'))[0])).toBe('Your hive may spend up to $50 a month.')
    for (const exit of NOT_YET) expect(buttons().map(words)).not.toContain(exit)
    expect(enabled(button('Not now'))).toBe(true)
    await tap(button('Wake Wren'))
    expect(hive.log).toEqual(expect.arrayContaining(['name:Wren', 'wake:openrouter/anthropic/claude-sonnet-5.5']))
    expect(hive.progress).toMatchObject({ status: 'finished', beats_done: expect.arrayContaining(['ask', 'hello']) })
    expect(hive.log.filter((x) => x.startsWith('limit:'))).toEqual([]) // nobody changed the limit, so Wake wrote none
    expect(doc.body.textContent).toContain('Hello, I am Wren.')
    expect(doc.body.textContent).toContain('First Light is saved as complete.')
    // finished: the ways out and the later parts appear
    expect(enabled(button('Continue'))).toBe(true)
    expect(buttons().map(words)).not.toContain('Not now') // nothing is left to set aside
    for (const later of ['Change its look', 'Choose your role', 'Take a tour']) expect(enabled(button(later))).toBe(true)
    await escape()
    expect(useFirstLight.getState().run).toBeNull()
    expect(nav.calls).toEqual([])
    expect(nudge()).toEqual([])
  })

  it('a key from another provider still works: its start names the provider and the mind moves onto it', async () => {
    await open()
    await type(field((n) => reactProps(n).type === 'password'), ANTHROPIC_KEY)
    expect(text('label')).toContain('Anthropic API key')
    expect(text('p')).toContain('Anthropic key, read from how it starts (sk-ant-).')
    await tap(button('Add key'))
    expect(added).toEqual([{ provider: 'anthropic', key: ANTHROPIC_KEY, default: true }])
    expect(hive.model).toBe('anthropic/claude-sonnet-5-5')
    expect(nav.calls).toEqual([])
  })

  it('with no way to think yet, the key field is open from the start, and Paste puts the copied key in it and never hides it', async () => {
    await open()
    expect(all((n) => n.hasAttribute('data-fl-inline-key'))).toHaveLength(1)
    expect(buttons().map(words)).not.toContain('Choose how Omega thinks') // the open field is the next step
    // the summary does not fold the choices away while the omega cannot think, and says no "Change"
    const summary = all((n) => n.tagName === 'SUMMARY')[0]
    let folded = true
    ;(reactProps(summary).onClick as (e: unknown) => void)({ preventDefault: () => { folded = false } })
    expect(folded).toBe(false)
    expect(words(summary)).not.toContain('Change')
    // the key arrived inside a message: Paste finds it, puts it in the field with the cursor there, and sends nothing
    vi.stubGlobal('navigator', { userAgent: 'invented', clipboard: { readText: async () => `Here is your key: ${KEY}. Keep it safe!` } })
    await tap(button('Paste an OpenRouter key'))
    const key = field((n) => reactProps(n).type === 'password')
    expect(reactProps(key).value).toBe(KEY)
    expect(doc.activeElement).toBe(key)
    expect(words(all((n) => n.hasAttribute('data-fl-paste-hint'))[0])).toBe('Your key is in. Press Add key.')
    expect(added).toEqual([])
    // pressing it again pastes again; the field stays
    await tap(button('Paste an OpenRouter key'))
    expect(all((n) => n.hasAttribute('data-fl-inline-key'))).toHaveLength(1)
    expect(reactProps(field((n) => reactProps(n).type === 'password')).value).toBe(KEY)
    await tap(button('Add key'))
    expect(added).toEqual([{ provider: 'openrouter', key: KEY, default: true }])
    expect(hive.model).toBe(MODEL)
    expect(useFirstLight.getState().run?.u1).toBeTruthy()
    expect(nav.calls).toEqual([])
  })

  it('when the browser will not read what was copied, or it holds no key, Paste puts the cursor in the field and says how to paste', async () => {
    await open()
    vi.stubGlobal('navigator', { userAgent: 'invented', platform: 'MacIntel', clipboard: { readText: async () => { throw new Error('NotAllowedError') } } })
    await tap(button('Paste an OpenRouter key'))
    const key = () => field((n) => reactProps(n).type === 'password')
    const hint = () => all((n) => n.hasAttribute('data-fl-paste-hint')).map(words)
    expect(doc.activeElement).toBe(key())
    expect(hint()).toEqual(['Click the field and press ⌘ and V together.'])
    vi.stubGlobal('navigator', { userAgent: 'invented', platform: 'Win32', clipboard: { readText: async () => 'lunch at noon' } })
    await tap(button('Paste an OpenRouter key'))
    expect(reactProps(key()).value).toBe('')
    expect(hint()).toEqual(["There's no key in what you copied. Copy the key, then press Paste again, or click the field and press Ctrl and V together."])
    expect(all((n) => n.hasAttribute('data-fl-inline-key'))).toHaveLength(1)
    // a key pasted by hand: the hint has said its piece and goes
    await type(key(), KEY)
    expect(hint()).toEqual([])
    expect(added).toEqual([])
  })

  it('a model on this computer, chosen in the card, is how it thinks', async () => {
    const local = provider({ name: 'local', label: 'Model on this computer', local: true, needs_key: false, connected: true, configured: true, readiness: 'unverified', models: ['llama-invented'] })
    useHive.setState({ providers: [mock, anthropic, local], models: [echo, { id: 'local/llama-invented', provider: 'local', label: 'llama-invented', local: true }] })
    await open()
    await tap(button('Use a model on this computer'))
    await tap(button('llama-invented'))
    expect(hive.model).toBe('local/llama-invented')
    expect(words(all((n) => n.hasAttribute('data-u1-model'))[0])).toBe('A model on this computer')
    expect(enabled(button('Wake Omega'))).toBe(true)
    expect(nav.calls).toEqual([])
  })

  it('a key the hive already has is offered as a way to think, one tap', async () => {
    const openrouter = provider({ name: 'openrouter', label: 'OpenRouter', connected: true, configured: true, readiness: 'unverified', source: 'stored', keys: 1, key_hint: '…4400' })
    useHive.setState({ providers: [mock, anthropic, openrouter], models: [echo, ...['openai/gpt-invented', 'anthropic/claude-sonnet-5.5'].map((m) => ({ id: `openrouter/${m}`, provider: 'openrouter', label: m, local: false }))] })
    await open()
    await tap(button('Think with OpenRouter'))
    expect(hive.model).toBe('openrouter/anthropic/claude-sonnet-5.5')
    expect(enabled(button('Wake Omega'))).toBe(true)
  })
})

describe('First Light keeps what the person types', () => {
  it('an edit to its purpose sticks: a visible Save writes it, and the card shows it after saving and after reading again', async () => {
    await open()
    const purpose = () => all((n) => n.tagName === 'TEXTAREA')[0]
    expect(buttons().map(words)).not.toContain('Save')
    await type(purpose(), 'Help me plan our garden.')
    expect(hive.persona).toBe('') // typing alone sends nothing
    await tap(button('Save'))
    expect(hive.persona).toBe('Help me plan our garden.')
    expect(hive.name).toBe('Omega')
    expect(buttons().map(words)).not.toContain('Save')
    expect(reactProps(purpose()).value).toBe('Help me plan our garden.')
    await act(async () => useFirstLight.getState().reload())
    await settle()
    expect(reactProps(purpose()).value).toBe('Help me plan our garden.')
    expect(hive.progress.status).toBe('in_progress') // saving the profile does not finish First Light
  })
})

const MODEL = 'openrouter/anthropic/claude-sonnet-5.5'
/** The hive already holds the person's OpenRouter key (saved before First Light), so OpenRouter can think. */
function keyHeld() {
  hive.ownKeys = 1
  const openrouter = provider({ name: 'openrouter', label: 'OpenRouter', connected: true, configured: true, readiness: 'unverified', source: 'stored', keys: 1, key_hint: '…0000', models: LISTED.openrouter.models })
  useHive.setState({ providers: [mock, anthropic, openrouter], models: [echo, ...LISTED.openrouter.models.map((m) => ({ id: `openrouter/${m}`, provider: 'openrouter', label: m, local: false }))] })
}
/**
 * Peter's hive as GET /api/agents and GET /api/swarms list it: his personal mind (a_personal) in its own swarm, archived
 * unless `archived` is false, so left out of the open swarms; and, unless `helper` is null, another mind of his in an
 * open swarm, used before (`helper: 'used'`) or never woken.
 */
function peter({ archived = true, helper = 'unused' }: { archived?: boolean; helper?: 'used' | 'unused' | null } = {}) {
  hive.archived = archived
  const mine = { owner: 'user:owner', kind: 'omega', model: MODEL, status: 'asleep', last_active_at: null }
  // as GET /api/agents sends them (hive.agent_view): an owner and no personal_of; the personal mind is marked is_mine
  const agents = { a_personal: { ...mine, id: 'a_personal', name: 'Omega', swarm_id: 's_personal', is_mine: true },
    ...(helper ? { a_helper: { ...mine, id: 'a_helper', name: 'Helper', swarm_id: 's_work', last_active_at: helper === 'used' ? '2026-11-09T21:00:00Z' : null } } : {}) }
  const swarms = { s_work: { id: 's_work', name: 'Work', archived_at: null }, ...(archived ? {} : { s_personal: { id: 's_personal', name: 'Omega', archived_at: null } }) }
  useHive.setState({ agents: agents as never, swarms: swarms as never })
}

describe('First Light can always be finished, whatever the hive’s state', () => {
  it('a key the hive already holds, pasted again, counts as saved: no refusal, and it is how the omega thinks', async () => {
    keyHeld()
    await open()
    await tap(button('Paste an OpenRouter key'))
    await type(field((n) => reactProps(n).type === 'password'), HELD)
    await tap(button('Add key'))
    expect(added).toEqual([{ provider: 'openrouter', key: HELD, default: true }])
    expect(all((n) => n.hasAttribute('data-fl-key-refused'))).toEqual([])
    expect(text('p')).toContain('That OpenRouter key is already saved in this hive, so Omega thinks with it.')
    expect(hive.model).toBe(MODEL)
    expect(enabled(button('Wake Omega'))).toBe(true)
    await tap(button('Wake Omega'))
    expect(hive.progress).toMatchObject({ status: 'finished', beats_done: expect.arrayContaining(['ask', 'hello']) })
  })

  it('an archived personal mind: Wake is not offered, and Restore brings it back so Wake finishes First Light', async () => {
    keyHeld(); hive.model = MODEL; peter()
    await open()
    expect(words(all((n) => n.hasAttribute('data-u1-instead'))[0].findAll((n) => n.getAttribute('role') === 'status')[0])).toBe("Omega is archived, so it can't wake. Restore it to wake it here.")
    expect(buttons().map(words)).not.toContain('Wake Omega')
    expect(buttons().map(words)).not.toContain('Wake Helper') // a mind never used is not one of theirs in use
    for (const exit of NOT_YET) expect(buttons().map(words)).not.toContain(exit)
    expect(enabled(button('Not now'))).toBe(true)
    await tap(button('Restore Omega'))
    expect(hive.log).toContain('restore:s_personal')
    expect(all((n) => n.hasAttribute('data-u1-instead'))).toEqual([])
    await tap(button('Wake Omega'))
    expect(hive.log).toContain(`wake:${MODEL}`)
    expect(hive.progress).toMatchObject({ status: 'finished', beats_done: expect.arrayContaining(['ask', 'hello']) })
    expect(enabled(button('Continue'))).toBe(true)
    await escape()
    expect(useFirstLight.getState().run).toBeNull()
    expect(nav.calls).toEqual([])
  })

  it('an archived personal mind: another of the person’s own minds in use is woken instead, and First Light finishes with it', async () => {
    keyHeld(); hive.model = MODEL; peter({ helper: 'used' })
    await open()
    expect(words(all((n) => n.hasAttribute('data-u1-instead'))[0].findAll((n) => n.getAttribute('role') === 'status')[0])).toBe("Omega is archived, so it can't wake. Restore it to wake it here, or wake another of your minds and finish with that.")
    await tap(button('Wake Helper'))
    expect(hive.log).toContain('wake-other:a_helper')
    expect(hive.log.some((x) => x.startsWith('wake:'))).toBe(false) // the archived personal mind is left as it is
    expect(words(all((n) => n.hasAttribute('data-u1-ended'))[0])).toContain('Helper is awake.')
    expect(hive.progress.status).toBe('finished')
    expect(doc.body.textContent).toContain('First Light is saved as complete.')
    expect(enabled(button('Continue'))).toBe(true)
    await tap(button('Continue'))
    expect(useFirstLight.getState().run).toBeNull()
  })

  it('a member whose personal mind an admin archived, with no other mind in use: First Light finishes without it', async () => {
    keyHeld(); hive.model = MODEL; hive.admin = false; peter()
    await open()
    expect(buttons().map(words)).not.toContain('Restore Omega') // only an admin restores a swarm
    expect(buttons().map(words)).not.toContain('Wake Helper') // never used, so not offered
    expect(text('p')).toContain('Only an admin can restore it, so First Light can finish without it.')
    await tap(button('Finish First Light'))
    expect(hive.log.filter((x) => /^(restore|wake)/.test(x))).toEqual([])
    expect(hive.progress.status).toBe('finished')
    expect(hive.progress.beats_done).not.toContain('hello') // no greeting is claimed
    expect(words(all((n) => n.hasAttribute('data-u1-ended'))[0])).toContain('First Light finishes without waking Omega, which stays archived until an admin restores it.')
    expect(enabled(button('Continue'))).toBe(true)
  })

  it('a hive already in use before First Light came to it is not held: Close is there, and nothing marks it to come back', async () => {
    keyHeld(); peter({ helper: 'used' })
    await open()
    expect(words(all((n) => n.hasAttribute('data-u1-may-leave'))[0])).toBe('You\'ve used this hive before, so you can close this whenever you like.')
    expect(enabled(button('Close'))).toBe(true)
    expect(buttons().map(words)).not.toContain('Not now')
    expect(hive.log.filter((x) => x.startsWith('progress:'))).toEqual([]) // its record is left not started
    await escape()
    expect(useFirstLight.getState().run).toBeNull()
    expect(hive.progress.status).toBe('not_started')
    expect(nudge()).toEqual([]) // closing writes nothing, so nothing asks to finish it
  })

  it('a hive whose person’s own mind has been awake is in use too: Close is there, and nothing marks it to come back', async () => {
    keyHeld(); peter({ archived: false, helper: null }); personal({ last_active_at: '2026-11-09T21:00:00Z' })
    await open()
    expect(words(all((n) => n.hasAttribute('data-u1-may-leave'))[0])).toBe('You\'ve used this hive before, so you can close this whenever you like.')
    expect(enabled(button('Close'))).toBe(true)
    expect(buttons().map(words)).not.toContain('Not now')
    expect(hive.log.filter((x) => x.startsWith('progress:'))).toEqual([])
    await escape()
    expect(useFirstLight.getState().run).toBeNull()
    expect(nudge()).toEqual([])
  })

  it('a record an older build left skipped (its Not now) stays skipped: its Not now keeps it so, and Finish setup offers it again', async () => {
    hive.progress = { ...BLANK_PROGRESS, status: 'skipped', version: 3 }
    await open()
    expect(all((n) => n.hasAttribute('data-u1-may-leave'))).toEqual([])
    expect(buttons().map(words)).not.toContain('Close')
    await tap(button('Not now'))
    expect(useFirstLight.getState().run).toBeNull()
    expect(hive.progress).toMatchObject({ status: 'skipped', version: 3 })
    expect(hive.log.filter((x) => x.startsWith('progress:'))).toEqual([]) // already skipped: nothing is written
  })
})

/** A fresh hive with the person's personal mind asleep and never woken, in its own open swarm, as the hive lists it. */
function fresh() {
  peter({ archived: false, helper: null })
  useHive.setState({ ready: true })
}
const tapNudge = async () => tap(nudge()[0].findAll((n) => n.tagName === 'BUTTON')[0])
const nameField = () => field((n) => reactProps(n).placeholder === 'Give it a name')
const purposeField = () => all((n) => n.tagName === 'TEXTAREA')[0]
const keyField = () => field((n) => reactProps(n).type === 'password')
/** the personal mind as the next GET /api/agents or agent.updated would carry it */
const personal = (over: Record<string, unknown>) => {
  const agents = useHive.getState().agents as unknown as Record<string, Record<string, unknown>>
  useHive.setState({ agents: { ...agents, a_personal: { ...agents.a_personal, ...over } } as never })
}

describe('Not now sets First Light aside, and Finish setup brings it back where the person left off', () => {
  it('Not now closes the card and records it skipped; Finish setup then shows', async () => {
    fresh()
    await open()
    expect(nudge()).toEqual([]) // not while First Light is open
    await type(nameField(), 'Wren')
    await tap(button('Not now'))
    expect(useFirstLight.getState().run).toBeNull()
    expect(hive.progress.status).toBe('skipped')
    expect(hive.log.filter((x) => x.startsWith('progress:'))).toEqual(['progress:{"status":"in_progress"}', 'progress:{"status":"skipped"}'])
    expect(nav.calls).toEqual([])
    expect(nudge().map(words)).toEqual(['Finish setup'])
  })

  it('one tap on Finish setup reopens the card where the person left off: what they typed, but never a pasted key', async () => {
    fresh()
    await open()
    await type(nameField(), 'Wren')
    await type(purposeField(), 'Help me plan our garden.')
    await type(keyField(), KEY) // pasted, not added
    await tap(button('Not now'))
    await tapNudge()
    expect(useFirstLight.getState().run?.u1).toBeTruthy()
    expect(nudge()).toEqual([])
    expect(reactProps(nameField()).value).toBe('Wren')
    expect(reactProps(purposeField()).value).toBe('Help me plan our garden.')
    expect(reactProps(keyField()).value ?? '').toBe('')
    expect(added).toEqual([])
    expect(hive.name).toBe('Omega') // typed, not saved: nothing was written for it
    // set aside, it stays so while open again: a reload does not bring it back by itself
    expect(hive.progress.status).toBe('skipped')
    expect(enabled(button('Not now'))).toBe(true)
  })

  it('Escape sets it aside the same way', async () => {
    fresh()
    await open()
    await escape()
    await settle()
    expect(useFirstLight.getState().run).toBeNull()
    expect(hive.progress.status).toBe('skipped')
    expect(nudge().map(words)).toEqual(['Finish setup'])
  })

  it('Finish setup stays whichever page is open', async () => {
    fresh()
    await open()
    await tap(button('Not now'))
    for (const page of ['#/settings', '#/me', '#/usage', '#/code', '#/']) {
      ;(window as unknown as { location: { hash: string } }).location.hash = page
      personal({}) // the hive store moves on, as it does on every page
      await settle()
      expect(nudge().map(words)).toEqual(['Finish setup'])
    }
  })

  it('it ends once the person’s mind has been awake, and the mind going back to sleep does not bring it back', async () => {
    fresh()
    await open()
    await tap(button('Not now'))
    expect(nudge()).toHaveLength(1)
    personal({ status: 'awake', last_active_at: '2026-11-10T03:00:00Z' })
    await settle()
    expect(nudge()).toEqual([])
    personal({ status: 'asleep' })
    await settle()
    expect(nudge()).toEqual([])
  })

  it('finishing First Light from it ends it for good', async () => {
    fresh(); keyHeld(); hive.model = MODEL
    await open()
    await tap(button('Not now'))
    await tapNudge()
    await tap(button('Wake Omega'))
    expect(hive.progress).toMatchObject({ status: 'finished', beats_done: expect.arrayContaining(['ask', 'hello']) })
    await tap(button('Continue'))
    expect(useFirstLight.getState().run).toBeNull()
    expect(nudge()).toEqual([])
  })

  it('every way First Light can always be finished stays: an archived personal mind is set aside and taken up again from Finish setup', async () => {
    keyHeld(); hive.model = MODEL; peter(); useHive.setState({ ready: true })
    await open()
    await tap(button('Not now'))
    expect(nudge().map(words)).toEqual(['Finish setup'])
    await tapNudge()
    await tap(button('Restore Omega'))
    await tap(button('Wake Omega'))
    expect(hive.progress.status).toBe('finished')
    await tap(button('Continue'))
    expect(nudge()).toEqual([])
  })

  it('a hive already in use, the simulator and another sign-in see no Finish setup', async () => {
    keyHeld(); peter({ archived: false, helper: 'used' }); useHive.setState({ ready: true })
    hive.progress = { ...BLANK_PROGRESS, status: 'skipped', version: 2 }
    await open()
    await tap(button('Close')) // a hive in use offers Close, and closing writes nothing
    expect(nudge()).toEqual([])
    // the person's record noted skipped on a hive not in use, then read by the simulator or by someone else
    peter({ archived: false, helper: null })
    useFlDoor.setState({ record: null })
    const { noteFlRecord } = await import('./door')
    noteFlRecord('skipped')
    await settle()
    expect(nudge()).toHaveLength(1)
    useHive.setState({ client: Object.assign(new OwnHive(), { mode: 'sim', demo: true }) as never })
    await settle()
    expect(nudge()).toEqual([])
    useHive.setState({ client: new OwnHive() as never }) // another sign-in: the record noted was not theirs
    await settle()
    expect(nudge()).toEqual([])
  })

  it('its × hides it for this person in this browser, on every page; First Light is still there when asked for', async () => {
    const kept = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) })
    fresh()
    await open()
    await tap(button('Not now'))
    expect(nudge().map(words)).toEqual(['Finish setup'])
    await tap(nudge()[0].findAll((n) => n.getAttribute('aria-label') === 'Hide Finish setup for me')[0])
    expect(nudge()).toEqual([])
    expect([...kept.entries()]).toEqual([['omegahive.finish-setup.dismissed.user:owner', '1']])
    for (const page of ['#/settings', '#/me', '#/']) {
      ;(window as unknown as { location: { hash: string } }).location.hash = page
      personal({}) // the hive store moves on, as it does on every page
      await settle()
      expect(nudge()).toEqual([])
    }
    // the Me page's Meet your mind (or the Ask) still opens it
    await act(async () => startFirstLight({ mode: 'live' }))
    await settle()
    expect(useFirstLight.getState().run?.u1).toBeTruthy()
  })

  it('waits until the hive store lists the person’s own minds: a list still loading is never read as a hive not in use', async () => {
    fresh()
    await open()
    await tap(button('Not now'))
    expect(nudge()).toHaveLength(1)
    const agents = useHive.getState().agents
    useHive.setState({ ready: false })
    await settle()
    expect(nudge()).toEqual([])
    useHive.setState({ ready: true, agents: {} }) // read, but no personal mind of theirs listed yet
    await settle()
    expect(nudge()).toEqual([])
    useHive.setState({ agents })
    await settle()
    expect(nudge().map(words)).toEqual(['Finish setup'])
  })

  it('a page drawn with ui/Page carries it in its own header, in place of the floating copy', async () => {
    fresh()
    const { noteFlRecord } = await import('./door')
    noteFlRecord('skipped')
    const { Page } = await import('../../ui/Page')
    await act(async () => root.render(createElement(Fragment, null, createElement(Page, { title: 'Usage', label: 'Usage', children: 'what the page shows' }), createElement(SetupNudge))))
    await settle()
    const header = all((n) => n.tagName === 'HEADER')[0]
    expect(header.findAll((n) => n.getAttribute('data-tour') === 'finish-setup').map(words)).toEqual(['Finish setup'])
    expect(nudge().map((n) => n.getAttribute('data-place'))).toEqual(['page'])
  })

  it('a page with its own header row shows it there, and the floating copy stands down while it does', async () => {
    fresh()
    const { noteFlRecord } = await import('./door')
    noteFlRecord('skipped')
    const both = createElement(Fragment, null, createElement(FinishSetup, { inline: true }), createElement(SetupNudge))
    await act(async () => root.render(both))
    await settle()
    expect(nudge().map((n) => n.getAttribute('data-place'))).toEqual(['page'])
    await act(async () => root.render(createElement(SetupNudge)))
    await settle()
    expect(nudge().map((n) => n.getAttribute('data-place'))).toEqual(['above'])
  })
})
