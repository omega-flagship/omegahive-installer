/**
 * lab-pc-band r1.6, figures (lab-figures r1): the real useFigure on a minimal hook runtime (state, effects with deps
 * and cleanup), as pcFamilyScope.test.ts does. The PNG is generated here (api/sim/pngFixture), not any report's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rt = { slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }
vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const i = rt.cursor++
      if (!(i in rt.slots)) rt.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
      return [rt.slots[i], (v: unknown) => (rt.slots[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[i]) : v)]
    },
    useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
      const i = rt.cursor++
      const prev = rt.slots[i] as { deps?: unknown[]; cleanup?: (() => void) | void } | undefined
      if (!prev || !deps || !prev.deps || deps.some((d, n) => d !== prev.deps![n]))
        rt.effects.push(() => {
          prev?.cleanup?.()
          rt.slots[i] = { deps, cleanup: fn() }
        })
    },
  }
})

const { useFigure, figureFailure } = await import('./Figures')
const { ApiError } = await import('../../../api/client')
const { makePng } = await import('../../../api/sim/pngFixture')
import type { PcFigure } from './model'

const png = makePng(4, 3, (x, y) => [x * 60, y * 80, 120])
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')
let fig: PcFigure
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
const step = <T,>(hook: () => T): T => {
  rt.cursor = 0
  const v = hook()
  while (rt.effects.length) rt.effects.shift()!()
  return v
}
/** run every effect cleanup, as an unmount does */
const unmount = () => {
  for (const s of rt.slots) (s as { cleanup?: () => void } | undefined)?.cleanup?.()
  rt.slots = []
}
let made: string[]
let revoked: string[]

beforeEach(async () => {
  rt.slots = []
  rt.effects = []
  made = []
  revoked = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:sim/${made.length}`
    made.push(u)
    return u
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u))
  const sha = await hex(png)
  fig = { sha256: sha, mime: 'image/png', bytes: png.length, width: 4, height: 3, caption: 'A caption', sourceLocator: null, readUrl: `/api/evolve/swarms/s/records/r/figures/${sha}` }
})
afterEach(() => {
  unmount()   // no read from one test may land in the next
  vi.restoreAllMocks()
})
/** wait (bounded) until the hook leaves "loading": the sha256 check is real async crypto, slower under load */
async function settled(read: () => unknown) {
  await vi.waitFor(() => expect(step(read as () => { status: string }).status).not.toBe('loading'), { timeout: 5000, interval: 10 })
}

const blobOf = (b: Uint8Array) => new Blob([b as BlobPart], { type: 'image/png' })

describe('useFigure', () => {
  it('reads through the fetcher (the client: header auth), checks the sha256, shows a blob: URL', async () => {
    const asked: string[] = []
    const fetcher = (u: string) => (asked.push(u), Promise.resolve(blobOf(png)))
    expect(step(() => useFigure(fig, fetcher, '1'))).toEqual({ status: 'loading' })
    await settled(() => useFigure(fig, fetcher, '1'))
    expect(step(() => useFigure(fig, fetcher, '1'))).toEqual({ status: 'ready', url: 'blob:sim/0' })
    expect(asked).toEqual([fig.readUrl])
    expect(asked[0]).not.toMatch(/[?#]/)
  })
  it('the blob: URL is revoked on unmount', async () => {
    const fetcher = () => Promise.resolve(blobOf(png))
    step(() => useFigure(fig, fetcher, '1'))
    await settled(() => useFigure(fig, fetcher, '1'))
    unmount()
    expect(revoked).toEqual(['blob:sim/0'])
  })
  it('a new identity epoch revokes the old URL and reads again; the old one is never shown under the new identity', async () => {
    const fetcher = () => Promise.resolve(blobOf(png))
    step(() => useFigure(fig, fetcher, '1'))
    await settled(() => useFigure(fig, fetcher, '1'))
    expect(step(() => useFigure(fig, fetcher, '1'))).toEqual({ status: 'ready', url: 'blob:sim/0' })
    expect(step(() => useFigure(fig, fetcher, '2'))).toEqual({ status: 'loading' })
    expect(revoked).toEqual(['blob:sim/0'])
    await settled(() => useFigure(fig, fetcher, '2'))
    expect(step(() => useFigure(fig, fetcher, '2'))).toEqual({ status: 'ready', url: 'blob:sim/1' })
  })
  it('a read that ends after the identity changed makes no URL (nothing to leak)', async () => {
    let release!: (b: Blob) => void
    const fetcher = () => new Promise<Blob>((r) => (release = r))
    step(() => useFigure(fig, fetcher, '1'))
    unmount()
    release(blobOf(png))
    // let the hook's own sha256 check run to its end (the same digest, queued after it), then look
    await hex(png)
    await hex(png)
    await flush()
    expect(made).toEqual([])
  })
  it('401, 404 and network failures: not available here, with the reason; the figure keeps its identity', async () => {
    for (const [e, why] of [
      [new ApiError(401, 'unauthorized', 'x'), 'you are signed out'],
      [new ApiError(404, 'not_found', 'x'), 'not found, or not shared with you'],
      [new ApiError(0, 'network', 'x'), 'the hive could not be reached'],
    ] as const) {
      unmount()
      const reject = () => Promise.reject(e)
      step(() => useFigure(fig, reject, 'k'))
      await settled(() => useFigure(fig, reject, 'k'))
      expect(step(() => useFigure(fig, reject, 'k'))).toEqual({ status: 'unavailable', why })
      expect(figureFailure(e)).toBe(why)
    }
    expect(made).toEqual([])
  })
  it('bytes that do not match the recorded sha256 are not shown', async () => {
    const other = makePng(2, 2, () => [1, 2, 3])
    const fetcher = () => Promise.resolve(blobOf(other))
    step(() => useFigure(fig, fetcher, '1'))
    await settled(() => useFigure(fig, fetcher, '1'))
    expect(step(() => useFigure(fig, fetcher, '1'))).toEqual({ status: 'unavailable', why: 'its bytes do not match the recorded sha256' })
    expect(made).toEqual([])
  })
  it('no read route, or no reader: not available here, and nothing is fetched', () => {
    expect(step(() => useFigure({ ...fig, readUrl: null }, () => Promise.reject(new Error('must not be called')), '1'))).toEqual({ status: 'unavailable', why: 'the host gave no read route for it' })
    expect(step(() => useFigure(fig, null, '1'))).toEqual({ status: 'unavailable', why: 'this hive cannot read figures' })
  })
})
