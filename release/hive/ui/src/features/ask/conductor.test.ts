import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Ask conductor's executor (ASK_CONDUCTOR_ACTION_VOCABULARY_v1_20261007, Platform-confirmed terms). Played in node
 * with a hand-made page: the hash moves as the router does, the document is a few elements with presence attributes,
 * and the client is a fake that records every act result posted. Invented data only.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
let reduced = false
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: reduced }), innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
type FakeEl = { sel: string; getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number; width: number; height: number }; closest: () => null; scrollIntoView: ReturnType<typeof vi.fn>; getAttribute: (k: string) => string | null }
const els: FakeEl[] = []
const el = (sel: string, region?: string): FakeEl => ({ sel, getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50 }), closest: () => null, scrollIntoView: vi.fn(), getAttribute: (k) => (k === 'data-presence-region' ? region ?? null : null) })
vi.stubGlobal('document', {
  documentElement: { style: { removeProperty() {}, setProperty() {} }, dataset: {} },
  querySelectorAll: (sel: string) => (sel === '[data-presence-region]' ? els.filter((e) => e.getAttribute('data-presence-region')) : els.filter((e) => e.sel === sel)),
  querySelector: () => null,
  scrollingElement: null,
})
vi.mock('../../lib/router', async (orig) => {
  const real = await orig<typeof import('../../lib/router')>()
  return { ...real, navigate: (r: import('../../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { ACT_REASONS, checkAct, checkAskEvent } = await import('../../api/ask')
const { markUnsaved } = await import('./dirty')
const { fitView, decodeSegment, isPrivateApp, isPrivateHash } = await import('./view')
const { askContext } = await import('./context')
const { parse } = await import('../../lib/router')
const { ApiError } = await import('../../api/client')
const { useHive } = await import('../../store/store')
const { threadRows, useAskStore } = await import('../../store/ask')
const { ACTS_PER_TURN, APP_UNRESOLVED_REASON, conductorSettled, REFUSED_APP_REASON, resetConductor } = await import('./conductor')
const { newSession, sessionKey } = await import('../../store/programSession')
const { declareFieldForTest } = await import('./fields')
const { lookState, previewLook } = await import('../../shell/uiVariant')
const { SimAsk } = await import('../../api/sim/ask')
type AskEvent = import('../../api/ask').AskEvent
type ActResult = import('../../api/ask').ActResult
type HiveClient = import('../../api/client').HiveClient

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
let posted: { op: string; act: string; body: ActResult }[] = []
let answerWith: (act: string) => Promise<unknown> = async () => ({ recorded: true })
function fakeClient(over: Partial<HiveClient> = {}): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', events: [], more: false })),
    askTakeover: vi.fn(async () => ({})),
    askActResult: vi.fn(async (op: string, act: string, body: ActResult) => {
      posted.push({ op, act, body })
      return answerWith(act)
    }),
    setUiPrefs: vi.fn(async (p: unknown) => ({ prefs: p, updated_at: '2026-10-07T00:00:00Z' })),
    ...over,
  } as unknown as HiveClient
}

let n = 0
let seq = 0
async function turn(client = fakeClient()) {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await useAskStore.getState().send('show me around motivations', { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  seq = 0
  deliver(op, { phase: 'accepted', thread })
  return op
}
function deliver(op: string, f: Record<string, unknown>) {
  useAskStore.getState().onEvent({ type: 'ask', operation_id: op, turn_id: 't1', seq: ++seq, at: '2026-10-07T10:00:00Z', ...f } as unknown as AskEvent)
}
const act = (op: string, a: Record<string, unknown>) => deliver(op, { phase: 'act', act: { act_id: `act_${seq + 1}`, ...a } })
const rows = () => threadRows(useAskStore.getState())
const result = (actId: string) => posted.find((p) => p.act === actId)?.body

beforeEach(() => {
  posted = []
  answerWith = async () => ({ recorded: true })
  loc.hash = '#/'
  reduced = false
  els.length = 0
  resetConductor()
})
afterEach(() => {
  previewLook(null)
  declareFieldForTest({ id: 'palette.search', label: 'Search the hive', kind: 'search' }, null)
  useAskStore.getState().reset()
})

describe('parser: each kind accepted well-formed, rejected otherwise (never guessed)', () => {
  const good: Record<string, unknown>[] = [
    { kind: 'navigate', route: '#/usage', animate: true },
    { kind: 'open', feature: 'money.usage', entity: { kind: 'swarm', ref: 's_lyra' } },
    { kind: 'look', prefs: { variant: null, layout: 'rail' } },
    { kind: 'point', target: { feature: 'money.usage' }, caption: 'Usage lives here' },
    { kind: 'highlight', target: { region: 'search' }, ink: { shape: 'circle' } },
    { kind: 'fill', field: 'palette.search', text: 'x'.repeat(4000) },
    { kind: 'scroll', to: 'bottom' },
    { kind: 'scroll', target: { region: 'page' } },
    { kind: 'tour.step', script: 'temporal-reasoning', step: 2 },
  ]
  const bad: Record<string, unknown>[] = [
    { kind: 'teleport', route: '#/usage' },
    { kind: 'navigate' },
    { kind: 'navigate', route: '#/usage', animate: 'yes' },
    { kind: 'navigate', route: '#/usage', extra: 1 },
    { kind: 'open', feature: 'Money Usage' },
    { kind: 'open', feature: 'money.usage', entity: { kind: 'secret', ref: 'x' } },
    { kind: 'look', prefs: {} },
    { kind: 'look', prefs: { variant: { schema: 'x' } } },
    { kind: 'look', prefs: { colour: 'red' } },
    { kind: 'point', target: { feature: 'money.usage' }, caption: 'x'.repeat(141) },
    { kind: 'point', target: { selector: '#x' } },
    { kind: 'highlight', target: { region: 'page' }, caption: '<b>hi</b>' },
    { kind: 'highlight', target: { region: 'page' }, ink: { shape: 'blob' } },
    { kind: 'fill', field: 'palette.search', text: 'x'.repeat(4001) },
    { kind: 'fill', field: 'Search New', text: 'hi' },
    { kind: 'fill', field: 'palette.search', text: 'hi', submit: true },
    { kind: 'scroll' },
    { kind: 'scroll', to: 'middle' },
    { kind: 'scroll', to: 'top', target: { region: 'page' } },
    { kind: 'tour.step', script: 'x', step: -1 },
    { kind: 'tour.step', script: 'x', step: 1.5 },
  ]
  it('accepts every kind well-formed, with captions ≤ 140 and fill text ≤ 4000', () => {
    for (const a of good) expect(checkAct({ act_id: 'act_1', ...a }), JSON.stringify(a)).not.toBeNull()
    expect(checkAct({ act_id: 'act_1', kind: 'point', target: { region: 'page' }, caption: 'x'.repeat(140) })).not.toBeNull()
  })
  it('rejects unknown kinds, unknown or malformed fields, and over-cap text', () => {
    for (const a of bad) expect(checkAct({ act_id: 'act_1', ...a }), JSON.stringify(a)).toBeNull()
    expect(checkAct({ act_id: 'has space', kind: 'scroll', to: 'top' })).toBeNull()
  })
  it('a frame: an unreadable act is kept (answered, never applied); no act id at all is dropped', () => {
    const f = (a: unknown) => checkAskEvent({ type: 'ask', operation_id: 'ask:x', seq: 2, phase: 'act', act: a })
    expect((f({ act_id: 'act_1', kind: 'teleport' }) as { act: { kind: string } }).act.kind).toBe('unreadable')
    expect(f({ kind: 'scroll', to: 'top' })).toBeNull()
    expect((f({ act_id: 'act_1', kind: 'scroll', to: 'top' }) as { act: { kind: string } }).act.kind).toBe('scroll')
  })
  it('dispatched and answer delta frames are checked', () => {
    const base = { type: 'ask', operation_id: 'ask:x', seq: 2 }
    expect(checkAskEvent({ ...base, phase: 'dispatched', intent_id: 'int_1', intent_kind: 'code.task', to: { kind: 'service', ref: 'svc_code', name: 'Code' }, label: 'Fix add' })).not.toBeNull()
    expect(checkAskEvent({ ...base, phase: 'dispatched', intent_id: 'int_1', intent_kind: 'code.task', to: { kind: 'planet', ref: 'x' } })).toBeNull()
    expect(checkAskEvent({ ...base, phase: 'dispatched', intent_id: 'int_1', intent_kind: 'code.task', to: { kind: 'service', ref: 'svc' }, label: '<script>' })).toBeNull()
    expect(checkAskEvent({ ...base, phase: 'answer', text: 'Hi', delta: true })).not.toBeNull()
    expect(checkAskEvent({ ...base, phase: 'answer', text: 'Hi', delta: 'yes' })).toBeNull()
  })
})

describe('executor', () => {
  it('applies acts in seq order and answers each one, with the page view after it', async () => {
    const op = await turn()
    declareFieldForTest({ id: 'palette.search', label: 'Search the hive', kind: 'search' }, () => undefined)
    act(op, { kind: 'navigate', route: '#/swarms', label: 'Swarms' })
    act(op, { kind: 'navigate', route: '#/usage', label: 'Usage' })
    act(op, { kind: 'fill', field: 'palette.search', text: 'Weekly summary' })
    await conductorSettled(op)
    expect(posted.map((p) => p.act)).toEqual(['act_2', 'act_3', 'act_4'])
    expect(loc.hash).toBe('#/usage')
    const r = result('act_3')!
    expect(r.ok).toBe(true)
    expect(r.route).toBe('usage')
    expect(r.experience).toBe('classic')
    expect(r.view).toBeTypeOf('object')
    expect(result('act_4')!.view.fields).toEqual([{ id: 'palette.search', label: 'Search the hive', kind: 'search' }])
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThanOrEqual(8192)
    expect(rows().filter((x) => x.op === op && x.kind === 'local').map((x) => x.text)).toEqual(['Opened Swarms', 'Opened Usage', 'Typed into Search the hive: “Weekly summary”. Nothing is sent until you do.'])
  })

  it('an act after the turn closed or a new turn started is stale_origin, and is not applied', async () => {
    const op = await turn()
    deliver(op, { phase: 'done', spent_usd: 0 })
    act(op, { kind: 'navigate', route: '#/usage' })
    await conductorSettled(op)
    expect(result('act_3')).toMatchObject({ ok: false, reason: 'stale_origin' })
    expect(loc.hash).toBe('#/')
  })

  it('after the person took over the page, acts are stale_origin', async () => {
    const op = await turn()
    useAskStore.getState().personTookOver()
    act(op, { kind: 'navigate', route: '#/usage' })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: false, reason: 'stale_origin' })
    expect(loc.hash).toBe('#/')
  })

  it('reasons are the closed set: an undeclared field, feature, region or route is not_declared; a malformed act is invalid', async () => {
    const op = await turn()
    act(op, { kind: 'fill', field: 'palette.secret', text: 'x' })
    act(op, { kind: 'open', feature: 'work.nothing' })
    act(op, { kind: 'highlight', target: { region: 'nowhere' } })
    act(op, { kind: 'teleport' })
    act(op, { kind: 'navigate', route: '#/nowhere-at-all' })
    act(op, { kind: 'look', prefs: { variant: 'no-such-look' } })
    act(op, { kind: 'tour.step', script: 'intro', step: 0 })
    await conductorSettled(op)
    expect(posted.map((p) => [p.body.ok, p.body.reason])).toEqual([
      [false, 'not_declared'],
      [false, 'not_declared'],
      [false, 'not_declared'],
      [false, 'invalid'],
      [false, 'not_declared'],
      [false, 'invalid'],
      [false, 'not_declared'],
    ])
    for (const p of posted) expect(ACT_REASONS).toContain(p.body.reason)
  })

  it('fill only calls the field’s own setter: it never submits', async () => {
    const op = await turn()
    const set = vi.fn()
    const submit = vi.fn()
    declareFieldForTest({ id: 'palette.search', label: 'Search the hive', kind: 'search' }, set)
    const createGoal = vi.fn()
    useHive.setState({ createGoal } as never)
    act(op, { kind: 'fill', field: 'palette.search', text: 'Write the weekly summary' })
    await conductorSettled(op)
    expect(set).toHaveBeenCalledWith('Write the weekly summary')
    expect(submit).not.toHaveBeenCalled()
    expect(createGoal).not.toHaveBeenCalled()
    expect(result('act_2')).toMatchObject({ ok: true })
  })

  it('Undo: a navigate goes Back, a look returns to the one before, both from the thread row', async () => {
    const client = fakeClient()
    const op = await turn(client)
    act(op, { kind: 'navigate', route: '#/usage', label: 'Usage' })
    act(op, { kind: 'look', prefs: { layout: 'topbar' }, label: 'Top bar' })
    await conductorSettled(op)
    expect(loc.hash).toBe('#/usage')
    expect(lookState().saved?.layout).toBe('topbar')
    const [nav, look] = rows().filter((x) => x.op === op && x.kind === 'local')
    expect(nav.undo).toBe('back')
    expect(look.undo).toBe('undo')
    await useAskStore.getState().runUndo(look.id)
    expect(lookState().saved?.layout ?? null).toBeNull()
    await useAskStore.getState().runUndo(nav.id)
    expect(loc.hash).toBe('#/')
    expect(rows().filter((x) => x.op === op && x.kind === 'local').every((x) => x.state === 'back' && !x.undo)).toBe(true)
  })

  it('an open with Undo, and the thread shows it', async () => {
    const op = await turn()
    act(op, { kind: 'open', feature: 'swarms.see' })
    await conductorSettled(op)
    expect(loc.hash).toBe('#/swarms')
    const row = rows().find((x) => x.op === op && x.kind === 'local')!
    expect(row.text).toBe('Opened Swarms')
    await useAskStore.getState().runUndo(row.id)
    expect(loc.hash).toBe('#/')
  })

  it(`stops after ${ACTS_PER_TURN} acts in one turn, answers the rest act_cap and says so once`, async () => {
    const op = await turn()
    for (let i = 0; i < ACTS_PER_TURN + 3; i++) act(op, { kind: 'scroll', to: 'top' })
    await conductorSettled(op)
    expect(posted).toHaveLength(ACTS_PER_TURN + 3)
    expect(posted.slice(0, ACTS_PER_TURN).every((p) => p.body.ok)).toBe(true)
    expect(posted.slice(ACTS_PER_TURN).every((p) => !p.body.ok && p.body.reason === 'act_cap')).toBe(true)
    expect(rows().filter((x) => x.op === op && x.kind === 'note' && /more than 32 steps on the page/.test(x.text))).toHaveLength(1)
  })

  it('the result route: 409 is success (not retried); 404 stops the conductor for that turn', async () => {
    answerWith = async (a) => {
      if (a === 'act_2') throw new ApiError(409, 'act_result_recorded', 'recorded')
      if (a === 'act_3') throw new ApiError(404, 'not_available', 'no')
      return {}
    }
    const op = await turn()
    act(op, { kind: 'scroll', to: 'top' })
    act(op, { kind: 'scroll', to: 'top' })
    await conductorSettled(op)
    act(op, { kind: 'navigate', route: '#/usage' })
    await conductorSettled(op)
    expect(posted.map((p) => p.act)).toEqual(['act_2', 'act_3'])
    expect(loc.hash).toBe('#/')
    expect(rows().some((x) => x.kind === 'note' && /Stopped following/.test(x.text))).toBe(true)
  })

  it('private apps: no view from Atlas or Truth, no acts on their pages, no moves into them', async () => {
    const op = await turn()
    act(op, { kind: 'navigate', route: '#/program/atlas' })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: false, reason: 'private' })
    loc.hash = '#/program/atlas'
    els.push(el('[data-presence-ref="item:rec_1"]'), el('[data-presence-region="page"]', 'page'))
    act(op, { kind: 'point', target: { entity: { kind: 'item', ref: 'rec_1' } } })
    act(op, { kind: 'fill', field: 'palette.search', text: 'x' })
    await conductorSettled(op)
    expect(result('act_3')).toMatchObject({ ok: false, reason: 'private', view: {}, route: 'private' })
    expect(result('act_4')).toMatchObject({ ok: false, reason: 'private', view: {}, route: 'private' })
    for (const p of posted.slice(1)) expect(JSON.stringify(p.body)).not.toMatch(/atlas|rec_1|refs/)
    loc.hash = '#/program/omegatruth'
    act(op, { kind: 'scroll', to: 'top' })
    await conductorSettled(op)
    expect(result('act_5')!.view).toEqual({})
  })

  it('reduced motion: a point is shown in place without travel and still marked ok', async () => {
    reduced = true
    els.push(el('[data-presence-feature="money.usage"]'))
    const op = await turn()
    act(op, { kind: 'point', target: { feature: 'money.usage' }, caption: 'Usage lives here' })
    act(op, { kind: 'highlight', target: { feature: 'money.usage' } })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: true, reason: 'reduced_motion_skipped' })
    expect(result('act_3')).toMatchObject({ ok: true })
    const p = useAskStore.getState().presence
    expect(p.at(-1)).toMatchObject({ still: true, verb: 'look' })
  })

  it('a highlight is in place (no travel); a point on screen travels', async () => {
    els.push(el('[data-presence-region="search"]', 'search'))
    const op = await turn()
    act(op, { kind: 'highlight', target: { region: 'search' }, caption: 'Here', ink: { shape: 'circle' } })
    act(op, { kind: 'point', target: { region: 'search' } })
    await conductorSettled(op)
    const [h, pt] = useAskStore.getState().presence.slice(-2)
    expect(h).toMatchObject({ verb: 'sketch', still: true, caption: 'Here' })
    expect(pt.still).toBeUndefined()
    expect(result('act_2')!.view.regions).toEqual(['search'])
  })

  it('tour.step is the guided-demo runner: placed at the step, shown, answered ok with the page after it', async () => {
    const { setGuideEnv, useGuide } = await import('../guided/store')
    setGuideEnv({
      go: (r) => void (loc.hash = `#/${r.name}`),
      picks: () => ({ mind: null, swarm: null, belief: null }),
      appEnabled: () => false,
      ui: () => undefined,
      experience: () => undefined,
      press: () => undefined,
      find: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) }) as unknown as Element,
      reveal: () => undefined,
      sleep: async () => undefined,
    })
    try {
      const op = await turn()
      act(op, { kind: 'tour.step', script: 'intro', step: 0 })
      act(op, { kind: 'tour.step', script: 'lab', step: 1 })
      act(op, { kind: 'tour.step', script: 'lab', step: 9 })
      await conductorSettled(op)
      // no such demo, or no such step: nothing changes
      expect(result('act_2')).toMatchObject({ ok: false, reason: 'not_declared' })
      expect(result('act_4')).toMatchObject({ ok: false, reason: 'not_declared' })
      expect(result('act_3')).toMatchObject({ ok: true, route: 'lab', experience: 'classic' })
      const run = useGuide.getState().run
      expect(run?.kind === 'demo' && [run.script.id, run.m.step, run.m.status, run.op]).toEqual(['lab', 1, 'ready', op])
    } finally {
      useGuide.getState().close()
      setGuideEnv(null)
    }
  })

  it('unsaved changes on the page: a move is not made (stale_origin: the person has the page)', async () => {
    const op = await turn()
    markUnsaved('test', true)
    act(op, { kind: 'navigate', route: '#/usage', label: 'Usage' })
    await conductorSettled(op)
    markUnsaved('test', false)
    expect(result('act_2')).toMatchObject({ ok: false, reason: 'stale_origin' })
    expect(loc.hash).toBe('#/')
  })
})

