import type { ScreenFacts } from '../../screens/screenSpace'
import type { PlanView } from './contract'
import { codeTarget, openQuestions } from './planModel'

/**
 * What the Make bench is told (plan.metta): which of its three screens is drawn, this moment's facts (counts, flags and
 * known symbols, never a person's words) from which MeTTa composes it, and the values its parts draw by path. Pure: the
 * page hands in the plan view (or none yet) and where its own controls stand.
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
}
export interface PlanComposed { screen: PlanScreen; data: Record<string, unknown>; facts: ScreenFacts }

const READY = new Set(['ready_to_deploy', 'deploying', 'deployed'])
/** statuses that wait on something outside the plan (the person, a free assignee, the hive): said in the head */
const HELD = new Set(['needs_you', 'engine_error', 'assignee_unavailable'])

/** The screen for where the plan stands: none yet (the sentence), at work, or ready (and after its deploy). */
export function planScreen(view: PlanView | null, opening = false): PlanScreen {
  if (!view) return opening ? 'plan' : 'plan-start'
  return READY.has(view.status) || view.installed ? 'plan-ready' : 'plan'
}

export function planFacts(view: PlanView | null, ui: PlanUi): PlanComposed {
  const open = view ? openQuestions(view).length : 0
  const answered = view ? view.questions.filter((q) => q.answered).length : 0
  const stop = view?.actions.find((a) => a.name === 'stop')
  const ended = !!view && (view.status === 'stopped' || view.status === 'deployed' || !!view.installed)
  const live = !!view && (!!ui.showing || !!view.checkpoint || !!view.preview || !!codeTarget(view))
  const flags = {
    'can.plan': ui.can,
    'start.busy': ui.starting,
    'plan.stopped': view?.status === 'stopped',
    'plan.blocked': !!view && HELD.has(view.status),
    'plan.installed': !!view?.installed,
    'plan.live': live,
    'plan.unreviewed': !!view?.unreviewed,
    'can.stop': !!stop?.available && !ended,
    'stop.asking': ui.stopAsking,
  }
  return {
    screen: planScreen(view, !!ui.opening),
    facts: {
      counts: { pieces: view?.pieces.length ?? 0, 'questions.open': open, 'questions.answered': answered },
      flags,
      values: { start: ui.startError ? 'failed' : 'idle' },
    },
    data: {
      ...flags,
      'plan.sentence': view?.sentence ?? '',
      'plan.status': view?.status_line ?? '',
      'start.error': ui.startError ?? '',
      'installed.name': view?.installed?.name ?? '',
    },
  }
}
