// Parity: the sim commons (MeTTaScript, ./commons) against PeTTa running the same lib_nal / lib_hive the way
// hive/spaces/service.py runs them (parity/petta-reference.json, written by scripts/showreel-pln-reference.py, which
// also writes the showreel's reference). Two kinds of case (parity/cases.json):
//  - revisions: lib_nal Truth_Revision on pairs of truth values (the sim tests' pairs and the cap);
//  - commons: per swarm, its members (grants), its vocabulary (hive-vocab-add!) and every assertion in order through
//    hive-publish!, statements as parsed expressions (hive/spaces/sexpr.py on the PeTTa side): the sim tests'
//    sequences, and the default sim's (seed 7, as the demo build) whole seeded commons, refusals included. After each
//    step: the outcome, the unmapped terms of a quarantine, and the Current truth value (1e-12 relative) and stamp.
// SIM_COMMONS_CASES_OUT=<file> writes the cases (the seeded part is recorded from SimClient itself).
import { describe, expect, it, vi } from 'vitest'
import { SimCommons } from './commons'
import { SimClient, simSeedCache } from './SimClient'
import cases from './parity/cases.json'
import petta from './parity/petta-reference.json'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 2060 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 40000 }) // ~3x the worst case measured under load (followups-r5)

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

type Step = { agent: string; statement: string; tv: [number, number]; stamp: string[] }
type Commons = { swarm: string; members: string[]; vocab: string[]; steps: Step[] }

/** The default sim's seeded commons: each swarm's members, vocabulary and every assertion SimClient sent the engine. */
async function seeded(): Promise<Commons[]> {
  simSeedCache.clear() // the engine runs the seed here (never a cached copy)
  const sim = new SimClient({ latency: false, autoStart: false })
  expect(simSeedCache.stats()).toMatchObject({ hits: 0, misses: 1 })
  const swarms = [...new Set(sim.published.map((p) => p.swarm_id))]
  return Promise.all(
    swarms.map(async (swarm) => ({
      swarm: `seed7-${swarm}`,
      members: [...sim.swarms.get(swarm)!.member_ids].sort(),
      vocab: await sim.getVocab(swarm),
      steps: sim.published.filter((p) => p.swarm_id === swarm).map(({ assertion: a }) => ({ agent: a.agent_id, statement: a.statement, tv: [a.tv.f, a.tv.c] as [number, number], stamp: a.stamp })),
    })),
  )
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b))
const STV = /^\(stv (\S+) (\S+)\)$/
const stvOf = (s: string) => {
  const m = STV.exec(s)
  if (!m) throw new Error(`not a truth value: ${s}`)
  return { f: Number(m[1]), c: Number(m[2]) }
}
const bank = cases.commons as unknown as Commons[]
type RefStep = { input: Step; outcome: string; unmapped: string[] | null; tv: string | null; stamp: string[] | null }
const ref = petta.commons as unknown as { swarm: string; members: string[]; vocab: string[]; steps: RefStep[] }[]

describe('sim commons parity with PeTTa', () => {
  it('the cases hold the default sim’s seeded commons as it is now', async () => {
    const now = await seeded()
    if (env.SIM_COMMONS_CASES_OUT) fs.writeFileSync(env.SIM_COMMONS_CASES_OUT, JSON.stringify({ ...cases, commons: [...bank.filter((c) => !c.swarm.startsWith('seed7-')), ...now] }, null, 1) + '\n')
    expect(bank.filter((c) => c.swarm.startsWith('seed7-'))).toEqual(now)
    expect(now.reduce((n, c) => n + c.steps.length, 0)).toBeGreaterThan(40)
  })

  it('the reference was made from these exact cases and libraries', () => {
    expect(petta.engine).toMatch(/^PeTTa /)
    expect(Object.keys(petta.libs).sort()).toEqual(['hive/spaces/lib_hive.metta', 'lib_nal.metta', 'lib_pln.metta'])
    // every input, exactly as PeTTa was given it
    expect(petta.revisions.map((r) => r.args)).toEqual(cases.revisions)
    expect(ref.map((c) => ({ swarm: c.swarm, members: c.members, vocab: c.vocab, steps: c.steps.map((s) => s.input) }))).toEqual(bank)
  })

  it('every Truth_Revision matches', () => {
    const e = SimCommons.start()
    const bad: string[] = []
    cases.revisions.forEach(([a, b], i) => {
      const r = petta.revisions[i]
      const got = e.revise({ f: a[0], c: a[1] }, { f: b[0], c: b[1] })
      const want = stvOf(r.result)
      if (!close(got.f, want.f) || !close(got.c, want.c)) bad.push(`${r.expr}: MeTTaScript ${JSON.stringify(got)} vs PeTTa ${r.result}`)
    })
    expect(bad).toEqual([])
  })

  it('every commons step matches: outcome, unmapped terms, truth value and stamp', () => {
    const bad: string[] = []
    let n = 0
    bank.forEach((c, ci) => {
      const e = SimCommons.start()
      e.setMembers(c.swarm, c.members)
      e.addVocab(c.swarm, c.vocab)
      c.steps.forEach((s, si) => {
        const want = ref[ci].steps[si]
        const r = e.publish(c.swarm, s.agent, s.statement, { f: s.tv[0], c: s.tv[1] }, s.stamp)
        n++
        const tv = want.tv ? stvOf(want.tv) : null
        const ok =
          r.outcome === want.outcome &&
          JSON.stringify(r.unmapped ?? null) === JSON.stringify(want.unmapped) &&
          (r.held === null ? tv === null : !!tv && close(r.held.exact.f, tv.f) && close(r.held.exact.c, tv.c) && JSON.stringify(r.held.stamp) === JSON.stringify(want.stamp))
        if (!ok) bad.push(`${c.swarm} step ${si} ${s.statement}: MeTTaScript ${r.outcome} ${JSON.stringify(r.unmapped ?? null)} ${JSON.stringify(r.held?.exact ?? null)} ${r.held?.stamp.join(' ')} vs PeTTa ${want.outcome} ${JSON.stringify(want.unmapped)} ${want.tv} ${want.stamp?.join(' ')}`)
      })
    })
    expect(bad).toEqual([])
    expect(n).toBeGreaterThan(50)
    // the cases reach every engine outcome, and the cap
    const outcomes = new Set(ref.flatMap((c) => c.steps.map((s) => s.outcome)))
    for (const o of ['adopted', 'revised', 'chosen', 'kept', 'duplicate', 'quarantined', 'denied']) expect([o, outcomes.has(o)]).toEqual([o, true])
    expect(ref.some((c) => c.steps.some((s) => s.outcome === 'revised' && s.tv && stvOf(s.tv).c === 0.99))).toBe(true)
    // the seeded demo's refusals are the engine's: every seeded swarm has an outsider denied
    for (const c of ref.filter((x) => x.swarm.startsWith('seed7-'))) expect([c.swarm, c.steps.some((s) => s.outcome === 'denied')]).toEqual([c.swarm, true])
  })
})
