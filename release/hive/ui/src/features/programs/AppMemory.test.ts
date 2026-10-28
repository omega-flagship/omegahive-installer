import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The repository's tests run in Node. As in HostConfirm.test.ts, this React hook double
// retains real hook state/effect cleanup while running the actual component and
// its event handlers. Browser focus, pixels and native download delivery remain
// separate browser checks; these tests do not claim them.
const H = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, ei: 0,
  effects: [] as ({ deps?: unknown[]; cleanup?: unknown } | undefined)[], pending: [] as (() => void)[],
  portalTarget: null as unknown, api: { openReview: vi.fn(), fixReview: vi.fn(), forgetReview: vi.fn(), exportReview: vi.fn() } }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  const slot = (init: () => unknown) => { const n = H.i++; if (!(n in H.slots)) H.slots[n] = init(); return n }
  const hooks = { ...actual, useId: () => 'p8-host-test',
    useState: (init: unknown) => { const n = slot(() => typeof init === 'function' ? (init as () => unknown)() : init)
      return [H.slots[n], (value: unknown) => { H.slots[n] = typeof value === 'function' ? (value as (old: unknown) => unknown)(H.slots[n]) : value }] },
    useRef: (value: unknown) => H.slots[slot(() => ({ current: value }))], useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => unknown, deps?: unknown[]) => { const n = H.ei++, old = H.effects[n]
      if (!old || !deps || !old.deps || deps.some((d, k) => !Object.is(d, old.deps![k]))) H.pending.push(() => {
        if (typeof old?.cleanup === 'function') old.cleanup()
        H.effects[n] = { deps, cleanup: fn() }
      }) },
  }
  return { ...hooks, default: hooks }
})
vi.mock('react-dom', () => ({ createPortal: (node: unknown, target: unknown) => { H.portalTarget = target; return node } }))
vi.mock('../../lib/askMemory/store', () => ({ askMemory: H.api,
  KIND_TITLES: { preference: 'Preferences', name: 'Names', place: 'Places', person: 'People', project: 'Projects', correction: 'Corrections' } }))
vi.mock('../../lib/hooks', () => ({ useReducedMotion: () => false, useEscape: () => undefined }))
vi.mock('../../ui/useModalContainment', () => ({ useModalContainment: () => undefined }))

import type { Belief } from '../../lib/askMemory/types'
import type { MemoryReviewSnapshot } from '../../lib/askMemory/store'
import { AppMemory, type AppMemoryOpening } from './AppMemory'

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const element = (node: unknown): node is Element => !!node && typeof node === 'object' && 'props' in node && 'type' in node
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return element(tree) ? [tree, ...nodes(tree.props.children)] : []
}
function text(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return element(tree) ? text(tree.props.children) : ''
}
const tagged = (tree: unknown, key: string) => nodes(tree).find((node) => Object.prototype.hasOwnProperty.call(node.props, key))!
function button(tree: unknown, label: string): Element {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node) === label)
  if (!found) throw new Error(`button missing: ${label}`)
  return found
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const B: Belief = { id: 'p8_note', kind: 'preference', statement: 'Invented private note.', truth: { frequency: .6, confidence: .7 },
  uses: 0, last_used_at: null, created_at: 10, updated_at: 10, source_turn: null }
