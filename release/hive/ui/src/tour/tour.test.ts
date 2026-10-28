import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAPTERS } from './chapters'
import { estimateMs, GAP_MS, initialState, reduceTour, SPEECH_START_TIMEOUT, TourRunner, type ChapterLike, type SpeakHandlers, type SpeechPort, type TourState } from './machine'
import { restoreSnapshot, takeSnapshot, type RestorableState, type RestoreEnv } from './restore'
import { englishVoices, pickVoice, voiceScore } from './speech'

const chapters: ChapterLike[] = [
  { id: 'a', title: 'A', beats: [{ text: 'one two three' }, { text: 'four five' }] },
  { id: 'b', title: 'B', beats: [{ text: 'six' }] },
  { id: 'c', title: 'C', beats: [{ text: 'seven eight' }, { text: 'nine' }, { text: 'ten' }] },
]

const done = (s: TourState) => reduceTour(chapters, s, { type: 'beatDone', token: s.token })

describe('tour state machine: sequencing', () => {
  it('walks every beat of every chapter in order, then ends', () => {
    let s = initialState(chapters)
    const seen: string[] = []
    while (s.status === 'playing') {
      seen.push(`${chapters[s.chapter].id}${s.beat}`)
      s = done(s)
    }
    expect(seen).toEqual(['a0', 'a1', 'b0', 'c0', 'c1', 'c2'])
    expect(s.status).toBe('ended')
  })

  it('ignores a late beatDone from an older beat', () => {
    const s = initialState(chapters)
    const stale = { type: 'beatDone' as const, token: s.token - 1 }
    expect(reduceTour(chapters, s, stale)).toBe(s)
    const paused = reduceTour(chapters, s, { type: 'pause' })
    expect(reduceTour(chapters, paused, { type: 'beatDone', token: paused.token })).toBe(paused)
  })

  it('next / prev / goto jump between chapters at their first beat', () => {
    let s = initialState(chapters)
    s = reduceTour(chapters, s, { type: 'next' })
    expect([s.chapter, s.beat]).toEqual([1, 0])
    s = reduceTour(chapters, s, { type: 'goto', chapter: 2 })
    s = done(s)
    expect([s.chapter, s.beat]).toEqual([2, 1])
    // mid-chapter, prev restarts the chapter; at its start, it goes back one
    s = reduceTour(chapters, s, { type: 'prev' })
    expect([s.chapter, s.beat]).toEqual([2, 0])
    s = reduceTour(chapters, s, { type: 'prev' })
    expect([s.chapter, s.beat]).toEqual([1, 0])
    // next on the last chapter ends the tour
    s = reduceTour(chapters, reduceTour(chapters, s, { type: 'goto', chapter: 2 }), { type: 'next' })
    expect(s.status).toBe('ended')
  })

  it('"Show me" plays one chapter and ends', () => {
    let s = initialState(chapters, { chapter: 'c', only: true })
    expect(s.chapter).toBe(2)
    s = done(done(done(s)))
    expect(s.status).toBe('ended')
    expect(s.chapter).toBe(2)
  })

  it('pause, play, restart and mute keep the place; every change bumps the token', () => {
    let s = done(initialState(chapters))
    const t = s.token
    s = reduceTour(chapters, s, { type: 'toggle' })
    expect(s.status).toBe('paused')
    s = reduceTour(chapters, s, { type: 'toggle' })
    expect([s.status, s.chapter, s.beat]).toEqual(['playing', 0, 1])
    expect(s.token).toBeGreaterThan(t)
    s = reduceTour(chapters, s, { type: 'mute', muted: true })
    expect(s.voice).toBe('off')
    s = reduceTour(chapters, s, { type: 'restart' })
    expect([s.chapter, s.beat, s.status]).toEqual([0, 0, 'playing'])
  })

  it('once speech is unavailable, mute cannot turn it back on', () => {
    let s = reduceTour(chapters, initialState(chapters), { type: 'speechUnavailable' })
    expect(s.voice).toBe('unavailable')
    s = reduceTour(chapters, s, { type: 'mute', muted: false })
    expect(s.voice).toBe('unavailable')
  })

  it('every chapter in the real script has a title and an id', () => {
    expect(CHAPTERS.length).toBeGreaterThanOrEqual(9)
    expect(CHAPTERS.length).toBeLessThanOrEqual(11)
    expect(new Set(CHAPTERS.map((c) => c.id)).size).toBe(CHAPTERS.length)
  })
})