describe('conductor-live: a move into an app the swarm refuses is answered refused, never ok', () => {
  const settle = (id: string, swarm: string, patch: Partial<import('../../store/programSession').ProgramSession>, ms: number) => {
    // the app page's own read (ProgramHost → openProgram): begins loading, then settles as the host answers
    const key = sessionKey(id, swarm)
    useHive.setState((s) => ({ programSessions: { ...s.programSessions, [key]: { ...newSession(id, swarm), key, loading: true } } }))
    setTimeout(() => useHive.setState((s) => ({ programSessions: { ...s.programSessions, [key]: { ...s.programSessions[key], loading: false, ...patch } } })), ms)
  }
  afterEach(() => useHive.setState({ programSessions: {} }))
  it('navigate: the page moves (the person sees RefusedHere) and the result is ok:false with the fixed reason', async () => {
    const op = await turn()
    settle('tools-x', 's_one', { error: { code: 'program_refused', message: 'tools-x is not allowed in this swarm' } }, 120)
    act(op, { kind: 'navigate', route: '#/program/tools-x/s_one', label: 'Tools' })
    await conductorSettled(op)
    expect(loc.hash).toBe('#/program/tools-x/s_one')
    expect(REFUSED_APP_REASON).toBe('blocked')
    expect(result('act_2')).toMatchObject({ ok: false, reason: REFUSED_APP_REASON })
    expect(rows().find((x) => x.op === op && x.kind === 'local')?.text).toBe('Opened Tools, but this swarm doesn’t allow it here.')
  })
  it('the same move into an app the swarm allows is ok; any other error is not called refused', async () => {
    const op = await turn()
    settle('tools-y', 's_one', { graph: { nodes: [], links: [] } as never }, 80)
    act(op, { kind: 'navigate', route: '#/program/tools-y/s_one', label: 'Tools' })
    settle('tools-z', 's_one', { error: { code: 'program_error', message: 'boom' } }, 80)
    act(op, { kind: 'navigate', route: '#/program/tools-z/s_one', label: 'Tools Z' })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: true })
    expect(result('act_3')).toMatchObject({ ok: true })
  })
  it('r2 P2: a read still loading after the settle wait is unresolved: ok:false, never ok, and a later refusal changes nothing', async () => {
    const op = await turn()
    const key = sessionKey('tools-slow', 's_one')
    useHive.setState((s) => ({ programSessions: { ...s.programSessions, [key]: { ...newSession('tools-slow', 's_one'), key, loading: true } } }))
    act(op, { kind: 'navigate', route: '#/program/tools-slow/s_one', label: 'Slow tools' })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: false, reason: APP_UNRESOLVED_REASON })
    expect(rows().find((x) => x.op === op && x.kind === 'local')?.text).toBe('Opened Slow tools, but it didn’t finish loading, so it isn’t known yet whether this swarm allows it.')
    useHive.setState((s) => ({ programSessions: { ...s.programSessions, [key]: { ...s.programSessions[key], loading: false, error: { code: 'program_refused', message: 'refused' } } } }))
    expect(posted.filter((p) => p.act === 'act_2')).toHaveLength(1)
  }, 10000)
  it('an app shown without a session (its own frame or a form) is not held: ok after the short wait', async () => {
    const op = await turn()
    act(op, { kind: 'navigate', route: '#/program/tools-w/s_one', label: 'Tools W' })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: true })
  })
  it('the person changes (identity epoch): nothing is posted for the earlier one', async () => {
    const op = await turn()
    settle('tools-x', 's_one', { error: { code: 'program_refused', message: 'refused' } }, 150)
    act(op, { kind: 'navigate', route: '#/program/tools-x/s_one', label: 'Tools' })
    await new Promise((r) => setTimeout(r, 60))
    useAskStore.getState().reset()
    await conductorSettled(op)
    expect(result('act_2')).toBeUndefined()
  })
  it('r3 (Kimi #2): the turn closes while the app is still loading: the wait stops then, never held to the settle limit', async () => {
    const op = await turn()
    const key = sessionKey('tools-slow', 's_one')
    useHive.setState((s) => ({ programSessions: { ...s.programSessions, [key]: { ...newSession('tools-slow', 's_one'), key, loading: true } } }))
    const began = Date.now()
    act(op, { kind: 'navigate', route: '#/program/tools-slow/s_one', label: 'Slow tools' })
    await new Promise((r) => setTimeout(r, 120))
    deliver(op, { phase: 'done', spent_usd: 0 })
    await conductorSettled(op)
    expect(Date.now() - began).toBeLessThan(1500)
    // not known whether the swarm allows it: never ok
    expect(result('act_2')).toMatchObject({ ok: false, reason: APP_UNRESOLVED_REASON })
  })
  it('r3 (Kimi #1): an open checks the route the open itself reached, read before any wait', async () => {
    const { openWithBack } = await import('./run')
    const { featureById } = await import('../registry')
    useHive.setState({ client: fakeClient(), session: `session-${++n}`, inits: n })
    loc.hash = '#/'
    const opened = openWithBack(featureById('swarms.see')!, { ok: () => true, client: fakeClient() } as never)!
    expect(opened).toMatchObject({ moved: true, to: '#/swarms' })
    // the page moving on afterwards does not change what was opened
    loc.hash = '#/usage'
    expect(opened.to).toBe('#/swarms')
    loc.hash = '#/'
  })
})

