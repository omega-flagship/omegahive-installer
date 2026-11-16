// Purpose: the usage region of the frame screen (screens/frame.metta) for the look being worn: states the frame's facts and data (today the battery's, features/usage/allowance.ts), has MeTTa compose the frame, and draws the parts it places in the usage region. Loaded lazily by shell/UsageRegion.tsx, so the screen engine stays out of the first paint.
import { useMemo } from 'react'
import { experienceById } from '../experiences/registry'
import { allowanceScreen, useBatteries } from '../features/usage/allowance'
import { RegionParts } from '../screens/Screen'
import { screensSpace, type ScreenFacts } from '../screens/screenSpace'
import { useLook } from './uiVariant'

export default function FrameUsage({ className }: { className?: string }) {
  const look = experienceById(useLook().current?.experience).id
  const { data, facts } = allowanceScreen(useBatteries())
  // composing runs MeTTa, so it is redone only when a fact or the look changes; the words and levels are data, filled at
  // draw time
  const factsKey = JSON.stringify(facts)
  const plan = useMemo(() => screensSpace().compose('frame', look, JSON.parse(factsKey) as ScreenFacts), [look, factsKey])
  return <RegionParts plan={plan} host={{ data }} region="usage" className={className} />
}
