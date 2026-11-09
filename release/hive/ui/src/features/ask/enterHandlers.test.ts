import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * uifix-r2.1 (stand-in FIX-FIRST on r2, Kimi r2): Enter's money paths, exercised through each Ask skin's ACTUAL key
 * handler and what it draws, not the pure row rule alone. Each skin component runs mounted under the repo's controlled
 * React stand-in (the dualP2 / askCustody pattern: hook slots, effects after render, a render when a setter changes),
 * against the real hive store, the real Ask store and the identity test kit's synthetic people. The one gate money
 * leaves through, askMind, records instead of sending. INVENTED data only; no hive, no provider, nothing leaves.
 *
 * Skins: Still's own field, Still's floating line, the Classic capsule, a floating skin (Cosmos's transmission; Flux,
 * Canvas and OmegaTown draw the same FloatingAsk/ClassicAsk), Professional, and Construct's prompt.
 */
const R = vi.hoisted(() => ({ own: null as null | { slots: unknown[]; effects: ({ deps?: unknown[]; cleanup?: unknown } | undefined)[]; dirty: boolean }, i: 0, ei: 0, pending: [] as (() => void)[], ids: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]))
  const slot = (init: () => unknown) => {
    const own = R.own!, n = R.i++
    if (!(n in own.slots)) own.slots[n] = init()
    return n
  }
  const memo = (f: () => unknown, deps?: unknown[]) => {
    const own = R.own!, n = slot(() => ({ deps: undefined, value: undefined, fresh: true }))
    const s = own.slots[n] as { deps?: unknown[]; value: unknown; fresh: boolean }
    if (s.fresh || changed(deps, s.deps)) own.slots[n] = { deps, value: f(), fresh: false }
    return (own.slots[n] as { value: unknown }).value
  }
  const effect = (fn: () => unknown, deps?: unknown[]) => {
    const own = R.own!, n = R.ei++, prev = own.effects[n]
    if (!prev || changed(deps, prev.deps)) R.pending.push(() => {
      if (typeof prev?.cleanup === 'function') (prev.cleanup as () => void)()
      own.effects[n] = { deps, cleanup: fn() }
    })
  }
  const m = { ...actual,
    useState: (init: unknown) => {
      const own = R.own!, n = slot(() => typeof init === 'function' ? (init as () => unknown)() : init)
      return [own.slots[n], (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(own.slots[n]) : v
        if (!Object.is(next, own.slots[n])) { own.slots[n] = next; own.dirty = true }
      }]
    },
    useRef: (v: unknown) => R.own!.slots[slot(() => ({ current: v }))],
    useCallback: (f: unknown, deps?: unknown[]) => memo(() => f, deps), useMemo: memo,
    useId: () => R.own!.slots[slot(() => `:enter${++R.ids}:`)],
    useSyncExternalStore: (subscribe: (changed: () => void) => () => void, get: () => unknown) => {
      const own = R.own!, n = slot(() => ({ get, value: get() }))
      const snapshot = own.slots[n] as { get: () => unknown; value: unknown }
      snapshot.get = get; snapshot.value = get()
      effect(() => {
        const changed = () => {
          const next = snapshot.get()
          if (!Object.is(snapshot.value, next)) { snapshot.value = next; own.dirty = true }
        }
        const off = subscribe(changed)
        changed()
        return off
      }, [subscribe])
      return snapshot.value
    }, useDebugValue: () => undefined,
    useContext: (c: { _currentValue?: unknown }) => c._currentValue, useEffect: effect, useLayoutEffect: effect,
  }
  return { ...m, default: m }
})
// External Zustand's React binding is outside the stand-in's module graph: bridge only its hook (the dualP2 pattern)
async function bridged<S>(store: { getState: () => S; subscribe: (l: () => void) => () => void }) {
  const { useSyncExternalStore } = await import('react')
  return Object.assign((sel?: (s: S) => unknown) => {
    const read = () => (sel ? sel(store.getState()) : store.getState())
    return useSyncExternalStore(store.subscribe, read, read)
  }, store)
}
vi.mock('../../store/store', async () => {
  const actual = await vi.importActual<typeof import('../../store/store')>('../../store/store')
  return { ...actual, useHive: await bridged(actual.useHive) }
})
vi.mock('../../store/ask', async () => {
  const actual = await vi.importActual<typeof import('../../store/ask')>('../../store/ask')
  return { ...actual, useAskStore: await bridged(actual.useAskStore) }
})
vi.mock('../../shell/phase', async () => {
  const actual = await vi.importActual<typeof import('../../shell/phase')>('../../shell/phase')
  return { ...actual, usePhase: await bridged(actual.usePhase) }
})
vi.mock('../mind/store', async () => {
  const actual = await vi.importActual<typeof import('../mind/store')>('../mind/store')
  return { ...actual, useMind: await bridged(actual.useMind) }
})
vi.mock('../../experiences/construct/state', async () => {
  const actual = await vi.importActual<typeof import('../../experiences/construct/state')>('../../experiences/construct/state')
  return { ...actual, useC: await bridged(actual.useC) }
})
// framer-motion's presence hook (read by ui/useModalContainment) is a presentation leaf outside the stand-in
vi.mock('framer-motion', async (orig) => ({ ...(await orig<typeof import('framer-motion')>()), useIsPresent: () => true }))
// the one gate money leaves the page through (features/ask/mind): recorded, never sent
const M = vi.hoisted(() => ({ asks: [] as string[] }))
vi.mock('./mind', async (orig) => ({ ...(await orig<typeof import('./mind')>()), askMind: async (text: string) => void M.asks.push(text) }))

const windowEvents = new Map<string, Set<(event: unknown) => void>>()
const win = { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener(type: string, fn: (event: unknown) => void) { (windowEvents.get(type) ?? windowEvents.set(type, new Set()).get(type)!).add(fn) }, removeEventListener(type: string, fn: (event: unknown) => void) { windowEvents.get(type)?.delete(fn) }, dispatchEvent(event: { type: string }) { for (const fn of windowEvents.get(event.type) ?? []) fn(event); return true }, innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, getComputedStyle: () => ({}) }
const doc = { documentElement: { lang: 'en-GB', style: { setProperty() {}, removeProperty() {} }, dataset: {} }, body: {}, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {} }) }
vi.stubGlobal('window', win)
vi.stubGlobal('document', doc)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
vi.stubGlobal('navigator', { userAgent: '', language: 'en-GB' })

const { useHive } = await import('../../store/store')
const { useAskStore, askRetryContext } = await import('../../store/ask')
const { testPerson, signInAs, releasePersons, reportTestPrincipal } = await import('../../lib/identityEpoch.testkit')
const { ClassicAsk, FloatingAsk } = await import('./ClassicAsk')
const { VoiceNoticeView } = await import('./VoiceParts')
const { StillLine } = await import('./StillLine')
const { Ask: StillAsk } = await import('../../experiences/still/Ask')
const { ProfessionalAsk } = await import('../../experiences/professional/Ask')
const { CommandLine } = await import('../../experiences/construct/CommandLine')
const professionalBinding = await import('../../experiences/professional/binding')
const { REFUSED, useAskField, useSeen } = await import('./useAskField')
const { noteComposition, noteKeyCapture, resetComposition } = await import('./keys')
const { default: voiceSource } = await import('./useAskVoice.ts?raw')
const { ARM_MS } = await import('../../lib/decisionGate')
const { NoteRow } = await import('./Thread')
const { askAutoWake } = await import('../../store/askAutoWake')
const { currentEpoch } = await import('../../lib/identityEpoch')

