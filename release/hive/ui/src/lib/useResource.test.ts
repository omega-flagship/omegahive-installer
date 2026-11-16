// Purpose: the one loading model for every page (lib/useResource): a read's states, superseded and refused reads,
// polling, the count of reads in flight the Ask waits on, and how a resource is drawn.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../api/client'
import { ResourceView } from '../ui/ResourceView'
import { actionFailure, need, Resource, UnsupportedError, type ResourceState, type Visibility } from './useResource'
import { onReadsInFlight, readsInFlight, trackRead } from './readsInFlight'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function fakeVisibility() {
  let hidden = false
  const fns = new Set<() => void>()
  const vis: Visibility = { hidden: () => hidden, onChange: (fn) => (fns.add(fn), () => fns.delete(fn)) }
  return { vis, set: (h: boolean) => ((hidden = h), fns.forEach((f) => f())) }
}

describe('Resource', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts loading, then ready', async () => {
    const r = new Resource(() => Promise.resolve([1, 2]))
    expect(r.getState().status).toBe('loading')
    r.start()
    await flush()
    expect(r.getState()).toMatchObject({ status: 'ready', data: [1, 2], error: undefined })
    r.stop()
  })

  it('reports an empty list as empty, and honours isEmpty', async () => {
    const a = new Resource(() => Promise.resolve([] as number[]))
    a.start()
    await flush()
    expect(a.getState().status).toBe('empty')
    const b = new Resource(() => Promise.resolve({ minds: [] }), { isEmpty: () => false })
    b.start()
    await flush()
    expect(b.getState().status).toBe('ready')
  })

  it('a failure with nothing loaded is an error, and retry recovers', async () => {
    let fail = true
    const r = new Resource(() => (fail ? Promise.reject(new ApiError(500, 'boom', 'Server error')) : Promise.resolve(['x'])))
    r.start()
    await flush()
    expect(r.getState().status).toBe('error')
    expect((r.getState().error as ApiError).status).toBe(500)
    fail = false
    await r.load()
    expect(r.getState()).toMatchObject({ status: 'ready', data: ['x'], error: undefined })
  })

  it('a failed refresh keeps the last data and reports the error alongside it', async () => {
    let fail = false
    const r = new Resource(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(['x'])))
    r.start()
    await flush()
    fail = true
    await r.load()
    const s = r.getState()
    expect(s.status).toBe('ready')
    expect(s.data).toEqual(['x'])
    expect((s.error as Error).message).toBe('offline')
  })

  it('a missing client method is unsupported, never a skeleton forever', async () => {
    const client = { mode: 'sim' } as unknown as HiveClient
    const r = new Resource(() => need(client, 'health', 'Health checks')())
    r.start()
    await flush()
    expect(r.getState().status).toBe('unsupported')
    expect((r.getState().error as Error).message).toBe('Health checks is not available here.')
    // a null client too
    const n = new Resource(() => need(null, 'listPeople')())
    n.start()
    await flush()
    expect(n.getState().status).toBe('unsupported')
  })

  it('need() binds the method to its client', async () => {
    const client = { secret: 42, me() { return Promise.resolve((this as { secret: number }).secret) } } as unknown as HiveClient
    expect(await need(client, 'me')()).toBe(42)
  })

  it('drops responses from superseded fetches', async () => {
    const resolvers: ((v: string) => void)[] = []
    const r = new Resource(() => new Promise<string>((res) => resolvers.push(res)))
    r.start()
    await flush()
    void r.load()
    await flush()
    resolvers[1]('new')
    await flush()
    resolvers[0]('old')
    await flush()
    expect(r.getState().data).toBe('new')
  })

  it('polls only while visible, and refetches as soon as the tab is shown again', async () => {
    const { vis, set } = fakeVisibility()
    const fetcher = vi.fn(() => Promise.resolve(['x']))
    const r = new Resource(fetcher, { poll: 1000, visibility: vis })
    r.start()
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    set(true)
    vi.advanceTimersByTime(5000)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    set(false)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(4)
    r.stop()
    vi.advanceTimersByTime(5000)
    set(true)
    set(false)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('notifies subscribers with a new snapshot on each change', async () => {
    const r = new Resource(() => Promise.resolve(['x']))
    const seen: string[] = []
    r.subscribe(() => seen.push(r.getState().status))
    r.start()
    await flush()
    expect(seen).toEqual(['ready'])
    r.mutate(() => [])
    expect(r.getState().status).toBe('empty')
  })
})

