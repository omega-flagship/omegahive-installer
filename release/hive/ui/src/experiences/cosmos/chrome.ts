import type { ExperienceChrome } from '../chrome'

/**
 * Cosmos window chrome: a deep-space HUD. Near-black navy glass with a cool hairline, white and ice-blue type in the
 * wide geometric face the HUD uses, almost square corners, an ice-blue accent. Every text colour is at least 4.5:1 on
 * the surface even where the glass sits over a bright star (cosmos/chrome.test.ts measures it).
 */
export const chrome: ExperienceChrome = {
  surface: 'rgb(5 10 24 / 0.94)',
  raised: 'rgb(14 24 50 / 0.97)',
  ink: '#eef4ff',
  ink2: '#c3d1ec',
  ink3: '#9db0d3',
  line: 'rgb(160 196 255 / 0.16)',
  edge: '#6f86b3',
  accent: '#7cc4ff',
  onAccent: '#020a18',
  danger: '#ff8b95',
  onDanger: '#1c0306',
  font: "'Avenir Next', 'Avenir', 'Futura', 'Century Gothic', 'Montserrat', 'Segoe UI', system-ui, sans-serif",
  display: "'Futura', 'Avenir Next', 'Century Gothic', 'Josefin Sans', system-ui, sans-serif",
  radius: '4px',
  controlRadius: '2px',
  scrim: 'rgb(1 2 8 / 0.66)',
  shadow: '0 30px 80px -20px rgb(0 0 0 / 0.85), 0 0 0 1px rgb(124 196 255 / 0.10), inset 0 1px 0 rgb(200 225 255 / 0.07)',
  material: 'glass',
  scheme: 'dark',
}
