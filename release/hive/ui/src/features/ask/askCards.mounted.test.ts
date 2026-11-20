// @vitest-environment node
// Purpose: verify a mind's offer to build in Create shows in the Ask whatever its thread shows: Professional's card with
// no rows and with its conversation hidden, Still's question box before today's page, and a folded Ask opened with no
// rows, each with the stopped tasks and Directing Studio beside it, and Professional's conversation once it is shown.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, type MiniNode } from '../../ui/miniDom.testkit'
import { ScreensSpace } from '../../screens/screenSpace'

type Heard = { type: string; agent_id?: string }
const state = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  swarms: {} as Record<string, unknown>,
  agents: {} as Record<string, unknown>,
  heard: new Set<(e: { type: string; agent_id?: string }) => void>(),
  ask: { log: [] as unknown[], threadOpen: false, turns: {}, thread: null, local: {} as Record<string, unknown> },
}))
// the Ask's whole state as useAskStore() without a selector gives it (ThreadHead reads it whole), its calls inert
const askState = vi.hoisted(() => () => ({ ...state.ask, personal: undefined, setThreadOpen: (open: boolean) => { state.ask.threadOpen = open }, stop: async () => undefined }))
// the hive's store as the cards and lib/identityEpoch read it (each test's client is one identity), and the Ask's as the
// skins read it: today's log and whether its conversation is shown
vi.mock('../../store/store', async (original) => ({
  ...(await original<typeof import('../../store/store')>()),
  useHive: Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => ({ client: state.client, session: null, inits: 0 }),
    subscribe: () => () => undefined,
  }),
  hiveBus: { on: (fn: (e: Heard) => void) => { state.heard.add(fn); return () => { state.heard.delete(fn) } } },
}))
vi.mock('../../store/ask', async (original) => ({
  ...(await original<typeof import('../../store/ask')>()),
  useAskStore: Object.assign((select?: (s: ReturnType<typeof askState>) => unknown) => (select ? select(askState()) : askState()), {
    getState: askState,
    subscribe: () => () => undefined,
  }),
}))
// the real look state (the Ask's size reads it: a person with no saved size has the bubble), worn as Classic
vi.mock('../../shell/uiVariant', async (original) => ({ ...(await original<object>()), useLook: () => ({ current: { experience: 'classic' } }) }))
vi.mock('../../screens/useCompose', () => ({ useCompose: () => (name: string, facts: Parameters<typeof space.compose>[2]) => space.compose(name, 'classic', facts) }))
// the other cards beside the offers, as markers: each has its own tests
vi.mock('../tasks/StoppedTasks', async () => {
  const { createElement: el } = await import('react')
  return { StoppedTasks: () => el('i', { 'data-stopped-tasks': '' }) }
})
vi.mock('../studioLive/DirectingStudio', async () => {
  const { createElement: el } = await import('react')
  return { DirectingStudio: () => el('i', { 'data-directing-studio': '' }) }
})
// Professional's field, voice and choosers at rest: this is about what shows under the field
vi.mock('./useAskField', () => ({
  useAskField: () => ({
    value: '', list: [], panel: null, active: null, answering: false, preparing: false, waking: false, answerer: undefined, chip: undefined,
    change() {}, voiceText() {}, valueNow: () => '', setSel() {}, setPanel() {}, run: async () => undefined, take: async () => undefined,
    submit: async () => undefined, onKeyDown() {}, declareSeen() {},
  }),
  useSeen: () => undefined,
  keepFieldFocus: () => undefined,
}))
vi.mock('./useAskVoice', () => ({ useAskVoice: () => ({ listening: false, notice: null, label: 'Voice', button: {}, onFieldKey: () => false }) }))
vi.mock('./VoiceParts', () => ({ VoiceAnnouncer: () => null, VoiceListening: () => null, VoiceNoticeView: () => null }))
vi.mock('./AnswererPicker', () => ({ AnswererInline: () => null, AnswererPicker: () => null, AnswererRefusal: () => null }))
vi.mock('./ClassicAsk', () => ({ PanelView: () => null }))
vi.mock('../../experiences/professional/binding', () => ({ current: () => true }))
const { ProfessionalAsk } = await import('../../experiences/professional/Ask')
const { StillLetter } = await import('../../experiences/still/Letter')
const { Thread } = await import('./Thread')

const space = ScreensSpace.open()
let container: MiniNode, root: Root, saved: Record<string, unknown>
const OFFER = { id: 'cof_1', mind: { id: 'a_dot', name: 'Dot' }, sentence: 'a tip calculator', state: 'offered', plan_id: null, created_at: '2026-11-20T09:30:00Z' }
const CARD = 'Dot can build this in Create: “a tip calculator”'
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
const count = (pick: (n: MiniNode) => boolean) => container.findAll(pick).length
const starts = () => count((n) => n.tagName === 'BUTTON' && n.textContent === 'Start in Create')
const marked = (attr: string) => count((n) => n.attributes.has(attr))
const logs = () => count((n) => n.attributes.get('role') === 'log')
async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => root.render(element))
  await flush()
}

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const key of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[key] = g[key]
  const doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win; g.window = win; g.document = doc; g.HTMLIFrameElement = win.HTMLIFrameElement; g.IS_REACT_ACT_ENVIRONMENT = true
  container = doc.createElement('div'); doc.body.appendChild(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container as unknown as Element)
  state.client = { createOffers: async () => [OFFER] }
  state.ask.log = []; state.ask.threadOpen = false
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value
})

it('Professional’s Ask with no rows shows the offer card with Start, beside the stopped tasks and Directing Studio', async () => {
  await mount(createElement(ProfessionalAsk, { ctx: 'test', inputRef: { current: null } }))
  expect(container.textContent).toContain(CARD)
  expect(starts()).toBe(1)
  expect(marked('data-stopped-tasks')).toBe(1)
  expect(marked('data-directing-studio')).toBe(1)
  expect(logs()).toBe(0)
})

it('Professional’s Ask with rows and its conversation hidden still shows the card; shown, the conversation holds it once', async () => {
  state.ask.log = [{ kind: 'row', row: { id: 'r1', kind: 'you', text: 'what needs me?' } }]
  await mount(createElement(ProfessionalAsk, { ctx: 'test', inputRef: { current: null } }))
  expect(container.textContent).toContain(CARD)
  expect(logs()).toBe(0)
  state.ask.threadOpen = true
  await mount(createElement(ProfessionalAsk, { ctx: 'test2', inputRef: { current: null } }))
  expect(logs()).toBe(1)
  expect(starts()).toBe(1)
  expect(marked('data-directing-studio')).toBe(1)
})

it('Still’s question box before today’s page has rows shows the card, beside the stopped tasks and Directing Studio', async () => {
  await mount(createElement(StillLetter, { words: [] }))
  expect(container.textContent).toContain(CARD)
  expect(starts()).toBe(1)
  expect(marked('data-stopped-tasks')).toBe(1)
  expect(marked('data-directing-studio')).toBe(1)
  expect(logs()).toBe(0)
})

it('a folded Ask opened with no rows (its thread) shows its empty line and then the card', async () => {
  await mount(createElement(Thread, { variant: 'glass' }))
  expect(logs()).toBe(1)
  expect(container.textContent).toContain('Ask for anything')
  expect(container.textContent).toContain(CARD)
  expect(starts()).toBe(1)
})
