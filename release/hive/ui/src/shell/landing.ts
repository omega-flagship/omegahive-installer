import { bindEpoch, type EpochBinding } from '../lib/identityEpoch'
import { keepLook, lookState, type UiPrefs } from './uiVariant'

/**
 * Where a person lands in their look (Ask-and-apps contract R1.1 §7, #6): awake unless their own row says Pro. Going to
 * Pro and back writes it, bound to the principal who made the move (lib/identityEpoch): a save that lands after a
 * sign-in change writes nothing on this page and answers 'stale'. No write when it already says so.
 */
export const landingOf = (p: UiPrefs | null | undefined): 'awake' | 'pro' => (p?.landing === 'pro' ? 'pro' : 'awake')

export async function rememberLanding(client: Parameters<typeof keepLook>[0], to: 'awake' | 'pro', binding: EpochBinding = bindEpoch()): Promise<'saved' | 'same' | 'stale' | 'no-host'> {
  const saved = lookState().saved
  if (landingOf(saved) === to) return 'same'
  if (!client?.setUiPrefs) return 'no-host'
  const base: UiPrefs = saved ?? { variant: null, layout: null, apps: null, experience: null }
  try {
    await keepLook(client, { ...base, landing: to }, binding.commit)
  } catch (e) {
    if (!binding.current()) return 'stale'
    throw e
  }
  return binding.current() ? 'saved' : 'stale'
}
