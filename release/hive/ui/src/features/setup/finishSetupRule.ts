import { useHive } from '../../store/store'
import { flRecordNow, useFlDoor } from '../firstlight/door'
import { ownMinds } from '../firstlight/ownMinds'
import { isDemoClient } from '../showreel/hook'

type Lists = Pick<ReturnType<typeof useHive.getState>, 'ready' | 'agents' | 'swarms'>

/**
 * Whether the hive is in use (features/firstlight/ownMinds `established`: a mind of the person's own, their personal mind
 * included, has been awake), as the hive store lists their minds now. Null while it cannot tell: before the store's
 * first lists, or while they name no personal mind of theirs. Null is never read as "not in use", so neither First
 * Light nor its nudge acts on a list that is still loading.
 */
export const inUseNow = (s: Lists = useHive.getState()): boolean | null => (s.ready ? ownMinds(s.agents, s.swarms, null)?.established ?? null : null)

/**
 * inUseNow once the store can tell: the hive makes a person's personal mind at sign-in, and the store lists it with its
 * first lists or the event that follows. Null when `alive` ends first. Time: one inUseNow per store change while waiting.
 */
export function inUseKnown(alive: () => boolean): Promise<boolean | null> {
  const now = inUseNow()
  if (now !== null || !alive()) return Promise.resolve(alive() ? now : null)
  return new Promise((resolve) => {
    const stop = useHive.subscribe((s) => {
      const known = inUseNow(s)
      if (known === null && alive()) return
      stop()
      resolve(alive() ? known : null)
    })
  })
}

/**
 * Whether the setup nudge says Finish setup: the person set First Light aside with its Not now (their record reads
 * skipped) and the hive is known not to be in use (inUseNow: none of their own minds, their personal mind included, has
 * ever been awake). Never on the simulator, while First Light is open, or while the store cannot tell yet.
 */
export function useFinishSetup(): boolean {
  const ready = useHive((s) => s.ready)
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  useHive((s) => s.session) // another sign-in reads only its own record (flRecordNow)
  const open = useFlDoor((s) => !!s.asked)
  const record = useFlDoor((s) => s.record)
  if (!client || isDemoClient(client) || open || flRecordNow(record) !== 'skipped') return false
  return inUseNow({ ready, agents, swarms }) === false
}
