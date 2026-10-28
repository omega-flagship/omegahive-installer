import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import { useHive } from '../../store/store'
import { INITIAL, screenOf } from './machine'
import { powerMenuItems } from './menu'
import { installPower, usePower } from './store'

/** The whole page path against the simulator (invented data): the power store, the gated client and the hive store. */
const fresh = () => new SimClient({ seed: 11, latency: false, autoStart: false, historyDays: 1 })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { location: { search: '' } })
  usePower.setState({ ...INITIAL, dialog: null })
})
afterEach(() => {
  useHive.getState().client?.disconnect()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function boot(sim: SimClient) {
  const toasts: { tone: string; title: string; body?: string }[] = []
  const c = installPower(sim, { notify: (n) => void toasts.push(n), nameOf: (id) => sim.agents.get(id)?.name })
  await useHive.getState().init(c)
  await usePower.getState().load()
  return { c, toasts }
}

describe('menus: who sees which power item', () => {
  it('an admin gets Wake all and Turn the hive off next to Stop all, plus the rest setting', async () => {
    await boot(fresh())
    expect(powerMenuItems().map((i) => i.id)).toEqual(['wake-all', 'power-off', 'rest'])
    expect(powerMenuItems().find((i) => i.id === 'power-off')?.danger).toBe(true)
  })

  it('a member gets only their own rest setting, and cannot open an admin dialog', async () => {
    const sim = fresh()
    sim.simMember = true
    await boot(sim)
    expect(usePower.getState().admin).toBe(false)
    expect(powerMenuItems().map((i) => i.id)).toEqual(['rest'])
    usePower.getState().openDialog('off')
    expect(usePower.getState().dialog).toBeNull()
    usePower.getState().openDialog('rest')
    expect(usePower.getState().dialog).toBe('rest')
  })

  it('while off an admin has no menu power items (the off screen is the only control)', async () => {
    const sim = fresh()
    await boot(sim)
    await usePower.getState().turnOff()
    expect(screenOf(usePower.getState())).toBe('off')
    expect(powerMenuItems().map((i) => i.id)).toEqual(['rest'])
  })
})

describe('honest results end to end (sim)', () => {
  it('Off with one mind that will not stop: the result names it as still running', async () => {
    const sim = fresh()
    await boot(sim)
    const stubborn = [...sim.agents.values()].find((a) => a.status !== 'stopped')!
    sim.simPower.failStop.add(stubborn.id)
    expect(await usePower.getState().turnOff()).toBe(true)
    const r = usePower.getState().result
    expect(r?.kind).toBe('off')
    expect(r?.kind === 'off' && r.failed.minds.map((m) => m.id)).toEqual([stubborn.id])
    expect(sim.agents.get(stubborn.id)!.status).not.toBe('stopped')
  })

  it('Wake all after a plain Stop all, with one failure: a calm error notice names it; no black screen', async () => {
    const sim = fresh()
    const { toasts } = await boot(sim)
    const failing = [...sim.agents.values()].find((a) => a.status !== 'stopped')!
    await useHive.getState().stopAll()
    sim.simPower.failWake.add(failing.id)
    expect(await usePower.getState().wakeAll()).toBe(true)
    expect(screenOf(usePower.getState())).toBe('none')
    const t = toasts.at(-1)!
    expect(t.tone).toBe('error')
    expect(t.title).toMatch(/^Woke \d+ minds?\.$/)
    expect(t.body).toContain(`1 mind did not wake: ${failing.name}`)
  })

  it('Wake all whose answer is lost: the retry replays the same operation, the host redoes it, the replay is the result, then GET', async () => {
    const sim = fresh()
    const { toasts } = await boot(sim)
    await useHive.getState().stopAll()
    const pending = ((await sim.getPower()) as { minds_in_snapshot: number }).minds_in_snapshot
    expect(pending).toBeGreaterThan(1)
    sim.simPower.cutShortNext = 1
    const spy = vi.spyOn(sim, 'setPower')
    const first = await usePower.getState().wakeAll()
    expect(first).toMatchObject({ unsettled: expect.stringMatching(/No answer came back/) })
    expect(toasts).toHaveLength(0)
    // the cut-short run woke the first half; the replay redoes the whole run: it wakes the rest and skips those
    // already starting, so its counts differ from what the first answer would have said
    expect(await usePower.getState().wakeAll()).toBe(true)
    expect(spy.mock.calls[0][0].operation_id).toBe(spy.mock.calls[1][0].operation_id)
    const half = Math.ceil(pending / 2)
    const t = toasts.at(-1)!
    expect(t.title).toBe(`Woke ${pending - half} mind${pending - half === 1 ? '' : 's'}.`)
    expect(t.body).toContain(`Skipped ${half} mind`)
    expect(t.body).toContain('not stopped (already starting)')
    // the refetch shows the true state: nothing left to wake
    await vi.waitFor(() => expect(usePower.getState().snapshot).toBe(0))
  })

  it('Wake all with nothing pending: "Nothing to wake."', async () => {
    const { toasts } = await boot(fresh())
    expect(await usePower.getState().wakeAll()).toBe(true)
    expect(toasts.at(-1)).toMatchObject({ tone: 'success', title: 'Nothing to wake.' })
  })

  it('plain Stop all that cannot stop one mind (500 stop_incomplete) is mapped on its own: named as still running', async () => {
    const sim = fresh()
    await boot(sim)
    const stubborn = [...sim.agents.values()].find((a) => a.status !== 'stopped')!
    sim.simPower.failStop.add(stubborn.id)
    useHive.getState().setStopAll(true)
    expect(await useHive.getState().stopAll()).toBeNull()
    expect(useHive.getState().stopAllOpen).toBe(false)
    const t = useHive.getState().toasts.at(-1)!
    expect(t).toMatchObject({ tone: 'error', title: 'Stop all did not stop every mind' })
    expect(t.body).toMatch(/^Stopped \d+ minds?\. 1 mind could not be stopped and is still running: /)
    expect(t.body).toContain(stubborn.name)
    // and Wake all still has the snapshot it recorded
    expect((await sim.getPower()) as { minds_in_snapshot: number }).toMatchObject({ minds_in_snapshot: expect.any(Number) })
    expect(((await sim.getPower()) as { minds_in_snapshot: number }).minds_in_snapshot).toBeGreaterThan(0)
  })
})
