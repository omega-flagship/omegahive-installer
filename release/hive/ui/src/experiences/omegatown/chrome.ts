import type { ExperienceChrome } from '../chrome'

/** One proposed furniture family. Architectural artwork is freely mixed local content. */
export const chrome: ExperienceChrome = {
  surface: '#f5f2e8', raised: '#fffdf7', ink: '#203e38', ink2: '#3f5c50', ink3: '#576a5d',
  line: '#a4b09c', edge: '#657d6b', accent: '#286951', onAccent: '#ffffff', danger: '#a33338', onDanger: '#ffffff',
  font: "'Inter Variable', Inter, system-ui, sans-serif", display: "'Inter Variable', Inter, system-ui, sans-serif",
  radius: '18px', controlRadius: '10px', scrim: 'rgb(14 43 33 / .48)', shadow: '0 22px 66px -26px rgb(20 49 37 / .45)',
  material: 'paper', scheme: 'light',
}

/** Proposed Town furniture tokens, applied with its existing chrome. Scenery remains illustrative content. */
export const FURNITURE = {
  '--ot-coat-amber': '#bd713e', '--ot-coat-fern': '#467c61', '--ot-coat-violet': '#85699e',
  '--ot-room-surface': '#d8ddd1', '--ot-room-light': '#ede4ce', '--ot-code-surface': '#263e4a', '--ot-code-light': '#596275',
  '--ot-room-mark': '#a6d4bc', '--ot-room-shadow': '#203a3555',
  '--ot-room-furniture': '#a6b395', '--ot-room-edge': '#d6d6b9',
} as const
