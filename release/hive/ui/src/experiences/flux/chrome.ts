import type { ExperienceChrome } from '../chrome'

/**
 * Flux window chrome: liquid glass. Deep plum glass with a pearly hairline, soft rounded type, generous corners and
 * pill controls, an iridescent pink accent. Every text colour is at least 4.5:1 on the surface even where the glass
 * sits over a bright drop (flux/chrome.test.ts measures it).
 */
export const chrome: ExperienceChrome = {
  surface: 'rgb(30 14 46 / 0.92)',
  raised: 'rgb(50 25 74 / 0.96)',
  ink: '#f8f3ff',
  ink2: '#e4dcf2',
  ink3: '#cfc4e2',
  line: 'rgb(255 255 255 / 0.13)',
  edge: '#9d86bd',
  accent: '#ff9fdc',
  onAccent: '#24062a',
  danger: '#ff9fb2',
  onDanger: '#2a0610',
  font: "'SF Pro Rounded', ui-rounded, 'Avenir Next Rounded', 'Avenir Next', 'Nunito', 'Quicksand', system-ui, -apple-system, sans-serif",
  display: "'SF Pro Rounded', ui-rounded, 'Avenir Next Rounded', 'Avenir Next', 'Nunito', system-ui, sans-serif",
  radius: '30px',
  controlRadius: '18px',
  scrim: 'rgb(12 4 22 / 0.55)',
  shadow: '0 30px 80px rgb(0 0 0 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.28), inset 0 0 0 1px rgb(255 255 255 / 0.1)',
  material: 'glass',
  scheme: 'dark',
}
