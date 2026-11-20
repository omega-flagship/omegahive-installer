// Purpose: verify each folded skin's conversation button marks what waits on the person in the Ask (an offer to build,
// a stopped task) with how many, where it marks rows with a dot, and names what waits in its words; and that it marks
// and says nothing more while nothing waits or while the thread is open.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

// the two reads the mark counts, as their shared hooks hand them over (each has its own tests); the thread itself is
// not this file's subject
const waits = vi.hoisted(() => ({ offers: 0, stops: 0 }))
const handle = (data: unknown[]) => ({ status: data.length ? 'ready' : 'empty', data, error: undefined, refreshing: false, reload() {}, mutate() {} })
vi.mock('../dot/useOpenOffers', () => ({ useOpenOffers: () => handle(Array.from({ length: waits.offers }, (_, i) => ({ id: `cof_${i}` }))) }))
vi.mock('../tasks/useTaskStops', () => ({ useTaskStops: () => handle(Array.from({ length: waits.stops }, (_, i) => ({ id: `stop_${i}` }))) }))
vi.mock('./Thread', async (original) => ({ ...(await original<typeof import('./Thread')>()), Thread: () => null, ThreadHead: () => null }))
// the Ask's rows and whether its thread is open, as the skins read them: a server render reads a zustand store's initial
// state (its server snapshot), never a setState, so the test hands the skins its own
const ask = vi.hoisted(() => ({ log: [] as unknown[], threadOpen: false }))
vi.mock('../../store/ask', async (original) => {
  const real = await original<typeof import('../../store/ask')>()
  const state = () => ({ ...real.useAskStore.getState(), log: ask.log, threadOpen: ask.threadOpen }) as ReturnType<typeof real.useAskStore.getState>
  const useAskStore = Object.assign((select?: (s: ReturnType<typeof state>) => unknown) => (select ? select(state()) : state()), real.useAskStore, { getState: state })
  return { ...real, useAskStore }
})

const { FloatingAsk } = await import('./ClassicAsk')
const { CommandLine } = await import('../../experiences/construct/CommandLine')
const { StillLine } = await import('./StillLine')
const { waitingWords } = await import('./waiting')

const place = { mode: 'desktop' as const, bottom: 74, left: 400, width: 640 }
const ROW = { kind: 'row', row: { id: 'r1', kind: 'you', text: 'what needs me?' } }
function show(state: { offers?: number; stops?: number; rows?: number; open?: boolean }) {
  waits.offers = state.offers ?? 0
  waits.stops = state.stops ?? 0
  ask.log = Array.from({ length: state.rows ?? 0 }, () => ROW)
  ask.threadOpen = !!state.open
}
const capsule = () => renderToStaticMarkup(createElement(FloatingAsk, { place, experience: 'classic', inputRef: createRef<HTMLInputElement>(), look: 'capsule' }))
const button = (html: string, label: RegExp) => html.match(new RegExp(`<button[^>]*aria-label="${label.source}"[^>]*>.*?</button>`))?.[0] ?? ''

afterEach(() => show({}))

describe('the floating Ask, folded', () => {
  it('marks an offer waiting with how many and says what waits, with no rows in the thread', () => {
    show({ offers: 1 })
    const b = button(capsule(), /Show the thread[^"]*/)
    expect(b).toContain('aria-label="Show the thread, an offer to build is waiting"')
    expect(b).toContain('title="Show the thread, an offer to build is waiting"')
    expect(b).toMatch(/<span class="ask-dot" data-waiting="" aria-hidden="true">1<\/span>/)
  })

  it('marks rows with the plain dot while nothing waits, and nothing at all with neither', () => {
    show({ rows: 2 })
    expect(button(capsule(), /Show the thread \(2 rows\)/)).toMatch(/<span class="ask-dot" aria-hidden="true"><\/span>/)
    show({})
    const empty = button(capsule(), /Show the thread/)
    expect(empty).not.toBe('')
    expect(empty).not.toContain('ask-dot')
  })

  it('counts every kind that waits beside rows, and marks nothing once the thread is open', () => {
    show({ offers: 1, stops: 2, rows: 3 })
    expect(button(capsule(), /Show the thread[^"]*/)).toMatch(/aria-label="Show the thread \(3 rows\), an offer to build and 2 stopped tasks are waiting"[\s\S]*data-waiting="" aria-hidden="true">3</)
    show({ offers: 1, open: true })
    const open = button(capsule(), /Hide the thread/)
    expect(open).not.toBe('')
    expect(open).not.toContain('ask-dot')
  })
})

describe('Construct’s ask log and Still’s page, folded', () => {
  it('the ask log’s toggle carries how many wait and its words name them', () => {
    show({ offers: 2, stops: 1 })
    const html = renderToStaticMarkup(createElement(CommandLine, { phone: false }))
    expect(html).toContain('aria-label="Show the ask log, 2 offers to build and a stopped task are waiting"')
    expect(html).toMatch(/<span class="cx-badge cx-ask-waiting" data-waiting="" aria-hidden="true">3<\/span>/)
    show({})
    const none = renderToStaticMarkup(createElement(CommandLine, { phone: false }))
    expect(none).toContain('aria-label="Show the ask log"')
    expect(none).not.toContain('cx-ask-waiting')
  })

  it('Still’s Today’s page carries how many wait and names them, and keeps its own words while nothing does', () => {
    const still = () => renderToStaticMarkup(createElement(StillLine, { place, inputRef: createRef<HTMLInputElement>(), words: [] }))
    show({ stops: 1 })
    expect(still()).toMatch(/aria-label="Today’s page, a stopped task is waiting"[^>]*>Today’s page<span class="ask-still-waiting" data-waiting="" aria-hidden="true">1<\/span>/)
    show({})
    const none = still()
    expect(none).toContain('>Today’s page</button>')
    expect(none).not.toContain('ask-still-waiting')
  })
})

describe('waitingWords', () => {
  it.each([
    [{ offers: 0, stops: 0 }, ''],
    [{ offers: 1, stops: 0 }, 'an offer to build is waiting'],
    [{ offers: 3, stops: 0 }, '3 offers to build are waiting'],
    [{ offers: 0, stops: 1 }, 'a stopped task is waiting'],
    [{ offers: 0, stops: 2 }, '2 stopped tasks are waiting'],
    [{ offers: 1, stops: 1 }, 'an offer to build and a stopped task are waiting'],
  ])('%o says %j', (waiting, words) => {
    expect(waitingWords(waiting)).toBe(words)
  })
})
