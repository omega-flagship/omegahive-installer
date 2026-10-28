import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, SKIP_MS, TourRunner, type SpeechPort } from './machine'
import { beatPreparer, SKIP_NOTE, type PrepareDeps, type ReportRow } from './prepare'
import { buildChapters, type Chapter, type Target, type TourCtx } from './script'
import type { Store } from '../store/store'

/**
 * followups-r6 item 5 (Kimi r5 #9): `waitFor` returns null when its element never shows. The tour now handles that
 * honestly: a beat whose subject is not on screen is skipped with a visible note (SKIP_NOTE), nothing is narrated over
 * it, and the tour moves on; it never crashes or hangs. INVENTED, empty data only.
 */

/** A store with nothing in it: no swarms, minds, beliefs, tasks or apps (every target the script picks is absent). */
function emptyStore(): Store {
  const noop = () => undefined
  return { swarms: {}, agents: {}, beliefs: {}, goals: {}, programs: [], programSessions: {}, stopAllOpen: false, paletteOpen: false, client: null, setStopAll: noop, setPalette: noop, programGo: noop, programSelect: noop, programBack: noop } as unknown as Store
}

function fakeCtx(waited: string[]): TourCtx {
  return {
    mobile: false,
    sim: true,
    store: emptyStore,
    go: () => undefined,
    sleep: async () => undefined,
    find: () => null,
    // the real waitFor gives up after `ms` and returns null: here at once
    waitFor: async (name) => { waited.push(name); return null },
    freshProgram: () => undefined,
    scene: { overview: () => undefined, dot: () => null, core: () => null },
  }
}

/** The player's side, faked: which targets are on screen, and what the player was told. */
function deps(chapters: Chapter[], onScreen: Set<string>, waited: string[] = []) {
  const did: string[] = []
  const rows: ReportRow[] = []
  let target: Target | null = null
  const d: PrepareDeps = {
    chapters,
    ctx: fakeCtx(waited),
    reduced: true,
    resolve: async (t) => (typeof t === 'string' && onScreen.has(t) ? { x: 10, y: 10, w: 40, h: 20 } : null),
    reveal: async () => undefined,
    setTarget: (t) => { target = t; did.push(`target ${typeof t === 'string' ? t : t ? 'fn' : 'none'}`) },
    hasTarget: () => target !== null,
    click: () => did.push('click'),
    begin: (row) => rows.push(row),
  }
  return { d, did, rows }
}

const chapter = (beats: Chapter['beats'], setup: Chapter['setup'] = () => undefined): Chapter => ({ id: 'x', title: 'X', blurb: 'x', setup, beats })
const live = () => true

describe('item 5: a beat whose subject is not on screen is skipped, with a note', () => {
  it('its show target never appears: skipped (SKIP_NOTE), reported as skipped, no spotlight left on', async () => {
    const ch = [chapter([{ text: 'Amber cards are waiting on you.', show: 'goal-waiting' }])]
    const { d, did, rows } = deps(ch, new Set())
    expect(await beatPreparer(d)(0, 0, false, live)).toEqual({ skip: SKIP_NOTE })
    expect(rows[0]).toMatchObject({ skipped: true, targets: [{ name: 'goal-waiting', found: false }] })
    expect(did.at(-1)).toBe('target none')
  })
  it('it is there: the beat narrates, spotlighting it (no skip)', async () => {
    const ch = [chapter([{ text: 'Amber cards are waiting on you.', show: 'goal-waiting' }])]
    const { d, did, rows } = deps(ch, new Set(['goal-waiting']))
    expect(await beatPreparer(d)(0, 0, false, live)).toBeUndefined()
    expect(rows[0].skipped).toBeUndefined()
    expect(did.at(-1)).toBe('target goal-waiting')
  })
  it('a beat that shows nothing on purpose (show: null) is never skipped', async () => {
    const ch = [chapter([{ text: 'This is your hive.', show: null }])]
    const { d } = deps(ch, new Set())
    expect(await beatPreparer(d)(0, 0, false, live)).toBeUndefined()
  })
  it('its pointer target is missing too: the beat’s own work still runs, then it is skipped (no click on nothing)', async () => {
    const ran: string[] = []
    const ch = [chapter([{ text: 'Rules choose allow, ask or deny.', point: 'approvals-tab-rules', do: () => void ran.push('do'), show: 'policy-rules' }])]
    const { d, did } = deps(ch, new Set())
    expect(await beatPreparer(d)(0, 0, false, live)).toEqual({ skip: SKIP_NOTE })
    expect(ran).toEqual(['do'])
    expect(did).not.toContain('click')
  })
  it('its pointer target is there: it narrates while the pointer clicks (as before)', async () => {
    const ch = [chapter([{ text: 'Rules choose allow, ask or deny.', point: 'approvals-tab-rules', show: 'policy-rules' }])]
    const { d, did } = deps(ch, new Set(['approvals-tab-rules', 'policy-rules']))
    const r = await beatPreparer(d)(0, 0, false, live)
    expect(r?.rest).toBeInstanceOf(Promise)
    await r!.rest
    expect(did).toContain('click')
  })
  it('a chapter setup whose waitFor timed out (null) does not throw: its beats are skipped one by one', async () => {
    const waited: string[] = []
    const ch = [chapter([{ text: 'Apps turn work into maps.', show: 'programs-list' }], async (ctx) => { await ctx.waitFor('programs-list', 4000) })]
    const { d } = deps(ch, new Set(), waited)
    expect(await beatPreparer(d)(0, 0, true, live)).toEqual({ skip: SKIP_NOTE })
    expect(waited).toEqual(['programs-list'])
  })
})