interface El { type: unknown; props: Record<string, unknown> }
const isEl = (x: unknown): x is El => !!x && typeof x === 'object' && 'type' in x && 'props' in x
function find(x: unknown, f: (e: El) => boolean): El[] {
  if (Array.isArray(x)) return x.flatMap((n) => find(n, f))
  if (!isEl(x)) return []
  return [...(f(x) ? [x] : []), ...find(x.props.children, f)]
}
const text = (x: unknown): string => (typeof x === 'string' || typeof x === 'number' ? String(x) : Array.isArray(x) ? x.map(text).join(' ') : isEl(x) ? text(x.props.children) : '')
interface Mounted { readonly tree: unknown; settle(): void; unmount(): void }
function mount(component: () => unknown): Mounted {
  const own = { slots: [] as unknown[], effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], dirty: true }
  let tree: unknown
  const render = () => {
    own.dirty = false; R.own = own; R.i = R.ei = 0; R.pending = []
    tree = component()
    const pending = R.pending; R.pending = []; pending.forEach((f) => f())
  }
  const settle = () => { for (let i = 0; own.dirty && i < 20; i++) render(); expect(own.dirty, 'settled').toBe(false) }
  const out = { get tree() { return tree }, settle, unmount: () => own.effects.forEach((e) => typeof e?.cleanup === 'function' && (e.cleanup as () => void)()) }
  mounted.push(out); settle(); return out
}
let mounted: Mounted[] = []

// ------------------------------------------------------------------ the skins, as their hosts mount them
const inputRef = { current: null }
const place = { mode: 'desktop' as const, bottom: 74, left: 400, width: 640 }
const world = { minds: [{ id: 'a_vega01', name: 'Vega', awake: true, swarm: 'Lyra' }], swarms: [], pending: 0, experiences: [], looks: [] }
const stillActs: string[] = []
let stillSearch: () => Promise<unknown> = async () => ({ text: 'Invented results', keep: true, results: [] })
const SKINS = {
  still: () => StillAsk({ inputRef, world, onAct: (a: { do: string }) => (stillActs.push(a.do), a.do === 'search' ? stillSearch() : null) } as never),
  stillLine: () => StillLine({ place, inputRef, words: [] }),
  // ClassicAsk is FloatingAsk with the capsule look (Classic, OmegaTown)
  capsule: () => FloatingAsk({ place, experience: 'classic', inputRef, look: 'capsule' }),
  floating: () => FloatingAsk({ place, experience: 'cosmos', inputRef, look: 'transmission' }),
  professional: () => ProfessionalAsk({ ctx: professionalBinding.contextOf(useHive.getState()), inputRef }),
  construct: () => CommandLine({ phone: false }),
} as const
type Skin = keyof typeof SKINS
const ALL = Object.keys(SKINS) as Skin[]
/** skins whose voice notice REPLACES the rows (Still's own field keeps its rows on screen beside the notice) */
const NOTICE_HIDES_ROWS: Skin[] = ['stillLine', 'capsule', 'floating', 'professional']

const key = (k: string, more: Record<string, unknown> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, keyCode: k === 'Enter' ? 13 : 0, preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false }, ...more })
const flush = async () => { for (let k = 0; k < 8; k++) await Promise.resolve() }
const inputOf = (m: Mounted) => find(m.tree, (e) => e.type === 'input')[0]
const valueOf = (m: Mounted) => inputOf(m).props.value
/** ask-send-r1: a floating Ask's focus is its capsule's (focus anywhere within it); the other skins' is their field's */
const capsuleOf = (m: Mounted) => find(m.tree, (e) => 'data-ask-capsule' in e.props)[0] as El | undefined
async function type(m: Mounted, words: string) {
  ;((capsuleOf(m) ?? inputOf(m)).props.onFocus as (() => void) | undefined)?.()
  m.settle()
  ;(inputOf(m).props.onChange as (e: unknown) => void)({ target: { value: words } })
  m.settle()
}
async function press(m: Mounted, k = 'Enter', more: Record<string, unknown> = {}) {
  const ev = key(k, more)
  // what the page's capture listener does first, for every key, on the very native event the field then reads
  const native = ev.nativeEvent as Record<string, unknown>
  native.key ??= k
  native.keyCode ??= (ev as { keyCode: number }).keyCode
  noteKeyCapture(native)
  ;(inputOf(m).props.onKeyDown as (e: unknown) => void)(ev)
  await flush()
  m.settle()
  await flush()
  m.settle()
}
const searched = () => stillActs.filter((a) => a === 'search').length + palette.mock.calls.length
const refusedWith = (body: string) => useHive.getState().toasts.some((t) => t.title === 'Nothing was sent' && t.body === body)
const palette = vi.fn()
let clock = 1_000_000

beforeEach(async () => {
  win.location.hash = '#/'
  resetComposition()
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  M.asks.length = 0
  stillActs.length = 0
  palette.mockClear()
  stillSearch = async () => ({ text: 'Invented results', keep: true, results: [] })
  await signInAs(testPerson(`p${++clock}`))
  useAskStore.getState().bind(useHive.getState().session, 'user:p_invented')
  useHive.setState({ openPalette: palette, toasts: [] })
  clock += 10_000
})
afterEach(() => {
  mounted.reverse().forEach((m) => m.unmount())
  mounted = []
  useAskStore.getState().reset()
  releasePersons()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
/** a turn in flight, as the Ask store holds one once the host admitted it */
function turnOpen() {
  useAskStore.setState({ open: 'op_invented', turns: { op_invented: { op: 'op_invented', you: 'invented question', state: 'open', lastSeq: 1, events: [], outcomes: {}, notes: [] } as never } })
}

describe('r2.1 stand-in #2 / Kimi #1: an IME-confirming Enter never sends, in every skin', () => {
  it.each(ALL)('%s: compositionstart, Enter (isComposing), Enter (keyCode 229), compositionend, Safari\'s 229 as the first key after, then Enter acts once', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    noteComposition('start')
    // composing: the browser marks the confirming key, or sends it as keyCode 229 during the composition
    await press(m, 'Enter', { nativeEvent: { isComposing: true } })
    await press(m, 'Enter', { keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })
    noteComposition('end')
    // Safari: the confirming Enter arrives as 229, the first key AFTER compositionend, however long after (a busy page)
    clock += 5_000
    await press(m, 'Enter', { keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })
    expect(M.asks, skin).toEqual([])
    expect(searched(), skin).toBe(0)
    expect(valueOf(m), skin).toBe('kelp')
    // the composition's key is spent: the next plain Enter is the person's (Ask Vega)
    await press(m, 'Enter')
    expect(M.asks, skin).toEqual(['kelp'])
  })
  it.each(ALL)('%s: r2.3: a 229 that is NOT the first key after a composition (another key came between) is an ordinary Enter', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    noteComposition('start')
    noteComposition('end')
    noteKeyCapture({ key: 'Shift', keyCode: 16 }) // some other key came first: the composition's own key is spent
    await press(m, 'Enter', { keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })
    expect(M.asks, skin).toEqual(['kelp'])
  })
  it.each(ALL)('%s: Kimi r2.1 #4: a stray keyCode 229 Enter with no composition around it is an ordinary Enter (never dead)', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    await press(m, 'Enter', { keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } })
    expect(M.asks, skin).toEqual(['kelp'])
  })
})

