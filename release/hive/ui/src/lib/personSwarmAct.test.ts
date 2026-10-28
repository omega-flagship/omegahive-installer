import { describe, expect, it, vi } from 'vitest'
import type { ActionResult } from '../api/types'
import { personStartedProgramAct, registerPersonSwarmHost } from './personSwarmAct'

const sent = { swarm_id: 's', action: 'person-started', items: [] }
const result: ActionResult = { status: 'refused', message: 'Existing body' }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

describe('host-only act hint is advisory and bound to the opening generation', () => {
  it('does not infer a hint from app result JSON when the host transport is unavailable', async () => {
    const client = { programAct: vi.fn(async () => ({ ...result, detail: { consent_required: true } })) }
    const onHint = vi.fn()
    const off = registerPersonSwarmHost({ client, program: 'p', swarm: 's', current: () => true, consentRequired: onHint })
    const body = await personStartedProgramAct(client, 'p', sent, () => true)
    expect(body.detail).toEqual({ consent_required: true })
    expect(onHint).not.toHaveBeenCalled()
    off()
  })
  it('delivers the header hint to the matching current host while returning the identical body object', async () => {
    const client = { programAct: vi.fn(async () => result), hostProgramAct: vi.fn(async () => ({ result, personSwarmConsentRequired: true })) }
    const onHint = vi.fn()
    const off = registerPersonSwarmHost({ client, program: 'p', swarm: 's', current: () => true, consentRequired: onHint })
    expect(await personStartedProgramAct(client, 'p', sent, () => true)).toBe(result)
    expect(onHint).toHaveBeenCalledTimes(1)
    off()
  })
  it('a late result cannot open a new A after the old A unmounted', async () => {
    const pending = deferred<{ result: ActionResult; personSwarmConsentRequired: boolean }>()
    const client = { programAct: vi.fn(async () => result), hostProgramAct: vi.fn(() => pending.promise) }
    const oldHint = vi.fn(), newHint = vi.fn()
    const oldOff = registerPersonSwarmHost({ client, program: 'p', swarm: 's', current: () => true, consentRequired: oldHint })
    const act = personStartedProgramAct(client, 'p', sent, () => true)
    oldOff()
    const newOff = registerPersonSwarmHost({ client, program: 'p', swarm: 's', current: () => true, consentRequired: newHint })
    pending.resolve({ result, personSwarmConsentRequired: true })
    await act
    expect(oldHint).not.toHaveBeenCalled()
    expect(newHint).not.toHaveBeenCalled()
    newOff()
  })
  it('identity/act cancellation or another program/swarm prevents the hint', async () => {
    const client = { programAct: vi.fn(async () => result), hostProgramAct: vi.fn(async () => ({ result, personSwarmConsentRequired: true })) }
    const onHint = vi.fn()
    const off = registerPersonSwarmHost({ client, program: 'p', swarm: 's', current: () => true, consentRequired: onHint })
    await expect(personStartedProgramAct(client, 'p', sent, () => false)).rejects.toThrow('no longer current')
    expect(client.hostProgramAct).not.toHaveBeenCalled()
    await personStartedProgramAct(client, 'other', sent, () => true)
    await personStartedProgramAct(client, 'p', { ...sent, swarm_id: 'other' }, () => true)
    expect(onHint).not.toHaveBeenCalled()
    off()
  })
})
