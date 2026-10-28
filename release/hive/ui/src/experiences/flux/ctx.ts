import { createContext, useCallback, useContext } from 'react'
import type { Agent } from '../sdk'
import type { FluxWorld, FluxView } from './world'
import type { DotTab, SheetPage } from './nav'

export interface SheetState {
  page: SheetPage
  tab?: 'history' | 'rules'
  swarm?: string | null
  /** The Tasks sheet's motivation filter: a motivation id, or 'none' for Unsorted. */
  motivation?: string | null
  pickFor?: DotTab | null
  origin?: Origin
}

export interface Origin {
  x: number
  y: number
}

export interface FluxApi {
  world: FluxWorld
  /** The GPU liquid is running (false: reduced motion or no WebGL). */
  gpu: boolean
  reduced: boolean
  desktop: boolean
  view: FluxView
  openSwarm(id: string, origin?: Origin): void
  openMind(id: string, origin?: Origin): void
  openDecision(id: string, origin?: Origin): void
  closeDecision(): void
  home(): void
  /** The Everything sheet and the native sheets it pours. */
  sheet: SheetState | null
  openSheet(s: SheetState | null): void
}

export const FluxCtx = createContext<FluxApi | null>(null)

export function useFlux(): FluxApi {
  const v = useContext(FluxCtx)
  if (!v) throw new Error('Flux context missing')
  return v
}

/** Bind an element to a liquid entity (it is moved to it every frame). */
export function useNode(key: string) {
  const { world } = useFlux()
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return
      world.nodes.set(key, el)
      // without the GPU nothing moves it every frame: place it now, not at the next unrelated change
      world.placeStatic()
      return () => {
        if (world.nodes.get(key) === el) world.nodes.delete(key)
      }
    },
    [world, key],
  )
}

/** Mark where a droplet should pour into a panel. */
export function useSlot(key: string) {
  const { world } = useFlux()
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return
      world.slots.set(key, el)
      world.placeStatic()
      return () => {
        if (world.slots.get(key) === el) world.slots.delete(key)
      }
    },
    [world, key],
  )
}

export const FONT = "'SF Pro Rounded', ui-rounded, 'Avenir Next Rounded', 'Avenir Next', 'Nunito', 'Quicksand', system-ui, -apple-system, sans-serif"
export const INK = '#f8f3ff'
export const INK2 = '#e4dcf2'
export const INK3 = '#cfc4e2'

export const rgbCss = (c: [number, number, number], a = 1) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)} / ${a})`

export const statusLine = (a: Agent, thinking?: string) =>
  a.status === 'awake' ? (thinking === 'llm' ? 'Thinking' : thinking === 'skills' ? 'Acting' : 'Awake')
  : a.status === 'starting' ? 'Waking'
  : a.status === 'asleep' ? 'Asleep'
  : a.status === 'error' ? 'Needs attention'
  : a.status === 'stopped' ? 'Stopped'
  : 'Not started'

