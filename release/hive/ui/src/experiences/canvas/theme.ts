import type { CSSProperties } from 'react'
import { lightnessForWhite } from './contrast'

export type Mode = 'light' | 'dark'

/** Board tokens. Every text colour here holds >= 4.5:1 on paper, card and island tints of its mode. */
export const TOKENS: Record<Mode, Record<string, string>> = {
  light: {
    '--paper': '#f6f6f3',
    '--dot': 'rgba(22,22,26,0.17)',
    '--ink': '#16161a',
    '--ink-2': '#3d3d47',
    '--ink-3': '#5f5f6b',
    '--card': '#ffffff',
    '--card-2': '#fafaf8',
    '--line': 'rgba(22,22,26,0.11)',
    '--line-2': 'rgba(22,22,26,0.2)',
    '--accent': '#3b5bff',
    '--accent-ink': '#2b48e0',
    '--accent-soft': 'rgba(59,91,255,0.12)',
    '--on-accent': '#ffffff',
    '--chrome': 'rgba(255,255,255,0.86)',
    '--chrome-line': 'rgba(22,22,26,0.1)',
    '--shadow-sm': '0 1px 2px rgba(22,22,26,0.06), 0 1px 1px rgba(22,22,26,0.04)',
    '--shadow': '0 1px 2px rgba(22,22,26,0.05), 0 8px 24px -8px rgba(22,22,26,0.14)',
    '--shadow-lg': '0 2px 6px rgba(22,22,26,0.06), 0 24px 60px -12px rgba(22,22,26,0.28)',
    '--good': '#11864a',
    '--warn': '#a35f00',
    '--bad': '#c62a1f',
    '--on-bad': '#ffffff',
    '--sleep': '#5f6b85',
    '--bubble-me': '#16161a',
    '--bubble-me-ink': '#ffffff',
    '--bubble': '#f1f1ee',
  },
  dark: {
    '--paper': '#111114',
    '--dot': 'rgba(255,255,255,0.11)',
    '--ink': '#f2f2ef',
    '--ink-2': '#cfcfd6',
    '--ink-3': '#a3a3ae',
    '--card': '#1b1b20',
    '--card-2': '#202026',
    '--line': 'rgba(255,255,255,0.09)',
    '--line-2': 'rgba(255,255,255,0.18)',
    '--accent': '#7d93ff',
    '--accent-ink': '#9eafff',
    '--accent-soft': 'rgba(125,147,255,0.16)',
    '--on-accent': '#0b0d1c',
    '--chrome': 'rgba(28,28,33,0.86)',
    '--chrome-line': 'rgba(255,255,255,0.09)',
    '--shadow-sm': '0 1px 2px rgba(0,0,0,0.4)',
    '--shadow': '0 1px 2px rgba(0,0,0,0.35), 0 10px 28px -10px rgba(0,0,0,0.6)',
    '--shadow-lg': '0 2px 6px rgba(0,0,0,0.4), 0 28px 70px -12px rgba(0,0,0,0.75)',
    '--good': '#4cd987',
    '--warn': '#f4b740',
    '--bad': '#ff7a70',
    '--on-bad': '#16161a',
    '--sleep': '#9aa3b8',
    '--bubble-me': '#f2f2ef',
    '--bubble-me-ink': '#111114',
    '--bubble': '#26262d',
  },
}

export const tokenStyle = (mode: Mode): CSSProperties => TOKENS[mode] as CSSProperties

/** Swarm tint set. Title ink keeps >= 4.5:1 on the island fill. */
export function tint(hue: number | null, mode: Mode) {
  if (hue === null) {
    return mode === 'light'
      ? { fill: '#efefec', edge: 'rgba(22,22,26,0.12)', title: '#2c2c33', soft: '#e4e4e0', strong: '#6b6b76' }
      : { fill: '#18181c', edge: 'rgba(255,255,255,0.09)', title: '#e4e4e8', soft: '#24242a', strong: '#9a9aa6' }
  }
  const h = Math.round(hue)
  return mode === 'light'
    ? { fill: `hsl(${h} 70% 96.5%)`, edge: `hsl(${h} 45% 84%)`, title: `hsl(${h} 60% 25%)`, soft: `hsl(${h} 70% 91%)`, strong: `hsl(${h} 62% 46%)` }
    : { fill: `hsl(${h} 26% 13%)`, edge: `hsl(${h} 30% 24%)`, title: `hsl(${h} 80% 84%)`, soft: `hsl(${h} 30% 19%)`, strong: `hsl(${h} 70% 66%)` }
}

const fillL = new Map<number, number>()
/**
 * A mind's identity colour as an avatar fill. Lightness starts at 42% and drops per hue until a white initial
 * holds 4.5:1 (yellows, greens and cyans need a deeper shade; blues and reds keep 42%).
 */
export function avatarFill(hue: number): string {
  const h = ((Math.round(hue) % 360) + 360) % 360
  let l = fillL.get(h)
  if (l === undefined) fillL.set(h, (l = lightnessForWhite(h, 62, 42)))
  return `hsl(${h} 62% ${l}%)`
}

export const FONT = "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"
export const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace"
