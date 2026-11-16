/**
 * A value an effect creates and a render shows, for an object that lives outside React (a controller that registers
 * itself on creation, so it must be made in an effect): the effect sets it here, the render reads it with
 * useSyncExternalStore(held.subscribe, held.get). No setState in the effect, and the render always sees the latest.
 */
export interface Held<T> { get(): T; set(value: T): void; subscribe(listener: () => void): () => void }

export function heldValue<T>(initial: T): Held<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const l of [...listeners]) l()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