describe('thread rows: dispatched and streamed answers', () => {
  it('dispatched says who it was handed to', async () => {
    const op = await turn()
    deliver(op, { phase: 'dispatched', intent_id: 'int_1', intent_kind: 'code.task', to: { kind: 'service', ref: 'svc_code', name: 'Code' }, label: 'Fix add' })
    expect(rows().find((x) => x.op === op && x.kind === 'local')!.text).toBe('Handed to Code: Fix add')
  })
  it('deltas append into one answer row; the whole answer settles it', async () => {
    const op = await turn()
    deliver(op, { phase: 'answer', delta: true, text: 'Usage is ' })
    deliver(op, { phase: 'answer', delta: true, text: 'the spend.' })
    let a = rows().filter((x) => x.op === op && x.kind === 'answer')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ text: 'Usage is the spend.', streaming: true })
    deliver(op, { phase: 'answer', text: 'Usage is the spend of your swarms.' })
    a = rows().filter((x) => x.op === op && x.kind === 'answer')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ text: 'Usage is the spend of your swarms.', streaming: false })
  })
  it('the whole answer replaces the streamed pieces (not appended to them)', async () => {
    const op = await turn()
    deliver(op, { phase: 'answer', delta: true, text: 'Usage is the sp' })
    deliver(op, { phase: 'answer', text: 'Usage is the spend.' })
    expect(rows().filter((x) => x.op === op && x.kind === 'answer').map((x) => x.text)).toEqual(['Usage is the spend.'])
  })
  it('done says a limit in the page’s own words; complete says nothing; an unknown outcome is not echoed', async () => {
    for (const [outcome, said] of [
      ['act_cap', /limit of steps/],
      ['call_cap', /limit of thinking/],
      ['time_cap', /ran out of time/],
      ['spend_cap', /spending limit/],
      ['cancelled', /was stopped/],
      ['error', /went wrong/],
    ] as const) {
      const op = await turn()
      deliver(op, { phase: 'done', spent_usd: 0, outcome })
      expect(rows().filter((x) => x.op === op && x.kind === 'note').map((x) => x.text).join(' '), outcome).toMatch(said)
      useAskStore.getState().reset()
    }
    const op = await turn()
    deliver(op, { phase: 'done', spent_usd: 0, outcome: 'complete' })
    expect(rows().filter((x) => x.op === op && x.kind === 'note')).toHaveLength(0)
    expect(checkAskEvent({ type: 'ask', operation_id: 'ask:x', seq: 2, phase: 'done', outcome: 'HOST SAYS worker died' })).not.toHaveProperty('outcome')
  })
  it('done settles an answer still streaming', async () => {
    const op = await turn()
    deliver(op, { phase: 'answer', delta: true, text: 'Part of it' })
    deliver(op, { phase: 'done', spent_usd: 0 })
    expect(rows().find((x) => x.op === op && x.kind === 'answer')).toMatchObject({ text: 'Part of it', streaming: false })
  })
})