describe('r2.1: the IME guard holds at each layer of its own', () => {
  it('the shared hook itself (every skin hands it their keys): a composing Enter does nothing', async () => {
    const { useAskField } = await import('./useAskField')
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().change('kelp'); m.settle()
    f().declareSeen({ rows: true, panel: false })
    noteComposition('start')
    f().onKeyDown(key('Enter', { nativeEvent: { isComposing: true } }) as never); await flush(); m.settle()
    f().onKeyDown(key('Enter', { keyCode: 229 }) as never); await flush(); m.settle()
    expect(M.asks).toEqual([])
    noteComposition('end')
    noteKeyCapture({ key: 'Shift', keyCode: 16 }) // the composition's own key is spent
    noteKeyCapture({ key: 'Enter', keyCode: 13 })
    f().onKeyDown(key('Enter') as never); await flush(); m.settle()
    expect(M.asks).toEqual(['kelp'])
  })
  it("Construct's command path (commands never pass through the Ask): a composing Enter runs no command", async () => {
    const { useC } = await import('../../experiences/construct/state')
    useC.setState({ console: [] })
    const m = mount(SKINS.construct)
    await type(m, 'help')
    await press(m, 'Enter', { nativeEvent: { isComposing: true } })
    expect(useC.getState().console).toHaveLength(0)
    expect(valueOf(m)).toBe('help')
    await press(m)
    expect(useC.getState().console.length).toBeGreaterThan(0)
  })
})

describe('r2.1 stand-in #1: mid-turn, Enter steers only when the steer row is the highlighted one', () => {
  it.each(ALL)('%s: a turn in flight, one typed letter: no steer row, and Enter takes the highlighted Search, not the mind', async (skin) => {
    const m = mount(SKINS[skin])
    turnOpen(); m.settle()
    await type(m, 'k')
    await press(m)
    expect(M.asks, skin).toEqual([])
    expect(searched(), skin).toBe(1)
  })
  it.each(ALL)('%s: a turn in flight, words long enough for the steer row: it is first, and Enter steers', async (skin) => {
    const m = mount(SKINS[skin])
    turnOpen(); m.settle()
    await type(m, 'only the open tasks')
    expect(text(m.tree)).toMatch(/Tell/)
    await press(m)
    expect(M.asks, skin).toEqual(['only the open tasks'])
    expect(searched(), skin).toBe(0)
  })
  it.each(ALL)('%s: list transitions: the turn opens under typed words (Ask row becomes the steer row): that Enter waits, then steers', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    turnOpen(); m.settle() // a refresh: the words did not change, the row Enter runs did
    await press(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.changed), skin).toBe(true)
    clock += ARM_MS + 10
    await press(m)
    expect(M.asks, skin).toEqual(['kelp'])
    // the turn ends while the words stand: the steer row goes, the Ask row returns; it waits again, never a silent send
    useAskStore.setState({ open: null }); m.settle()
    useHive.setState({ toasts: [] })
  })
})

describe('r2.1 stand-in #3: a voice notice in place of the rows: Enter sends nothing, and says so', () => {
  /** the voice notice the skin draws (VoiceNoticeView is a child component: read what it is given) */
  const notice = (m: Mounted) => (find(m.tree, (e) => e.type === VoiceNoticeView)[0]?.props.v as { notice: { kind: string } | null } | undefined)?.notice
  const mic = (m: Mounted) => find(m.tree, (e) => e.type === 'button' && 'aria-pressed' in e.props)[0]
  it.each(ALL.filter((s) => s !== 'construct'))('%s: the unsupported-microphone notice, then Enter', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    ;(mic(m).props.onClick as (e: unknown) => void)({ detail: 0, preventDefault() {} })
    m.settle()
    expect(notice(m)?.kind, skin).toBe('say')
    await press(m)
    if (NOTICE_HIDES_ROWS.includes(skin)) {
      expect(M.asks, skin).toEqual([])
      expect(searched(), skin).toBe(0)
      expect(refusedWith(REFUSED.hidden), skin).toBe(true)
    } else {
      // Still keeps its rows (and their highlight) on screen beside the notice: Enter does what they show
      expect(M.asks, skin).toEqual(['kelp'])
    }
  })
  it.each(ALL.filter((s) => s !== 'construct'))('%s: the microphone-consent notice, then Enter', async (skin) => {
    // a browser whose speech service needs the person's consent (the reviewConsent recognition stand-in)
    class Rec { lang = ''; continuous = false; interimResults = false; onstart = null; onresult = null; onerror = null; onend = null; start() {} stop() {} abort() {} }
    vi.stubGlobal('SpeechRecognition', Rec)
    vi.stubGlobal('isSecureContext', true)
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    ;(mic(m).props.onClick as (e: unknown) => void)({ detail: 0, preventDefault() {} })
    await flush(); m.settle(); await flush(); m.settle()
    expect(notice(m)?.kind, skin).toBe('consent')
    await press(m)
    if (NOTICE_HIDES_ROWS.includes(skin)) {
      expect(M.asks, skin).toEqual([])
      expect(refusedWith(REFUSED.hidden), skin).toBe(true)
    } else expect(M.asks, skin).toEqual(['kelp'])
  })
})

describe('r2.1 Kimi #3 and #4: no silent miss; a refresh never moves a paid row under a pending Enter', () => {
  it('busy: an Enter while the last act still runs is said, and nothing new is sent', async () => {
    let finish: (v: unknown) => void = () => undefined
    stillSearch = () => new Promise((r) => (finish = r))
    const m = mount(SKINS.still)
    await type(m, 'kelp')
    ;(inputOf(m).props.onKeyDown as (e: unknown) => void)(key('ArrowDown')); m.settle()
    await press(m) // Search runs and is still running
    expect(stillActs).toEqual(['search'])
    await press(m)
    expect(stillActs).toEqual(['search'])
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.busy)).toBe(true)
    finish({ text: 'done', keep: true })
    await flush()
  })
  it.each(ALL)('%s: a refresh that pulls the highlighted row away (the named mind leaves): the paid row that replaces it waits', async (skin) => {
    const agent = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_wren', name: 'Wren', kind: 'omega' as const, status: 'awake' as const }
    useHive.setState({ agents: { ...useHive.getState().agents, [agent.id]: agent } })
    const m = mount(SKINS[skin])
    await type(m, 'Wren')
    // row 0 is a view (open Wren), not a paid row
    const before = find(m.tree, (e) => e.props.role === 'option' && e.props['aria-selected'] === true).map(text).join(' ')
    expect(before, skin).not.toMatch(/^\s*Ask\b/)
    const { [agent.id]: _gone, ...rest } = useHive.getState().agents
    useHive.setState({ agents: rest }); m.settle()
    await press(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.changed), skin).toBe(true)
    clock += ARM_MS + 10
    await press(m)
    expect(M.asks, skin).toEqual(['Wren'])
  })
  it.each(ALL)('%s: typing that changes the Enter row is the person reading as they type: no wait (only a refresh waits)', async (skin) => {
    const agent = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_wren', name: 'Wren', kind: 'omega' as const, status: 'awake' as const }
    useHive.setState({ agents: { ...useHive.getState().agents, [agent.id]: agent } })
    const m = mount(SKINS[skin])
    await type(m, 'Wren') // row 0: open Wren (a view)
    await type(m, 'Wrens') // row 0 becomes the paid Ask row, because of the person's own keystroke
    await press(m)
    expect(M.asks, skin).toEqual(['Wrens'])
    expect(refusedWith(REFUSED.changed), skin).toBe(false)
  })
  it.each(ALL)('%s: an unrelated refresh leaves row 0 and its Enter exactly as they were (no wait, no move)', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    const row0 = () => find(m.tree, (e) => e.props.role === 'option' && e.props['aria-selected'] === true).map(text).join(' ')
    const before = row0()
    const extra = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_quill', name: 'Quill' }
    useHive.setState({ agents: { ...useHive.getState().agents, [extra.id]: extra }, toasts: [] }); m.settle()
    expect(row0(), skin).toBe(before)
    await press(m)
    expect(M.asks, skin).toEqual(['kelp'])
    expect(refusedWith(REFUSED.changed), skin).toBe(false)
  })
})

