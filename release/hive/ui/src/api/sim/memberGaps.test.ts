// Purpose: pins that the demo client mirrors the hive's member guards and flags for apps, the Lab and a swarm's vocabulary.
import { describe, expect, it } from 'vitest'
import { SimClient } from './SimClient'

/** Review #299, item 4: the demo's member (Rowan) meets the refusals and flags the live routes give. */
const sim = () => new SimClient({ seed: 42, latency: false, autoStart: false })

describe("the demo follows the hive's member guards", () => {
  it('only an admin switches or reloads apps', async () => {
    const s = sim()
    const [app] = await s.programs()
    expect((await s.programDisable(app.id)).enabled).toBe(false)
    s.simSignInAs('member')
    for (const press of [() => s.programEnable(app.id), () => s.programDisable(app.id), () => s.programsReload()])
      await expect(press()).rejects.toMatchObject({ status: 403, code: 'admin_only' })
    s.simSignInAs('operator')
    expect((await s.programEnable(app.id)).enabled).toBe(true)
  })

  it('only an admin starts or cancels a Lab run, and each suite says so as may_run', async () => {
    const s = sim()
    const suites = await s.listLabSuites()
    expect(suites.length).toBeGreaterThan(0)
    expect(new Set(suites.map((x) => x.may_run))).toEqual(new Set([true]))
    s.simSignInAs('member')
    expect(new Set((await s.listLabSuites()).map((x) => x.may_run))).toEqual(new Set([false]))
    await expect(s.startLabRun(suites[0].id)).rejects.toMatchObject({ status: 403, code: 'admin_only' })
    await expect(s.cancelLabRun('run_any')).rejects.toMatchObject({ status: 403, code: 'admin_only' })
  })

  it("adding vocabulary is the swarm's owner's, its person's or an admin's, as each swarm's may_control says", async () => {
    const s = sim()
    const [first] = await s.listSwarms()
    expect(first.may_control).toBe(true)                                 // the operator, an admin
    s.simSignInAs('member')
    expect((await s.getSwarm(first.id)).may_control).toBe(false)
    await expect(s.addVocab(first.id, ['ivy'])).rejects.toMatchObject({ status: 403, code: 'owner_only' })
    s.swarms.get(first.id)!.owner = 'user:p_rowan'                         // now Rowan's own swarm
    expect((await s.listSwarms()).find((x) => x.id === first.id)?.may_control).toBe(true)
    expect(await s.addVocab(first.id, ['ivy'])).toContain('ivy')
  })
})
