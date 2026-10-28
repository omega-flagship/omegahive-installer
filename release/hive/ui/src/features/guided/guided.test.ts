import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Guided demos by Ask: intent matching, the step state machine, the driver's navigation and presence calls,
// takeover/stop, identity fencing, the honest answers for modules not built yet, and the scripts' own integrity.
// INVENTED data only; nothing here reaches a hive.

const loc = { hash: '#/', search: '' }
const moved: string[] = []
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined })
vi.mock('../../lib/router', async (orig) => {
  const real = await orig<typeof import('../../lib/router')>()
  return { ...real, navigate: (r: import('../../lib/router').Route) => void ((loc.hash = real.href(r)), moved.push(loc.hash)) }
})

const { guidedIntent, guideControl, topicScore, bestScript, nearest } = await import('./match')
const { reduceGuide, startMachine, dwellMs } = await import('./machine')
const { applyAction, playStep, fill, selectorsOf, findIn, targetsOf } = await import('./driver')
const { GUIDE_SCRIPTS, scriptById } = await import('./scripts')
const { useGuide, controlFromWords, listAnswer, unknownAnswer } = await import('./store')
const { resolve, decide } = await import('../../lib/intent')
const { useAskStore } = await import('../../store/ask')
type GuideEnv = import('./driver').GuideEnv
type Picks = import('./driver').Picks
type AskOrigin = import('../../store/ask').AskOrigin

const id = (t: string) => {
  const g = guidedIntent(t)
  return g?.kind === 'script' ? g.script.id : g?.kind ?? null
}

describe('guided demos: recognising the request in the Ask', () => {
  it('starts the right demo from many phrasings', () => {
    const cases: [string, string][] = [
      ['show me how belief revision works', 'beliefs'],
      ['Show me how truth values work', 'beliefs'],
      ['how does the commons work', 'beliefs'],
      ['walk me through the commons explorer', 'commons-explorer'],
      ['explain NAL', 'reasoning'],
      ['demo PLN', 'reasoning'],
      ['can you show me how NARS works?', 'reasoning'],
      ['show me how swapping experiences works', 'experiences'],
      ['give me a tour of the hive', 'hive'],
      ['walk me through the Lab', 'lab'],
      ['show me how the code canvas works', 'code'],
      ['show me how vibe coding works', 'code'],
      ['take me through the coffee room', 'coffee'],
      ['show me how spending limits work', 'trust'],
      ['how do outside agents work', 'mcp'],
      ['show me how mcp works', 'mcp'],
      ['show me how the holarchy works', 'swarms'],
      ['demo the design canvas', 'design'],
      ['show me how memory works', 'memory'],
      ['show me how evolve works', 'evolve'],
      ['show me the omega tools', 'tools-catalogue'],
      ['walk me through power modes', 'power'],
      ['show me how temporal reasoning works', 'temporal'],
      ['show me how attention works', 'attention'],
      ['show me how causal reasoning works', 'assume'],
      ['demo scratch space', 'scratch'],
      ['show me how energy works', 'energy'],
      ['walk me through affordances', 'self-knowledge'],
    ]
    for (const [t, want] of cases) expect([t, id(t)]).toEqual([t, want])
  })

  it('every script’s own trigger phrases start that script', () => {
    for (const s of GUIDE_SCRIPTS) for (const t of s.triggers) expect([t, id(t)]).toEqual([t, s.id])
  })

  it('an unknown topic with demo phrasing gets an honest "no demo" with real demos to offer', () => {
    const g = guidedIntent('show me how cooking works')
    expect(g?.kind).toBe('unknown')
    if (g?.kind !== 'unknown') return
    expect(g.topic).toBe('cooking')
    expect(g.near.length).toBe(3)
    expect(g.near.every((s) => s.status === 'ready')).toBe(true)
  })

  it('soft phrasing about something unknown is a question for the orchestrator, not a demo', () => {
    expect(guidedIntent('how does the weather work')).toBeNull()
    expect(guidedIntent('explain why task 4 failed')).toBeNull()
    expect(guidedIntent('show my usage')).toBeNull()
    expect(guidedIntent('show me the usage of Forge')).toBeNull()
    expect(guidedIntent('')).toBeNull()
  })

  it('lists the demos when asked which there are', () => {
    expect(guidedIntent('what demos are there')?.kind).toBe('list')
    expect(guidedIntent('show me the demos')?.kind).toBe('list')
  })

  it('scores exact topics above partial ones, and prefers ready demos on a tie', () => {
    const beliefs = scriptById('beliefs')!
    expect(topicScore('belief revision', beliefs)).toBe(1)
    expect(topicScore('belief revision in a swarm', beliefs)).toBeGreaterThan(0.5)
    expect(bestScript('reasoning')?.script.id).toBe('reasoning')
    expect(bestScript('zebra')).toBeNull()
    expect(nearest('truth').map((s) => s.id)).toContain('beliefs')
  })

  it('reads demo controls while one plays', () => {
    expect(guideControl('next')).toBe('next')
    expect(guideControl('Go back')).toBe('back')
    expect(guideControl('hold on')).toBe('pause')
    expect(guideControl('resume the demo')).toBe('resume')
    expect(guideControl('stop the tour')).toBe('stop')
    expect(guideControl('start over')).toBe('restart')
    expect(guideControl('show my usage')).toBeNull()
  })

  it('the shared fast path offers exactly one row for a demo request, and the policy runs it', () => {
    const world = { minds: [], swarms: [], pending: 0 }
    for (const t of ['show me how belief revision works', 'show me how temporal reasoning works', 'show me how cooking works', 'what demos are there']) {
      const cs = resolve(t, { experience: 'classic' }, world)
      expect(cs).toHaveLength(1)
      expect(cs[0].act).toEqual({ do: 'guide', text: t })
      expect(cs[0].effect).toBe('view')
      expect(decide(cs, { orchestrator: true }).kind).toBe('run')
    }
    // anything else is untouched
    expect(resolve('show my usage', { experience: 'classic' }, world).some((c) => c.act?.do === 'guide')).toBe(false)
  })
})

describe('guided demos: the step state machine', () => {
  const ready = (s: ReturnType<typeof startMachine>) => reduceGuide(s, { type: 'ready', token: s.token })

  it('walks every step in order, then ends as done', () => {
    let s = startMachine(3)
    const seen: number[] = []
    while (s.status !== 'ended') {
      expect(s.status).toBe('running')
      s = ready(s)
      expect(s.status).toBe('ready')
      seen.push(s.step)
      s = reduceGuide(s, { type: 'next' })
    }
    expect(seen).toEqual([0, 1, 2])
    expect(s.ended).toBe('done')
  })

  it('ignores a late "ready" from an older step', () => {
    const s = reduceGuide(startMachine(3), { type: 'next' })
    expect(reduceGuide(s, { type: 'ready', token: s.token - 1 })).toBe(s)
  })

  it('back never goes before the first step, and replays the step from its start', () => {
    const s = ready(startMachine(3))
    const b = reduceGuide(s, { type: 'back' })
    expect(b.step).toBe(0)
    expect(b.status).toBe('running')
    expect(b.token).toBeGreaterThan(s.token)
  })

  it('pause and resume: resume plays the step again (its place may have changed)', () => {
    const s = ready(startMachine(2))
    const p = reduceGuide(s, { type: 'pause' })
    expect(p.status).toBe('paused')
    expect(p.paused).toBe('person')
    const r = reduceGuide(p, { type: 'resume' })
    expect(r.status).toBe('running')
    expect(r.step).toBe(0)
    expect(reduceGuide(reduceGuide(s, { type: 'toggle' }), { type: 'toggle' }).status).toBe('running')
  })

  it('a takeover pauses and says so; a paused demo ignores a step finishing', () => {
    const s = startMachine(2)
    const t = reduceGuide(s, { type: 'takeover' })
    expect(t.status).toBe('paused')
    expect(t.paused).toBe('took-over')
    expect(reduceGuide(t, { type: 'ready', token: s.token })).toBe(t)
  })

  it('auto-advance only moves a ready step, with its own token, when auto is on', () => {
    let s = ready(startMachine(3))
    expect(reduceGuide(s, { type: 'tick', token: s.token })).toBe(s)
    s = reduceGuide(s, { type: 'auto', on: true })
    expect(reduceGuide(s, { type: 'tick', token: s.token - 1 })).toBe(s)
    expect(reduceGuide(s, { type: 'tick', token: s.token }).step).toBe(1)
    expect(dwellMs('short')).toBe(4000)
    expect(dwellMs('x'.repeat(1000))).toBe(14000)
  })

  it('stop and fenced end it; an ended demo only restarts', () => {
    const s = ready(startMachine(3))
    const st = reduceGuide(s, { type: 'stop' })
    expect(st.ended).toBe('stopped')
    expect(reduceGuide(st, { type: 'next' })).toBe(st)
    expect(reduceGuide(s, { type: 'fenced' }).ended).toBe('fenced')
    const again = reduceGuide(st, { type: 'restart' })
    expect([again.status, again.step, again.ended]).toEqual(['running', 0, undefined])
  })
})

// ---------------------------------------------------------------- the driver

const PICKS: Picks = { mind: { id: 'a_vega01', name: 'Vega' }, swarm: { id: 's_lyra', name: 'Lyra' }, belief: '(--> sun star)' }
function fakeEnv(over: Partial<GuideEnv> = {}, found: () => Element | null = () => null) {
  const calls: unknown[][] = []
  const env: GuideEnv = {
    go: (r) => void calls.push(['go', r]),
    picks: () => PICKS,
    appEnabled: (id) => id === 'commons-explorer',
    ui: (k) => void calls.push(['ui', k]),
    experience: (id) => void calls.push(['experience', id]),
    press: (n, o) => void calls.push(['press', n, o]),
    find: (t) => (calls.push(['find', t.length]), found()),
    reveal: (el) => void calls.push(['reveal', el]),
    sleep: async () => undefined,
    ...over,
  }
  return { env, calls }
}

