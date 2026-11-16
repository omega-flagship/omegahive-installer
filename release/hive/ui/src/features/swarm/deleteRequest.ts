import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { HiveClient } from '../../api/client'
import { bindEpoch, currentEpoch, onIdentityChange } from '../../lib/identityEpoch'

/**
 * "Delete swarm and its minds": which swarm's warning is open (one at a time, over any page or experience: App mounts
 * the dialog). Opened by the swarm's settings, the archived swarms list and the Ask ("delete the Forge swarm") alike.
 * Bound to the identity that opened it: an identity change closes it at once.
 */
export interface SwarmDeleteOpen {
  swarmId: string
  /** the name the opener knew (an archived swarm is not in the store after a reload); the host's preview decides */
  name?: string
  epoch: number
  seq: number
}

let seq = 0
export const useSwarmDelete = create<{ open: SwarmDeleteOpen | null }>(() => ({ open: null }))

export function openSwarmDelete(swarmId: string, known?: { name?: string }): SwarmDeleteOpen {
  const open = { swarmId, name: known?.name, epoch: currentEpoch(), seq: ++seq }
  useSwarmDelete.setState({ open })
  return open
}

export function closeSwarmDelete(): void {
  useSwarmDelete.setState({ open: null })
}

/**
 * Archived swarms by name, for the Ask ("delete the Forge swarm" after a partial delete left Forge archived: the hive
 * leaves archived swarms out of the normal list, so the store forgets them on a reload). Read once per identity, admins
 * only (a member is refused and gets none); cleared by any identity change.
 */
export const archivedNames = createStore<{ list: { id: string; name: string }[] | null }>(() => ({ list: null }))
/**
 * The Ask's read of it. React's own useSyncExternalStore, not zustand's hook binding: the Ask field runs under the
 * conductor/custody harnesses (experiences/dualP2, construct/askCustody), which stand in React's hooks; a store hook
 * bound to another React copy breaks them (Platform integration on ce8001d, r3).
 */
export function useArchivedNames(): { id: string; name: string }[] | null {
  return useSyncExternalStore(archivedNames.subscribe, () => archivedNames.getState().list, () => archivedNames.getState().list)
}
let asked = -1
export function learnArchived(list: { id: string; name: string }[]): void {
  // what the hive listed, plus anything noted meanwhile (a list read before a partial delete does not have it yet)
  archivedNames.setState((st) => {
    const ids = new Set(list.map((s) => s.id))
    return { list: [...list.map((s) => ({ id: s.id, name: s.name })), ...(st.list ?? []).filter((x) => !ids.has(x.id))] }
  })
}
/** A swarm this session just saw archived (a partial or archived delete answer), or deleted (`gone`). */
export function noteArchived(s: { id: string; name: string }, gone = false): void {
  archivedNames.setState((st) => {
    const rest = (st.list ?? []).filter((x) => x.id !== s.id)
    return { list: gone ? rest : [...rest, { id: s.id, name: s.name }] }
  })
}
export async function ensureArchived(client: HiveClient | null | undefined): Promise<void> {
  const b = bindEpoch()
  if (!client || asked === b.epoch) return
  asked = b.epoch
  try {
    const list = await client.listSwarms({ archived: true })
    b.commit(() => learnArchived(list))
  } catch {
    // not an admin, or the hive cannot list them: the Ask simply does not name archived swarms
  }
}

onIdentityChange(() => {
  useSwarmDelete.setState({ open: null })
  archivedNames.setState({ list: null })
  asked = -1
})

/**
 * Whether this hive deletes a swarm together with its minds (host 065e22d): learned from the plain delete's 409, whose
 * body says `with_minds` only on hives that have it. Unknown until then; a hive found without it hides the action.
 */
const support = new WeakMap<object, boolean>()
export const withMindsSupport = (client: HiveClient | null | undefined): boolean | undefined => (client ? support.get(client) : undefined)
export function learnWithMinds(client: HiveClient | null | undefined, has: boolean): void {
  if (client) support.set(client, has)
}
