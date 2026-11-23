// Purpose: the own-coding part of a mind's settings: MeTTa composes it (ownCoding.metta), and its switch sets or
// clears options.own_coding, which only the mind's owner may do.
import { useMemo } from 'react'
import type { Agent } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { shown } from '../../lib/displayName'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { ownCodingScreen } from './ownCoding'

export function OwnCodingSetting({ agent }: { agent: Agent }) {
  const patch = useHive((s) => s.patchAgent)
  const toast = useHive((s) => s.toast)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const { plan, data } = useMemo(() => {
    const { data, facts } = ownCodingScreen(agent)
    return { plan: compose('own-coding', facts), data }
  }, [agent, compose])
  return (
    <Screen plan={plan} host={{
      data,
      onAction: async (action, _item, value) => {
        if (action !== 'own-coding') return
        const next = { ...(agent.options ?? {}) }
        if (value === true) next.own_coding = true
        else delete next.own_coding
        const ok = await patch(agent.id, { options: next })
        if (ok) toast({ tone: 'success', title: value === true ? `${shown(agent.name)} may now write and run its own code`
          : `${shown(agent.name)} builds software through Create again`, body: 'From its next turn; an Iter mind changes its tools at its next start.' })
      },
    }} />
  )
}
