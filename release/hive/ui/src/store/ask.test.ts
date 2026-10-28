import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the page's location, played in node: navigate() moves the hash, as the router does
const loc = { hash: '#/', search: '', pathname: '/' }
const moved: { hash: string; animate?: boolean }[] = []
// Preserve the browser's listener contract while keeping location/media deterministic in Node.
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: loc, matchMedia: () => ({ matches: false }) }))
vi.mock('../lib/router', async (orig) => {
  const real = await orig<typeof import('../lib/router')>()
  return { ...real, navigate: (r: import('../lib/router').Route) => void ((loc.hash = real.href(r)), moved.push({ hash: loc.hash })) }
})

const { AskRefusal } = await import('../api/ask')
const { useHive, hiveBus } = await import('./store')
const { NAV_FLOOD_CAP, PRESENCE_PER_TURN, setMover, threadRows, useAskStore } = await import('./ask')
const { markUnsaved } = await import('../features/ask/dirty')
const { DONE_WORDS, REFUSAL_WORDS } = await import('../features/ask/words')
const { href, parse } = await import('../lib/router')
const { previewLook } = await import('../shell/uiVariant')
type AskEvent = import('../api/ask').AskEvent
type HiveClient = import('../api/client').HiveClient

/**
 * Universal Ask phase 1: the store slice. A hand-made client (invented data, no network): what the host sends is
 * played as frames, in order, out of order, malformed, and read back. Covers the owner's rulings of 2026-10-05: moves as
 * often as the mind chooses (flood cap only), the person always wins (takeover), steering mid-turn, reversal, memory.
 */
const OP_RE = /^ask:/
let frames: Record<string, AskEvent[]> = {}
let sent: unknown[] = []
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
function fakeClient(over: Partial<HiveClient> = {}): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => {
      sent.push(b)
      return { operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const }
    }),
    askTurn: vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: 't1', events: (frames[op] ?? []).filter((e) => e.seq > after), more: false })),
    askSteer: vi.fn(async (op: string, b: { steer_id: string }) => ({ steer_id: b.steer_id, operation_id: op })),
    askTakeover: vi.fn(async () => ({})),
    askConfirm: vi.fn(async () => ({ ok: true })),
    askStop: vi.fn(async () => ({})),
    ...over,
  } as unknown as HiveClient
}

