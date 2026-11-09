import type { ScreenFacts } from '../../screens/screenSpace'
import { withResource, type ResourceLike } from '../../screens/resourceFacts'

/** Where the Flow studio is: no live connection, its files loading, failed, or in. */
export interface StudioState { enabled: boolean; ready: boolean; error: string | null }

/** The studio's load as the standard resource status (screens/resourceFacts.ts). Pure. */
export function studioResource(s: StudioState): ResourceLike {
  if (!s.enabled) return { status: 'unsupported' }
  if (s.error !== null) return { status: 'error', error: s.error }
  return s.ready ? { status: 'ready' } : { status: 'loading' }
}

/** The facts the flow screen composes from (flow.metta): whether adoptions can be read, and the studio's load. Pure. */
export function flowScreen(s: StudioState, canAdopt: boolean): { data: Record<string, unknown>; facts: ScreenFacts } {
  return withResource(studioResource(s), { data: {}, facts: { flags: { 'can.adopt': canAdopt } } })
}
