// Purpose: draw a waiting Ask turn's go-ahead question (the ask-go-ahead screen, goAhead.metta) under the turn, in the
// look being worn, and send the person's answer through the Ask store.
import { useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useAskStore, type AskRow } from '../../store/ask'
import { goAheadScreen } from './goAhead'

/**
 * A go-ahead row (store/ask turnRows): MeTTa decides what shows for its facts; Go ahead or Stop answers the question
 * once (answerGoAhead), and while that answer is in flight the buttons wait.
 */
export function GoAheadRow({ r }: { r: AskRow }) {
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const screen = useMemo(() => (r.goAhead ? goAheadScreen(r.goAhead) : null), [r.goAhead])
  const plan = useMemo(() => (screen ? compose('ask-go-ahead', screen.facts) : null), [compose, screen])
  const op = r.op
  if (!screen || !plan || !op) return null
  return (
    <div className="ask-row" data-kind="go-ahead">
      <Screen
        plan={plan}
        host={{
          data: screen.data,
          busy: screen.busy,
          onAction: (action) => {
            if (action === 'go-ahead' || action === 'go-stop') void useAskStore.getState().answerGoAhead(op, action === 'go-ahead')
          },
        }}
      />
    </div>
  )
}