let n = 0
async function start(client: HiveClient, principal = 'user:p_ada') {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, principal)
}
/** A frame for the open turn, recorded as the host would store it (for the recovery read). */
function frame(op: string, seq: number, f: Record<string, unknown>): AskEvent {
  const e = { type: 'ask', operation_id: op, turn_id: 't1', principal: 'user:p_ada', seq, at: '2026-10-05T21:00:00Z', ...f } as unknown as AskEvent
  ;(frames[op] ??= []).push(e)
  return e
}
const deliver = (e: AskEvent) => useAskStore.getState().onEvent(e)
const rows = () => threadRows(useAskStore.getState())
const openOp = () => useAskStore.getState().open!
async function ask(text = 'show me around', client = fakeClient()) {
  if (useHive.getState().client !== client) await start(client)
  await useAskStore.getState().send(text, { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
  const op = openOp()
  deliver(frame(op, 1, { phase: 'accepted', thread }))
  return op
}
const nav = (op: string, seq: number, route: string, extra: Record<string, unknown> = {}) => frame(op, seq, { phase: 'proposal', proposal: { id: `p${seq}`, kind: 'navigate', route, digest: `d${seq}`, label: route.slice(2), ...extra } })

beforeEach(() => {
  frames = {}
  sent = []
  moved.length = 0
  loc.hash = '#/'
  setMover(null)
})
afterEach(() => {
  markUnsaved('test', false)
  previewLook(null) // a look preview counts as unsaved state for the next test
  useAskStore.getState().reset()
})

describe('frames: checked, in order, once; gaps recovered', () => {
  it('a gap waits and is filled from GET /api/ask/{op}; nothing applies twice', async () => {
    const op = await ask('hello there')
    const f2 = frame(op, 2, { phase: 'thinking', step: 'reading' })
    const f3 = frame(op, 3, { phase: 'answer', text: 'Hello.' })
    deliver(f3) // 2 was lost on the way
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].lastSeq).toBe(3))
    deliver(f2)
    deliver(f3)
    expect(useAskStore.getState().turns[op].events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(rows().filter((r) => r.kind === 'answer').map((r) => r.text)).toEqual(['Hello.'])
  })

  it('malformed frames are dropped silently: unknown phase, HTML in a caption, too many ink points, a revert with no target', async () => {
    const op = await ask('hello there')
    const before = useAskStore.getState().turns[op].lastSeq
    for (const bad of [
      { phase: 'explode' },
      { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'point', target: { feature: 'work.goals' }, caption: '<img src=x onerror=1>' },
      { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'dance', target: { feature: 'work.goals' }, caption: 'x' },
      { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'sketch', target: { feature: 'work.goals' }, ink: { shape: 'path', points: Array.from({ length: 65 }, () => [0, 0]) } },
      { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'point', target: { entity: { kind: 'secret', ref: 'x' } }, caption: 'x' },
      { phase: 'revert' },
      { phase: 'answer', text: 'x'.repeat(8001) },
    ])
      deliver({ type: 'ask', operation_id: op, turn_id: 't1', seq: before + 1, ...bad } as unknown as AskEvent)
    expect(useAskStore.getState().turns[op].lastSeq).toBe(before)
  })

  it('a refusal is said in the page’s own words: the host’s sentence is never shown', async () => {
    const op = await ask('hello there')
    deliver(frame(op, 2, { phase: 'refused', reason: 'timed_out', say: 'HOST INTERNAL: worker 7 timed out at ask.py:120' }))
    const r = rows().find((x) => x.kind === 'refused')!
    expect(r.text).toBe('')
    expect(REFUSAL_WORDS[r.reason!].say).not.toMatch(/ask\.py|worker/)
    expect(JSON.stringify(rows())).not.toContain('HOST INTERNAL')
    // a reason outside the closed set still closes the turn, as "not available"
    const op2 = await ask('again')
    deliver(frame(op2, 2, { phase: 'refused', reason: 'kaboom', say: 'raw' }))
    expect(useAskStore.getState().turns[op2].events.at(-1)).toMatchObject({ reason: 'not_available' })
  })
  it('ask-send-r1: timed_out says only that no answer came in time, with the spend the host counted; no "Nothing was done", no Ask again', async () => {
    const { refusedSay } = await import('../features/ask/words')
    const op = await ask('hello there')
    deliver(frame(op, 2, { phase: 'refused', reason: 'timed_out', spent_usd: 0.03, turn_spent_usd: 0.0234 }))
    const r = rows().find((x) => x.kind === 'refused')!
    expect(r.spentUsd).toBe(0.0234)
    expect(refusedSay(r.reason, r.spentUsd)).toBe('No answer came in time. The hive had counted $0.02 spent on it by then.')
    expect(REFUSAL_WORDS.timed_out.say).toBe('No answer came in time.')
    expect(REFUSAL_WORDS.timed_out.say).not.toMatch(/nothing was done|ask again/i)
    // the host reports no settled turn after its deadline: no retry is offered on it
    expect(REFUSAL_WORDS.timed_out.offer).toBeUndefined()
    // no spend reported (or an unreadable one): the bare words, nothing invented
    const op2 = await ask('again')
    deliver(frame(op2, 2, { phase: 'refused', reason: 'timed_out', turn_spent_usd: -1 }))
    const r2 = rows().filter((x) => x.kind === 'refused').at(-1)!
    expect(r2.spentUsd).toBeUndefined()
    expect(refusedSay(r2.reason, r2.spentUsd)).toBe('No answer came in time.')
    // only timed_out carries the figure; the pre-admission refusals keep their guaranteed "Nothing was done"
    expect(refusedSay('operation_conflict', 0.5)).toBe(REFUSAL_WORDS.operation_conflict.say)
    expect(REFUSAL_WORDS.operation_conflict.say).toMatch(/Nothing was done/)
    expect(REFUSAL_WORDS.invalid.say).toMatch(/Nothing was done/)
  })
})

