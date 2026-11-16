// Purpose: the mind whose chat or card the person is using, which an Ask made meanwhile answers as (Jon, 16 Nov: "the
// ask will auto route to whichever mind you're interacting with"): each look's chat marks its mind while it is open,
// and the Ask's context names the one opened last that is still open.
import { useEffect } from 'react'

/** Open chats or cards per mind (one mind may be open in two places), and the order they opened, latest last. */
const openCount = new Map<string, number>()
let order: string[] = []
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const toEnd = (id: string) => { order = [...order.filter((x) => x !== id), id] }

export const mindInUse = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** The mind whose chat or card opened last and is still open, or null. */
  get(): string | null {
    return order.length ? order[order.length - 1] : null
  },
  /** A chat or card of this mind opened: it is the one in use now, until it closes (the returned release, once). */
  open(id: string): () => void {
    openCount.set(id, (openCount.get(id) ?? 0) + 1)
    toEnd(id)
    emit()
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (openCount.get(id) ?? 1) - 1
      if (left > 0) openCount.set(id, left)
      else {
        openCount.delete(id)
        order = order.filter((x) => x !== id)
      }
      emit()
    }
  },
  /** Nothing is in use (a sign-out or a new person). */
  clear(): void {
    if (!order.length && !openCount.size) return
    openCount.clear()
    order = []
    emit()
  },
}

/** Marks this mind's chat or card as in use while the component showing it is mounted (no id: nothing is marked). */
export function useMindInUse(id: string | null | undefined): void {
  useEffect(() => (id ? mindInUse.open(id) : undefined), [id])
}
