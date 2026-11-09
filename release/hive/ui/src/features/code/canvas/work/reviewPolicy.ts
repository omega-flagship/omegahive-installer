/**
 * The person's own Code controller review setting (host hive/core/app.py GET/PUT /api/me/code-controller, engine round
 * 12f4292f): review-required (the default: a second opinion before a change can go in; none available → the request
 * waits for the person) or review-waivable (a tested proposal may go on unreviewed when no second opinion can run, and
 * the work stream says so plainly). It applies to new requests.
 *
 * Read once per client; a client without the read, a 404 (an older host) or an answer it can't trust hides the row.
 * A change is written through bindOperation().write (same sign-in, still mounted), shown at once, and put back with one
 * plain line if the save does not go through.
 */
import { useCallback, useEffect, useState } from 'react'
import { bindOperation, OPERATION_STOPPED_WORDS, stopped, useAlive } from '../../../../lib/boundOperation'

export type ReviewPolicy = 'review-required' | 'review-waivable'
export interface ReviewSettingClient {
  codeControllerPrefs?: () => Promise<unknown>
  setCodeControllerPrefs?: (body: { review_policy: ReviewPolicy }) => Promise<unknown>
}
export type ReviewSetting =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; required: boolean; saving: boolean; note: string | null }

export const SAVE_FAILED = 'Your setting couldn’t be saved, so it’s back as it was.'

/** the policy from an answer, or null when it can't be trusted */
export function parseReviewPolicy(raw: unknown): ReviewPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = (raw as { review_policy?: unknown }).review_policy
  return p === 'review-required' || p === 'review-waivable' ? p : null
}

export function useReviewSetting(client: unknown): { setting: ReviewSetting; toggle: (required: boolean) => void } {
  const c = (client ?? {}) as ReviewSettingClient
  const readable = typeof c.codeControllerPrefs === 'function'
  const [state, setState] = useState<{ client: unknown; setting: ReviewSetting } | null>(null)
  const alive = useAlive()
  useEffect(() => {
    if (!readable) return
    let live = true
    void (async () => {
      let setting: ReviewSetting = { kind: 'hidden' }
      try {
        const p = parseReviewPolicy(await c.codeControllerPrefs!())
        if (p) setting = { kind: 'ready', required: p === 'review-required', saving: false, note: null }
      } catch {
        // 404 (an older host) or unreadable: nothing is claimed, the row stays hidden
      }
      if (live) setState({ client, setting })
    })()
    return () => { live = false }
    // the client names the binding; its methods come with it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, readable])
  const setting: ReviewSetting = !readable ? { kind: 'hidden' } : state && state.client === client ? state.setting : { kind: 'loading' }
  const toggle = useCallback((required: boolean) => {
    const cur = state && state.client === client ? state.setting : null
    if (!cur || cur.kind !== 'ready' || cur.saving || typeof c.setCodeControllerPrefs !== 'function') return
    const was = cur.required
    const put = (s: ReviewSetting) => { if (alive()) setState({ client, setting: s }) }
    put({ kind: 'ready', required, saving: true, note: null })
    const op = bindOperation(alive)
    void (async () => {
      try {
        const p = parseReviewPolicy(await op.write(() => c.setCodeControllerPrefs!({ review_policy: required ? 'review-required' : 'review-waivable' })))
        put(p ? { kind: 'ready', required: p === 'review-required', saving: false, note: null } : { kind: 'ready', required: was, saving: false, note: SAVE_FAILED })
      } catch (e) {
        put({ kind: 'ready', required: was, saving: false, note: stopped(e) ? OPERATION_STOPPED_WORDS : SAVE_FAILED })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, state, alive])
  return { setting, toggle }
}
