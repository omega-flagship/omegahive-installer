import type { CSSProperties } from 'react'
import { XC } from '../chromeDress'
import type { Grammar } from '../contract'

/**
 * The commons' colours, per rendering. One source: Commons sets these as --cm-* on its root, and contrast.test.ts
 * measures the text pairs below, so the report's numbers are the colours on screen.
 *
 * Identity in every rendering: lavender (#a493ff) and cyan (#6ee7ff), the hive's own (APP_IDENTITIES.md). On paper
 * and on Canvas's light board they are inked darker so they stay readable as text.
 */

export type CommonsGrammar = 'classic' | 'still' | 'canvas'
export type PaletteId = 'classic' | 'still' | 'canvas-light' | 'canvas-dark'

export interface Palette {
  /** The page. */
  bg: string
  /** Opaque raised surface (panels, cards), what text actually sits on. */
  card: string
  ink: string
  ink2: string
  ink3: string
  /** Lavender: the commons' accent, believed stars, headings. */
  lav: string
  /** Cyan: the second identity colour; well supported, "for". */
  cyan: string
  /** Reports against, rivals. */
  against: string
  /** Missing research. */
  warn: string
  ok: string
  /** Primary button fill and its ink. */
  primary: string
  onPrimary: string
  /** Hairlines (decorative). */
  rule: string
  /** Control edges (3:1 on card). */
  edge: string
  /** Star glow (decorative) and the sky's deep tone. */
  glow: string
  deep: string
}

export const PALETTES: Record<PaletteId, Palette> = {
  classic: {
    bg: '#0a0a20',
    card: '#14143a',
    ink: '#eceaff',
    ink2: '#c9c6ee',
    ink3: '#a3a0d0',
    lav: '#b6a8ff',
    cyan: '#6ee7ff',
    against: '#ffa3b5',
    warn: '#f5c76e',
    ok: '#8fe8b8',
    primary: '#a493ff',
    onPrimary: '#0b0820',
    rule: 'rgba(164, 147, 255, 0.18)',
    edge: '#7a76b8',
    glow: '#a493ff',
    deep: '#05051a',
  },
  still: {
    bg: '#fbf8f2',
    card: '#f1ebdf',
    ink: '#1b1712',
    ink2: '#463e35',
    ink3: '#64594d',
    lav: '#4e34a8',
    cyan: '#0c5b6b',
    against: '#962a1e',
    warn: '#7a4300',
    ok: '#1d6639',
    primary: '#4e34a8',
    onPrimary: '#fbf8f2',
    rule: 'rgba(27, 23, 18, 0.14)',
    edge: '#8d8072',
    glow: '#6d55c9',
    deep: '#efe7d8',
  },
  'canvas-light': {
    bg: '#f6f6f3',
    card: '#ffffff',
    ink: '#16161a',
    ink2: '#3d3d47',
    ink3: '#5f5f6b',
    lav: '#5340d0',
    cyan: '#0b6577',
    against: '#c22a1f',
    warn: '#9a5900',
    ok: '#11804a',
    primary: '#5340d0',
    onPrimary: '#ffffff',
    rule: 'rgba(22, 22, 26, 0.11)',
    edge: '#8a8a96',
    glow: '#7b6bff',
    deep: '#ececf6',
  },
  'canvas-dark': {
    bg: '#111114',
    card: '#1b1b20',
    ink: '#f2f2ef',
    ink2: '#cfcfd6',
    ink3: '#a3a3ae',
    lav: '#b4a6ff',
    cyan: '#6ee7ff',
    against: '#ff8a80',
    warn: '#f4b740',
    ok: '#4cd987',
    primary: '#b4a6ff',
    onPrimary: '#0b0d1c',
    rule: 'rgba(255, 255, 255, 0.09)',
    edge: '#6f6f7c',
    glow: '#a493ff',
    deep: '#16161c',
  },
}

/** Text pairs that must hold 4.5:1 (name, foreground, background). */
export const TEXT_PAIRS: [string, keyof Palette, keyof Palette][] = [
  ['body ink on page', 'ink', 'bg'],
  ['body ink on card', 'ink', 'card'],
  ['secondary on page', 'ink2', 'bg'],
  ['secondary on card', 'ink2', 'card'],
  ['faintest on page', 'ink3', 'bg'],
  ['faintest on card', 'ink3', 'card'],
  ['lavender on page', 'lav', 'bg'],
  ['lavender on card', 'lav', 'card'],
  ['cyan / for on page', 'cyan', 'bg'],
  ['cyan / for on card', 'cyan', 'card'],
  ['against on card', 'against', 'card'],
  ['missing research on card', 'warn', 'card'],
  ['ok on card', 'ok', 'card'],
  ['primary ink on primary', 'onPrimary', 'primary'],
]

/** Non-text pairs that must hold 3:1 (control edges, focus rings). */
export const UI_PAIRS: [string, keyof Palette, keyof Palette][] = [
  ['control edge on card', 'edge', 'card'],
  ['focus ring (lavender) on page', 'lav', 'bg'],
]

/**
 * The commons in an experience it has no rendering for (Cosmos, Construct, Flux): the classic sky in the experience's
 * chrome (forms/chromeDress.ts). Surfaces, ink, accent and edges are the chrome's; the semantic tones are the classic
 * set on a dark chrome and the paper set on a light one. contrast.test.ts measures it on each of those chromes.
 */
export function chromePalette(scheme: 'light' | 'dark'): Palette {
  const tones = PALETTES[scheme === 'light' ? 'still' : 'classic']
  return {
    bg: XC.surface,
    card: XC.raised,
    ink: XC.ink,
    ink2: XC.ink2,
    ink3: XC.ink3,
    lav: XC.accent,
    cyan: tones.cyan,
    against: tones.against,
    warn: tones.warn,
    ok: tones.ok,
    primary: XC.accent,
    onPrimary: XC.onAccent,
    rule: XC.line,
    edge: XC.edge,
    glow: XC.accent,
    deep: XC.surface,
  }
}

export function paletteVars(id: PaletteId | Palette): CSSProperties {
  const p = typeof id === 'string' ? PALETTES[id] : id
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [`--cm-${k}`, v])) as CSSProperties
}

/** The rendering a host grammar gets: its own where one exists, else classic (Cosmos, Flux, Construct). */
export function commonsGrammar(g: Grammar): CommonsGrammar {
  return g === 'still' || g === 'canvas' ? g : 'classic'
}

export const paletteFor = (g: CommonsGrammar, scheme: 'light' | 'dark'): PaletteId => (g === 'canvas' ? (scheme === 'dark' ? 'canvas-dark' : 'canvas-light') : g)
