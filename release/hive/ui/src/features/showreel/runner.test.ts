import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The demo showreel's runner (Surface demo D4): it plays each step through the conductor's acts in order, never on a
// real hive, stops at once when the person takes over, pauses (not a take-over) when they ask in the Ask, answers from
// the step's own script at 0 model calls, and opens the layers of how. A fake screen (ReelEnv) records what it does.
// INVENTED data only; nothing here reaches a hive or a model.

const loc = { hash: '#/', search: '?sim=1' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), innerWidth: 1440, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined })

const { useReel, setReelEnv, showreelWords, resetReel, stepNow } = await import('./store')
const { PLAYLIST } = await import('./scenes')
const { OFF_SCRIPT } = await import('./words')
const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { scriptById, GUIDE_SCRIPTS } = await import('../guided/scripts')
type ReelEnv = import('./store').ReelEnv
type RunnerAct = import('./store').RunnerAct

const at = (scene: string, i = 0) => PLAYLIST.findIndex((p) => p.scene.id === scene && p.i === i)
const TEAM = at('showreel-team-room')
const demoClient = { mode: 'sim' as const, demo: true, swarmRoom: async () => ({ id: 'r_team1' }) }
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick()
}

interface Log {
  kind: string
  detail?: string
}
function fakeEnv(opts: { holdCursor?: boolean; holdAct?: RunnerAct['kind'] } = {}) {
  const log: Log[] = []
  const held: (() => void)[] = []
  /** the step check each act was handed (the in-flight take-over tests read it) */
  const alives: (() => boolean)[] = []
  const el = { getBoundingClientRect: () => ({ left: 10, top: 10, width: 40, height: 20, right: 50, bottom: 30 }) } as unknown as Element
  const env: ReelEnv = {
    act: async (a: RunnerAct, _op, _seq, _origin, alive) => {
      log.push({ kind: `act:${a.kind}`, detail: a.kind === 'navigate' ? a.route : a.kind === 'open' ? a.feature : a.kind === 'tour.step' ? `${a.script}#${a.step}` : undefined })
      alives.push(alive)
      if (opts.holdAct === a.kind) await new Promise<void>((r) => held.push(r))
      return { ok: true }
    },
    dialog: (d) => log.push({ kind: d ? 'dialog:open' : 'dialog:close', detail: d?.swarm }),
    place: async (m) => (m.kind === 'team-room' ? `#/messages/team-of-${m.swarm}` : `#/program/omegadesign/${m.swarm}?design=${encodeURIComponent(m.title)}`),
    find: () => el,
    cursor: (_el, click) => {
      log.push({ kind: click ? 'cursor:click' : 'cursor:glide' })
      return opts.holdCursor ? new Promise<void>((r) => held.push(r)) : Promise.resolve()
    },
    draw: (marks) => log.push({ kind: 'draw', detail: marks.map((m) => m.kind).join(',') }),
    clear: () => undefined,
    say: (t) => log.push({ kind: 'say', detail: t }),
    hush: () => undefined,
    // the dwell never runs out by itself here: each test moves the reel on
    sleep: () => new Promise<void>(() => undefined),
  }
  return { env, log, held, alives }
}

beforeEach(() => {
  resetReel()
  useHive.setState({ client: demoClient as never, session: 's1', inits: 1 })
})
afterEach(() => {
  setReelEnv(null)
  resetReel()
})

describe('the showreel only plays in demo mode', () => {
  it('refuses on a real hive and on a plain simulator; plays on the demo simulator', () => {
    useHive.setState({ client: { mode: 'live' } as never })
    expect(useReel.getState().start()).toBe(false)
    useHive.setState({ client: { mode: 'sim' } as never })
    expect(useReel.getState().start()).toBe(false)
    useHive.setState({ client: demoClient as never })
    expect(useReel.getState().start()).toBe(true)
    expect(useReel.getState().reel.status).toBe('playing')
  })
  it('its guided scripts are known only once it starts, and never among the demos people pick from', () => {
    const id = PLAYLIST[0].scene.id
    expect(GUIDE_SCRIPTS.some((s) => s.id === id)).toBe(false)
    useReel.getState().start()
    expect(scriptById(id)?.id).toBe(id)
    expect(GUIDE_SCRIPTS.some((s) => s.id === id)).toBe(false)
  })
  it('"show me around" in the Ask starts it on the demo simulator, and is left to the Ask anywhere else', () => {
    useHive.setState({ client: { mode: 'live' } as never })
    expect(showreelWords('show me around')).toBe(false)
    useHive.setState({ client: demoClient as never })
    expect(showreelWords('show me around')).toBe(true)
    expect(useReel.getState().reel.status).toBe('playing')
  })
})

