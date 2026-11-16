import { experienceById } from '../../experiences/registry'
import { useLook } from '../../shell/uiVariant'

export type MindLook = 'classic' | 'cosmos' | 'still'

/** The look the page is shown in (any other experience shows Classic's figure over its own chrome). */
export function useMindLook(): MindLook {
  const look = useLook()
  const id = experienceById(look.current?.experience).id
  return id === 'cosmos' || id === 'still' ? id : 'classic'
}

