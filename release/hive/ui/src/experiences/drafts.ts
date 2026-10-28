import { useMemo, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { bindEpoch, onIdentityChange, type EpochBinding } from '../lib/identityEpoch'

/**
 * Unsent words, kept apart from the panel that shows them (close-home r3). A surface's X resets an experience to its
 * home (home:requested), which closes conversation panels and forms; what the person typed must survive that and be
 * there when they reopen the same place. One draft per key (an experience and the place: a mind's conversation, a
 * swarm's new task, …). Per person: an identity change clears every draft, and a write made under an earlier identity
 * (a send that fails after an await) is skipped (lib/identityEpoch).
 */
type Drafts = { drafts: Record<string, string>; gen: number }
export const useDrafts = create<Drafts>()(() => ({ drafts: {}, gen: 0 }))
onIdentityChange(() => useDrafts.setState((s) => ({ drafts: {}, gen: s.gen + 1 })))

function write(key: string, next: string) {
  useDrafts.setState((s) => {
    if ((s.drafts[key] ?? '') === next) return s
    const drafts = { ...s.drafts }
    if (next) drafts[key] = next
    else delete drafts[key]
    return { drafts }
  })
}

export type SetDraft = (v: string | ((cur: string) => string)) => void

/** The words kept under `key` ('' when none). */
export const readDraft = (key: string): string => useDrafts.getState().drafts[key] ?? ''

/** A writer for `key` bound to one identity: once that identity is no longer current, it writes nothing. */
export function draftWriter(key: string, binding: EpochBinding = bindEpoch()): SetDraft {
  return (v) => {
    binding.commit(() => write(key, typeof v === 'function' ? v(readDraft(key)) : v))
  }
}

/** Like useState(''), but the text lives in the draft store under `key`, independent of this component's lifetime. */
export function useDraft(key: string): [string, SetDraft] {
  // read through React's own external-store hook (no zustand hook), so every React runtime sees the same subscription
  const text = useSyncExternalStore(useDrafts.subscribe, () => readDraft(key), () => readDraft(key))
  const gen = useSyncExternalStore(useDrafts.subscribe, () => useDrafts.getState().gen, () => useDrafts.getState().gen)
  // bound to the identity this render belongs to: a late write from an earlier person never lands
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const binding = useMemo(() => bindEpoch(), [gen])
  const set = useMemo(() => draftWriter(key, binding), [binding, key])
  return [text, set]
}
