import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Guided-play r1: a guided demo started from the Ask plays itself through with the shared demo cursor and marks
// (features/ink). It may move the page and point at things on a live hive, but it NEVER presses anything (no click,
// no dispatched event, no focus, no request), and over a decision control (Keep, Confirm, Delete, Send) the cursor
// only points. Any click, scroll, tap or key on the page takes over; typing in the Ask pauses it.
// INVENTED data only; nothing here reaches a hive or a model.

const loc = { hash: '#/', search: '' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined })

/** A stand-in DOM element: records anything that would press it. `within` are the classes of its ancestors. */
class FakeEl {
  pressed: string[] = []
  constructor(
    public tag: string,
    public text: string,
    public within: string[] = [],
    public box = { left: 100, top: 200, width: 120, height: 32, right: 220, bottom: 232 },
  ) {}
  closest(sel: string): FakeEl | null {
    if (sel.startsWith('.')) return this.within.includes(sel.slice(1)) ? this : null
    return /button/.test(sel) && this.tag === 'button' ? this : null
  }
  getBoundingClientRect() {
    return this.box
  }
  getAttribute() {
    return null
  }
  hasAttribute() {
    return false
  }
  get textContent() {
    return this.text
  }
  get innerText() {
    return this.text
  }
  click() {
    this.pressed.push('click')
  }
  dispatchEvent() {
    this.pressed.push('dispatch')
    return true
  }
  focus() {
    this.pressed.push('focus')
  }
}
vi.stubGlobal('Element', FakeEl)

const { playInk, inputVerdict, shortLabel, markKind, inkTargets, needsReveal, ThreadFold, MOUNT_MS, MOUNT_POLL_MS } = await import('./play')
const { glideTo, drawMarks, clearInk, useInk, isDecisionControl } = await import('../ink/ink')
const { useGuide } = await import('./store')
const { guidedIntent } = await import('./match')
const { GUIDE_SCRIPTS } = await import('./scripts')
const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
type PlayScreen = import('./play').PlayScreen
type AskOrigin = import('../../store/ask').AskOrigin
type Mark = import('../ink/ink').Mark

const picks = { mind: { id: 'd_a', name: 'Ada' }, swarm: null, belief: null }
const noSleep = () => Promise.resolve()
const el = (text: string, tag = 'button', within: string[] = []) => new FakeEl(tag, text, within) as unknown as Element & FakeEl

/** the real ink (glideTo / drawMarks) on a page holding `target` */
function realScreen(target: Element | null, drawn: Mark[][] = [], revealed: Element[] = []): PlayScreen {
  return {
    sleep: noSleep,
    reveal: (e) => void revealed.push(e),
    find: () => target,
    glide: (e, click) => glideTo('guided', e, click, false, noSleep),
    draw: (m) => {
      drawn.push(m)
      drawMarks('guided', m)
    },
    clear: () => clearInk('guided'),
  }
}

function origin(): AskOrigin & { live: boolean } {
  const o = { client: null, session: 's', inits: 1, principal: 'user:test', auth: null, epoch: 0, live: true, ok: () => o.live }
  return o
}

beforeEach(() => {
  useInk.setState({ owner: null, marks: [], cursor: { x: -40, y: -40, shown: false, clicks: 0, jump: true } })
})

