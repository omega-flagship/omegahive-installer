// Purpose: read the person's open offers to build in Create once for every place that shows or counts them: a mind's
// chat its own mind's, the Ask's cards and the folded Ask's mark every mind's.
import { useEffect } from 'react'
import type { CreateOffer } from '../../api/types'
import { need, useResource, type ResourceHandle } from '../../lib/useResource'
import { hiveBus, useHive } from '../../store/store'
import { parseOffers } from './createOffer'

/**
 * The person's open offers (GET /api/me/create-offers), one mind's when `mind` is named and every mind's otherwise,
 * one shared read per mind however many places show or count them, read again on each create.offer event about them.
 * It belongs to the identity lib/identityEpoch names (the client, its sign-in, the store's session and init count), so
 * no offer read for one person is ever shown to the next; an unreadable list keeps the last one, so an offer is never
 * invented.
 */
export function useOpenOffers(mind?: string): ResourceHandle<CreateOffer[]> {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const inits = useHive((s) => s.inits)
  const read = useResource(() => need(client, 'createOffers')(mind).then(parseOffers),
    { context: [session, inits], share: mind ? `create-offers:${mind}` : 'create-offers' })
  const { reload } = read
  useEffect(() => hiveBus.on((e) => { if (e.type === 'create.offer' && (!mind || e.agent_id === mind)) reload() }), [reload, mind])
  return read
}
