import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * A change of look cross-fades through the View Transitions API. A person who switches look twice quickly makes the
 * browser skip the first transition, whose promises reject with AbortError ("Transition was skipped"). That must never
 * be left as an unhandled rejection (MacBook capture, light-token R1.2), and the look that lands is the last one asked
 * for. The browser's behaviour is modelled here: starting a transition skips the one still running.
 */
const mem = new Map<string, string>()
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
const props = new Map<string, string>()
const root = { dataset: {} as Record<string, string>, style: { colorScheme: '', setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) } }
const skipped = () => Object.assign(new Error('Transition was skipped. New ViewTransition started.'), { name: 'AbortError' })
let running: { skip: () => void } | null = null
const startViewTransition = (cb: () => void) => {
  running?.skip()
  let reject!: (e: unknown) => void, resolve!: () => void
  const ready = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  const finished = ready.then(() => undefined)
  const t = { skip: () => reject(skipped()) }
  running = t
  cb()
  setTimeout(() => { if (running === t) { running = null; resolve() } }, 20)
  return { ready, finished, updateCallbackDone: Promise.resolve() }
}
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })
vi.stubGlobal('matchMedia', () => ({ matches: false }))
vi.stubGlobal('document', { documentElement: root, startViewTransition })

const unhandled: unknown[] = []
const onUnhandled = (e: unknown) => void unhandled.push(e)
// Node's process, typed locally: the app's tsconfig has no Node types
const proc = (globalThis as unknown as { process: { on(ev: string, f: (e: unknown) => void): void; off(ev: string, f: (e: unknown) => void): void } }).process
proc.on('unhandledRejection', onUnhandled)
afterAll(() => void proc.off('unhandledRejection', onUnhandled))

const { previewLook, SEED_VARIANTS } = await import('./uiVariant')

describe('switching look twice quickly', () => {
  it('leaves no unhandled rejection, and the last look asked for is the one worn', async () => {
    const [a, b] = SEED_VARIANTS.filter((v) => v.schema === 'omegasurface.variant/0.1')
    const prefs = (v: typeof a) => ({ variant: v, layout: null, apps: null, experience: null })
    root.dataset.uiVariant = 'default'
    previewLook(prefs(a))
    previewLook(prefs(b))            // before the first cross-fade has finished: the browser skips it
    previewLook(prefs(a))
    previewLook(prefs(b))
    await new Promise((r) => setTimeout(r, 80))
    expect(unhandled).toEqual([])
    expect(root.dataset.uiVariant).toBe(b.id)
  })
})