describe("r2.2 stand-in P1: Construct's `ask <words>` shows its paid row and goes through the guarded Enter", () => {
  const selected = (m: Mounted) => find(m.tree, (e) => e.props.role === 'option' && e.props['aria-selected'] === true).map(text).join(' ')
  it('idle: `ask kelp` shows "Ask … “kelp”" highlighted; Enter asks once, through the Ask (never the command line)', async () => {
    const m = mount(SKINS.construct)
    await type(m, 'ask kelp')
    expect(selected(m)).toMatch(/Ask[\s\S]*kelp/)
    await press(m)
    expect(M.asks).toEqual(['kelp'])
  })
  it('idle: `ask k` (too short for a row): nothing is shown, and Enter refuses and says so', async () => {
    const m = mount(SKINS.construct)
    await type(m, 'ask k')
    expect(selected(m)).toBe('')
    await press(m)
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.empty)).toBe(true)
  })
  it('idle: the prompt not in use (blurred, its row not drawn): Enter refuses, nothing is sent', async () => {
    const m = mount(SKINS.construct)
    await type(m, 'ask kelp')
    ;(inputOf(m).props.onBlur as () => void)(); m.settle()
    await press(m)
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.hidden)).toBe(true)
  })
  it('live turn: `ask kelp` shows the steer row highlighted; Enter steers once', async () => {
    const m = mount(SKINS.construct)
    turnOpen(); m.settle()
    await type(m, 'ask kelp')
    expect(selected(m)).toMatch(/Tell[\s\S]*kelp/)
    await press(m)
    expect(M.asks).toEqual(['kelp'])
  })
  it('live turn opening under `ask kelp` (a refresh): that Enter waits, then steers', async () => {
    const m = mount(SKINS.construct)
    await type(m, 'ask kelp')
    turnOpen(); m.settle()
    await press(m)
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.changed)).toBe(true)
    clock += ARM_MS + 10
    await press(m)
    expect(M.asks).toEqual(['kelp'])
  })
})

describe('r2.2 stand-in P1 (and Kimi r2.1 #5): same-row typing never defeats the refresh guard', () => {
  it.each(ALL)('%s: "kelp", then "kelps" (the same Ask row), then a turn opens, then Enter at once: it waits, then steers', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    await type(m, 'kelps')
    turnOpen(); m.settle()
    await press(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.changed), skin).toBe(true)
    clock += ARM_MS + 10
    await press(m)
    expect(M.asks, skin).toEqual(['kelps'])
  })
  it('spoken words that bring a paid row in are not typing: that Enter waits (interim words included)', async () => {
    const agent = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_wren', name: 'Wren', kind: 'omega' as const, status: 'awake' as const }
    useHive.setState({ agents: { ...useHive.getState().agents, [agent.id]: agent } })
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().declareSeen({ rows: true, panel: false })
    f().voiceText('Wren'); m.settle() // row 0: open Wren (a view)
    f().voiceText('Wrens'); m.settle() // interim words: row 0 becomes the paid Ask row, by voice
    await f().submit(); await flush(); m.settle()
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.changed)).toBe(true)
    clock += ARM_MS + 10
    await f().submit(); await flush(); m.settle()
    expect(M.asks).toEqual(['Wrens'])
  })
})

describe('r2.2 Kimi r2.1 #1-#3: per-field declarations, panel-only Enter, quiet voice refusals', () => {
  it("Still's own field: its rows count only while it is the field in use (focused); blurred, its Enter refuses", async () => {
    const m = mount(SKINS.still)
    await type(m, 'kelp')
    ;(inputOf(m).props.onBlur as () => void)(); m.settle()
    await press(m)
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.hidden)).toBe(true)
  })
  it('a skin that unmounts withdraws its declaration: a retained handle of that field then acts on nothing', async () => {
    const m = mount(() => {
      const f = useAskField({ experience: 'still' })
      useSeen(f.declareSeen, true, false)
      return f
    })
    const f = m.tree as ReturnType<typeof useAskField>
    f.change('kelp'); m.settle()
    const live = m.tree as ReturnType<typeof useAskField>
    m.unmount()
    await live.submit(); await flush()
    expect(M.asks).toEqual([])
    expect(refusedWith(REFUSED.hidden)).toBe(true)
  })
  it('only a panel on screen ("Did you mean…"): Enter refuses with the panel\'s reason; no unseen act runs, paid or not', async () => {
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().change('show usage'); m.settle()
    f().setPanel({ kind: 'choose', options: [] }); m.settle()
    f().declareSeen({ rows: false, panel: true })
    const before = window.location.hash
    await f().submit(); await flush(); m.settle()
    expect(M.asks).toEqual([])
    expect(window.location.hash).toBe(before) // the view the policy would have opened was not opened
    expect(refusedWith(REFUSED.panel)).toBe(true)
  })
  it('voice send-on-pause refused (nothing visible): quiet: no notice, and the words stay in the field', async () => {
    const m = mount(() => useAskField({ experience: 'classic' }))
    const f = () => m.tree as ReturnType<typeof useAskField>
    f().voiceText('kelp'); m.settle()
    // nothing declared: a voice notice replaced the rows
    await f().submit({ quiet: true }); await flush(); m.settle()
    expect(M.asks).toEqual([])
    expect(useHive.getState().toasts).toEqual([])
    expect(f().value).toBe('kelp')
    // and the voice hook's send-on-pause is that quiet submit
    expect(voiceSource).toContain('void fRef.current.submit({ quiet: true })')
  })
})