describe('guided demos: the driver (navigation and presence calls)', () => {
  it('opens the picked mind, swarm, belief and app through the router', () => {
    const { env, calls } = fakeEnv()
    expect(applyAction({ mind: 'memory' }, env, PICKS)).toBeNull()
    expect(applyAction({ swarm: 'commons' }, env, PICKS)).toBeNull()
    expect(applyAction({ swarm: 'commons', belief: true }, env, PICKS)).toBeNull()
    expect(applyAction({ app: 'commons-explorer' }, env, PICKS)).toBeNull()
    expect(applyAction({ room: 'coffee' }, env, PICKS)).toBeNull()
    expect(calls).toEqual([
      ['go', { name: 'dot', id: 'a_vega01', tab: 'memory' }],
      ['go', { name: 'swarm', id: 's_lyra', tab: 'commons' }],
      ['go', { name: 'swarm', id: 's_lyra', statement: '(--> sun star)' }],
      ['go', { name: 'program', id: 'commons-explorer', swarm: 's_lyra' }],
      ['go', { name: 'messages', room: 'coffee' }],
    ])
  })

  it('says honestly when there is nothing to open (no mind, no swarm, an app not on this hive)', () => {
    const { env, calls } = fakeEnv()
    const none: Picks = { mind: null, swarm: null, belief: null }
    expect(applyAction({ mind: 'chat' }, env, none)).toMatch(/no mind yet/)
    expect(applyAction({ swarm: 'commons' }, env, none)).toMatch(/no swarm yet/)
    expect(applyAction({ app: 'atlas' }, env, PICKS)).toMatch(/not on this hive/)
    expect(applyAction({ swarm: 'commons', belief: true }, env, { ...PICKS, belief: null })).toMatch(/no shared beliefs yet/)
    expect(calls).toContainEqual(['go', { name: 'programs' }])
  })

  it('harmless UI only: previews, gallery, menus', () => {
    const { env, calls } = fakeEnv()
    applyAction({ experience: 'still' }, env, PICKS)
    applyAction({ experience: null }, env, PICKS)
    applyAction({ ui: 'gallery' }, env, PICKS)
    applyAction({ press: 'hud-more' }, env, PICKS)
    expect(calls).toEqual([['experience', 'still'], ['experience', null], ['ui', 'gallery'], ['press', 'hud-more', true]])
  })

  it('a reading step folds the Ask thread to its bar after its move (stand-in r5 P2); other steps never do', async () => {
    const el = { tag: 'viewer' } as unknown as Element
    const { env, calls } = fakeEnv({}, () => el)
    await playStep({ say: 'x', do: { mind: 'tools' }, target: { tour: 'module-attention' }, read: true }, env, () => true)
    expect(calls.slice(0, 2)).toEqual([['go', { name: 'dot', id: 'a_vega01', tab: 'tools' }], ['ui', 'ask-bar']])
    const other = fakeEnv({}, () => el)
    await playStep({ say: 'x', do: { mind: 'tools' }, target: { tour: 'module-attention' } }, other.env, () => true)
    expect(other.calls.some((c) => c[0] === 'ui')).toBe(false)
  })

  it('every tour that ends on a module viewer ends on a reading step: all six, banked and stub (stand-in r5 P2)', async () => {
    const { viewerStep } = await import('./banked')
    const viewers = GUIDE_SCRIPTS.filter((s) => s.viewer)
    expect(viewers.map((s) => s.viewer).sort()).toEqual(['assume', 'attention', 'energy', 'scratch', 'self', 'temporal'])
    for (const s of viewers) {
      const last = s.banked ? viewerStep(s)[0] : s.steps.at(-1)!
      expect([s.id, last]).toMatchObject([s.id, { do: { mind: 'tools' }, target: [{ tour: `module-${s.viewer}` }, { tour: 'reasoning-modules' }, { region: 'page' }], read: true }])
    }
    // no other step folds the Ask
    for (const s of GUIDE_SCRIPTS) for (const st of s.steps) if (st.read) expect(JSON.stringify(st.target)).toContain(`module-${s.viewer}`)
  })

  it('the live fold only closes the Ask thread (the Ask stays), and is not put back over what is being read', async () => {
    const { liveEnv } = await import('./store')
    useAskStore.getState().setThreadOpen(true)
    liveEnv.ui('ask-bar')
    expect(useAskStore.getState().threadOpen).toBe(false)
    liveEnv.ui('close')
    expect(useAskStore.getState().threadOpen).toBe(false)
  })

  it('r1.2a: a read step does not fold a thread the person reopened during this played demo; another run still folds it', async () => {
    const { liveEnv, threadFold } = await import('./store')
    useGuide.setState({ run: { kind: 'demo', id: 9001 } as unknown as import('./store').GuideRun })
    useAskStore.getState().setThreadOpen(true)
    threadFold.step(9001)
    expect(useAskStore.getState().threadOpen).toBe(false)
    useAskStore.getState().setThreadOpen(true)
    threadFold.step(9001)
    liveEnv.ui('ask-bar')
    expect(useAskStore.getState().threadOpen).toBe(true)
    useGuide.setState({ run: { kind: 'demo', id: 9002 } as unknown as import('./store').GuideRun })
    liveEnv.ui('ask-bar')
    expect(useAskStore.getState().threadOpen).toBe(false)
    threadFold.drop()
    useGuide.setState({ run: null })
  })

  it('waits for the target, then brings it into view', async () => {
    const el = { tag: 'target' } as unknown as Element
    let n = 0
    const { env, calls } = fakeEnv({}, () => (++n >= 3 ? el : null))
    const r = await playStep({ say: 'x', do: { mind: 'model' }, target: { tour: 'mind-tools' } }, env, () => true)
    expect(r).toEqual({ el, note: null })
    expect(calls.filter((c) => c[0] === 'find')).toHaveLength(3)
    expect(calls.at(-1)).toEqual(['reveal', el])
  })

  it('gives up on a target that never shows (and says it is not on screen), within its limit', async () => {
    const { env, calls } = fakeEnv()
    const r = await playStep({ say: 'x', target: { tour: 'nope' }, wait: { for: 'target', ms: 360 } }, env, () => true)
    expect(r.el).toBeNull()
    expect(calls.filter((c) => c[0] === 'find').length).toBe(4)
  })

  it('a "your turn" step waits as long as it takes, and stops at once when superseded', async () => {
    let alive = true
    let n = 0
    const { env } = fakeEnv({ sleep: async () => void (++n > 50 && (alive = false)) })
    const r = await playStep({ say: 'x', target: { region: 'code-editor' }, wait: { for: 'you' } }, env, () => alive)
    expect(r.el).toBeNull()
    expect(n).toBeGreaterThan(50)
  })

  it('a superseded step does nothing more after its action', async () => {
    const { env, calls } = fakeEnv()
    await playStep({ say: 'x', do: { go: { name: 'lab' } }, target: { tour: 'lab-scorecard' } }, env, () => false)
    expect(calls).toEqual([['go', { name: 'lab' }]])
  })

  it('builds presence selectors from safe values only, and fills the picks into the words', () => {
    expect(selectorsOf({ region: 'page' }, PICKS)).toEqual(['[data-presence-region="page"]'])
    expect(selectorsOf({ feature: 'swarms.beliefs' }, PICKS)).toEqual(['[data-presence-feature="swarms.beliefs"]'])
    expect(selectorsOf({ entity: 'mind' }, PICKS)).toEqual(['[data-presence-ref="mind:a_vega01"]'])
    expect(selectorsOf({ tour: 'x"] , body [y' }, PICKS)).toEqual([])
    expect(selectorsOf({ region: 'Bad Region' }, PICKS)).toEqual([])
    expect(targetsOf(undefined)).toEqual([])
    expect(fill('{mind} in {swarm}: “{belief}”', PICKS)).toBe('Vega in Lyra: “(--> sun star)”')
    expect(fill('{mind}', { mind: null, swarm: null, belief: null })).toBe('a mind')
  })

  it('finds the first target in order that has a size and is not inert or the guide itself', () => {
    const mk = (w: number, inert = false) => ({ getBoundingClientRect: () => ({ width: w, height: w }), closest: () => (inert ? {} : null) }) as unknown as Element
    const hidden = mk(0)
    const under = mk(10, true)
    const good = mk(10)
    const root = { querySelectorAll: (sel: string) => (sel.includes('first') ? [hidden, under] : sel.includes('second') ? [good] : []) }
    expect(findIn(root, [{ tour: 'first' }, { tour: 'second' }], PICKS)).toBe(good)
    expect(findIn(root, [{ tour: 'first' }], PICKS)).toBeNull()
  })
})

// ---------------------------------------------------------------- the run: start, controls, fencing, stubs

function origin(): AskOrigin & { live: boolean } {
  const o = { client: null, session: 's', inits: 1, principal: 'user:test', auth: null, epoch: 0, live: true, ok: () => o.live }
  return o
}