describe('guided-play: the player draws, and only draws', () => {
  it('a step with a target: the cursor glides there and clicks (a ripple), then one mark with a few words', async () => {
    const t = el('Memory spaces', 'div')
    const drawn: Mark[][] = []
    const step = { say: 'A mind’s memory is its own: MeTTa spaces of atoms, run on PeTTa.', target: { tour: 'memory-spaces' } }
    expect(await playInk(step, picks, realScreen(t, drawn), () => true)).toBe('drawn')
    const ink = useInk.getState()
    expect(ink.cursor.shown).toBe(true)
    expect(ink.cursor.clicks).toBe(1)
    expect(drawn).toEqual([[{ kind: 'circle', target: [{ tour: 'memory-spaces' }], label: 'A mind’s memory is its own', el: t }]])
    expect(t.pressed).toEqual([])
  })

  it('a step with no target, or a target not on the page, shows its caption only', async () => {
    const drawn: Mark[][] = []
    expect(await playInk({ say: 'Just words.' }, picks, realScreen(el('x'), drawn), () => true)).toBe('caption')
    expect(await playInk({ say: 'Gone.', target: { tour: 'nowhere' } }, picks, realScreen(null, drawn), () => true)).toBe('caption')
    expect(drawn).toEqual([])
    expect(useInk.getState().cursor.shown).toBe(false)
  })

  it('the whole page, or a target off screen, is not pointed at: the caption only', async () => {
    const drawn: Mark[][] = []
    const page = new FakeEl('main', 'page', [], { left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900 }) as unknown as Element
    const below = new FakeEl('div', 'x', [], { left: 10, top: 880, width: 100, height: 40, right: 110, bottom: 920 }) as unknown as Element
    expect(await playInk({ say: 'x', target: { region: 'page' } }, picks, realScreen(page, drawn), () => true)).toBe('caption')
    expect(await playInk({ say: 'x', target: { tour: 'a' } }, picks, realScreen(below, drawn), () => true)).toBe('caption')
    expect(drawn).toEqual([])
  })

  it('a superseded step draws nothing more', async () => {
    const drawn: Mark[][] = []
    expect(await playInk({ say: 'x', target: { tour: 'a' } }, picks, realScreen(el('A', 'div'), drawn), () => false)).toBe('gone')
    expect(drawn).toEqual([])
  })

  it('labels are short; big targets get an arrow, wide short ones an underline', () => {
    expect(shortLabel('Each space holds one kind of memory: persistent facts, its agenda.')).toBe('Each space holds one kind of memory')
    expect(shortLabel('Minds can lend each other a view of a space for a set time, with consent').length).toBeLessThanOrEqual(38)
    expect(markKind({ width: 1200, height: 700 }, 1440, 900)).toBe('arrow')
    expect(markKind({ width: 400, height: 40 }, 1440, 900)).toBe('underline')
    expect(markKind({ width: 120, height: 60 }, 1440, 900)).toBe('circle')
  })

  it('reduced motion: the cursor jumps (no glide)', async () => {
    await glideTo('guided', el('Memory', 'div'), true, true, noSleep)
    expect(useInk.getState().cursor.jump).toBe(true)
    await glideTo('guided', el('Memory', 'div'), true, false, noSleep)
    expect(useInk.getState().cursor.jump).toBe(false)
  })

  it('one player never clears the other’s marks', () => {
    drawMarks('showreel', [{ kind: 'circle', target: [{ tour: 'x' }] }])
    clearInk('guided', { cursor: true })
    expect(useInk.getState().marks.length).toBe(1)
    clearInk('showreel')
    expect(useInk.getState().marks.length).toBe(0)
  })
})

describe('guided-play on a live hive: it never presses a decision control and never posts', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('knows the decision controls by their words', () => {
    for (const w of ['Keep', 'Confirm', 'Delete swarm', 'Send', 'Approve', 'Save changes']) expect([w, isDecisionControl(el(w))]).toEqual([w, true])
    for (const w of ['Memory', 'Spaces', 'Next']) expect([w, isDecisionControl(el(w))]).toEqual([w, false])
    expect(isDecisionControl(el('Delete', 'div'))).toBe(false)
  })

  it('pointed at Keep, Confirm, Delete or Send, every step of every ready demo only points: no press, no ripple, no request', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (u: unknown) => {
      calls.push(`fetch ${String(u)}`)
      throw new Error('no network in this test')
    }) as typeof fetch
    // a live client whose every method records the call
    const client = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : (...a: unknown[]) => {
            calls.push(`client.${String(k)}(${a.length})`)
            // an unsubscribe, for the store's own subscriptions
            return () => undefined
          }) })
    useHive.setState({ client: client as never })
    // what the store itself does on a new client (its auth subscription) is not the player's
    calls.length = 0
    let steps = 0
    for (const s of GUIDE_SCRIPTS.filter((x) => x.status === 'ready')) {
      for (const step of s.steps) {
        if (!step.target) continue
        for (const w of ['Keep', 'Confirm', 'Delete', 'Send']) {
          const b = el(w)
          const before = useInk.getState().cursor.clicks
          await playInk(step, picks, realScreen(b), () => true)
          expect([s.id, w, b.pressed]).toEqual([s.id, w, []])
          expect(useInk.getState().cursor.clicks).toBe(before)
          steps++
        }
      }
    }
    expect(steps).toBeGreaterThan(40)
    expect(calls).toEqual([])
    useHive.setState({ client: null })
  })

  it('pointed at an ordinary control it ripples, but still never presses it', async () => {
    const b = el('Memory')
    await playInk({ say: 'Memory.', target: { tour: 'm' } }, picks, realScreen(b), () => true)
    expect(useInk.getState().cursor.clicks).toBe(1)
    expect(b.pressed).toEqual([])
  })
})

