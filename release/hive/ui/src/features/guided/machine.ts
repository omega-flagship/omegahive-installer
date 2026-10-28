/**
 * The guided demo's state machine (pure, tested). A demo is a list of steps; each step is first `running` (its screen
 * action and its wait), then `ready` (shown, waiting for Next, or for auto-advance). The person can pause, go back,
 * go on or stop at any time; their own input on the page pauses it ("took over"); a change of session or sign-in
 * ends it ("fenced"), whatever its status (a finished or stopped demo is fenced too: stand-in r1 P1). Every (re)start of a step bumps `token`, so a late answer from an older step is ignored.
 */

export type GuideRunStatus = 'running' | 'ready' | 'paused' | 'ended'
export type EndReason = 'done' | 'stopped' | 'fenced'
/** `ask`: the person is typing in the Ask while the demo plays itself (guided-play) */
export type PauseReason = 'person' | 'took-over' | 'ask'

export interface GuideMachine {
  step: number
  total: number
  status: GuideRunStatus
  auto: boolean
  token: number
  paused?: PauseReason
  ended?: EndReason
}

export type GuideEvent =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'pause'; why?: 'ask' }
  | { type: 'resume' }
  | { type: 'toggle' }
  | { type: 'takeover' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'fenced' }
  | { type: 'ready'; token: number }
  | { type: 'tick'; token: number }
  | { type: 'auto'; on: boolean }
  /** the conductor's `tour.step`: place the demo at a step (played from its start) */
  | { type: 'goto'; step: number }

export function startMachine(total: number, auto = false, step = 0): GuideMachine {
  return { step: total > 0 ? Math.min(Math.max(0, step), total - 1) : 0, total, status: total > 0 ? 'running' : 'ended', auto, token: 1, ...(total > 0 ? {} : { ended: 'done' as const }) }
}

const at = (s: GuideMachine, step: number): GuideMachine => ({ step, total: s.total, status: 'running', auto: s.auto, token: s.token + 1 })

export function reduceGuide(s: GuideMachine, e: GuideEvent): GuideMachine {
  // an ended demo only restarts, or is fenced: a change of person ends what is still shown of it, finished or stopped
  if (s.status === 'ended' && e.type !== 'restart' && e.type !== 'fenced') return s
  switch (e.type) {
    case 'next':
      return s.step >= s.total - 1 ? { ...s, status: 'ended', ended: 'done', paused: undefined, token: s.token + 1 } : at(s, s.step + 1)
    case 'back':
      return at(s, Math.max(0, s.step - 1))
    case 'pause':
      return s.status === 'paused' ? s : { ...s, status: 'paused', paused: e.why ?? 'person', token: s.token + 1 }
    case 'takeover':
      return s.status === 'paused' ? s : { ...s, status: 'paused', paused: 'took-over', token: s.token + 1 }
    case 'resume':
      // the step is shown again from its start: its place may have changed while paused
      return s.status === 'paused' ? at(s, s.step) : s
    case 'toggle':
      return reduceGuide(s, { type: s.status === 'paused' ? 'resume' : 'pause' })
    case 'restart':
      return { ...at(s, 0), ended: undefined }
    case 'stop':
      return { ...s, status: 'ended', ended: 'stopped', paused: undefined, token: s.token + 1 }
    case 'fenced':
      return s.ended === 'fenced' ? s : { ...s, status: 'ended', ended: 'fenced', paused: undefined, token: s.token + 1 }
    case 'ready':
      return s.status === 'running' && e.token === s.token ? { ...s, status: 'ready' } : s
    case 'tick':
      return s.auto && s.status === 'ready' && e.token === s.token ? reduceGuide(s, { type: 'next' }) : s
    case 'auto':
      return { ...s, auto: e.on }
    case 'goto':
      // out of range is not guessed at; the step already shown (or on its way) is left as it is
      if (!Number.isInteger(e.step) || e.step < 0 || e.step >= s.total) return s
      return e.step === s.step && s.status !== 'paused' ? s : at(s, e.step)
  }
}

/** How long a shown step stays before auto-advance: time to read it (or hear it), never under 4 s. */
export const dwellMs = (text: string): number => Math.max(4000, Math.min(14000, 1200 + text.length * 55))
