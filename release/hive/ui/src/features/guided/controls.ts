/**
 * The guided demo's controls and what a screen reader hears, as plain functions (GuideLayer renders them; tests call
 * them). Every control is the person's act (store personAct): the conductor yields first, then the demo follows.
 */
import type { KeyboardEvent } from 'react'
import { BANKED_QUALIFICATION } from './banked'
import { fill } from './driver'
import { personAct, useGuide, type GuideRun, type PersonAct } from './store'

type DemoRun = Extract<GuideRun, { kind: 'demo' }>

/** a step that waits for the person, now waiting */
export const yourTurn = (run: DemoRun) => run.m.status === 'running' && run.script.steps[run.m.step]?.wait?.for === 'you'

/** One of the demo's controls: its label, what it does (always the person's act), and its key. */
export interface GuideButton {
  label: string
  act: PersonAct
  tone?: 'primary' | 'quiet'
  disabled?: boolean
  pressed?: boolean
  keys?: string
}

/** The demo's buttons for where it stands (the same list renders the caption, the thread card and the tests). */
export function guideButtons(run: DemoRun): GuideButton[] {
  const { m } = run
  if (m.status === 'ended')
    return [
      { label: 'Back to where you were', act: 'backToStart', tone: 'primary' },
      { label: 'Play again', act: 'restart' },
      { label: 'Close', act: 'close' },
    ]
  return [
    { label: 'Back', act: 'back', disabled: m.step === 0, keys: 'ArrowLeft' },
    { label: m.status === 'paused' ? 'Resume' : 'Pause', act: 'toggle', pressed: m.status === 'paused', keys: 'Space' },
    { label: m.step >= m.total - 1 ? 'Finish' : 'Next', act: 'next', tone: 'primary', keys: 'ArrowRight' },
    { label: 'Stop', act: 'stop', tone: 'quiet', keys: 'Escape' },
  ]
}

/** Keys while focus is in the demo's own controls: ← Back, → Next, Space pause, Esc stop. */
export function guideKeys(e: Pick<KeyboardEvent<HTMLElement>, 'key' | 'target' | 'preventDefault'>) {
  const g = useGuide.getState()
  if (g.run?.kind !== 'demo') {
    if (e.key === 'Escape' && g.run) {
      e.preventDefault()
      g.close()
    }
    return
  }
  const onButton = e.target instanceof HTMLElement && /^(BUTTON|INPUT)$/.test(e.target.tagName)
  const ev = e.key === 'ArrowRight' ? 'next' : e.key === 'ArrowLeft' ? 'back' : e.key === ' ' && !onButton ? 'toggle' : e.key === 'Escape' ? 'stop' : null
  if (!ev) return
  e.preventDefault()
  personAct(ev)
}

/**
 * What a screen reader hears: each step once it is shown, and a pause, a takeover or the end. A banked step is never
 * heard as a result: its qualification ("banked / synthetic, not run now", executed now: false) comes first. Under a
 * modal the demo is hidden and inert, so nothing of it is announced over the dialog.
 */
export function announcement(run: GuideRun | null, underModal: boolean): string {
  if (!run || underModal) return ''
  if (run.kind === 'answer') return run.text
  const step = run.script.steps[run.m.step]
  const where = `${run.script.title}, step ${run.m.step + 1} of ${run.m.total}${step?.banked ? ` (${BANKED_QUALIFICATION})` : ''}`
  if (yourTurn(run)) return `${where}, your turn: ${fill(step.say, run.picks)}`
  if (run.m.status === 'ready') return `${where}: ${run.said[run.m.step] ?? ''}${run.note ? ` ${run.note}` : ''}`
  if (run.m.status === 'paused') return run.m.paused === 'took-over' ? 'Demo paused: you took over. Resume or Next to carry on.' : run.m.paused === 'ask' ? 'Demo paused while you type in the Ask. Resume or Next to carry on.' : 'Demo paused.'
  if (run.m.status === 'ended') return run.m.ended === 'done' ? 'Demo finished.' : 'Demo stopped.'
  return ''
}
