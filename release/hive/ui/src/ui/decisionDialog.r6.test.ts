import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'

/**
 * Missing-UI batch 1 r6 (stand-in r5 P1, STANDIN_MISSING_UI_B1_R5_VERDICT_20261007): the decision dialog writes only
 * under the identity it was acted in. An identity change (a credential replaced on the SAME client, testkit
 * switchPerson sameTab) that lands between an action's answer and the dialog's continuation, or during a recheck,
 * shows nothing of the earlier person's outcome, and the dialog closes on the change itself.
 *
 * This repo's tests run in node with no DOM library, so the REAL ui/DecisionDialog function is mounted on a minimal
 * hook runtime (state, refs, effects with deps and cleanups; createPortal returns its children) and driven through
 * the elements it renders: the action button's onClick and the "Check again" button, then re-rendered to read the
 * status line. INVENTED DATA only.
 */

// ---- a minimal hook runtime for one mounted component ----
const escape = vi.hoisted(() => ({ run: null as null | (() => void) }))
const rt = {
  slots: [] as unknown[],
  i: 0,
  pending: [] as { slot: number; run: () => void | (() => void) }[],
  cleanups: new Map<number, () => void>(),
}
function reset() {
  for (const c of rt.cleanups.values()) c()
  rt.slots = []
  rt.i = 0
  rt.pending = []
  rt.cleanups.clear()
}
function effect(run: () => void | (() => void), deps?: unknown[]) {
  const slot = rt.i++
  const prev = rt.slots[slot] as unknown[] | undefined
  const changed = !deps || !prev || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]))
  rt.slots[slot] = deps
  if (changed) rt.pending.push({ slot, run })
}
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  return {
    ...real,
    useState: <T,>(init: T | (() => T)) => {
      const slot = rt.i++
      if (!(slot in rt.slots)) rt.slots[slot] = typeof init === 'function' ? (init as () => T)() : init
      return [rt.slots[slot] as T, (v: T | ((p: T) => T)) => (rt.slots[slot] = typeof v === 'function' ? (v as (p: T) => T)(rt.slots[slot] as T) : v)]
    },
    useRef: <T,>(init: T) => {
      const slot = rt.i++
      if (!(slot in rt.slots)) rt.slots[slot] = { current: init }
      return rt.slots[slot]
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useId: () => 'dd',
  }
})
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (children: ReactNode) => children }))
vi.mock('../lib/hooks', async (orig) => ({ ...(await orig<typeof import('../lib/hooks')>()), useEscape: (run: () => void) => { escape.run = run }, useIsDesktop: () => true, useReducedMotion: () => true }))
vi.mock('./useModalContainment', () => ({ useModalContainment: () => undefined }))

const { DecisionDialog } = await import('./DecisionDialog')
const { boundRun } = await import('../lib/epochBound')
const STALE: import('../lib/identityEpoch').Stale = (await import('../lib/identityEpoch')).STALE
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')

type Props = Parameters<typeof DecisionDialog>[0]
function render(props: Props): ReactElement {
  rt.i = 0
  const el = DecisionDialog(props) as unknown as ReactElement
  const run = rt.pending.splice(0)
  for (const p of run) {
    rt.cleanups.get(p.slot)?.()
    const c = p.run()
    if (typeof c === 'function') rt.cleanups.set(p.slot, c)
  }
  return el
}
type El = { type?: unknown; props?: Record<string, unknown> }
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out))
  else if (node && typeof node === 'object' && 'props' in node) {
    const e = node as El
    out.push(e)
    all(e.props?.children, out)
  }
  return out
}
const text = (node: unknown): string =>
  Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' && 'props' in node ? text((node as El).props?.children) : ''
const statusOf = (el: ReactElement) => text(all(el).find((e) => e.props?.role === 'status')?.props?.children)
const clickOn = async (el: ReactElement, pick: (e: El) => boolean) => {
  const b = all(el).find(pick)
  if (!b) throw new Error('no such button')
  await (b.props!.onClick as (e: unknown) => unknown)({ stopPropagation: () => undefined })
}
const isAction = (label: string) => (e: El) => e.type === 'button' && 'aria-describedby' in (e.props ?? {}) && text(e.props?.children) === label

