import { parseSaved, type SavedSession } from './editSessionRules'

/**
 * Surface request L: the edit session this browser saves (which task and grant the Code workbench used), stored per
 * principal AND target, so a session saved under another sign-in is never even read. One attempt reused a task and
 * grant saved under an older identity and the hive refused it (grant_invalid).
 *
 * Keys: `omegadots.code.session.<principal>|<target>` (both URI-encoded) and `….ws` for its workspace. Every older
 * `omegadots.code.<target>` entry (request H and before: target only, no principal) is ignored and removed.
 */

export interface SessionStore {
  readonly length: number
  key(i: number): string | null
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

const PREFIX = 'omegadots.code.'
const KEYED = `${PREFIX}session.`

export const sessionKey = (principal: string, target: string) => `${KEYED}${encodeURIComponent(principal)}|${encodeURIComponent(target)}`
export const workspaceKey = (principal: string, target: string) => `${sessionKey(principal, target)}.ws`

const browser = (): SessionStore | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Remove every saved session that is not keyed by principal (request H and before). Returns how many were removed. */
export function purgeUnkeyed(store: SessionStore | null = browser()): number {
  if (!store) return 0
  try {
    const old: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k && k.startsWith(PREFIX) && !k.startsWith(KEYED)) old.push(k)
    }
    for (const k of old) store.removeItem(k)
    return old.length
  } catch {
    return 0
  }
}

/** The session this principal saved for this target, read strictly; nothing for an unknown principal. */
export function readSession(principal: string | null | undefined, target: string, store: SessionStore | null = browser()): (SavedSession & { swarm_id?: string; base_commit?: string; workspace_id?: string }) | null {
  purgeUnkeyed(store)
  if (!principal || !store) return null
  try {
    const raw = store.getItem(sessionKey(principal, target))
    const s = parseSaved(raw)
    if (!s) return null
    // stored under this principal's key but naming another principal: judgeSaved drops it ("belongs to another sign-in")
    const extra = JSON.parse(raw!) as Record<string, unknown>
    return {
      ...s,
      swarm_id: typeof extra.swarm_id === 'string' ? extra.swarm_id : undefined,
      base_commit: typeof extra.base_commit === 'string' ? extra.base_commit : undefined,
      workspace_id: typeof extra.workspace_id === 'string' ? extra.workspace_id : undefined,
    }
  } catch {
    return null
  }
}

/** Save the session this principal now uses for a target; a new task never inherits the old task's workspace. */
export function saveSession(principal: string | null | undefined, target: string, o: { task_id: string; grant_id: string; repository_id: string; swarm_id?: string; base_commit?: string; workspace_id?: string }, fresh: boolean, store: SessionStore | null = browser()) {
  if (!principal || !store) return
  try {
    const { task_id, grant_id, repository_id, swarm_id, base_commit, workspace_id } = o
    store.setItem(sessionKey(principal, target), JSON.stringify({ task_id, grant_id, repository_id, swarm_id, base_commit, workspace_id, principal, saved_at: new Date().toISOString() }))
    if (fresh) store.removeItem(workspaceKey(principal, target))
  } catch {
    /* storage unavailable: the session still works for this page */
  }
}

/** Forget the session (and its workspace) this principal saved for a target. */
export function dropSession(principal: string | null | undefined, target: string, store: SessionStore | null = browser()) {
  if (!principal || !store) return
  try {
    store.removeItem(sessionKey(principal, target))
    store.removeItem(workspaceKey(principal, target))
  } catch {
    /* storage unavailable */
  }
}

/**
 * Surface L1: forget the saved session only if storage still holds the one that was judged (same task AND grant). A
 * judgement about one grant never deletes an entry that has since been replaced, even on the same task.
 */
export function dropSessionIf(principal: string | null | undefined, target: string, judged: { task_id: string; grant_id: string }, store: SessionStore | null = browser()): boolean {
  if (!principal || !store) return false
  try {
    const now = parseSaved(store.getItem(sessionKey(principal, target)))
    if (!now || now.task_id !== judged.task_id || now.grant_id !== judged.grant_id) return false
  } catch {
    return false
  }
  dropSession(principal, target, store)
  return true
}

export function readWorkspace(principal: string | null | undefined, target: string, store: SessionStore | null = browser()): string | null {
  if (!principal || !store) return null
  try {
    return store.getItem(workspaceKey(principal, target))
  } catch {
    return null
  }
}

export function saveWorkspace(principal: string | null | undefined, target: string, id: string, store: SessionStore | null = browser()) {
  if (!principal || !store) return
  try {
    store.setItem(workspaceKey(principal, target), id)
  } catch {
    /* storage unavailable */
  }
}

/**
 * Surface S: remember the workspace made for a session, but only while storage still holds that same session (task AND
 * grant). A create that lands after the person left the workbench is remembered too, so coming back reads that
 * workspace instead of making another; one that lands after a newer session replaced it is never filed under it.
 */
export function saveWorkspaceFor(principal: string | null | undefined, target: string, session: { task_id: string; grant_id: string }, id: string, store: SessionStore | null = browser()): boolean {
  if (!principal || !store) return false
  try {
    const now = parseSaved(store.getItem(sessionKey(principal, target)))
    if (!now || now.task_id !== session.task_id || now.grant_id !== session.grant_id) return false
    store.setItem(workspaceKey(principal, target), id)
    return true
  } catch {
    return false
  }
}
