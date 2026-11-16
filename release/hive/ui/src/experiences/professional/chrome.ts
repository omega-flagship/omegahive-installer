import type { ExperienceChrome } from '../chrome'
import { P } from './theme'

/** Whole-experience chrome; no light-token override or saved-preference write. */
export const chrome: ExperienceChrome = {
  surface: P.surface, raised: P.raised,
  ink: P.ink, ink2: P.secondary, ink3: P.muted,
  line: P.line, edge: P.edge,
  accent: P.accent, onAccent: P.surface,
  danger: P.danger, onDanger: P.surface,
  font: P.font, display: P.font,
  radius: '12px', controlRadius: '8px',
  scrim: P.scrim, shadow: P.shadow,
  material: 'none', scheme: 'light',
}
