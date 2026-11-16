import type { ExperienceChrome } from '../chrome'

/**
 * Still's window chrome: every shared window (Ω menu, Everything, decision dialogs, toasts, palette, Change UI,
 * classic pages opened over Still) becomes a sheet of warm paper with ink type and one deep red. Measured by
 * still/chrome.test.ts (WCAG 2.x, on `surface`): ink 16.8:1, ink2 9.9:1, ink3 6.2:1, accent 7.1:1, danger 8.8:1,
 * onAccent on accent 7.1:1, onDanger on danger 8.8:1, edge 3.6:1; on `raised` every text pair stays ≥5.4:1.
 */
export const chrome: ExperienceChrome = {
  surface: '#fbf8f2',
  raised: '#f1ebdf',
  ink: '#1b1712',
  ink2: '#463e35',
  ink3: '#675c50',
  line: 'rgb(27 23 18 / 0.13)',
  edge: '#8d8072',
  accent: '#a3221b',
  onAccent: '#fbf8f2',
  danger: '#8a1c16',
  onDanger: '#fbf8f2',
  font: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', 'Source Sans 3', system-ui, sans-serif",
  display: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  radius: '20px',
  controlRadius: '12px',
  scrim: 'rgb(70 56 38 / 0.32)',
  shadow: '0 0 0 1px rgb(60 40 20 / 0.08), 0 1px 2px rgb(60 40 20 / 0.06), 0 28px 70px -26px rgb(60 40 20 / 0.45)',
  material: 'paper',
  scheme: 'light',
}
