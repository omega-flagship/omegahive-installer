/**
 * What the loaded OmegaCode service says it supports (GET /v1/capabilities `features`). Codex's owner rulings
 * (CODE_CANVAS_P1_OWNER_DECISIONS_20261006 §1, §4): plain summaries and dependent groups are used only when the loaded
 * service declares `proposal-plain-summary` / `dependent-suggestion-groups`; nothing is synthesised for proposals
 * without them.
 *
 * r3 (stand-in Review P2-4, Kimi r2 follow-up): the answer belongs to the context it was read for. A changed context
 * (another client, task, grant or workspace) is "checking" at once, with nothing declared, until ITS answer arrives; a
 * failed read is "failed" (said, with a retry), never quietly "nothing declared"; a late answer for an earlier context
 * is dropped.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

export const PLAIN_SUMMARY = 'proposal-plain-summary'
export const DEPENDENT_GROUPS = 'dependent-suggestion-groups'

export function featuresOf(raw: unknown): Set<string> {
  const out = new Set<string>()
  if (!raw || typeof raw !== 'object') return out
  const f = (raw as { features?: unknown }).features
  if (Array.isArray(f)) for (const x of f) if (typeof x === 'string' && x) out.add(x)
  // merge features are listed under `merge.features` (OmegaCode api.py capabilities)
  const m = (raw as { merge?: { features?: unknown } }).merge?.features
  if (Array.isArray(m)) for (const x of m) if (typeof x === 'string' && x) out.add(x)
  return out
}

export type CapStatus = 'checking' | 'ready' | 'failed'
export interface Caps {
  status: CapStatus
  /** the context these features were read for */
  key: string
  features: ReadonlySet<string>
  why?: string
}
const NONE: ReadonlySet<string> = new Set()

/** One context's capability read at a time; the latest context wins and earlier answers are dropped. */
export class CapabilityReader {
  private state: Caps = { status: 'checking', key: '', features: NONE }
  private seq = 0
  private subs = new Set<() => void>()
  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }
  getState = () => this.state
  private set(s: Caps) {
    this.state = s
    this.subs.forEach((f) => f())
  }
  /** What is known for `key` now: another context's answer is never lent to this one. */
  stateFor(key: string): Caps {
    return this.state.key === key ? this.state : { status: 'checking', key, features: NONE }
  }
  load(key: string, read: () => Promise<unknown>): Promise<void> {
    const mine = ++this.seq
    this.set({ status: 'checking', key, features: NONE })
    return read().then(
      (raw) => {
        if (mine === this.seq) this.set({ status: 'ready', key, features: featuresOf(raw) })
      },
      (e: unknown) => {
        if (mine === this.seq) this.set({ status: 'failed', key, features: NONE, why: e instanceof Error ? e.message : String(e) })
      },
    )
  }
}

/** Why a proposal with dependent groups cannot be decided here (fail closed), or null. */
export function groupsProblem(groups: readonly (readonly string[])[] | undefined, caps: Pick<Caps, 'status' | 'features'>): string | null {
  if (!groups?.length) return null
  if (caps.status === 'checking') return 'Checking whether the code service supports changes that only work together…'
  if (caps.status === 'failed') return 'Couldn’t check what the code service supports, so a proposal whose changes only work together cannot be decided here. Retry the check.'
  if (caps.features.has(DEPENDENT_GROUPS)) return null
  return 'This proposal says some changes only work together, but the loaded code service does not say it supports that. It cannot be decided here; open it in the drawer’s Proposals to see it in full.'
}

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

/**
 * The loaded service's features for one context (`key`: the client, task, grant and workspace they are read through).
 * Fails closed: a changed key is "checking" with nothing declared at once.
 */
export function useCodeFeatures(call: Call | null, key: string): Caps & { retry: () => void } {
  const reader = useMemo(() => new CapabilityReader(), [])
  const seen = useSyncExternalStore(reader.subscribe, reader.getState, reader.getState)
  const load = useCallback(() => {
    if (call) void reader.load(key, () => call<unknown>('GET', '/v1/capabilities'))
  }, [call, key, reader])
  useEffect(load, [load])
  const caps = seen.key === key && call ? seen : reader.stateFor(key)
  return { ...caps, retry: load }
}

/** A stable identity for an object (a client, a call function), for capability keys. */
const ids = new WeakMap<object, number>()
let next = 1
export const identity = (o: object | null | undefined): number => {
  if (!o) return 0
  let n = ids.get(o)
  if (!n) ids.set(o, (n = next++))
  return n
}
