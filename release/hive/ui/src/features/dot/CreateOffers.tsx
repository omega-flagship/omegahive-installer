// Purpose: draw what a mind offers to build in Create in its chat (the mind-create-offers screen, createOffer.metta) and
// carry out the person's press: Start in Create opens the plan it started on Create's Make bench, Not now sets it aside.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Agent } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { CREATE_APP_ID } from '../../lib/displayName'
import { bindEpoch } from '../../lib/identityEpoch'
import { navigate } from '../../lib/router'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { hiveBus, useHive } from '../../store/store'
import { followPlan } from '../createPlan/usePlan'
import { offersScreen, parseOffers, startedPlan } from './createOffer'

interface OfferClient {
  createOffers?(mind: string): Promise<unknown>
  createOfferStart?(offerId: string): Promise<unknown>
  createOfferDismiss?(offerId: string): Promise<unknown>
}

const errText = (e: unknown) => (e as { message?: string } | null)?.message || 'The hive did not answer.'

/**
 * What this mind offers to build in Create for the person reading its chat. MeTTa decides what shows (nothing while
 * there is no open offer); this reads the person's open offers from this mind (again on each create.offer event about
 * it), states the facts, and carries out a press. Start in Create starts the plan with the offer's words (the person's
 * own press, behind Create's person gate), then follows that plan and opens Create's Make bench on it; Not now sets the
 * offer aside. Every write after an await belongs to the identity it started under (lib/identityEpoch).
 */
export function CreateOffers({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client) as unknown as OfferClient | null
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const binding = useMemo(() => bindEpoch(), [])
  const [offers, setOffers] = useState<ReturnType<typeof parseOffers>>([])
  const [pressing, setPressing] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!client?.createOffers) return
    void client.createOffers(agent.id).then(
      (raw) => binding.commit(() => setOffers(parseOffers(raw))),
      () => undefined,   // an unreadable list leaves the last one: an offer is never invented
    )
  }, [client, agent.id, binding])
  useEffect(() => { load() }, [load])
  useEffect(() => hiveBus.on((e) => { if (e.type === 'create.offer' && e.agent_id === agent.id) load() }), [load, agent.id])

  const press = (action: string, offerId: string | undefined) => {
    if (!offerId || pressing) return
    const act = action === 'start-offer' ? client?.createOfferStart : action === 'dismiss-offer' ? client?.createOfferDismiss : undefined
    if (!act) return
    setPressing(true)
    setAlert(null)
    void act.call(client, offerId).then(
      (raw) => binding.commit(() => {
        setPressing(false)
        setOffers((now) => now.filter((o) => o.id !== offerId))
        if (action !== 'start-offer') return
        const planId = startedPlan(raw)
        if (planId) followPlan(planId)
        navigate({ name: 'program', id: CREATE_APP_ID, view: 'make' })
      }),
      (e: unknown) => binding.commit(() => { setPressing(false); setAlert(errText(e)) }),
    )
  }

  // composed once per change of the offers or the alert: each card is a MeTTa composition of its own
  const screen = useMemo(() => offersScreen(offers, agent.name, alert, compose), [offers, agent.name, alert, compose])
  const plan = useMemo(() => compose('mind-create-offers', screen.facts), [compose, screen])
  return (
    <Screen plan={plan} className="shrink-0 px-3 pb-2 empty:hidden" host={{
      data: screen.data,
      busy: pressing,
      onAction: (action, item) => press(action, Array.isArray(item.scope) ? item.scope[0] : undefined),
    }} />
  )
}
