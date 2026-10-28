import type { GoalGrant } from '../../api/types'
import { bindTo, type Bound } from '../../lib/decisionGate'

/**
 * Surface request H: the Code workbench's edit session (which task and grant it uses) and the person's own edit grant.
 *
 * The hive decides; nothing here adds authority. `revocableGrant` only decides whether the "Stop editing" control is
 * offered (the viewer's own active grant, the one this workbench uses). The host's DELETE /api/goals/{task}/grants/{grant}
 * (hive/core/app.py:431, services.py:199 at 60fa650) is admin-only and checks the grant belongs to the task.
 *
 * POST /api/code/open (hive/core/code.py:221-232) always creates a new task and a new 12-hour edit grant; reuse of an
 * earlier task is purely this browser's saved session (localStorage). Reuse is therefore a deliberate choice the
 * person makes on the start screen, never what happens on its own.
 */

/** How the workbench came to use this task and grant (shown in plain words, never silent). */
export type Origin = 'new' | 'reused' | 'joined' | 'selected'

export interface SavedSession {
  task_id: string
  grant_id: string
  repository_id: string
  saved_at?: string
  /** request L: the principal that saved it (sessions are also stored under that principal's key). */
  principal?: string
}

const TASK = /^g_[A-Za-z0-9_-]+$/
const GRANT = /^[A-Za-z0-9_-]+$/

/** A saved session from storage, strictly: anything that is not one is ignored (and never reused). */
export function parseSaved(raw: string | null): SavedSession | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object') return null
    const { task_id, grant_id, repository_id, saved_at, principal } = o
    if (typeof task_id !== 'string' || !TASK.test(task_id) || typeof grant_id !== 'string' || !GRANT.test(grant_id) || typeof repository_id !== 'string' || !repository_id) return null
    const out: SavedSession = { task_id, grant_id, repository_id, saved_at: typeof saved_at === 'string' ? saved_at : undefined }
    if (typeof principal === 'string' && principal) out.principal = principal
    return out
  } catch {
    return null
  }
}

/** The plain label for where this task and grant came from. */
export function originLabel(origin: Origin, task: string): string {
  switch (origin) {
    case 'new':
      return `New task ${task}, started here`
    case 'reused':
      return `Reusing task ${task}: you chose the task saved in this browser`
    case 'joined':
      return `Joined the existing workspace on task ${task}`
    case 'selected':
      return `Editing the existing task ${task}`
  }
}

/**
 * The grant this workbench uses, only when it is the viewer's own and still active: same id, same task, the viewer's
 * principal, not revoked, not expired. Anything else (another person's grant, a revoked one, an expired one, an
 * unknown viewer) is null and the control is not offered.
 */
export function revocableGrant(grants: readonly GoalGrant[] | null | undefined, use: { task_id: string; grant_id: string }, principal: string | null | undefined, nowSec: number): GoalGrant | null {
  if (!grants || !principal) return null
  const g = grants.find((x) => x.id === use.grant_id)
  if (!g || g.goal_id !== use.task_id || g.principal !== principal) return null
  if (!g.active || g.revoked_at || !(g.expires_at > nowSec)) return null
  return g
}

/** Where the grant this workbench uses stands, in plain words (null when it is active or unknown). */
export function grantStanding(g: GoalGrant | undefined, nowSec: number): { kind: 'revoked'; at: string } | { kind: 'expired'; at: number } | null {
  if (!g) return null
  if (g.revoked_at) return { kind: 'revoked', at: g.revoked_at }
  if (!(g.expires_at > nowSec)) return { kind: 'expired', at: g.expires_at }
  return null
}

/** What the person inspected in the revoke dialog (these names appear in "changed while it was open (…)"). */
export interface GrantSeen {
  task: string
  holder: string
  scope: string
  workspace: string | null
  expires: number
  revoked: string | null
}
export const GRANT_SEEN_FIELDS = ['task', 'holder', 'scope', 'workspace', 'expires', 'revoked'] as const satisfies readonly (keyof GrantSeen)[]
export const grantSeenOf = (g: GoalGrant): GrantSeen => ({ task: g.goal_id, holder: g.principal, scope: g.scope, workspace: g.workspace_id, expires: g.expires_at, revoked: g.revoked_at })

