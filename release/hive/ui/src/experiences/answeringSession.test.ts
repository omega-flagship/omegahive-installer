import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../api/sim/SimClient'
import type { Approval } from '../api/types'
import { approvalBound, approvalSeenOf } from '../lib/approvalDecision'
import { useHive } from '../store/store'
import { useCosmos } from './cosmos/state'
import { useC } from './construct/state'

/**
 * Surface O (O-B1 follow-up): Cosmos and Construct take the session an approval request was answered under at the
 * press, next to `answering`, and hand it to ApprovalDecision as `session=` (as Flux does since 694ca95). A client
 * switch between the press and the dialog opening must not move the answer into the new session: the dialog binds
 * the press's session, so the shared binding and the store refuse it. Two real SimClients, real init, invented data.
 */

const sim = (seed: number) => new SimClient({ seed, latency: false, autoStart: false, historyDays: 1 })
const clients: SimClient[] = []

async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}

/** The two experiences' answer stores, through the same two fields. */
const STORES = {
  cosmos: { answer: (a: Approval | null, s?: string) => useCosmos.getState().answer(a, s), read: () => ({ ap: useCosmos.getState().answering, session: useCosmos.getState().answeringSession }) },
  construct: { answer: (a: Approval | null, s?: string) => useC.getState().answer(a, s), read: () => ({ ap: useC.getState().answering, session: useC.getState().answeringSession }) },
}

beforeEach(() => vi.stubGlobal('window', { location: { search: '' } }))
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect()
  useCosmos.getState().answer(null)
  useC.getState().answer(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function underA() {
  const a = sim(21)
  const b = sim(22)
  clients.push(a, b)
  await useHive.getState().init(a)
  const sample = Object.values(useHive.getState().approvals).find((x) => x.status === 'pending') ?? Object.values(useHive.getState().approvals)[0]
  const pendingA: Approval = { ...sample, status: 'pending' }
  // B holds the very same record (reused id, identical inspected fields): only the session tells them apart
  vi.spyOn(b, 'listApprovals').mockResolvedValue([pendingA])
  return { a, b, pendingA, sessionA: useHive.getState().session }
}

describe.each(Object.entries(STORES))('%s: the answering session is stamped at the press', (_name, store) => {
  it('keeps the session the caller stamped, through a client switch before the dialog opens', async () => {
    const { b, pendingA, sessionA } = await underA()
    store.answer(pendingA, sessionA)
    const approveB = vi.spyOn(b, 'approve')
    await useHive.getState().init(b)
    const s = useHive.getState()
    expect(s.session).not.toBe(sessionA)
    const { ap, session } = store.read()
    expect(session).toBe(sessionA)
    // what ApprovalDecision binds with session= (the press's session): refused, nothing reaches B
    const seen = { ...approvalSeenOf(ap!), session: session! }
    expect(approvalBound(seen, s.approvals[pendingA.id]).kind).toBe('closed')
    expect(await s.decide(pendingA.id, 'approve', undefined, seen.session)).toBeNull()
    expect(approveB).not.toHaveBeenCalled()
    // the defect this closes: stamped when the dialog opens (after the switch), the same request would be answerable in B
    expect(approvalBound(approvalSeenOf(ap!), s.approvals[pendingA.id]).kind).toBe('ready')
  })

  it('with no session given, stamps the store session at the press, not a later one', async () => {
    const { b, pendingA, sessionA } = await underA()
    store.answer(pendingA)
    expect(store.read().session).toBe(sessionA)
    await useHive.getState().init(b)
    expect(store.read().session).toBe(sessionA)
  })

  it('closing clears the request and its session together', async () => {
    const { pendingA, sessionA } = await underA()
    store.answer(pendingA, sessionA)
    store.answer(null)
    expect(store.read()).toEqual({ ap: null, session: null })
  })
})

describe('the openers and hosts pass the press session through', () => {
  it('Cosmos and Construct host ApprovalDecision with session= from the stamp', async () => {
    for (const f of ['./cosmos/index.tsx', './construct/index.tsx']) {
      const text = await source(f)
      expect(text, f).toMatch(/<ApprovalDecision[^>]*session=\{answeringSession \?\? undefined\}/)
    }
  })

  it('every press that opens the dialog passes the session it was shown under', async () => {
    const opens: [string, RegExp][] = [
      ['./cosmos/Panels.tsx', /answer\(a, session\)/],
      ['./construct/Panes.tsx', /answer\(ap, session\)/],
      ['./construct/index.tsx', /answer\(ap, h\.session\)/],
    ]
    for (const [f, re] of opens) {
      const text = await source(f)
      expect(text, f).toMatch(re)
      // no opener left that answers without a session (closing with null is fine)
      expect(text, f).not.toMatch(/\banswer\((?!null\))[^,()]+\)/)
    }
  })
})
