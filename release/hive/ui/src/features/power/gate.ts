import { ApiError } from '../../api/client'
import { HIVE_OFF_CODE, OPEN_WHILE_OFF } from './api'

/** What the page knows of the hive's power: not yet read, on, or off. */
export type GateState = 'unknown' | 'on' | 'off'

/**
 * The page's side of "while off, only power, sign-in and the events socket" (Platform, 2026-10-05). One gate per
 * client: every client method outside OPEN_WHILE_OFF goes through it.
 *  - on: straight through, synchronously (a sync method stays sync).
 *  - off: refused at once with ApiError(503, 'hive_off'); NO request is made, so polling costs nothing.
 *  - unknown (boot, or just signed in): held until the power read settles, then on or refused. The first held call
 *    asks for that read (`need`), so a hydrate after sign-in reads power before anything else.
 */
export class PowerGate {
  state: GateState = 'unknown'
  /** Method names refused while off, in order (tests read this; capped). */
  readonly refused: string[] = []
  /**
   * f0b412fc B1: the identity this gate holds calls for. Bumped by `end` (sign-out, an unauthorized answer, a new
   * client): a call held under an earlier generation is settled (rejected) and never runs against a later identity.
   */
  generation = 0
  /** Set once this gate's client was replaced: every call through it is refused, with no request made. */
  retired: ApiError | null = null
  private waiters: { resolve: (s: Exclude<GateState, 'unknown'>) => void; reject: (e: ApiError) => void }[] = []
  private listeners = new Set<(s: GateState, prev: GateState) => void>()
  /** Called when a held call needs the power read; set by the power store. */
  need: () => void = () => undefined

  set(next: GateState): void {
    const prev = this.state
    if (next === prev) return
    this.state = next
    if (next !== 'unknown') {
      const w = this.waiters
      this.waiters = []
      w.forEach((f) => f.resolve(next))
    }
    this.listeners.forEach((f) => f(next, prev))
  }
  /**
   * The identity this gate served has ended (signed out, or its client replaced): every held call is rejected with
   * `why` (none of them runs later, under whoever signs in next), the gate goes back to unknown, and the generation
   * moves on. `retire` also refuses every later call through this gate (its client is no longer the page's).
   */
  end(why: ApiError, retire = false): void {
    this.generation++
    if (retire) this.retired = why
    const w = this.waiters
    this.waiters = []
    w.forEach((f) => f.reject(why))
    this.set('unknown')
  }
  on(fn: (s: GateState, prev: GateState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  known(): Promise<Exclude<GateState, 'unknown'>> {
    if (this.retired) return Promise.reject(this.retired)
    if (this.state !== 'unknown') return Promise.resolve(this.state)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  refuse(name: string): ApiError {
    if (this.refused.length < 500) this.refused.push(name)
    return new ApiError(503, HIVE_OFF_CODE, 'The hive is off. An admin can turn it on.')
  }
}

/** A held call whose session ended before power was known: it was never sent. */
export const ended = (): ApiError => new ApiError(401, 'session_ended', 'Signed out before this could be sent. It was not sent.')

/** A held or later call through a client the page has replaced: never sent. */
export const replaced = (): ApiError => new ApiError(409, 'client_replaced', 'This connection was replaced before this could be sent. It was not sent.')

/** The client as the rest of the page sees it: the same object, with every method outside OPEN_WHILE_OFF gated. */
export function gateClient<C extends object>(raw: C, gate: PowerGate, signedOut: () => void = () => undefined): C {
  const wrapped = new Map<PropertyKey, unknown>()
  return new Proxy(raw, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      // signing out ends the identity on this client whether or not the client reports it (f0b412fc B1)
      if (prop === 'logout')
        return (...args: unknown[]) => {
          let result: unknown
          try {
            result = (value as (...a: unknown[]) => unknown).apply(target, args)
          } catch (e) {
            signedOut()
            throw e
          }
          // an awaited sign-out (live client) ends the identity once it settles, whichever way
          if (result && typeof (result as Promise<unknown>).then === 'function') return (result as Promise<unknown>).finally(signedOut)
          signedOut()
          return result
        }
      if (typeof prop !== 'string' || OPEN_WHILE_OFF.has(prop)) return (value as (...a: unknown[]) => unknown).bind(target)
      let w = wrapped.get(prop)
      if (!w) {
        w = (...args: unknown[]) => {
          // read at call time: a method replaced on the client is the one called
          const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown
          if (gate.retired) return Promise.reject(gate.retired)
          if (gate.state === 'on') return fn.apply(target, args)
          if (gate.state === 'off') return Promise.reject(gate.refuse(prop))
          // held: it runs only under the identity it was made in (a sign-out or a new client settles it, unrun)
          const g = gate.generation
          gate.need()
          return gate.known().then((s) => {
            if (gate.generation !== g || gate.retired) return Promise.reject(gate.retired ?? ended())
            return s === 'on' ? fn.apply(target, args) : Promise.reject(gate.refuse(prop))
          })
        }
        wrapped.set(prop, w)
      }
      return w
    },
  })
}