describe('r2.2 audit: the other composer that sends a typed request to a mind', () => {
  it("the Code canvas's change prompt (a paid request) ignores an IME's confirming Enter, with the same shared rule", async () => {
    const { default: code } = await import('../code/canvas/CodeCanvas.tsx?raw')
    expect(code).toContain("import { guardComposing } from '../../ask/keys'")
    expect(code).toMatch(/if \(guardComposing\(e\)\) return\s+if \(e\.key === 'Enter' && !e\.shiftKey\) \{\s+e\.preventDefault\(\)\s+onSend\(\)/)
  })
})

describe('r2.3 stand-in P1: an IME-confirming Enter does nothing else either (no implicit form submission)', () => {
  it.each(ALL)("%s: Safari's confirming 229 just after compositionend has its default cancelled; mid-composition the input method's Enter is left alone", async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    const tail = vi.fn()
    const during = vi.fn()
    noteComposition('start')
    await press(m, 'Enter', { nativeEvent: { isComposing: true }, preventDefault: during })
    noteComposition('end')
    await press(m, 'Enter', { keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 }, preventDefault: tail })
    expect(tail, skin).toHaveBeenCalled()
    // cancelling an active composition's Enter can stop WebKit committing the candidate: never done
    expect(during, skin).not.toHaveBeenCalled()
    expect(M.asks, skin).toEqual([])
  })
  it("Professional: the form's own submission (what Enter's implicit submission fires) never dispatches; the Ask button's click does", async () => {
    const m = mount(SKINS.professional)
    await type(m, 'kelp')
    const form = find(m.tree, (e) => e.type === 'form')[0]
    const prevented = vi.fn()
    ;(form.props.onSubmit as (e: unknown) => void)({ preventDefault: prevented })
    await flush(); m.settle()
    expect(prevented).toHaveBeenCalled()
    expect(M.asks).toEqual([])
    const ask = find(m.tree, (e) => e.type === 'button' && text(e) === 'Ask')[0]
    expect(ask.props.type).toBe('button') // not a submit button: Enter's implicit submission has no default button to press
    ;(ask.props.onClick as () => void)()
    await flush(); m.settle()
    expect(M.asks).toEqual(['kelp'])
  })
})

describe('r2.3 Kimi r2.2 #1, #2: a refused `ask` keeps a pending yes/no; recalled words are a refresh', () => {
  it("Construct: a refused `ask k` leaves the pending yes/no (and prints no echo); an `ask kelp` that acts cancels it, then echoes", async () => {
    const { useC } = await import('../../experiences/construct/state')
    const { run } = await import('../../experiences/construct/commands')
    const approvals = Object.values(useHive.getState().approvals).filter((a) => a.status === 'pending')
    expect(approvals.length).toBeGreaterThan(0)
    useC.setState({ console: [] })
    await run('approve 1')
    const consoleText = () => useC.getState().console.map((l) => l.segs.map((x) => x.t).join('')).join('\n')
    expect(consoleText()).toMatch(/yes.*to go ahead/)
    const m = mount(SKINS.construct)
    await type(m, 'ask k')
    await press(m)
    expect(consoleText()).not.toMatch(/cancelled/)
    expect(consoleText()).not.toMatch(/ask k/)
    await type(m, 'ask kelp')
    await press(m)
    expect(M.asks).toEqual(['kelp'])
    expect(consoleText()).toMatch(/approve #1: cancelled, nothing changed/)
    expect(consoleText()).toMatch(/ask kelp/)
  })
  it.each(ALL.filter((s) => s !== 'construct'))('%s: ArrowUp recalls earlier words: the row they bring waits out the arming window', async (skin) => {
    const m = mount(SKINS[skin])
    await type(m, 'kelp')
    await press(m)
    expect(M.asks, skin).toEqual(['kelp'])
    expect(valueOf(m), skin).toBe('')
    ;(inputOf(m).props.onKeyDown as (e: unknown) => void)(key('ArrowUp')); m.settle()
    expect(valueOf(m), skin).toBe('kelp')
    await press(m)
    expect(M.asks, skin).toEqual(['kelp'])
    expect(refusedWith(REFUSED.changed), skin).toBe(true)
    clock += ARM_MS + 10
    await press(m)
    expect(M.asks, skin).toEqual(['kelp', 'kelp'])
  })
})

describe('r2.3 audit: every direct mind chat composer ignores an IME-confirming Enter with the shared rule', () => {
  const COMPOSERS = ['features/dot/Chat.tsx', 'experiences/professional/Conversation.tsx', 'experiences/cosmos/Panels.tsx', 'experiences/flux/panels.tsx', 'experiences/canvas/chat.tsx', 'experiences/still/Reading.tsx', 'experiences/canvas/parts.tsx']
  it.each(COMPOSERS)('%s', async (file) => {
    const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: string, e: 'utf8') => string }
    const src = fs.readFileSync(new URL(`../../${file}`, import.meta.url).pathname, 'utf8')
    expect(src).toMatch(/import \{ guardComposing \} from '(\.\.\/)+(features\/)?ask\/keys'/)
    expect(src).not.toMatch(/isComposing/)
    expect(src).toMatch(/guardComposing\(e\)/)
  })
})

describe('r2.3/r2.4: the composition rule is ordinal, per field, decided in the capture phase, and wired to the page', () => {
  it('wired: compositions per field on the document, every key captured on the window before any field', async () => {
    const { default: keysSource } = await import('./keys.ts?raw')
    expect(keysSource).toContain("window.addEventListener('keydown', noteKeyCapture, true)")
    expect(keysSource).toContain("document.addEventListener('compositionend', (e) => noteComposition('end', e.target), true)")
    expect(keysSource).toContain("document.addEventListener('compositionstart', (e) => noteComposition('start', e.target), true)")
    expect(keysSource).not.toMatch(/performance\.now|_MS\b/)
  })
  it('Kimi r2.3 #4: a composition in field A never arms field B: B\'s 229 Enter is an ordinary key, A\'s is the confirming key', async () => {
    const { composingKey } = await import('./keys')
    const A = {}, B = {}
    noteComposition('start', A)
    noteComposition('end', A)
    const toB = { key: 'Enter', keyCode: 229, isComposing: false, target: B }
    noteKeyCapture(toB)
    expect(composingKey({ keyCode: 229, nativeEvent: toB })).toBe(false)
    const toA = { key: 'Enter', keyCode: 229, isComposing: false, target: A }
    noteKeyCapture(toA)
    expect(composingKey({ keyCode: 229, nativeEvent: toA })).toBe(true)
  })
  it('Kimi r2.3 #2: the capture listener spends the credit for EVERY key, even one a field then stops: no leak to a later 229', async () => {
    const { composingKey } = await import('./keys')
    const A = {}
    noteComposition('start', A)
    noteComposition('end', A)
    // a key the field's own handler stops (stopPropagation): the capture listener has already run for it
    noteKeyCapture({ key: 'a', keyCode: 65, target: A })
    const later = { key: 'Enter', keyCode: 229, isComposing: false, target: A }
    noteKeyCapture(later)
    expect(composingKey({ keyCode: 229, nativeEvent: later })).toBe(false)
  })
  it('the capture listener cancels a confirming Enter\'s default once the composition has ended (no implicit form submission anywhere), never mid-composition', async () => {
    const A = {}
    const after = vi.fn(), during = vi.fn()
    noteComposition('start', A)
    noteKeyCapture({ key: 'Enter', keyCode: 229, isComposing: false, target: A, preventDefault: during })
    noteComposition('end', A)
    noteKeyCapture({ key: 'Enter', keyCode: 229, isComposing: false, target: A, preventDefault: after })
    expect(during).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalled()
    // an ordinary Enter in a field with no composition: untouched
    const plain = vi.fn()
    noteKeyCapture({ key: 'Enter', keyCode: 13, isComposing: false, target: {}, preventDefault: plain })
    expect(plain).not.toHaveBeenCalled()
  })
})