describe('the mind moves the page (Quinn: as often as it chooses; animated only when it asks)', () => {
  it('five moves all apply, in order, with the trail of every move; animate reaches the mover', async () => {
    const calls: { hash: string; animate: boolean }[] = []
    setMover((r, animate) => {
      loc.hash = href(r)
      calls.push({ hash: loc.hash, animate })
    })
    const op = await ask()
    ;['#/tasks', '#/usage', '#/swarms', '#/approvals', '#/health'].forEach((h, i) => deliver(nav(op, i + 2, h, { animate: i % 2 === 0 })))
    expect(calls.map((c) => c.hash)).toEqual(['#/tasks', '#/usage', '#/swarms', '#/approvals', '#/health'])
    expect(calls.map((c) => c.animate)).toEqual([true, false, true, false, true])
    expect(rows().filter((r) => r.kind === 'nav').map((r) => r.state)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied'])
  })

  it('a flood cap stops a runaway turn', async () => {
    const op = await ask()
    for (let i = 0; i < NAV_FLOOD_CAP + 5; i++) deliver(nav(op, i + 2, i % 2 ? '#/tasks' : '#/usage'))
    expect(useAskStore.getState().turns[op].moves).toBe(NAV_FLOOD_CAP)
  })

  it('never over unsaved state: a Go card instead', async () => {
    const op = await ask()
    markUnsaved('test', true)
    deliver(nav(op, 2, '#/usage'))
    expect(loc.hash).toBe('#/')
    expect(rows().filter((r) => r.kind === 'go').map((r) => r.route)).toEqual(['#/usage'])
  })

  it('the person always wins: after they take over, moves become Go cards (and the host is told); a steer resumes', async () => {
    const client = fakeClient()
    const op = await ask('show me around', client)
    deliver(nav(op, 2, '#/tasks'))
    useAskStore.getState().personTookOver()
    expect(client.askTakeover).toHaveBeenCalledWith(op)
    deliver(nav(op, 3, '#/usage'))
    expect(loc.hash).toBe('#/tasks')
    expect(rows().map((r) => r.kind)).toContain('go')
    expect(rows().some((r) => r.kind === 'note' && /You took over/.test(r.text))).toBe(true)
    await useAskStore.getState().steer('carry on', { route: 'goals', experience: 'classic' })
    deliver(nav(op, 4, '#/swarms'))
    expect(loc.hash).toBe('#/swarms')
  })

  it('conductor-live takeover: a 404 not_available (conductor off) is inert; the page keeps its own pause, no error said', async () => {
    const client = fakeClient({ askTakeover: vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'not available') }) as never })
    const op = await ask('show me around', client)
    useAskStore.getState().personTookOver()
    await Promise.resolve()
    await Promise.resolve()
    expect(client.askTakeover).toHaveBeenCalledWith(op)
    expect(useAskStore.getState().turns[op].tookOver).toBe(true)
    expect(useAskStore.getState().turns[op].state).toBe('open')
    expect(rows().some((r) => r.kind === 'refused')).toBe(false)
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].takeover).toBe('inert'))
    expect(client.askStop).not.toHaveBeenCalled()   // never a stop of the coordinator's answer (ask-takeover r5b)
  })

  it('conductor-live takeover: the host’s done {cancelled, taken_over} closes the turn and says it plainly, not as an error', async () => {
    const client = fakeClient()
    const op = await ask('show me around', client)
    useAskStore.getState().personTookOver()
    deliver(frame(op, 2, { phase: 'done', outcome: 'cancelled', taken_over: true, spent_usd: 0.01, turn_spent_usd: 0.01 }))
    expect(useAskStore.getState().turns[op].state).toBe('done')
    const notes = rows().filter((r) => r.kind === 'note').map((r) => r.text)
    expect(notes).toContain('You took over — the Ask stopped.')
    expect(notes).not.toContain(DONE_WORDS.cancelled)
    expect(rows().some((r) => r.kind === 'refused' || r.state === 'failed')).toBe(false)
    // a plain cancelled (not a takeover) still reads as a stop
    const op2 = await ask('again', client)
    deliver(frame(op2, 2, { phase: 'done', outcome: 'cancelled' }))
    expect(rows().filter((r) => r.op === op2 && r.kind === 'note').map((r) => r.text)).toEqual([DONE_WORDS.cancelled])
  })

  it('conductor-live: the recovery view’s takeover reason is in the closed set, said plainly', () => {
    expect(REFUSAL_WORDS.takeover.say).toBe('You took over — the Ask stopped.')
  })

  it('ask-takeover r3: a takeover while the request is still being sent reaches the host once the turn is admitted', async () => {
    let admit!: () => void
    const client = fakeClient({
      ask: vi.fn((b: { operation_id: string }) => new Promise((res) => {
        admit = () => res({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })
      })) as never,
    })
    await start(client)
    const pending = useAskStore.getState().send('show me around', { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
    const op = openOp()
    expect(useAskStore.getState().turns[op].state).toBe('sending')
    useAskStore.getState().personTookOver()
    expect(useAskStore.getState().turns[op].tookOver).toBe(true)
    expect(client.askTakeover).not.toHaveBeenCalled()   // the host has no turn yet: a 404 would lose it
    admit()
    await pending
    expect(client.askTakeover).toHaveBeenCalledTimes(1)
    expect(client.askTakeover).toHaveBeenCalledWith(op)
    deliver(frame(op, 1, { phase: 'accepted', thread }))   // the accepted frame afterwards sends nothing more
    await Promise.resolve()
    expect(client.askTakeover).toHaveBeenCalledTimes(1)
    expect(useAskStore.getState().turns[op].takeover).toBe('sent')
  })

  it('ask-takeover r3: a takeover the host does not take stops the turn instead, and says so if that fails too', async () => {
    const client = fakeClient({
      askTakeover: vi.fn(async () => { throw new Error('offline') }) as never,
      askStop: vi.fn(async () => { throw new Error('offline') }) as never,
    })
    const op = await ask('show me around', client)
    useAskStore.getState().personTookOver()
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].takeover).toBe('failed'))
    expect(client.askStop).toHaveBeenCalledWith(op)
    expect(useAskStore.getState().turns[op].tookOver).toBe(true)   // the page still refuses the mind's moves
    expect(rows().some((r) => r.kind === 'note' && /didn’t confirm that the orchestrator stopped/.test(r.text))).toBe(true)
    const ok = fakeClient({ askTakeover: vi.fn(async () => { throw new Error('offline') }) as never })
    const op2 = await ask('again', ok)
    useAskStore.getState().personTookOver()
    await vi.waitFor(() => expect(useAskStore.getState().turns[op2].takeover).toBe('sent'))
    expect(ok.askStop).toHaveBeenCalledWith(op2)
  })

  it('followups-r8: a takeover answered after a sign-in change sends no stop (the second write is bound to the thread)', async () => {
    let fail: (e: Error) => void = () => undefined
    const client = fakeClient({ askTakeover: vi.fn(() => new Promise((_, rej) => { fail = rej })) as never })
    const op = await ask('show me around', client)
    useAskStore.getState().personTookOver()
    await vi.waitFor(() => expect(client.askTakeover).toHaveBeenCalledWith(op))
    useHive.setState({ session: `session-${++n}`, inits: n }) // signed in again on this page
    fail(new Error('offline'))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(client.askStop).not.toHaveBeenCalled()
  })

  it('a presence `go` moves the page like a navigate, with the same guards; presence is capped per turn', async () => {
    const op = await ask()
    deliver(frame(op, 2, { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'go', target: { feature: 'money.usage' }, caption: 'Opening Usage' }))
    expect(loc.hash).toBe('#/usage')
    for (let i = 0; i < PRESENCE_PER_TURN + 10; i++) deliver(frame(op, 3 + i, { phase: 'presence', actor: { id: 'a_vega01', name: 'Vega' }, verb: 'look', target: { region: 'page' }, caption: 'looking' }))
    expect(useAskStore.getState().turns[op].presence).toBe(PRESENCE_PER_TURN)
    expect(useAskStore.getState().presence.length).toBeLessThanOrEqual(4)
  })
})

