/**
 * The look follows the signed-in person (Request an experience r1d). On every identity change (lib/identityEpoch),
 * inside the change itself, the earlier person's look leaves the screen (uiVariant forgetLookOwner: the standard look,
 * unbound), and the new person's own look is loaded under a binding: a load that finishes after a further change
 * applies nothing, so a late load of A's look never shows under B. This also covers a re-login on the same tab, which
 * keeps the same client and so never re-runs App's load. Imported once by App (and by its tests).
 */
import { bindEpoch, onIdentityChange } from '../lib/identityEpoch'
import { useHive } from '../store/store'
import { forgetLookOwner, loadLook, restartSaveQueue, setLookBinder } from './uiVariant'

type LookClient = Parameters<typeof loadLook>[0]

/** Load the signed-in person's look, bound to the identity it was asked under. */
export function loadLookBound(client: LookClient): Promise<void> {
  const binding = bindEpoch()
  return loadLook(client, binding.commit)
}

// every async path in uiVariant (load, keep, reset, escape, replay) binds to the identity it started under
setLookBinder(bindEpoch)

onIdentityChange(() => {
  restartSaveQueue()
  forgetLookOwner()
  const client = useHive.getState().client
  // the new person's look, once the change has settled (the load binds the epoch it starts under)
  if (client) queueMicrotask(() => void loadLookBound(useHive.getState().client))
})
