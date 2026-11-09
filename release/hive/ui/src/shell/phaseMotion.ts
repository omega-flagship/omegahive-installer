import { MotionGlobalConfig } from 'framer-motion'

const owners = new Set<symbol>()
let previous: boolean | undefined

/** Rest has no framework animation loop. Awake restores its own motion; hidden Pro owners freeze themselves.
 * Preserve any pre-existing policy and overlapping host owners. */
export function holdPhaseMotion(): () => void {
  if (!owners.size) previous = MotionGlobalConfig.skipAnimations
  const owner = Symbol('phase motion')
  owners.add(owner)
  MotionGlobalConfig.skipAnimations = true
  let released = false
  return () => {
    if (released) return
    released = true
    // A different writer may change policy during our hold. Retain that policy rather
    // than clobbering it with the first owner's snapshot on a release/acquire handoff.
    if (MotionGlobalConfig.skipAnimations !== true) previous = MotionGlobalConfig.skipAnimations
    owners.delete(owner)
    if (owners.size) { MotionGlobalConfig.skipAnimations = true; return }
    if (previous === undefined) delete MotionGlobalConfig.skipAnimations
    else MotionGlobalConfig.skipAnimations = previous
  }
}