describe('simulator result route', () => {
  it('records once, 409 on a repeat, 404 for an act it never emitted or another person', () => {
    const later: (() => void)[] = []
    let who = 'user:p_ada'
    const emitted: AskEvent[] = []
    const sim = new SimAsk({
      emit: (e) => emitted.push(e),
      later: (_ms, fn) => later.push(fn),
      agents: () => [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' } as never],
      swarms: () => [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' } as never],
      goals: () => [],
      principal: () => who,
    })
    sim.ask({ operation_id: 'ask:demo0001', text: 'show me around motivations', context: { route: 'hive', experience: 'classic' }, via: 'typed' })
    for (const fn of later) fn()
    const acts = emitted.filter((e) => e.phase === 'act') as Extract<AskEvent, { phase: 'act' }>[]
    expect(acts.map((a) => a.act.kind)).toEqual(['open', 'highlight', 'fill'])
    expect(JSON.stringify(emitted)).not.toMatch(/goal|board/i)
    expect(emitted.filter((e) => e.phase === 'answer' && (e as { delta?: boolean }).delta)).toHaveLength(3)
    const body: ActResult = { ok: true, view: {}, route: 'usage', experience: 'classic' }
    const id = acts[0].act.act_id
    expect(sim.actResult('ask:demo0001', id, body)).toEqual({ recorded: true })
    expect(() => sim.actResult('ask:demo0001', id, body)).toThrow(expect.objectContaining({ status: 409, code: 'act_result_recorded' }))
    expect(() => sim.actResult('ask:demo0001', 'act_never', body)).toThrow(expect.objectContaining({ status: 404 }))
    who = 'user:p_bob'
    expect(() => sim.actResult('ask:demo0001', acts[1].act.act_id, body)).toThrow(expect.objectContaining({ status: 404 }))
  })
})

describe('view limits (Platform r2 Q1) and the private turn context (Q6)', () => {
  it('fitView keeps at most 32 conforming fields and regions, exactly {id, label, kind}; the rest are dropped or trimmed', () => {
    const fields = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, label: `Field ${i}`, kind: 'text' as const })),
      { id: 'Bad Id', label: 'x', kind: 'text' as const },
      { id: 'ok.long', label: 'L'.repeat(200), kind: 'prompt' as const },
      { id: 'ctl', label: 'a\u0007b', kind: 'text' as const },
      { id: 'empty', label: '   ', kind: 'text' as const },
      { id: 'kind', label: 'x', kind: 'checkbox' as never },
      { id: 'extra', label: 'x', kind: 'search' as const, secret: 'y' } as never,
    ]
    const v = fitView({ fields: [fields[40], fields[41], fields[42], fields[43], fields[44], fields[45], ...fields.slice(0, 40)], regions: ['page', 'Bad Region', 'x'.repeat(65), ...Array.from({ length: 40 }, (_, i) => `r${i}`)] })
    expect(v.fields!.length).toBeLessThanOrEqual(32)
    expect(v.regions!.length).toBeLessThanOrEqual(32)
    for (const f of v.fields!) {
      expect(Object.keys(f).sort()).toEqual(['id', 'kind', 'label'])
      expect(f.id).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      expect(f.label.length).toBeGreaterThanOrEqual(1)
      expect(f.label.length).toBeLessThanOrEqual(80)
      expect(['text', 'search', 'prompt']).toContain(f.kind)
    }
    expect(v.fields!.map((f) => f.id)).toContain('ok.long')
    expect(v.fields!.find((f) => f.id === 'ok.long')!.label).toHaveLength(80)
    expect(v.fields!.map((f) => f.id)).not.toEqual(expect.arrayContaining(['Bad Id', 'ctl', 'empty', 'kind']))
    for (const r of v.regions!) expect(r).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    expect(new TextEncoder().encode(JSON.stringify(v)).length).toBeLessThanOrEqual(2048)
  })
  it('a non-conforming field is never declared (so it can never be filled or sent)', () => {
    expect(declareFieldForTest({ id: 'Search New', label: 'x', kind: 'text' }, () => undefined)).toBe(false)
    expect(declareFieldForTest({ id: 'goals.ctl', label: 'a\nb', kind: 'text' }, () => undefined)).toBe(false)
    expect(declareFieldForTest({ id: 'goals.ok', label: 'Fine', kind: 'text' }, () => undefined)).toBe(true)
    declareFieldForTest({ id: 'goals.ok', label: 'Fine', kind: 'text' }, null)
  })
  it('Atlas and Truth: the turn context is exactly { private: true }', () => {
    for (const app of ['atlas', 'omegatruth', 'truth']) expect(askContext(parse(`#/program/${app}`), 'classic', 'in the app', 'a_vega01')).toEqual({ private: true })
    expect(askContext(parse('#/usage'), 'classic', 'on Usage')).toMatchObject({ route: 'usage', experience: 'classic' })
    expect(fitView({ refs: [{ kind: 'item', ref: 'rec_1' }], acts: ['x'], summary: 's' }, { privateApp: true })).toEqual({})
  })
  it('the simulator refuses a non-conforming view or a private context with anything else in it', () => {
    const sim = new SimAsk({ emit: () => undefined, later: () => undefined, agents: () => [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' } as never], swarms: () => [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' } as never], goals: () => [], principal: () => 'user:p_ada' })
    const body = (context: unknown, n: number) => ({ operation_id: `ask:limits00${n}`, text: 'hello', context, via: 'typed' }) as never
    expect(() => sim.ask(body({ route: 'usage', experience: 'classic', view: { fields: [{ id: 'Bad Id', label: 'x', kind: 'text' }] } }, 1))).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => sim.ask(body({ route: 'usage', experience: 'classic', view: { regions: Array.from({ length: 33 }, (_, i) => `r${i}`) } }, 2))).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => sim.ask(body({ private: true, program: 'atlas' }, 3))).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(sim.ask(body({ private: true }, 4)).state).toBe('accepted')
  })
})