describe('tour runner: timing fallback', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const run = (speech: SpeechPort | null, rate = 1) => {
    const narrated: string[] = []
    let ended = false
    const states: TourState[] = []
    const r = new TourRunner(
      {
        chapters,
        speech,
        prepare: async () => undefined,
        onState: (s) => states.push(s),
        onNarrate: (c, b) => narrated.push(`${chapters[c].id}${b}`),
        onEnded: () => (ended = true),
      },
      initialState(chapters, { rate }),
    )
    r.start()
    return { r, narrated, states, isEnded: () => ended }
  }

  it('without speech, runs the whole tour on reading-time estimates', async () => {
    const { narrated, isEnded, r } = run(null)
    expect(r.state.voice).toBe('unavailable')
    const total = chapters.flatMap((c) => c.beats).reduce((n, b) => n + estimateMs(b.text), 0)
    await vi.advanceTimersByTimeAsync(total - 50)
    expect(isEnded()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(isEnded()).toBe(true)
    expect(narrated).toEqual(['a0', 'a1', 'b0', 'c0', 'c1', 'c2'])
  })

  it('speeds up with the rate', async () => {
    const { isEnded } = run(null, 2)
    const total = chapters.flatMap((c) => c.beats).reduce((n, b) => n + estimateMs(b.text, 2), 0)
    await vi.advanceTimersByTimeAsync(total + 100)
    expect(isEnded()).toBe(true)
  })

  it('with speech, advances on each utterance end', async () => {
    const spoken: string[] = []
    const speech: SpeechPort = {
      speak(text, _rate, h) {
        spoken.push(text)
        setTimeout(() => h.onStart(), 10)
        setTimeout(() => h.onEnd(), 300)
      },
      cancel: () => undefined,
    }
    const { isEnded, r } = run(speech)
    await vi.advanceTimersByTimeAsync((300 + GAP_MS) * 6 + 100)
    expect(isEnded()).toBe(true)
    expect(spoken).toHaveLength(6)
    expect(r.state.voice).toBe('on')
  })

  it('falls back to timings when speech errors', async () => {
    const speech: SpeechPort = {
      speak: (_t, _r, h: SpeakHandlers) => setTimeout(() => h.onError('synthesis-failed'), 5),
      cancel: () => undefined,
    }
    const { isEnded, r } = run(speech)
    await vi.advanceTimersByTimeAsync(20)
    expect(r.state.voice).toBe('unavailable')
    const total = chapters.flatMap((c) => c.beats).reduce((n, b) => n + estimateMs(b.text), 0)
    await vi.advanceTimersByTimeAsync(total + 200)
    expect(isEnded()).toBe(true)
  })

  it('falls back when speech never starts (blocked autoplay, empty voice list)', async () => {
    const speech: SpeechPort = { speak: () => undefined, cancel: () => undefined }
    const { isEnded, r } = run(speech)
    await vi.advanceTimersByTimeAsync(SPEECH_START_TIMEOUT + 10)
    expect(r.state.voice).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(isEnded()).toBe(true)
  })

  it('a missing end event never stalls the tour (watchdog)', async () => {
    const speech: SpeechPort = { speak: (_t, _r, h) => setTimeout(() => h.onStart(), 5), cancel: () => undefined }
    const { isEnded } = run(speech)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(isEnded()).toBe(true)
  })

  it('pausing stops the clock; playing re-runs the current beat', async () => {
    const { r, narrated } = run(null)
    await vi.advanceTimersByTimeAsync(estimateMs('one two three') + 10)
    expect(r.state.beat).toBe(1)
    r.dispatch({ type: 'pause' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect([r.state.chapter, r.state.beat, r.state.status]).toEqual([0, 1, 'paused'])
    r.dispatch({ type: 'play' })
    await vi.advanceTimersByTimeAsync(10)
    expect(narrated.slice(-1)).toEqual(['a1'])
    r.destroy()
  })
})

describe('tour restore', () => {
  function fakeEnv(hash: string, state: RestorableState, store: Record<string, string>) {
    const env: RestoreEnv & { hash: string; state: RestorableState; store: Record<string, string> } = {
      hash,
      state,
      store,
      getHash: () => env.hash,
      replaceHash: (h) => (env.hash = h),
      getState: () => env.state,
      setState: (p) => (env.state = { ...env.state, ...p }),
      storage: {
        keys: () => Object.keys(env.store),
        get: (k) => env.store[k] ?? null,
        set: (k, v) => (env.store[k] = v),
        remove: (k) => delete env.store[k],
      },
    }
    return env
  }

  it('puts the route, overlays, program sessions and touched storage back', () => {
    const mine = { trail: ['mine'] }
    const env = fakeEnv('#/lab', { paletteOpen: false, stopAllOpen: false, programSessions: { 'p\u0000s': mine } }, {
      'omegadots.program.trail.p/s': '[mine]',
      'omegadots.intro.welcome.v1': 'tour',
    })
    const snap = takeSnapshot(env)
    // the tour wanders off
    env.hash = '#/program/contract-fixture/s_lyra'
    env.state = { paletteOpen: true, stopAllOpen: true, programSessions: { 'p\u0000s': { trail: ['tour'] }, 'q\u0000s': {} } }
    env.store['omegadots.program.trail.p/s'] = '[tour]'
    env.store['omegadots.program.trail.q/s'] = '[tour]'
    env.store['omegadots.program.swarm.q'] = 's'
    restoreSnapshot(env, snap)
    expect(env.hash).toBe('#/lab')
    expect(env.state).toEqual({ paletteOpen: false, stopAllOpen: false, programSessions: { 'p\u0000s': mine } })
    expect(env.store).toEqual({ 'omegadots.program.trail.p/s': '[mine]', 'omegadots.intro.welcome.v1': 'tour' })
  })

  it('returns to the requested place (the demo opens on the Lab after the welcome)', () => {
    const env = fakeEnv('#/', { paletteOpen: false, stopAllOpen: false, programSessions: {} }, {})
    const snap = takeSnapshot(env, '#/lab')
    env.hash = '#/goals'
    restoreSnapshot(env, snap)
    expect(env.hash).toBe('#/lab')
  })

  it('survives storage that throws', () => {
    const env = fakeEnv('#/', { paletteOpen: false, stopAllOpen: false, programSessions: {} }, {})
    env.storage.keys = () => {
      throw new Error('SecurityError')
    }
    const snap = takeSnapshot(env)
    env.hash = '#/lab'
    expect(() => restoreSnapshot(env, snap)).not.toThrow()
    expect(env.hash).toBe('#/')
  })
})

describe('voice choice', () => {
  const v = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) => ({ name, lang, voiceURI: name, localService: true, default: false, ...extra }) as SpeechSynthesisVoice
  it('prefers natural English voices and skips novelty ones', () => {
    const list = [v('Albert', 'en-US'), v('Thomas', 'fr-FR'), v('Google US English', 'en-US'), v('Microsoft Aria Online (Natural)', 'en-US'), v('Fred', 'en-US')]
    expect(englishVoices(list).map((x) => x.name)[0]).toBe('Microsoft Aria Online (Natural)')
    expect(englishVoices(list).some((x) => x.lang.startsWith('fr'))).toBe(false)
    expect(voiceScore(v('Albert', 'en-US'))).toBeLessThan(0)
    expect(pickVoice(list, 'Fred')?.name).toBe('Fred')
    expect(pickVoice([], null)).toBeNull()
  })
})