describe("r2.4 stand-in P1: Construct's session composer (the 8th composer) ignores an IME-confirming Enter", () => {
  async function session() {
    const { Session } = await import('../../experiences/construct/Panes')
    const agent = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_wren', name: 'Wren', kind: 'omega' as const, status: 'awake' as const }
    const sent: string[] = []
    useHive.setState({ agents: { ...useHive.getState().agents, [agent.id]: agent }, sendMessage: (async (_id: string, t: string) => void sent.push(t)) as never })
    const m = mount(() => Session({ agent, phone: false }))
    const input = () => find(m.tree, (e) => e.type === 'input' && typeof e.props.onKeyDown === 'function')[0]
    const typeIn = (t: string) => ((input().props.onChange as (e: unknown) => void)({ target: { value: t } }), m.settle())
    const pressIn = async (more: Record<string, unknown> = {}) => {
      const ev = key('Enter', more)
      const native = ev.nativeEvent as Record<string, unknown>
      native.key ??= 'Enter'
      native.keyCode ??= (ev as { keyCode: number }).keyCode
      noteKeyCapture(native)
      ;(input().props.onKeyDown as (e: unknown) => void)(ev)
      await flush(); m.settle()
    }
    return { m, sent, input, typeIn, pressIn }
  }
  it("Safari's confirming 229 neither sends nor clears the draft; an ordinary Enter afterwards sends it", async () => {
    const s = await session()
    s.typeIn('hello ケ')
    noteComposition('start')
    await s.pressIn({ nativeEvent: { isComposing: true } })
    noteComposition('end')
    const prevented = vi.fn()
    await s.pressIn({ keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 }, preventDefault: prevented })
    expect(s.sent).toEqual([])
    expect(s.input().props.value).toBe('hello ケ')
    expect(prevented).toHaveBeenCalled()
    await s.pressIn()
    expect(s.sent).toEqual(['hello ケ'])
    expect(s.input().props.value).toBe('')
  })
})

describe('ask-send-r1 (live eb006a94): the Ask button acts on exactly the row the person sees, in every skin with one', () => {
  // the skins that draw an Ask (send) button: FloatingAsk in each look (Classic/OmegaTown capsule, Cosmos transmission,
  // Flux liquid, Construct's floating terminal line, Canvas note; phone and landscape are the same component), and
  // Professional. Still's field, Still's floating line and Construct's prompt have no send button (Enter only).
  const floatingSkin = (experience: string, look: 'capsule' | 'transmission' | 'liquid' | 'terminal' | 'note') => () => FloatingAsk({ place, experience, inputRef, look })
  const SEND = {
    capsule: floatingSkin('classic', 'capsule'),
    transmission: floatingSkin('cosmos', 'transmission'),
    liquid: floatingSkin('flux', 'liquid'),
    terminal: floatingSkin('construct', 'terminal'),
    note: floatingSkin('canvas', 'note'),
    phoneCapsule: () => FloatingAsk({ place: { mode: 'phone' as const, bottom: 12, left: 16, width: 358 }, experience: 'classic', inputRef, look: 'capsule' }),
    professional: SKINS.professional,
  } as const
  type SendSkin = keyof typeof SEND
  const SENDERS = Object.keys(SEND) as SendSkin[]
  /** the floating looks: rows drawn only while the Ask is in use (Professional draws its rows whether or not it is) */
  const FOCUS_GATED = SENDERS.filter((s) => s !== 'professional')
  // stand-in DOM nodes: the capsule contains its own controls, never the page's
  const ASK_BUTTON = { node: 'the Ask button' }
  const PAGE = { node: 'elsewhere on the page' }
  const sendOf = (m: Mounted) => find(m.tree, (e) => e.type === 'button' && (e.props['aria-label'] === 'Ask' || text(e) === 'Ask'))[0]
  const paidRow = (m: Mounted) => find(m.tree, (e) => e.props.role === 'option' && e.props['aria-selected'] === true && /Paid by you/.test(String(e.props['aria-label'] ?? '')))
  const blurTo = (m: Mounted, to: unknown) => {
    const cap = capsuleOf(m)
    ;((cap ?? inputOf(m)).props.onBlur as ((e: unknown) => void) | undefined)?.({ currentTarget: { contains: (n: unknown) => n === ASK_BUTTON }, relatedTarget: to })
    m.settle()
  }
  const focusIn = (m: Mounted) => {
    ;((capsuleOf(m) ?? inputOf(m)).props.onFocus as (() => void) | undefined)?.()
    m.settle()
  }
  const click = async (m: Mounted) => {
    ;(sendOf(m).props.onClick as (e: unknown) => void)({})
    await flush(); m.settle(); await flush(); m.settle()
  }
  /**
   * A pointer press on the Ask button, as a browser runs it: mousedown (a touch tap's compatibility mousedown too),
   * then, unless that was prevented, the focus move: WebKit and touch never focus a pressed button (the field just
   * blurs, relatedTarget null); Blink focuses the button (focusout to it, then focusin). Then the click.
   */
  async function pointerPress(m: Mounted, engine: 'webkit' | 'blink' | 'touch') {
    const ev = { defaultPrevented: false, pointerType: engine === 'touch' ? 'touch' : 'mouse', preventDefault() { this.defaultPrevented = true } }
    ;(sendOf(m).props.onMouseDown as ((e: unknown) => void) | undefined)?.(ev)
    if (!ev.defaultPrevented) {
      if (engine === 'blink') { blurTo(m, ASK_BUTTON); focusIn(m) } else blurTo(m, null)
    }
    m.settle()
    // the row the person is looking at, payer line and all, is still drawn under the press
    expect(paidRow(m).length, `${engine}: paid row drawn under the press`).toBe(1)
    await click(m)
    return ev
  }

  it.each(SENDERS)('%s: the Ask button keeps the caret in the field (its mousedown is prevented, as the rows\' is)', async (skin) => {
    const m = mount(SEND[skin])
    await type(m, 'kelp')
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    ;(sendOf(m).props.onMouseDown as ((e: unknown) => void) | undefined)?.(ev)
    expect(ev.defaultPrevented, skin).toBe(true)
  })
  for (const engine of ['webkit', 'blink', 'touch'] as const) {
    it.each(SENDERS)(`%s: ${engine} pointer down → (blur) → click on Ask sends the visible paid row exactly once`, async (skin) => {
      const m = mount(SEND[skin])
      await type(m, 'kelp')
      expect(paidRow(m).length, skin).toBe(1)
      await pointerPress(m, engine)
      expect(M.asks, skin).toEqual(['kelp'])
      expect(useHive.getState().toasts.filter((t) => t.title === 'Nothing was sent'), skin).toEqual([])
    })
  }
  it.each(SENDERS)('%s: keyboard Tab to Ask, then Enter or Space (the button\'s click) sends the visible row', async (skin) => {
    for (const k of ['Enter', 'Space']) {
      M.asks.length = 0
      const m = mount(SEND[skin])
      await type(m, 'kelp')
      // Tab: focus moves from the field to the Ask button, inside the capsule: the rows stay drawn throughout
      blurTo(m, ASK_BUTTON)
      expect(paidRow(m).length, `${skin} ${k}: rows drawn between focusout and focusin`).toBe(1)
      focusIn(m)
      await click(m)
      expect(M.asks, `${skin} ${k}`).toEqual(['kelp'])
      expect(refusedWith(REFUSED.hidden), `${skin} ${k}`).toBe(false)
      m.unmount()
    }
  })
  it.each(FOCUS_GATED)('%s: focus truly leaving the capsule hides the rows; then Enter, or a click on Ask, refuses (hidden)', async (skin) => {
    const m = mount(SEND[skin])
    await type(m, 'kelp')
    blurTo(m, PAGE)
    expect(paidRow(m), skin).toEqual([])
    await press(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.hidden), skin).toBe(true)
    useHive.setState({ toasts: [] })
    // a press on Ask from outside never brings the row in under that same press: it keeps the caret where it was
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    ;(sendOf(m).props.onMouseDown as (e: unknown) => void)(ev); m.settle()
    await click(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.hidden), skin).toBe(true)
    // Esc's blur (relatedTarget null) leaves too
    focusIn(m)
    blurTo(m, null)
    useHive.setState({ toasts: [] })
    await press(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.hidden), skin).toBe(true)
  })
  it.each(SENDERS)('%s: a row that changed under the press (a refresh made the paid row the Ask row) refuses (changed); after the arming window it acts', async (skin) => {
    const agent = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_wren', name: 'Wren', kind: 'omega' as const, status: 'awake' as const }
    useHive.setState({ agents: { ...useHive.getState().agents, [agent.id]: agent } })
    const m = mount(SEND[skin])
    await type(m, 'Wren') // row 0: open Wren (a view, not paid)
    expect(paidRow(m), skin).toEqual([])
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    ;(sendOf(m).props.onMouseDown as (e: unknown) => void)(ev); m.settle()
    // under the press the named mind leaves: the paid row replaces the view row while the words stood still
    const { [agent.id]: _gone, ...rest } = useHive.getState().agents
    void _gone
    useHive.setState({ agents: rest }); m.settle()
    expect(paidRow(m).length, skin).toBe(1)
    await click(m)
    expect(M.asks, skin).toEqual([])
    expect(refusedWith(REFUSED.changed), skin).toBe(true)
    clock += ARM_MS + 10
    await click(m)
    expect(M.asks, skin).toEqual(['Wren'])
  })
})