describe('guided demos: the run (start, control, takeover, fencing, honest answers)', () => {
  beforeEach(() => {
    useGuide.getState().close()
    useAskStore.setState({ log: [], threadOpen: false })
    loc.hash = '#/'
    moved.length = 0
  })
  afterEach(() => useGuide.getState().close())

  it('starts a ready demo from the Ask, records it in the thread and opens the thread', async () => {
    const o = origin()
    const g = guidedIntent('show me how belief revision works')!
    expect(await useGuide.getState().start(g, { you: 'show me how belief revision works', origin: o })).toBe(true)
    const run = useGuide.getState().run
    expect(run?.kind).toBe('demo')
    if (run?.kind !== 'demo') return
    expect(run.script.id).toBe('beliefs')
    expect(run.m.status).toBe('running')
    expect(useAskStore.getState().threadOpen).toBe(true)
    const rows = useAskStore.getState().log.map((e) => (e.kind === 'row' ? e.row.text : ''))
    expect(rows[0]).toBe('show me how belief revision works')
    expect(rows[1]).toMatch(/^Guided demo: Belief revision and truth values \(6 steps\)/)
  })

  it('a finished step is said; words in the Ask control it; Stop ends it', async () => {
    const o = origin()
    await useGuide.getState().start(guidedIntent('walk me through the lab')!, { you: 'walk me through the lab', origin: o })
    let run = useGuide.getState().run
    if (run?.kind !== 'demo') throw new Error('no demo')
    useGuide.getState().stepDone(run.m.token, { found: true, note: null })
    run = useGuide.getState().run
    if (run?.kind !== 'demo') throw new Error('no demo')
    expect(run.m.status).toBe('ready')
    expect(run.said[0]).toMatch(/^The Lab tests the hive itself/)
    expect(controlFromWords('next')).toBe(true)
    expect((useGuide.getState().run as { m: { step: number } }).m.step).toBe(1)
    expect(controlFromWords('show my usage')).toBe(false)
    expect(controlFromWords('stop')).toBe(true)
    run = useGuide.getState().run
    expect(run?.kind === 'demo' && run.m.ended).toBe('stopped')
    // Stop again closes it
    expect(controlFromWords('stop')).toBe(true)
    expect(useGuide.getState().run).toBeNull()
  })

  it('the person taking over pauses it, and says so', async () => {
    await useGuide.getState().start(guidedIntent('show me how memory works')!, { you: 'x', origin: origin() })
    useGuide.getState().send({ type: 'takeover' })
    const run = useGuide.getState().run
    expect(run?.kind === 'demo' && [run.m.status, run.m.paused]).toEqual(['paused', 'took-over'])
  })

  it('a sign-in or session change ends it at once and leaves nothing on screen', async () => {
    const o = origin()
    await useGuide.getState().start(guidedIntent('show me how swapping experiences works')!, { you: 'x', origin: o })
    const run = useGuide.getState().run
    if (run?.kind !== 'demo') throw new Error('no demo')
    o.live = false
    // a step that finishes after the change does nothing; the next event ends the run
    useGuide.getState().stepDone(run.m.token, { found: true, note: null })
    expect(useGuide.getState().run).toBeNull()
  })

  it('never starts under an origin that no longer holds', async () => {
    const o = origin()
    o.live = false
    expect(await useGuide.getState().start(guidedIntent('show me how memory works')!, { you: 'x', origin: o })).toBe(false)
    expect(useGuide.getState().run).toBeNull()
  })

  it('temporal reasoning: the exact honest answer, the nearest real demos, and Root’s proposed hooks', async () => {
    await useGuide.getState().start(guidedIntent('show me how temporal reasoning works')!, { you: 'show me how temporal reasoning works', origin: origin() })
    const run = useGuide.getState().run
    if (run?.kind !== 'answer') throw new Error('no answer')
    expect(run.text).toBe('Temporal reasoning is being built. The capability set exists but its engine isn’t bound yet. First up: ordering events, time-bound beliefs, and expectations confirmed or missed.')
    expect(run.near.map((s) => s.id)).toEqual(['beliefs', 'memory'])
    expect(run.script?.hooks).toEqual(['temporal-demo-sequence', 'temporal-demo-anticipation'])
    expect(moved).toEqual([]) // an answer moves nothing on screen
    // "show what exists today" and the nearest offers play real demos
    expect(useGuide.getState().play(run.near[0], { origin: run.origin })).toBe(true)
    expect(useGuide.getState().run?.kind).toBe('demo')
  })

  it('an unknown topic and the list say so plainly', async () => {
    await useGuide.getState().start(guidedIntent('show me how cooking works')!, { you: 'x', origin: origin() })
    let run = useGuide.getState().run
    expect(run?.kind === 'answer' && run.text).toBe(unknownAnswer('cooking'))
    await useGuide.getState().start(guidedIntent('what demos are there')!, { you: 'x', origin: origin() })
    run = useGuide.getState().run
    expect(run?.kind === 'answer' && run.text).toBe(listAnswer)
    expect(controlFromWords('stop')).toBe(true)
    expect(useGuide.getState().run).toBeNull()
  })
})

// ---------------------------------------------------------------- the scripts themselves

// read the app's own sources (the same way experiences/ask.test.ts does)
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string, o?: { recursive?: boolean }) => string[] }
const SRC = new URL('../../', import.meta.url).pathname
const sources = (): string[] => fs.readdirSync(SRC, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)).map((f) => `${SRC}${f}`)
const readFileSync = (p: string, e: 'utf8') => fs.readFileSync(p, e)

