/**
 * Window chrome per experience. Every shared window (Ω menu, Everything directory, decision dialogs, confirms, sheets,
 * toasts, the command palette, Change UI, classic pages opened inside an experience) dresses in the chrome of the
 * experience the person is in, so no window ever looks like a leftover from another UI (Jon, 2026-10-05).
 *
 * Each experience exports `chrome` from `experiences/<id>/chrome.ts`. The host writes it to CSS variables on <html>;
 * shared windows read only these variables (classes in index.css: .xc-window, .xc-menu, .xc-item, .xc-button, …).
 */
export interface ExperienceChrome {
  /** Window surface (opaque enough to read on any backdrop). */
  surface: string
  /** A second, raised surface: menus over windows, selected rows. */
  raised: string
  /** Primary text, secondary text, faint text (≥4.5:1 on surface for the first two; faint ≥4.5:1 too, it is text). */
  ink: string
  ink2: string
  ink3: string
  /** Hairlines and control edges (edges ≥3:1 on surface). */
  line: string
  edge: string
  /** Accent for focus, selection, primary actions; and the ink drawn on top of the accent. */
  accent: string
  onAccent: string
  /** Danger (revoke, deny, delete) and its on-colour. */
  danger: string
  onDanger: string
  /** Type: UI family and display family. */
  font: string
  display: string
  /** Corner radius for windows and for controls (CSS lengths). */
  radius: string
  controlRadius: string
  /** Backdrop behind modal windows, and the window shadow. */
  scrim: string
  shadow: string
  /** Optional material: 'glass' blurs the backdrop; 'paper' adds grain; 'terminal' adds scanlines; 'none'. */
  material: 'glass' | 'paper' | 'terminal' | 'none'
  /** Light or dark, for native controls (color-scheme). */
  scheme: 'light' | 'dark'
}

/** The classic hive's chrome: what every window looked like before experiences. */
export const CLASSIC_CHROME: ExperienceChrome = {
  surface: 'rgb(11 11 33 / 0.96)',
  raised: 'rgb(24 24 62 / 0.96)',
  ink: '#eceaff',
  ink2: '#b9b8dc',
  ink3: '#8a89b3',
  line: 'rgb(170 170 255 / 0.14)',
  edge: '#6868a0',
  accent: '#a493ff',
  onAccent: '#0b0820',
  danger: '#fb7185',
  onDanger: '#1a0509',
  font: "'Inter Variable', Inter, system-ui, sans-serif",
  display: "'Inter Variable', Inter, system-ui, sans-serif",
  radius: '18px',
  controlRadius: '12px',
  scrim: 'rgb(0 0 0 / 0.55)',
  shadow: '0 30px 80px -24px rgb(0 0 0 / 0.85)',
  material: 'glass',
  scheme: 'dark',
}

const VARS: Record<keyof Omit<ExperienceChrome, 'material' | 'scheme'>, string> = {
  surface: '--xc-surface',
  raised: '--xc-raised',
  ink: '--xc-ink',
  ink2: '--xc-ink-2',
  ink3: '--xc-ink-3',
  line: '--xc-line',
  edge: '--xc-edge',
  accent: '--xc-accent',
  onAccent: '--xc-on-accent',
  danger: '--xc-danger',
  onDanger: '--xc-on-danger',
  font: '--xc-font',
  display: '--xc-display',
  radius: '--xc-radius',
  controlRadius: '--xc-control-radius',
  scrim: '--xc-scrim',
  shadow: '--xc-shadow',
}

/**
 * Dress every shared window in this chrome (null: the classic chrome). With a chrome, <html data-xc-active> also
 * turns on the dress for classic windows and pages (index.css `.xc-dress`, `.xc-frame`, `.xc-page`, `.xc-backdrop`),
 * so a classic page opened inside an experience wears that experience; with null the classic UI is untouched.
 */
/**
 * In the Classic hive the person's own look IS the world, so its window chrome follows the worn look's tokens (light-token
 * round R1): the default look resolves to the classic glass above, Paper or any other look dresses every shared window
 * (the Ask's chip and cards, dialogs, sheets) in its own colours. Experiences keep their own chrome.
 */
export const CLASSIC_FOLLOWS_LOOK: ExperienceChrome = {
  ...CLASSIC_CHROME,
  surface: 'color-mix(in oklab, var(--color-abyss) 96%, transparent)',
  raised: 'color-mix(in oklab, color-mix(in oklab, var(--color-ink) 8%, var(--color-abyss)) 96%, transparent)',
  ink: 'var(--color-ink)',
  ink2: 'var(--color-ink-2)',
  ink3: 'var(--color-ink-3)',
  line: 'var(--color-line-2)',
  edge: 'var(--color-control)',
  accent: 'var(--color-accent)',
  onAccent: 'var(--color-primary-ink)',
  danger: 'var(--color-bad)',
  font: 'var(--font-sans)',
  display: 'var(--font-display)',
}

export function applyChrome(c: ExperienceChrome | null): void {
  if (typeof document === 'undefined') return
  const chrome = c ?? CLASSIC_FOLLOWS_LOOK
  const root = document.documentElement
  for (const [k, v] of Object.entries(VARS)) root.style.setProperty(v, chrome[k as keyof typeof VARS])
  root.dataset.xcMaterial = chrome.material
  root.dataset.xcScheme = c ? chrome.scheme : root.dataset.uiScheme ?? chrome.scheme   // Classic: the worn look's scheme
  if (c) root.dataset.xcActive = ''
  else delete root.dataset.xcActive
}

/** What `experiences/<id>/chrome.ts` exports. `currentChrome` (optional) answers for an experience with modes (Canvas light/dark). */
export interface ChromeModule {
  chrome: ExperienceChrome
  currentChrome?: () => ExperienceChrome
}

const lum = (hex: string) => {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/**
 * A stand-in chrome from an experience's gallery swatch, used only until the experience ships its own chrome.ts:
 * windows still take the experience's colours rather than the classic glass.
 */
export function chromeFromSwatch(s: { bg: string; fg: string; accent: string }): ExperienceChrome {
  const light = lum(s.bg) > 0.4
  const mix = (a: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${s.bg})`
  return {
    ...CLASSIC_CHROME,
    surface: s.bg,
    raised: mix(s.fg, 7),
    ink: s.fg,
    ink2: mix(s.fg, 82),
    ink3: mix(s.fg, 68),
    line: `color-mix(in srgb, ${s.fg} 14%, transparent)`,
    edge: mix(s.fg, 45),
    accent: s.accent,
    onAccent: lum(s.accent) > 0.35 ? '#0b0b10' : '#ffffff',
    danger: light ? '#b3261e' : '#fb7185',
    onDanger: light ? '#ffffff' : '#1a0509',
    scrim: light ? 'rgb(20 20 30 / 0.3)' : 'rgb(0 0 0 / 0.6)',
    shadow: light ? '0 24px 60px -20px rgb(20 20 30 / 0.35)' : CLASSIC_CHROME.shadow,
    material: 'none',
    scheme: light ? 'light' : 'dark',
  }
}

export const chromeVarNames = Object.values(VARS)
