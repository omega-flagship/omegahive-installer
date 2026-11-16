import { useEffect } from 'react'
import { SURFACE_PREVIEW } from '../experiences/registry'
import { announceHeld } from './heldExperience'
import { useHive } from '../store/store'
import { useLook } from './uiVariant'

/** Mounted once by App: says when the chosen experience is held back in this preview build (shell/heldExperience, TF-03). Renders nothing itself (the notice is a toast). */
export function HeldExperienceNotice({ preview = SURFACE_PREVIEW }: { preview?: boolean }) {
  const wanted = useLook().current?.experience ?? null
  // binding a hive client empties the notices (store init), so say it only once the hive is ready, or it is never seen
  const ready = useHive((s) => s.ready)
  useEffect(() => {
    if (ready) announceHeld(wanted, preview)
  }, [wanted, preview, ready])
  return null
}