describe('steering, reversal and memory', () => {
  it('conductor-live: a steer always goes to the host (no "can’t take words" fallback); a not_available refusal is said plainly', async () => {
    const client = fakeClient({ askSteer: vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'not available') }) as never })
    const op = await ask('show me around', client)
    await useAskStore.getState().steer('the other one', { route: 'hive', experience: 'classic' })
    expect(client.askSteer).toHaveBeenCalledTimes(1)
    expect(useAskStore.getState().turns[op].steers[0].state).toBe('failed')
    const notes = rows().filter((r) => r.kind === 'note').map((r) => r.text)
    expect(notes).toContain('These words couldn’t join this answer while it runs. Ask again when it finishes.')
    expect(notes.some((t) => /can’t take words mid-answer yet/.test(t))).toBe(false)
  })

  it('a steer shows at once where it was typed, is placed by its echo, and the turn stays open', async () => {
    const op = await ask()
    deliver(nav(op, 2, '#/tasks'))
    await useAskStore.getState().steer('not usage please', { route: 'goals', experience: 'classic' })
    expect(rows().map((r) => r.kind)).toEqual(['you', 'nav', 'steer'])
    expect(useAskStore.getState().turns[op].state).toBe('open')
    const sid = useAskStore.getState().turns[op].steers[0].steer_id
    deliver(nav(op, 3, '#/usage'))
    deliver(frame(op, 4, { phase: 'steer', steer_id: sid, text: 'not usage please', at_seq: 2 }))
    // pending until the echo, then placed by the host's seq; never shown twice
    expect(rows().filter((r) => r.kind === 'steer')).toHaveLength(1)
    expect(rows().map((r) => r.kind)).toEqual(['you', 'nav', 'nav', 'steer'])
  })

  it('a revert undoes the mind’s move through history and strikes it in the trail (never deleted)', async () => {
    const op = await ask()
    deliver(nav(op, 2, '#/tasks'))
    deliver(nav(op, 3, '#/usage'))
    deliver(frame(op, 4, { phase: 'revert', target_id: 'p3' }))
    await vi.waitFor(() => expect(loc.hash).toBe('#/tasks'))
    const navs = rows().filter((r) => r.kind === 'nav')
    expect(navs.map((r) => r.state)).toEqual(['applied', 'reverted'])
    expect(rows().some((r) => r.kind === 'note' && /Reverted: usage/.test(r.text))).toBe(true)
  })

  it('a look the person KEPT is never reverted silently: it is offered', async () => {
    const op = await ask()
    deliver(frame(op, 2, { phase: 'proposal', proposal: { id: 'pu', kind: 'ui', prefs: { layout: 'dock' }, digest: 'd' } }))
    const ui = rows().find((r) => r.kind === 'ui')!
    await useAskStore.getState().keepUi(ui.id).catch(() => undefined)
    // keepLook needs a client that stores looks; play it kept
    const t = useAskStore.getState().turns[op]
    const o = t.outcomes[2]
    if (o.kind === 'ui') useAskStore.setState({ turns: { ...useAskStore.getState().turns, [op]: { ...t, outcomes: { ...t.outcomes, 2: { ...o, state: 'kept' } } } } })
    deliver(frame(op, 3, { phase: 'revert', target_id: 'pu' }))
    await vi.waitFor(() => expect(rows().some((r) => r.kind === 'revert-offer')).toBe(true))
    expect(rows().find((r) => r.kind === 'ui')!.state).toBe('kept')
  })

  it('memory: a reconnect rebuilds exactly the same thread from GET /api/ask/{op}, steers mid-stream included', async () => {
    const op = await ask()
    deliver(frame(op, 2, { phase: 'thinking', step: 'looking around' }))
    deliver(nav(op, 3, '#/tasks'))
    await useAskStore.getState().steer('slower please', { route: 'goals', experience: 'classic' })
    const sid = useAskStore.getState().turns[op].steers[0].steer_id
    deliver(frame(op, 4, { phase: 'steer', steer_id: sid, text: 'slower please', at_seq: 3 }))
    deliver(nav(op, 5, '#/usage'))
    deliver(frame(op, 6, { phase: 'revert', target_id: 'p5' }))
    await vi.waitFor(() => expect(loc.hash).toBe('#/tasks'))
    deliver(frame(op, 7, { phase: 'answer', text: 'Done; I went back to Goals.' }))
    deliver(frame(op, 8, { phase: 'done', spent_usd: 0.02, turn_spent_usd: 0.02, outcome: 'answered' }))
    const before = JSON.stringify(rows())
    const movesBefore = moved.length
    await useAskStore.getState().rebuild()
    expect(JSON.stringify(rows())).toBe(before)
    expect(moved.length).toBe(movesBefore) // no effect runs twice
    expect(rows().map((r) => r.kind)).toEqual(['you', 'step', 'nav', 'steer', 'nav', 'note', 'answer'])
  })

  it('a steer to a closed turn is a fresh request, never dropped and never an error', async () => {
    const op = await ask()
    deliver(frame(op, 2, { phase: 'done', spent_usd: 0.01, outcome: 'answered' }))
    await useAskStore.getState().steer('one more thing', { route: 'hive', experience: 'classic' })
    expect(Object.keys(useAskStore.getState().turns)).toHaveLength(2)
    expect(rows().filter((r) => r.kind === 'you').map((r) => r.text)).toEqual(['show me around', 'one more thing'])
  })
})

