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
vi.mock('../lib/hooks', async (orig) => ({ ...(await orig<typeof import('../lib/hooks')>()), useEscape: () => undefined, useIsDesktop: () => true, useReducedMotion: () => true }))
vi.mock('./useModalContainment', () => ({ useModalContainment: () => undefined }))

const { DecisionDialog } = await import('./DecisionDialog')
const { boundRun } = await import('../lib/epochBound')
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

describe('r6: the decision dialog settles only under the identity it was acted in', () => {
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
