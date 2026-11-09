import { errorMessage, isForbidden, type ResourceStatus } from '../lib/useResource'
import type { ScreenFacts } from './screenSpace'

/**
 * The one standard set of facts a page states about the resource its screen loads, for the shared resource-state
 * fragment in lib_screens.metta (`(Resource <screen> <base> (…))`). Pure: every page states them the same way.
 *
 *   value resource   loading | ready | unsupported | forbidden | failed   (ready covers an empty answer too)
 *   flag  resource.stale   a refresh failed and the last data stays on screen
 *   flag  resource.empty   the answer is in, and empty
 *   data  resource.error   why the last read failed, in plain words ('' when it did not)
 */
export type ResourceFact = 'loading' | 'ready' | 'unsupported' | 'forbidden' | 'failed'
/** What the facts are read from: a ResourceState (lib/useResource), or any load that tracks the same status and last failure. */
export type ResourceLike = { status: ResourceStatus; error?: unknown }

export function resourceFact(res: ResourceLike): ResourceFact {
  switch (res.status) {
    case 'loading': return 'loading'
    case 'unsupported': return 'unsupported'
    case 'error': return isForbidden(res.error) ? 'forbidden' : 'failed'
    default: return 'ready'
  }
}

export function resourceFacts(res: ResourceLike): { data: { 'resource.error': string }; facts: Required<Pick<ScreenFacts, 'flags' | 'values'>> } {
  const state = resourceFact(res)
  return {
    data: { 'resource.error': res.error === undefined ? '' : errorMessage(res.error) },
    facts: {
      values: { resource: state },
      flags: { 'resource.stale': state === 'ready' && res.error !== undefined, 'resource.empty': res.status === 'empty' },
    },
  }
}

/** A page's own facts with the resource's standard ones added (the page's counts, flags and values are kept). */
export function withResource(res: ResourceLike, own: { data: Record<string, unknown>; facts: ScreenFacts }): { data: Record<string, unknown>; facts: ScreenFacts } {
  const r = resourceFacts(res)
  return {
    data: { ...own.data, ...r.data },
    facts: { ...own.facts, flags: { ...own.facts.flags, ...r.facts.flags }, values: { ...own.facts.values, ...r.facts.values } },
  }
}