describe('bound to the session and the person', () => {
  it('a store session switch clears the thread, and a late answer from before it never lands', async () => {
    let release!: () => void
    const slow = fakeClient({ ask: vi.fn(() => new Promise((r) => (release = () => r({ operation_id: 'x', turn_id: 't', thread, state: 'accepted' })))) as never })
    await start(slow)
    const p = useAskStore.getState().send('hello there', { route: 'hive', experience: 'classic' })
    expect(rows()).toHaveLength(1)
    useHive.setState({ session: 'another-session', inits: 999 })
    expect(rows()).toHaveLength(0)
    release()
    await p
    expect(useAskStore.getState().thread).toBeNull()
  })

  it('a different person on the same session clears it too', async () => {
    const client = fakeClient()
    await ask('hello there', client)
    useAskStore.getState().bind(useHive.getState().session, 'user:someone_else')
    expect(rows()).toHaveLength(0)
  })

  it('events reach the thread only through the hive store’s session-bound bus', async () => {
    const op = await ask('hello there')
    hiveBus.emit(frame(op, 2, { phase: 'answer', text: 'via the bus' }) as never)
    expect(rows().some((r) => r.text === 'via the bus')).toBe(true)
  })
})

describe('refusals with the host’s details', () => {
  it('ask_busy rejoins the turn already in flight; mind_asleep names the sleeping coordinator', async () => {
    const busy = fakeClient({
      ask: vi.fn(async () => {
        throw new AskRefusal(409, 'ask_busy', 'busy', { operation_id: 'ask:earlier:1' })
      }) as never,
      askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't0', state: 'thinking', text: 'my earlier question', thread, events: [] })) as never,
    })
    await start(busy)
    await useAskStore.getState().send('second', { route: 'hive', experience: 'classic' })
    await vi.waitFor(() => expect(useAskStore.getState().open).toBe('ask:earlier:1'))
    expect(rows().filter((r) => r.kind === 'you').map((r) => r.text)).toEqual(['second', 'my earlier question'])

    const asleep = fakeClient({ ask: vi.fn(async () => { throw new AskRefusal(409, 'mind_asleep', 'asleep', { mind: { id: 'a_altr03', name: 'Altair' } }) }) as never })
    await start(asleep)
    await useAskStore.getState().send('hi', { route: 'hive', experience: 'classic' })
    expect(rows().find((r) => r.kind === 'refused')).toMatchObject({ reason: 'mind_asleep', mind: { id: 'a_altr03' } })
  })
})

