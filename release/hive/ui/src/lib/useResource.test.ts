import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../api/client'
import { ResourceView } from '../ui/ResourceView'
import { actionFailure, need, Resource, UnsupportedError, type ResourceState, type Visibility } from './useResource'

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
