import { describe, expect, it } from 'vitest'
import { decide, resolve, type Candidate, type World } from '../../lib/intent'
import { askRows, asksMind, enterAction, highlighted, sendsToMind, type AskSeen } from './enter'
import fieldSource from './useAskField.ts?raw'

/**
 * UI review 2026-10-12 ST1 (money safety): with "Search everything for “kelp”" highlighted and marked ↵, Enter sent the
 * words to a mind (a paid answer) instead of searching; clicking the row searched. Enter now does exactly what clicking
 * the highlighted row does, in every skin (they all draw the one hook). The rows and the Enter rule are the ones the
 * hook uses (enter.ts), over the real fast path (resolve) and policy (decide). INVENTED data only.
 */
const world: World = {
  minds: [
    { id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' },
    { id: 'a_altr03', name: 'Altair', awake: false, swarm: 'Lyra' },
    { id: 'ag_7d1c0a11f3', name: 'Mira', awake: false, swarm: 'Forge' },
    { id: 'ag_92be44c8e0', name: 'Mira', awake: false, swarm: 'Atlas Team' },
  ],
  swarms: [{ id: 's_lyra', name: 'Lyra' }],
  pending: 1,
  experiences: [
    { id: 'classic', name: 'Classic hive' },
    { id: 'still', name: 'Still' },
  ],
  looks: [],
}
const EXPERIENCES = ['still', 'classic', 'professional', 'omegatown', 'cosmos', 'construct', 'flux', 'canvas']
const WORDS = ['kelp', 'cepheid', 'k', 'what is the hive working on this week', 'search for kelp', 'show usage', 'wake Altair', 'wake Mira', 'wake Altair tomorrow', 'open decisions waiting on you', 'what needs me', 'ask Vega about kelp', 'wak', 'darker']

const ROWS: AskSeen = { rows: true, panel: false }
/** The field as the hook builds it: rows shown, and what Enter would do with the highlight at `sel`. */
function field(words: string, experience: string, orchestrator = true, steering = false) {
  const cands = resolve(words, { experience }, world)
  const d = decide(cands, { orchestrator })
  const rows = askRows(cands, words, 'Vega', d, steering)
  return { cands, d, rows, enter: (sel: number, moved: boolean, seen: AskSeen = ROWS, placeChanged = false) => enterAction(rows, sel, moved, d, { steering, seen, placeChanged }) }
}
const keyOf = (c: Candidate | undefined) => c?.key

describe('ST1: Enter on the highlighted row does what clicking it does', () => {
  it('“kelp”: the row Enter will run is the highlighted one; with Search highlighted, Enter searches and asks no mind', () => {
    const f = field('kelp', 'still')
    expect(f.d.kind).toBe('mind')
    // at rest the highlighted row (first) is the mind row: the spend is shown before Enter, not hidden under Search
    expect(keyOf(highlighted(f.rows, 0))).toBe('mind')
    expect(asksMind(f.enter(0, false))).toBe(true)
    // the person moves the highlight to "Search everything for “kelp”": Enter searches, exactly as a click would
    const at = f.rows.findIndex((c) => c.key === 'search')
    expect(at).toBeGreaterThan(0)
    expect(f.enter(at, true)).toEqual({ kind: 'take', c: f.rows[at] })
    expect(f.rows[at].act).toEqual({ do: 'search', text: 'kelp' })
    expect(asksMind(f.enter(at, true))).toBe(false)
  })

  it('the old order (Search first, highlighted at rest): Enter takes Search, never the mind the policy picked', () => {
    const { cands, d } = field('cepheid', 'still')
    const search = cands.find((c) => c.key === 'search')!
    const e = enterAction([search, ...cands.filter((c) => c !== search)], 0, false, d, { steering: false, seen: ROWS, placeChanged: false })
    expect(d.kind).toBe('mind')
    expect(e).toEqual({ kind: 'take', c: search })
    expect(asksMind(e)).toBe(false)
  })

  it('one letter (no mind row yet): Enter takes the highlighted Search, never sends the letter to a mind', () => {
    const f = field('k', 'still')
    expect(f.rows.some(sendsToMind)).toBe(false)
    expect(f.d.kind).toBe('mind')
    expect(asksMind(f.enter(0, false))).toBe(false)
    expect(keyOf((f.enter(0, false) as { c: Candidate }).c)).toBe('search')
  })

  it('no orchestrator: Enter takes the highlighted row (Search), as a click does', () => {
    const f = field('kelp', 'still', false)
    expect(f.d.kind).toBe('none')
    expect(f.enter(0, false)).toEqual({ kind: 'take', c: highlighted(f.rows, 0) })
    expect(keyOf(highlighted(f.rows, 0))).toBe('search')
  })

  it('while a mind answers, the highlighted first row is the steer, and Enter steers', () => {
    const f = field('only the open tasks', 'cosmos', true, true)
    expect(keyOf(f.rows[0])).toBe('steer')
    expect(sendsToMind(f.rows[0])).toBe(true)
    expect(f.enter(0, false)).toEqual({ kind: 'take', c: f.rows[0] })
  })

  it('r2.1 (stand-in #1): mid-turn, one letter shows no steer row, and Enter takes the highlighted Search, not the mind', () => {
    const f = field('k', 'cosmos', true, true)
    expect(f.rows.some(sendsToMind)).toBe(false)
    const e = f.enter(0, false)
    expect(e).toEqual({ kind: 'take', c: f.rows[0] })
    expect(keyOf(f.rows[0])).toBe('search')
    expect(asksMind(e)).toBe(false)
    // mid-turn, a moved highlight onto Search is Search too
    const g = field('kelp', 'cosmos', true, true)
    const at = g.rows.findIndex((c) => c.key === 'search')
    expect(asksMind(g.enter(at, true))).toBe(false)
  })

  it('r2.1 (stand-in #3): nothing on screen (a voice notice or a picker replaced the rows): Enter refuses, whatever is highlighted', () => {
    for (const words of ['kelp', 'what is the hive working on this week', 'show usage', 'wake Altair']) {
      for (const steering of [false, true]) {
        const f = field(words, 'classic', true, steering)
        for (const [sel, moved] of [[0, false], [1, true]] as [number, boolean][]) expect(f.enter(sel, moved, { rows: false, panel: false })).toEqual({ kind: 'refuse', why: 'hidden' })
      }
    }
  })

  it('r2.2 (Kimi r2.1 #2): no row on screen: Enter acts only on what the visible panel offers ("That place changed…"); otherwise it refuses, paid or not', () => {
    const f = field('kelp', 'classic')
    expect(f.enter(0, false, { rows: false, panel: true })).toEqual({ kind: 'refuse', why: 'panel' })
    expect(f.enter(0, false, { rows: false, panel: true }, true)).toEqual({ kind: 'policy', d: f.d })
    // an unpaid act the policy would run at once (a view, a person-typed hive action) never runs unseen either
    for (const words of ['show usage', 'wake Altair', 'open decisions waiting on you']) {
      const v = field(words, 'classic')
      expect(['run', 'own', 'open-decision']).toContain(v.d.kind)
      expect(v.enter(0, false, { rows: false, panel: true })).toEqual({ kind: 'refuse', why: 'panel' })
      expect(v.enter(1, true, { rows: false, panel: true })).toEqual({ kind: 'refuse', why: 'panel' })
    }
  })

  it('every skin, many words, every highlight: Enter asks a mind only when the highlighted row is a mind row', () => {
    let checked = 0
    for (const experience of EXPERIENCES) {
      for (const words of WORDS) {
        for (const orchestrator of [true, false]) {
          const f = field(words, experience, orchestrator)
          // at rest (sel 0, not moved), and the highlight moved to every row
          const cases: [number, boolean][] = [[0, false], ...f.rows.map((_, i): [number, boolean] => [i, true])]
          for (const [sel, moved] of cases) {
            const row = highlighted(f.rows, sel)
            const e = f.enter(sel, moved)
            checked++
            if (!sendsToMind(row)) expect(asksMind(e), `${experience} “${words}” sel ${sel}${moved ? ' moved' : ''}: highlighted ${row?.key}`).toBe(false)
            // when the policy acts on a row itself, it is the highlighted row
            if (e.kind === 'policy' && (e.d.kind === 'run' || e.d.kind === 'own' || e.d.kind === 'open-decision')) expect(e.d.c.key).toBe(row?.key)
            if (moved) expect(e).toEqual(row ? { kind: 'take', c: row } : { kind: 'refuse', why: 'empty' })
            // hidden rows never authorise a mind; a panel does only when its words say so
            for (const panel of [false, true]) {
              for (const placeChanged of [false, true]) {
                const h = f.enter(sel, moved, { rows: false, panel }, placeChanged)
                // with no row on screen, the only thing Enter may do is what "That place changed…" offers
                if (h.kind !== 'refuse') expect(panel && placeChanged, `${experience} “${words}” hidden rows, panel ${panel}`).toBe(true)
                expect(h.kind).not.toBe('take')
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200)
  })
})

describe('ST1 is wired: the one hook every skin draws uses these rows and this rule', () => {
  it('the shown rows are askRows; Enter goes through enterAction before the policy; take runs what a click runs', () => {
    // the shown rows are askRows (j0-fixes r1 only adds who pays to the paid rows, keeping each row's key and order)
    expect(fieldSource).toContain('const rows = forced !== null ? askRows([], forced, answererName, decision, !!open) : askRows(cands, value, answererName, decision, !!open)')
    expect(fieldSource).toMatch(/return rows\.map\(\(c\) => \(c\.key === 'mind' \|\| c\.key === 'steer' \? \{ \.\.\.c, pays \} : c\)\)/)
    expect(fieldSource).toContain('const active = highlighted(shownList, sel)')
    expect(fieldSource).toContain("const e = enterAction(shownList, sel, moved, decision, { steering: !!open, seen: seen.current, placeChanged: panel?.kind === 'say' && panel.text === PLACE_CHANGED })")
    expect(fieldSource).toMatch(/if \(e\.kind === 'refuse'\) return refuse\(REFUSED\[e\.why\]\)[\s\S]{0,300}if \(e\.kind === 'take'\) return take\(e\.c, ev\)\s+const d = e\.d\s+switch \(d\.kind\)/)
    // no Enter path reaches a mind around enterAction (the old mid-turn bypass is gone)
    expect(fieldSource).not.toMatch(/if \(useAskStore\.getState\(\)\.open\) return run/)
    // one policy switch on Enter, reached only through enterAction
    expect(fieldSource.match(/switch \(d\.kind\)/g)).toHaveLength(1)
  })
})