describe('the only path to an app act is the DecisionDialog, with the digest of what was shown', () => {
  it('action-needs-confirm opens the confirm; confirming sends exactly the proposal’s id and digest', async () => {
    const client = fakeClient()
    const op = await ask('save a note in design', client)
    deliver(frame(op, 2, { phase: 'action-needs-confirm', proposal: { id: 'p_act', kind: 'app_act', program: 'omegadesign', action: 'save_note', items: [], params: { text: 'hi' }, digest: 'sim:abc', label: 'Save a note in Design' } }))
    expect(useAskStore.getState().confirm?.proposal.id).toBe('p_act')
    expect(await useAskStore.getState().confirmAct()).toBe(true)
    expect(client.askConfirm).toHaveBeenCalledWith(op, 'p_act', 'sim:abc')
    expect(rows().find((r) => r.kind === 'confirm')!.state).toBe('confirmed')
  })
  it('Review B1 (commons f0818d8): a confirm whose answer was lost is unsettled, never "Nothing changed"; a refusal still is', async () => {
    const { OUTCOME_UNKNOWN, decisionShown, NOTHING_CHANGED } = await import('../lib/decisionGate')
    const proposal = { id: 'p_act', kind: 'app_act', program: 'omegadesign', action: 'save_note', items: [], params: {}, digest: 'd', label: 'Save a note' }
    const lost = fakeClient({ askConfirm: vi.fn(async () => { throw new (await import('../api/client')).ApiError(0, 'network', 'Failed to fetch') }) as never })
    const op = await ask('save a note in design', lost)
    deliver(frame(op, 2, { phase: 'action-needs-confirm', proposal }))
    const r = await useAskStore.getState().confirmAct()
    expect(r).toEqual({ unsettled: OUTCOME_UNKNOWN })
    expect(JSON.stringify(decisionShown(r))).not.toContain(NOTHING_CHANGED)
    const refused = fakeClient({ askConfirm: vi.fn(async () => { throw new (await import('../api/client')).ApiError(403, 'not_allowed', 'no') }) as never })
    const op2 = await ask('save a note in design', refused)
    deliver(frame(op2, 2, { phase: 'action-needs-confirm', proposal }))
    expect(await useAskStore.getState().confirmAct()).toBe('You are not allowed to do that here.')
  })
  it('declining does nothing but record it', async () => {
    const client = fakeClient()
    const op = await ask('save a note in design', client)
    deliver(frame(op, 2, { phase: 'action-needs-confirm', proposal: { id: 'p_act', kind: 'app_act', program: 'omegadesign', action: 'save_note', items: [], params: {}, digest: 'd', label: 'Save a note' } }))
    useAskStore.getState().declineAct()
    expect(client.askConfirm).not.toHaveBeenCalled()
    expect(rows().find((r) => r.kind === 'confirm')!.state).toBe('declined')
  })
})

