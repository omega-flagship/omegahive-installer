import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approval } from '../api/types'
import { SimClient } from '../api/sim/SimClient'
import { countPending } from '../store/reducer'
import { useHive } from '../store/store'
import { announceable, approvalToastQueue, ASK_GROUP, askToast, asksWait, queueEmptiesOn, type QueuedAsk } from './approvalToasts'

const ask = (id: string) => ({ id, agent_id: 'a', skill: 'shell', command: 'ls', status: 'pending' }) as unknown as Approval

describe('approval toasts yield to an open modal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('shows at once with no modal', () => {
    const shown: string[][] = []
    const q = approvalToastQueue((a) => shown.push(a.map((x) => x.id)), () => false)
    q.push(ask('1'))
    expect(shown).toEqual([['1']])
  })
  it('waits while a modal is open, then shows what arrived in one toast', () => {
    let modal = true
    const shown: string[][] = []
    const q = approvalToastQueue((a) => shown.push(a.map((x) => x.id)), () => modal, 100)
    q.push(ask('1'))
    q.push(ask('2'))
    vi.advanceTimersByTime(500)
    expect(shown).toEqual([])
    expect(q.pending()).toBe(2)
    modal = false
    vi.advanceTimersByTime(150)
    expect(shown).toEqual([['1', '2']])
    expect(q.pending()).toBe(0)
  })
})

describe('approval toasts wait while a guided reading step shows (stand-in r5 P2)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('asksWait follows html[data-guide-reading]; the asks wait, then one toast says what arrived', () => {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('document', { documentElement: { dataset } })
    expect(asksWait()).toBe(false)
    dataset.guideReading = ''
    expect(asksWait()).toBe(true)
    const shown: string[][] = []
    const q = approvalToastQueue((a) => shown.push(a.map((x) => x.id)), asksWait, 100)
    q.push(ask('1'))
    vi.advanceTimersByTime(500)
    expect([shown, q.pending()]).toEqual([[], 1])
    delete dataset.guideReading
    vi.advanceTimersByTime(150)
    expect(shown).toEqual([['1']])
  })
})

