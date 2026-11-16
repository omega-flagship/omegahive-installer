import type { ExperienceChrome } from '../chrome'

/**
 * Construct's window chrome: every shared window (Ω menu, Everything, decision dialogs, toasts, palette, Change UI,
 * classic pages opened over the construct) becomes a terminal window. Black glass, phosphor ink, square corners,
 * scanlines. Contrast on `surface` (WCAG 2.x, measured by construct/chrome.test.ts): ink 17.8:1, ink2 12.8:1,
 * ink3 7.9:1, accent 15.0:1, danger 7.2:1, onAccent on accent 14.6:1, onDanger on danger 7.1:1, edge 4.6:1; on `raised`
 * every text pair stays ≥6.5:1.
 */
export const chrome: ExperienceChrome = {
  surface: '#020a05',
  raised: '#08190e',
  ink: '#c8ffd2',
  ink2: '#86e398',
  ink3: '#5fb46f',
  line: 'rgb(84 255 140 / 0.2)',
  edge: '#2e8a48',
  accent: '#39ff7a',
  onAccent: '#021006',
  danger: '#ff6b5e',
  onDanger: '#1a0300',
  font: "'IBM Plex Mono', 'SF Mono', SFMono-Regular, Menlo, ui-monospace, monospace",
  display: "'IBM Plex Mono', 'SF Mono', SFMono-Regular, Menlo, ui-monospace, monospace",
  radius: '0px',
  controlRadius: '0px',
  scrim: 'rgb(0 6 2 / 0.72)',
  shadow: '0 0 0 1px rgb(57 255 122 / 0.28), 0 0 42px rgb(57 255 122 / 0.12), 0 30px 80px -20px rgb(0 0 0 / 0.9)',
  material: 'terminal',
  scheme: 'dark',
}
