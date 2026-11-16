/**
 * The person's own personal mind as this page knows it (GET /api/me/mind), and the swarm-talk collector's state.
 * Per person: every identity change empties it at once (lib/identityEpoch), and every write after an await is bound
 * to the identity it started under. The memory itself is not here: it is the browser's (lib/askMemory).
 */
import { create } from 'zustand'
import { ApiError } from '../../api/client'
import { readPersonalMind, type PersonalMind } from '../../api/personalMind'
import { askMemory } from '../../lib/askMemory'
import { bindEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { useHive } from '../../store/store'
import { collectInbox, type CollectResult } from './inbox'

/**
 * unknown: not read yet; absent: this hive has no personal minds (404), or this account is not a named person (403);
 * none: the hive answered {mind: null}; ready: `mind` is the person's; error: the read failed (try again).
 */
export type MindState = 'unknown' | 'loading' | 'ready' | 'absent' | 'none' | 'error'

interface MindStore {
  state: MindState
  mind: PersonalMind | null
  /** why it is absent: the host has no route (404), or this account is not a named person (403) */
  absentWhy: 'no_route' | 'person_required' | null
  /** the last collect of the swarm talk (null: none yet) */
  collect: CollectResult | null
  collecting: boolean
  load(): Promise<void>
  /** Rename the person's mind (POST /api/me/mind {name}). Resolves to an error message, or null when renamed. */
  rename(name: string): Promise<string | null>
  /** Collect the swarm talk now (one at a time; a host without the inbox is not asked again for this person). */
  collectNow(): Promise<CollectResult | null>
}

const EMPTY = { state: 'unknown' as MindState, mind: null, absentWhy: null, collect: null, collecting: false }

let inflight: Promise<CollectResult | null> | null = null

export const useMind = create<MindStore>((set, get) => ({
  ...EMPTY,
  async load() {
    const client = useHive.getState().client
    if (!client?.myMind) return set({ state: 'absent', absentWhy: 'no_route', mind: null })
    const binding = bindEpoch()
    if (get().state !== 'ready') set({ state: 'loading' })
    try {
      const raw = await client.myMind()
      binding.commit(() => {
        const mind = readPersonalMind(raw)
        set({ state: mind ? 'ready' : 'none', mind, absentWhy: null })
      })
    } catch (e) {
      binding.commit(() => {
        if (e instanceof ApiError && e.status === 404) set({ state: 'absent', absentWhy: 'no_route', mind: null })
        else if (e instanceof ApiError && e.status === 403) set({ state: 'absent', absentWhy: 'person_required', mind: null })
        else set({ state: get().mind ? 'ready' : 'error' })
      })
    }
  },
  async rename(name) {
    const client = useHive.getState().client
    const words = name.trim()
    if (!words) return 'A name needs at least one letter.'
    if (words.length > 80) return 'That name is too long (80 letters at most).'
    if (!client?.renameMyMind) return 'Renaming is not available on this hive.'
    const binding = bindEpoch()
    try {
      const raw = await client.renameMyMind(words)
      const mind = readPersonalMind(raw)
      const done = binding.commit(() => {
        if (mind) set({ state: 'ready', mind })
        return true
      })
      return done === true ? null : 'You are signed in as someone else now, so nothing was changed here.'
    } catch (e) {
      if (!binding.current()) return 'You are signed in as someone else now, so nothing was changed here.'
      return e instanceof ApiError && e.status === 400 ? 'The hive did not take that name. Try plain words.' : 'The name could not be saved just now. Try again in a moment.'
    }
  },
  collectNow() {
    if (inflight) return inflight
    const client = useHive.getState().client
    const st = get()
    if (!client || st.collect?.state === 'absent') return Promise.resolve(st.collect)
    const binding = bindEpoch()
    set({ collecting: true })
    const run = collectInbox({ client, memory: askMemory, bind: () => binding })
      .catch((): CollectResult => ({ state: 'failed' }))
      .then((r) => {
        binding.commit(() => set({ collect: r.state === 'stale' ? get().collect : r, collecting: false }))
        return r
      })
      .finally(() => {
        if (inflight === run) inflight = null
      })
    inflight = run
    return run
  },
}))

// a different person (or nobody): nothing of the last one's mind or collect is kept, and a collect in flight is let go
onIdentityChange(() => {
  inflight = null
  useMind.setState({ ...EMPTY })
})
