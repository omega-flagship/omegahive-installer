import type { HiveClient } from '../api/client'
import { bindOperation, stopped } from '../lib/boundOperation'

/** The hive's landing: no hash, `#` or `#/` (any query is ignored). Every other address is a deep link. */
export function isLanding(hash: string): boolean {
  const path = hash.split('?')[0]
  return path === '' || path === '#' || path === '#/'
}

/**
 * Late automatic routing never supersedes a person's newer navigation, explicit journey or tour, and never opens over a
 * deep link: First Light may open by itself only on the hive's landing (#/ or no hash). Anywhere else (#/code,
 * #/create/code, #/me…) the person reached a page on purpose; it stays theirs, and First Light waits to be asked for.
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

/** A read and a local route only; no mind creation, provider probe, Wake or model call. */
export async function enterFirstRun(client: Pick<HiveClient, 'onboarding'>, resume: () => void, alive: () => boolean = () => true): Promise<'resume' | 'complete' | 'unknown' | 'stopped'> {
  const op = bindOperation(alive)
  if (!client.onboarding) return 'unknown'
  try {
    const decision = firstRunDisposition(await op.write(() => client.onboarding!()))
    if (!op.current()) return 'stopped'
    if (decision === 'resume') resume()
    return decision
  } catch (e) {
    return !op.current() || stopped(e) ? 'stopped' : 'unknown'
  }
}
