import type { IconName } from './Icon'

/** Colours and glyphs for allow / ask / deny, shared by policy rules and per-command gates. */
export const MODE_STYLE: Record<'allow' | 'ask' | 'deny', { color: string; bg: string; icon: IconName; label: string }> = {
  allow: { color: '#4ade80', bg: 'rgb(74 222 128 / 0.1)', icon: 'check', label: 'Allow' },
  ask: { color: '#fbbf24', bg: 'rgb(251 191 36 / 0.1)', icon: 'question', label: 'Ask' },
  deny: { color: '#fb7185', bg: 'rgb(251 113 133 / 0.1)', icon: 'ban', label: 'Deny' },
}
