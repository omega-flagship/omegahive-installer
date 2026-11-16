/**
 * What an experience lends its Ask skin, so the skin can live in the experience's own medium without the Ask reaching
 * into the experience (and without the experience forking the Ask). Presentation only: a bridge can make the liquid
 * refract through the capsule or ripple it. It never acts, navigates or
 * reads hive data, and it is dropped when the experience unmounts.
 */
import { useSyncExternalStore } from 'react'

export interface AskBridge {
  /** Flux: register an element as liquid glass (the shader refracts through it); returns the unregister. */
  glass?: (el: HTMLElement, radius: number) => () => void
  /** Flux: a ripple in the liquid at a screen point (strength ~0.3–1.6). */
  ripple?: (x: number, y: number, strength: number) => void
}

const bridges = new Map<string, AskBridge>()
const subs = new Set<() => void>()

export function registerAskBridge(experience: string, b: AskBridge): () => void {
  bridges.set(experience, b)
  subs.forEach((f) => f())
  return () => {
    if (bridges.get(experience) === b) {
      bridges.delete(experience)
      subs.forEach((f) => f())
    }
  }
}

export const askBridge = (experience: string): AskBridge | undefined => bridges.get(experience)

export function onBridgeChange(f: () => void): () => void {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}

/** The experience's bridge, re-read when an experience registers or drops one (it may load after the Ask). */
export function useAskBridge(experience: string): AskBridge | undefined {
  return useSyncExternalStore(onBridgeChange, () => bridges.get(experience), () => undefined)
}
