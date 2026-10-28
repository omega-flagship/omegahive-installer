// Speed in Node: MindCore called directly (the worker's logic, no worker). Skipped unless MIND_BENCH=1;
// MIND_BENCH_OUT=<file> writes the report. The browser run is scripts/mind-metta-bench.
import { describe, expect, it } from 'vitest'
import { MindCore } from '../core'
import { MindHost } from '../host'
import { memoryStore } from '../persist'
import { SIZES, rng, sentence, stat, type SpeedReport } from './workload'

const fsName = 'node:fs'
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const t = () => performance.now()

describe.skipIf(!env.MIND_BENCH)('speed (Node)', () => {
  it('cold start, add, revise, recall, infer at 50 / 200 / 1000 beliefs', async () => {
    const cold: number[] = []
    for (let i = 0; i < 10; i++) {
      const t0 = t()
      MindCore.create()
      cold.push(t() - t0)
    }
    const report: SpeedReport = { where: `Node ${(globalThis as { process?: { version: string } }).process?.version}`, cold: stat(cold), sizes: {} }
    for (const size of SIZES) {
      const r = rng(size)
      const s = MindCore.create()
      const add: number[] = []
      for (let i = 0; i < size; i++) {
        const t0 = t()
        s.addBelief(`b${i}`, 'fact', `${sentence(r)} ${i}`, { f: 0.5 + r() / 2, c: 0.2 + r() * 0.7 })
        add.push(t() - t0)
      }
      const rev: number[] = []
      for (let i = 0; i < 50; i++) {
        const t0 = t()
        s.reviseBelief(`b${Math.floor(r() * size)}`, { f: r(), c: 0.1 + r() * 0.8 })
        rev.push(t() - t0)
      }
      const rec: number[] = []
      for (let i = 0; i < 50; i++) {
        const q = sentence(r, 4)
        const t0 = t()
        s.recall(q, 5)
        rec.push(t() - t0)
      }
      const inf: number[] = []
      for (let i = 0; i < 30; i++) {
        const t0 = t()
        s.infer({ link: 'Inheritance', from: 'A', to: 'B', stv: { f: r(), c: 0.9 } }, { link: 'Inheritance', from: 'B', to: 'C', stv: { f: r(), c: 0.9 } })
        inf.push(t() - t0)
      }
      const t0 = t()
      const text = s.export()
      const exportMs = t() - t0
      report.sizes[size] = { addBelief: stat(add), reviseBelief: stat(rev), recall: stat(rec), infer: stat(inf), exportMs, exportBytes: new TextEncoder().encode(text).length }
      expect(s.stats().beliefs).toBe(size)
    }
    // a whole write-through change at 1000 beliefs (export + store), as the worker does it
    const r = rng(7)
    const h = await MindHost.open(memoryStore())
    for (let i = 0; i < 1000; i++) h.core.addBelief(`b${i}`, 'fact', `${sentence(r)} ${i}`, { f: 0.9, c: 0.5 })
    const wt: number[] = []
    for (let i = 0; i < 10; i++) {
      const t0 = t()
      await h.run('addBelief', [`w${i}`, 'fact', sentence(r), { f: 0.9, c: 0.5 }])
      wt.push(t() - t0)
    }
    const restore0 = t()
    MindCore.restore(h.core.export())
    const restoreMs = t() - restore0
    const out = { ...report, writeThrough1000: stat(wt), restore1000Ms: restoreMs }
    if (env.MIND_BENCH_OUT) ((await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }).writeFileSync(env.MIND_BENCH_OUT, JSON.stringify(out, null, 1))
    console.log(JSON.stringify(out))
  }, 600_000)
})
