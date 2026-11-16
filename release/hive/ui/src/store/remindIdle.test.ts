import { describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../api/client'
import { useHive } from './store'

// INVENTED mind. The store's Remind: the shapes' refusals as plain words, anything else thrown, nothing for a moved-on session.
// r1.3: the store reads the host's may_remind fresh (GET /api/agents/{id}) before sending
const getAgent = async (id: string) => ({ id, name: 'Lyra', status: 'awake', may_remind: true, may_sleep: true })
const withClient = (remindIdle: (id: string) => Promise<unknown>) => useHive.setState({ client: { remindIdle, getAgent } as unknown as HiveClient, session: 's1', remindedAt: {} })

describe('store.remindIdle', () => {
  it('asks, or says the refusal plainly', async () => {
    withClient(async () => ({}))
    expect(await useHive.getState().remindIdle('a_1', 'Lyra')).toMatchObject({ ok: true })
    withClient(async () => { throw new ApiError(409, 'not_awake', 'x') })
    expect(await useHive.getState().remindIdle('a_1', 'Lyra')).toEqual({ ok: false, text: 'Lyra is not awake, so Health did not ask. Health only asks awake minds and never wakes one.' })
    withClient(async () => { throw new TypeError('network') })
    await expect(useHive.getState().remindIdle('a_1', 'Lyra')).rejects.toThrow('network')
  })

  it('a session that moved on hears nothing', async () => {
    let release: (() => void) | undefined
    withClient(() => new Promise((r) => (release = () => r({}))))
    const job = useHive.getState().remindIdle('a_1', 'Lyra')
    // the Remind goes out once the fresh read says yes (r1.3); the session moves while it is in flight
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    useHive.setState({ session: 's2' })
    release!()
    expect(await job).toBeNull()
  })
})