describe('asks held during a reading step (Root r6: deferred, withdrawn, person switch, tour closed)', () => {
  const ap = (id: string, status = 'pending') => ({ id, status, command: 'invented', agent_id: 'a_inv', skill: 'shell' }) as unknown as Approval
  const agents = { a_inv: { name: 'Invented' } } as unknown as ReturnType<typeof useHive.getState>['agents']
  /** the Inbox badge's count: shell/Nav's own countPending over the store's approvals */
  const badge = (approvals: Record<string, Approval>) => countPending(approvals)
  const dataset: Record<string, string> = {}
  beforeEach(() => {
    vi.useFakeTimers()
    for (const k of Object.keys(dataset)) delete dataset[k]
    vi.stubGlobal('document', { documentElement: { dataset } })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  /** the hook's queue, with its own show (askToast over the store as it is at that moment) */
  const rig = (now: () => { session: string; approvals: Record<string, Approval> }) => {
    const toasts: string[] = []
    const q = approvalToastQueue<QueuedAsk>((queued) => {
      const t = askToast(queued, { ...now(), agents }, '#/')
      if (t) toasts.push(t.title)
    }, asksWait, 100)
    return { q, toasts }
  }

  it('deferred: held while reading, delivered once it ends; the Inbox badge counts it all along', async () => {
    const { holdAsks } = await import('../features/guided/reading')
    const state = { session: 'S1', approvals: {} as Record<string, Approval> }
    const { q, toasts } = rig(() => state)
    const release = holdAsks(document.documentElement as HTMLElement)
    state.approvals = { p1: ap('p1') }
    q.push({ approval: ap('p1'), session: 'S1' })
    vi.advanceTimersByTime(1000)
    expect([toasts, q.pending(), badge(state.approvals)]).toEqual([[], 1, 1])
    release()
    vi.advanceTimersByTime(150)
    expect([toasts, q.pending(), badge(state.approvals)]).toEqual([['Invented asks to run shell'], 0, 1])
  })

  it('withdrawn while held (decided, expired): dropped, never delivered late', async () => {
    const { holdAsks } = await import('../features/guided/reading')
    const state = { session: 'S1', approvals: { p1: ap('p1'), p2: ap('p2') } as Record<string, Approval> }
    const { q, toasts } = rig(() => state)
    const release = holdAsks(document.documentElement as HTMLElement)
    q.push({ approval: ap('p1'), session: 'S1' })
    q.push({ approval: ap('p2'), session: 'S1' })
    state.approvals = { p1: ap('p1', 'denied'), p2: ap('p2', 'expired') }
    expect(badge(state.approvals)).toBe(0)
    release()
    vi.advanceTimersByTime(300)
    expect([toasts, q.pending()]).toEqual([[], 0])
  })

  it('a person switch while held: nothing of the previous person is delivered', async () => {
    const { holdAsks } = await import('../features/guided/reading')
    let state = { session: 'S-a', approvals: { p1: ap('p1') } as Record<string, Approval> }
    const { q, toasts } = rig(() => state)
    const release = holdAsks(document.documentElement as HTMLElement)
    q.push({ approval: ap('p1'), session: 'S-a' })
    // the next person's store, even holding an ask with the same id
    state = { session: 'S-b', approvals: { p1: ap('p1') } }
    expect(queueEmptiesOn({ session: 'S-b', inits: 2 }, { session: 'S-a', inits: 1 })).toBe(true)
    release()
    vi.advanceTimersByTime(300)
    expect(toasts).toEqual([])
    // and the hook empties the queue on that change itself (q.stop): nothing is left to deliver later
    q.push({ approval: ap('p9'), session: 'S-a' })
    q.stop()
    vi.advanceTimersByTime(300)
    expect([toasts, q.pending()]).toEqual([[], 0])
  })

  it('the tour closed or aborted mid-step: the hold is released at once, and what waited is delivered', async () => {
    const { holdAsks, readingNow } = await import('../features/guided/reading')
    const step = { say: 'x', read: true as const }
    const run = (status: string) => ({ kind: 'demo', script: { steps: [step] }, m: { status, step: 0 } }) as unknown as Parameters<typeof readingNow>[0]
    // GuideLayer holds while readingNow is true and releases (effect cleanup) the moment it turns false
    expect(readingNow(run('ready'), false, true)).toBe(true)
    expect(readingNow(run('paused'), false, true)).toBe(true)
    for (const [r, modal, shown] of [[null, false, true], [run('ended'), false, true], [run('running'), false, true], [run('ready'), true, true], [run('ready'), false, false]] as const) expect(readingNow(r, modal, shown)).toBe(false)
    const state = { session: 'S1', approvals: { p1: ap('p1') } as Record<string, Approval> }
    const { q, toasts } = rig(() => state)
    const release = holdAsks(document.documentElement as HTMLElement)
    q.push({ approval: ap('p1'), session: 'S1' })
    expect(asksWait()).toBe(true)
    release() // closed / stopped / fenced: readingNow false, the effect's cleanup
    expect(asksWait()).toBe(false)
    expect(dataset).toEqual({})
    vi.advanceTimersByTime(150)
    expect(toasts).toEqual(['Invented asks to run shell'])
  })
})

describe('announceable (Review R-B1, R-B2)', () => {
  const ap = (id: string, status: string, command = 'ls') => ({ id, status, command, agent_id: 'a', skill: 'shell' }) as unknown as Approval
  it('announces only asks queued in the current session that the store still holds as pending, as the store holds them', () => {
    const now = { session: 'S2', approvals: { p_1: ap('p_1', 'pending', 'store copy'), p_2: ap('p_2', 'approved') } }
    const out = announceable([{ approval: ap('p_1', 'pending', 'queued copy'), session: 'S2' }, { approval: ap('p_2', 'pending'), session: 'S2' }], now)
    expect(out.map((a) => a.command)).toEqual(['store copy'])
  })
  it('never announces an ask the store does not hold', () => {
    expect(announceable([{ approval: ap('p_from_a', 'pending'), session: 'S2' }], { session: 'S2', approvals: {} })).toEqual([])
  })
  it('Review R-B2: an A ask whose id B reuses is not announced under B (A-private command never shown)', () => {
    const a = { approval: ap('p_same', 'pending', 'invented A-private command'), session: 'S1' }
    const b = { session: 'S2', approvals: { p_same: ap('p_same', 'pending', 'B command') } }
    const out = announceable([a], b)
    expect(out).toEqual([])
    expect(JSON.stringify(out)).not.toContain('A-private')
  })
  it('A -> B -> A: an ask queued in the first A session is not revived by the later A session', () => {
    const first = { approval: ap('p_same', 'pending', 'first A'), session: 'S1' }
    const later = { session: 'S3', approvals: { p_same: ap('p_same', 'pending', 'later A') } }
    expect(announceable([first], later)).toEqual([])
  })
})

describe('Kimi K3: the queue empties on a fresh init of the same client', () => {
  it('queueEmptiesOn: a new session or a new init empties it; anything else does not', () => {
    expect(queueEmptiesOn({ session: 'S1', inits: 2 }, { session: 'S1', inits: 2 })).toBe(false)
    expect(queueEmptiesOn({ session: 'S1', inits: 3 }, { session: 'S1', inits: 2 })).toBe(true)
    expect(queueEmptiesOn({ session: 'S2', inits: 3 }, { session: 'S1', inits: 2 })).toBe(true)
  })

  it('an ask queued behind a modal is not announced after init runs again for the same client', async () => {
    vi.stubGlobal('window', { location: { search: '', hash: '' } })
    const client = new SimClient({ seed: 31, latency: false, autoStart: false, historyDays: 1 })
    try {
      await useHive.getState().init(client)
      const shown: string[][] = []
      const q = approvalToastQueue<QueuedAsk>((x) => shown.push(x.map((y) => y.approval.id)), () => modal, 100)
      let modal = true
      // the hook's wiring, as written in useApprovalToasts
      const off = useHive.subscribe((st, prev) => {
        if (queueEmptiesOn(st, prev)) q.stop()
      })
      const before = useHive.getState().inits
      q.push({ approval: ask('p_invented'), session: useHive.getState().session })
      expect(q.pending()).toBe(1)
      await useHive.getState().init(client)
      expect(useHive.getState().inits).toBe(before + 1)
      expect(useHive.getState().session).toBeTruthy()
      expect(q.pending()).toBe(0)
      modal = false
      q.flush()
      expect(shown).toEqual([])
      // and the queue still works for asks after the re-init
      q.push({ approval: ask('p_after'), session: useHive.getState().session })
      expect(shown).toEqual([['p_after']])
      off()
      q.stop()
    } finally {
      client.disconnect()
      vi.unstubAllGlobals()
    }
  })
})

/** Audit P2 #11: two or three "X asks to run …" cards piled up over the content and the Ask. */
describe('approval asks never pile up', () => {
  const ap = (id: string, agent_id = 'a1') => ({ id, agent_id, skill: 'shell', command: `echo ${id}`, status: 'pending' }) as unknown as Approval
  const q = (a: Approval): QueuedAsk => ({ approval: a, session: 's1' })
  it('a second ask while the first card shows: one card says more decisions wait, in the same group, with no count', () => {
    const approvals = { x: ap('x'), y: ap('y'), z: ap('z') }
    const agents = { a1: { name: 'Vega', hue: 1 } } as never
    const first = askToast([q(approvals.x)], { session: 's1', approvals, agents }, '#/')!
    expect(first).toMatchObject({ group: ASK_GROUP, title: 'Vega asks to run shell' })
    const next = askToast([q(approvals.y)], { session: 's1', approvals, agents, toasts: [{ ...first, id: 1 }] }, '#/')!
    expect(next).toMatchObject({ group: ASK_GROUP, title: 'More decisions waiting', body: 'The newest: Vega asks to run shell', action: { label: 'Open the inbox' } })
  })
  it('the store keeps one toast per group: the newer replaces the card on screen', () => {
    const s = useHive.getState()
    s.toast({ tone: 'info', title: 'A asks', group: ASK_GROUP })
    s.toast({ tone: 'info', title: 'Unrelated' })
    s.toast({ tone: 'info', title: 'More decisions waiting', group: ASK_GROUP })
    const titles = useHive.getState().toasts.map((t) => t.title)
    expect(titles.filter((t) => t === 'A asks' || t === 'More decisions waiting')).toEqual(['More decisions waiting'])
    expect(titles).toContain('Unrelated')
  })
})