describe('item 5: the runner shows the note, says nothing, and moves on', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const chapters = [chapter([{ text: 'One.' }, { text: 'Two, not on screen.' }, { text: 'Three.' }])]

  it('a skipped beat: onSkip with the note, never narrated or spoken, and the next beat comes after SKIP_MS', async () => {
    const spoken: string[] = []
    const narrated: number[] = []
    const skipped: [number, string][] = []
    let ended = false
    const speech: SpeechPort = { speak: (text, _r, h) => { spoken.push(text); h.onStart(); setTimeout(() => h.onEnd(), 500) }, cancel: () => undefined }
    const r = new TourRunner(
      {
        chapters,
        speech,
        prepare: async (_c, b) => (b === 1 ? { skip: SKIP_NOTE } : undefined),
        onState: () => undefined,
        onNarrate: (_c, b) => narrated.push(b),
        onSkip: (_c, b, note) => skipped.push([b, note]),
        onEnded: () => (ended = true),
      },
      initialState(chapters),
    )
    r.start()
    await vi.advanceTimersByTimeAsync(500 + 380 + 10)   // beat 0 spoken, then the gap
    expect(skipped).toEqual([[1, SKIP_NOTE]])
    await vi.advanceTimersByTimeAsync(SKIP_MS - 50)
    expect(r.state.beat).toBe(1)                          // the note stays up for SKIP_MS
    await vi.advanceTimersByTimeAsync(100)
    expect(r.state.beat).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ended).toBe(true)
    expect(narrated).toEqual([0, 2])
    expect(spoken).toEqual(['One.', 'Three.'])
  })

  it('the real script with nothing on screen (every waitFor times out): it runs to the end, every beat with a subject skipped, none hangs', async () => {
    const waited: string[] = []
    const real = buildChapters(fakeCtx(waited))
    const { d, rows } = deps(real, new Set(), waited)
    let ended = false
    const skipped: string[] = []
    const r = new TourRunner(
      { chapters: real, speech: null, prepare: beatPreparer(d), onState: () => undefined, onSkip: (c, b) => skipped.push(`${real[c].id}${b}`), onEnded: () => (ended = true) },
      initialState(real),
    )
    r.start()
    const beats = real.flatMap((c) => c.beats)
    await vi.advanceTimersByTimeAsync(beats.length * 30_000)
    expect(ended).toBe(true)
    expect(rows.length).toBe(beats.length)
    // every beat that points at or shows something was skipped; the ones that show nothing on purpose narrated
    const withSubject = real.flatMap((c) => c.beats.map((b, i) => ({ id: `${c.id}${i}`, subject: (b.show === undefined ? b.point : b.show) != null })))
    expect(skipped).toEqual(withSubject.filter((x) => x.subject).map((x) => x.id))
    expect(waited.length).toBeGreaterThan(0)
  })
})
