// Purpose: draw the Ask's "connect a model first" state: the ask-connect screen (connect.metta) MeTTa composes for the
// look being worn, and its one press, which opens You and your keys with the add-key form showing.
import { useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { requestAddKey } from '../keys/addKeyIntent'
import { connectScreen } from './connect'

/** Carry out the screen's press. */
export function connectAction(action: string): void {
  if (action !== 'add-key') return
  requestAddKey()
  navigate({ name: 'me' })
}

export function ConnectNotice({ held }: { held: boolean }) {
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const { data, facts } = useMemo(() => connectScreen(true, held), [held])
  const plan = useMemo(() => compose('ask-connect', facts), [compose, facts])
  return (
    <div className="ask-say" data-ask-connect={held ? 'held' : 'rest'}>
      <Screen plan={plan} host={{ data, onAction: connectAction }} />
    </div>
  )
}
