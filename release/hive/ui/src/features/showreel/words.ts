/**
 * What the Ask hears while the showreel shows (pure, tested). Every answer comes from the step's own script (its why,
 * what you are seeing, why it clicked), at 0 model calls. Anything else gets one plain line: model use stays off in
 * demo mode, so the Ask never guesses.
 */
import type { ShowStep } from './types'

export type Heard =
  | { kind: 'why' }
  | { kind: 'what' }
  | { kind: 'click' }
  | { kind: 'how' }
  | { kind: 'carry-on' }
  | { kind: 'pause' }
  | { kind: 'stop' }
  | { kind: 'next' }
  | { kind: 'back' }
  | { kind: 'other' }

export const OFF_SCRIPT = 'I can only explain this demo’s steps here.'
export const START_WORDS = /^(show me around|watch it run|play the showreel|run the showreel|demo yourself)$/

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[?!.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Words that start the showreel in demo mode ("show me around"). */
export const startsShowreel = (text: string): boolean => START_WORDS.test(norm(text))

export function hear(text: string): Heard {
  const t = norm(text)
  if (!t) return { kind: 'other' }
  if (/^(why did you (click|press|tap|open|pick|choose|do) (that|this|it)|what did you (click|press|tap)|why (that|this) (button|click))$/.test(t)) return { kind: 'click' }
  if (/^(why|why that|why this|why is that|why are you doing (that|this)|what for|what's the point|why does it do that)$/.test(t)) return { kind: 'why' }
  if (/^(what's that|what is that|what's this|what is this|what am i (looking at|seeing)|what are you (showing|doing)|what's happening)$/.test(t)) return { kind: 'what' }
  if (/^(how|how does (that|this|it) work|how does it do (that|this)|deeper|go deeper|show me more( about (this|that))?|tell me more|all the way down|how all the way down)$/.test(t)) return { kind: 'how' }
  if (/^(carry on|continue|go on|keep going|resume|play|ok carry on|okay carry on)$/.test(t)) return { kind: 'carry-on' }
  if (/^(pause|wait|hold on|hang on)$/.test(t)) return { kind: 'pause' }
  if (/^(stop|stop the demo|stop the showreel|end|that's enough|quit)$/.test(t)) return { kind: 'stop' }
  if (/^(next|skip|next step)$/.test(t)) return { kind: 'next' }
  if (/^(back|go back|previous|previous step)$/.test(t)) return { kind: 'back' }
  return { kind: 'other' }
}

/** The step's own answer to a why / what / click question. */
export function answerFor(kind: 'why' | 'what' | 'click', step: ShowStep): string {
  if (kind === 'what') return step.seeing
  if (kind === 'click') return step.click ?? step.why
  return step.why
}
