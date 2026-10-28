/**
 * The showreel's state machine (pure, tested). It plays the playlist (scenes.ts PLAYLIST) step by step, and loops when
 * asked. The person always wins:
 *  - their own mouse, keyboard or touch on the page is a TAKE-OVER: it stops where it is and says "You took over";
 *  - typing or speaking into the Ask is a PAUSE (status `paused`, reason `ask`): it waits for "Carry on";
 *  - opening the layers of "how" pauses it too (reason `layers`), and so does the guided caption's own Pause.
 * Every (re)start of a step bumps `token`, so a step superseded part way (paused, skipped, stopped) does nothing more.
 */
export type ReelStatus = 'idle' | 'playing' | 'paused' | 'took-over' | 'ended'
export type ReelPause = 'ask' | 'layers' | 'person'

export interface Reel {
  status: ReelStatus
  /** the playlist index now */
  at: number
  total: number
  loop: boolean
  token: number
  paused?: ReelPause
  /** how many times it has gone round */
  rounds: number
}

export type ReelEvent =
  | { type: 'start'; total: number; loop?: boolean }
  | { type: 'done'; token: number }
  | { type: 'pause'; why: ReelPause }
  | { type: 'resume' }
  | { type: 'takeover' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; at: number }
  | { type: 'loop'; on: boolean }
  | { type: 'stop' }

export const IDLE: Reel = { status: 'idle', at: 0, total: 0, loop: true, token: 0, rounds: 0 }

/** Still showing (playing, paused, or stopped where the person took over): the Ask answers about its step. */
export const active = (r: Reel): boolean => r.status === 'playing' || r.status === 'paused' || r.status === 'took-over'

const play = (r: Reel, at: number): Reel => ({ ...r, status: 'playing', at, paused: undefined, token: r.token + 1 })

export function reduceReel(r: Reel, e: ReelEvent): Reel {
  switch (e.type) {
    case 'start':
      return e.total > 0 ? { status: 'playing', at: 0, total: e.total, loop: e.loop ?? r.loop, token: r.token + 1, rounds: 0 } : { ...IDLE, token: r.token + 1 }
    case 'done':
      // a step finished playing (its dwell ran out): the next one, round again, or the end
      if (r.status !== 'playing' || e.token !== r.token) return r
      if (r.at < r.total - 1) return play(r, r.at + 1)
      return r.loop ? { ...play(r, 0), rounds: r.rounds + 1 } : { ...r, status: 'ended', token: r.token + 1 }
    case 'pause':
      // a take-over is not undone by typing into the Ask afterwards; the person carries on when they choose
      return r.status === 'playing' || (r.status === 'paused' && r.paused !== e.why) ? { ...r, status: 'paused', paused: e.why, token: r.token + 1 } : r
    case 'resume':
      // the step plays again from its start: its page may have changed meanwhile
      return r.status === 'paused' || r.status === 'took-over' ? play(r, r.at) : r
    case 'takeover':
      return r.status === 'playing' || r.status === 'paused' ? { ...r, status: 'took-over', paused: undefined, token: r.token + 1 } : r
    case 'next':
      if (!active(r)) return r
      return r.at < r.total - 1 ? play(r, r.at + 1) : r.loop ? play(r, 0) : { ...r, status: 'ended', token: r.token + 1 }
    case 'back':
      return active(r) ? play(r, Math.max(0, r.at - 1)) : r
    case 'goto':
      return active(r) && Number.isInteger(e.at) && e.at >= 0 && e.at < r.total ? play(r, e.at) : r
    case 'loop':
      return { ...r, loop: e.on }
    case 'stop':
      return r.status === 'idle' || r.status === 'ended' ? r : { ...r, status: 'ended', paused: undefined, token: r.token + 1 }
  }
}

/** How long a shown step stays: time to read its caption (or hear it), never under 4.5 s. */
export const dwellMs = (text: string): number => Math.max(4500, Math.min(12000, 1500 + text.length * 50))