describe('encoded routes never get past the private-app check (host review of aa43ae4)', () => {
  const ENCODED = ['%61tlas', '%41TLAS', 'ATLAS', '%6Fmega%74ruth', '%4F%4D%45%47%41TRUTH', 'tr%75th', '%2561tlas', '%252561tlas']
  it('app ids: decoded until stable (≤ 3 rounds), lowercased; malformed or still encoded is private', () => {
    for (const id of ENCODED) expect(isPrivateApp(id), id).toBe(true)
    expect(isPrivateApp('%E0%A4%A')).toBe(true)
    expect(isPrivateApp('%25252561tlas')).toBe(true) // 4 rounds: fail closed
    expect(decodeSegment('%2561tlas')).toBe('atlas')
    expect(decodeSegment('%E0%A4%A')).toBeNull()
    expect(isPrivateApp('omegadesign')).toBe(false)
    expect(isPrivateApp('%6Fmegadesign')).toBe(false)
  })
  it('hashes: program and programs routes, a mind’s app route, and a malformed escape anywhere', () => {
    for (const id of ENCODED) {
      expect(isPrivateHash(`#/program/${id}`), id).toBe(true)
      expect(isPrivateHash(`#/programs/${id}`), id).toBe(true)
      expect(isPrivateHash(`#/dot/a_vega01/program/${id}`), id).toBe(true)
    }
    expect(isPrivateHash('#/program/%E0%A4%A')).toBe(true)
    expect(isPrivateHash('#/goals/%E0%A4%A')).toBe(true)
    expect(isPrivateHash('#/%70rogram/atlas')).toBe(true)
    expect(isPrivateHash('#/program/omegadesign')).toBe(false)
    expect(isPrivateHash('#/usage')).toBe(false)
  })
  it('the turn context is { private: true } on an encoded private page', () => {
    for (const id of ['%2561tlas', '%41TLAS', '%6Fmega%74ruth']) {
      loc.hash = `#/program/${id}`
      expect(askContext(parse(`#/program/${encodeURIComponent('x')}`), 'classic', 'in the app')).toEqual({ private: true })
    }
    loc.hash = '#/usage'
    expect(askContext({ name: 'program', id: 'ATLAS' }, 'classic', 'in the app')).toEqual({ private: true })
  })
  it('the conductor: no moves into an encoded private app, and results from one name nothing', async () => {
    const op = await turn()
    for (const id of ['%61tlas', '%41TLAS', '%6Fmega%74ruth', '%2561tlas', '%E0%A4%A']) act(op, { kind: 'navigate', route: `#/program/${id}` })
    await conductorSettled(op)
    expect(posted.map((p) => p.body.reason)).toEqual(['private', 'private', 'private', 'private', 'private'])
    expect(loc.hash).toBe('#/')
    posted = []
    for (const id of ['%2561tlas', '%41TLAS', '%E0%A4%A']) {
      loc.hash = `#/program/${id}`
      act(op, { kind: 'scroll', to: 'top' })
    }
    await conductorSettled(op)
    for (const p of posted) expect(p.body).toMatchObject({ ok: false, reason: 'private', view: {}, route: 'private' })
  })
  it('blocked is in the set: an act that fails while applying is answered blocked', async () => {
    const op = await turn()
    declareFieldForTest({ id: 'palette.search', label: 'Search the hive', kind: 'search' }, () => {
      throw new Error('boom')
    })
    act(op, { kind: 'fill', field: 'palette.search', text: 'x' })
    await conductorSettled(op)
    expect(result('act_2')).toMatchObject({ ok: false, reason: 'blocked' })
    expect(ACT_REASONS).toContain('blocked')
  })
})