/** Is the live grant still the one inspected, and can it still be revoked? */
export function grantBound(seen: GrantSeen, live: GoalGrant | undefined, nowSec: number): Bound {
  return bindTo(seen, live ? grantSeenOf(live) : undefined, GRANT_SEEN_FIELDS, (l) =>
    l.revoked ? 'This grant is already revoked.' : !(l.expires > nowSec) ? 'This grant has already expired.' : null,
  )
}

/** The facts the start dialog binds to: the target as the person read it. */
export interface TargetSeen {
  label: string
  repository: string
  commit: string | null
  openable: boolean
}
export const TARGET_SEEN_FIELDS = ['label', 'repository', 'commit', 'openable'] as const satisfies readonly (keyof TargetSeen)[]
export const targetSeenOf = (t: { label: string; repository_id: string; repo: { commit: string | null } | null; openable?: boolean; closed_reason?: string | null }): TargetSeen => ({
  label: t.label,
  repository: t.repository_id,
  commit: t.repo?.commit ?? null,
  openable: targetOpenable(t),
})
export function targetBound(seen: TargetSeen, live: TargetSeen | undefined): Bound {
  return bindTo(seen, live, TARGET_SEEN_FIELDS, (l) => (!l.openable ? 'This target cannot be opened for editing now.' : null))
}

// ------------------------------------------------------------------------------------------------ request L

/**
 * Surface request L: targets the Code service cannot edit, and saved sessions that no longer work.
 *
 * Platform next10 (51a7ccc, hive/core/code.py:186-201) gives every target `closed_reason` (plain words, or null) and sets
 * `openable` from it; POST /api/code/open on a target the service has no editable copy of is refused 409 not_editable
 * before any task or grant exists (code.py:289-290). Live 0aa6330 has no closed_reason: there `openable` (or a commit)
 * decides, as before, and the service refuses later with 403 repository_unregistered (relayed, after a task and grant
 * were made).
 */
export interface TargetOpenFacts {
  repo: { commit: string | null } | null
  openable?: boolean
  closed_reason?: string | null
}

/** Why the target cannot be opened, in the host's plain words; null when the host gave none (open, or live 0aa6330). */
export function closedReason(t: TargetOpenFacts): string | null {
  const r = t.closed_reason
  return typeof r === 'string' && r.trim() ? r.trim() : null
}

/** Can the target be opened for editing? A closed_reason always closes it; otherwise `openable` (or a commit) decides. */
export function targetOpenable(t: TargetOpenFacts): boolean {
  if (closedReason(t)) return false
  return t.openable ?? !!t.repo?.commit
}

const codeOf = (e: unknown): string | null => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null)
const statusOf = (e: unknown): number | null => (e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null)
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The two refusals that mean "this repository is not editable in the hive". */
export type NotEditable = { kind: 'not_editable' | 'repository_unregistered'; message: string }
export function notEditable(e: unknown): NotEditable | null {
  const code = codeOf(e)
  if (code === 'not_editable' || code === 'repository_unregistered') return { kind: code, message: messageOf(e) }
  return null
}

/** The plain words for a not-editable refusal. `made` is the task and grant the hive had already made (live 0aa6330 only). */
export function notEditableText(r: NotEditable, label: string, made?: { task_id: string; grant_id: string } | null): { title: string; body: string } {
  const title = 'This repository isn’t editable in the hive'
  if (r.kind === 'not_editable') return { title, body: `${r.message.replace(/\.$/, '')}. The hive refused before making anything: no task or edit grant was created.` }
  const why = `The Code service has no editable copy of ${label} registered (repository_unregistered), so it can’t be edited here.`
  return { title, body: made ? `${why} The hive had already made task ${made.task_id} with edit grant ${made.grant_id} for this attempt; this browser no longer offers it. Stop editing (revoke the grant) below, then cancel the task in Tasks.` : `${why} Nothing was opened.` }
}

