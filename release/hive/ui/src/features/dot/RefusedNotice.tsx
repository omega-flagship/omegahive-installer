// Purpose: draw why a mind is quiet in its chat panel: the mind-refused screen (refused.metta) MeTTa composes from the
// refusal its own model calls last met, and the presses that help.
import { useMemo } from 'react'
import type { Agent } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { refusedScreen } from './refused'

/** The mind's refusal notice. MeTTa decides whether anything shows (nothing while its calls are answered); this states
 *  the facts and carries out a press: Your keys opens You & your keys, Choose a model the panel's model tab. The plan is
 *  composed once per refusal (its facts change only with the mind's view); the words saying when it tries again are
 *  read against the time every 15 s, so "in about 4 minutes" counts down to "now". */
export function RefusedNotice({ agent, onChooseModel }: { agent: Agent; onChooseModel: () => void }) {
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const now = useNow()
  const plan = useMemo(() => compose('mind-refused', refusedScreen(agent).facts), [agent, compose])
  const { data } = refusedScreen(agent, now)
  return (
    <div className="mt-2">
      <Screen plan={plan} host={{
        data,
        onAction: (action) => {
          if (action === 'open-keys') navigate({ name: 'me' })
          else if (action === 'choose-model') onChooseModel()
        },
      }} />
    </div>
  )
}