describe('r3c (stand-in r3b): field labels and nested targets match the host exactly', () => {
  it('a label the host calls unprintable (U+200B, U+00A0, U+00AD) is never declared; ASCII space is fine', async () => {
    const { fieldLabel } = await import('../../api/ask')
    for (const bad of ['zero​width', 'no break', 'soft­hyphen', 'line sep', 'ctl\u0007']) expect(fieldLabel(bad), JSON.stringify(bad)).toBeNull()
    expect(fieldLabel('New task title')).toBe('New task title')
  })
  it('an entity target is exactly {kind, ref}: extra keys and arrays are refused', () => {
    const at = (entity: unknown) => checkAct({ act_id: 'act_1', kind: 'point', target: { entity } })
    expect(at({ kind: 'mind', ref: 'a_vega01' })).not.toBeNull()
    expect(at({ kind: 'mind', ref: 'a_vega01', submit: true })).toBeNull()
    expect(at([{ kind: 'mind', ref: 'a_vega01' }])).toBeNull()
    expect(checkAct({ act_id: 'act_1', kind: 'highlight', target: { entity: { kind: 'mind', ref: 'a_vega01', extra: 1 } } })).toBeNull()
    expect(checkAct({ act_id: 'act_1', kind: 'scroll', target: { entity: { kind: 'mind', ref: 'a_vega01', x: 0 } } })).toBeNull()
  })
})