describe('ask-send-r1 item 2 (pin): the thread money is the host thread view\'s own spend over its cap, never a mind\'s figures', () => {
  it.each(['capsule', 'floating'] as const)('%s: a mind with prior spend and a fresh thread shows $0.00 / $0.25, never the mind\'s total', async (skin) => {
    const prior = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_maker', name: 'Maker', kind: 'omega' as const, status: 'awake' as const, spent_usd: 0.1695, budget_usd: 10 }
    useHive.setState({ agents: { ...useHive.getState().agents, [prior.id]: prior } })
    useAskStore.setState({ thread: { id: 'ses_invented_fresh', mind: { id: prior.id, name: prior.name }, budget_usd: 0.25, spent_usd: 0 } })
    const m = mount(SKINS[skin])
    const all = text(m.tree)
    expect(all, skin).toContain('$0.00 / $0.25')
    expect(all, skin).not.toContain('$0.17')
  })
})


describe('retained floating field: page context is part of the paid reading interval', () => {
  const skins = [
    ['flux', () => FloatingAsk({ place, experience: 'flux', inputRef, look: 'liquid' })],
    ['canvas', () => FloatingAsk({ place, experience: 'canvas', inputRef, look: 'note' })],
    ['released Classic', () => {
      // The stand-in renders hook leaves directly; follow ClassicAsk's real one-level wrapper as React would.
      const child = ClassicAsk({ place, experience: 'classic', inputRef })
      expect(child.type).toBe(FloatingAsk)
      return FloatingAsk(child.props as Parameters<typeof FloatingAsk>[0])
    }],
    ['released Cosmos', SKINS.floating],
    ['released Professional', SKINS.professional],
  ] as const
  it.each(skins)('%s: unchanged paid row and held words wait again on page out and return', async (_skin, component) => {
    const m = mount(component)
    const words = 'Invented question without a local action'
    await type(m, words)
    const selected = () => find(m.tree, e => e.props.role === 'option' && e.props['aria-selected'] === true).map(text).join(' ')
    const originalRow = selected()
    expect(originalRow).toMatch(/Ask/)
    for (const hash of ['#/programs', '#/', '#/first-light?beat=one', '#/first-light?beat=two']) {
      clock += ARM_MS + 10 // the old context's line has already been read
      useHive.setState({ toasts: [] }); m.settle()
      win.location.hash = hash
      win.dispatchEvent({ type: 'hashchange' }); m.settle()
      expect(selected()).toBe(originalRow) // same recipient and row; only the page context changed
      await press(m)
      expect(M.asks).toEqual([])
      expect(refusedWith(REFUSED.changed)).toBe(true)
      expect(valueOf(m)).toBe(words)
    }
    clock += ARM_MS + 10
    // A genuine subscribed ambient update renders a fresh parsed route object with the SAME identity.
    const extra = { ...Object.values(useHive.getState().agents)[0], id: 'a_invented_quill', name: 'Quill' }
    useHive.setState({ agents: { ...useHive.getState().agents, [extra.id]: extra }, toasts: [] }); m.settle()
    expect(selected()).toBe(originalRow)
    await press(m) // no new reading interval for that unrelated render
    expect(M.asks).toEqual([words])
    expect(refusedWith(REFUSED.changed)).toBe(false)
  })
})


describe('released Ask: a retained paid-row callback belongs to its presentation and identity', () => {
  const skins = [
    ['Classic', () => { const child = ClassicAsk({ place, experience: 'classic', inputRef }); return FloatingAsk(child.props as Parameters<typeof FloatingAsk>[0]) }],
    ['Cosmos', SKINS.floating],
    ['Professional', SKINS.professional],
  ] as const
  const capturePaidClick = (m: Mounted) => {
    const row = find(m.tree, e => e.props.role === 'option' && e.props['aria-selected'] === true).find(e => /Paid by you/.test(text(e)))
    expect(row, 'actual selected paid row').toBeDefined()
    const target = find(row, e => typeof e.props.onClick === 'function')[0]
    expect(target, 'actual paid-row click handler').toBeDefined()
    const click = target.props.onClick as () => unknown
    return async () => { await click(); await flush() }
  }
  it.each(skins)('%s: retained paid-row callback cannot act after a same-person remount', async (_skin, component) => {
    const old = mount(component)
    await type(old, 'Explain this invented onboarding message'); clock += ARM_MS + 10
    const click = capturePaidClick(old)
    old.unmount()
    const fresh = mount(component)
    const words = 'Explain a different invented onboarding message'
    await type(fresh, words); clock += ARM_MS + 10
    await click()
    expect(M.asks, 'disposed presentation cannot reach the money seam').toEqual([])
    expect(valueOf(fresh)).toBe(words)
    await press(fresh)
    expect(M.asks, 'current presentation still works once').toEqual([words])
  })
  it.each(skins)('%s: retained paid-row callback cannot act after a covered-page context commit', async (_skin, component) => {
    const m = mount(component)
    const words = 'Explain this invented onboarding message'
    await type(m, words); clock += ARM_MS + 10
    const click = capturePaidClick(m)
    win.location.hash = '#/programs'; win.dispatchEvent({ type: 'hashchange' }); m.settle()
    clock += ARM_MS + 10 // a stale callback must not revive when the new context's reading interval ends
    await click()
    expect(M.asks, 'earlier page presentation cannot reach the money seam').toEqual([])
    expect(valueOf(m)).toBe(words)
    await press(m)
    expect(M.asks, 'current page still has one working field').toEqual([words])
  })
  it.each(skins)('%s: retained paid-row callback cannot cross identity before the next field commit', async (_skin, component) => {
    const m = mount(component)
    await type(m, 'Explain this invented onboarding message'); clock += ARM_MS + 10
    const click = capturePaidClick(m)
    await signInAs(testPerson(`after${++clock}`))
    useAskStore.getState().bind(useHive.getState().session, 'user:p_invented_after')
    await click() // no m.settle(): the old callback must be dead before a new field commit
    expect(M.asks, 'earlier identity cannot reach the money seam').toEqual([])
    m.settle()
    expect(valueOf(m)).toBe('')
    const words = 'Explain a different invented onboarding message'
    await type(m, words); clock += ARM_MS + 10
    await press(m)
    expect(M.asks, 'new identity still has one working field').toEqual([words])
  })
})


