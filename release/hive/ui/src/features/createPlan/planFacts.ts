import type { Compose, ScreenFacts } from '../../screens/screenSpace'
import { clockTime } from '../../lib/format'
import type { PlanRevision, PlanSummary, PlanView } from './contract'
import { codeTarget, isHeld, openQuestions, planEnded } from './planModel'

/**
 * Purpose: what the Make bench is told (plan.metta): which of its three screens is drawn, this moment's facts (counts,
 * flags and known symbols, never a person's words) from which MeTTa composes it, and the values its parts draw by path,
 * each of the app's versions (plan-revision) and each app the person made (plan-made) composed as its own small screen.
 * Pure: the page hands in the plan view (or none yet), where its own controls stand, and the composer for the look it
 * wears.
 */
export type PlanScreen = 'plan-start' | 'plan' | 'plan-ready'
export interface PlanUi {
  /** this hive carries the plan routes */
  can: boolean
  /** the sentence is on its way */
  starting: boolean
  /** why the last start failed, in plain words */
  startError: string | null
  /** the Stop is asking to be confirmed */
  stopAsking: boolean
  /** a plan this browser follows is being read again (back on the bench): drawn as the plan, not the empty canvas */
  opening?: boolean
  /** the page already holds something to run or read (a verified preview, a file's text), whatever the view says */
  showing?: boolean
  /** the newest build held on the person or the hive that this page does not show (left by Make something else) */
  held?: { sentence: string } | null
  /** the words in the change box */
  words?: string
  /** a change or a put-back is on its way */
  revising?: boolean
  /** the apps the person made, offered on the empty canvas to change */
  made?: PlanSummary[]
}
export interface PlanComposed { screen: PlanScreen; data: Record<string, unknown>; facts: ScreenFacts }

const READY = new Set(['ready_to_deploy', 'deploying', 'deployed'])
/** statuses that wait on something outside the plan (the person, a free assignee, the hive): said in the head */
const HELD = new Set(['needs_you', 'engine_error', 'assignee_unavailable'])
/** a round that is over: deployed, or stopped */
const SETTLED = new Set(['deployed', 'stopped'])

/** A later round is in flight: it changes the installed app in place, from its planning to its deploy (or its stop). */
export const changing = (view: PlanView): boolean => view.round > 1 && !SETTLED.has(view.status)

/**
 * The screen for where the plan stands: none yet (the sentence), at work, or ready (and after its deploy). An installed
 * app stays on the ready screen, at its current version, unless a later round is at work on it.
 */
export function planScreen(view: PlanView | null, opening = false): PlanScreen {
  if (!view) return opening ? 'plan' : 'plan-start'
  if (READY.has(view.status)) return 'plan-ready'
  if (changing(view)) return 'plan'
  return view.installed ? 'plan-ready' : 'plan'
}

/** When something happened, in a few words: "19 Nov, 11:40"; nothing for a time it can't read. */
function when(iso: string): string {
  const t = Date.parse(iso)
  if (!iso || !Number.isFinite(t)) return ''
  return `${new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${clockTime(iso)}`
}

/** One version's line under the app: "Version 2 · deployed 19 Nov, 11:40", and what it was made from when that wasn't the
 * version just before it (a change made after an undo). */
function revisionMeta(r: PlanRevision): string {
  const at = when(r.deployed_at)
  const from = r.from !== null && r.from !== r.round - 1 ? ` · made from version ${r.from}` : ''
  return `Version ${r.round}${at ? ` · deployed ${at}` : ''}${from}`
}

export function planFacts(view: PlanView | null, ui: PlanUi, compose: Compose): PlanComposed {
  const open = view ? openQuestions(view).length : 0
  const answered = view ? view.questions.filter((q) => q.answered).length : 0
  const action = (name: string) => view?.actions.find((a) => a.name === name)
  const stop = action('stop')
  const revise = action('revise')
  const undo = action('undo')
  const revert = action('revert')
  const later = !!view && changing(view)
  // finished: nothing more is built unless the person asks for a change (an installed app at rest, or a stopped round:
  // planModel.planEnded, which a later round at work on the installed app is not)
  const ended = !!view && planEnded(view)
  const live = !!view && (!!ui.showing || !!view.checkpoint || !!view.preview || !!codeTarget(view))
  const words = ui.words ?? ''
  const flags = {
    'can.plan': ui.can,
    'start.busy': ui.starting,
    'plan.stopped': view?.status === 'stopped',
    'plan.blocked': !!view && HELD.has(view.status),
    'plan.waiting': !!view?.waiting && !ended,
    'plan.installed': !!view?.installed,
    'plan.live': live,
    'plan.unreviewed': !!view?.unreviewed,
    'plan.changing': later,
    'can.stop': !!stop?.available && !ended,
    'stop.asking': ui.stopAsking,
    'plan.leavable': !!view && isHeld(view) && !ended,
    'plan.held': !view && !!ui.held,
    // the hive changes a made app in place: the change box is there; held while it can't take a change now
    'can.revise': !!revise,
    'revise.refused': !!revise && !revise.available,
    'can.undo': !!undo?.available && undo.round !== undefined,
  }
  const current = view?.revisions.find((r) => r.current) ?? null
  const rows = (view?.revisions ?? []).map((r) => ({
    id: `r${r.round}`,
    plan: compose('plan-revision', { flags: { 'rev.current': r.current, 'can.revert': !!revert?.available } }),
    data: { 'rev.title': r.words ? `“${r.words}”` : `Version ${r.round}`, 'rev.meta': revisionMeta(r), 'rev.round': r.round },
    // a change or a put-back on its way holds every row's own controls
    busy: !!ui.revising,
  }))
  // the apps the person made, each its own row to open and change (on the empty canvas only), named by the app's name;
  // the sentence it began from, quoted, only when the hive gives no name
  const made = (view ? [] : ui.made ?? []).map((p) => {
    const at = when(p.updated_at)
    const title = p.title ?? (p.sentence ? `“${p.sentence}”` : 'An app you made')
    return {
      id: p.plan_id,
      plan: compose('plan-made', {}),
      data: { 'made.title': title, 'made.meta': at ? `Last changed ${at}` : '' },
    }
  })
  return {
    screen: planScreen(view, !!ui.opening),
    facts: {
      counts: { pieces: view?.pieces.length ?? 0, 'questions.open': open, 'questions.answered': answered, revisions: rows.length, made: made.length },
      flags,
      values: { start: ui.startError ? 'failed' : 'idle' },
    },
    data: {
      ...flags,
      'plan.sentence': view?.sentence ?? '',
      'plan.status': view?.status_line ?? '',
      'start.error': ui.startError ?? '',
      'held.sentence': ui.held?.sentence ?? '',
      'installed.name': view?.installed?.name ?? '',
      'waiting.name': view?.waiting?.name ?? '',
      'waiting.message': view?.waiting?.message ?? '',
      'round.words': view?.round_words ? `“${view.round_words}”` : '',
      'revise.words': words,
      // the Change button waits while there are no words, a change is on its way, or the hive can't take one now
      'revise.held': !words.trim() || !!ui.revising || !revise?.available,
      'revise.busy': !!ui.revising,
      'revise.why_not': revise && !revise.available ? revise.why_not ?? "It can't take a change just now." : '',
      'revisions.rows': rows,
      'revisions.current': current ? `r${current.round}` : '',
      'undo.round': undo?.round ?? '',
      'made.rows': made,
    },
  }
}