describe('reads in flight (what the Ask waits for before it reads the page an act left)', () => {
  const gate = () => {
    let open!: (v: number[]) => void
    const p = new Promise<number[]>((done) => (open = done))
    return { p, open }
  }

  it('a read counts from its fetch until it lands, and each change is announced', async () => {
    const changes: number[] = []
    const off = onReadsInFlight(() => changes.push(readsInFlight()))
    const g = gate()
    const r = new Resource(() => g.p)
    expect(readsInFlight()).toBe(0)
    r.start()
    expect(readsInFlight()).toBe(1)
    g.open([1])
    await flush()
    expect(r.getState().status).toBe('ready')
    expect(readsInFlight()).toBe(0)
    expect(changes).toEqual([1, 0])
    // a refresh is a read in flight too: the page shows its last answer meanwhile, and the Ask waits for the new one
    const again = gate()
    r.setFetcher(() => again.p)
    void r.load()
    expect(readsInFlight()).toBe(1)
    again.open([2])
    await flush()
    expect(readsInFlight()).toBe(0)
    r.stop()
    off()
  })

  it('a superseded read never ends the count while the newer read is still out', async () => {
    const slow = gate()
    const quick = gate()
    const reads = [slow, quick]
    const r = new Resource(() => reads.shift()!.p)
    r.start()
    void r.load()
    expect(readsInFlight()).toBe(1)
    slow.open([1])   // the old read lands first: it is ignored, and the newer one is still out
    await flush()
    expect(readsInFlight()).toBe(1)
    quick.open([2])
    await flush()
    expect(readsInFlight()).toBe(0)
    expect(r.getState().data).toEqual([2])
    r.stop()
  })

  it('any read tracked (a page’s or a look’s code arriving) counts until it lands or fails', async () => {
    const code = gate()
    const lost = Promise.reject(new Error('chunk failed'))
    lost.catch(() => undefined)
    void trackRead(code.p)
    const failing = trackRead(lost).catch(() => 'failed')
    expect(readsInFlight()).toBe(2)
    expect(await failing).toBe('failed')
    await flush()
    expect(readsInFlight()).toBe(1)
    code.open([1])
    await flush()
    expect(readsInFlight()).toBe(0)
  })

  it('a stop or a change of person ends its read at once, though the fetch is still out', async () => {
    const a = new Resource(() => gate().p)
    a.start()
    expect(readsInFlight()).toBe(1)
    a.stop()
    expect(readsInFlight()).toBe(0)
    const b = new Resource(() => gate().p, {}, 'ctx-ada')
    b.start()
    expect(readsInFlight()).toBe(1)
    b.rebind('ctx-bo')
    expect(readsInFlight()).toBe(0)
    b.stop()
  })
})

describe('actionFailure', () => {
  it('says "not available here" for a missing method, never success', () => {
    expect(actionFailure(new UnsupportedError('Withdrawing invitations'), 'That did not work')).toEqual({ tone: 'info', title: 'Not available here', body: 'Withdrawing invitations is not available here.' })
    expect(actionFailure(new ApiError(500, 'x', 'Boom'), 'Could not save')).toEqual({ tone: 'error', title: 'Could not save', body: 'Boom' })
    expect(actionFailure(new ApiError(0, 'network', 'fetch failed'), 'Could not save').body).toMatch(/Could not reach the hive/)
  })
})

describe('ResourceView', () => {
  const view = (res: ResourceState<string[]>, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(ResourceView<string[]>, { res: { ...res, reload: () => undefined }, errorTitle: 'Could not load', ...extra, children: (d: string[]) => createElement('p', null, `rows:${d.join(',')}`) }))
  const base = { data: undefined, error: undefined, refreshing: false }

  it('renders each state', () => {
    expect(view({ ...base, status: 'loading' })).toContain('skeleton')
    expect(view({ ...base, status: 'unsupported' })).toContain('Not available here')
    expect(view({ ...base, status: 'ready', data: ['a', 'b'] })).toContain('rows:a,b')
    expect(view({ ...base, status: 'empty', data: [] }, { empty: { title: 'Nothing yet' } })).toContain('Nothing yet')
    expect(view({ ...base, status: 'empty', data: [] })).toContain('rows:')
  })

  it('shows an error with retry, and the forbidden text only on a 403', () => {
    const forbidden = { title: 'Admins only' }
    const e500 = view({ ...base, status: 'error', error: new ApiError(500, 'x', 'Server error') }, { forbidden })
    expect(e500).toContain('Could not load')
    expect(e500).toContain('Try again')
    expect(e500).not.toContain('Admins only')
    const e403 = view({ ...base, status: 'error', error: new ApiError(403, 'forbidden', 'Admins only') }, { forbidden })
    expect(e403).toContain('Admins only')
    expect(e403).not.toContain('Try again')
    // without a forbidden blurb a 403 is an ordinary error
    expect(view({ ...base, status: 'error', error: new ApiError(403, 'forbidden', 'nope') })).toContain('Try again')
  })

  it('keeps stale data on screen with a refresh notice', () => {
    const html = view({ ...base, status: 'ready', data: ['a'], error: new Error('offline') })
    expect(html).toContain('rows:a')
    expect(html).toContain('Could not refresh')
  })
})
