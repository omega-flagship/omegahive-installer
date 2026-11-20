// Purpose: let another place (the Ask's "Add a key", features/ask/ConnectNotice) open You and your keys with the add-key
// form already showing. Only a wish to open the form passes through here: never a key, nor any part of one.
const listeners = new Set<() => void>()
let wanted = false

/** Ask for the add-key form: the You page opens it when it mounts, or at once if it is already showing. */
export function requestAddKey(): void {
  wanted = true
  for (const fn of [...listeners]) fn()
}
/** The You page's read: true once per request. */
export function takeAddKeyRequest(): boolean {
  const was = wanted
  wanted = false
  return was
}
export function onAddKeyRequest(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