/** The hive (or the service on its behalf) refused the edit grant itself. */
export const GRANT_REFUSALS = ['grant_invalid', 'grant_revoked', 'grant_required'] as const
export function grantRefused(e: unknown): boolean {
  const code = codeOf(e)
  return !!code && (GRANT_REFUSALS as readonly string[]).includes(code)
}

/** What the start screen does with a session saved in this browser. */
export type SavedJudgement =
  | { kind: 'checking' }
  | { kind: 'offer'; grant: GoalGrant }
  /** dropped from this browser, with the reason in plain words */
  | { kind: 'drop'; why: string }
  /** could not be checked (the hive did not answer): not offered, not dropped */
  | { kind: 'unchecked'; why: string }

const SAVED = 'The task saved in this browser'

/**
 * Offer reuse only when the saved grant exists, is on that task, is the current principal's, and is active, unrevoked
 * and unexpired (exactly `revocableGrant`). Every definite "no" drops it with the reason; an unanswered check neither
 * offers nor drops. `read` is GET /api/goals/{task}/grants: its grants, or the error it gave.
 */
export function judgeSaved(
  saved: SavedSession,
  read: { grants?: readonly GoalGrant[]; error?: unknown } | null,
  principal: string | null | undefined,
  nowSec: number,
  when: (iso: string) => string = (iso) => iso,
): SavedJudgement {
  if (principal === undefined || !read) return { kind: 'checking' }
  if (!principal) return { kind: 'unchecked', why: 'Your sign-in could not be read, so the task saved in this browser cannot be checked. It is not offered.' }
  if (saved.principal && saved.principal !== principal) return { kind: 'drop', why: `${SAVED} belongs to another sign-in.` }
  if (read.error !== undefined || !read.grants) {
    if (statusOf(read.error) === 404) return { kind: 'drop', why: `${SAVED} is no longer in the hive.` }
    return { kind: 'unchecked', why: `Its edit grant could not be checked (${messageOf(read.error ?? 'no answer')}), so it is not offered.` }
  }
  const ok = revocableGrant(read.grants, saved, principal, nowSec)
  if (ok) return { kind: 'offer', grant: ok }
  const g = read.grants.find((x) => x.id === saved.grant_id)
  if (!g) return { kind: 'drop', why: `${SAVED} can’t be reused: its edit grant is no longer on that task.` }
  if (g.goal_id !== saved.task_id) return { kind: 'drop', why: `${SAVED} can’t be reused: its edit grant belongs to a different task.` }
  if (g.principal !== principal) return { kind: 'drop', why: `${SAVED} belongs to another sign-in.` }
  if (g.revoked_at) return { kind: 'drop', why: `${SAVED} can’t be reused: its edit grant was revoked (${when(g.revoked_at)}).` }
  return { kind: 'drop', why: `${SAVED} can’t be reused: its edit grant has ended (${when(new Date(g.expires_at * 1000).toISOString())}).` }
}

/**
 * Surface L1: what judgeSaved may use, from the grant lookup's state. The lookup is a useResource bound to the client,
 * principal, target and saved task+grant, so any state it reports already belongs to the current identity; while the
 * current identity's answer is pending this is null (judgeSaved says "checking", and nothing is offered or dropped).
 */
export function grantRead(s: { status: 'unsupported' | 'loading' | 'error' | 'empty' | 'ready'; data: readonly GoalGrant[] | null | undefined; error: unknown }): { grants?: readonly GoalGrant[]; error?: unknown } | null {
  if (s.status === 'unsupported') return { error: new Error('this hive does not list grants') }
  if (s.status === 'loading') return null
  if (s.status === 'error') return { error: s.error }
  return s.data ? { grants: s.data } : null
}

/** The identity a saved session's grant lookup is made under (besides the client): who, which target, which task and grant. */
export const savedIdentity = (principal: string | null | undefined, target: string, saved: Pick<SavedSession, 'task_id' | 'grant_id'> | null | undefined) => [
  principal,
  target,
  saved?.task_id ?? null,
  saved?.grant_id ?? null,
]
