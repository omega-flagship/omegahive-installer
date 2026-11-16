import type { HiveClient } from '../api/client'
import { noteFlRecord } from '../features/firstlight/door'
import { bindOperation, stopped } from '../lib/boundOperation'

/** The hive's landing: no hash, `#` or `#/` (any query is ignored). Every other address is a deep link. */
export function isLanding(hash: string): boolean {
  const path = hash.split('?')[0]
  return path === '' || path === '#' || path === '#/'
}

/**
 * Late automatic routing never supersedes a person's newer navigation, explicit journey or tour, and never opens over a
 * deep link: First Light may open by itself only on the hive's landing (#/ or no hash). Anywhere else (#/code,
 * #/create/code, #/me…) the person reached a page on purpose; it stays theirs, and First Light waits to be asked for
 * (the Me page, the Ask, or the Finish setup nudge once it is set aside). This holds for a First Light the person has
 * begun as much as for one never begun: Not now is the card's way out, so a link followed is never taken over.
 */
export function mayResumeFirstRun(at: string, current: string, moved: boolean, journeyOpen: boolean, tourOpen: boolean): boolean {
  return !moved && at === current && isLanding(current) && !journeyOpen && !tourOpen
}

/** The host record, never the browser welcome flag, decides whether live First Light resumes. */
export function firstRunDisposition(value: unknown): 'resume' | 'complete' | 'unknown' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const r = value as Record<string, unknown>
  if (r.record !== 'first-light.progress/1' || typeof r.version !== 'number' || !Number.isSafeInteger(r.version) || r.version < 0) return 'unknown'
  if (r.status === 'finished' || r.status === 'skipped') return 'complete'
  return r.status === 'not_started' || r.status === 'in_progress' ? 'resume' : 'unknown'
}

/**
 * A read and a local route only; no mind creation, provider probe, Wake or model call. `resume` opens First Light where
 * mayResumeFirstRun allows it. `inUse`: whether the hive is in use (features/firstlight/ownMinds: a mind of the
 * person's own, their personal mind included, has been awake), so an update never forces it back into onboarding and
 * First Light then opens only when asked for; null, or a promise of it, while the hive store cannot tell yet
 * (features/setup/finishSetupRule inUseKnown waits for it). Only a known "not in use" opens it.
 */
export async function enterFirstRun(client: Pick<HiveClient, 'onboarding'>, resume: () => void, alive: () => boolean = () => true, inUse: () => boolean | null | Promise<boolean | null> = () => false): Promise<'resume' | 'complete' | 'unknown' | 'stopped'> {
  const op = bindOperation(alive)
  if (!client.onboarding) return 'unknown'
  try {
    const record = await op.write(() => client.onboarding!())
    const decision = firstRunDisposition(record)
    if (!op.current()) return 'stopped'
    // what the Finish setup bar reads (features/setup/SetupChecklist FinishSetupNudge): a record it cannot read forgets
    noteFlRecord(decision === 'unknown' ? null : (record as { status?: unknown }).status)
    if (decision === 'resume') {
      const used = await inUse()
      if (!op.current()) return 'stopped'
      if (used === false) resume()
    }
    return decision
  } catch (e) {
    return !op.current() || stopped(e) ? 'stopped' : 'unknown'
  }
}
