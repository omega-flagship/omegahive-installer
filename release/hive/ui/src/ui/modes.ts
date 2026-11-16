import type { IconName } from './Icon'

/** Colours and glyphs for allow / ask / deny, shared by policy rules and per-command gates. */
export const MODE_STYLE: Record<'allow' | 'ask' | 'deny', { color: string; bg: string; icon: IconName; label: string }> = {
  allow: { color: 'var(--color-good)', bg: 'color-mix(in oklab, var(--color-good) 10%, transparent)', icon: 'check', label: 'Allow' },
  ask: { color: 'var(--color-warn)', bg: 'color-mix(in oklab, var(--color-warn) 10%, transparent)', icon: 'question', label: 'Ask' },
  deny: { color: 'var(--color-bad)', bg: 'color-mix(in oklab, var(--color-bad) 10%, transparent)', icon: 'ban', label: 'Deny' },
}