describe('playing a step through the conductor’s acts', () => {
  it('cursor click, then the move, then the tour step, then the marks', async () => {
    const { env, log } = fakeEnv()
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    await settle()
    useReel.getState().send({ type: 'goto', at: TEAM })
    await settle()
    const team = log.slice(log.lastIndexOf(log.filter((l) => l.kind === 'dialog:close').at(-1)!) + 1)
    expect(team.map((l) => l.kind + (l.detail ? `=${l.detail}` : ''))).toEqual([
      'cursor:click',
      'act:navigate=#/swarms/s_lyra',
      `act:tour.step=showreel-team-room#0`,
      'cursor:glide',
      'draw=circle',
    ])
  })
  it('the team room is read first, then moved to (the same read the Chat button makes)', async () => {
    const { env, log } = fakeEnv()
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    useReel.getState().send({ type: 'goto', at: TEAM + 1 })
    await settle()
    expect(log.filter((l) => l.kind === 'act:navigate').map((l) => l.detail)).toContain('#/messages/team-of-s_lyra')
  })
  it('voice is off by default; when on, the caption is spoken as well', async () => {
    const { env, log } = fakeEnv()
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    await settle()
    expect(log.some((l) => l.kind === 'say')).toBe(false)
    useReel.getState().setVoice(true)
    useReel.getState().send({ type: 'next' })
    await settle()
    expect(log.filter((l) => l.kind === 'say').map((l) => l.detail)).toEqual([PLAYLIST[1].step.guide.say])
  })
  it('a take-over while an act is in flight: the executor is handed the step check, it turns false, and nothing more is done', async () => {
    const { env, log, held, alives } = fakeEnv({ holdAct: 'navigate' })
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    await settle()
    expect(log.map((l) => l.kind)).toEqual(['dialog:close', 'cursor:click', 'act:navigate'])
    expect(alives[0]()).toBe(true)
    useReel.getState().send({ type: 'takeover' })
    // the act in flight sees it at once (performLocal folds it into the origin it runs under)
    expect(alives[0]()).toBe(false)
    held.forEach((r) => r())
    await settle()
    expect(log.map((l) => l.kind)).toEqual(['dialog:close', 'cursor:click', 'act:navigate'])
  })
  it('the delete warning: opened after the move, before the tour step; put away when the showreel moves on', async () => {
    const { env, log } = fakeEnv()
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    const del = at('showreel-swarm-delete')
    useReel.getState().send({ type: 'goto', at: del })
    await settle()
    const kinds = log.map((l) => l.kind + (l.detail ? `=${l.detail}` : ''))
    const open = kinds.indexOf('dialog:open=s_drift')
    expect(open).toBeGreaterThan(kinds.indexOf('act:navigate=#/swarms/s_drift'))
    expect(kinds[open + 1]).toBe('act:tour.step=showreel-swarm-delete#0')
    useReel.getState().send({ type: 'next' })
    await settle()
    expect(log.slice(open + 1).some((l) => l.kind === 'dialog:close')).toBe(true)
  })
  it('a take-over mid-step: nothing more is done for that step', async () => {
    const { env, log, held } = fakeEnv({ holdCursor: true })
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    await settle()
    expect(log.map((l) => l.kind)).toEqual(['dialog:close', 'cursor:click'])
    useReel.getState().send({ type: 'takeover' })
    held.forEach((r) => r())
    await settle()
    expect(log.map((l) => l.kind)).toEqual(['dialog:close', 'cursor:click'])
    expect(useReel.getState().reel.status).toBe('took-over')
  })
  it('a change of sign-in stops it', async () => {
    const { env } = fakeEnv({ holdCursor: true })
    setReelEnv(env)
    useReel.getState().start({ loop: false })
    useHive.setState({ session: 'someone-else' })
    useReel.getState().send({ type: 'next' })
    await settle()
    expect(useReel.getState().reel.status).toBe('ended')
  })
})

