import { describe, expect, it } from 'vitest'
import { SimClient } from './SimClient'

/** Demo walk (demo-p2): Vega, Lyra's coordinator, dozed off mid-demo and the Ask, Design and the tour then waited on it. */
describe('the simulated hive’s idle sleep', () => {
  it('never puts a swarm’s coordinator to sleep; other awake minds still doze off', () => {
    const sim = new SimClient({ seed: 7, latency: false, autoStart: false })
    for (const a of sim.agents.values()) a.status = 'awake'
    const coordinators = new Set([...sim.swarms.values()].map((s) => s.coordinator_id).filter(Boolean))
    expect(coordinators.size).toBeGreaterThan(0)
    // every tick rolls into the sleep/wake branch with more than six minds awake
    const rolls = [0.72, 0.1, 0.5, 0.9, 0.3]
    let i = 0
    ;(sim as unknown as { rng: () => number }).rng = () => (i++ % 2 === 0 ? 0.72 : rolls[i % rolls.length])
    for (let n = 0; n < 40; n++) (sim as unknown as { tick(): void }).tick()
    const minds = [...sim.agents.values()]
    expect(minds.filter((a) => coordinators.has(a.id)).every((a) => a.status === 'awake')).toBe(true)
    // (a dozing mind may already be waking: asleep, then starting)
    expect(minds.some((a) => !coordinators.has(a.id) && a.status !== 'awake')).toBe(true)
  })
})
