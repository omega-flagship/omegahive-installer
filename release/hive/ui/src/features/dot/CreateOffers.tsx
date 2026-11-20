// Purpose: draw what a mind offers to build in Create in its chat, whichever look draws that chat (the mind-create-offers
// screen, createOffer.metta), and carry out the person's press: Start in Create opens the plan it started on Create's
// Make bench, Not now sets it aside.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Agent } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { cx } from '../../lib/cx'
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

// The cards give way first when a chat is short: they shrink and scroll inside, so the composer under them stays whole,
// as the outside member's connect steps do in Chat.tsx. Mounted shrink-0, two cards and a mind's error notice pushed
// classic's composer under its Live log bar at 1440x900, where neither the box nor Send took a pointer (a dry run on a
// hive with no model, 19 Nov).
const GIVE_WAY = 'thin-scroll max-h-[45dvh] min-h-0 shrink overflow-y-auto'

// The cards are drawn by the shared blocks in the classic hive's colour tokens, and each experience draws its chat in its
// own tree, outside the classic pages' dress (App.tsx). So the cards wear the dress themselves: inside an experience
// (html[data-xc-active]) index.css re-points those tokens at the worn experience's chrome, whose inks hold 4.5:1 on its
// surfaces (each experience's chrome.test.ts); in the classic hive the dress is off. Undressed, Canvas's white chat drew
// the offer and Not now in classic's near-white ink on white, about 1.2:1 (the v0.40 Mac kit, 20 Nov).
const DRESS = 'xc-dress'

/**
 * What this mind offers to build in Create for the person reading its chat. MeTTa decides what shows (nothing while
 * there is no open offer); this reads the person's open offers from this mind (again on each create.offer event about
 * it), states the facts, and carries out a press. Start in Create starts the plan with the offer's words (the person's
 * own press, behind Create's person gate), then follows that plan and opens Create's Make bench on it; Not now sets the
 * offer aside. Every write after an await belongs to the identity it started under (lib/identityEpoch). Each look's own
 * chat with a mind mounts it between the conversation and the composer, with the look's own spacing as `className`; the
 * classic mind panel's is the default. The cards give way first when the chat is short (GIVE_WAY), so a look's
 * className never sets shrink-0, and they wear the worn experience's chrome (DRESS).
 */
export function CreateOffers({ agent, className = 'px-3 pb-2 empty:hidden' }: { agent: Agent; className?: string }) {
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
    <Screen plan={plan} className={cx(DRESS, GIVE_WAY, className)} host={{
      data: screen.data,
      busy: pressing,
      onAction: (action, item) => press(action, Array.isArray(item.scope) ? item.scope[0] : undefined),
    }} />
  )
}
