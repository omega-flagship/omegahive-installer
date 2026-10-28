import { describe, expect, it } from 'vitest'
import {
  awaySummary,
  chipDestination,
  MOVE_SLOP,
  restAlertFor,
  restAllowed,
  restBlocked,
  restChips,
  restCounts,
  restInitial,
  restReducer,
  sceneLoops,
  TYPE_TARGETS,
  wakeFor,
  workingLine,
  type RestAction,
  type RestProbe,
  type RestView,
} from './rest'
import { blockDigits, clockParts, constellation, handAngles, sketchCircle, timeInWords } from './restClocks'
import { screenOf, INITIAL } from './machine'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const HERE = new URL('.', import.meta.url).pathname
const src = (p: string) => fs.readFileSync(`${HERE}${p}`, 'utf8')
const IDLE = 120_000
const run = (actions: RestAction[], from: RestView = restInitial(0)) => actions.reduce(restReducer, from)
const CLEAR: RestProbe = { hidden: false, modal: false, pointerDown: false, composing: false, draft: false }

describe('resting: the idle timer', () => {
  it('defaults to two minutes, and rests exactly at the idle time after the last input', () => {
    expect(src('rest.ts')).toMatch(/return \{ minutes: 2 \}/)
    const v = run([{ type: 'input', at: 1000 }])
    expect(run([{ type: 'tick', at: 1000 + IDLE - 1, idleMs: IDLE }], v).resting).toBe(false)
    expect(run([{ type: 'tick', at: 1000 + IDLE, idleMs: IDLE }], v).resting).toBe(true)
  })

  it('never starts during a dialog, a press or drag, a composition, words in a field, or a hidden tab', () => {
    expect(restBlocked(CLEAR)).toBe(false)
    for (const k of Object.keys(CLEAR) as (keyof RestProbe)[]) {
      const p = { ...CLEAR, [k]: true }
      expect(restBlocked(p), k).toBe(true)
      expect(run([{ type: 'tick', at: IDLE * 3, idleMs: IDLE, blocked: restBlocked(p) }]).resting, k).toBe(false)
    }
  })
})

