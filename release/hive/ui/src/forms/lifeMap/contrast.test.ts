import { describe, expect, it } from 'vitest'
import { KIND_COLOR, POLARITY_COLOR, POLARITY_INK, TERRITORIES } from './model'

/**
 * WCAG 2.x contrast for every text colour the Atlas form uses, on the surfaces it is drawn on.
 * Surfaces with translucency are measured at their darkest/lightest composited value over the page.
 * Run: npx vitest run src/forms/lifeMap/contrast.test.ts  (prints the table)
 */

function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export const ratio = (fg: string, bg: string) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// surfaces (composited)
const BG = '#04070c' // the stage
const GLASS = '#0b111c' // side panels and sheets in glass, over the stage
const GLASS_LIT = '#1a2340' // glass over the brightest nebula/figure region
const PAPER = '#f4f1ea' // reading sheets, the biography
const MARGIN = '#ece7dc' // still's margin note
const CARD = '#fbf9f4' // envelope, wonder blocks
const BANNER_DARK = '#2a1414' // the SAMPLE banner (dark)
const BANNER_PAPER = '#f7e9e4'

type Row = [string, string, string, string, number]
const rows: Row[] = []
const check = (what: string, fg: string, bg: string, bgName: string, min = 4.5) => rows.push([what, fg, bg, bgName, min])

// dark: ink, muted text, chrome
check('ink', '#eef3fa', GLASS_LIT, 'glass over light')
check('muted text (--muted)', '#9aa6b8', BG, 'stage')
check('muted text (--muted)', '#9aa6b8', GLASS, 'glass')
check('muted text (--muted)', '#9aa6b8', GLASS_LIT, 'glass over light')
check('callout sub / labels', '#aeb9c9', GLASS_LIT, 'glass over light')
check('disclaimer', '#93a0b3', BG, 'stage')
check('timeline year', '#93a0b3', GLASS, 'glass')
check('SAMPLE banner text', '#ffe2dc', BANNER_DARK, 'banner')
check('SAMPLE banner label', '#ff8a7a', BANNER_DARK, 'banner')
check('SAMPLE chip', '#1a0d0b', '#ff8a7a', 'coral chip')
check('primary button', '#1a0d0b', '#ff8a7a', 'coral button')
check('sky (focus, links)', '#7fd3ff', GLASS_LIT, 'glass over light')
// territories as label text on dark (callouts, chips, slabel values)
for (const t of TERRITORIES) check(`${t.label} (territory, on dark)`, t.color, GLASS_LIT, 'glass over light')
// relation family on dark (legend, evidence headings in glass)
for (const [k, c] of Object.entries(POLARITY_COLOR)) check(`relation ${k} (on dark)`, c, GLASS, 'glass')
for (const [k, c] of Object.entries(KIND_COLOR)) check(`kind ${k} (on dark)`, c, GLASS, 'glass')
// paper
check('ink (paper)', '#1b2230', PAPER, 'paper')
check('muted (paper)', '#535d6c', PAPER, 'paper')
check('muted (paper margin)', '#535d6c', MARGIN, 'margin')
check('muted (paper card)', '#535d6c', CARD, 'card')
check('page body', '#1f2634', PAPER, 'paper')
for (const t of TERRITORIES) {
  check(`${t.label} ink (paper)`, t.ink, PAPER, 'paper')
  check(`${t.label} ink (margin)`, t.ink, MARGIN, 'margin')
}
for (const [k, c] of Object.entries(POLARITY_INK)) check(`relation ink ${k}`, c, PAPER, 'paper')
check('supports (paper)', '#18714a', MARGIN, 'margin')
check('opposes (paper)', '#b42a42', MARGIN, 'margin')
check('qualifies (paper)', '#7a5600', MARGIN, 'margin')
check('coral ink (paper)', '#b8432f', PAPER, 'paper')
check('sky ink (paper)', '#1f6f9c', PAPER, 'paper')
check('SAMPLE banner (paper)', '#5e1e14', BANNER_PAPER, 'banner')
check('SAMPLE chip (paper)', '#ffffff', '#b8432f', 'chip')
check('confirm button', '#f4f1ea', '#1b2230', 'button')
check('danger confirm', '#ffffff', '#b42a42', 'button')
// non-text: control edges need 3:1
check('field border (non-text)', '#7b8593', '#ffffff', 'field', 3)

describe('contrast (WCAG 2.x, measured)', () => {
  it('every text colour clears 4.5:1 on its surface (3:1 for control edges)', () => {
    const table = rows.map(([what, fg, , bgName, min]) => {
      const r = ratio(fg, rows.find((x) => x[0] === what && x[3] === bgName)![2])
      return { what, fg, on: bgName, ratio: Math.round(r * 100) / 100, min, pass: r >= min }
    })
    console.table(table)
    const fails = table.filter((t) => !t.pass)
    expect(fails, JSON.stringify(fails)).toEqual([])
  })
})