describe('guided demos: the scripts', () => {
  it('ids are unique; ready demos have steps; stubs have an honest answer, nearest real demos and hooks', () => {
    const ids = GUIDE_SCRIPTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of GUIDE_SCRIPTS) {
      expect(s.triggers.length).toBeGreaterThan(0)
      // a banked demo's steps are read from the hive; its own steps are what exists today
      if (s.status === 'ready') expect(s.steps.length).toBeGreaterThan(s.banked ? 0 : 1)
      else {
        expect(s.answer && s.needs).toBeTruthy()
        expect(s.nearest!.length).toBeGreaterThan(0)
        for (const n of s.nearest!) expect(scriptById(n)?.status).toBe('ready')
        expect(s.hooks!.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every area Quinn asked for, and stubs the modules with no screen yet', () => {
    const ready = GUIDE_SCRIPTS.filter((s) => s.status === 'ready').map((s) => s.id)
    for (const want of ['hive', 'swarms', 'beliefs', 'memory', 'reasoning', 'thinking', 'lab', 'evolve', 'commons-explorer', 'ask', 'experiences', 'apps', 'design', 'code', 'coffee', 'power', 'trust', 'mcp', 'tools-catalogue']) expect(ready).toContain(want)
    // Root's four ready hooks are banked tours; temporal is unavailable (being built); assume's hooks are proposed only
    expect(Object.fromEntries(GUIDE_SCRIPTS.filter((s) => s.banked).map((s) => [s.id, s.banked]))).toEqual({ attention: 'attention-demo-focus', 'self-knowledge': 'skill-demo-nominate', energy: 'energy-demo-reserve', scratch: 'scratch-demo-promotion' })
    const stubs = GUIDE_SCRIPTS.filter((s) => s.status === 'stub').map((s) => s.id)
    expect(stubs.sort()).toEqual(['assume', 'temporal'])
  })

  it('every tour target a script names exists in the app (literally or as a template prefix)', () => {
    const all = sources().map((p) => readFileSync(p, 'utf8')).join('\n')
    const names = new Set<string>()
    for (const s of GUIDE_SCRIPTS) for (const st of s.steps) for (const t of targetsOf(st.target)) if (t.tour) names.add(t.tour)
    const missing = [...names].filter((n) => {
      if (all.includes(`data-tour="${n}"`) || all.includes(`tour="${n}"`) || all.includes(`tour: '${n}'`)) return false
      // templates like data-tour={`experience-${e.id}`}
      const m = n.match(/^(.*-)[^-]+$/)
      return !(m && (all.includes('`' + m[1] + '${') || all.includes(`'${m[1]}' +`)))
    })
    expect(missing).toEqual([])
  })

  it('every region a script names is a real presence region', () => {
    const all = sources().map((p) => readFileSync(p, 'utf8')).join('\n')
    const regions = new Set<string>()
    for (const s of GUIDE_SCRIPTS) for (const st of s.steps) for (const t of targetsOf(st.target)) if (t.region) regions.add(t.region)
    expect([...regions].filter((r) => !all.includes(`data-presence-region="${r}"`))).toEqual([])
  })

  it('no script can decide, spend or change the hive (only reads, previews and harmless UI)', () => {
    const allowed = new Set(['go', 'mind', 'swarm', 'app', 'room', 'ui', 'experience', 'press'])
    for (const s of GUIDE_SCRIPTS)
      for (const st of s.steps) {
        if (!st.do) continue
        expect(Object.keys(st.do).filter((k) => !['belief', 'open'].includes(k)).every((k) => allowed.has(k))).toBe(true)
        if ('go' in st.do) expect(['approvals', 'usage', 'lab', 'hive', 'explore', 'swarms', 'programs', 'code', 'health', 'connect']).toContain(st.do.go.name)
      }
  })

  it('no model identifiers and no private app data in the words', () => {
    const words = JSON.stringify(GUIDE_SCRIPTS)
    expect(words).not.toMatch(/claude-|gpt-|gemini|opus|sonnet|haiku|llama/i)
    expect(words).not.toMatch(/\/Users\/|Omegav2-Codex|pub-drafts/)
  })
})

describe('guided demos: the Omega Tools catalogue stand-in (sim only, invented)', async () => {
  const { omegaTools } = await import('../../api/sim/omegaTools')
  const p = omegaTools()
  const ctx = {} as import('../../api/sim/programs').ProgramCtx

  it('offers inspection and banked examples only: no action runs a tool', async () => {
    const acts = p.describe().actions.map((a) => a.id)
    // demo D3: compose-set is a composition preview (executed: false, registered: false), not a run
    expect(acts).toEqual(['inspect-tool', 'inspect-set', 'inspect-foundation', 'show-examples', 'foundation-examples', 'inspect-demo', 'compose-set'])
    expect(acts.some((a) => /run|exec|native|apply/.test(a))).toBe(false)
    expect(await p.act(ctx, 'run-native', ['t-urgency'], {})).toMatchObject({ status: 'refused' })
  })

  it('banked examples are labelled banked with executed_now false', async () => {
    const r = (await p.act(ctx, 'show-examples', ['t-urgency'], {})) as { detail: { examples: { banked: boolean; executed_now: boolean }[]; executed_now: boolean } }
    expect(r.detail.executed_now).toBe(false)
    expect(r.detail.examples.length).toBeGreaterThan(0)
    expect(r.detail.examples.every((x) => x.banked && x.executed_now === false)).toBe(true)
    const g = p.view(ctx, null, 'map') as { items: { kind: string; label: string }[] }
    for (const x of g.items.filter((i) => i.kind === 'example')) expect(x.label).toMatch(/Banked .*executed now: false/)
    expect(new Set(g.items.map((i) => i.kind))).toEqual(new Set(['tool', 'set', 'foundation', 'component', 'example', 'source', 'demo']))
  })

  it('a module-state focus for an unseen mind is one 404 not_found, as the host answers', () => {
    expect(() => p.view(ctx, 'mind:a_unknown:attention', 'unfold')).toThrow(expect.objectContaining({ status: 404, code: 'not_found' }))
  })
})

describe('guided demos: experience previews are put back exactly', async () => {
  const { liveEnv } = await import('./store')
  const { lookState, previewLook } = await import('../../shell/uiVariant')
  it('previews Still, Construct, Cosmos, then returns to the person’s own look (their earlier preview included)', () => {
    const mine = { variant: null, layout: 'topbar' as const, apps: null, experience: null }
    previewLook(mine)
    liveEnv.experience('still')
    expect(lookState().preview?.experience).toBe('still')
    expect(lookState().preview?.layout).toBe('topbar')
    liveEnv.experience('construct')
    liveEnv.experience('cosmos')
    expect(lookState().preview?.experience).toBe('cosmos')
    liveEnv.experience(null)
    expect(lookState().preview).toBe(mine)
    // and when the demo ends mid-preview, the close puts it back too
    liveEnv.experience('flux')
    useGuide.getState().close()
    expect(lookState().preview).toBe(mine)
    previewLook(null)
  })
})

// ---------------------------------------------------------------- banked tours and the conductor's tour.step

describe('guided demos: banked synthetic tours (Root’s four ready hooks)', async () => {
  const { readBankedStep, readBankedDemo, loadBanked, bankedScript, freshRunHook, BANKED_LABEL, TOOLS_APP } = await import('./banked')
  const { omegaTools, simBankedDemo } = await import('../../api/sim/omegaTools')
  const tools = omegaTools()
  const ctx = {} as import('../../api/sim/programs').ProgramCtx
  const client = (over: Record<string, unknown> = {}) =>
    ({ programView: vi.fn(async (id: string, b: { focus?: string | null; stage?: string }) => (id === TOOLS_APP ? tools.view(ctx, b.focus ?? null, 'detail') : Promise.reject(new Error('no')))), ...over }) as unknown as import('../../api/client').HiveClient
  const good = { id: 's1', explain: 'An invented step.', tool: 'sim-tool', skill: 'sim-skill', arguments: [1], expected_native: [2], contains_native: null, qualification: 'synthetic', state_origin: 'invented' }

  it('reads a step only in the contract’s exact shape, and only when synthetic', () => {
    expect(readBankedStep(good)).toMatchObject({ id: 's1', expected_native: [2], contains_native: null, qualification: 'synthetic' })
    expect(readBankedStep({ ...good, example: 'x' })).not.toBeNull()
    expect(readBankedStep({ ...good, qualification: 'live' })).toBeNull()
    expect(readBankedStep({ ...good, actual: [2] })).toBeNull()
    expect(readBankedStep({ ...good, executed_now: true })).toBeNull()
    expect(readBankedStep({ ...good, contains_native: [2] })).toBeNull() // expected and contains together: not guessed at
    expect(readBankedStep({ ...good, arguments: 'x' })).toBeNull()
    expect(readBankedStep({ ...good, explain: '' })).toBeNull()
  })

  it('the four ready hooks read; the temporal ones are unavailable', () => {
    for (const h of ['attention-demo-focus', 'skill-demo-nominate', 'energy-demo-reserve', 'scratch-demo-promotion']) {
      const d = readBankedDemo(simBankedDemo(h), h)
      expect(d && d !== 'unavailable' && d.steps.length).toBeGreaterThan(1)
    }
    expect(readBankedDemo(simBankedDemo('temporal-demo-sequence'), 'temporal-demo-sequence')).toBe('unavailable')
    expect(readBankedDemo(simBankedDemo('temporal-demo-anticipation'), 'temporal-demo-anticipation')).toBe('unavailable')
    // a card for another hook is not this one
    expect(readBankedDemo(simBankedDemo('energy-demo-reserve'), 'attention-demo-focus')).toBeNull()
  })

  it('reads the script through the Tools app’s own view (focus demo:<hook>); without the app, says so', async () => {
    const c = client()
    const r = await loadBanked('attention-demo-focus', c, true, 's_lyra')
    expect('demo' in r && r.demo.steps.map((x) => x.id)).toEqual(['baseline', 'salience', 'recall'])
    expect(c.programView).toHaveBeenCalledWith(TOOLS_APP, { swarm_id: 's_lyra', focus: 'demo:attention-demo-focus', stage: 'detail' })
    expect(await loadBanked('attention-demo-focus', c, false, 's_lyra')).toEqual({ missing: 'app' })
    expect(await loadBanked('temporal-demo-sequence', c, true, 's_lyra')).toEqual({ missing: 'unavailable' })
    expect(await loadBanked('attention-demo-focus', client({ programView: async () => Promise.reject(new Error('down')) }), true, 's_lyra')).toEqual({ missing: 'unreadable' })
  })

  it('the tour: open the Tools app, one step per banked step (as recorded), then “nothing ran now”', async () => {
    const base = scriptById('attention')!
    const r = await loadBanked('attention-demo-focus', client(), true, 's_lyra')
    const t = bankedScript(base, r)
    expect(t.steps).toHaveLength(6)
    expect(t.steps[0].do).toEqual({ app: TOOLS_APP })
    expect(t.steps[0].say).toMatch(/banked script .* not run now/)
    expect(t.steps.slice(1, 4).map((s) => s.banked?.id)).toEqual(['baseline', 'salience', 'recall'])
    expect(t.steps.slice(1, 4).every((s) => s.banked?.qualification === 'synthetic' && !s.do)).toBe(true)
    expect(t.steps[4].say).toMatch(/Nothing ran now/)
    // then the screen moves to the module's current-state viewer (screen-only; no banked step is shown there)
    expect(t.steps[5]).toMatchObject({ do: { mind: 'tools' }, target: [{ tour: 'module-attention' }, { tour: 'reasoning-modules' }, { region: 'page' }], read: true })
    expect(t.steps[5].banked).toBeUndefined()
    expect(BANKED_LABEL).toBe('Banked / synthetic, not run now')
    // not readable: an honest note, then what exists today
    const today = bankedScript(base, { missing: 'app' })
    expect(today.title).toBe('Attention (ECAN): what exists today')
    expect(today.steps[0].say).toMatch(/^Its banked demo lives in the Omega Tools catalogue, which is not on this hive yet\./)
    expect(today.steps.some((s) => s.banked)).toBe(false)
    expect(today.steps.at(-1)?.target).toEqual([{ tour: 'module-attention' }, { tour: 'reasoning-modules' }, { region: 'page' }])
  })

  it('fresh execution is one named TODO hook that does nothing; no guided code calls the host to run anything', () => {
    expect(freshRunHook('attention-demo-focus', 'baseline')).toEqual({ status: 'waiting-on-platform' })
    const dir = new URL('./', import.meta.url).pathname
    for (const f of fs.readdirSync(dir, { recursive: true }).filter((x) => /\.(ts|tsx)$/.test(x) && !/\.test\./.test(x))) {
      const code = readFileSync(`${dir}${f}`, 'utf8')
      expect(code).not.toMatch(/programAct\(|askActResult|fetch\(|['"`]\/api\/|confirmToken|mind_token|Authorization/)
    }
  })

  it('the banked card is always labelled; a recorded output is never shown as actual', () => {
    const src = readFileSync(new URL('./GuideLayer.tsx', import.meta.url).pathname, 'utf8')
    expect(src).toMatch(/Recorded output \(expected, not actual\)/)
    expect(src).toMatch(/executed now: false/)
    expect(src).not.toMatch(/>\s*(Result|Actual|Output)\s*</)
  })
})

describe('guided demos: the conductor’s tour.step', async () => {
  const { tourStep, setGuideEnv } = await import('./store')
  const { omegaTools } = await import('../../api/sim/omegaTools')
  const { useHive } = await import('../../store/store')
  const tools = omegaTools()
  const ctx = {} as import('../../api/sim/programs').ProgramCtx
  const box = { left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50 }
  const shownEl = { getBoundingClientRect: () => box } as unknown as Element
  const fakeEnv = (): GuideEnv => ({
    go: (r) => void ((loc.hash = `#/${r.name}`), moved.push(loc.hash)),
    picks: () => ({ mind: { id: 'a_vega01', name: 'Vega' }, swarm: { id: 's_lyra', name: 'Lyra' }, belief: null }),
    appEnabled: (id) => id === 'omega-tools',
    ui: () => undefined,
    experience: () => undefined,
    press: () => undefined,
    find: () => shownEl,
    reveal: () => undefined,
    sleep: async () => undefined,
  })
  beforeEach(() => {
    useGuide.getState().close()
    moved.length = 0
    setGuideEnv(fakeEnv())
    useHive.setState({
      client: { programView: async (_id: string, b: { focus?: string | null }) => tools.view(ctx, b.focus ?? null, 'detail') } as never,
      programs: [{ id: 'omega-tools', enabled: true } as never],
      swarms: { s_lyra: { id: 's_lyra', name: 'Lyra' } } as never,
    })
  })
  afterEach(() => {
    useGuide.getState().close()
    setGuideEnv(null)
  })
  const at = () => {
    const r = useGuide.getState().run
    return r?.kind === 'demo' ? { id: r.script.id, step: r.m.step, status: r.m.status, op: r.op } : r?.kind ?? null
  }

  it('places a ready demo at the step asked, plays it, and answers ok once it is shown', async () => {
    const o = origin()
    expect(await tourStep('lab', 2, o, 'ask:op1')).toEqual({ ok: true })
    expect(at()).toEqual({ id: 'lab', step: 2, status: 'ready', op: 'ask:op1' })
    expect(moved.at(-1)).toBe('#/lab')
    const r = useGuide.getState().run
    expect(r?.kind === 'demo' && r.said[2]).toMatch(/^The epistemic bench/)
    // the next step of the same demo moves the same run
    const id = r?.id
    expect(await tourStep('lab', 3, o, 'ask:op1')).toEqual({ ok: true })
    expect(at()).toMatchObject({ id: 'lab', step: 3, status: 'ready' })
    expect(useGuide.getState().run?.id).toBe(id)
    // reduced motion: shown in place, answered as such
    expect(await tourStep('lab', 1, o, 'ask:op1', true)).toEqual({ ok: true, reason: 'reduced_motion_skipped' })
  })

  it('unknown scripts and steps out of range change nothing', async () => {
    const o = origin()
    expect(await tourStep('no-such-demo', 0, o)).toEqual({ ok: false, reason: 'not_declared' })
    expect(await tourStep('lab', 99, o)).toEqual({ ok: false, reason: 'not_declared' })
    expect(useGuide.getState().run).toBeNull()
  })

  it('the person always wins: a demo they paused is blocked, one they took over is stale_origin', async () => {
    const o = origin()
    await tourStep('hive', 0, o, 'ask:op2')
    useGuide.getState().send({ type: 'pause' })
    expect(await tourStep('hive', 1, o, 'ask:op2')).toEqual({ ok: false, reason: 'blocked' })
    useGuide.getState().send({ type: 'resume' })
    useGuide.getState().send({ type: 'takeover' })
    expect(await tourStep('hive', 1, o, 'ask:op2')).toEqual({ ok: false, reason: 'stale_origin' })
    expect(at()).toMatchObject({ step: 0, status: 'paused' })
    const gone = origin()
    gone.live = false
    expect(await tourStep('hive', 1, gone)).toEqual({ ok: false, reason: 'stale_origin' })
  })

  it('temporal (unavailable): its honest “being built” answer is shown, and the act answers blocked', async () => {
    expect(await tourStep('temporal', 0, origin(), 'ask:op3')).toEqual({ ok: false, reason: 'blocked' })
    const r = useGuide.getState().run
    expect(r?.kind === 'answer' && r.text).toMatch(/^Temporal reasoning is being built\./)
    expect(moved).toEqual([])
  })

  it('a step reached by a jump is set up again by the nearest earlier action; in order, it is not', async () => {
    const { actionFor } = await import('./store')
    const lab = scriptById('lab')!.steps
    expect(actionFor(lab, 1, 0)).toBeUndefined()
    expect(actionFor(lab, 1, undefined)).toEqual({ go: { name: 'lab' } })
    expect(actionFor(lab, 1, 3)).toEqual({ go: { name: 'lab' } })
    expect(actionFor(lab, 1, 1)).toEqual({ go: { name: 'lab' } }) // resumed: the person may have moved away
    expect(actionFor(lab, 2, 1)).toEqual(lab[2].do)
  })

  it('handed to the orchestrator: a turn that ends without placing a step plays the demo here, and says so', async () => {
    const { expectConducted } = await import('./store')
    const o = origin()
    const turnOf = (state: string, tookOver = false) => ({ state, tookOver }) as never
    useAskStore.setState({ turns: { 'ask:f1': turnOf('open'), 'ask:f2': turnOf('open'), 'ask:f3': turnOf('open') }, log: [] })
    const g = guidedIntent('walk me through the lab') as Extract<ReturnType<typeof guidedIntent>, { kind: 'script' }>
    expectConducted('ask:f1', g, { you: 'walk me through the lab', origin: o })
    useAskStore.setState({ turns: { ...useAskStore.getState().turns, 'ask:f1': turnOf('done') } })
    await vi.waitFor(() => expect(at()).toMatchObject({ id: 'lab', step: 0 }))
    expect(useAskStore.getState().log.some((e) => e.kind === 'row' && /^The orchestrator did not guide this one, so it plays here\. Guided demo: The Lab/.test(e.row.text))).toBe(true)
    useGuide.getState().close()
    // a turn whose conductor placed a step needs no fallback
    expectConducted('ask:f2', g, { you: 'x', origin: o })
    await tourStep('hive', 0, o, 'ask:f2')
    useGuide.getState().close()
    useAskStore.setState({ turns: { ...useAskStore.getState().turns, 'ask:f2': turnOf('done') } })
    await Promise.resolve()
    expect(useGuide.getState().run).toBeNull()
    // nor one the person took over
    expectConducted('ask:f3', g, { you: 'x', origin: o })
    useAskStore.setState({ turns: { ...useAskStore.getState().turns, 'ask:f3': turnOf('done', true) } })
    await Promise.resolve()
    expect(useGuide.getState().run).toBeNull()
  })

  it('a banked tour reads its script first, then shows each banked step as recorded', async () => {
    const o = origin()
    expect(await tourStep('attention', 0, o, 'ask:op4')).toEqual({ ok: true })
    expect(moved.at(-1)).toBe('#/program')
    expect(await tourStep('attention', 2, o, 'ask:op4')).toEqual({ ok: true })
    const r = useGuide.getState().run
    if (r?.kind !== 'demo') throw new Error('no demo')
    // 3 banked steps between the opening and "nothing ran now", then the move to the module's viewer
    expect(r.m.total).toBe(6)
    expect(r.script.steps[2].banked).toMatchObject({ id: 'salience', qualification: 'synthetic' })
    expect(r.said[2]).toBe(r.script.steps[2].banked!.explain)
  })
})

describe('guided demos: the simulator’s conductor drives “show me how attention works” with tour.step', async () => {
  const { SimAsk } = await import('../../api/sim/ask')
  type AskEvent = import('../../api/ask').AskEvent
  it('one tour.step at a time, the next only after the page’s result, then the answer and done', () => {
    const emitted: AskEvent[] = []
    const later: (() => void)[] = []
    const sim = new SimAsk({
      emit: (e) => emitted.push(e),
      later: (_ms, fn) => later.push(fn),
      agents: () => [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' } as never],
      swarms: () => [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' } as never],
      goals: () => [],
      principal: () => 'user:p_ada',
    })
    const flush = () => {
      while (later.length) later.shift()!()
    }
    sim.ask({ operation_id: 'ask:tour0001', text: 'show me how attention works', context: { route: 'hive', experience: 'classic' }, via: 'typed' })
    flush()
    const acts = () => emitted.filter((e) => e.phase === 'act') as Extract<AskEvent, { phase: 'act' }>[]
    expect(acts().map((a) => a.act)).toEqual([expect.objectContaining({ kind: 'tour.step', script: 'attention', step: 0 })])
    expect(emitted.some((e) => e.phase === 'done')).toBe(false)
    const ok = { ok: true, view: {}, route: 'program', experience: 'classic' }
    for (let i = 0; i < 6; i++) {
      sim.actResult('ask:tour0001', acts()[i].act.act_id, ok)
      flush()
    }
    expect(acts().map((a) => (a.act as { step: number }).step)).toEqual([0, 1, 2, 3, 4, 5])
    expect(emitted.filter((e) => e.phase === 'answer').at(-1)).toMatchObject({ text: expect.stringMatching(/^That was Attention \(ECAN\), in 6 steps\./) })
    expect(emitted.at(-1)?.phase).toBe('done')
  })

  it('a step the page could not show ends the tour honestly', () => {
    const emitted: AskEvent[] = []
    const later: (() => void)[] = []
    const sim = new SimAsk({ emit: (e) => emitted.push(e), later: (_ms, fn) => later.push(fn), agents: () => [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' } as never], swarms: () => [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' } as never], goals: () => [], principal: () => 'user:p_ada' })
    sim.ask({ operation_id: 'ask:tour0002', text: 'walk me through the lab', context: { route: 'hive', experience: 'classic' }, via: 'typed' })
    while (later.length) later.shift()!()
    const first = emitted.find((e) => e.phase === 'act') as Extract<AskEvent, { phase: 'act' }>
    sim.actResult('ask:tour0002', first.act.act_id, { ok: false, reason: 'stale_origin', view: {}, route: 'lab', experience: 'classic' })
    while (later.length) later.shift()!()
    expect(emitted.filter((e) => e.phase === 'act')).toHaveLength(1)
    expect(emitted.filter((e) => e.phase === 'answer').at(-1)).toMatchObject({ text: expect.stringMatching(/stopped guiding .* at step 1 of 4: you took over/) })
  })
})

// ---------------------------------------------------------------- stand-in r1: the person's controls, colours, announcements

describe('guided demos: every control the person uses takes the demo from the conductor (stand-in r1 P2)', async () => {
  const { tourStep, setGuideEnv } = await import('./store')
  // (imported in each test that uses them: controls.ts is new in r2)
  const controls = () => import('./controls')
  const { useHive } = await import('../../store/store')
  const shownEl = { getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50 }) } as unknown as Element
  const env = (): GuideEnv => ({
    go: (r) => void ((loc.hash = `#/${r.name}`), moved.push(loc.hash)),
    picks: () => ({ mind: null, swarm: null, belief: null }),
    appEnabled: () => false,
    ui: () => undefined,
    experience: () => undefined,
    press: () => undefined,
    find: () => shownEl,
    reveal: () => undefined,
    sleep: async () => undefined,
  })
  const LAST = scriptById('lab')!.steps.length - 1
  let n = 0
  /** a conducted tour of the Lab, placed at `step` by the orchestrator's turn (open, not taken over) */
  const conducted = async (step: number) => {
    useGuide.getState().close()
    const op = `ask:held${++n}`
    const turn = { op, you: 'walk me through the lab', state: 'open', lastSeq: 0, events: [], outcomes: {}, notes: [], steers: [], moves: 0, tookOver: false, presence: 0, ahead: [] }
    useAskStore.setState({ open: op, turns: { ...useAskStore.getState().turns, [op]: turn } } as never)
    const o = origin()
    expect(await tourStep('lab', step, o, op)).toEqual({ ok: true })
    const r = useGuide.getState().run
    if (r?.kind !== 'demo') throw new Error('no demo')
    return { op, o, id: r.id }
  }
  const tookOver = (op: string) => useAskStore.getState().turns[op]?.tookOver
  const where = () => {
    const r = useGuide.getState().run
    // the demo's own progress (its step finishing: running → ready) is not the conductor's; where it is, is
    return r?.kind === 'demo' ? { id: r.id, step: r.m.step, ended: r.m.ended ?? null } : r
  }
  beforeEach(() => {
    useGuide.getState().close()
    moved.length = 0
    setGuideEnv(env())
    useHive.setState({ programs: [] })
  })
  afterEach(() => {
    useGuide.getState().close()
    setGuideEnv(null)
    useAskStore.setState({ open: null })
  })

  it('the buttons (Back, Pause, Next, Stop): the conductor’s next step can neither override nor rewind them', async () => {
    const { guideButtons } = await controls()
    const { personAct } = await import('./store')
    const r0 = await conducted(1)
    const run = useGuide.getState().run
    if (run?.kind !== 'demo') throw new Error('no demo')
    expect(guideButtons(run).map((b) => b.label)).toEqual(['Back', 'Pause', 'Next', 'Stop'])
    for (const label of ['Back', 'Pause', 'Next', 'Stop']) {
      const { op, o } = label === 'Back' ? r0 : await conducted(1)
      const r = useGuide.getState().run
      if (r?.kind !== 'demo') throw new Error('no demo')
      personAct(guideButtons(r).find((b) => b.label === label)!.act)
      expect([label, tookOver(op)]).toEqual([label, true])
      const after = where()
      // the step the conductor had scheduled next arrives: it is the person's demo now
      expect(await tourStep('lab', 2, o, op)).toEqual({ ok: false, reason: 'stale_origin' })
      expect([label, where()]).toEqual([label, after])
    }
  })

  it('Finish, Play again and Close: a demo the person ended is never restarted by the conductor', async () => {
    const { guideButtons } = await controls()
    const { personAct } = await import('./store')
    for (const label of ['Finish', 'Play again', 'Close']) {
      const { op, o, id } = await conducted(LAST)
      let r = useGuide.getState().run
      if (r?.kind !== 'demo') throw new Error('no demo')
      if (label !== 'Finish') {
        personAct(guideButtons(r).find((b) => b.label === 'Finish')!.act)
        r = useGuide.getState().run
        if (r?.kind !== 'demo') throw new Error('no demo')
        useAskStore.setState({ turns: { ...useAskStore.getState().turns, [op]: { ...useAskStore.getState().turns[op], tookOver: false } } })
      }
      const b = guideButtons(r).find((x) => x.label === label)!
      expect(b).toBeDefined()
      personAct(b.act)
      expect([label, tookOver(op)]).toEqual([label, true])
      const after = where()
      expect(await tourStep('lab', LAST, o, op)).toEqual({ ok: false, reason: 'stale_origin' })
      expect(await tourStep('lab', 0, o, op)).toEqual({ ok: false, reason: 'stale_origin' })
      expect([label, where()]).toEqual([label, after])
      if (label === 'Finish') expect(after).toMatchObject({ id, ended: 'done' })
      useGuide.getState().close()
    }
  })

  it('the keys (← → Space Esc) in the demo’s controls do the same', async () => {
    const { guideKeys } = await controls()
    vi.stubGlobal('HTMLElement', class {})
    for (const key of ['ArrowLeft', 'ArrowRight', ' ', 'Escape']) {
      const { op, o } = await conducted(1)
      guideKeys({ key, target: null, preventDefault: () => undefined } as never)
      expect([key, tookOver(op)]).toEqual([key, true])
      const after = where()
      expect(await tourStep('lab', 2, o, op)).toEqual({ ok: false, reason: 'stale_origin' })
      expect([key, where()]).toEqual([key, after])
    }
  })

  it('typed controls ("next", "go back", "start over", "hold on", "stop") do the same', async () => {
    for (const words of ['next', 'go back', 'start over', 'hold on', 'stop']) {
      const { op, o } = await conducted(1)
      expect(controlFromWords(words)).toBe(true)
      expect([words, tookOver(op)]).toEqual([words, true])
      const after = where()
      expect(await tourStep('lab', 2, o, op)).toEqual({ ok: false, reason: 'stale_origin' })
      expect([words, where()]).toEqual([words, after])
    }
  })
})

describe('guided demos: colours are the experience’s own tokens, readable in every experience (stand-in r1 #4)', async () => {
  const { flatten, ratio, parse } = await import('../../experiences/canvas/contrast')
  const { CLASSIC_CHROME } = await import('../../experiences/chrome')
  const { chromeForMode } = await import('../../experiences/canvas/chrome')
  const chromes: [string, import('../../experiences/chrome').ExperienceChrome][] = [
    ['classic', CLASSIC_CHROME],
    ['still', (await import('../../experiences/still/chrome')).chrome],
    ['construct', (await import('../../experiences/construct/chrome')).chrome],
    ['cosmos', (await import('../../experiences/cosmos/chrome')).chrome],
    ['flux', (await import('../../experiences/flux/chrome')).chrome],
    ['canvas light', chromeForMode('light')],
    ['canvas dark', chromeForMode('dark')],
  ]
  const css = readFileSync(`${SRC}features/guided/guided.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const defined = new Set([...readFileSync(`${SRC}index.css`, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g), ...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

  it('no literal colour, and every token it reads is defined (no fallback left to stand in)', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/gi)).toBeNull()
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)\s*[,)]/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(10)
    // the beacon's start point is written by GuideLayer itself (style --from-x / --from-y), not a colour
    const inline = new Set([...readFileSync(`${SRC}features/guided/GuideLayer.tsx`, 'utf8').matchAll(/'(--[a-z0-9-]+)' as string/g)].map((m) => m[1]))
    expect(used.filter((v) => !defined.has(v) && !inline.has(v))).toEqual([])
    expect(css).not.toMatch(/var\(--[a-z0-9-]+\s*,/)
  })

  it('caption text, buttons, focus ring and presence meet WCAG 2 in every experience, light and dark', () => {
    // what is measured below is what guided.css draws: the caption in the chrome, the shared parts re-pointed at it
    const rule = (sel: string) => css.match(new RegExp(`(^|\\n)${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[2] ?? ''
    const caption = rule('.guide-caption')
    expect(caption).toMatch(/background: var\(--xc-texture\), var\(--xc-surface\);/)
    expect(caption).toMatch(/border: 1px solid var\(--xc-edge\);/)
    expect(caption).toMatch(/\n\s*color: var\(--xc-ink\);/)
    for (const [k, v] of [['--color-ink', '--xc-ink'], ['--color-ink-2', '--xc-ink-2'], ['--color-ink-3', '--xc-ink-3'], ['--color-accent', '--xc-accent']]) expect(caption).toContain(`${k}: var(${v});`)
    expect(rule(".guide-btn[data-tone='primary']")).toMatch(/background: color-mix\(in srgb, var\(--color-accent\) 18%, transparent\);/)
    expect(rule('.guide-btn')).toMatch(/border: 1px solid color-mix\(in srgb, currentColor 60%, transparent\);/)
    expect(rule('.guide-btn:focus-visible')).toMatch(/outline: 2px solid var\(--color-accent\);/)
    expect(rule('.guide-glow')).toMatch(/0 0 0 2px var\(--xc-accent\)/)
    expect(rule('.guide-note,\n.guide-status')).toMatch(/color: var\(--color-ink-3\);/)
    expect(rule('.guide-badge')).toMatch(/color: var\(--color-ink-2\);/)
    const mixed = (c: string, pct: number) => {
      const p = parse(c)
      return `rgb(${p[0]} ${p[1]} ${p[2]} / ${p[3] * pct})`
    }
    const rows: string[] = []
    for (const [name, c] of chromes) {
      // the caption's surface over the worst backdrop (it may be glass)
      for (const backdrop of ['#000000', '#ffffff']) {
        const surface = flatten(c.surface, backdrop)
        const bg = `rgb(${surface[0]} ${surface[1]} ${surface[2]})`
        const primary = flatten(mixed(c.accent, 0.18), bg)
        const pairs: [string, number, number][] = [
          ['ink', ratio(flatten(c.ink, bg), surface), 4.5],
          ['ink-2 (badges)', ratio(flatten(c.ink2, bg), surface), 4.5],
          ['ink-3 (notes, status)', ratio(flatten(c.ink3, bg), surface), 4.5],
          ['ink on the primary button', ratio(flatten(c.ink, bg), primary), 4.5],
          ['accent (focus ring, presence)', ratio(flatten(c.accent, bg), surface), 3],
          ['button edge (ink 60%)', ratio(flatten(mixed(c.ink, 0.6), bg), surface), 3],
          ['caption edge', ratio(flatten(c.edge, bg), surface), 3],
        ]
        for (const [pair, r, min] of pairs) {
          rows.push(`${name} on ${backdrop}: ${pair} ${r.toFixed(2)}:1 (min ${min})`)
          expect([name, backdrop, pair, r >= min]).toEqual([name, backdrop, pair, true])
        }
      }
    }
    expect(rows.length).toBe(chromes.length * 2 * 7)
  })
})

describe('guided demos: what a screen reader hears (stand-in r1 #5)', async () => {
  const { BANKED_LABEL } = await import('./banked')
  const announcement = async (...a: Parameters<typeof import('./controls').announcement>) => (await import('./controls')).announcement(...a)
  const banked = { id: 's1', explain: 'An invented step.', tool: 'sim-tool', skill: 'sim-skill', arguments: [1], expected_native: [2], contains_native: null, qualification: 'synthetic' as const, state_origin: 'invented' }
  const run = (over: Partial<import('./machine').GuideMachine> = {}, steps = [{ say: 'Opens it.' }, { say: 'An invented step.', banked }]) => {
    const m = { ...startMachine(steps.length, false, 1), status: 'ready' as const, ...over }
    return { kind: 'demo' as const, id: 1, script: { id: 'x', title: 'Invented', status: 'ready', standing: '', triggers: [], steps } as never, m, origin: origin(), bind: { epoch: 0, current: () => true, commit: <R,>(w: () => R) => w() }, from: '#/', picks: { mind: null, swarm: null, belief: null }, said: ['Opens it.', 'An invented step.'], note: null, found: true }
  }

  it('a banked step is announced with its qualification, never as a result', async () => {
    const said = await announcement(run(), false)
    expect(said).toContain(BANKED_LABEL)
    expect(said).toContain('executed now: false')
    expect(said.indexOf(BANKED_LABEL)).toBeLessThan(said.indexOf('An invented step.'))
    // a plain step says no such thing
    expect(await announcement(run({ step: 0 }), false)).not.toContain(BANKED_LABEL)
  })

  it('nothing is announced while a modal holds the screen (the demo is hidden and inert under it)', async () => {
    expect(await announcement(run(), true)).toBe('')
    expect(await announcement(run({ status: 'paused', paused: 'took-over' }), true)).toBe('')
    expect(await announcement(run({ status: 'ended', ended: 'done' }), true)).toBe('')
    expect(await announcement(run({ status: 'ended', ended: 'done' }), false)).toBe('Demo finished.')
  })
})

describe('guided demos: the thread card labels every banked transcript entry, playing and ended (stand-in r2)', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { GuideCardView } = await import('./GuideLayer')
  const { bankedScript } = await import('./banked')
  const { setGuideEnv } = await import('./store')
  // the wording the card itself uses (BANKED_LABEL; executed now: false), as one phrase
  const QUAL = 'Banked / synthetic, not run now; executed now: false'
  const step = (n: number) => ({ id: `s${n}`, explain: `Invented banked step ${n}.`, tool: 'sim-tool', skill: 'sim-skill', arguments: [n], expected_native: [n], contains_native: null, qualification: 'synthetic' as const, state_origin: 'invented' })
  const script = bankedScript(scriptById('attention')!, { demo: { id: 'attention-demo-focus', title: 'Invented', module: 'attention', qualification: 'synthetic', steps: [step(1), step(2), step(3)] } })
  // the thread card exactly as GuideCard renders it for the run now in the store
  const render = () => renderToStaticMarkup(createElement(GuideCardView, { run: useGuide.getState().run }))
  /** the transcript's entries, each as its rendered text */
  const entries = (html: string) => [...(html.match(/<ol class="guide-said">([\s\S]*?)<\/ol>/)?.[1] ?? '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))
  const demo = () => {
    const r = useGuide.getState().run
    if (r?.kind !== 'demo') throw new Error('no demo')
    return r
  }
  const shownThen = (e: import('./machine').GuideEvent) => {
    useGuide.getState().stepDone(demo().m.token, { found: true, note: null })
    useGuide.getState().send(e)
  }
  beforeEach(() => {
    setGuideEnv(null)
    useGuide.getState().close()
    expect(useGuide.getState().play(script, { origin: origin() })).toBe(true)
  })
  afterEach(() => useGuide.getState().close())
  /** every banked entry carries the qualification, and no other entry does */
  const labelledExactly = (html: string, banked: number[]) => {
    const es = entries(html)
    expect(es.length).toBeGreaterThan(0)
    es.forEach((t, i) => expect([i, t.includes(QUAL)]).toEqual([i, banked.includes(i)]))
    for (const i of banked) expect(es[i]).toMatch(new RegExp(`^${QUAL.replace(/[/()]/g, '\\$&')} Invented banked step ${i}\\.$`))
  }

  it('advancing: each banked step said so far is labelled, not only the current one', () => {
    shownThen({ type: 'next' })
    shownThen({ type: 'next' })
    shownThen({ type: 'next' })
    useGuide.getState().stepDone(demo().m.token, { found: true, note: null })
    expect(demo().m.step).toBe(3)
    labelledExactly(render(), [1, 2, 3])
  })

  it('stopping: the card is gone, the transcript’s banked entries keep their qualification', () => {
    shownThen({ type: 'next' })
    shownThen({ type: 'next' })
    shownThen({ type: 'stop' })
    expect([demo().m.status, demo().m.ended]).toEqual(['ended', 'stopped'])
    const html = render()
    expect(html).not.toContain('class="guide-banked"')
    labelledExactly(html, [1, 2])
  })

  it('finishing: every banked entry stays labelled after the demo ends', () => {
    for (let i = 0; i < script.steps.length; i++) shownThen({ type: 'next' })
    expect([demo().m.status, demo().m.ended]).toEqual(['ended', 'done'])
    const html = render()
    expect(html).not.toContain('class="guide-banked"')
    labelledExactly(html, [1, 2, 3])
  })
})

describe('the deferred reveal after a reading step reflows its sheet is fenced (Root 173503Z)', async () => {
  const { liveEnv, deferredRevealPending, cancelDeferredReveal, setGuideEnv } = await import('./store')
  const { useHive } = await import('../../store/store')
  const origin = () => {
    const o = { client: null, session: 's', inits: 1, principal: 'user:test', auth: null, epoch: 0, live: true, ok: () => o.live }
    return o as unknown as AskOrigin
  }
  const script = { ...scriptById('attention')!, banked: undefined, steps: [{ say: 'a', target: { tour: 'x' } }, { say: 'b', target: { tour: 'module-attention' }, read: true as const }] }
  /** a target in a phone sheet left with 10px to read in (a short screen): the reveal presses the sheet open and defers */
  function fake() {
    const n = { clicks: 0, measures: 0 }
    const snap = { isConnected: true, getAttribute: () => 'false', click: () => void n.clicks++ }
    const el = {
      isConnected: true,
      parentElement: { getBoundingClientRect: () => ({ top: 500, bottom: 510 }), parentElement: null },
      closest: () => ({ querySelector: () => snap }),
      getBoundingClientRect: () => (n.measures++, { top: 600, bottom: 700, left: 0, right: 300, height: 100, width: 300 }),
    }
    return { el: el as unknown as Element, raw: el, n }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'auto' }))
    vi.stubGlobal('document', { body: null, documentElement: { dataset: {} }, scrollingElement: null })
    setGuideEnv(null)
    useGuide.getState().close()
    expect(useGuide.getState().play(script, { origin: origin() })).toBe(true)
  })
  afterEach(() => {
    cancelDeferredReveal()
    useGuide.getState().close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined })
  })
  const demo = () => useGuide.getState().run as Extract<NonNullable<ReturnType<typeof useGuide.getState>['run']>, { kind: 'demo' }>
  /** reveal, then the cancel path, then the timer: the callback must not measure or press anything */
  const after = (cancel: (f: ReturnType<typeof fake>) => void) => {
    const f = fake()
    liveEnv.reveal(f.el, true)
    expect([f.n.clicks, deferredRevealPending()]).toEqual([1, true])
    cancel(f)
    const at = { ...f.n }
    vi.advanceTimersByTime(1000)
    return { f, at }
  }

  it('holding (same run, step and person): it reveals again once the sheet has opened', () => {
    const { f, at } = after(() => undefined)
    expect(f.n.measures).toBeGreaterThan(at.measures)
  })
  it('Stop: nothing after', () => {
    const { f, at } = after(() => useGuide.getState().send({ type: 'stop' }))
    expect([deferredRevealPending(), f.n]).toEqual([false, at])
  })
  it('Finish (the last step’s Next): nothing after', () => {
    const { f, at } = after(() => {
      useGuide.getState().stepDone(demo().m.token, { found: true, note: null })
      useGuide.getState().send({ type: 'next' })
      useGuide.getState().stepDone(demo().m.token, { found: true, note: null })
      useGuide.getState().send({ type: 'next' })
      expect(demo().m.status).toBe('ended')
    })
    expect([deferredRevealPending(), f.n]).toEqual([false, at])
  })
  it('another step or a new run: nothing after', () => {
    const one = after(() => useGuide.getState().send({ type: 'next' }))
    expect(one.f.n).toEqual(one.at)
    const two = after(() => useGuide.getState().play(script, { origin: origin() }))
    expect([deferredRevealPending(), two.f.n]).toEqual([false, two.at])
  })
  it('a person change: nothing after, nothing pressed for the previous person', () => {
    const { f, at } = after(() => useHive.setState({ session: `other-${Math.random()}` }))
    expect([deferredRevealPending(), f.n]).toEqual([false, at])
  })
  it('a desktop panel with no room and no Expand control: its yielding bands step aside for the step, then it reveals again', async () => {
    const { holdAsks, markDemo } = await import('./reading')
    const n = { measures: 0 }
    const el = {
      isConnected: true,
      parentElement: { getBoundingClientRect: () => ({ top: 273, bottom: 392 }), parentElement: null },
      closest: () => ({ querySelector: (q: string) => (q.includes('data-reading-yields') ? {} : null) }),
      getBoundingClientRect: () => (n.measures++, { top: 273, bottom: 403, left: 0, right: 300, height: 130, width: 300 }),
    } as unknown as Element
    const root = (document as unknown as { documentElement: HTMLElement }).documentElement
    liveEnv.reveal(el, true)
    expect([root.dataset.guideReflow, deferredRevealPending()]).toEqual(['', true])
    const at = n.measures
    vi.advanceTimersByTime(100)
    expect(n.measures).toBeGreaterThan(at)
    // ended with the step (holdAsks' release) or the demo (markDemo's release)
    holdAsks(root)()
    expect(root.dataset.guideReflow).toBeUndefined()
    root.dataset.guideReflow = ''
    markDemo(root)()
    expect(root.dataset.guideReflow).toBeUndefined()
  })
  it('lifecycle (Root 184433Z): a loading card that fits, then grows past an animated frame that settles smaller: the room is made once for the step, then the step ends and it is released', async () => {
    const { layoutReading } = await import('./store')
    const { ReadingRoom, holdAsks } = await import('./reading')
    const root = (document as unknown as { documentElement: HTMLElement }).documentElement
    // the panel's scrollport [273, frameBottom] (animating), the card [273, 273 + card] (loading, then resolved)
    const geo = { frameBottom: 410, card: 120 }
    const el = {
      isConnected: true,
      parentElement: { getBoundingClientRect: () => ({ top: 273, bottom: geo.frameBottom }), parentElement: null },
      closest: () => ({ querySelector: (q: string) => (q.includes('data-reading-yields') ? {} : null) }),
      getBoundingClientRect: () => ({ top: 273, bottom: 273 + geo.card, left: 1005, right: 1202, height: geo.card, width: 197 }),
    } as unknown as Element
    const room = new ReadingRoom()
    const key = () => `${demo().id}:${demo().m.token}:1`
    const measure = () => layoutReading(el, { width: 380, height: 147 }, { width: 1440, height: 438 }, [], null, room, key())
    // 1. the loading card fits the frame as it animates in: no room made
    expect(measure().roomMade).toBe(false)
    expect(root.dataset.guideReflow).toBeUndefined()
    // 2. the card resolves (130) while the frame settles smaller (392): no longer fits, the room is made, once
    geo.card = 130
    geo.frameBottom = 392
    expect(measure().roomMade).toBe(true)
    expect([root.dataset.guideReflow, deferredRevealPending()]).toEqual(['', true])
    // 3. later measurements of the same step (still not fitting, reveal pending or not): never again
    expect(measure().roomMade).toBe(false)
    vi.advanceTimersByTime(100)
    geo.frameBottom = 380
    expect(measure().roomMade).toBe(false)
    // 4. the step ends (its release): the reflow goes, and a new step starts afresh
    holdAsks(root)()
    expect(root.dataset.guideReflow).toBeUndefined()
    room.release()
    expect(measure().roomMade).toBe(true)
    cancelDeferredReveal()
  })
  it('lifecycle: pure content growth inside an unchanged band (the clipped box unchanged) still makes the room, once', async () => {
    const { layoutReading } = await import('./store')
    const { ReadingRoom, sameMeasure } = await import('./reading')
    const root = (document as unknown as { documentElement: HTMLElement }).documentElement
    delete root.dataset.guideReflow
    const geo = { card: 119 }
    const el = {
      isConnected: true,
      parentElement: { getBoundingClientRect: () => ({ top: 273, bottom: 392 }), parentElement: null },
      closest: () => ({ querySelector: (q: string) => (q.includes('data-reading-yields') ? {} : null) }),
      getBoundingClientRect: () => ({ top: 273, bottom: 273 + geo.card, left: 1005, right: 1202, height: geo.card, width: 197 }),
    } as unknown as Element
    const room = new ReadingRoom()
    const key = `${demo().id}:${demo().m.token}:1`
    const m = () => { const b = el.getBoundingClientRect(); return { el, band: { top: 273, bottom: 392 }, box: { left: b.left, top: b.top, right: b.right, bottom: Math.min(392, b.bottom) }, full: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } } }
    const first = m()
    expect(layoutReading(el, { width: 380, height: 147 }, { width: 1440, height: 438 }, [], null, room, key).roomMade).toBe(false)
    geo.card = 130
    const second = m()
    // the clipped box is the same; the measurement is not (GuideLayer's useTargetBox keeps it, so the layout runs again)
    expect([first.box, sameMeasure(first, second)]).toEqual([second.box, false])
    expect(layoutReading(el, { width: 380, height: 147 }, { width: 1440, height: 438 }, [], null, room, key).roomMade).toBe(true)
    expect(root.dataset.guideReflow).toBe('')
    expect(layoutReading(el, { width: 380, height: 147 }, { width: 1440, height: 438 }, [], null, room, key).roomMade).toBe(false)
    cancelDeferredReveal()
    delete root.dataset.guideReflow
  })
  it('stand-in r6 P2: after the person takes over (and while paused), the reading layout never scrolls, reflows or makes room; it moves again only once resumed', async () => {
    const { readingStepLayout, readingMayMove } = await import('./store')
    const { ReadingRoom } = await import('./reading')
    const root = (document as unknown as { documentElement: HTMLElement }).documentElement
    delete root.dataset.guideReflow
    const scrolls: number[] = []
    // an oversized viewer aligned under the caption; then the person scrolls it down 130px themselves
    const geo = { top: 176 }
    const scroller = { getBoundingClientRect: () => ({ top: 100, bottom: 700 }), parentElement: null, scrollHeight: 4000, clientHeight: 600, scrollBy: (o: { top: number }) => void scrolls.push(o.top) }
    const el = {
      isConnected: true,
      parentElement: scroller,
      closest: () => ({ querySelector: (q: string) => (q.includes('data-reading-yields') ? {} : null) }),
      getBoundingClientRect: () => ({ top: geo.top, bottom: geo.top + 1400, left: 0, right: 372, height: 1400, width: 372 }),
    } as unknown as Element
    const room = new ReadingRoom()
    const tries = { current: '' }
    const layout = () => readingStepLayout(el, { width: 366, height: 160 }, { width: 390, height: 734 }, [], null, room, demo(), 1, tries)
    useGuide.getState().stepDone(demo().m.token, { found: true, note: null })
    expect([demo().m.status, readingMayMove(demo())]).toEqual(['ready', true])
    // positive control, while it plays: misaligned, the layout does move the page (room made, then a corrective scroll)
    geo.top = 300
    layout()
    layout()
    expect(root.dataset.guideReflow === '' || scrolls.length > 0).toBe(true)
    cancelDeferredReveal()
    delete root.dataset.guideReflow
    // the person's own wheel: takeover pauses the demo; their scroll moves the viewer 130px
    useGuide.getState().send({ type: 'takeover' })
    expect([demo().m.status, demo().m.paused, readingMayMove(demo())]).toEqual(['paused', 'took-over', false])
    geo.top = 176 - 130
    scrolls.length = 0
    for (let i = 0; i < 5; i++) {
      const lay = layout()
      expect(lay.roomMade).toBe(false)
      expect(lay.placement.shift).not.toBe(0) // it would ask to pull back; it must not
    }
    expect(scrolls).toEqual([])
    expect([root.dataset.guideReflow, deferredRevealPending()]).toEqual([undefined, false])
    // Pause (not a takeover) and Stop: the same
    useGuide.getState().send({ type: 'resume' })
    useGuide.getState().stepDone(demo().m.token, { found: true, note: null })
    useGuide.getState().send({ type: 'toggle' })
    expect(demo().m.status).toBe('paused')
    layout()
    useGuide.getState().send({ type: 'stop' })
    layout()
    expect(scrolls).toEqual([])
  })
  it('the target left the page: nothing after', () => {
    const { f, at } = after((x) => void (x.raw.isConnected = false))
    expect(f.n).toEqual(at)
  })
})
