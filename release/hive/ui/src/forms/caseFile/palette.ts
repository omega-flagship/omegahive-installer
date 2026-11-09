import type { CSSProperties } from 'react'
import { XC } from '../chromeDress'
import type { Grammar } from '../contract'

/**
 * The case file's colours, per grammar. One source: CaseFile sets these as CSS custom properties on its root,
 * and contrast.test.ts measures the text pairs below, so the numbers in the report are the colours on screen.
 *
 * Identity carriers in every grammar: brass (#e8c27a) and verdigris (#7fd8c8), tinted to the grammar's law.
 * On paper the pair is inked darker so it stays readable; in the docket it is phosphor amber and cyan.
 */

export type CaseGrammar = 'classic' | 'still' | 'construct'

export interface Palette {
  /** Opaque surface the form paints. */
  bg: string
  /** Opaque raised surface (cards, panes, sheets), the colour text actually sits on. */
  card: string
  ink: string
  ink2: string
  ink3: string
  /** Brass: the case's own accent (headings, marks, the beam). */
  brass: string
  /** Verdigris: the second identity colour, and the "for" side. */
  verd: string
  /** The "against" side. */
  against: string
  warn: string
  bad: string
  ok: string
  /** Hairlines and ledger rules (decorative, not text). */
  rule: string
  /** Action ink on its control. */
  control: string
}

export const PALETTES: Record<CaseGrammar, Palette> = {
  classic: {
    bg: '#07070e',
    card: '#11111b',
    ink: '#f3ede0',
    ink2: '#d2c9b6',
    ink3: '#a69e8c',
    brass: '#e8c27a',
    verd: '#7fd8c8',
    against: '#f4a28c',
    warn: '#f2b65c',
    bad: '#ff8f80',
    ok: '#8fe0b0',
    rule: 'rgba(232, 194, 122, 0.16)',
    control: '#8a7a55',
  },
  still: {
    bg: '#f6f0e3',
    card: '#efe6d2',
    ink: '#221a12',
    ink2: '#463b2e',
    ink3: '#65584a',
    brass: '#7e520c',
    verd: '#17665a',
    against: '#962a1e',
    warn: '#7f4400',
    bad: '#9b1c12',
    ok: '#1f6a3c',
    rule: 'rgba(126, 82, 12, 0.22)',
    control: '#8b7a62',
  },
  construct: {
    bg: '#010805',
    card: '#03120a',
    ink: '#b4ffc2',
    ink2: '#86e398',
    ink3: '#5fae6e',
    brass: '#ffbb45',
    verd: '#84f6e6',
    against: '#ff7a6e',
    warn: '#ffbb45',
    bad: '#ff6b5e',
    ok: '#39ff7a',
    rule: 'rgba(84, 255, 140, 0.24)',
    control: '#3f9a57',
  },
}

/** Text pairs that must hold 4.5:1 (name, foreground token, background token). */
export const TEXT_PAIRS: [string, keyof Palette, keyof Palette][] = [
  ['body ink on surface', 'ink', 'bg'],
  ['body ink on card', 'ink', 'card'],
  ['secondary on card', 'ink2', 'card'],
  ['faintest text on surface', 'ink3', 'bg'],
  ['faintest text on card', 'ink3', 'card'],
  ['brass on surface', 'brass', 'bg'],
  ['brass on card', 'brass', 'card'],
  ['verdigris / for on card', 'verd', 'card'],
  ['against on card', 'against', 'card'],
  ['warning on card', 'warn', 'card'],
  ['bad / retracted on card', 'bad', 'card'],
  ['ok on card', 'ok', 'card'],
]

/**
 * The case file in an experience it has no rendering for (Cosmos, Flux, Canvas light or dark): the classic layout in
 * the experience's chrome (forms/chromeDress.ts). Surfaces, ink, rules and the brass accent are the chrome's; the
 * sides and states are the classic set on a dark chrome and the paper set on a light one (contrast.test.ts).
 */
export function chromePalette(scheme: 'light' | 'dark'): Palette {
  const tones = PALETTES[scheme === 'light' ? 'still' : 'classic']
  return {
    bg: XC.surface,
    card: XC.raised,
    ink: XC.ink,
    ink2: XC.ink2,
    ink3: XC.ink3,
    brass: XC.accent,
    verd: tones.verd,
    against: tones.against,
    warn: tones.warn,
    bad: tones.bad,
    ok: tones.ok,
    rule: XC.line,
    control: XC.edge,
  }
}

export function paletteVars(g: CaseGrammar | Palette): CSSProperties {
  const p = typeof g === 'string' ? PALETTES[g] : g
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [`--cf-${k}`, v])) as CSSProperties
}

/** The rendering a host grammar gets: its own where one exists, else classic. */
export function caseGrammar(g: Grammar): CaseGrammar {
  return g === 'still' || g === 'construct' ? g : 'classic'
}
