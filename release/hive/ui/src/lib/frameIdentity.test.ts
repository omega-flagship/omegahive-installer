import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * studio-host-seam r1 (Surface P2, SURFACE_DESIGN_DRAFT_DELETE_REVIEW_20261008 finding 3): an app frame's host-bridge
 * operation belongs to the identity it was asked under. When the signed-in person changes WITHOUT a new hive client
 * (a re-login on the same tab), a pending draft delete/save or act must not complete or post as the new person, and
 * the frame is told the outcome is unknown ('unavailable', never act_not_sent), never that it succeeded.
 * The REAL store identity change (identityEpoch testkit), synthetic SimClients and invented drafts only. No hive.
 */
const mem = new Map<string, string>()
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) }
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

const { bindEpoch } = await import('./identityEpoch')
const { bindFrameRequest, frameRefusal, actFileRefused } = await import('./frameOps')
const { FrameAssetGrants, studioDispatcher } = await import('./studioBridge')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('./identityEpoch.testkit')
type EpochBinding = import('./identityEpoch').EpochBinding
type StudioClient = import('./studioBridge').StudioEnv['client']

afterEach(() => releasePersons())

function gate() {
  let release!: () => void
  const p = new Promise<void>((r) => (release = r))
  return { p, release: () => release() }
}

/** A studio client whose writes wait on a gate, recording each call (who was asked, and when). */
function heldStudio() {
  const calls: string[] = []
  const g = gate()
  const client = {
    putAppDraft: async (_p: string, key: string, b: { expected_revision: number | null }) => {
      calls.push(`put:${key}`)
      await g.p
      return { draft_key: key, revision: (b.expected_revision ?? 0) + 1, saved_at: '2026-10-08T00:00:00Z' }
    },
    deleteAppDraft: async (_p: string, key: string) => {
      calls.push(`delete:${key}`)
      await g.p
      return { deleted: key }
    },
    listAppDrafts: async () => ({ drafts: [] }),
    getAppDraft: async () => { throw new Error('unused') },
    assetBlob: async () => { throw new Error('unused') },
  } as unknown as StudioClient
  return { client, calls, release: g.release }
}

/** AppFrame's receive path for a slice-2 message, as wired there: bind on receipt, refuse if not admitted, settle on post. */
async function receive(doc: EpochBinding, data: object, studio: ReturnType<typeof studioDispatcher>, posted: object[]) {
  const req = bindFrameRequest(doc, bindEpoch(), data)
  const reply = (value: object) => {
    const out = req.settle(value)
    if (out) posted.push(out)
  }
  if (!req.admitted) return reply({})
  const out = await studio(data)
  if (out) reply(out.reply)
}

const del = { type: 'draft-delete', id: 'd1', draft_key: 'deck-1' }
const save = { type: 'draft-save', id: 's1', draft_key: 'deck-1', expected_revision: null, body: { title: 'invented' } }

describe('a pending app-frame operation never completes as the next person (same client, re-login)', () => {
  it('a draft delete pending when A becomes B: the frame hears unknown, never draft-deleted', async () => {
    const a = testPerson('a'), b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const doc = bindEpoch()   // the document was loaded for A
    const h = heldStudio()
    const studio = studioDispatcher({ client: h.client, programId: 'studio', swarmId: 's_x', draftSave: () => true, grants: new FrameAssetGrants() })
    const posted: object[] = []
    const pending = receive(doc, del, studio, posted)
    await Promise.resolve()
    expect(h.calls).toEqual(['delete:deck-1'])   // sent as A, before the change
    const { before, after } = await switchPerson(a, b)
    expect(after).toBeGreaterThan(before)
    h.release()
    await pending
    expect(posted).toEqual([{ type: 'draft-refused', id: 'd1', op: 'delete', reason: 'unavailable' }])
    expect(JSON.stringify(posted)).not.toMatch(/draft-deleted|act_not_sent/)
  })

  it('a draft save pending when A becomes B: unknown, never draft-saved', async () => {
    const a = testPerson('a'), b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const doc = bindEpoch()
    const h = heldStudio()
    const studio = studioDispatcher({ client: h.client, programId: 'studio', swarmId: 's_x', draftSave: () => true, grants: new FrameAssetGrants() })
    const posted: object[] = []
    const pending = receive(doc, save, studio, posted)
    await Promise.resolve()
    await switchPerson(a, b)
    h.release()
    await pending
    expect(posted).toEqual([{ type: 'draft-refused', id: 's1', op: 'save', reason: 'unavailable' }])
  })

  it('a delete asked by A\'s document after the change is never sent as B: no call, the frame hears unknown', async () => {
    const a = testPerson('a'), b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const doc = bindEpoch()
    await switchPerson(a, b)   // Studio's confirm ticket was opened under A; the click lands after the re-login
    const h = heldStudio()
    const studio = studioDispatcher({ client: h.client, programId: 'studio', swarmId: 's_x', draftSave: () => true, grants: new FrameAssetGrants() })
    const posted: object[] = []
    await receive(doc, del, studio, posted)
    expect(h.calls).toEqual([])   // nothing reached the hive as B
    expect(posted).toEqual([{ type: 'draft-refused', id: 'd1', op: 'delete', reason: 'unavailable' }])
  })

  it('an act answered after the change: app-reply unknown, never its result and never act_not_sent', async () => {
    const a = testPerson('a'), b = testPerson('b', { sameTab: a })
    await signInAs(a)
    const doc = bindEpoch()
    const msg = { type: 'app-request', id: 'r1', op: 'act', body: { action: 'save' } }
    const req = bindFrameRequest(doc, bindEpoch(), msg)
    expect(req.admitted).toBe(true)
    await switchPerson(a, b)
    expect(req.settle({ type: 'app-reply', id: 'r1', ok: true, result: { status: 'done' } })).toEqual({ type: 'app-reply', id: 'r1', ok: false, error: 'unavailable', reason: 'unavailable' })
    // even a host-certified not-sent refusal is told as unknown once the person changed (the frame is being replaced)
    expect(req.settle(actFileRefused('r1', 'unavailable', true))).not.toHaveProperty('act_not_sent')
  })

  it('while the person is unchanged, every answer passes through exactly as before', async () => {
    const a = testPerson('a')
    await signInAs(a)
    const doc = bindEpoch()
    const h = heldStudio()
    const studio = studioDispatcher({ client: h.client, programId: 'studio', swarmId: 's_x', draftSave: () => true, grants: new FrameAssetGrants() })
    const posted: object[] = []
    const pending = receive(doc, del, studio, posted)
    h.release()
    await pending
    expect(posted).toEqual([{ type: 'draft-deleted', id: 'd1', draft_key: 'deck-1' }])
    const reply = { type: 'app-reply', id: 'r2', ok: true, result: {} }
    expect(bindFrameRequest(doc, bindEpoch(), { type: 'app-request', id: 'r2', op: 'view' }).settle(reply)).toBe(reply)
  })
})

