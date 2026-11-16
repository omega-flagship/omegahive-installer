import type { ExperienceChrome } from '../chrome'
import { TOKENS, type Mode } from './theme'

/**
 * Canvas's window chrome: every shared window (Ω menu, Everything, decision dialogs, confirms, toasts, the palette,
 * Change UI, classic pages opened over the board) is a product-grade card on the board's paper: white card, near-black
 * ink, one electric blue, Inter, 12px corners, no blur or texture. The board has a dark mode; so does its chrome.
 * Every pair comes from canvas/theme.ts, whose text colours hold >= 4.5:1 (contrast.test.ts); measured again in
 * canvas/chrome.test.ts on the window surface.
 */
const MODE_KEY = 'omegahive.canvas.mode'

export function chromeForMode(mode: Mode): ExperienceChrome {
  const t = TOKENS[mode]
  return {
    surface: t['--card'],
    raised: mode === 'light' ? '#f1f1ee' : '#26262d',
    ink: t['--ink'],
    ink2: t['--ink-2'],
    ink3: t['--ink-3'],
    line: t['--line-2'],
    edge: mode === 'light' ? '#8a8a96' : '#6f6f7c',
    accent: mode === 'light' ? t['--accent-ink'] : t['--accent'],
    onAccent: t['--on-accent'],
    danger: t['--bad'],
    onDanger: t['--on-bad'],
    font: "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    display: "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
    radius: '12px',
    controlRadius: '8px',
    scrim: mode === 'light' ? 'rgb(22 22 26 / 0.28)' : 'rgb(0 0 0 / 0.6)',
    shadow: t['--shadow-lg'],
    material: 'none',
    scheme: mode,
  }
}

export const chrome: ExperienceChrome = chromeForMode('light')

/** The chrome for the board's current mode (light unless the person switched the board to dark). */
export function currentChrome(): ExperienceChrome {
  try {
    return chromeForMode(localStorage.getItem(MODE_KEY) === 'dark' ? 'dark' : 'light')
  } catch {
    return chrome
  }
}
