/**
 * An artifact chip in words said in the hive (Screen.tsx's said block) carries no colour of its own: its title, icon,
 * edge and tint take the colour of the words it sits in, so it reads at the bubble's own contrast. A tester on v0.31 saw
 * the Canvas chip's title in her look's pale ink on the Canvas's light bubble, barely readable.
 *
 * For every look a person can wear, in both Canvas modes and in both bubbles (a mind's words and the person's own), this
 * takes the colour the chip's own classes give its title (a look token it names, else the words' colour) and holds its
 * contrast against the bubble to WCAG's 4.5:1. The chip is drawn by the real block, through InlineParts.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InlineParts, type ScreenHost } from './Screen'
import type { ScreenPlan } from './plan'
import { DEFAULT_VARIANT, SEED_VARIANTS } from '../shell/uiVariant'
import { TOKENS, type Mode } from '../experiences/canvas/theme'
import { contrast } from '../experiences/canvas/contrast'

const NAMED = `ar_${'0123456789abcdef'.repeat(2)}`
const GONE = `ar_${'fedcba9876543210'.repeat(2)}`
const plan = {
  screen: 'words', title: null, look: 'canvas', space: 'flat', missing: [],
  parts: [{ order: 10, block: 'said', props: { text: `Your converter is ready: ${NAMED}. The old one, ${GONE}, is gone.` } }],
} as unknown as ScreenPlan
const host: ScreenHost = { data: { 'words.named': { [NAMED]: { title: 'Celsius to Fahrenheit', kind: 'view' }, [GONE]: { missing: true } } }, onOpen: () => undefined }
const html = renderToStaticMarkup(createElement(InlineParts, { plan, host }))

/** Each chip as drawn: its kind (named or missing) and the classes on the chip and on everything inside it. */
const chips = [...html.matchAll(/<(button|span)\b([^>]*\bdata-artifact-ref="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => {
  const own = /\bclass="([^"]*)"/.exec(m[2])?.[1] ?? ''
  const inner = [...m[4].matchAll(/\bclass="([^"]*)"/g)].map((c) => c[1]).join(' ')
  return { ref: m[3], own: own.split(/\s+/).filter(Boolean), inner: inner.split(/\s+/).filter(Boolean) }
})

// text- classes that set size, alignment or wrapping, not colour
const NOT_COLOUR = /^text-(\[[\d.]+(em|rem|px)\]|xs|sm|base|lg|\d?xl|left|right|center|start|end|balance|pretty|wrap|nowrap|ellipsis|clip)$/
/**
 * The colour the chip's own classes give its title (the title's span inherits it): a look token it names (text-ink,
 * text-ink-3, ...), else the words' colour (no colour class, text-inherit or text-current). A colour this test can't
 * price fails it rather than passing unread.
 */
function titleInk(classes: string[], look: Record<string, string>, words: string): string {
  const colour = classes.filter((c) => c.startsWith('text-') && !NOT_COLOUR.test(c)).map((c) => c.slice('text-'.length))
  const last = colour[colour.length - 1]
  if (last === undefined || last === 'inherit' || last === 'current') return words
  if (!(last in look)) throw new Error(`the chip names a colour this test can't price: text-${last}`)
  return look[last]
}

const LOOKS = [DEFAULT_VARIANT, ...SEED_VARIANTS].map((v) => [v.id, { ...DEFAULT_VARIANT.colors, ...v.colors } as Record<string, string>] as const)
const MODES: Mode[] = ['light', 'dark']
const BUBBLES = [
  ["a mind's words", '--ink', '--bubble'],
  ["the person's own", '--bubble-me-ink', '--bubble-me'],
] as const
const CASES = LOOKS.flatMap(([look, colors]) => MODES.flatMap((mode) => BUBBLES.map(([bubble, ink, bg]) => ({ look, colors, mode, bubble, ink: TOKENS[mode][ink], bg: TOKENS[mode][bg] }))))

describe('an artifact chip reads in the colour of the words around it', () => {
  it('draws both chips, a named one and a missing one', () => {
    expect(chips.map((c) => c.ref)).toEqual([NAMED, 'missing'])
    expect(html).toContain('Celsius to Fahrenheit')
    expect(html).toContain('Artifact not available')
  })

  it('carries no colour of its own: no look token on the chip, its icon or its title', () => {
    for (const c of chips) {
      for (const cls of [...c.own, ...c.inner]) expect(cls).not.toMatch(/^(text-ink|text-accent|border-line|bg-tint)/)
    }
  })

  it.each(CASES)('in the $look look, Canvas $mode, $bubble: the chip title holds 4.5:1 against the bubble', ({ colors, ink, bg }) => {
    for (const c of chips) {
      const title = titleInk(c.own, colors, ink)
      expect(contrast(title, bg), `${c.ref} chip title ${title} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