const snapshot = (statement = B.statement, version = 10): MemoryReviewSnapshot => ({
  beliefs: [{ ...B, statement, updated_at: version }], token: { owner: 1, backend: {} as never, gen: 0, base: (id) => id === B.id ? version : undefined },
})
const active: { unmount: () => void }[] = []
const links: { href: string; download: string; click: ReturnType<typeof vi.fn> }[] = []
let hostBody: object, post: ReturnType<typeof vi.fn>
function render(opening: AppMemoryOpening) {
  H.slots = []; H.effects = []
  const onClose = vi.fn()
  let currentClose: () => void = onClose, mode: 'light' | 'dark' = 'dark'
  let tree: unknown
  const rerender = () => {
    H.i = 0; H.ei = 0; H.pending = []; tree = AppMemory({ opening, mode, onClose: currentClose })
    // Attach minimal host refs before effects, as a mounted React tree does.
    for (const node of nodes(tree)) {
      const ref = node.props.ref as { current: unknown } | undefined
      if (ref && typeof ref === 'object' && !ref.current) ref.current = { hidden: false, style: { display: '' }, focus: vi.fn() }
    }
    H.pending.forEach((effect) => effect())
  }
  rerender()
  const mounted = { get tree() { return tree }, onClose, rerender,
    replaceCloseAndMode: (nextClose: () => void, nextMode: 'light' | 'dark') => { currentClose = nextClose; mode = nextMode; rerender() },
    unmount: () => H.effects.forEach((effect) => typeof effect?.cleanup === 'function' && effect.cleanup()) }
  active.push(mounted)
  return mounted
}
function opening() {
  const controller = new AbortController()
  const value: AppMemoryOpening = { id: 'r1', appName: 'Invented app', topic: 'gardening', theme: 'calm',
    themes: { memory_theme: { calm: { accent: '#123456', dark: { surface: '#101010', panel: '#202020', text: '#ffffff' } } } },
    snapshot: snapshot(), guard: { signal: controller.signal, current: () => !controller.signal.aborted } }
  return { value, controller }
}
async function press(mounted: ReturnType<typeof render>, target: Element) {
  ;(target.props.onClick as () => unknown)()
  await flush(); mounted.rerender()
}
async function edit(mounted: ReturnType<typeof render>, words = 'Invented corrected note.') {
  await press(mounted, button(mounted.tree, 'Fix'))
  const input = nodes(mounted.tree).find((node) => node.type === 'textarea')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value: words } }); mounted.rerender()
  await press(mounted, button(mounted.tree, 'Review fix'))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  for (const fn of Object.values(H.api)) fn.mockReset()
  H.api.openReview.mockResolvedValue(snapshot())
  H.api.fixReview.mockResolvedValue({ kind: 'done' }); H.api.forgetReview.mockResolvedValue({ kind: 'done' })
  H.api.exportReview.mockResolvedValue({ text: '{"invented":"private host-only note"}', file: {} })
  hostBody = { host: true }; links.length = 0; post = vi.fn()
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, parent: { postMessage: post } })
  vi.stubGlobal('document', { body: hostBody, createElement: () => { const link = { href: '', download: '', click: vi.fn() }; links.push(link); return link } })
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:host-only'), revokeObjectURL: vi.fn() })
})
afterEach(() => { active.splice(0).forEach((mounted) => mounted.unmount()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('P8 actual host overlay under the Node hook harness', () => {
  it('renders through a host portal with identity and confirms outside the themed body', async () => {
    const mounted = render(opening().value)
    expect(H.portalTarget).toBe(hostBody)
    const themed = tagged(mounted.tree, 'data-memory-themed'), identity = tagged(mounted.tree, 'data-memory-host-identity')
    expect(text(identity)).toContain('Your memory · kept safe in your hive')
    expect(text(identity)).toContain('OmegaHive')
    expect(nodes(themed)).not.toContain(identity)
    expect(nodes(mounted.tree).some((node) => node.type === 'iframe')).toBe(false)
    await edit(mounted)
    const confirm = tagged(mounted.tree, 'data-memory-host-confirm')
    expect(nodes(tagged(mounted.tree, 'data-memory-themed'))).not.toContain(confirm)
    expect(confirm.props.style).toBeUndefined(); expect(identity.props.style).toBeUndefined()
    expect(text(confirm)).toContain('Invented app asked you to review gardening')
    expect(H.api.fixReview).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled()
  })

  it('requires the explicit host confirm before writing a correction', async () => {
    const op = opening(), mounted = render(op.value)
    await edit(mounted)
    expect(H.api.fixReview).not.toHaveBeenCalled()
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Save fix'))
    expect(H.api.fixReview).toHaveBeenCalledWith(expect.any(Object), B.id, 'Invented corrected note.', op.value.guard)
    expect(post).not.toHaveBeenCalled()
  })

  it('shows current words and the stale warning for a same-timestamp external edit', async () => {
    H.api.openReview.mockResolvedValue(snapshot('Invented changed elsewhere.', 10))
    const mounted = render(opening().value)
    await edit(mounted)
    const card = tagged(mounted.tree, 'data-memory-host-confirm')
    expect(text(card)).toContain('Invented changed elsewhere.')
    expect(text(card)).toContain('This changed since you opened it')
    expect(H.api.fixReview).not.toHaveBeenCalled()
  })

  it('does not silently retry a stale CAS; current text needs a second explicit confirmation', async () => {
    const newer = snapshot('Invented race winner.', 11)
    H.api.fixReview.mockResolvedValueOnce({ kind: 'stale', snapshot: newer }).mockResolvedValueOnce({ kind: 'done' })
    const mounted = render(opening().value)
    await edit(mounted)
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Save fix'))
    expect(H.api.fixReview).toHaveBeenCalledTimes(1)
    expect(text(tagged(mounted.tree, 'data-memory-host-confirm'))).toContain('Invented race winner.')
    expect(text(tagged(mounted.tree, 'data-memory-host-confirm'))).toContain('This changed since you opened it')
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Save fix'))
    expect(H.api.fixReview).toHaveBeenCalledTimes(2)
    expect(H.api.fixReview.mock.calls[1][0]).toBe(newer)
  })

  it('arms forgetting only after two seconds, including the handler-level guard', async () => {
    const mounted = render(opening().value)
    await press(mounted, button(mounted.tree, 'Forget'))
    const early = button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Wait a moment…')
    expect(early.props.disabled).toBe(true)
    await press(mounted, early) // a retained callback still cannot bypass the timer
    expect(H.api.forgetReview).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1999); mounted.rerender()
    expect(button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Wait a moment…').props.disabled).toBe(true)
    vi.advanceTimersByTime(1); mounted.rerender()
    const armed = button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Forget')
    expect(armed.props.disabled).toBe(false)
    await press(mounted, armed); expect(H.api.forgetReview).toHaveBeenCalledTimes(1)
  })

  it('downloads only after host confirmation and sends no text or URL to the frame', async () => {
    const mounted = render(opening().value)
    await press(mounted, button(mounted.tree, 'Export your memory'))
    expect(H.api.exportReview).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled()
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Export'))
    expect(H.api.exportReview).toHaveBeenCalledTimes(1)
    expect(links).toHaveLength(1); expect(links[0].download).toBe('Your-memory.json'); expect(links[0].click).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    mounted.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:host-only')
  })

  it('revokes a completed export on document abort and leaves none for unmount', async () => {
    const op = opening(), mounted = render(op.value)
    await press(mounted, button(mounted.tree, 'Export your memory'))
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Export'))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    op.controller.abort()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:host-only')
    expect(mounted.onClose).toHaveBeenCalledTimes(1)
    mounted.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps an export URL through same-opening callback/theme rerender until actual teardown', async () => {
    const op = opening(), mounted = render(op.value)
    await press(mounted, button(mounted.tree, 'Export your memory'))
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Export'))
    const latestClose = vi.fn()
    mounted.replaceCloseAndMode(latestClose, 'light')
    vi.advanceTimersByTime(1000)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(mounted.onClose).not.toHaveBeenCalled(); expect(latestClose).not.toHaveBeenCalled()
    op.controller.abort()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:host-only')
    expect(mounted.onClose).not.toHaveBeenCalled(); expect(latestClose).toHaveBeenCalledTimes(1)
    mounted.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
  })

  it('drops a late export after document teardown instead of creating a download', async () => {
    let finish!: (value: unknown) => void
    H.api.exportReview.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const op = opening(), mounted = render(op.value)
    await press(mounted, button(mounted.tree, 'Export your memory'))
    await press(mounted, button(tagged(mounted.tree, 'data-memory-host-confirm'), 'Export'))
    const box = (tagged(mounted.tree, 'data-app-memory-host').props.ref as { current: { hidden: boolean; style: { display: string } } }).current
    op.controller.abort()
    expect(box.hidden).toBe(true); expect(box.style.display).toBe('none')
    finish({ text: 'Invented late private words', file: {} }); await flush(); mounted.rerender()
    expect(mounted.tree).toBeNull(); expect(mounted.onClose).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(links).toHaveLength(0); expect(post).not.toHaveBeenCalled()
  })
})
