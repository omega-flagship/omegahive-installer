import { stopped } from '../../lib/boundOperation'
import { FlRefusal, type AskShape, type BoundWrite, type FlHost, type MindRef } from './host'
import type { ProfileSaveState, WriteState } from './conditionalCopy'

/** Both presentations observe the real adapter's name → optional persona → prefs
 * writes. A failure never erases an earlier acknowledgement or guesses rollback.
 * Readback is a read through the same person/lifetime fence, not another save.
 */
export async function saveAskObserved(
  host: FlHost,
  mindId: string,
  shape: AskShape,
  write: BoundWrite,
  publish: (state: ProfileSaveState) => void,
  priorLimitSaved = false,
): Promise<MindRef> {
  let state: ProfileSaveState = { name: 'not_sent', purpose: shape.how === null ? 'unchanged' : 'not_sent', preferences: 'not_sent', priorLimitSaved }
  const fields = shape.how === null ? ['name', 'preferences'] as const : ['name', 'purpose', 'preferences'] as const
  let next = 0
  const observe = (field: 'name' | 'purpose' | 'preferences', value: WriteState) => {
    state = { ...state, [field]: value }
    publish({ ...state })
  }
  const readback = async () => {
    if (!host.profile) return
    try {
      const current = await write(() => host.profile!(mindId))
      if (current.id === mindId && typeof current.name === 'string' && typeof current.persona === 'string') {
        state = { ...state, readback: { name: current.name, purpose: current.persona } }
        publish({ ...state })
      }
    } catch { /* A missing readback proves neither rollback nor success. */ }
  }
  publish({ ...state })
  try {
    const mind = await host.saveAsk(mindId, shape, async (send) => {
      const field = fields[next++]
      if (!field) throw new FlRefusal(0, 'profile_unconfirmed', 'The profile write sequence could not be confirmed.')
      try {
        const value = await write(() => { observe(field, 'sent'); return send() })
        observe(field, 'saved')
        return value
      } catch (error) {
        if (state[field] === 'sent') observe(field, 'unknown')
        throw error
      }
    })
    if (mind.id !== mindId) {
      observe('name', 'unknown')
      throw new FlRefusal(409, 'mind_changed', 'Your personal omega changed; nothing further was sent.')
    }
    // Keep the adapter's ordinary preference-refusal policy, while withholding
    // an all-saved claim and reading the current profile after a partial result.
    if (fields.some((field) => state[field] !== 'saved')) await readback()
    return mind
  } catch (error) {
    if (!stopped(error)) await readback()
    throw error
  }
}