describe('guided-play: started from the Ask, it plays itself; the person always wins', () => {
  beforeEach(() => {
    useGuide.getState().close()
    useAskStore.setState({ log: [], threadOpen: false })
  })
  afterEach(() => useGuide.getState().close())

  const run = () => {
    const r = useGuide.getState().run
    if (r?.kind !== 'demo') throw new Error('no demo')
    return r
  }

  it('“how does memory work” plays itself through, end to end: every step shown, marked, then the next', async () => {
    const g = guidedIntent('how does memory work')
    expect(g?.kind === 'script' && g.script.id).toBe('memory')
    expect(await useGuide.getState().start(g!, { you: 'how does memory work', origin: origin(), note: 'The orchestrator did not guide this one, so it plays here.' })).toBe(true)
    expect(run().play).toBe(true)
    expect(run().m.auto).toBe(true)
    const rows = useAskStore.getState().log.map((e) => (e.kind === 'row' ? e.row.text : ''))
    expect(rows[1]).toMatch(/^The orchestrator did not guide this one, so it plays here\. Guided demo: A mind’s memory: spaces and atoms \(4 steps\)\. It plays by itself/)
    const shown: number[] = []
    for (let i = 0; i < 10 && run().m.status !== 'ended'; i++) {
      const r = run()
      useGuide.getState().stepDone(r.m.token, { found: true, note: null })
      const ready = run()
      const t = el('Memory spaces', 'div')
      expect(await playInk(ready.script.steps[ready.m.step], ready.picks, realScreen(t), () => run().m.token === ready.m.token)).toBe('drawn')
      expect(t.pressed).toEqual([])
      shown.push(ready.m.step)
      // its caption read (dwell), auto-advance moves on
      useGuide.getState().send({ type: 'tick', token: ready.m.token })
    }
    expect(shown).toEqual([0, 1, 2, 3])
    expect(run().m.ended).toBe('done')
  })

  it('a click, scroll, tap or key on the page takes over: the step draws nothing more and auto-advance stops', async () => {
    for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
      useGuide.getState().close()
      await useGuide.getState().start(guidedIntent('show me how memory works')!, { you: 'x', origin: origin() })
      const r = run()
      useGuide.getState().stepDone(r.m.token, { found: true, note: null })
      const ready = run()
      const drawn: Mark[][] = []
      let release!: () => void
      const gliding = new Promise<void>((res) => (release = res))
      const screen: PlayScreen = { ...realScreen(el('Memory spaces', 'div'), drawn), glide: () => gliding }
      const playing = playInk(ready.script.steps[0], ready.picks, screen, () => run().m.token === ready.m.token && run().m.status === 'ready')
      // the person's own input on the page, part way through the glide
      const v = inputVerdict({ type, isTrusted: true, key: 'a', target: el('page', 'div') }, true)
      expect([type, v]).toEqual([type, 'takeover'])
      useGuide.getState().send({ type: 'takeover' })
      release()
      expect(await playing).toBe('gone')
      expect(drawn).toEqual([])
      expect([run().m.status, run().m.paused]).toEqual(['paused', 'took-over'])
      useGuide.getState().send({ type: 'tick', token: ready.m.token })
      expect(run().m.step).toBe(0)
    }
  })

  it('typing in the Ask pauses it; the demo’s own controls, modifier keys and synthetic events are neither', () => {
    const ask = el('field', 'input', ['ask-root'])
    expect(inputVerdict({ type: 'keydown', isTrusted: true, key: 'w', target: ask }, true)).toBe('pause')
    // "/" opens the Ask: a pause, not a take-over
    expect(inputVerdict({ type: 'keydown', isTrusted: true, key: '/', target: el('page', 'div') }, true)).toBe('pause')
    // clicking into the Ask is not typing; a demo the orchestrator drives is not paused by the Ask
    expect(inputVerdict({ type: 'pointerdown', isTrusted: true, target: ask }, true)).toBeNull()
    expect(inputVerdict({ type: 'keydown', isTrusted: true, key: 'w', target: ask }, false)).toBeNull()
    expect(inputVerdict({ type: 'pointerdown', isTrusted: true, target: el('Next', 'button', ['guide-ui']) }, true)).toBeNull()
    expect(inputVerdict({ type: 'keydown', isTrusted: true, key: 'Shift', target: el('page', 'div') }, true)).toBeNull()
    expect(inputVerdict({ type: 'pointerdown', isTrusted: false, target: el('page', 'div') }, true)).toBeNull()
  })

  it('paused while typing: it says so, and Next or Resume carries on', async () => {
    await useGuide.getState().start(guidedIntent('show me how memory works')!, { you: 'x', origin: origin() })
    useGuide.getState().stepDone(run().m.token, { found: true, note: null })
    useGuide.getState().send({ type: 'pause', why: 'ask' })
    expect([run().m.status, run().m.paused]).toEqual(['paused', 'ask'])
    useGuide.getState().send({ type: 'resume' })
    expect(run().m.status).toBe('running')
  })

  it('a demo placed by an Ask turn’s conductor gets the cursor and marks but no auto-advance; the showreel’s does not', async () => {
    const { tourStep } = await import('./store')
    await tourStep('memory', 0, origin(), 'turn-1')
    expect(run().play).toBe(true)
    expect(run().m.auto).toBe(false)
    useGuide.getState().close()
    await tourStep('memory', 0, origin(), 'showreel:1:1')
    expect(run().play).toBeUndefined()
    useGuide.getState().close()
    useGuide.getState().play(GUIDE_SCRIPTS.find((s) => s.id === 'memory')!, { origin: origin() })
    expect(run().play).toBeUndefined()
  })
})

