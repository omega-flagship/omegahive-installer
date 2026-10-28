// The browser half of the speed check: the real worker, through the typed client, with IndexedDB storage.
import { MindSpace } from '../../src/lib/mindSpace/client'
import { SIZES, rng, sentence, stat, type SpeedReport } from '../../src/lib/mindSpace/bench/workload'

const t = () => performance.now()

async function main() {
  const cold: number[] = []
  const coldInWorker: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = t()
    const { space, opened } = await MindSpace.open(`cold-${i}`)
    cold.push(t() - t0)
    coldInWorker.push(opened.coldMs)
    space.close()
  }
  const report: SpeedReport & Record<string, unknown> = { where: navigator.userAgent, cold: stat(cold), sizes: {} }
  report.coldInWorker = stat(coldInWorker)
  for (const size of SIZES) {
    const r = rng(size)
    const { space, opened } = await MindSpace.open(`bench-${size}`)
    report[`storage-${size}`] = opened
    const add: number[] = []
    let durable = true
    for (let i = 0; i < size; i++) {
      const t0 = t()
      const a = await space.addBelief(`b${i}`, 'fact', `${sentence(r)} ${i}`, { f: 0.5 + r() / 2, c: 0.2 + r() * 0.7 })
      add.push(t() - t0)
      durable &&= a.durable
    }
    report[`durable-${size}`] = durable
    const rev: number[] = []
    for (let i = 0; i < 30; i++) {
      const t0 = t()
      await space.reviseBelief(`b${Math.floor(r() * size)}`, { f: r(), c: 0.1 + r() * 0.8 })
      rev.push(t() - t0)
    }
    const rec: number[] = []
    for (let i = 0; i < 50; i++) {
      const q = sentence(r, 4)
      const t0 = t()
      await space.recall(q, 5)
      rec.push(t() - t0)
    }
    const inf: number[] = []
    for (let i = 0; i < 30; i++) {
      const t0 = t()
      await space.infer({ link: 'Inheritance', from: 'A', to: 'B', stv: { f: r(), c: 0.9 } }, { link: 'Inheritance', from: 'B', to: 'C', stv: { f: r(), c: 0.9 } })
      inf.push(t() - t0)
    }
    const t0 = t()
    const text = (await space.export()).value
    report.sizes[size] = { addBelief: stat(add), reviseBelief: stat(rev), recall: stat(rec), infer: stat(inf), exportMs: t() - t0, exportBytes: new TextEncoder().encode(text).length }
    space.close()
    // reopen: the space comes back from IndexedDB (cold start with a saved space)
    const t1 = t()
    const again = await MindSpace.open(`bench-${size}`)
    report[`reopen-${size}`] = { ms: t() - t1, coldMs: again.opened.coldMs, gen: again.opened.gen, beliefs: (await again.space.stats()).value.beliefs }
    again.space.close()
  }
  // r2: two workers on one space (as two tabs): a forget in A is never served by B
  {
    const A = (await MindSpace.open('tabs')).space
    const B = (await MindSpace.open('tabs')).space
    const w = 'my bank is the blue one'
    await A.addBelief('t1', 'fact', w, { f: 1, c: 0.5 }, { evidence: [{ agent: 'bench', n: 1 }] })
    await A.addBelief('t2', 'fact', 'My bank is the blue one.', { f: 1, c: 0.5 }, { evidence: [{ agent: 'bench', n: 2 }] })
    const before = (await B.recall('blue bank', 5)).value.items.length
    await A.forget('t1')
    const after = {
      recall: (await B.recall('blue bank', 5)).value.items.length,
      belief: (await B.belief('t2')).value,
      exportHasWords: (await B.export()).value.toLowerCase().includes('blue one'),
    }
    await A.addBelief('t3', 'fact', 'tea at four', { f: 1, c: 0.5 }, { evidence: [{ agent: 'bench', n: 3 }] })
    await A.forgetAll()
    const afterAll = (await B.stats()).value
    report.twoTabs = { before, after, afterAll }
    A.close()
    B.close()
  }
  ;(window as unknown as { __bench: unknown }).__bench = report
  document.getElementById('out')!.textContent = JSON.stringify(report, null, 1)
}
main().catch((e) => {
  ;(window as unknown as { __bench: unknown }).__bench = { error: String(e?.stack ?? e) }
})
