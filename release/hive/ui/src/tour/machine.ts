/**
 * The tour's state machine, kept pure so it can be tested: which chapter and beat are playing, and how
 * the next one is reached. A beat is one narrated sentence with its pointer move and spotlight. The
 * runner below drives beats with speech when it works and with timings when it does not.
 */

export interface BeatLike {
  text: string
}
export interface ChapterLike {
  id: string
  title: string
  beats: BeatLike[]
}

export type TourStatus = 'playing' | 'paused' | 'ended'
/** on: speaking · off: muted by the person (captions only) · unavailable: no speech here (captions only). */
export type VoiceMode = 'on' | 'off' | 'unavailable'

export interface TourState {
  chapter: number
  beat: number
  status: TourStatus
  voice: VoiceMode
  rate: number
  /** Play only this chapter, then end ("Show me"). */
  only: number | null
  /** Bumps whenever a beat (re)starts, so late callbacks from an older beat are ignored. */
  token: number
}

export type TourEvent =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; chapter: number }
  | { type: 'restart' }
  | { type: 'beatDone'; token: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'speechUnavailable' }
  | { type: 'rate'; rate: number }

export const RATES = [0.75, 1, 1.25, 1.5, 2] as const

export function initialState(chapters: ChapterLike[], opts: { chapter?: string; only?: boolean; voice?: VoiceMode; rate?: number } = {}): TourState {
  const found = opts.chapter ? chapters.findIndex((c) => c.id === opts.chapter) : 0
  const chapter = Math.max(0, found)
  return { chapter, beat: 0, status: 'playing', voice: opts.voice ?? 'on', rate: opts.rate ?? 1, only: opts.only ? chapter : null, token: 1 }
}

const at = (s: TourState, chapter: number, beat = 0): TourState => ({ ...s, chapter, beat, status: s.status === 'ended' ? 'playing' : s.status, token: s.token + 1 })

export function reduceTour(chapters: ChapterLike[], s: TourState, e: TourEvent): TourState {
  const last = chapters.length - 1
  switch (e.type) {
    case 'play':
      if (s.status === 'ended') return { ...at(s, s.only ?? 0), status: 'playing' }
      return s.status === 'playing' ? s : { ...s, status: 'playing', token: s.token + 1 }
    case 'pause':
      return s.status === 'playing' ? { ...s, status: 'paused', token: s.token + 1 } : s
    case 'toggle':
      return reduceTour(chapters, s, { type: s.status === 'playing' ? 'pause' : 'play' })
    case 'beatDone': {
      if (e.token !== s.token || s.status !== 'playing') return s
      const beats = chapters[s.chapter]?.beats.length ?? 0
      if (s.beat + 1 < beats) return { ...s, beat: s.beat + 1, token: s.token + 1 }
      if (s.only !== null || s.chapter >= last) return { ...s, status: 'ended', token: s.token + 1 }
      return { ...s, chapter: s.chapter + 1, beat: 0, token: s.token + 1 }
    }
    case 'next':
      if (s.only !== null || s.chapter >= last) return { ...s, status: 'ended', token: s.token + 1 }
      return at(s, s.chapter + 1)
    case 'prev':
      // mid-chapter: back to its start; at a chapter's start: the one before
      if (s.beat > 0 || s.only !== null || s.chapter === 0) return at(s, s.chapter)
      return at(s, s.chapter - 1)
    case 'goto':
      return at({ ...s, only: s.only === null ? null : e.chapter }, Math.max(0, Math.min(last, e.chapter)))
    case 'restart':
      return { ...at(s, s.only ?? 0), status: 'playing' }
    case 'mute':
      if (s.voice === 'unavailable') return s
      return { ...s, voice: e.muted ? 'off' : 'on', token: s.token + 1 }
    case 'speechUnavailable':
      // keep the beat running on timings; no restart
      return { ...s, voice: 'unavailable' }
    case 'rate':
      return { ...s, rate: e.rate }
  }
}

/** How long a caption stays up without speech: about speaking pace (2.8 words a second), scaled by the speed setting. */
export function estimateMs(text: string, rate = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.round(Math.max(1500, (words / 2.8) * 1000 + 350) / rate)
}

/** A chapter's length as played: its sentences, the gaps between them, and a moment to set the view up. */
export function chapterMs(c: ChapterLike, rate = 1): number {
  return c.beats.reduce((n, b) => n + estimateMs(b.text, rate) + GAP_MS / rate, 900 / rate)
}

// ---------------------------------------------------------------- runner

export interface SpeakHandlers {
  onStart(): void
  onEnd(): void
  onError(code: string): void
  onBoundary?(charIndex: number): void
}

/** What the runner needs from speechSynthesis (or a fake in tests). */
export interface SpeechPort {
  speak(text: string, rate: number, h: SpeakHandlers): void
  cancel(): void
}

/**
 * Narration may start before the beat's UI work is done (the pointer glides while it speaks); `rest` finishes it.
 * `skip`: the beat's subject is not on screen; this note shows instead of the sentence, then the tour moves on
 * (followups-r6: a target that never appears is said, never narrated over and never waited on for ever).
 */
export interface PrepareResult {
  rest?: Promise<void>
  skip?: string
}

