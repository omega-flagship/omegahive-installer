// @vitest-environment node
// Purpose: the Ask conductor's act runner reads the page an act left only once it has settled (features/ask/conductor
// settledPage): a move answers with the page it opened once that page's read has landed, a fill with the list it
// narrowed once the page has read it again, and a read still in flight when the wait runs out is answered as loading,
// with how many reads were pending, never as the page. Pages here are mounted with their own reads (lib/useResource)
// and Ask views, as the hive's pages are. INVENTED ids.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, useSyncExternalStore } from 'react'
import { act } from 'react'
import type { ActResult, AskEvent } from '../../api/ask'
import type { HiveClient } from '../../api/client'
import { lazyRoute } from '../../lib/lazyRoute'
import { useResource } from '../../lib/useResource'
import { setMover, useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { PresenceLazy } from '../../ui/PresenceLazy'
import { mountPage, type MountedPage } from '../views/mountedView.testkit'
import { APP_READ_SETTLE_MS, conductorSettled, resetConductor } from './conductor'
import { useAskFillable } from './fields'
import { useAskView } from './view'

// a move into the Artifacts page waits APP_READ_SETTLE_MS for a read that never lands: allow for it on a loaded machine
vi.setConfig({ testTimeout: APP_READ_SETTLE_MS + 15_000 })

// where the page is: the runner's moves go through the mover, as AskHost's does
let at = 'hive'
const watchers = new Set<() => void>()
const route = { get: () => at, watch: (f: () => void) => (watchers.add(f), () => void watchers.delete(f)) }
const moveTo = (name: string) => { at = name; for (const f of [...watchers]) f() }

const later = <T,>(ms: number, value: T) => new Promise<T>((done) => setTimeout(() => done(value), ms))
const refs = (ids: string[] | undefined) => (ids ?? []).map((ref) => ({ kind: 'artifact' as const, ref }))

function Home() {
  useAskView('test.home', { title: 'Home', refs: [{ kind: 'goal', ref: 'g_home0001' }] })
  return null
}
function Listing({ read }: { read: () => Promise<string[]> }) {
  const res = useResource(read)
  useAskView('test.listing', { title: 'Listing', refs: refs(res.data) })
  return null
}
function Search() {
  const [q, setQ] = useState('')
  useAskFillable('test.search', 'Search the list', 'search', setQ)
  // the page reads its list again for the words typed (useResource key): it keeps the last list on screen meanwhile
  const res = useResource(() => later(40, ['ar_harbour01', 'ar_tipview01'].filter((id) => id.includes(q))), { key: q })
  useAskView('test.search', { title: 'Search', refs: refs(res.data) })
  return null
}
// a page whose code arrives later, loaded and wrapped as the hive's own pages are (App.tsx: lazyRoute, PresenceLazy)
const LazyListing = lazyRoute(() => later(60, { default: Listing }))
function App({ read, lazyPage = false }: { read: () => Promise<string[]>; lazyPage?: boolean }) {
  const where = useSyncExternalStore(route.watch, route.get, route.get)
  if (where === 'artifacts') return lazyPage ? <PresenceLazy><LazyListing read={read} /></PresenceLazy> : <Listing read={read} />
  return where === 'search' ? <Search /> : <Home />
}

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
let posted: { act: string; body: ActResult }[] = []
let page: MountedPage
let n = 0
let seq = 0
beforeEach(async () => {
  page = await mountPage()
  // the runner moves and reads the page outside React's act(), as in the browser
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  posted = []
  at = 'hive'
  resetConductor()
  setMover((r) => moveTo(r.name))
})
afterEach(async () => {
  setMover(null)
  useAskStore.getState().reset()
  await page.restore()
  useHive.setState({ client: null as never })
})

async function turn(): Promise<string> {
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', events: [], more: false })),
    askTakeover: vi.fn(async () => ({})),
    askActResult: vi.fn(async (_op: string, act: string, body: ActResult) => {
      posted.push({ act, body })
      return { recorded: true }
    }),
  } as unknown as HiveClient
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await useAskStore.getState().send('show me the harbour picture', { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  seq = 0
  deliver(op, { phase: 'accepted', thread })
  return op
}
function deliver(op: string, f: Record<string, unknown>) {
  useAskStore.getState().onEvent({ type: 'ask', operation_id: op, turn_id: 't1', seq: ++seq, at: '2026-11-16T00:00:00Z', ...f } as unknown as AskEvent)
}
const mount = async (read: () => Promise<string[]>, lazyPage = false) => {
  await act(async () => page.root.render(<App read={read} lazyPage={lazyPage} />))
}
const answerTo = (actId: string) => posted.find((p) => p.act === actId)?.body

describe('an act is answered with the page it left, once that page has settled', () => {
  it('a move answers with the page it opened, its list read, never with the page it left behind', async () => {
    await mount(() => later(60, ['ar_harbour01', 'ar_tipview01']))
    const op = await turn()
    deliver(op, { phase: 'act', act: { act_id: 'act_move', kind: 'navigate', route: '#/artifacts' } })
    await conductorSettled(op)
    const body = answerTo('act_move')!
    expect(body.ok).toBe(true)
    expect(body.view.refs).toEqual(refs(['ar_harbour01', 'ar_tipview01']))
    expect(body.loading).toBeUndefined()
  })

  it('a move to a page whose code is still arriving answers once its code and then its list have landed', async () => {
    await mount(() => later(60, ['ar_harbour01', 'ar_tipview01']), true)
    const op = await turn()
    deliver(op, { phase: 'act', act: { act_id: 'act_lazy', kind: 'navigate', route: '#/artifacts' } })
    await conductorSettled(op)
    const body = answerTo('act_lazy')!
    expect(body.view.refs).toEqual(refs(['ar_harbour01', 'ar_tipview01']))
    expect(body.loading).toBeUndefined()
  })

  it('a fill answers with the list the page read again for the words typed', async () => {
    moveTo('search')
    await mount(() => later(0, []))
    // the first list has landed before the turn begins
    await act(async () => { await later(80, null) })
    const op = await turn()
    deliver(op, { phase: 'act', act: { act_id: 'act_fill', kind: 'fill', field: 'test.search', text: 'harbour' } })
    await conductorSettled(op)
    expect(answerTo('act_fill')!.view.refs).toEqual(refs(['ar_harbour01']))
  })

  it('a read still in flight when the wait runs out is answered as loading, with how many reads were pending', async () => {
    await mount(() => new Promise<string[]>(() => undefined))   // a read that never lands
    const op = await turn()
    const began = Date.now()
    deliver(op, { phase: 'act', act: { act_id: 'act_slow', kind: 'navigate', route: '#/artifacts' } })
    await conductorSettled(op)
    const body = answerTo('act_slow')!
    expect(Date.now() - began).toBeGreaterThanOrEqual(APP_READ_SETTLE_MS - 50)
    // the page as it stood (its list not in yet), and that one read was still loading, so it is read again, not trusted
    expect(body.loading).toBe(1)
    expect(body.view.refs).toEqual([])
  })
})
