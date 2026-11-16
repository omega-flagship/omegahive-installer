/**
 * The shell's rest → awake → Pro contract (CANDIDATE, one-experience r1): the pure rules, the gesture, the opt-in, the
 * store's behaviour for an experience that is not phased (always Pro: today's behaviour), and the registry gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextPhase, omegaGesture, onePointerPress, phasesOptedIn, pointerHub, readGesture, resetForIdentity, resumeExpired, SWIPE_PX, wheelIsNavigation, transitionOf, typesIntoAsk, usePhase, type PhaseEvent, type ShellPhase } from './phase'
import { ALL_EXPERIENCES, CLASSIC, unreviewedAllowed } from '../experiences/registry'

const EVENTS: PhaseEvent[] = ['omega-tap', 'omega-swipe', 'type', 'pro', 'back', 'power', 'idle', 'urgent', 'navigate']

describe('nextPhase', () => {
  it('rest wakes only on the Ω (tap or swipe), a key typed, or an urgent event', () => {
    const to = Object.fromEntries(EVENTS.map((e) => [e, nextPhase('rest', e)]))
    expect(to).toEqual({ 'omega-tap': 'awake', 'omega-swipe': 'awake', type: 'awake', pro: 'rest', back: 'rest', power: 'rest', idle: 'rest', urgent: 'awake', navigate: 'awake' })
  })
  it('awake goes to Pro by the swipe or the Pro control, and back to rest by power or Back', () => {
    const to = Object.fromEntries(EVENTS.map((e) => [e, nextPhase('awake', e)]))
    expect(to).toEqual({ 'omega-tap': 'awake', 'omega-swipe': 'pro', type: 'awake', pro: 'pro', back: 'rest', power: 'rest', idle: 'rest', urgent: 'awake', navigate: 'pro' })
  })
  it('Pro returns to awake by the person; only the idle time rests it directly', () => {
    const to = Object.fromEntries(EVENTS.map((e) => [e, nextPhase('pro', e)]))
    expect(to).toEqual({ 'omega-tap': 'pro', 'omega-swipe': 'pro', type: 'pro', pro: 'pro', back: 'awake', power: 'awake', idle: 'rest', urgent: 'pro', navigate: 'pro' })
  })
  it('names each move (the UiNext transitions)', () => {
    const all: ShellPhase[] = ['rest', 'awake', 'pro']
    const named = all.flatMap((a) => all.map((b) => [a, b, transitionOf(a, b)] as const)).filter(([, , t]) => t)
    expect(named).toEqual([
      ['rest', 'awake', 'wake'],
      ['awake', 'rest', 'settle'],
      ['awake', 'pro', 'fly-out'],
      ['pro', 'rest', 'settle'],
      ['pro', 'awake', 'fly-in'],
    ])
  })
})

describe('the Ω gesture', () => {
  it('reads a short press as a tap and an upward travel as a swipe', () => {
    expect(readGesture(0, 0)).toBe('tap')
    expect(readGesture(4, -5)).toBe('tap')
    expect(readGesture(0, -SWIPE_PX)).toBe('swipe')
    expect(readGesture(10, -60)).toBe('swipe')
  })
  it('a sideways drag, a downward drag or a short upward one is neither', () => {
    expect(readGesture(60, -40)).toBeNull()
    expect(readGesture(0, 60)).toBeNull()
    expect(readGesture(0, -(SWIPE_PX - 1))).toBeNull()
  })
  it('a printable key outside a field types into the Ask; modifiers, Space and fields do not', () => {
    expect(typesIntoAsk({ key: 'h' }, null)).toBe(true)
    expect(typesIntoAsk({ key: 'h', metaKey: true }, null)).toBe(false)
    // r2 (Kimi r1 #5): a key the focused control already took for itself stays with it
    expect(typesIntoAsk({ key: 'h', defaultPrevented: true }, null)).toBe(false)
    expect(typesIntoAsk({ key: ' ' }, null)).toBe(false)
    expect(typesIntoAsk({ key: 'Enter' }, null)).toBe(false)
    expect(typesIntoAsk({ key: 'h' }, { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe(false)
  })
})

describe('the opt-in', () => {
  const store = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
  }
  it('is off unless asked for, kept for the tab once asked, and off again with ?phases=0', () => {
    const s = store()
    expect(phasesOptedIn('', s)).toBe(false)
    expect(phasesOptedIn('?sim=1', s)).toBe(false)
    expect(phasesOptedIn('?sim=1&phases=1', s)).toBe(true)
    expect(phasesOptedIn('?sim=1', s)).toBe(true)
    expect(phasesOptedIn('?phases=0', s)).toBe(false)
    expect(phasesOptedIn('', s)).toBe(false)
  })
  it('a storage that throws leaves the URL to decide', () => {
    const bad = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') }, removeItem: () => { throw new Error('no') } }
    expect(phasesOptedIn('?phases=1', bad)).toBe(true)
    expect(phasesOptedIn('', bad)).toBe(false)
  })
})

describe('the store', () => {
  it('not phased: always Pro, and events change nothing (today’s behaviour)', () => {
    usePhase.getState().setPhased(false)
    expect(usePhase.getState().phase).toBe('pro')
    expect(usePhase.getState().send('power')).toBe('pro')
    expect(usePhase.getState().send('back')).toBe('pro')
    expect(usePhase.getState().phase).toBe('pro')
  })
  it('phased: starts at rest, follows the rules, remembers Pro was reached; leaving is Pro again', () => {
    const st = usePhase.getState()
    st.setPhased(true)
    expect(usePhase.getState().phase).toBe('rest')
    expect(usePhase.getState().send('pro')).toBe('rest')
    expect(usePhase.getState().send('omega-tap')).toBe('awake')
    expect(usePhase.getState().from).toBe('rest')
    expect(usePhase.getState().proSeen).toBe(false)
    expect(usePhase.getState().send('omega-swipe')).toBe('pro')
    expect(usePhase.getState().proSeen).toBe(true)
    expect(usePhase.getState().send('back')).toBe('awake')
    expect(usePhase.getState().send('power')).toBe('rest')
    usePhase.getState().setPhased(false)
    expect(usePhase.getState()).toMatchObject({ phased: false, phase: 'pro', proSeen: false })
  })
})

describe('the registry contract', () => {
  it('releases Jon-approved Professional, Still and Construct with Cosmos, while Classic stays candidate', () => {
    const withPhases = ALL_EXPERIENCES.filter((e) => e.phases).map((e) => e.id)
    expect(withPhases).toEqual(['classic', 'professional', 'cosmos', 'construct', 'still'])
    expect(ALL_EXPERIENCES.filter(e => e.phasesReviewed).map(e => e.id).sort()).toEqual(['construct', 'cosmos', 'professional', 'still'])
    for (const id of ['classic', 'flux', 'canvas']) expect(ALL_EXPERIENCES.find(e => e.id === id)?.phasesReviewed, id).not.toBe(true)
    expect(typeof CLASSIC.phases).toBe('function')
    expect(ALL_EXPERIENCES.find((e) => e.id === 'cosmos')?.phasesReviewed).toBe(true)
    expect(unreviewedAllowed({ PROD: true, MODE: 'production' })).toBe(false)
  })
  it('Classic shares a single renderer across rest and awake, preserving its mark', async () => {
    const m = await CLASSIC.phases!()
    expect(typeof m.rest).toBe('function')
    expect(m.awake).toBeUndefined()
  })
  it('Cosmos stays the reviewed experience it was (the candidate does not touch its verdict or entry)', () => {
    const c = ALL_EXPERIENCES.find((e) => e.id === 'cosmos')!
    expect(c.reviewed).toBe(true)
    expect(typeof c.load).toBe('function')
  })
  it('the Cosmos phases module draws rest and awake and has both hooks', async () => {
    const c = ALL_EXPERIENCES.find((e) => e.id === 'cosmos')!
    const m = await c.phases!()
    expect(typeof m.rest).toBe('function')
    expect(typeof m.awake).toBe('function')
    expect(typeof m.toPro).toBe('function')
    expect(typeof m.fromPro).toBe('function')
  })
})

describe('the idle owner hands its rest to the phases (features/power)', () => {
  it('an urgent event wakes a native rest: a pending decision, a budget refusal; nothing else, and not when awake', async () => {
    const { nativeWakeFor } = await import('../features/power/rest')
    const approval = { type: 'approval.created', approval: { id: 'a1', status: 'pending' } }
    const budget = { type: 'budget.refused' }
    expect(nativeWakeFor(approval, true)).toBe(true)
    expect(nativeWakeFor(budget, true)).toBe(true)
    expect(nativeWakeFor({ type: 'approval.created', approval: { id: 'a1', status: 'approved' } }, true)).toBe(false)
    expect(nativeWakeFor({ type: 'agent.status' }, true)).toBe(false)
    expect(nativeWakeFor(approval, false)).toBe(false)
    // and the shell moves rest → awake on it (Pro and awake stay where they are)
    expect(nextPhase('rest', 'urgent')).toBe('awake')
    expect(nextPhase('pro', 'urgent')).toBe('pro')
  })
})

describe('who began a rest (Design IDLE_PROVENANCE_3F2CAE3B: the five lifecycle cases)', () => {
  const st = () => usePhase.getState()
  const fresh = () => {
    st().setPhased(false)
    st().setPhased(true)
  }
  it('1. the opening rest, then the idle time, then an urgent event: stays at rest', () => {
    fresh()
    st().send('idle') // the delegated idle callback, with nothing to move
    expect(st().restBy).toBeNull()
    expect(st().wakeUrgent()).toBe('rest')
  })
  it('2. awake, power (the person rests it), idle, urgent: stays at rest', () => {
    fresh()
    st().send('omega-tap')
    st().send('power')
    st().send('idle')
    expect(st().restBy).toBeNull()
    expect(st().wakeUrgent()).toBe('rest')
  })
  it('3. awake or Pro, a real idle move into rest, urgent: wakes (to awake)', () => {
    fresh()
    st().send('omega-tap')
    st().send('idle')
    expect(st()).toMatchObject({ phase: 'rest', restBy: 'idle' })
    expect(st().wakeUrgent()).toBe('awake')
    expect(st().restBy).toBeNull()
    st().send('pro')
    expect(st().phase).toBe('pro')
    st().send('idle')
    expect(st().restBy).toBe('idle')
    expect(st().wakeUrgent()).toBe('awake')
  })
  it('4. an idle-begun rest, then another identity: its opening rest does not wake on urgent', () => {
    fresh()
    st().send('omega-tap')
    st().send('idle')
    expect(st().restBy).toBe('idle')
    // the identity reset (registered with lib/identityEpoch onIdentityChange)
    resetForIdentity()
    expect(st()).toMatchObject({ phase: 'rest', restBy: null, proSeen: false })
    expect(st().wakeUrgent()).toBe('rest')
  })
  it('5. opting out, or a new session: no idle ownership survives', () => {
    fresh()
    st().send('omega-tap')
    st().send('idle')
    st().setPhased(false)
    expect(st().restBy).toBeNull()
    expect(st().wakeUrgent()).toBe('pro')
    st().setPhased(true)
    expect(st()).toMatchObject({ phase: 'rest', restBy: null })
    expect(st().wakeUrgent()).toBe('rest')
  })
})

describe('r2: an app is a visit (the phase resumes when the same experience comes back)', () => {
  const st = () => usePhase.getState()
  it('coming back from an app: the same experience resumes where it was; another starts at rest', () => {
    st().setPhased(false)
    usePhase.setState({ resume: null })
    st().setPhased(true, 'cosmos')
    st().send('omega-tap')
    expect(st().phase).toBe('awake')
    st().setPhased(false, 'cosmos') // an app opens full screen
    expect(st()).toMatchObject({ phased: false, phase: 'pro', resume: { experience: 'cosmos', phase: 'awake' } })
    st().setPhased(true, 'cosmos') // and closes
    expect(st()).toMatchObject({ phased: true, phase: 'awake', resume: null })
    st().setPhased(false, 'cosmos')
    st().setPhased(true, 'nocturne')
    expect(st().phase).toBe('rest')
  })
  it('another identity never resumes the previous person’s place', () => {
    st().setPhased(false)
    st().setPhased(true, 'cosmos')
    st().send('omega-tap')
    st().setPhased(false, 'cosmos')
    resetForIdentity()
    expect(st().resume).toBeNull()
    st().setPhased(true, 'cosmos')
    expect(st().phase).toBe('rest')
  })
})

describe('identity rest survives the saved-look handoff', () => {
  it('does not let fallback and restored-look mounts replace the new identity rest with a landing preference', () => {
    const st = () => usePhase.getState()
    st().setPhased(false)
    st().setPhased(true, 'professional')
    st().send('omega-tap')
    resetForIdentity()
    let leaving = 'professional'
    for (const experience of ['classic', 'professional', 'classic', 'professional']) {
      st().setPhased(false, leaving)
      st().setPhased(true, experience, 'awake')
      expect(st()).toMatchObject({ phase: 'rest', proSeen: false, restBy: null })
      expect(st().wakeUrgent()).toBe('rest')
      leaving = experience
    }
    st().setPhased(false, 'professional')
    st().setPhased(true, 'professional', 'pro')
    expect(st().phase).toBe('rest')
    // The person's next real intent releases the rest; subsequent same-look visits work normally.
    expect(st().send('type')).toBe('awake')
    st().setPhased(false, 'professional')
    st().setPhased(true, 'professional', 'pro')
    expect(st().phase).toBe('awake')
  })
})

describe('r2: an app visit keeps who began the rest (Design cosmos-phase-resume-idle-r1, six cases)', () => {
  const st = () => usePhase.getState()
  const start = () => {
    st().setPhased(false)
    resetForIdentity()
    st().setPhased(true, 'cosmos')
  }
  const visit = (to = 'cosmos') => {
    st().setPhased(false, 'cosmos')
    st().setPhased(true, to)
  }
  it('1. an idle rest keeps its provenance across a same-experience app visit and still wakes for an urgent event', () => {
    start()
    st().send('omega-tap')
    st().send('idle')
    expect(st().restBy).toBe('idle')
    visit()
    expect(st()).toMatchObject({ phase: 'rest', restBy: 'idle' })
    expect(st().wakeUrgent()).toBe('awake')
  })
  for (const event of ['power', 'back'] as const)
    it(`2-3. a person-chosen rest (${event}) stays resting after an app visit and an urgent event`, () => {
      start()
      st().send('omega-tap')
      st().send(event)
      visit()
      expect(st()).toMatchObject({ phase: 'rest', restBy: null })
      expect(st().wakeUrgent()).toBe('rest')
    })
  it('4. the opening rest is not promoted to an idle rest by an app visit', () => {
    start()
    visit()
    expect(st().restBy).toBeNull()
    expect(st().wakeUrgent()).toBe('rest')
  })
  it('5. another experience never inherits the previous idle provenance', () => {
    start()
    st().send('omega-tap')
    st().send('idle')
    visit('nocturne')
    expect(st().restBy).toBeNull()
    expect(st().wakeUrgent()).toBe('rest')
  })
  it('6. an identity reset between leaving and returning removes the old phase and provenance', () => {
    start()
    st().send('omega-tap')
    st().send('idle')
    st().setPhased(false, 'cosmos')
    resetForIdentity()
    expect(st().resume).toBeNull()
    st().setPhased(true, 'cosmos')
    expect(st().restBy).toBeNull()
    expect(st().wakeUrgent()).toBe('rest')
  })
})

describe('r2.1: the native rest wakes on exactly the legacy rest’s predicate (Kimi r2 #3)', () => {
  it('a pending decision and a budget refusal wake both rests; a settled decision and other events wake neither', async () => {
    const { isUrgent, nativeWakeFor } = await import('../features/power/rest')
    const events = [
      { type: 'approval.created', approval: { status: 'pending' } },
      { type: 'budget.refused' },
      { type: 'approval.created', approval: { status: 'approved' } },
      { type: 'approval.updated', approval: { status: 'pending' } },
      { type: 'agent.status' },
    ]
    expect(events.map((e) => isUrgent(e))).toEqual([true, true, false, false, false])
    expect(events.map((e) => nativeWakeFor(e, true))).toEqual(events.map((e) => isUrgent(e)))
    // and the legacy rest uses that very predicate (RestScreen dispatches 'urgent' on isUrgent)
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string, e: 'utf8'): string }
    const host = fs.readFileSync(new URL('../features/power/RestScreen.tsx', import.meta.url).pathname, 'utf8')
    expect(host).toMatch(/if \(isUrgent\(e\)\) dispatch\(\{ type: 'urgent'/)
    expect(host).toMatch(/nativeWakeFor\(e, /)
  })
})

describe('r2.1: a pinch is the page’s zoom, never a tap, a swipe or navigation (stand-in r2 #1, Kimi r2 #2)', () => {
  const p = (id: number, x: number, y: number) => ({ pointerId: id, clientX: x, clientY: y })
  it('a one-finger press reads its travel; a press another finger joined reads as nothing, for every finger', () => {
    const r = onePointerPress(pointerHub())
    r.down(p(1, 100, 300))
    expect(r.up(p(1, 100, 200))).toEqual({ dx: 0, dy: -100 })
    // a pinch: two fingers spread and lift, in either order
    for (const order of [[1, 2], [2, 1]]) {
      r.down(p(1, 100, 300))
      r.down(p(2, 140, 300))
      for (const id of order) expect(r.up(p(id, id === 1 ? 40 : 220, 300))).toBeNull()
    }
    // the second finger lands after the first moved: still nothing, and nothing of it lingers for the next press
    r.down(p(1, 100, 300))
    r.down(p(2, 200, 300))
    expect(r.up(p(2, 260, 300))).toBeNull()
    expect(r.up(p(1, 100, 100))).toBeNull()
    r.down(p(3, 50, 50))
    expect(r.up(p(3, 52, 50))).toEqual({ dx: 2, dy: 0 })
  })
  it('a second finger landing elsewhere on the page (another element) still makes the press a pinch (r2.1 smoke at 390)', () => {
    const hub = pointerHub()
    const sky = onePointerPress(hub)
    sky.down(p(1, 195, 140))
    hub.down(2) // the second finger lands on a name or an app, not on the sky: only the page-wide listener sees it
    hub.up(2)
    expect(sky.up(p(1, 195, 40))).toBeNull()
    // and a finger already down elsewhere when the press starts
    hub.down(7)
    sky.down(p(3, 195, 300))
    expect(sky.up(p(3, 195, 200))).toBeNull()
    hub.up(7)
    sky.down(p(4, 195, 300))
    expect(sky.up(p(4, 195, 200))).toEqual({ dx: 0, dy: -100 })
  })
  it('a lone press the browser cancels reads as nothing, even if its pointer is later reported up', () => {
    const r = onePointerPress(pointerHub())
    r.down(p(1, 100, 300))
    r.cancel({ pointerId: 1 })
    expect(r.up(p(1, 100, 100))).toBeNull()
  })
  it('a press the browser cancels (it took the pinch) reads as nothing, and the next press is read again', () => {
    const r = onePointerPress(pointerHub())
    r.down(p(1, 100, 300))
    r.down(p(2, 150, 300))
    r.cancel({ pointerId: 1 })
    r.cancel({ pointerId: 2 })
    expect(r.up(p(1, 100, 100))).toBeNull()
    r.down(p(4, 0, 0))
    expect(r.up(p(4, 0, -50))).toEqual({ dx: 0, dy: -50 })
  })
  it('the Ω: a pinch on it neither taps nor swipes; one finger still does', () => {
    const tap = vi.fn()
    const swipe = vi.fn()
    const g = omegaGesture({ onTap: tap, onSwipe: swipe, hub: pointerHub() })
    g.onPointerDown(p(1, 100, 300))
    g.onPointerDown(p(2, 130, 300))
    g.onPointerUp(p(2, 130, 200))
    g.onPointerUp(p(1, 100, 200))
    expect([tap.mock.calls.length, swipe.mock.calls.length]).toEqual([0, 0])
    g.onPointerDown(p(3, 100, 300))
    g.onPointerUp(p(3, 100, 200))
    expect(swipe).toHaveBeenCalledTimes(1)
    g.onClick()
    expect(tap).not.toHaveBeenCalled()
    g.onPointerDown(p(4, 100, 300))
    g.onPointerUp(p(4, 101, 300))
    expect(tap).toHaveBeenCalledTimes(1)
  })
  it('a trackpad pinch (a wheel with ctrlKey) is not navigation; a plain wheel is', () => {
    expect(wheelIsNavigation({ ctrlKey: true })).toBe(false)
    expect(wheelIsNavigation({ ctrlKey: false })).toBe(true)
  })
  it('on the awake sky: a pinch or a ctrl-wheel leaves the view awake; a one-finger drag or a plain wheel goes to Pro', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(f: string, e: 'utf8'): string }
    const src = fs.readFileSync(new URL('../experiences/cosmos/phases.tsx', import.meta.url).pathname, 'utf8')
    // both skies read presses through onePointerPress and wheels through wheelIsNavigation (no raw pointer bookkeeping)
    expect(src.match(/const surface = useMemo\(\(\) => onePointerPress\(\), \[\]\)/g)?.length).toBe(2)
    expect(src.match(/if \(wheelIsNavigation\(e\)\) void usePhase\.getState\(\)\.send\('navigate'\)/g)?.length).toBe(2)
    expect(src.match(/onPointerCancel=\{\(e\) => surface\.cancel\(e\)\}/g)?.length).toBe(2)
    expect(src).not.toMatch(/onWheel=\{\(\) =>/)
  })
})

describe('r2.1: a kept place expires after the idle horizon (Kimi r2 #5)', () => {
  const st = () => usePhase.getState()
  // the person's rest minutes, as features/power stores them (this suite runs without a DOM)
  const prefs = new Map<string, string>()
  const setMinutes = (minutes: number) => {
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => prefs.get(k) ?? null } })
    prefs.set('omegahive.rest', JSON.stringify({ minutes }))
  }
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    prefs.clear()
  })
  const awakeThenApp = () => {
    st().setPhased(false)
    resetForIdentity()
    st().setPhased(true, 'cosmos')
    st().send('omega-tap')
    st().send('pro')
    st().setPhased(false, 'cosmos')
  }
  it('the rule: expired at the rest minutes, not before; 0 minutes never expires', () => {
    expect(resumeExpired(0, 119_999, 2)).toBe(false)
    expect(resumeExpired(0, 120_000, 2)).toBe(true)
    expect(resumeExpired(0, 10 * 3_600_000, 0)).toBe(false)
  })
  it('a return within the horizon resumes; one past it starts at rest, fresh (default two minutes)', () => {
    vi.useFakeTimers()
    awakeThenApp()
    vi.advanceTimersByTime(119_000)
    st().setPhased(true, 'cosmos')
    expect(st()).toMatchObject({ phase: 'pro', proSeen: true })
    st().setPhased(false, 'cosmos')
    vi.advanceTimersByTime(120_000)
    st().setPhased(true, 'cosmos')
    expect(st()).toMatchObject({ phase: 'rest', proSeen: false, restBy: null, resume: null })
  })
  it('follows the person’s own rest minutes, and never expires when they never rest', () => {
    vi.useFakeTimers()
    setMinutes(10)
    awakeThenApp()
    vi.advanceTimersByTime(5 * 60_000)
    st().setPhased(true, 'cosmos')
    expect(st().phase).toBe('pro')
    setMinutes(0)
    st().setPhased(false, 'cosmos')
    vi.advanceTimersByTime(24 * 3_600_000)
    st().setPhased(true, 'cosmos')
    expect(st().phase).toBe('pro')
  })
})

describe('R3.1 identity rest entry and explicit intents', () => {
  it('protects an identity change in an ordinary unphased look', () => {
    const before = usePhase.getState()
    try {
      usePhase.setState({ phased: false, identityRest: false, restBy: null, resume: null })
      resetForIdentity()
      expect(usePhase.getState().identityRest).toBe(true)
      usePhase.getState().setPhased(true, 'professional', 'pro')
      expect(usePhase.getState().phase).toBe('rest')
    } finally { usePhase.setState(before, true) }
  })
  it('person no-op intents release protection, but idle and urgent do not', () => {
    const before = usePhase.getState()
    try {
      for (const event of ['power', 'back', 'idle', 'urgent'] as const) {
        usePhase.setState({ phased: true, phase: 'rest', identityRest: true, restBy: null, resume: null })
        usePhase.getState().send(event)
        expect(usePhase.getState().identityRest, event).toBe(event === 'idle' || event === 'urgent')
      }
    } finally { usePhase.setState(before, true) }
  })
})