export interface RunnerEnv<C extends ChapterLike> {
  chapters: C[]
  /** null when the browser has no speechSynthesis. */
  speech: SpeechPort | null
  /**
   * Put the UI in place for a beat (route, pointer, spotlight). Resolves when it is ready to narrate.
   * `fresh` is true on a chapter's first beat: run the chapter's setup too.
   */
  prepare(chapter: number, beat: number, fresh: boolean, isCurrent: () => boolean): Promise<PrepareResult | void>
  onState(s: TourState): void
  /** The beat's sentence starts now (spoken or timed): show its caption. */
  onNarrate?(chapter: number, beat: number): void
  /** The beat is skipped (its subject is not on screen): show this note instead of its caption, for SKIP_MS. */
  onSkip?(chapter: number, beat: number, note: string): void
  onBoundary?(charIndex: number): void
  /** The tour ended by itself (last beat done). */
  onEnded?(): void
}

/** Pause between beats, so sentences do not run together. */
export const GAP_MS = 380
/** How long a skipped beat's note stays up (scaled by the speed setting) before the tour moves on. */
export const SKIP_MS = 2400
/** If speech has not started by then, the browser is not going to speak: switch to captions. */
export const SPEECH_START_TIMEOUT = 2200

/**
 * Drives beats: prepare the UI, then speak the sentence (advancing on the utterance's end event) or,
 * without speech, wait for its estimated reading time. A watchdog always advances, so a missing `end`
 * event never stalls the tour.
 */
export class TourRunner<C extends ChapterLike> {
  state: TourState
  private env: RunnerEnv<C>
  private timers: ReturnType<typeof setTimeout>[] = []
  private dead = false

  constructor(env: RunnerEnv<C>, initial: TourState) {
    this.env = env
    this.state = env.speech ? initial : { ...initial, voice: 'unavailable' }
  }

  start(): void {
    this.env.onState(this.state)
    void this.run()
  }

  dispatch(e: TourEvent): void {
    if (this.dead) return
    const prev = this.state
    const next = reduceTour(this.env.chapters, prev, e)
    if (next === prev) return
    this.state = next
    this.env.onState(next)
    if (next.token !== prev.token) {
      this.clear()
      this.env.speech?.cancel()
      if (next.status === 'playing') void this.run()
      if (next.status === 'ended' && prev.status !== 'ended') this.env.onEnded?.()
    }
  }

  destroy(): void {
    this.dead = true
    this.clear()
    this.env.speech?.cancel()
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  private async run(): Promise<void> {
    const s = this.state
    const token = s.token
    const isCurrent = () => !this.dead && this.state.token === token && this.state.status === 'playing'
    let rest: Promise<void> = Promise.resolve()
    let skip: string | undefined
    try {
      // a chapter's first beat also sets up its view, so any chapter can be jumped to
      const r = await this.env.prepare(s.chapter, s.beat, s.beat === 0, isCurrent)
      if (r?.rest) rest = r.rest.catch(() => undefined)
      skip = r?.skip
    } catch {
      /* a missing element never stops the tour */
    }
    if (!isCurrent()) return
    const beat = this.env.chapters[s.chapter]?.beats[s.beat]
    if (!beat) return
    // its subject is not on screen: say so, nothing is spoken, and move on
    if (skip !== undefined) {
      this.env.onSkip?.(s.chapter, s.beat, skip)
      this.after(SKIP_MS / this.state.rate, () => this.dispatch({ type: 'beatDone', token }))
      return
    }
    // the next beat waits for both the sentence and this beat's UI work
    const advance = () => void rest.then(() => this.dispatch({ type: 'beatDone', token }))
    const done = () => {
      if (isCurrent()) this.after(GAP_MS / this.state.rate, advance)
    }
    const timed = (ms: number) => this.after(ms, advance)
    this.env.onNarrate?.(s.chapter, s.beat)
    const speech = this.env.speech
    if (!speech || this.state.voice !== 'on') return timed(estimateMs(beat.text, this.state.rate))

    const est = estimateMs(beat.text, this.state.rate)
    let started = false
    let finished = false
    const fallback = (remaining: number) => {
      if (finished) return
      finished = true
      speech.cancel()
      if (isCurrent()) timed(remaining)
    }
    // watchdog: some engines never fire `end`
    this.after(est * 2 + 4000, () => {
      if (!finished) {
        finished = true
        advance()
      }
    })
    this.after(SPEECH_START_TIMEOUT, () => {
      if (started || finished || !isCurrent()) return
      this.dispatch({ type: 'speechUnavailable' })
      fallback(Math.max(600, est - SPEECH_START_TIMEOUT))
    })
    speech.speak(beat.text, this.state.rate, {
      onStart: () => {
        started = true
      },
      onEnd: () => {
        if (finished || !isCurrent()) return
        finished = true
        done()
      },
      onError: (code) => {
        if (!isCurrent() || code === 'interrupted' || code === 'canceled') return
        this.dispatch({ type: 'speechUnavailable' })
        fallback(est)
      },
      onBoundary: (i) => {
        started = true
        if (isCurrent()) this.env.onBoundary?.(i)
      },
    })
  }
}