describe('guided-play r1.1: the mark is on the intended element, never the Ask; one control surface; the thread folds', () => {
  it('a mark’s targets never include the Ask or the whole page', () => {
    expect(inkTargets([{ tour: 'memory-spaces' }, { region: 'page' }])).toEqual([{ tour: 'memory-spaces' }])
    expect(inkTargets([{ ask: true }])).toEqual([])
    expect(inkTargets({ ask: true, tour: 'x' })).toEqual([{ tour: 'x' }])
    expect(inkTargets({ region: 'thread' })).toEqual([{ region: 'thread' }])
  })

  it('a target still mounting after the page move is waited for, briefly, then marked', async () => {
    const t = el('Memory spaces', 'div')
    let polls = 0
    const drawn: Mark[][] = []
    const screen = { ...realScreen(t, drawn), find: () => (++polls > 4 ? t : null) }
    expect(await playInk({ say: 'Spaces.', target: [{ tour: 'memory-spaces' }, { region: 'page' }] }, picks, screen, () => true)).toBe('drawn')
    expect(polls).toBe(5)
    expect(drawn[0][0].el).toBe(t)
  })

  it('a target that never mounts is the caption only, within its limit; the Ask’s anchor is never marked instead', async () => {
    const drawn: Mark[][] = []
    let polls = 0
    const never = { ...realScreen(null, drawn), find: () => (polls++, null) }
    expect(await playInk({ say: 'x', target: [{ tour: 'memory-spaces' }, { region: 'page' }, { ask: true }] }, picks, never, () => true)).toBe('caption')
    expect(polls).toBe(Math.ceil(MOUNT_MS / MOUNT_POLL_MS) + 1)
    // whatever the page answers from inside the Ask (its send button, its bar) is not a target
    const send = el('Send', 'button', ['ask-root'])
    expect(await playInk({ say: 'x', target: { tour: 'memory-spaces' } }, picks, realScreen(send, drawn), () => true)).toBe('caption')
    // a step whose only target is the Ask, or the whole page, shows its caption
    expect(await playInk({ say: 'x', target: { ask: true } }, picks, realScreen(el('Ask', 'div'), drawn), () => true)).toBe('caption')
    expect(await playInk({ say: 'x', target: { region: 'page' } }, picks, realScreen(el('Page', 'div'), drawn), () => true)).toBe('caption')
    expect(drawn).toEqual([])
    expect(useInk.getState().cursor.shown).toBe(false)
  })

  it('a target only partly on screen is brought into view before it is marked; one in view is not moved', async () => {
    const low = new FakeEl('section', 'spaces', [], { left: 1000, top: 800, width: 400, height: 500, right: 1400, bottom: 1300 }) as unknown as Element & FakeEl
    const revealed: Element[] = []
    await playInk({ say: 'x', target: { tour: 'memory-spaces' } }, picks, realScreen(low, [], revealed), () => true)
    expect(revealed).toEqual([low])
    expect(low.pressed).toEqual([])
    const shown: Element[] = []
    await playInk({ say: 'x', target: { tour: 'memory-spaces' } }, picks, realScreen(el('Spaces', 'div'), [], shown), () => true)
    expect(shown).toEqual([])
    expect(needsReveal({ top: 800, bottom: 1300, height: 500 }, 900)).toBe(true)
    expect(needsReveal({ top: 100, bottom: 600, height: 500 }, 900)).toBe(false)
    expect(needsReveal({ top: 100, bottom: 2100, height: 2000 }, 900)).toBe(false)
  })

  it('the Ask thread folds while a step plays and comes back as it was; a thread the person had closed stays closed', () => {
    let open = true
    const sets: boolean[] = []
    const f = new ThreadFold({ open: () => open, set: (o) => void (sets.push(o), (open = o)) })
    f.step()
    expect(open).toBe(false)
    f.step()
    f.restore()
    expect(open).toBe(true)
    expect(sets).toEqual([false, true])
    // closed by the person before the demo: never opened by it
    open = false
    const g = new ThreadFold({ open: () => open, set: (o) => void (open = o) })
    g.step()
    g.restore()
    expect(open).toBe(false)
    // another person: nothing reopened for them
    open = true
    const h = new ThreadFold({ open: () => open, set: (o) => void (open = o) })
    h.step()
    h.drop()
    h.restore()
    expect(open).toBe(false)
  })

  it('followups-r5: a run that ends (or is closed) forgets the keep; a pause does not', async () => {
    let open = true
    const f = new ThreadFold({ open: () => open, set: (o) => void (open = o) })
    f.step('a')
    open = true   // the person reopens it mid-run
    f.step('a')
    expect(f.keeps('a')).toBe(true)
    f.restore()   // paused
    expect(f.keeps('a')).toBe(true)
    f.restore({ ended: true })
    expect(f.keeps('a')).toBe(false)
    // the same demo played again folds as at the start
    f.step('a')
    expect(open).toBe(false)
    // the layer passes "ended" for an ended or closed run and when it goes away, never for a pause
    const fsName = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
    const src = readFileSync(new URL('./GuideLayer.tsx', import.meta.url).pathname, 'utf8')
    expect(src).toContain("else threadFold.restore({ ended: !demo || status === 'ended' })")
    expect(src).toContain('threadFold.restore({ ended: true })')
  })

  it('r1.2a: a thread the person reopens during a played demo stays open for the rest of that run, and folds again in the next', () => {
    let open = true
    const f = new ThreadFold({ open: () => open, set: (o) => void (open = o) })
    f.step(1)
    expect(open).toBe(false)
    // the person presses the thread open again, mid-run
    open = true
    f.step(1)
    expect(open).toBe(true)
    f.step(1)
    f.step(1)
    expect(open).toBe(true)
    expect(f.keeps(1)).toBe(true)
    // pause and resume in the same run: still theirs
    f.restore()
    f.step(1)
    expect(open).toBe(true)
    // the next run folds it as before
    f.step(2)
    expect(f.keeps(1)).toBe(false)
    expect(open).toBe(false)
    // a change of person forgets the keep
    open = true
    f.step(2)
    expect(f.keeps(2)).toBe(true)
    f.drop()
    expect(f.keeps(2)).toBe(false)
    f.step(2)
    expect(open).toBe(false)
  })

  it('one control surface: the thread card is the transcript, with no controls; the caption has them', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { GuideCardView } = await import('./GuideLayer')
    useGuide.getState().close()
    await useGuide.getState().start(guidedIntent('show me how memory works')!, { you: 'x', origin: origin() })
    const r = useGuide.getState().run
    if (r?.kind !== 'demo') throw new Error('no demo')
    useGuide.getState().stepDone(r.m.token, { found: true, note: null })
    const card = renderToStaticMarkup(createElement(GuideCardView, { run: useGuide.getState().run }))
    expect(card).toContain('guide-said')
    expect(card).not.toContain('<button')
    expect(card).not.toContain('guide-controls')
    useGuide.getState().close()
  })
})