describe('frameRefusal (the bucket refusal, moved from AppFrame, plus the unknown answer)', () => {
  it('rate-limited answers are exactly the old bucket replies', () => {
    expect(frameRefusal({ type: 'read', id: 'q' }, 'rate-limited')).toEqual({ type: 'read-refused', id: 'q', reason: 'rate-limited' })
    expect(frameRefusal({ type: 'open-url', id: 'q' }, 'rate-limited')).toEqual({ type: 'url-refused', id: 'q', reason: 'rate-limited' })
    expect(frameRefusal({ type: 'show-file', id: 'q' }, 'rate-limited')).toEqual({ type: 'file-refused', id: 'q', reason: 'rate-limited' })
    expect(frameRefusal({ type: 'pick', id: 'q' }, 'rate-limited')).toEqual({ type: 'picked', id: 'q', cancelled: true, reason: 'rate-limited' })
    expect(frameRefusal({ type: 'app-request', id: 'q' }, 'rate-limited')).toEqual({ type: 'app-reply', id: 'q', ok: false, error: 'rate-limited', reason: 'rate-limited' })
    expect(frameRefusal({ type: 'subscribe', goal_id: 'g' }, 'rate-limited')).toEqual({ type: 'goal.refused', goal_id: 'g', reason: 'rate-limited' })
    expect(frameRefusal(del, 'rate-limited')).toEqual({ type: 'draft-refused', id: 'd1', op: 'delete', reason: 'rate-limited' })
    expect(frameRefusal({ type: 'app-ready' }, 'rate-limited')).toBeNull()
  })

  it('unknown answers: unavailable where the reply type has it, else dropped; never a success or act_not_sent', () => {
    expect(frameRefusal(save, 'unavailable')).toEqual({ type: 'draft-refused', id: 's1', op: 'save', reason: 'unavailable' })
    expect(frameRefusal({ type: 'asset-bytes', id: 'x', handle: 'asset:a_1' }, 'unavailable')).toMatchObject({ type: 'asset-refused', id: 'x', reason: 'unavailable' })
    expect(frameRefusal({ type: 'read', id: 'q' }, 'unavailable')).toEqual({ type: 'read-refused', id: 'q', reason: 'unavailable' })
    expect(frameRefusal({ ...del, extra: 1 }, 'unavailable')).toEqual({ type: 'draft-refused', id: 'd1', op: 'delete', reason: 'unavailable' })   // even one that fails validation
    expect(frameRefusal({ type: 'open-url', id: 'q' }, 'unavailable')).toBeNull()
    expect(frameRefusal({ type: 'show-file', id: 'q' }, 'unavailable')).toBeNull()
    expect(frameRefusal({ type: 'subscribe', goal_id: 'g' }, 'unavailable')).toBeNull()
    expect(frameRefusal({ type: 'app-ready' }, 'unavailable')).toBeNull()
  })
})

describe('AppFrame wires the binding (source check)', () => {
  it('every frame message is bound on receipt, before any await, and the document follows the identity epoch', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: string) => string }
    const src = fs.readFileSync(new URL('../features/programs/AppFrame.tsx', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('const receive = async (event: MessageEvent) => {'), src.indexOf("window.addEventListener('message', receive)"))
    const bind = body.indexOf('const req = bindFrameRequest(docBinding, bindEpoch(), event.data)')
    expect(bind).toBeGreaterThan(0)
    expect(bind).toBeLessThan(body.indexOf('await'))
    expect(body.indexOf('if (!req.admitted) return reply({})')).toBeGreaterThan(bind)
    expect(body.indexOf('if (!req.admitted)')).toBeLessThan(body.indexOf('await studio(event.data)'))
    expect(body).toMatch(/const out = req\.settle\(value\)/)
    expect(body).not.toMatch(/postMessage/)   // the frame is only ever posted to through send (req.settle) or notify (docBinding)
    expect(body.match(/settleAct\([^)]*\)/g)).toEqual(['settleAct(m.id, admitted.asked, reply)'])
    expect(src).toMatch(/\}, \[client, programId, identity\]\)/)        // a new document for a new identity
    expect(src).toMatch(/\}, \[client, identity\]\)/)                    // the person in `context` is re-read too
    expect(src).toMatch(/const notify = \(value: object, transfer: Transferable\[\] = \[\]\) => void docBinding\.commit\(\(\) => send\(value, transfer\)\)/)
    expect(src).toMatch(/post\.current = notify/)
  })
})
