import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARM_MS } from '../../lib/decisionGate'
import type { Goal } from '../../api/types'
import { useHive } from '../../store/store'
import { run } from './commands'
import { useC } from './state'

// Review D1: Construct's `goal done|failed|cancel|reopen` previews the goal, and `yes` dispatches only while the goal is
// still exactly what was previewed (status, holder, swarm, title, version), not merely while it exists.
const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g_sheliak', swarm_id: 's_lyra', parent_id: null, title: 'Book telescope time for the Sheliak eclipse', detail: '', priority: 0.5,
  status: 'stalled', created_by: 'user:operator', claimed_by: 'agent:a_vega01', result: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-05T09:00:00Z', ...over,
})
const writes: { id: string; body: unknown }[] = []
const lastLine = () => useC.getState().console.slice(-3).map((l) => l.segs.map((s) => s.t).join('')).join('\n')

// a controllable clock: `yes` counts only after the preview has been on screen for the arming window (Surface O)
let clock = 1_000_000
const read = async () => {
  clock += ARM_MS + 50
}
afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  writes.length = 0
  const client = { patchGoal: async (id: string, body: Partial<Goal>) => (writes.push({ id, body }), { ...useHive.getState().goals[id], ...body, updated_at: 'later' }) }
  useHive.setState({ client: client as never, goals: { g_sheliak: goal() }, swarms: {}, agents: {} })
})

describe('Review D1: Construct goal confirm rechecks drift, not only existence', () => {
  it('a status change between preview and yes refuses; nothing is written', async () => {
    await run('goal cancel 1')
    expect(lastLine()).toMatch(/yes.*to go ahead/)
    useHive.setState({ goals: { g_sheliak: goal({ status: 'claimed', updated_at: '2026-10-05T09:02:00Z' }) } })
    await read()
    await run('yes')
    expect(writes).toHaveLength(0)
    expect(lastLine()).toMatch(/changed while it was open \(status, version\)/)
  })

  it('a holder change refuses', async () => {
    await run('goal cancel 1')
    useHive.setState({ goals: { g_sheliak: goal({ claimed_by: 'agent:a_other' }) } })
    await read()
    await run('yes')
    expect(writes).toHaveLength(0)
  })

  it('a version-only change refuses', async () => {
    await run('goal done 1')
    useHive.setState({ goals: { g_sheliak: goal({ updated_at: '2026-10-05T09:05:00Z' }) } })
    await read()
    await run('yes')
    expect(writes).toHaveLength(0)
  })

  it('an unchanged goal is changed once, as previewed', async () => {
    await run('goal cancel 1')
    await read()
    await run('yes')
    expect(writes).toEqual([{ id: 'g_sheliak', body: { status: 'cancelled' } }])
    await run('yes') // nothing is awaiting any more
    expect(writes).toHaveLength(1)
  })

  it('yes is stamped with the session the goal was previewed under (Kimi #2, next22)', async () => {
    await run('goal cancel 1')
    // the store's session moves on (a reconnect): the previewed goal's write is refused, nothing is sent
    useHive.setState({ session: `${useHive.getState().session}-later` })
    await read() // past the arming window (Surface O), so the refusal is the session's
    await run('yes')
    expect(writes).toHaveLength(0)
    // the runtime refusal is the session's own words (next28 Review), not another refusal that also writes nothing
    expect(lastLine()).toMatch(/opened under an earlier connection to the hive\. Nothing was decided here\./)
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: string) => string }
    expect(fs.readFileSync(new URL('./commands.ts', import.meta.url), 'utf8')).toMatch(/writeGoal\(id, \{ status: to \}, seen\.session\)/)
  })

  it('a yes inside the arming window is refused and the preview stays; a later yes goes (Surface O)', async () => {
    await run('goal cancel 1')
    await run('yes')
    expect(writes).toHaveLength(0)
    expect(lastLine()).toMatch(/just appeared; read it, then yes/)
    await read()
    await run('yes')
    expect(writes).toEqual([{ id: 'g_sheliak', body: { status: 'cancelled' } }])
  })

  it('a yes after the hive client changed (another session) refuses; nothing is written (Surface O)', async () => {
    await run('goal cancel 1')
    useHive.setState({ client: { patchGoal: async () => (writes.push({ id: 'other', body: null }), goal()) } as never })
    await read()
    await run('yes')
    expect(writes).toHaveLength(0)
    expect(lastLine()).toMatch(/previewed for another session/)
  })

  it('a lost answer is never "is still …": applied → ✓ after the re-read; unapplied → "could not confirm … unchanged" (Review B1, next22)', async () => {
    const applied = { ...goal(), status: 'done' as const, updated_at: '2026-10-05T09:10:00Z' }
    const lose = (onHive: Goal) => {
      useHive.setState({
        client: { patchGoal: async (id: string, body: unknown) => { writes.push({ id, body }); throw new TypeError('Failed to fetch') }, getGoal: async () => onHive } as never,
        goals: { g_sheliak: goal() },
        goalsUnsure: {},
      })
    }
    lose(applied)
    await run('goal done 1')
    await read()
    await run('yes')
    expect(writes).toHaveLength(1)
    expect(lastLine()).toMatch(/✓ “Book telescope time for the Sheliak eclipse” is done.*read again, the change is there/)
    expect(lastLine()).not.toMatch(/is still/)
    lose(goal())
    await run('goal done 1')
    await read()
    await run('yes')
    expect(writes).toHaveLength(2)
    expect(lastLine()).toMatch(/\? “Book telescope time for the Sheliak eclipse” We could not confirm whether this happened\. The task was read again and is unchanged/)
    expect(lastLine()).not.toMatch(/is still/)
  })

  it('yes and no are never recorded in history, so a recalled yes cannot land on a fresh preview (Surface O)', async () => {
    await run('goal cancel 1')
    await read()
    await run('yes')
    expect(useC.getState().history).not.toContain('yes')
  })
})
