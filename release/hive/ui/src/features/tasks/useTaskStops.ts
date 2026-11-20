// Purpose: read the person's task stops once for every place that shows or counts them: the Ask's cards, a mind's chat
// and the folded Ask's mark.
import { useEffect } from 'react'
import type { TaskStop } from '../../api/taskStops'
import { need, useResource, type ResourceHandle } from '../../lib/useResource'
import { hiveBus, useHive } from '../../store/store'

// a stop is read again each minute while the page is visible, as main's held-calls list polls (heldCalls.ts
// HELD_POLL_MS), a module this line doesn't carry
const HELD_POLL_MS = 60_000

/**
 * The person's task stops (GET /api/me/task-stops), one shared read however many places show or count them: polled
 * every HELD_POLL_MS while the page is visible and read again when a goal changes. An acknowledged stop goes when the
 * read after it lands (`reload`), in every place at once. Like useOpenOffers, it belongs to the identity
 * lib/identityEpoch names (the client, its sign-in, the store's session and init count).
 */
export function useTaskStops(): ResourceHandle<TaskStop[]> {
  const client = useHive((s) => s.client)
  const session = useHive((s) => s.session)
  const inits = useHive((s) => s.inits)
  const read = useResource(() => need(client, 'listTaskStops')().then((r) => r.stops),
    { context: [session, inits], poll: HELD_POLL_MS, share: 'task-stops' })
  const { reload } = read
  useEffect(() => hiveBus.on((event) => { if (event.type === 'goal.updated') reload() }), [reload])
  return read
}