describe('resting: waking, with no lost keystroke', () => {
  it('any key wakes; a printable key with nothing focused goes to the Ask', () => {
    expect(wakeFor({ type: 'keydown', key: 'h' }, null)).toMatchObject({ wake: true, typeIntoAsk: true })
    expect(wakeFor({ type: 'keydown', key: 'H' }, null).typeIntoAsk).toBe(true)
    // already typing in a field: the key goes there as it was going
    expect(wakeFor({ type: 'keydown', key: 'h', intoField: true }, null)).toMatchObject({ wake: true, typeIntoAsk: false })
    // shortcuts, and keys that type nothing, wake without moving focus
    expect(wakeFor({ type: 'keydown', key: 'k', mod: true }, null)).toMatchObject({ wake: true, typeIntoAsk: false })
    for (const key of ['Shift', 'Escape', 'Tab', 'Enter', 'ArrowDown', 'Process']) expect(wakeFor({ type: 'keydown', key }, null)).toMatchObject({ wake: true, typeIntoAsk: false })
  })

  it('a real pointer move wakes; a move that is not one (the layer appearing under a still pointer) does not', () => {
    const at = { x: 500, y: 300 }
    expect(wakeFor({ type: 'pointermove', x: 500, y: 300 }, at).wake).toBe(false)
    expect(wakeFor({ type: 'pointermove', x: 500 + MOVE_SLOP, y: 300 }, at).wake).toBe(false)
    expect(wakeFor({ type: 'pointermove', x: 500 + MOVE_SLOP + 1, y: 300 }, at).wake).toBe(true)
    expect(wakeFor({ type: 'pointermove', x: 1, y: 1 }, null).wake).toBe(false)
  })

  it('a press on the rest wakes at once behind a click shield (never lands on the page); elsewhere, a wheel, a touch wake at once', () => {
    expect(wakeFor({ type: 'pointerdown', onRest: true }, null)).toMatchObject({ wake: true, shield: true })
    expect(wakeFor({ type: 'touchstart', onRest: true }, null)).toMatchObject({ wake: true, shield: true })
    expect(wakeFor({ type: 'pointerdown', onRest: false }, null).wake).toBe(true)
    expect(wakeFor({ type: 'wheel' }, null).wake).toBe(true)
  })

  it('the host never consumes an input: passive capture listeners, no preventDefault or stopPropagation on them', () => {
    const host = src('RestScreen.tsx')
    expect(host).toMatch(/addEventListener\(n, on, \{ capture: true, passive: true \}\)/)
    const handler = host.slice(host.indexOf('const on = (e: Event)'), host.indexOf('INPUTS.forEach'))
    expect(handler).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation/)
    // the Ask is focused inside the same keydown, so this very key lands in it
    expect(handler).toMatch(/if \(d\.typeIntoAsk\) typeTarget\(\)\?\.focus/)
  })

  it('typing goes to the Ask in each experience that has one, and to Construct’s command line', () => {
    expect(TYPE_TARGETS).toContain('.ask-root .ask-input')
    expect(TYPE_TARGETS).toContain('.still .st-ask-input')
    expect(TYPE_TARGETS).toContain('.ask-root .ask-still-input')
    // Construct's prompt is its Ask (Ask phase 2): the typed keys land in it, the same input that carries data-ask-input
    expect(src('../../experiences/construct/CommandLine.tsx')).toMatch(/aria-label="Command line[^"]*"[\s\S]*?data-ask-input=""[\s\S]*?data-rest-type=""/)
    expect(src('../ask/ClassicAsk.tsx')).toMatch(/className="ask-input"/)
    expect(src('../ask/StillLine.tsx')).toMatch(/className="ask-still-input"/)
    expect(src('../../experiences/still/Ask.tsx')).toMatch(/className="st-ask-input"/)
  })

  it('a dialog that opens while resting ends the rest (a rest never covers a confirm)', () => {
    const host = src('RestScreen.tsx')
    expect(host).toMatch(/new MutationObserver\(\(\) => modalOpen\(\) && dispatch\(\{ type: 'input'/)
  })
})

describe('resting: the hive’s power wins', () => {
  it('rests only with no power screen up', () => {
    expect(restAllowed(true, 'none')).toBe(true)
    for (const s of ['off', 'lighting', 'report'] as const) expect(restAllowed(true, s)).toBe(false)
    expect(restAllowed(false, 'none')).toBe(false)
    expect(restAllowed(true, screenOf({ ...INITIAL, gate: 'off' }))).toBe(false)
    expect(restAllowed(true, screenOf({ ...INITIAL, gate: 'on' }))).toBe(true)
  })

  it('the hive going off ends a rest at once (the host wakes when no longer allowed); urgent items wake too', () => {
    expect(src('RestScreen.tsx')).toMatch(/if \(!allowed\) dispatch\(\{ type: 'reset', ctx/)
    const v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }, { type: 'urgent', at: IDLE + 5 }])
    expect(v.resting).toBe(false)
  })

  it('experiences pause their own expensive loops while resting', () => {
    expect(src('../../experiences/cosmos/index.tsx')).toMatch(/covered = useRoute\(\)\.name !== 'hive' \|\| resting/)
    expect(src('../../experiences/flux/index.tsx')).toMatch(/covered = useRoute\(\)\.name !== 'hive' \|\| resting/)
    expect(src('../../experiences/construct/index.tsx')).toMatch(/route\.name === 'hive' && !resting/)
    expect(src('PowerHost.tsx')).toMatch(/resting && experience === 'classic'/)
  })
})

describe('resting: subtle alerts', () => {
  const goal = (id: string, title: string) => ({ type: 'goal.updated', goal: { id, title, status: 'done', detail: 'SECRET' } })

  it('maps events to alerts: goals finished, people asking, answers, power (Wake all); never bodies', () => {
    expect(restAlertFor({ type: 'hive.power', state: 'on', since: 's1' })).toEqual({ kind: 'power', title: null, key: 'power:s1' })
    expect(restAlertFor({ type: 'hive.power', state: 'off', since: 's2' })).toBeNull()
    expect(JSON.stringify(restAlertFor(goal('g1', 'Map')))).not.toContain('SECRET')
  })

  it('counts what waits and what arrived, needs-you first, and each count is a way in', () => {
    let v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }])
    v = run(
      [
        { type: 'alert', ctx: '', admin: true, alert: restAlertFor(goal('g1', 'Map'))! },
        { type: 'alert', ctx: '', admin: true, alert: restAlertFor({ type: 'person_request.created', request: { id: 'r1', status: 'pending' } })! },
        { type: 'alert', ctx: '', admin: true, alert: restAlertFor({ type: 'ask', phase: 'answer', operation_id: 'op1' })! },
        { type: 'alert', ctx: '', admin: true, alert: restAlertFor({ type: 'hive.power', state: 'on', since: 's' })! },
      ],
      v,
    )
    const chips = restChips(restCounts({ decisions: 2, health: 1 }, v.away, true))
    expect(chips.map((c) => c.id)).toEqual(['decisions', 'asks', 'health', 'goals', 'answers', 'power'])
    expect(chips.map((c) => c.label)).toEqual(['2 decisions waiting', '1 person asking', '1 mind needs you', '1 task finished', '1 answer ready', 'Minds were woken'])
    expect(chipDestination('decisions', v.away)).toEqual({ name: 'approvals' })
    expect(chipDestination('asks', v.away)).toEqual({ name: 'approvals' })
    expect(chipDestination('health', v.away)).toEqual({ name: 'health' })
    expect(chipDestination('goals', v.away)).toEqual({ name: 'tasks', task: 'g1' })
    expect(chipDestination('answers', v.away)).toEqual({ name: 'thread' })
    expect(chipDestination('power', v.away)).toEqual({ name: 'hive' })
    // nothing waiting, nothing arrived: no chips at all
    expect(restChips(restCounts({ decisions: 0, health: 0 }, []))).toEqual([])
  })

  it('more than one goal opens the board, not one goal', () => {
    const away = [restAlertFor(goal('g1', 'A'))!, restAlertFor(goal('g2', 'B'))!]
    expect(chipDestination('goals', away)).toEqual({ name: 'tasks' })
  })

  it('after waking, what was missed stays a way in until the line is dismissed', () => {
    let v = run([{ type: 'tick', at: IDLE, idleMs: IDLE }, { type: 'alert', ctx: '', admin: true, alert: restAlertFor(goal('g1', 'Map'))! }])
    v = run([{ type: 'input', at: IDLE + 1 }], v)
    expect(v.missed.map((a) => a.key)).toEqual(['goal:g1'])
    expect(v.summary).toBe(awaySummary(v.missed))
    expect(run([{ type: 'clearSummary' }], v).missed).toEqual([])
  })

  it('a quiet sign that the hive is working', () => {
    expect(workingLine(0, 0)).toBe('All minds are resting')
    expect(workingLine(1, 0)).toBe('1 mind awake')
    expect(workingLine(3, 2)).toBe('3 minds awake · 2 thinking')
  })

  it('never makes a sound, and entering announces nothing (no focus move; the live line starts empty)', () => {
    const all = src('RestScreen.tsx') + src('RestFaces.tsx') + src('RestScene.tsx')
    expect(all).not.toMatch(/new Audio|AudioContext|\.play\(/)
    expect(all).not.toMatch(/autoFocus|\.focus\(\)/)
    expect(src('RestFaces.tsx')).toMatch(/aria-live="polite">\s*\{line \?\? ''\}/)
    expect(src('RestScreen.tsx')).not.toMatch(/role="dialog"|\saria-modal=/)
  })
})

