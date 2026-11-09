import { describe, expect, it, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * ASK-1 phase 2, rendered: Cosmos's transmission console, Flux's liquid capsule, Canvas's note card and Construct's prompt each draw the
 * same Ask (the shared hook and store) in their own grammar. Rendered on the server (no DOM): the field, its landmark
 * and combobox; and the thread's rows (your words, a steer, words held while admission is unknown, a refusal, the
 * answer, a move) in every grammar, as plain text. INVENTED data only.
 */
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

const { FloatingAsk } = await import('../features/ask/ClassicAsk')
const { ThreadLog } = await import('../features/ask/Thread')
const { CommandLine } = await import('./construct/CommandLine')
const { SKIN_WORDS } = await import('../features/ask/skins')
const { REFUSAL_WORDS } = await import('../features/ask/words')
type AskRow = import('../store/ask').AskRow

const place = { mode: 'desktop' as const, bottom: 74, left: 400, width: 640 }

describe('the floating skins render the one Ask in their own grammar', () => {
  const exp = { transmission: 'cosmos', liquid: 'flux', terminal: 'construct', note: 'canvas' } as const
  for (const look of ['transmission', 'liquid', 'terminal', 'note'] as const) {
    it(`${look}: a combobox field with the skin's words, kept clear, its own mark`, () => {
      const html = renderToStaticMarkup(createElement(FloatingAsk, { place, experience: exp[look], inputRef: createRef<HTMLInputElement>(), look }))
      expect(html).toContain(`data-look="${look}"`)
      expect(html).toMatch(/class="ask-dock"[^>]*data-xc-keep-clear=""/)
      expect(html).toMatch(/role="combobox"/)
      expect(html).toContain(`aria-label="${SKIN_WORDS[look].label}"`) // the skin's own words (small things F25)
      expect(html).toContain(`placeholder="${SKIN_WORDS[look].placeholder}"`)
      expect(html).toMatch(/aria-pressed="false"/) // the mic (voice arrives in phase 3)
      expect(html).not.toMatch(/omega/i)
    })
  }
})

describe('Construct: the prompt renders as the Ask', () => {
  it('one Ask landmark around the command line; a combobox the host can summon; asks fall through, commands stay', () => {
    const html = renderToStaticMarkup(createElement(CommandLine, { phone: false }))
    expect(html.match(/<section aria-label="Ask"/g)).toHaveLength(1)
    expect(html).toMatch(/data-ask-zone=""/)
    expect(html).toMatch(/role="combobox"[^>]*aria-autocomplete="list"|aria-autocomplete="list"[^>]*role="combobox"/)
    expect(html).toMatch(/data-ask-input=""/)
    expect(html).toContain('Command line: type a command, or ask anything')
    expect(html).toContain('or just ask')
    expect(html).toMatch(/aria-label="Show the ask log"/)
  })
})

describe('the thread renders every kind of row in every grammar, as plain text', () => {
  const rows: AskRow[] = [
    { id: 'r1', op: 'ask:1', kind: 'you', text: 'what is Lyra working on', where: 'in Cosmos' },
    { id: 'r2', op: 'ask:1', kind: 'steer', text: 'only the open goals', state: 'sent' },
    // words typed while the request's admission was unknown are held, and said so
    { id: 'r3', op: 'ask:1', kind: 'note', text: 'Held until the hive confirms it received your last request; then these words are sent.' },
    { id: 'r4', op: 'ask:1', kind: 'answer', text: 'Lyra has 12 open goals. <b>not html</b>', who: 'Vega' },
    { id: 'r5', op: 'ask:1', kind: 'nav', text: 'Opened Goals', state: 'applied', route: '#/goals', label: 'Goals' },
    { id: 'r6', op: 'ask:2', kind: 'refused', text: '', reason: 'spend_limit' },
    { id: 'r7', op: 'ask:3', kind: 'nav', text: 'Opened Usage', state: 'reverted', route: '#/usage', label: 'Usage' },
  ]
  const intro: Record<string, RegExp> = { transmission: /Incoming transmission · Vega/, liquid: />Vega</, terminal: /vega@hive/, glass: />Vega</, note: /A note from Vega/ }
  for (const variant of ['transmission', 'liquid', 'terminal', 'glass', 'note'] as const) {
    it(`${variant}: send, steer, held, answer, move, refused, reverted`, () => {
      const html = renderToStaticMarkup(createElement(ThreadLog, { rows, variant }))
      expect(html).toMatch(/role="log" aria-live="polite"/)
      expect(html).toContain(`data-variant="${variant}"`)
      expect(html).toContain('what is Lyra working on')
      expect(html).toMatch(/data-kind="steer"[^>]*>[\s\S]*only the open goals/)
      expect(html).toContain('Held until the hive confirms it received your last request')
      expect(html).toMatch(intro[variant])
      expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;') // the mind's words are text, never HTML
      expect(html).toMatch(/Opened Goals[\s\S]*Back/)
      expect(html).toContain(REFUSAL_WORDS.spend_limit.say)
      expect(html).toMatch(/<s[^>]*>Opened Usage<\/s>/) // reverted moves stay visible, struck through
      expect(html).not.toMatch(/omega/i)
    })
  }
})

it('every floating composer avoids a receipt/reading claim until waking has finished', () => {
  for (const words of Object.values(SKIN_WORDS)) {
    expect(words.step('Ada', 'preparing', false)).toBe('')
    expect(words.step('Ada', 'waking', false).toLowerCase()).toContain('waking')
    expect(words.step('Ada', 'waking', false)).not.toMatch(/reading|receiving|taking it in|writing/i)
  }
  expect(SKIN_WORDS.capsule.step('Ada', 'sending', true)).toBe('Ada is reading your request')
})
