import { money } from '../../lib/format'

/** POST /api/keys `starting_limit` (Jon 11-09): the month limit the hive set with this key because none governed paid
 *  calls yet ({usd, scope: 'hive' | 'own'}), as one plain sentence; null when the answer carries none. Untrusted input.
 *  Its own module, free of the store, so the store's Keys add and the own-key sheet both say it the same way. */
export function startingLimitWords(out: unknown): string | null {
  const s = out && typeof out === 'object' ? (out as { starting_limit?: unknown }).starting_limit : null
  if (!s || typeof s !== 'object') return null
  const { usd, scope } = s as { usd?: unknown; scope?: unknown }
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0 || (scope !== 'hive' && scope !== 'own')) return null
  return `Your monthly limit starts at ${money(usd)}. Change it on Limits.`
}
