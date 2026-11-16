import { describe, expect, it } from 'vitest'
import { FrameAssetGrants, studioDispatcher, studioReply, type StudioEnv, type StudioRequest } from './studioBridge'

// Review F1 (SURFACE_F_e4c0220 verdict): one save or delete per draft key in flight per frame, enforced across separate
// message events through the frame dispatcher; refusal is `busy`, never a queue that re-bases onto newer content.

const CH = '00000000-0000-4000-8000-000000000000'

function gate() {
  let release!: () => void
  let fail!: (e: unknown) => void
  const p = new Promise<void>((res, rej) => { release = res; fail = rej })
  return { p, release: () => release(), fail: (e: unknown) => fail(e) }
}

function delayedClient() {
  const calls: { op: string; key: string; rev: number | null; body?: unknown }[] = []
  const gates: ReturnType<typeof gate>[] = []
  const client: StudioEnv['client'] = {
    putAppDraft: async (_p, key, b) => {
      calls.push({ op: 'put', key, rev: b.expected_revision, body: b.body })
      const g = gate()
      gates.push(g)
      await g.p
      return { draft_key: key, revision: (b.expected_revision ?? 0) + 1, saved_at: '2026-10-05T00:00:00Z' }
    },
    deleteAppDraft: async (_p, key) => {
      calls.push({ op: 'delete', key, rev: null })
      const g = gate()
      gates.push(g)
      await g.p
      return { deleted: key }
    },
    listAppDrafts: async () => ({ drafts: [] }),
    getAppDraft: async () => { throw new Error('unused') },
    assetBlob: async () => { throw new Error('unused') },
  } as StudioEnv['client']
  return { client, calls, gates }
}

const save = (id: string, key = 'main', rev: number | null = null, text = id) =>
  ({ type: 'draft-save', channel: CH, id, draft_key: key, expected_revision: rev, body: { text } })

function dispatcher(client: StudioEnv['client'], grants = new FrameAssetGrants()) {
  return { grants, send: studioDispatcher({ client, programId: 'fixture', swarmId: 's_fixture', draftSave: () => true, grants }) }
}

describe('Review F1: per-frame, per-key write guard through the dispatcher', () => {
  it('a second same-key save while the first is unresolved is refused busy and never reaches the client', async () => {
    const { client, calls, gates } = delayedClient()
    const { send } = dispatcher(client)
    const one = send(save('one'))
    const two = await send(save('two', 'main', null, 'later'))
    expect(calls).toHaveLength(1)
    expect(two?.reply).toMatchObject({ type: 'draft-refused', id: 'two', op: 'save', reason: 'busy' })
    gates[0].release()
    expect((await one)?.reply).toMatchObject({ type: 'draft-saved', id: 'one', revision: 1 })
    // the first save's body and expected revision were sent as given (nothing re-based)
    expect(calls[0]).toMatchObject({ op: 'put', key: 'main', rev: null, body: { text: 'one' } })
  })

  it('the key is usable again after the save answers, with the frame choosing the next revision', async () => {
    const { client, calls, gates } = delayedClient()
    const { send } = dispatcher(client)
    const one = send(save('one'))
    gates[0].release()
    await one
    const again = send(save('again', 'main', 1))
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ rev: 1 })
    gates[1].release()
    expect((await again)?.reply).toMatchObject({ type: 'draft-saved', revision: 2 })
  })

  it('a failed save releases the key (finally), and the failure is reported, not swallowed', async () => {
    const { client, calls, gates } = delayedClient()
    const { send, grants } = dispatcher(client)
    const one = send(save('one'))
    gates[0].fail(Object.assign(new Error('boom'), { status: 500 }))
    expect((await one)?.reply).toMatchObject({ type: 'draft-refused', id: 'one', reason: 'unavailable' })
    expect(grants.writing.size).toBe(0)
    const next = send(save('next'))
    expect(calls).toHaveLength(2)
    gates[1].release()
    await next
  })

  it('different keys stay independent while one key is busy', async () => {
    const { client, calls, gates } = delayedClient()
    const { send } = dispatcher(client)
    const a = send(save('a', 'alpha'))
    const b = send(save('b', 'beta'))
    expect(calls.map((c) => c.key)).toEqual(['alpha', 'beta'])
    gates.forEach((g) => g.release())
    expect((await a)?.reply).toMatchObject({ type: 'draft-saved', draft_key: 'alpha' })
    expect((await b)?.reply).toMatchObject({ type: 'draft-saved', draft_key: 'beta' })
  })

  it('a delete on a key with a save in flight is refused busy (and the other way round)', async () => {
    const { client, calls, gates } = delayedClient()
    const { send } = dispatcher(client)
    const one = send(save('one'))
    const del = await send({ type: 'draft-delete', channel: CH, id: 'del', draft_key: 'main' })
    expect(del?.reply).toMatchObject({ type: 'draft-refused', op: 'delete', reason: 'busy' })
    gates[0].release()
    await one
    const del2 = send({ type: 'draft-delete', channel: CH, id: 'del2', draft_key: 'main' })
    const blocked = await send(save('during-delete'))
    expect(blocked?.reply).toMatchObject({ reason: 'busy' })
    expect(calls.map((c) => c.op)).toEqual(['put', 'delete'])
    gates[1].release()
    await del2
  })

  it('a new frame document (new grants) is not blocked by an old frame\'s unresolved save, and the old answer cannot touch it', async () => {
    const { client, calls, gates } = delayedClient()
    const old = dispatcher(client)
    const pending = old.send(save('old'))
    const fresh = dispatcher(client) // AppFrame makes new grants per document (reload/dispose)
    const now = fresh.send(save('fresh'))
    expect(calls).toHaveLength(2)
    gates[0].release()
    await pending
    expect(fresh.grants.writing.has('main')).toBe(true) // the old frame's completion released only its own key
    gates[1].release()
    await now
    expect(fresh.grants.writing.size).toBe(0)
  })

  it('reads (list/load) are never blocked by a write in flight', async () => {
    const { client, gates } = delayedClient()
    const { send } = dispatcher(client)
    const one = send(save('one'))
    const list = await send({ type: 'draft-list', channel: CH, id: 'ls' })
    expect(list?.reply).toMatchObject({ type: 'drafts', id: 'ls' })
    gates[0].release()
    await one
  })

  it('Review probe, verbatim shape: two same-key studioReply calls on one env start one client call', async () => {
    let calls = 0
    const g = gate()
    const env: StudioEnv = {
      programId: 'fixture', swarmId: 's_fixture', draftSave: true, grants: new FrameAssetGrants(),
      client: {
        putAppDraft: async (_p, k) => { calls++; await g.p; return { draft_key: k, revision: calls, saved_at: '2026-10-05T00:00:00Z' } },
        listAppDrafts: async () => ({ drafts: [] }), getAppDraft: async () => { throw Error('unused') }, deleteAppDraft: async () => ({ deleted: 'x' }),
      } as StudioEnv['client'],
    }
    const msg: StudioRequest = { type: 'draft-save', id: 'one', draft_key: 'main', expected_revision: null, body: { text: 'first' }, source_ref: null }
    const one = studioReply(msg, env)
    const two = studioReply({ ...msg, id: 'two', body: { text: 'later' } }, env)
    const observed = calls
    g.release()
    await Promise.all([one, two])
    expect(observed).toBe(1)
  })
})