describe('resting: reduced motion', () => {
  it('the scene loops only with motion allowed and the page visible', () => {
    expect(sceneLoops(false, false)).toBe(true)
    expect(sceneLoops(true, false)).toBe(false)
    expect(sceneLoops(false, true)).toBe(false)
  })

  it('the still, dimmed variant: no animation, a dimmed frame, the pencil already drawn', () => {
    const css = src('power.css')
    expect(css).toMatch(/\.pw-reduced\.pw-rest \.pw-scene \{\s*filter: brightness\(0\.7\)/)
    expect(css).toMatch(/\.pw-reduced\.pw-rest \.pw-draw \{\s*stroke-dashoffset: 0;/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.pw-rest \*,/)
  })
})

describe('resting: the clocks', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 6, h, m)

  it('Still writes the time out, honest about rounding', () => {
    expect(timeInWords(at(16, 20))).toBe('It is twenty past four, in the afternoon.')
    expect(timeInWords(at(16, 21))).toBe('It is just after twenty past four, in the afternoon.')
    expect(timeInWords(at(16, 43))).toBe('It is nearly quarter to five, in the afternoon.')
    expect(timeInWords(at(9, 0))).toBe('It is nine o’clock, in the morning.')
    expect(timeInWords(at(23, 58))).toBe('It is nearly midnight.')
    expect(timeInWords(at(12, 30))).toBe('It is half past twelve, in the afternoon.')
    expect(timeInWords(at(11, 45))).toBe('It is quarter to noon.')
    expect(timeInWords(at(0, 10))).toBe('It is ten past midnight.')
  })

  it('digits in 12- and 24-hour clocks', () => {
    expect(clockParts(at(16, 5), false)).toEqual({ digits: '16:05', suffix: null })
    expect(clockParts(at(16, 5), true)).toEqual({ digits: '4:05', suffix: 'PM' })
    expect(clockParts(at(0, 5), true)).toEqual({ digits: '12:05', suffix: 'AM' })
  })

  it('Cosmos draws the time as constellations; Construct as block glyphs; Canvas as a sketched face', () => {
    const c = constellation('8:88')
    expect(c.lines).toHaveLength(21)
    expect(c.stars.length).toBe(6 * 3 + 2)
    expect(constellation('8:88')).toEqual(c)
    const rows = blockDigits('12:45')
    expect(rows).toHaveLength(5)
    expect(new Set(rows.map((r) => r.length)).size).toBe(1)
    expect(sketchCircle(100, 100, 90, 1)).toMatch(/^M[\d.]+,[\d.]+ L/)
    expect(handAngles(at(3, 30))).toEqual({ hour: 105, minute: 180 })
  })
})
