/**
 * Still placeholder r2 (stand-in r1 FIX-FIRST, STANDIN_STILL_PLACEHOLDER_R1_VERDICT_20261007.md):
 * the question box's placeholder, rendered through Still's own Ask, at a phone width (390px) and a wide one (1440px),
 * idle and while an answer is writing, and across the 640px step (still.css's phone step) in both directions.
 *
 * The viewport is a fake width read by a stand-in useMediaQuery that evaluates the query the component actually asks
 * for (max-width/min-width in px), so the test pins both the strings and the breakpoint. On the unpatched Ask (which
 * never asks) every width shows the long strings and the phone cases fail.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const view = { width: 1440, answering: false }

/** Evaluate a CSS width media query against the fake viewport (the only kind Ask asks). */
function matches(query: string): boolean {
  const max = /max-width:\s*(\d+)px/.exec(query)
  const min = /min-width:\s*(\d+)px/.exec(query)
  if (!max && !min) return false
  return (!max || view.width <= Number(max[1])) && (!min || view.width >= Number(min[1]))
}

vi.mock('../../lib/hooks', async (orig) => ({ ...(await orig<typeof import('../../lib/hooks')>()), useMediaQuery: (q: string) => matches(q) }))
vi.mock('../../features/ask/useAskField', () => ({
  useAskField: () => ({
    value: '',
    list: [],
    panel: null,
    answering: view.answering,
    busy: false,
    active: null,
    sel: -1,
    setSel() {},
    change() {},
    onKeyDown() {},
    voiceText() {},
    take: async () => undefined,
    thread: null,
    answerer: 'Orchestrator',
    step: 'sending',
    declareSeen() {},
  }),
  // uifix-r2.2: the skin declares what it draws (a no-op here: these tests read the placeholder only)
  useSeen() {},
}))
vi.mock('../../features/ask/useAskVoice', () => ({
  useAskVoice: () => ({ listening: false, onFieldKey: () => false, button: {}, label: 'speak', state: 'idle' }),
}))
vi.mock('../../features/ask/VoiceParts', () => ({ VoiceAnnouncer: () => null, VoiceListening: () => null, VoiceNoticeView: () => null }))
vi.mock('../../features/ask/ClassicAsk', () => ({ PanelView: () => null }))
vi.mock('../../store/ask', () => ({ useAskStore: (sel: (s: { stop: () => void }) => unknown) => sel({ stop() {} }), askOrigin: () => ({ ok: () => true }) }))
vi.mock('./shared', () => ({ useSprings: () => ({ reduced: true, snappy: {}, fade: {} }) }))
vi.mock('../../lib/intent', async (orig) => ({ ...(await orig<typeof import('../../lib/intent')>()), examples: () => [] }))

const { Ask } = await import('./Ask')

/** Render Still's Ask at a width and state; return its input's placeholder. */
function placeholder(width: number, answering: boolean): string {
  view.width = width
  view.answering = answering
  const html = renderToStaticMarkup(createElement(Ask, { inputRef: { current: null }, world: {} as never, onAct: () => null }))
  const input = /<input[^>]*class="st-ask-input"[^>]*>/.exec(html)?.[0] ?? ''
  expect(input, 'the Ask input rendered').not.toBe('')
  // the accessible name never changes with the width
  expect(input).toContain('aria-label="What would you like the hive to do?"')
  return /placeholder="([^"]*)"/.exec(input)?.[1] ?? ''
}

const IDLE_SHORT = 'Ask the hive…'
const IDLE_LONG = 'What would you like the hive to do?'
const ANSWERING_SHORT = 'Add a word, or ask…'
const ANSWERING_LONG = 'Add a word while it writes, or ask anything'

afterEach(() => {
  view.width = 1440
  view.answering = false
})

describe('Still Ask placeholder fits the viewport (stand-in r1)', () => {
  it('idle: short at 390px, the unchanged long one at 1440px', () => {
    expect(placeholder(390, false)).toBe(IDLE_SHORT)
    expect(placeholder(1440, false)).toBe(IDLE_LONG)
  })
  it('while an answer is writing: short at 390px, the unchanged long one at 1440px', () => {
    expect(placeholder(390, true)).toBe(ANSWERING_SHORT)
    expect(placeholder(1440, true)).toBe(ANSWERING_LONG)
  })
  it('the step is 640px (still.css): 640 is a phone, 641 is wide', () => {
    expect(placeholder(640, false)).toBe(IDLE_SHORT)
    expect(placeholder(641, false)).toBe(IDLE_LONG)
    expect(placeholder(640, true)).toBe(ANSWERING_SHORT)
    expect(placeholder(641, true)).toBe(ANSWERING_LONG)
  })
  it('resizing across 640px in both directions follows the width', () => {
    const seen = [1440, 390, 1440, 641, 640, 1440].map((w) => placeholder(w, false))
    expect(seen).toEqual([IDLE_LONG, IDLE_SHORT, IDLE_LONG, IDLE_LONG, IDLE_SHORT, IDLE_LONG])
  })
})