describe('asking while it plays', () => {
  const asked = () => useAskStore.getState().log.filter((e) => e.kind === 'row').length

  it('"why?" pauses it (not a take-over) and answers from the step’s own script', async () => {
    const send = vi.spyOn(useAskStore.getState(), 'send')
    useReel.getState().start({ loop: false })
    const before = asked()
    expect(showreelWords('why?')).toBe(true)
    const s = useReel.getState()
    expect([s.reel.status, s.reel.paused]).toEqual(['paused', 'ask'])
    expect(s.answer).toMatchObject({ text: PLAYLIST[0].step.why, kind: 'step' })
    expect(asked()).toBeGreaterThan(before)
    expect(send).not.toHaveBeenCalled()
  })
  it('"what’s that?" and "why did you click that?" have their own answers', () => {
    useReel.getState().start({ loop: false })
    showreelWords('what’s that?')
    expect(useReel.getState().answer?.text).toBe(PLAYLIST[0].step.seeing)
    showreelWords('why did you click that?')
    expect(useReel.getState().answer?.text).toBe(PLAYLIST[0].step.click)
  })
  it('then Carry on plays on from the same step', () => {
    useReel.getState().start({ loop: false })
    useReel.getState().send({ type: 'next' })
    showreelWords('why?')
    expect(useReel.getState().reel.at).toBe(1)
    expect(showreelWords('carry on')).toBe(true)
    expect([useReel.getState().reel.status, useReel.getState().reel.at]).toEqual(['playing', 1])
    expect(useReel.getState().answer).toBeNull()
  })
  it('an off-script question gets the plain line and never reaches a model', () => {
    const send = vi.spyOn(useAskStore.getState(), 'send')
    useReel.getState().start({ loop: false })
    expect(showreelWords('what is the weather on Mars?')).toBe(true)
    expect(useReel.getState().answer).toMatchObject({ text: OFF_SCRIPT, kind: 'off' })
    expect(send).not.toHaveBeenCalled()
  })
  it('after a take-over, words about something else go back to the Ask; why is still answered', () => {
    useReel.getState().start({ loop: false })
    useReel.getState().send({ type: 'takeover' })
    expect(showreelWords('open the lab')).toBe(false)
    expect(showreelWords('why?')).toBe(true)
    expect(useReel.getState().reel.status).toBe('took-over')
  })
  it('"how?" opens the layers at the screen (paused), and "deeper" goes one layer down', () => {
    useReel.getState().start({ loop: false })
    showreelWords('how?')
    expect(useReel.getState().layers?.at).toBe('screen')
    expect(useReel.getState().reel.paused).toBe('layers')
    showreelWords('deeper')
    expect(useReel.getState().layers?.at).toBe('code')
    useReel.getState().closeLayers()
    expect([useReel.getState().layers, useReel.getState().reel.status]).toEqual([null, 'playing'])
    expect(stepNow()).toBe(PLAYLIST[0].step)
  })
})

describe('an act already in flight, in the real executor', () => {
  it('a tour step being prepared is not placed once the step no longer holds (stale_origin)', async () => {
    const { performLocal } = await import('../ask/conductor')
    const { useGuide } = await import('../guided/store')
    const { askOrigin } = await import('../../store/ask')
    useGuide.getState().close()
    useReel.getState().start({ loop: false })
    let live = true
    const p = performLocal('showreel:test', 1, { act_id: 'a1', kind: 'tour.step', script: 'showreel-health', step: 0 }, askOrigin(), () => live)
    // the person takes over while the step is still being prepared
    live = false
    expect(await p).toEqual({ ok: false, reason: 'stale_origin' })
    expect(useGuide.getState().run).toBeNull()
  })
})

describe('a move already in flight, in the real executor', () => {
  it('a move whose step stops holding while it waits answers stale_origin (the runner does nothing after it)', async () => {
    const { performLocal } = await import('../ask/conductor')
    const { askOrigin } = await import('../../store/ask')
    useReel.getState().start({ loop: false })
    let live = true
    const p = performLocal('showreel:test', 2, { act_id: 'a2', kind: 'navigate', route: '#/lab' }, askOrigin(), () => live)
    live = false
    expect(await p).toEqual({ ok: false, reason: 'stale_origin' })
  })
})

describe('leaving demo mode', () => {
  it('a switch to a real hive’s client forgets the demo scripts (they never resolve again) and puts the showreel away', () => {
    const id = PLAYLIST[0].scene.id
    useReel.getState().start()
    expect(scriptById(id)?.id).toBe(id)
    useHive.setState({ client: { mode: 'live' } as never })
    expect(scriptById(id)).toBeUndefined()
    expect(useReel.getState().reel.status).toBe('idle')
    // back on a demo client, they stay forgotten until the showreel starts again
    useHive.setState({ client: demoClient as never })
    expect(scriptById(id)).toBeUndefined()
  })
  it('even without the client changing hands: once it is no longer the demo simulator, a look forgets them', async () => {
    const { registerDemoScripts } = await import('../guided/scripts')
    let demo = true
    registerDemoScripts([{ ...GUIDE_SCRIPTS[0], id: 'demo-only-x' }], () => demo)
    expect(scriptById('demo-only-x')?.id).toBe('demo-only-x')
    demo = false
    expect(scriptById('demo-only-x')).toBeUndefined()
    demo = true
    expect(scriptById('demo-only-x')).toBeUndefined()
  })
})
