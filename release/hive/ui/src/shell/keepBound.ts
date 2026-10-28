import { bindEpoch } from '../lib/identityEpoch'
import { keepLook, type UiPrefs } from './uiVariant'

/**
 * The gallery's and the preview bar's Keep, bound to the person it was pressed for: the binding is taken before the
 * save is sent, and the page's writes after it go through `binding.commit` (lib/identityEpoch). A save that lands after
 * a sign-in change writes nothing on this page and answers 'stale' (no "kept" is said to the next person); a refusal
 * for the person still signed in rejects as before.
 */
export async function keepLookBound(client: Parameters<typeof keepLook>[0], p: UiPrefs): Promise<'kept' | 'stale'> {
  const binding = bindEpoch()
  try {
    await keepLook(client, p, binding.commit)
  } catch (e) {
    if (!binding.current()) return 'stale'
    throw e
  }
  return binding.current() ? 'kept' : 'stale'
}
