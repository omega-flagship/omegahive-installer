// Purpose: draw what MeTTa composes under an Ask answer (the ask-answer screen, answer.metta): where the answer came
// from, and the research its turn held back for an asleep Research swarm, with the press that wakes it and sends it,
// offered only where that press can go through.
// Loaded lazily (answerPartsLoader.ts, for AnswerPartsSlot.tsx), so the screen engine stays out of the thread's first paint.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { experienceById } from '../../experiences/registry'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useAskStore, type AskRow } from '../../store/ask'
import { askResearchWake } from '../../store/askResearchWake'
import { useHive } from '../../store/store'
import { answerScreen } from './answerFacts'

/**
 * The parts under one answer. MeTTa decides what shows from the row's facts (answerFacts.answerScreen); this states them,
 * draws the plan in the look being worn and carries out the press: Wake Research wakes the swarm's coordinator and sends
 * the request it held back, as the person who is signed in (askResearchWake). Before any press it has the request
 * checked, and checked again once the coordinator's status here moves on, so the press is offered only where it can go
 * through. With nothing composed, nothing is drawn.
 */
export default function AnswerParts({ r }: { r: AskRow }) {
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const intent = r.wait?.intent
  const wake = useSyncExternalStore(askResearchWake.subscribe, () => (intent ? askResearchWake.view(intent) : null), () => null)
  const client = useHive((s) => s.client)
  const principal = useAskStore((s) => s.bound?.principal)
  const mind = wake?.mind
  const live = useHive((s) => (mind ? s.agents[mind]?.status : undefined))
  const stands = wake?.status
  useEffect(() => {
    if (intent) void askResearchWake.check(intent, client, principal, live)
  }, [intent, client, principal, live, stands])
  const { data, facts } = useMemo(() => answerScreen(r, wake), [r, wake])
  const plan = useMemo(() => compose('ask-answer', facts), [compose, facts])
  if (!plan.parts.length) return null
  return (
    <Screen className="mt-1" plan={plan} host={{
      data,
      onAction: (action) => {
        if (action === 'wake-research' && intent) void askResearchWake.press(intent, useHive.getState().client, useAskStore.getState().bound?.principal)
      },
    }} />
  )
}
