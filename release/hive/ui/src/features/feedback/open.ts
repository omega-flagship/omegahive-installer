// Purpose: open the feedback area from anywhere (the corner entry, the Omega menu, a draft the person chose to use), in
// the look being worn, with the client that asks the hive what it adds.
import { experienceById } from '../../experiences/registry'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import type { Draft } from './drafts'
import { openFeedback } from './store'

export function useOpenFeedback(): (seed?: Draft) => void {
  const client = useHive((s) => s.client)
  const look = useLook()
  return (seed) => openFeedback(client, experienceById(look.current?.experience).name, seed)
}
