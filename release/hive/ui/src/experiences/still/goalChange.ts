import type { GoalWrite } from '../../store/store'
import { confirmGoalChange, useHive, type Goal, type GoalSeen } from '../sdk'

/**
 * Still's goal change, the words around it, and its read-only "Check again" (Review B1, next22b/next23b). The goal
 * sheet (Sheets.tsx) only holds this state and draws it.
 *
 * The outcome comes from the store's typed writeGoal, never from patchGoal's boolean: false there also means "the
 * answer was lost" (unknown, untaken), and only a refusal may be worded as one. An unknown outcome never says that
 * nothing happened; it offers a fresh read (store reconcileGoal), which sends nothing. Further decisions on the goal
 * stay fenced while it is unconfirmed: confirmGoalChange → goalBound closes on store goalsUnsure, and on an earlier
 * session.
 */

export const GOAL_WORD: Record<Goal['status'], string> = { open: 'waiting for a taker', claimed: 'in hand', waiting: 'waiting on a person', stalled: 'stalled', submitted: 'handed in', done: 'done', failed: 'failed', cancelled: 'cancelled' }

/** A goal change the person is being asked to confirm: the goal as it showed, and when the confirm appeared. */
export interface GoalAsk {
  id: string
  to: Goal['status']
  seen: GoalSeen
  shownAt: number
}

/** What the sheet shows under a goal after a change (or a check). `recheck`: offer "Check again" (a read only). */
export interface GoalNote {
  id: string
  /** the change asked for; null for a check made without one (the goal is unconfirmed, the note was put away) */
  to: Goal['status'] | null
  /** the store session the change was asked under; a check is only made in that session */
  session: string
  /** the goal's version as the person saw it, to tell "unchanged" from "changed since" */
  version: string
  text: string
  recheck: boolean
}

const UNKNOWN = 'The hive’s answer was lost and the task could not be read again, so whether this change happened is not known.'
const EARLIER = 'This change was asked under an earlier connection to the hive, so it cannot be checked from here; whether it happened there is not known.'

const noteFor = (a: Pick<GoalAsk, 'id' | 'to' | 'seen'>, text: string, recheck: boolean): GoalNote => ({ id: a.id, to: a.to, session: a.seen.session, version: a.seen.version, text, recheck })

/** May this note still be checked again? Only in its own session, and only while the store holds the goal unconfirmed. */
const checkable = (id: string, session: string): boolean => {
  const s = useHive.getState()
  return s.session === session && !!s.goalsUnsure[id]
}

/** The words for a write's outcome, in Still's voice. Null: taken on the hive's own answer (the goal moves; nothing to say). */
export function goalOutcome(a: Pick<GoalAsk, 'id' | 'to' | 'seen'>, r: GoalWrite): GoalNote | null {
  switch (r.kind) {
    case 'taken':
      return r.checked ? noteFor(a, `The hive’s answer was lost, so the task was read again: the change is there. It is ${GOAL_WORD[r.goal.status]} now.`, false) : null
    case 'refused':
      // nothing was sent, or the hive said no; an earlier unanswered change (goalsUnsure) can still be checked
      return noteFor(a, `This change was refused. ${r.why}`, checkable(a.id, a.seen.session))
    case 'untaken':
      return noteFor(
        a,
        r.goal.updated_at === a.seen.version
          ? `The hive’s answer was lost. The task was read again and is unchanged: it is still ${GOAL_WORD[r.goal.status]}. Ask again if you still want it.`
          : `The hive’s answer was lost. The task was read again: it is ${GOAL_WORD[r.goal.status]} now and changed since you saw it. Look at it, then ask again if you still want it.`,
        false,
      )
    case 'unknown':
      if (useHive.getState().session !== a.seen.session) return noteFor(a, `${r.why} ${EARLIER}`, false)
      return noteFor(a, `${UNKNOWN} Check it again before deciding anything more about it.`, checkable(a.id, a.seen.session))
  }
}

/**
 * The "Yes" on Still's inline confirm. `held`: not sent (not a fresh activation, or the goal is no longer the one
 * shown, or it is still unconfirmed); `sent`: what the sheet shows after the write. `sending` runs just before the write.
 */
export async function changeGoal(a: GoalAsk, ev: { at: number; repeat?: boolean }, sending: () => void): Promise<{ kind: 'held'; why: string } | { kind: 'sent'; note: GoalNote | null }> {
  const v = confirmGoalChange(a.seen, a.to, a.shownAt, useHive.getState().goals[a.id], ev)
  if (!v.ok) return { kind: 'held', why: v.why }
  sending()
  // quiet: the sheet says the not-confirmed outcomes itself, with its own "Check again"
  const r = await useHive.getState().writeGoal(a.id, { status: a.to }, a.seen.session, { quiet: true })
  return { kind: 'sent', note: goalOutcome(a, r) }
}

/** A check for an unconfirmed goal whose note is no longer showing (the person put it away): no change to compare. */
export const checkNoteFor = (g: Goal): GoalNote => ({ id: g.id, to: null, session: useHive.getState().session, version: g.updated_at, text: '', recheck: true })

/** "Check again": read the goal again (sends nothing) and say what the read shows. */
export async function recheckGoal(n: GoalNote): Promise<GoalNote> {
  const again = (text: string, recheck: boolean): GoalNote => ({ ...n, text, recheck })
  if (useHive.getState().session !== n.session) return again(EARLIER, false)
  const g = await useHive.getState().reconcileGoal(n.id)
  if (useHive.getState().session !== n.session) return again(EARLIER, false)
  if (!g) return again(`${UNKNOWN} It still could not be read.`, checkable(n.id, n.session))
  if (n.to === null) return again(`Checked again: it is ${GOAL_WORD[g.status]}.`, false)
  if (g.status === n.to) return again(`Checked again: the change is there. It is ${GOAL_WORD[g.status]} now.`, false)
  return again(
    g.updated_at === n.version
      ? `Checked again: the task is unchanged; it is still ${GOAL_WORD[g.status]}. Ask again if you still want it.`
      : `Checked again: it is ${GOAL_WORD[g.status]} now and changed since you saw it. Look at it, then ask again if you still want it.`,
    false,
  )
}