function defer<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

let clock = 1000
const a = () => persons.a
const persons = {} as { a: ReturnType<typeof testPerson>; b: ReturnType<typeof testPerson> }
beforeEach(async () => {
  vi.stubGlobal('window', { location: { search: '' } })
  vi.stubGlobal('document', { body: {} })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  reset()
  persons.a = testPerson('a')
  persons.b = testPerson('b', { sameTab: persons.a })
  await signInAs(persons.a)
})
afterEach(() => {
  reset()
  releasePersons()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const base = (run: Props['actions'][number]['run'], onClose: () => void): Props => ({ eyebrow: 'Test', title: 'A decision', facts: [], bound: { kind: 'ready' }, thing: 'This', onClose, actions: [{ label: 'Do it', tone: 'primary', run }] })

describe('a decision dialog keeps its opening visible authority', () => {
  it('waits for the first grant, then closes once when that grant is revoked', () => {
    let allowed = false
    const close = vi.fn(), props = { ...base(vi.fn(async () => true as const), close), canAct: () => allowed }
    let el = render(props)
    expect(all(el).find(isAction('Do it'))!.props!['aria-disabled']).toBe(true)
    expect(close).not.toHaveBeenCalled()
    allowed = true; el = render(props)
    expect(all(el).find(isAction('Do it'))!.props!['aria-disabled']).toBe(false)
    expect(close).not.toHaveBeenCalled()
    allowed = false; render(props); render(props)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('a replacement grant cannot renew an already opened dialog', async () => {
    let original = true
    const close = vi.fn(), run = vi.fn(async () => true as const)
    const props = { ...base(run, close), canAct: () => original }
    render(props); clock += 1000
    original = false
    const el = render({ ...props, canAct: () => true })
    expect(close).toHaveBeenCalledTimes(1)
    await clickOn(el, isAction('Do it'))
    expect(run).not.toHaveBeenCalled()
  })
  it('a saved action callback refuses revocation before React commits', async () => {
    let allowed = true
    const run = vi.fn(async () => true as const), props = { ...base(run, vi.fn()), canAct: () => allowed }
    const el = render(props); clock += 1000
    allowed = false
    await clickOn(el, isAction('Do it'))
    expect(run).not.toHaveBeenCalled()
  })
  it('an answer arriving after revocation publishes no outcome, before the close render', async () => {
    let allowed = true
    const d = defer<string>(), close = vi.fn(), props = { ...base(() => d.promise, close), canAct: () => allowed }
    const el = render(props); clock += 1000
    const pending = clickOn(el, isAction('Do it'))
    allowed = false; d.resolve('Outcome of a revoked attachment.'); await pending
    expect(close).not.toHaveBeenCalled()
    expect(statusOf(render(props))).not.toContain('revoked attachment')
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('a recheck answer after revocation also publishes no outcome', async () => {
    let allowed = true
    const again = defer<{ unsettled: string }>(), close = vi.fn()
    const props = { ...base(async () => ({ unsettled: 'Not known yet.', recheck: () => again.promise }), close), canAct: () => allowed }
    let el = render(props); clock += 1000
    await clickOn(el, isAction('Do it')); el = render(props)
    const pending = clickOn(el, e => e.type === 'button' && text(e.props?.children) === 'Check again')
    allowed = false; again.resolve({ unsettled: 'Recheck of a revoked attachment.' }); await pending
    expect(statusOf(render(props))).not.toContain('revoked attachment')
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('Escape stays available while its initial grant is pending', () => {
    const close = vi.fn(), props = { ...base(vi.fn(async () => true as const), close), canAct: () => false }
    render(props); escape.run!()
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('dismissing first does not notify twice when authority is revoked during the retained exit', () => {
    let allowed = true
    const close = vi.fn(), props = { ...base(vi.fn(async () => true as const), close), canAct: () => allowed }
    render(props); escape.run!()
    allowed = false; render(props)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('does not release busy after a revocation close when the pending action answers STALE', async () => {
    let allowed = true
    const d = defer<typeof STALE>(), close = vi.fn(), props = { ...base(() => d.promise, close), canAct: () => allowed }
    const el = render(props); clock += 1000
    const pending = clickOn(el, isAction('Do it'))
    allowed = false
    expect(statusOf(render(props))).toBe('Do it…')
    expect(close).toHaveBeenCalledTimes(1)
    d.resolve(STALE); await pending
    expect(statusOf(render(props))).toBe('Do it…')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('r6: the decision dialog settles only under the identity it was acted in', () => {
  it.each(['Escape', 'backdrop'])('%s dismisses a busy dialog locally before its answer arrives', async (how) => {
    const d = defer<string>(), onClose = vi.fn(), run = vi.fn(() => d.promise), props = base(run, onClose)
    let el = render(props); clock += 1000
    const pending = clickOn(el, isAction('Do it')); el = render(props)
    expect(run).toHaveBeenCalledTimes(1)
    if (how === 'Escape') escape.run!()
    else (el.props as { onClick: () => void }).onClick()
    expect(onClose).toHaveBeenCalledTimes(1)
    reset() // the real caller unmounts on dismissal: the late outcome has no dialog to publish into
    d.resolve('Late outcome'); await pending
    expect(onClose).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1)
  })
  it('control: with no identity change the refusal is shown', async () => {
    const d = defer<string>()
    const onClose = vi.fn()
    const props = base(() => d.promise, onClose)
    let el = render(props)
    clock += 1000
    const done = clickOn(el, isAction('Do it'))
    d.resolve('Words only the first person may read.')
    await done
    el = render(props)
    expect(statusOf(el)).toContain('Words only the first person may read.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an answer resolved just before a same-client credential replacement: nothing of it is shown; the change closes the dialog', async () => {
    const d = defer<string>()
    const onClose = vi.fn()
    const props = base(() => d.promise, onClose)
    let el = render(props)
    clock += 1000
    const done = clickOn(el, isAction('Do it'))
    d.resolve('Words only the first person may read.')
    void switchPerson(a(), persons.b) // synchronous identity change, before the dialog's continuation runs
    await done
    await flush()
    el = render(props)
    expect(statusOf(el)).not.toContain('first person')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the exact gap: boundRun checked its identity and resolved, then the identity changed before the dialog continued', async () => {
    const d = defer<string>()
    const onClose = vi.fn()
    const run = boundRun(async () => d.promise)
    const props = base(() => run().then((r) => (void switchPerson(a(), persons.b), r)), onClose)
    let el = render(props)
    clock += 1000
    const done = clickOn(el, isAction('Do it'))
    d.resolve('Words only the first person may read.')
    await done
    await flush()
    el = render(props)
    expect(statusOf(el)).not.toContain('first person')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a recheck whose answer lands with an identity change: its outcome is not shown', async () => {
    const first = defer<{ unsettled: string; recheck: () => Promise<{ unsettled: string }> }>()
    const again = defer<{ unsettled: string }>()
    const onClose = vi.fn()
    const props = base(() => first.promise, onClose)
    let el = render(props)
    clock += 1000
    const done = clickOn(el, isAction('Do it'))
    first.resolve({ unsettled: 'Not known yet.', recheck: () => again.promise })
    await done
    el = render(props)
    expect(statusOf(el)).toBe('Not known yet.')
    const checking = clickOn(el, (e) => e.type === 'button' && text(e.props?.children) === 'Check again')
    again.resolve({ unsettled: 'The first person’s recheck outcome.' })
    void switchPerson(a(), persons.b)
    await checking
    await flush()
    el = render(props)
    expect(statusOf(el)).not.toContain('first person')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