describe('retained Ask again: the rendered request, presentation and identity own Retry', () => {
  beforeEach(async () => {
    const person = testPerson(`retry_before${++clock}`)
    reportTestPrincipal(person)
    await signInAs(person)
    useAskStore.getState().bind(useHive.getState().session, `user:${person.name}`)
  })
  async function settled(words: string) {
    const client = useHive.getState().client
    if (!client) throw new Error('synthetic signed-in client required')
    const posts = vi.fn(async (body: { operation_id: string }) => ({ operation_id: body.operation_id, turn_id: `t_${body.operation_id}`, thread: { id: 'ses_invented', mind: { id: 'a_invented', name: 'Invented' }, budget_usd: 1, spent_usd: 0 } }))
    client.ask = posts as never
    await useAskStore.getState().send(words, { route: 'hive', experience: 'classic' })
    expect(posts).toHaveBeenCalledTimes(1)
    const op = posts.mock.calls[0][0].operation_id
    useAskStore.setState(s => ({ open: null, turns: { ...s.turns, [op]: { ...s.turns[op], state: 'done' } } }))
    return { op, posts }
  }
  const offer = (op: string, words: string) => () => {
    const row = NoteRow({ r: { id: 'retry_invented', kind: 'note', text: 'Invented stopped request', op, offer: [{ kind: 'retry', label: 'Ask again' }] }, lastYou: words })
    const leaf = find(row, e => typeof e.type === 'function' && 'offers' in e.props)[0]
    expect(leaf, 'actual NoteRow offer leaf').toBeDefined()
    return (leaf.type as (props: unknown) => unknown)(leaf.props)
  }
  const click = (m: Mounted) => {
    const button = find(m.tree, e => typeof e.props.onClick === 'function' && text(e) === 'Ask again')[0]
    expect(button, 'actual rendered Ask again handler').toBeDefined()
    return button.props.onClick as () => unknown
  }
  it('a retained handler stays revoked after same-person remount; the new button works once', async () => {
    const f = await settled('Invented first request')
    const old = mount(offer(f.op, 'Invented first request')), retry = click(old)
    old.unmount()
    const fresh = mount(offer(f.op, 'Invented first request'))
    retry(); await flush()
    expect(useAskStore.getState().open, 'stale retry cannot open a sending operation').toBeNull()
    expect(f.posts).toHaveBeenCalledTimes(1)
    click(fresh)(); await flush()
    await vi.waitFor(() => expect(f.posts).toHaveBeenCalledTimes(2))
  })
  it('a retained handler stays revoked after a page commit and return; the current button works once', async () => {
    const f = await settled('Invented page request')
    const m = mount(offer(f.op, 'Invented page request')), retry = click(m)
    win.location.hash = '#/programs'; win.dispatchEvent({ type: 'hashchange' }); m.settle()
    win.location.hash = '#/'; win.dispatchEvent({ type: 'hashchange' }); m.settle()
    retry(); await flush()
    expect(useAskStore.getState().open, 'stale retry cannot open a sending operation').toBeNull()
    expect(f.posts).toHaveBeenCalledTimes(1)
    click(m)(); await flush()
    await vi.waitFor(() => expect(f.posts).toHaveBeenCalledTimes(2))
  })
  it('an old identity cannot retry the new person’s settled request, even before the next presentation commit', async () => {
    const a = await settled('Invented A request')
    const m = mount(offer(a.op, 'Invented A request')), retry = click(m)
    const person = testPerson(`retry_after${++clock}`)
    reportTestPrincipal(person)
    await signInAs(person)
    useAskStore.getState().bind(useHive.getState().session, `user:${person.name}`)
    const b = await settled('Invented B request')
    retry(); await flush()
    expect(useAskStore.getState().open, 'stale retry cannot open a sending operation').toBeNull()
    expect(a.posts).toHaveBeenCalledTimes(1)
    expect(b.posts).toHaveBeenCalledTimes(1)
    const fresh = mount(offer(b.op, 'Invented B request'))
    click(fresh)(); await flush()
    await vi.waitFor(() => expect(b.posts).toHaveBeenCalledTimes(2))
    expect((b.posts.mock.calls[1][0] as { text?: string }).text).toBe('Invented B request')
  })
  it('a mid-flight reroute revokes the old Retry context; a freshly rendered retry sends the exact first posted context', async () => {
    let m!: Mounted, earlier!: () => unknown
    const words = 'Invented rerouted page request'
    vi.spyOn(askAutoWake, 'deliver').mockImplementationOnce(async (op, ports) => {
      m = mount(offer(op, words))
      earlier = click(m)
      // Exercise the real store routeOwn callback used by the explicit own-mind alternate before dispatch.
      if ('private' in ports.context) throw new Error('this invented page request is non-private')
      ports.routeOwn({ ...ports.context, route: 'programs' })
      return ports.send()
    })
    const f = await settled(words)
    earlier(); await flush() // no new presentation commit yet: the store must enforce the captured context too
    expect(useAskStore.getState().open).toBeNull()
    expect(f.posts).toHaveBeenCalledTimes(1)
    m.settle()
    click(m)(); await flush()
    await vi.waitFor(() => expect(f.posts).toHaveBeenCalledTimes(2))
    const posts = f.posts.mock.calls.map(([body]) => body as { context?: unknown })
    expect(posts[1].context).toEqual(posts[0].context)
    expect(posts[0].context).toMatchObject({ route: 'programs' })
  })
  it('the store refuses an earlier identity epoch even when given the new person’s current request id', async () => {
    await settled('Invented old identity request')
    const epoch = currentEpoch()
    const person = testPerson(`retry_epoch${++clock}`)
    reportTestPrincipal(person)
    await signInAs(person)
    useAskStore.getState().bind(useHive.getState().session, `user:${person.name}`)
    const b = await settled('Invented new identity request')
    await useAskStore.getState().retryLast(b.op, epoch, askRetryContext(b.op, currentEpoch()))
    expect(useAskStore.getState().open).toBeNull()
    expect(b.posts).toHaveBeenCalledTimes(1)
    await useAskStore.getState().retryLast(b.op, currentEpoch(), askRetryContext(b.op, currentEpoch()))
    expect(b.posts).toHaveBeenCalledTimes(2)
  })
  it('the store refuses an earlier request id under the same current epoch', async () => {
    const a = await settled('Invented superseded request'), epoch = currentEpoch()
    const b = await settled('Invented current request')
    await useAskStore.getState().retryLast(a.op, epoch, askRetryContext(b.op, currentEpoch()))
    expect(b.posts).toHaveBeenCalledTimes(1)
    await useAskStore.getState().retryLast(b.op, epoch, askRetryContext(b.op, currentEpoch()))
    await vi.waitFor(() => expect(b.posts).toHaveBeenCalledTimes(2))
  })
})