describe('the request on the wire matches the built host (platform/ask-p1 6100794)', () => {
  it('exact keys: operation_id, text, context, via; the addressed mind goes as context.mind; no `to`', async () => {
    await start(fakeClient())
    await useAskStore.getState().send('what is Vega doing', { route: 'hive', experience: 'classic', mind: 'a_vega01' })
    const b = sent[0] as Record<string, unknown>
    expect(Object.keys(b).sort()).toEqual(['context', 'operation_id', 'text', 'via'])
    expect(b.operation_id).toMatch(OP_RE)
    expect((b.context as { mind?: string }).mind).toBe('a_vega01')
    expect(parse('#/usage').name).toBe('usage')
  })
})

describe('host corrections at c63a53f', () => {
  it('truncated thinking is said once, quietly, however many trimmed frames arrive', async () => {
    const op = await ask('hello there')
    deliver(frame(op, 2, { phase: 'thinking', step: 'reading' }))
    deliver(frame(op, 3, { phase: 'thinking', step: '', truncated: true }))
    deliver(frame(op, 4, { phase: 'thinking', step: '', truncated: true }))
    expect(rows().filter((r) => r.text === '…more steps not shown')).toHaveLength(1)
    expect(rows().filter((r) => r.kind === 'step').map((r) => r.text)).toEqual(['reading'])
  })

  it('coordinator_busy: a plain sentence and a Try again the person presses; never an automatic retry loop', async () => {
    const busy = fakeClient({ ask: vi.fn(async () => { throw new AskRefusal(409, 'coordinator_busy', 'host text') }) as never })
    await start(busy)
    await useAskStore.getState().send('hi', { route: 'hive', experience: 'classic' })
    await new Promise((r) => setTimeout(r, 50))
    expect(busy.ask).toHaveBeenCalledTimes(1)
    const r = rows().find((x) => x.kind === 'refused')!
    expect(REFUSAL_WORDS[r.reason!].say).toBe('The coordinator is working for someone else; try again shortly.')
    expect(REFUSAL_WORDS[r.reason!].offer?.map((o) => o.kind)).toEqual(['retry'])
    expect(REFUSAL_WORDS.payer_conflict.say).toMatch(/Someone else/)
  })

  it('ask frames are only ever the asker’s own: a frame for a turn this page did not start is ignored (no admin fan-out)', async () => {
    const op = await ask('hello there')
    deliver({ type: 'ask', operation_id: 'ask:someone-else:1', turn_id: 'tx', principal: 'user:other', seq: 1, phase: 'answer', text: 'not yours' } as unknown as AskEvent)
    expect(JSON.stringify(rows())).not.toContain('not yours')
    expect(useAskStore.getState().turns[op].lastSeq).toBe(1)
  })
})
